# Temp song lifecycle — Round 2 Review

**Range:** master, fix commits `ea73c3c98`, `10a87ab0e`, `2419f7d73`
**Prior:** `docs/reviews/2026-05-05-agent06-temp-song.md` (12 findings: H×3, M×4, L×5)
**Date:** 2026-05-05

Verifying each Round-1 finding against the three "review fixes" commits, then hunting new regressions introduced by the diffs.

---

## Round-1 Verification

### H1 — `_tempId` tunneled via `as any` — **NOT FIXED (commit message lies)**

`2419f7d7385c579a511c64ef7df63e981fce0103`'s **commit message** says:

> `_tempId added to GenerationParams type (api.ts) — removes 'as any' tunnel`

The commit's actual file list is **only** `app/server/src/services/id3-tagger.ts`. `git show --name-only 2419f7d73` confirms — no `app/services/api.ts`, no `app/types.ts`. Verified `git diff ea73c3c98^..HEAD -- app/services/api.ts` and `…-- app/types.ts` both empty.

Current state:
- `app/services/api.ts:279-390` — `GenerationParams` interface, **no `_tempId` field**.
- `app/types.ts:59` — second `GenerationParams` interface (the one App.tsx imports for the `params` arg of `handleGenerate`), **no `_tempId` field**.
- `app/App.tsx:1167` — still `_tempId: (params as any)._tempId,` cast in the whitelist.

The fix was claimed, advertised in the commit log, but the code change is missing. Either the patch was lost in stash/rebase, or someone wrote the message before writing the code and forgot. Sev unchanged: **High**.

Action: actually add the field to BOTH interfaces (`app/services/api.ts` and `app/types.ts`) and drop the three `as any` casts (App.tsx:1167, plus the two CreatePanel literal sites).

---

### H2 — `App.tsx:1028` resolved-string in `song.stage` — **FIXED**

Commit `ea73c3c98` rewrites the assignment:

```ts
// before
stage: t('writingLyricsAndStyle') || 'Writing lyrics & style...'
// after — App.tsx:1034
stage: 'writingLyricsAndStyle'
```

Confirmed at `app/App.tsx:1031-1034`. The comment block above explains the rationale (language-switch retranslation). Round-1 H2 was actually a multi-pronged finding — this fix only resolves sub-point 2 (resolved-string leak). Sub-points 1 (i18n key channel), 3 (`'cancelled'` literal sentinel), and 4 (server-supplied `status.stage` overwrite) are all unchanged. The polling loop at `App.tsx:931` still does `newStage = status.stage ?? song.stage`, so once polling starts the Python-emitted raw text continues to land directly into `song.stage`, bypassing i18n.

Net: top-priority resolved-string fixed. Stage-channel mixing pre-existing — not introduced by these commits, deferred is acceptable. **Closing as fixed for the specific sub-point flagged.**

---

### H3 — No UI to cancel pre-flight click — **NOT FIXED (deferred without note)**

Searched the entire `app/` tree for `cancelPreflight`, `preflightControllers`, or any new `AbortController` ref tied to tempId. Result: zero hits. The `AbortController` at `CreatePanel.tsx:1553` is still allocated locally inside the `.then` and never stashed. SongList still renders the Cancel button on cards with `isGenerating: true && !jobId`, and that button still calls `cancelGeneration(undefined)` → `fetch('/api/generate/cancel/undefined')` → 404 → silent no-op.

User-facing: pressing Cancel during the 20s OpenRouter wait does nothing. Sev unchanged: **Medium-High**.

Action: stash a Map<tempId, AbortController> ref in CreatePanel + expose `cancelPreflight(tempId)` to App; in SongList branch on `!jobId` to call the new path.

---

### M1 — Cancelled cards wiped on next refresh — **NOT FIXED**

`refreshSongsList` merge logic still at `App.tsx:899`:

```ts
const stillGenerating = prev.filter(s => s.isGenerating && !loadedSongs.some(l => l.id === s.id));
```

Cancelled cards have `isGenerating: false, stage: 'cancelled'` (set at App.tsx:780). Any other job's success triggers `refreshSongsList` (called at App.tsx:982 after polling completes), and the cancelled card is silently dropped — Reset button vanishes mid-thought. Sev unchanged: **Medium**.

