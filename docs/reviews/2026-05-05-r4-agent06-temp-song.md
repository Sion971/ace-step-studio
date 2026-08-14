# Temp song lifecycle — Round 4 Review

**Range:** master, HEAD `0fe60457f` ("R3 review fixes batch 5")
**Prior:** R1 `2026-05-05-agent06-temp-song.md`, R2 `2026-05-05-r2-agent06-temp-song.md`, R3 `2026-05-05-r3-agent06-temp-song.md`
**Date:** 2026-05-05

Verifying the R3 outstanding-finding set against `0fe60457f`, with focus on whether the dual-`GenerationParams` drift (R3-H1) is finally closed and whether dropping the `(params as any)` whitelist casts in `App.tsx:1151-1178` introduced regressions.

---

## R3 Verification

### R3-H1 — `_tempId` only typed on `api.ts`'s `GenerationParams` (App.tsx imports `./types`'s sibling) — **FIXED**

`0fe60457f` widens `app/types.ts:148-191` (`GenerationParams`), adding **24 lines** that mirror what was already on `api.ts`'s side:
- `dcwEnabled / dcwMode / dcwScaler / dcwHighScaler / dcwWavelet`
- `retakeSeed / retakeVariance / flowEditMorph / flowEditSourceCaption / flowEditSourceLyrics / flowEditNMin / flowEditNMax / flowEditNAvg`
- `loraLoaded`
- `_tempId?: string`
- `pollinations?: { enabled, apiKey?, model?, width?, height?, seedMode?, enhance?, nologo?, safe?, prompt? }`
- `openrouterModel` was widened from `string` to `string | null` (matching api.ts).

`app/App.tsx:1009` is now `const preCreatedId = params._tempId;` — no cast. `app/App.tsx:1177` is now `_tempId: params._tempId,` — no cast. The outer `} as any, token);` wrapper at the old line 1179 (R3-confirmed cast) is gone too — body literal compiles directly against `api.ts`'s `GenerationParams` because both interfaces are now structurally compatible across the field set the call site actually mentions.

`tsc --noEmit` from `app/` reports zero errors involving `_tempId`, `GenerationParams`, `dcw*`, `flowEdit*`, `retake*`, `loraLoaded`, `pollinations`, or `prompt`. (Six pre-existing snake_case Song-mapping errors at App.tsx:887-892 are unrelated to batch 5 — confirmed by checking out `e53909eed` and seeing the same 6 errors.)

R1-H1 / R2-H1 / R3-H1 thread is closed.

### R3-N1 — `cancelGeneration` microtask race (delete → drainQueueWaiters → setSongs cancelled) — **UNCHANGED**

`app/App.tsx:778-789` reordering was not done in batch 5. Order is still:
1. `activeJobsRef.current.delete(jobId)`
2. `setActiveJobCount` / `setIsGenerating`
3. `drainQueueWaiters()`
4. `setSongs(... stage: 'cancelled')`

A parked CreatePanel `.then` fires between steps 3 and 4. Cosmetic (R3 sev: Low) — both cards end in correct states; only the visual transition is jarring.

### R3-N2 — Single-cancel drains queue → "lavinę" of pending LLM pre-flights — **UNCHANGED**

`drainQueueWaiters()` still fires inside `cancelGeneration` (App.tsx:784). Documenting comment was not added. Behavior is intentional per the commit motivating this drain ("permanent occupant" bug fix from R2 batch 4); R3 flagged it only as a UX semantic to either document or split into Skip/Cancel. Neither was done. Severity unchanged: **Medium** (UX surprise).

### R3-N3 — `resetSingleJob` also drains — **UNCHANGED**

`app/App.tsx:814` still calls `drainQueueWaiters()`. Same UX caveat as N2; same status: deferred.

### R3-N4 — Selection compounding when card cancelled (`refreshSongsList` overwrites `selectedSong` due to M1) — **UNCHANGED**

`app/App.tsx:907-919` predicates unchanged. Subsumed by the M1 deferral; will resolve when M1 lands.

---

## Earlier Outstanding Items (R1/R2 still open)

