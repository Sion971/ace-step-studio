# Temp song lifecycle — Round 3 Review

**Range:** master, HEAD `e53909eed` ("R2 review fixes batch 4")
**Prior:** R1 `2026-05-05-agent06-temp-song.md` (12 findings: 3H/4M/5L), R2 `2026-05-05-r2-agent06-temp-song.md` (1 fix, 9 deferred, 3 new N1-N3)
**Date:** 2026-05-05

Verifying R2 outstanding items against `e53909eed`, hunting R3 regressions introduced by the new `cancelGeneration` / `resetSingleJob` rewrites and the `_tempId` API typing.

---

## R2 Verification

### R2 H1 — `_tempId` actually on `GenerationParams` — **PARTIALLY FIXED**

`e53909eed` adds the field at `app/services/api.ts:391-394`:

```ts
// Pre-created placeholder card id from CreatePanel — App.tsx promotes the
// existing card instead of creating a duplicate. Underscore-prefixed since
// it's a UI tunnel, not an audio-gen knob.
_tempId?: string;
```

So R1's claim that R1's H1 lands in api.ts is now true. **But App.tsx imports `GenerationParams` from `./types`, not from `./services/api`** (App.tsx:14: `import { Song, GenerationParams, View, Playlist } from './types';`). Inspecting `app/types.ts:59-152`: the second `GenerationParams` interface (the one used as `handleGenerate`'s `params` parameter) **still has no `_tempId` field**. Last property is `openrouterModel?: string`.

Net consequence:
- `App.tsx:1009` — `const preCreatedId = (params as any)._tempId as string | undefined;` — **`as any` cast still required** (params is typed as `./types`'s `GenerationParams`).
- `App.tsx:1179` — `_tempId: (params as any)._tempId,` — **`as any` cast still required**.
- The api.ts addition only helps the callers of `generateApi.generate(params)` *inside* api.ts (and CreatePanel if it imported from there) — but CreatePanel passes the field as a literal property on the `onGenerate(...)` arg, which is typed against App's prop signature, ultimately `./types`'s `GenerationParams`.

So the rename-protection benefit promised in R1 H1 is **half delivered**: api.ts side is type-safe, App.tsx side is still untyped. A rename of `_tempId` in CreatePanel will still silently break promotion in App.tsx without any TS error.

Sev: still **High** (lifecycle footgun) until the field is also added to `app/types.ts:59` and the two casts at App.tsx:1009 and 1179 are dropped. Trivial three-line follow-up.

---

### R2 H2 — App.tsx:1034 bare key — **CONFIRMED FIXED in R2** (no further change at HEAD)

App.tsx:1034 reads `stage: 'writingLyricsAndStyle'` (i18n key, not resolved string). No regression in `e53909eed`.

---

### R2 H3 — No UI to cancel pre-flight click — **STILL DEFERRED**

`grep -rn "cancelPreflight\|preflightControllers" app/` → zero hits at HEAD. `AbortController` at `CreatePanel.tsx:1553` still allocated locally inside the `.then` chain, never stashed in a ref, never exposed. SongList Cancel button on a pre-flight card (no `jobId`) still calls `cancelGeneration(undefined)` → `fetch('/api/generate/cancel/undefined')` → 404 → silent no-op.

Sev unchanged: **Medium-High**. User pressing Cancel during the 20s OpenRouter wait gets nothing.

---

### R2 M1 — Cancelled cards wiped on next refresh — **NOT FIXED**

`refreshSongsList` predicate at `App.tsx:909`:

```ts
const stillGenerating = prev.filter(s => s.isGenerating && !loadedSongs.some(l => l.id === s.id));
```

Cancelled cards (`isGenerating: false, stage: 'cancelled'`) still drop on the next refresh — which is triggered by *any* successful job at App.tsx:954. One-line fix from R2 (`s.isGenerating || s.stage === 'cancelled'`) was not applied. Sev: **Medium**.

---

### R2 M2 / N1 — Cancel-all leaves pre-flight zombies & badge desync — **NOT FIXED**

`cancelAllGenerations` at App.tsx:819-843 still filters by `tempIds` collected from `activeJobsRef.current.values()`. Pre-flight clicks haven't reached `beginPollingJob` yet → not in `activeJobsRef` → their temp cards survive cancel-all. The added `setPendingClickCount(0)` at line 842 still resets the badge to 0 while the temp cards continue spinning, so badge=0 and zombie cards desynchronize as flagged in R2 N1.

No `pendingPreflightTempIdsRef` was introduced. Sev: **Medium** (M2/N1 still single bug, double-counted only because the post-fix UX is *worse* on this dimension than pre-fix).

---

### R2 substr deprecation — **NOT FIXED**

Both call sites still present:
- `App.tsx:118` — `Math.random().toString(36).substr(2, 9)` (createTempSongForClick)
- `App.tsx:1010` — same pattern (handleGenerate fallback)

Trivial. Sev: **Low**.

---

### Outstanding R1 lows L1-L5 — **all still deferred**, acceptable.

---

## New in R3 (introduced by `e53909eed`)

### R3-N1 — `cancelGeneration` race: cancelled card + new placeholder card simultaneously (LOW-MEDIUM)

**Refs:** App.tsx:778-789

`cancelGeneration` now (per `e53909eed` motivation in commit body — "single-cancel left job 'permanent occupant'") deletes the job from `activeJobsRef` and calls `drainQueueWaiters()` BEFORE the `setSongs` call that marks the card cancelled:

```ts
const jobData = activeJobsRef.current.get(jobId);
if (jobData) {
  clearInterval(jobData.pollInterval);
  activeJobsRef.current.delete(jobId);             // (1) drop from ref
  setActiveJobCount(activeJobsRef.current.size);
  if (activeJobsRef.current.size === 0) setIsGenerating(false);
  drainQueueWaiters();                              // (2) wake parked clicks
  setSongs(prev => prev.map(s =>                    // (3) mark cancelled
    s.id === jobData.tempId ? { ...s, isGenerating: false, stage: 'cancelled' } : s
  ));
}
```

Order (1) → (2) → (3) opens a microtask window where:
- `activeJobsRef` is empty
- `drainQueueWaiters` fires → resolves a parked `waitForJobsToDrain` Promise inside CreatePanel's queued click
- That click's `.then` runs `onGenerate(...)` → `handleGenerate` → `createTempSongForClick` (if `_tempId` was missing — in normal flow it's always there) and POSTs → `beginPollingJob` registers a NEW jobId in `activeJobsRef`
- THEN (3) runs, marking the OLD tempId card as cancelled

Result: UI shows old card with stage='cancelled' AND new card with stage='stageGeneratingTextOpenRouter' / 'queued'. Acceptable, since both cards are real and meaningful — the user did cancel one and a parked click did fire — but if a user thought the queue was paused, seeing a brand-new spinner appear right after they pressed Cancel is surprising.

Severity: **Low** (race is real but cosmetic; both cards are correct outcomes). Mitigation: do the `setSongs` call BEFORE `drainQueueWaiters`, or batch state updates with `flushSync` boundaries — minor.

### R3-N2 — Cancelled card unblocks queue prematurely (NEW QUEUE SEMANTIC, MEDIUM)

**Refs:** App.tsx:780-784

The R3 fix's stated intent: "single-cancel left job 'permanent occupant' → next click's pre-flight hung forever". The fix correctly removes `activeJobsRef[jobId]` so `waitForJobsToDrain` can resolve. But this changes a queue-mental-model invariant:

- Pre-R3: `waitForJobsToDrain` resolves only when a job *completes* (successfully or via error in `cleanupJob`). Cancel was a permanent block.
- R3: cancel ALSO drains the queue. So a user with bulk N=10 who cancels job 1 will see jobs 2-10 immediately fire their LLM pre-flight one-by-one — not what "cancel" usually means to a user.

Compare to `cancelAllGenerations` which the user clearly intends as "stop everything, don't keep going". Single-cancel is now semantically halfway between "skip this one" and "cancel". The button label is just "Cancel" with no disambiguation. Some users will press Cancel expecting nothing else to start.

This is arguably the right behavior (otherwise one stuck job freezes the whole queue), but it's a behavioral change worth either:
- Documenting in a comment near `cancelGeneration` ("single-cancel skips current and proceeds to next queued click — equivalent to 'next' on a media player")
- OR splitting the UI: "Skip" (drain → next) vs "Cancel" (don't continue), the latter calling `cancelAllGenerations` semantics on just that click's downstream.

Sev: **Medium** (UX surprise, not a correctness bug).

### R3-N3 — `resetSingleJob` now drains too (consistent with N2, same caveat) (LOW)

**Refs:** App.tsx:793-816

`resetSingleJob` got the same `drainQueueWaiters()` addition at line 814. The user intent here ("Reset" button on a cancelled card) is "blow this card away cleanly" — and now it ALSO releases parked queue waiters. If the user reset-ed a card without realizing the queue was parked behind it, suddenly N more LLM calls fire. Same UX caveat as N2; same fix surface (commentary or UI disambiguation). Sev: **Low**.

### R3-N4 — `setSongs(...).map` keeps cancelled card visible but `selectedSong` may still point at it via stale ref (LOW)

**Refs:** App.tsx:786-788, 916-919

`refreshSongsList` at App.tsx:917-919 has logic:

```ts
if (current?.isGenerating || (current && !loadedSongs.some(s => s.id === current.id))) {
  setSelectedSong(loadedSongs[0] ?? null);
}
```

A cancelled card has `isGenerating: false` AND is not in `loadedSongs` (no real DB row), so the second clause `current && !loadedSongs.some(...)` matches → `setSelectedSong` is overwritten with the newest real song. Combined with M1 (cancelled card silently wiped from `songs` on the same refresh), the user clicking Reset finds the card gone AND the right sidebar showing some unrelated song. Compounded UX failure that exists only because M1 wasn't fixed. Filing as a reminder that M1 has knock-on effects beyond just losing the Reset button.

Sev: **Low** (subsumed by M1 fix).

---

## Mental Simulation (post-`e53909eed`)

**Scenario A — 3 rapid clicks in bulk=1:**
1. Click 1: temp card, "Ожидает в очереди…" → "Пишу текст через OpenRouter…" → POST → polling → "queued"/"running"
2. Clicks 2, 3 park on `waitForJobsToDrain`
3. User cancels card 1
4. `cancelGeneration` deletes from activeJobsRef, drains waiters, marks card 1 cancelled
5. Click 2's `.then` resumes → its temp card transitions; click 3 stays parked until 2 finishes
6. After click 2 succeeds, refreshSongsList runs → **card 1 silently wiped** (M1)

Result: card 1 reset button appears for ~5-30s then vanishes when click 2 completes. **M1 manifests in this common path.**

**Scenario B — bulk=5, 2 cards in pre-flight + 3 placeholders, user clicks Cancel All:**
- Backend `/api/generate/cancel-all` fires. Only the 1 active polling job (whichever finished pre-flight first and registered in `activeJobsRef`) is in the ref → its tempId is removed from `songs`.
- Cards 2-5: `setSongs(prev => prev.filter(s => !tempIds.has(s.id)))` keeps them (their ids aren't in `tempIds`). Zombies remain.
- `setPendingClickCount(0)` resets badge → badge desync from cards (R2 N1 still open).
- `drainQueueWaiters` fires; pre-flight chain resumes; OR completes for each parked click; new real songs appear.
- User pressed Cancel All and got 4 new songs anyway.

**Scenario C — single-cancel during bulk=5:** new R3-N2 surprise. User cancels job 1; jobs 2-5 immediately start firing LLM in series.

---

## Counts

- R2 findings re-verified: 7 (H1, H2, H3, M1, M2/N1, substr, plus N2-N3 deferred-cleanup)
  - **Fixed at HEAD:** 1 partial (H1 api.ts side only — types.ts side missing → casts still required)
  - **Confirmed already-fixed in R2:** 1 (H2 sub-point 2)
  - **Still not fixed:** 5 (H1 types.ts side, H3, M1, M2/N1, substr)
- R3 new findings introduced by `e53909eed`: 4 (R3-N1 race, R3-N2 queue semantic, R3-N3 reset semantic, R3-N4 selection compounding)
- Outstanding High: 1 (H1 partial — kill the casts at App.tsx:1009, 1179 by adding `_tempId?: string` to `app/types.ts:59`'s `GenerationParams`)
- Outstanding Medium: 3 (H3 deferred, M1 trivial one-line, M2/N1 needs `pendingPreflightTempIdsRef`, plus new R3-N2 semantic)
- Outstanding Low: 4+ (substr deprecation, R3-N1 microtask race, R3-N3 reset-skip semantic, R3-N4 subsumed by M1, plus all R1 L1-L5)
- Total findings active at HEAD: ~12 (5 carried from R1/R2 + 4 new R3 + 3 partial-credit / cleanup notes)

## Priority Actions

1. **Finish H1 properly** — add `_tempId?: string;` to `app/types.ts:59` (GenerationParams), drop `as any` at App.tsx:1009 and App.tsx:1179. The api.ts addition is necessary but insufficient because App.tsx imports the OTHER GenerationParams. Three-line patch.
2. **M1 one-liner** — App.tsx:909 → `s.isGenerating || s.stage === 'cancelled'`.
3. **M2/N1** — `pendingPreflightTempIdsRef: Set<string>`; add in `createTempSongForClick`, drain in `beginPollingJob` (graduation) and in `cancelAllGenerations` (orphan reap).
4. **Document R3-N2/N3** — at minimum, comment near `cancelGeneration` clarifying that single-cancel drains the queue and proceeds to the next parked click. Better: split UI into Skip vs Cancel-And-Stop.
5. **R3-N1 race** — reorder `cancelGeneration`: do `setSongs` BEFORE `drainQueueWaiters`. Cosmetic but cheap.
6. **substr → slice** at App.tsx:118 and 1010.
7. **H3** still deferred — `Map<tempId, AbortController>` in CreatePanel + cancelPreflight callback in App + SongList branching on `!jobId`.