Trivial fix: `s.isGenerating || s.stage === 'cancelled'` in the predicate. Not applied.

---

### M2 — Bulk cancel-all leaves pre-flight orphans — **PARTIALLY ADDRESSED, INCOMPLETE**

Commit `ea73c3c98` adds two things to `cancelAllGenerations` (App.tsx:827-832):

```ts
drainQueueWaiters();
setPendingClickCount(0);
```

What this fixes: the FIFO queue chain wakes up (next click can fire LLM), and the visual N/10 badge resets to 0. Good.

What it does NOT fix: **the temp card itself**. Trace:

- `createTempSongForClick` (App.tsx:117) prepends a `Song` with `id = temp_<ts>_<rnd>` into `setSongs`. No external ref tracks this id.
- The id is handed to CreatePanel via `_tempId`, eventually passed to `onGenerate`/App's `handleGenerate`, which only registers in `activeJobsRef.current` AFTER the POST returns (`beginPollingJob` at App.tsx:1167).
- During the 20s OpenRouter pre-flight: the temp card exists in `songs` state, but is **NOT** in `activeJobsRef`.
- `cancelAllGenerations` (App.tsx:822-824):
  ```ts
  const tempIds = new Set([...activeJobsRef.current.values()].map(j => j.tempId));
  activeJobsRef.current.clear();
  setSongs(prev => prev.filter(s => !tempIds.has(s.id)));
  ```
  Only filters by tempIds in `activeJobsRef`. Pre-flight temp cards survive.