| Finding | Status at HEAD |
| --- | --- |
| H3 — no UI to cancel pre-flight click | **DEFERRED.** No `cancelPreflight`, `preflightControllers`, or `pendingPreflightTempIdsRef` anywhere in `app/`. SongList Cancel on a temp card without `jobId` still calls `cancelGeneration(undefined)` → `/api/generate/cancel/undefined` → silent no-op. |
| M1 — cancelled cards wiped on next refresh | **DEFERRED.** App.tsx:909 predicate still `prev.filter(s => s.isGenerating && !loadedSongs.some(...))`. One-line fix (`s.isGenerating || s.stage === 'cancelled'`) not applied. |
| M2 / N1 — Cancel-All leaves pre-flight zombies + badge desync | **DEFERRED.** `cancelAllGenerations` (App.tsx:819-843) still filters via `tempIds` from `activeJobsRef` only; `setPendingClickCount(0)` at line 842 still desyncs against surviving placeholders. |
| `substr(2, 9)` deprecation | **DEFERRED.** Both call sites unchanged: App.tsx:118 (createTempSongForClick), App.tsx:1010 (handleGenerate fallback). |
| R1 L1-L5 | **DEFERRED.** Acceptable. |

---

## R4 Mental Simulation

**Path A — `_tempId` present (normal flow):**
1. `CreatePanel.handleGenerate` (CreatePanel.tsx:1495-1513) bumps badge, calls `createTempSongForClick(preview)` once per bulk slot → tempIds accumulated → cards already visible in SongList.
2. After OR pre-flight succeeds, CreatePanel calls `onGenerate({ ..., _tempId: tempId })`.
3. `App.handleGenerate(params)` reads `params._tempId` directly (no cast) → truthy → promotion branch (App.tsx:1011-1020). Updates the existing card's title/style/tags/stage. ✓
4. POST to `/api/generate` runs through the explicit whitelist; **all** `params.X` reads are now type-checked. ✓
5. `beginPollingJob(jobId, tempId)` registers — temp card transitions to live job. ✓

**Path B — `_tempId` absent (legacy / direct caller):**
1. `params._tempId` undefined → falsy → `tempId = legacy random id` → legacy `setSongs(prev => [tempSong, ...prev])` + `setSelectedSong(tempSong)` + `setShowRightSidebar(true)` branch (App.tsx:1021-1037). ✓
2. POST proceeds identically. ✓

Both paths work.

**Path C — bulk=3 click, single-cancel mid-flight:**
1. 3 placeholders appear immediately via `createTempSongForClick`.
2. Click 1's chain runs OR → POST → polling.
3. Clicks 2, 3 park on `waitForJobsToDrain`.
4. User cancels card 1 → `cancelGeneration` → `drainQueueWaiters()` fires → click 2's `.then` resumes → card 2 promotes. **R3-N2 still in play** — but acceptable per commit's motivation.
5. After click 2 succeeds, `refreshSongsList` runs → **card 1 silently disappears** (M1 still open). User loses Reset button.

**Path D — TS compile sanity:**
- `tsc --noEmit` from `app/` shows 6 pre-existing errors (unrelated, present at `e53909eed` too).
- Zero errors involving the temp-song / GenerationParams / `_tempId` / DCW / FlowEdit / Pollinations / `prompt` surface.

---

## R4 New Findings

### R4-N1 — Promotion branch skips `setShowRightSidebar(true)` (LOW, behavioral asymmetry)

**Refs:** App.tsx:1011-1020 (promotion branch) vs App.tsx:1021-1037 (legacy branch)

The legacy `else` branch ends with `setShowRightSidebar(true)`. The `_tempId` branch does NOT. On desktop layouts where the user has the right sidebar collapsed, the click that goes through the new instant-feedback path leaves the sidebar collapsed, while a "legacy" click would have opened it. Probably intentional (less surprise mid-bulk-clicks), but worth a comment near the conditional. Severity: **Low**.

### R4-N2 — Promotion branch sets `selectedSong` only if it already matched the tempId (LOW)

**Refs:** App.tsx:1020 — `setSelectedSong(prev => prev?.id === tempId ? {...prev, title, style} : prev)`

`createTempSongForClick` (App.tsx:117-135) does NOT call `setSelectedSong` — the placeholder card appears in the list but is not auto-selected at click time. So when promotion runs, `selectedSong` is whatever the user had selected before clicking Создать. Result: bulk=3 click → 3 cards appear → none selected → user must click one to see right-sidebar details. Compared to legacy path which auto-selected the new card. UX trade-off: bulk would have spammed `setSelectedSong` 3 times anyway, so skipping selection is sane for bulk. For bulk=1 it's a small regression. Severity: **Low**.

### R4-N3 — `prompt` field now plumbed end-to-end (CONFIRMED FIXED, was a silent drop)

