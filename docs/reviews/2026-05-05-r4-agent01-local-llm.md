# Round-4 Local-LLM Path Regression Review

Scope: verify R3 outcomes against batch-5 commit `0fe60457f` ("R3 review fixes batch 5") and hunt for new regressions in the local-LM execution paths.

Inspected commit: `0fe60457f` — 5 code files (`app/App.tsx`, `app/server/src/routes/generate.ts`, `app/server/src/services/cover-jobs.ts`, `app/server/src/services/cover-jobs.test.ts`, `app/types.ts`) + 10 docs.

Pre-condition for the audited path: `useOpenRouter=false` OR (`useOpenRouter=true` AND `activeLmModel !== ''`). Local LM = `acestep-5Hz-lm-0.6B` by default.

---

## 1. R3 verification

| R3 finding | Severity | R4 status | Evidence |
|---|---|---|---|
| R2#1 — cover-jobs Map resurrection (in-flight Promise rewrites after `consumeCoverState`) | LOW | ✅ FIXED | `cover-jobs.ts:73-80` adds `cancelled` Set + `TOMBSTONE_TTL_MS = 5*60_000`. `consumeCoverState` (line 92-101) tombstones the jobId + auto-evicts via `setTimeout(...).unref?.()`. The 3 terminal `jobs.set(jobId, result)` sites (lines 158, 168, 176) are all guarded with `if (!cancelled.has(jobId))`. `startCoverGen` (line 116-120) early-returns `'failed'` when called for a tombstoned jobId, avoiding a Pollinations network call. **2 new vitest cases** (`cover-jobs.test.ts:180-208`) prove (a) zombie resurrection blocked, (b) tombstoned jobId short-circuits before `mockGenerate` fires. |
| R3 §4 / R1#7 — dual `GenerationParams` drift forces `(params as any)` casts in App.tsx | NIT/PARTIAL | ✅ FIXED | `app/types.ts:151-191` (the version App.tsx imports at line 14) now declares `dcwEnabled, dcwMode, dcwScaler, dcwHighScaler, dcwWavelet, retakeSeed, retakeVariance, flowEditMorph, flowEditSourceCaption, flowEditSourceLyrics, flowEditNMin, flowEditNMax, flowEditNAvg, loraLoaded, _tempId, pollinations`. `openrouterModel` widened to `string \| null`. App.tsx whitelist (`App.tsx:1009, 1157-1177`) now uses bare `params.fieldName` — zero `as any` casts, no trailing `} as any, token)`. `tsc --noEmit` produces only 6 pre-existing snake_case Song-property errors, all unrelated to batch 5. The two `GenerationParams` interfaces are still duplicated (`app/services/api.ts:279` vs `app/types.ts:148`) but both are independently widened and structurally compatible at the assignment point. |
| R3 agent07 L6 — `prompt` field forwarded by frontend but dropped by backend destructure | LOW | ✅ FIXED (persistence only) | `routes/generate.ts:136` adds `prompt?: string` to `GenerateBody`. Destructure (`:321`) and params object build (`:428`) include it. The persisted `params` blob now carries the field. **Caveat:** `acestep.ts:155` computes its own local `const prompt = params.customMode ? caption : (params.songDescription \|\| caption)` — `params.prompt` is **not consumed by buildGradioArgs**. So the field reaches the DB row but does not influence Gradio inputs. For the local-LM path this is a no-op functional change (acestep already had a working `prompt` derivation); the fix is about contract fidelity / future readers / cover-prompt-builder fallbacks reading the params blob. |
| R1#5 — `lmTemperature` not forwarded to `createSample` | NIT | ❌ STILL OPEN | `App.tsx:1048-1052` — `createSample({ query, instrumental, vocalLanguage })` is still 3-arg. Backend defaults to 0.85 regardless of the user's slider. Out-of-scope for batch 5 (NIT). |
| R1#6 — hardcoded `lmModel: 'acestep-5Hz-lm-0.6B'` in CreatePanel simple-mode payload | NIT | ❌ STILL OPEN | `CreatePanel.tsx:1766` unchanged. Out-of-scope for batch 5 (NIT). |
| R2 carry — AbortController cooperative cancellation through `generatePollinationsCover` | NIT (alt-fix in R2) | ❌ INTENTIONALLY DEFERRED | Tombstone closes the leak; AbortController would additionally save Pollinations bandwidth. Not regressed; explicitly out-of-scope. |
| R3 obs — `cleanupJob` `useCallback` deps `[]` should include `drainQueueWaiters` | NIT | ❌ STILL OPEN | `App.tsx:744-762` (per R3 line numbers) untouched in batch 5. Cosmetic. |

---

## 2. Targeted batch-5 verifications

### 2.1 `cover-jobs.ts` tombstone — semantic correctness