Mental simulate: user clicks Создать once, OR pre-flight starts (20s wait), user panics and clicks Cancel All. Result:
- `activeJobsRef` is empty (POST hasn't returned), so the filter removes nothing.
- `pendingClickCount` resets to 0 (badge shows 0).
- `drainQueueWaiters` fires.
- Pre-flight `.then` chain continues running (no AbortController wired to cancel it — see H3).
- 20s later, OR returns, `onGenerate` fires, POST returns a real jobId, `beginPollingJob` registers it, song polls to completion.
- Meanwhile the original temp card stays in `songs` with `stage: 'stageGeneratingTextOpenRouter'` forever (CreatePanel:1544 was the last setter; nothing promotes a card the user thought was cancelled).

Worse: with `releaseClaimedSlots` only firing on early-return paths in CreatePanel, and the success path going through `onGenerate` (which the user-cancelled temp card no longer matches because the new tempId is regenerated only if `preCreatedId` is missing — and it IS still passed), the pre-flight COMPLETES into a real song, but the user already pressed cancel-all. Net: ghost song appears, user is confused.

Sev unchanged: **Medium**. The drainQueueWaiters fix is real but addresses a different bug (FIFO deadlock), not the orphan-card bug.

Action: track pre-flight tempIds in a `pendingPreflightTempIdsRef: Set<string>` populated in `createTempSongForClick`, drained by `beginPollingJob` (graduation) AND `cancelAllGenerations` (orphan reap). Also wire AbortController per H3.

---

### M (substr → slice) — **NOT FIXED**

`String.prototype.substr` still used at:
- `app/App.tsx:118` (`createTempSongForClick`)
- `app/App.tsx:1000` (handleGenerate fallback)

Backend code already uses `.slice(2, …)` (acestep.ts:586, render-video.ts:49), so the codebase is half-converted. Trivial. Sev unchanged: **Low**.

---

### L1 (queued tag) / L2 (double-remove) / L3 (DRY) / L4 (lyrics slice) / L5 (no progress) — **ALL DEFERRED**

Skimmed — no changes. All purely cosmetic / DRY refactors. Acceptable to defer.

---

## New Findings (introduced by ea73c3c98)

### N1 — `cancelAllGenerations` zombie cards (NEW SYMPTOM, MEDIUM)

The added `setPendingClickCount(0)` makes the badge LIE. After cancel-all during pre-flight, the badge shows "0/10" but a temp card is still spinning with `isGenerating: true` and `stage: 'stageGeneratingTextOpenRouter'`. Pre-fix: badge said "1/10" and card was spinning — at least consistent. Post-fix: badge says "0" and card spins — the user can no longer tell from the badge that something is still running.

This is the user-facing manifestation of M2. Counted separately because the fix actively WORSENED the UX consistency: previously the leftover card and the leftover counter were visually paired. Now they desynchronize.

Action: same as M2 (track + reap pre-flight orphans).

### N2 — Whitelist `_tempId` cast unnecessary if H1 ever lands (Cleanup, LOW)

`App.tsx:1170`: `_tempId: (params as any)._tempId,`. Once H1 is properly applied, this cast can drop. Currently every field in the recovered whitelist (DCW, FlowEdit, retake, lora, prompt, openrouterModel, pollinations, _tempId) uses `as any`. The comment at App.tsx:1144-1148 acknowledges this. The whole block is technical debt — three `GenerationParams` interfaces (App-level, api.ts, server) drift independently. Worth a follow-up to pick ONE source of truth.

### N3 — Stage-channel mixing surfaces immediately after H2 fix (Pre-existing, LOW)

With H2 fixed, the lifecycle now is:
1. click → temp card with `stage: 'stageWaitingInQueue'` (i18n key)
2. pre-flight → `'stageGeneratingTextOpenRouter'` (key)
3. promotion → `'writingLyricsAndStyle'` (key — fixed by ea73c3c98)
4. POST returns → `beginPollingJob` polls Python `status.stage` (raw English, e.g. `"queued"`, `"running"`, `"diffusing"`)

Step 4 still bypasses i18n. SongList does `t(song.stage) || song.stage` so raw strings fall through to literal — but they're English-only.

This is pre-existing per Round-1 H2 sub-point 4. Not a regression. But now visible because the resolved-string leak is gone — users in non-English locales will notice the language flip from "Запускаю трек…" to "queued"/"running" mid-generation.

Action (deferred OK): backend should emit i18n keys instead of free-form English; frontend should map any unknown stage string through a synonym table.

---

## Mental Simulation (post-fix)

Click Создать (Простой mode + OR enabled) → temp card appears, stage="Ожидает в очереди…" ✓
Pre-flight starts → stage="Пишу текст через OpenRouter…" ✓
LLM returns, promotion to handleGenerate → stage="Запускаю трек…" ✓ (key, not resolved string — H2 fixed)
POST returns jobId, polling starts → stage="queued"/"running"/etc. (raw Python text, see N3)

Cancel-all mid pre-flight → badge=0, drain waiters fired, BUT temp card still spins with old stage, eventually completes into a real song. Bug per N1/M2.

Cancel single running job → card persists with `stage: 'cancelled'`, Reset button shows ✓.
…then any other job completes → `refreshSongsList` wipes the cancelled card. Bug per M1.

---

## Counts

- Round-1 findings verified: 12
  - **Fixed:** 1 (H2 sub-point 2 only)
  - **Not fixed (deferred):** 9 (H1 commit-msg lies, H3, M1, M2 partial, M-substr, L1-L5)
- New findings introduced by these commits: 3 (N1, N2, N3 — all severity ≤ Medium)
- Net delta: 1 fix, 1 new symptom of an existing bug (N1), 2 cleanup notes
- Outstanding High: 2 (H1 unfixed despite claim, H3 deferred)
- Outstanding Medium: 3 (M1, M2/N1, M-substr-deprecation)

## Recommendations (priority order)

1. **Land H1 for real** — add `_tempId?: string` to both `GenerationParams` interfaces (`app/services/api.ts:279-390` and `app/types.ts:59`), drop the three `as any` casts. Either revise commit `2419f7d73` or follow-up commit. The commit message currently misrepresents reality.
2. **Reap pre-flight orphans on cancel-all (M2/N1)** — add `pendingPreflightTempIdsRef`, drain in `cancelAllGenerations` and `resetGeneration`.
3. **Wire pre-flight cancel UI (H3)** — Map<tempId, AbortController> in CreatePanel, expose to App, branch in SongList Cancel button.
4. **One-line M1 fix** — `s.isGenerating || s.stage === 'cancelled'` at App.tsx:899.
5. **substr → slice** at App.tsx:118, 1000 (cosmetic; matches backend convention).
