# Temp song lifecycle — review

**Range:** master `d8aab5bf2..HEAD` (8 commits)
**Files in scope:** `app/App.tsx`, `app/components/CreatePanel.tsx`, `app/components/SongList.tsx`, `app/types.ts`
**Date:** 2026-05-05

Trace verified end-to-end: click → temp card → LLM pre-flight → `onGenerate` promotion → `beginPollingJob` → `cleanupJob` + `refreshSongsList`. Counts at bottom.

---

## H1 — `_tempId` tunneled via `as any`, no type safety

**Sev:** High (footgun; rename in one place silently breaks the lifecycle)
**Refs:** `CreatePanel.tsx:1617`, `CreatePanel.tsx:1731`, `App.tsx:993`, `types.ts:59-152`

`GenerationParams` does not declare `_tempId`. The producer (CreatePanel) writes it inside the object literal passed to `onGenerate`, the consumer (App) reads it via `(params as any)._tempId`. If anyone renames the field on either side TS won't catch it — the placeholder card silently turns into a duplicate (App takes the `else` branch at line 1005, creates a SECOND temp card, and the original is never promoted nor removed → stuck "Queued…" forever).

```ts
// types.ts — add to GenerationParams
/** Internal: pre-created placeholder card id from CreatePanel. */
_tempId?: string;
```

Then drop the `as any` casts at App.tsx:993 and the two CreatePanel literal sites.

---

## H2 — Stage field mixes i18n keys, resolved translations, and literal sentinels

**Sev:** High (inconsistent UX, language-switch bug, sentinel collision risk)
**Refs:** `App.tsx:129` (`stageWaitingInQueue`), `App.tsx:780` (`'cancelled'`), `App.tsx:1002` (`stageStartingTrack`), `App.tsx:1028` (resolved string!), `CreatePanel.tsx:1544` (`stageGeneratingTextOpenRouter`), `SongList.tsx:677,832,843`, `App.tsx:925` (server-supplied `status.stage` — opaque shape)

Four kinds of strings flow into the same `song.stage: string` field:

1. **i18n keys** — `stageWaitingInQueue`, `stageGeneratingTextOpenRouter`, `stageStartingTrack`, `stageGeneratingCover` — resolved via `t(song.stage)` at SongList.tsx:677,832.
2. **A pre-resolved translation** — `App.tsx:1028` does `stage: t('writingLyricsAndStyle') || 'Writing lyrics & style...'` — i.e. the *English/Russian/etc string* lands in `song.stage`. SongList then calls `t('Writing lyrics & style…')` — returns `undefined` — falls through to the literal, which happens to be in whatever language was active when this code ran. **Language switch mid-generation will not retranslate.**
3. **A literal sentinel** — `'cancelled'` (App.tsx:780). SongList branches on it (`song.stage === 'cancelled'`) at lines 424, 843. Not an i18n key.
4. **Server-driven stage from the polling endpoint** — `status.stage ?? song.stage` (App.tsx:925). Backend can set anything; format is undocumented from the frontend's POV.

If a future i18n catalog ever introduces a key literally named `cancelled`, the sentinel check at 843 silently changes meaning. If the server one day emits a stage equal to `'cancelled'`, the UI treats a still-running job as cancelled and shows the Reset button.

Fix: union type + helper.

```ts
// constants/stages.ts
export const STAGE = {
  WaitingInQueue: 'stageWaitingInQueue',
  GeneratingTextOpenRouter: 'stageGeneratingTextOpenRouter',
  StartingTrack: 'stageStartingTrack',
  GeneratingCover: 'stageGeneratingCover',
  WritingLyricsAndStyle: 'writingLyricsAndStyle',
} as const;
export type StageKey = typeof STAGE[keyof typeof STAGE];

// Separate channel for non-i18n status, so it doesn't collide with stage keys
export type SongLifecycle = 'generating' | 'cancelled' | 'idle';
```

Then on `Song`: `stage?: StageKey | string` (string for server-supplied) and `lifecycle?: SongLifecycle`. App.tsx:780 sets `lifecycle: 'cancelled'` instead of `stage: 'cancelled'`. App.tsx:1028 sets the **key** not the resolved string.

---

## H3 — No UI to cancel a pre-flight click (claim 7 confirmed and worse than stated)

**Sev:** Medium-High (user clicks Cancel during 20s OpenRouter wait — nothing happens)
**Refs:** `CreatePanel.tsx:1538-1573`, `SongList.tsx:734-741, 834-841`

While the LLM pre-flight is in flight (between `createTempSongForClick` at click and `beginPollingJob` after POST returns), the temp card has `isGenerating: true` and SongList renders the Cancel button (lines 734, 834). But:

- The card has **no `jobId`** yet (jobId is set at App.tsx:1140 *after* the POST returns).
- Cancel button calls `onCancelJob` which ultimately reaches `cancelGeneration(jobId)`. If the jobId prop is undefined the click is a no-op or NaN URL fetch.