**Refs:** `app/server/src/routes/generate.ts:135,322,428`

Batch 5 also adds `prompt` to `GenerateBody`, the destructure, and the `params` object. Frontend was already sending it (App.tsx:1157), backend was silently dropping it. This is a bonus fix from agent07 R3 L6 mentioned here only because it intersects the temp-song promotion (the `params.prompt` read at App.tsx:1157 is no longer wasted). Net: **positive**.

### R4-N4 — `cover-jobs.ts` tombstone Set adds correctness, not a temp-song concern (CONFIRMED FIXED, out-of-scope-but-noted)

**Refs:** `app/server/src/services/cover-jobs.ts:65-180`, `cover-jobs.test.ts:177-211`

Tombstone `Set<string>` + `if (!cancelled.has(jobId)) jobs.set(...)` guards prevent the in-flight Pollinations Promise from resurrecting a consumed entry. 2 new vitest tests cover (a) consume-mid-flight, (b) start-on-tombstoned. Out of scope for temp-song lifecycle but verifies the commit's claim of "94/94 passing". Net: **positive**.

---

## Counts

- R3 findings re-verified: 5 (H1 closure, R3-N1 race, R3-N2 cancel drain, R3-N3 reset drain, R3-N4 selection compounding)
  - **Fully fixed at HEAD:** 1 (R3-H1 — `_tempId` and full whitelist now type-safe; all `(params as any)` casts gone; `as any` on the body literal also gone; tsc clean on the affected surface)
  - **Still deferred:** 4 (R3-N1, R3-N2, R3-N3, R3-N4)
- Earlier R1/R2 findings re-verified: 4 (H3 pre-flight cancel, M1 wipe, M2/N1 cancel-all zombies, substr deprecation)
  - **Fixed:** 0
  - **Still deferred:** 4
- R4 new findings introduced by `0fe60457f`: 2 cosmetic (R4-N1 sidebar asymmetry, R4-N2 selection asymmetry) + 2 confirmed-positive (R4-N3 prompt plumbing, R4-N4 cover-jobs tombstone — both out of scope but flagged for completeness)
- Net regressions in batch 5: **zero**.
- Outstanding High at HEAD: **0** (R3-H1 closed)
- Outstanding Medium: 4 (H3, M1, M2/N1, R3-N2)
- Outstanding Low: 5+ (R3-N1, R3-N3, R3-N4, R4-N1, R4-N2, plus substr × 2 and R1 L1-L5)
- Total active findings at HEAD: ~11 (down from R3's ~12; R3-H1 cleared, no new High/Medium added)

---

## Priority Actions (unchanged from R3, minus H1)

1. **M1 one-liner** — App.tsx:909 → `s.isGenerating || s.stage === 'cancelled'`. Highest ROI, ~5 lines including comment.
2. **M2 / N1** — `pendingPreflightTempIdsRef: Set<string>`; add in `createTempSongForClick`, drain in `beginPollingJob` (graduation) and `cancelAllGenerations` (orphan reap). Closes the cancel-all zombie + badge desync compound.
3. **H3** — `Map<tempId, AbortController>` in CreatePanel + `cancelPreflight` callback in App + SongList branching on `!jobId`. Bigger, but addresses real user-facing gap.
4. **R3-N2 / N3 documentation** — comment near `cancelGeneration` and `resetSingleJob` explaining the queue-drain semantic. ~6 lines.
5. **R3-N1 race reorder** — swap `drainQueueWaiters()` and `setSongs(... cancelled)` in `cancelGeneration`. ~3 lines.
6. **substr → slice** at App.tsx:118 and 1010. ~2 lines.
7. **R4-N1 / N2 commentary** — note the intentional behavioral asymmetry between promotion and legacy branches (sidebar + selection). ~3 lines.

---

## Verdict

Batch 5 is the cleanest of the four review-driven commits in this thread. It closes the longest-standing open item (R3-H1's dual-types drift) without introducing any new High or Medium finding. The two new Lows (R4-N1, R4-N2) are pre-existing UX asymmetries the type fix happened to expose by removing the cast smoke. The `prompt`-field plumbing and `cover-jobs.ts` tombstone are bonus correctness wins from sibling agents that landed in the same commit.

The temp-song lifecycle now has zero outstanding High findings — all remaining work is Medium UX gaps (cancel-pre-flight UI, cancel/reset semantics) and Low cosmetic / API-deprecation items.