- **TTL choice:** `5*60_000 = 300s`. Pollinations call timeout is 60s (per R3 commit message and `pollinations.ts` config). 5× margin is safe — any in-flight Promise will have resolved/rejected long before the tombstone evicts.
- **`.unref?.()` syntax:** Optional chaining means if the host runtime returns a numeric timer ID instead of a Timeout object (browser polyfill in tests), the call no-ops cleanly. Node 18+ `Timer` always exposes `.unref()` so the production path attaches normally and the timer doesn't keep the event loop alive. ✅
- **Memory shape of `cancelled` Set:** stores 36-char UUIDv4 strings. Even at 1000 cancels stretching the 5-min window the Set is ~50 KB. Trivial.
- **Re-entrancy:** if `startCoverGen` is called for a jobId that was tombstoned then evicted (>5 min later), it would now succeed and start a new gen. By that time the original consumer has already emitted `failed` to the song row, so a resurrected entry would still leak — but only if some external caller reuses the jobId, which `generateUUID()` collisions effectively rule out. ✅ Acceptable.
- **Non-emptying of `cancelled` between server runs:** TTL eviction is the only reaper. With long-uptime (`cron`-restart, no restarts) and 1000s of cancels, Set has ~1000 strings at any 5-min snapshot. Effectively bounded; not a leak.

### 2.2 `types.ts` widening — TS compile and runtime

- All 17 added fields declared optional (`?`). Local-LM users in Простой mode populate `_tempId`, `prompt: songDescription`, `loraLoaded`, and `pollinations: { enabled: false }` (per `CreatePanel.tsx:1742-1771`). The remaining DCW/FlowEdit/retake cluster is untouched in simple-mode — they are `undefined` and JSON.stringify drops them. ✅
- App.tsx whitelist now uses `params.fieldName` directly. For local-LM Простой users:
  - `params.prompt = songDescription` (set in CreatePanel:1745)
  - `params.dcwEnabled, params.dcwMode, ...` — all `undefined` (CreatePanel simple branch never sets them)
  - `params.retakeSeed, params.flowEditMorph, ...` — all `undefined`
  - `params.loraLoaded` — set (CreatePanel:1771)
  - `params.openrouterModel` — `undefined` for local-LM (CreatePanel only sets it in custom branch at :1647)
  - `params.pollinations = { enabled: false }` (CreatePanel:1673 fallthrough)
  - `params._tempId = tempIdForThisJob`
- The body sent to `generateApi.startGeneration` is structurally compatible with `app/services/api.ts:GenerationParams` (which has all the same fields). No TS error.

### 2.3 `routes/generate.ts` `prompt` field

- Added in three places (`:136` interface, `:321` destructure, `:428` params object). 
- Backend consumers of `params.prompt`: **none** (verified via `grep -rn "params\.prompt"` — zero hits in `app/server/src/`). The cover-prompt fallback at `:537-552` reads `pol.prompt` (Pollinations sub-blob), not `params.prompt`.
- `acestep.ts:155` computes `prompt` locally, shadowing any incoming `params.prompt`. So the field is persisted (DB params JSON, status responses) but not wired into audio gen. Persistence-only fix — acceptable since R3 agent07 L6 was a "field is sent but dropped" findability complaint, not a behavior bug. ✅

### 2.4 Local-LM scenarios re-simulated

**Scenario A — Простой + local LM 0.6B + Pollinations OFF + bulk=1**
1. `incrementPendingClicks(1)`, `_tempId=tempIds[0]`, simple-mode payload includes `prompt: songDescription, pollinations: { enabled: false }`. ✅
2. `App.tsx:handleGenerate` reads `params._tempId` (now type-clean), promotes the placeholder.
3. `createSample({ query, instrumental, vocalLanguage })` runs → `enrichedParams` → `startGeneration` POST. The POST body fields `prompt, dcwEnabled, ..., flowEditNAvg, loraLoaded, openrouterModel, pollinations, _tempId` are all assigned from `params` (no casts). Undefined fields strip in JSON.stringify.
4. Backend destructures `prompt` (and the 14 R3-batch-4 fields). Persists in `params` blob.
5. Cover-gen kickoff at `:535-551` sees `pol = { enabled: false }` → `pol.model && pol.prompt` undefined → no `startCoverGen` call. ✅ No tombstone interaction needed.
6. Audio finishes → INSERT song. `cover_url=null`. `getCoverState(jobId)` undefined → no attach loop. MP3 has picsum thumbnail (id3-tagger fallback). ✅
7. Counter trace: 0 → 1 → 0 (decrement at `:1186`).

**Scenario B — Простой + local LM + bulk=10, user cancels job #5 mid-flight**
1. 10 incrementPendingClicks, 10 onGenerate calls, 10 startGeneration POSTs. Each backend job stores `params` blob with empty `pollinations`.
2. No cover-gen kickoff for any of them (Pollinations OFF) → no Map entries for any jobId.
3. User clicks cancel on job#5. `cancelGeneration` calls `/cancel/:jobId`, which calls `consumeCoverState(jobId)` (no-op — Map has no entry for this jobId; tombstone is added but harmless), updates DB row to `failed`.
4. Frontend `cancelGeneration` removes from `activeJobsRef`, calls `drainQueueWaiters()` (R3 batch 4 fix), pending click slot already released.
5. ✅ No regression; tombstone never resurrects since no Promise was running.