Looking at SongList.tsx:736 — `onCancelJob` is called with no args from the button, but it's typed/used elsewhere as `(jobId) => ...`. Need to verify the wiring at the App.tsx render site (line 1662 confirms `onCancelJob={cancelGeneration}` which expects a jobId). The actual Cancel button passes nothing, so the click hits `cancelGeneration(undefined)` → `fetch('/api/generate/cancel/undefined')` → 404 → caught → no UI update. Card stays "Queued" forever.

Also: `AbortController` at CreatePanel.tsx:1548 is allocated but **never wired to a cancel mechanism** — it's local to the chained `.then`, no ref/external handle. Even if a user could trigger it, nothing aborts the OpenRouter fetch.

Fix sketch:
- Stash the `AbortController` per tempId in a ref (`preflightControllersRef.current.set(tempId, ac)`).
- New callback `cancelPreflight(tempId)`: aborts the controller, calls `removeTempSongForClick(tempId)`, decrements pending counter.
- SongList: if `!song.jobId && song.isGenerating` → render this button instead of the jobId-based one.

---

## M1 — `cancelled` cards are unreachable on next refresh

**Sev:** Medium
**Refs:** `App.tsx:765-783` (cancel keeps card), `App.tsx:891-897` (refresh merge)

`cancelGeneration` deliberately leaves the card with `isGenerating: false, stage: 'cancelled'` so the user can hit Reset. But `refreshSongsList` (line 891) merges by `s.isGenerating && !loadedSongs.some(...)` — only **still-generating** orphans are kept. A cancelled card has `isGenerating: false`, so the next refresh (triggered by ANY other job's success at line 938) **wipes the cancelled card silently**. The user loses the Reset button mid-thought.

Fix: keep cards where `s.isGenerating || s.stage === 'cancelled'` (or `s.lifecycle === 'cancelled'` after H2).

```ts
// App.tsx:893
const stillGenerating = prev.filter(
  s => (s.isGenerating || s.stage === 'cancelled') && !loadedSongs.some(l => l.id === s.id)
);
```

---

## M2 — Bulk cancel-all wipes the click-pending placeholders too aggressively, and not enough

**Sev:** Medium
**Refs:** `App.tsx:809-827` (cancelAllGenerations), `App.tsx:829-848` (resetGeneration)

Both `cancelAllGenerations` and `resetGeneration` filter `setSongs` by `tempIds` collected from `activeJobsRef.current.values()` — only jobs that already reached `beginPollingJob` are in there. Placeholder cards still in pre-flight (no jobId yet, not in `activeJobsRef`) **survive cancel-all** as orphan "Queued…" cards. They'll never get cleaned up because their pre-flight will eventually call `onGenerate` → POST → polling → real cleanup, OR fail and hit `releaseClaimedSlots`. So it self-heals, but during the 20s window the UI lies — user pressed "Cancel all" and N cards keep spinning.

Worth at least a comment near `cancelAllGenerations` documenting the gap, or a proper fix that also iterates a `pendingPreflightTempIdsRef`.

---

## M3 — `Date.now() + Math.random()` collision: claim 2 confirmed safe

**Sev:** Low (verification)
**Refs:** `App.tsx:118`, `App.tsx:994`

`Math.random().toString(36).substr(2, 9)` is 9 base-36 chars ≈ 53 bits of entropy. Birthday-bound collision probability for 10 simultaneous IDs created in the same ms ≈ C(10,2) / 2^53 ≈ 5e-15. Acceptable. **However:** `String.prototype.substr` is deprecated (MDN flags it; some bundler configs warn). Switch to `slice(2, 11)` for hygiene.

---

## M4 — `selectedSong` race with bulk: claim 5 confirmed (only matches if user already selected the placeholder)

**Sev:** Low-Medium (UX, not bug)
**Refs:** `App.tsx:1004`, `App.tsx:1019-1020`

With `preCreatedId` (always true for clicks coming from CreatePanel after the new flow), App.tsx:1004 only updates `selectedSong` if `prev?.id === tempId`. The placeholder cards are created in `createTempSongForClick` which does NOT touch `selectedSong`. So for bulk N=10, none of the 10 placeholders become `selectedSong` automatically — the right sidebar shows whatever was previously selected (often nothing for a fresh session). Old behavior (no preCreatedId) auto-selected the first card AND opened the sidebar (App.tsx:1019-1020).

This is intentional per the trace, and arguably better for bulk (no jarring auto-select), but for **non-bulk N=1** it's a regression: clicking Создать once no longer auto-opens the right sidebar. If that was deliberate, fine; if not, in `createTempSongForClick` set `selectedSong = tempSong` when `selectedSong == null`.

---

## L1 — `tags: ['queued']` on placeholder, replaced with `['custom']` / `['simple']` — claim 16

**Sev:** Low (cosmetic)
**Refs:** `App.tsx:130`, `App.tsx:1001`

Confirmed acceptable. The "queued" tag flashes for ~20s on simple+OR mode. No i18n key for the tag value — SongList renders it raw. Minor.

---

## L2 — `removeTempSongForClick` double-remove safety: claim 14/15 confirmed

**Sev:** Low (no bug)
**Refs:** `App.tsx:143-145`, `CreatePanel.tsx:1515-1522`, `App.tsx:1054`, `App.tsx:1149`

`releaseClaimedSlots` only fires on early-return paths (validation fail, OR pre-flight fail) — see CreatePanel.tsx:1537,1567,1570,1775. App's catch path (App.tsx:1054, 1149) does its own `setSongs.filter`. They CAN both fire if: OR pre-flight succeeds → onGenerate POSTs → POST throws → App.tsx:1149 removes by tempId → CreatePanel's outer try/catch at line 1771 catches… no, the throw happens inside `await onGenerate(...)` which IS awaited inside the for-loop, so the catch at 1771 fires too → `releaseClaimedSlots` → second filter. Safe because filter on missing id is no-op (claim 15), but `decrementPendingClicks` is ALSO called twice → counter goes negative? No, `Math.max(0, c - n)` at App.tsx:111 clamps it. Verified safe.

But: the user pressed Создать once and the badge briefly shows -1-clamped-to-0 before restoring. Cosmetically fine, semantically smelly. Worth a one-shot guard:

```ts
// CreatePanel.tsx — track per-job claim
const slotReleased = new Set<number>();
// inside the loop after successful onGenerate:
//   slotReleased.add(i); claimedSlotsRemaining--;
// releaseClaimedSlots only releases unreleased slots
```

---

## L3 — `buildTempSongFromParams` (App.tsx:965) duplicates the temp-song shape

**Sev:** Low (DRY)
**Refs:** `App.tsx:965-976` (resume path), `App.tsx:117-135` (createTempSongForClick), `App.tsx:1006-1017` (handleGenerate fallback)

Three near-identical Song literals. Extract a single `makeTempSong(opts)` helper. Bonus: a single place to set `stage: STAGE.WaitingInQueue` after H2.

---

## L4 — `descriptionPreview.slice(0, 60)` — claim 17 acceptable but unbounded

**Sev:** Low
**Refs:** `App.tsx:121`, `CreatePanel.tsx:1508`

`previewBase = (customMode ? (title || style || lyrics || 'Track') : (songDescription || 'Track')).slice(0, 60)`. Lyrics in custom mode can be 2000+ chars; first 60 may be the LRC header `[00:00.00]` or section markers like `[Verse 1]`. Cosmetically ugly. Suggest stripping LRC markers and section tags before slice: `lyrics.replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)`.

---

## L5 — `isGenerating: true` set on placeholder but no `progress` field

**Sev:** Low
**Refs:** `App.tsx:117-135`, `SongList.tsx:721-733`

Placeholder has no `progress`. SongList renders the bar at `width: 0%` with `opacity-40` (line 725 — `progress === undefined` styling). Looks like a dead progress bar for 20s during pre-flight. Could either hide the bar entirely when undefined, or seed an indeterminate animation.

---

## Verified-correct claims (no action needed)

- **Claim 1:** `createTempSongForClick` shape correct, prepends to list. ✓
- **Claim 3:** Bulk update of `stageGeneratingTextOpenRouter` applies to all N — acceptable (single OR call shared). ✓
- **Claim 4:** Promotion logic at App.tsx:997-1003 maps by tempId. ✓
- **Claim 6:** `setShowRightSidebar(true)` only fires on the no-preCreatedId branch. Intentional with bulk; see M4 for non-bulk regression note.
- **Claim 7:** Cancel of running job works. Cancel of pre-flight click broken — see H3.
- **Claim 8:** `resetSingleJob` removes card. ✓
- **Claim 9:** `cleanupJob` filters temp by id, then `refreshSongsList` repopulates with real song row. ✓
- **Claim 10:** `refreshSongsList` (App.tsx:851-907) replaces with real DB rows; merge logic at line 891 keeps still-generating orphans. See M1 for the cancelled-orphan gap.
- **Claim 11:** All 5 langs (en/ru/zh/ja/ko) have `stageWaitingInQueue`, `stageGeneratingTextOpenRouter`, `stageStartingTrack`, `stageGeneratingCover`, `writingLyricsAndStyle`. Verified. ✓
- **Claim 13:** `cancelled` literal sentinel — see H2.
- **Claim 14/15:** Double-remove safe via filter no-op + clamp. See L2.

---

## Counts

- High: 3 (H1, H2, H3)
- Medium: 4 (M1, M2, M3, M4)
- Low: 5 (L1, L2, L3, L4, L5)
- Verified-correct: 11 of the 17 trace claims
- Total findings: 12