**Scenario C — Custom + local LM + Pollinations ON, user cancels mid-cover-gen**
1. Job posts with `pollinations: { enabled: true, model, prompt: effCoverPrompt, ... }`.
2. Audio kicks off. First `running` poll at `routes/generate.ts:535-551` triggers `startCoverGen(jobId, polCfg)`. Map gets pending entry. In-flight Pollinations Promise.
3. User cancels. `consumeCoverState(jobId)` deletes the Map entry AND adds to `cancelled`.
4. Pollinations resolves (or times out) — the IIFE checks `cancelled.has(jobId)` → skips `jobs.set`. Map stays clean. ✅ The R2 leak is now closed.
5. After 5 min, `setTimeout` evicts the tombstone. ✅
6. Subsequent attempts to `startCoverGen` for a recycled-jobId (impossible due to UUID) would no-op for 5 min.

**Scenario D — Custom + local LM + Pollinations ON, status poll re-fires `running` after job already moved to `failed`**
- `startCoverGen` (called from `:535-551`) checks `cancelled` first. If a `failed` poll preceded and called `consumeCoverState` (R3 batch 4 added this on `:619`), the tombstone blocks a redundant re-kickoff. ✅
- Even without the tombstone, `existing` early-return at line 113-114 would short-circuit (Map has the failed entry). But after the failed-branch `consumeCoverState`, the Map is empty — without the tombstone, a stale `running` re-poll would have started a fresh Pollinations call. Tombstone closes that race. ✅

### 2.5 New observation — `consumeCoverState` on success path

`routes/generate.ts:798-801` (per R3 line numbers, may have shifted by ±2) consumes the cover state after the success-attach UPDATE. This adds the jobId to the `cancelled` tombstone Set (the function is unconditional). Net impact: a 5-min window where re-attempting `startCoverGen` for the same jobId returns failed without firing. For successful jobs that just had their cover attached, this is correct (no need to regen). For some hypothetical retry/reset workflow that reuses the jobId, this would block it for 5 min. Currently no such workflow exists — `resetSingleJob` re-enqueues with a fresh jobId. ✅ No regression. Worth a comment noting "tombstone applies to success-consume too".

---

## 3. Net assessment

**Batch 5 lands cleanly with zero new regressions in the local-LM path.** Three of the four R3-flagged residual issues are closed:

1. **Tombstone Set in `cover-jobs.ts`** — closes the in-flight resurrection race that was leaking ~300 KB Buffer per cancel/fail. Implemented carefully with TTL eviction and `.unref?.()` for event-loop hygiene. Test coverage added (94/94 tests passing per commit message). ✅
2. **Dual-`GenerationParams` widening in `app/types.ts`** — App.tsx whitelist now type-clean, no `as any` casts. The api.ts and types.ts interfaces remain duplicated but are mutually compatible. ✅
3. **`prompt` field persisted by backend** — destructure widening reaches the DB. Audio-gen path unaffected (acestep.ts shadows). ✅

**No new regressions surfaced for the audited paths.** The `prompt` destructure is purely additive and `params.prompt` is read by zero downstream consumers, so persistence-only is safe. The tombstone Set is a closed system (only writers: consumeCoverState; only readers: startCoverGen, terminal jobs.set guards) with bounded growth.

### Remaining open items

| # | Severity | Source | Status |
|---|---|---|---|
| 1 | NIT | R1#5 | open — `App.tsx:1048-1052` createSample missing lmTemperature |
| 2 | NIT | R1#6 | open — `CreatePanel.tsx:1766` hardcoded `lmModel` |
| 3 | NIT | R3 obs | open — `cleanupJob` useCallback deps `[]` |
| 4 | NIT | R4 obs | open — alt-fix: thread AbortController through generatePollinationsCover to also save Pollinations bandwidth on cancel (tombstone already closes the memory leak) |

**Recommendation:** ship as-is; the three NITs are cosmetic and the AbortController alt-fix is a follow-up enhancement, not a bug.

---

**Path:** `D:\Projects\TEMP\ACE-Step-Studio\docs\reviews\2026-05-05-r4-agent01-local-llm.md`

| Category | Count |
|---|---|
| R3-FIXED-IN-BATCH-5 | 3 (cover-jobs tombstone, types.ts widening / cast removal, backend prompt destructure) |
| R3-STILL-OPEN | 4 (R1#5 lmTemperature, R1#6 hardcoded lmModel, cleanupJob deps, AbortController alt-fix) |
| NEW-REGRESSIONS | 0 |
| NEW-NIT-OBSERVATIONS | 1 (consumeCoverState success-path also tombstones — currently harmless, worth a comment) |
