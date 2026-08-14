# Round-3 Local-LLM Path Regression Review

Scope: verify the residual R2 findings against `e53909eed` ("R2 review fixes batch 4") and hunt for new regressions in the local-LM execution paths (Простой+local 5Hz, Custom+local LM, AI Generate/Format buttons, switch-model, `/api/generate/create-sample`).

Inspected commit: `e53909eed` — 3 code files (`app/App.tsx`, `app/server/src/routes/generate.ts`, `app/services/api.ts`) + 10 docs.

---

## 1. R2 verification (each prior finding revisited)

| R2 finding | Severity | R3 status | Evidence |
|---|---|---|---|
| R1#1 — `decrementPendingClicks(1)` on createSample failure | MUST | ✅ STILL FIXED | `App.tsx:1077` (was 1067 in R2) inside the inner-catch before `return`. Untouched in batch 4. |
| R1#2 — coverPrompt missing → `INVALID_JSON` | MUST | ✅ STILL FIXED | `openrouter.ts` defaulting still in place, batch 4 didn't touch llm code. |
| R1#3 — `coverPrompt` in SONG_FIELDS / STRING_FIELDS | SHOULD | ✅ STILL FIXED | `partialJson.ts` untouched in batch 4. |
| R1#4 — System-prompt "Final check" + few-shots | SHOULD | ✅ STILL FIXED | prompts untouched in batch 4. |
| R1#5 — `lmTemperature` not forwarded to createSample | NIT | ❌ NOT FIXED | `App.tsx:1048-1052` — still 3-arg call. Out of scope for batch 4. |
| R1#6 — `lmModel` hardcoded in CreatePanel simple-mode | NIT | ❌ NOT FIXED | `CreatePanel.tsx:1766` unchanged. Out of scope for batch 4. |
| R1#7 — `(params as any)` casts → claim "_tempId added to GenerationParams type" | NIT (PARTIAL in R2) | 🟡 STILL PARTIAL | Batch 4 added the fields to `app/services/api.ts:GenerationParams` (lines 372-394 — _tempId, DCW cluster, Retake/FlowEdit cluster) — that interface is the one used by `generateApi.startGeneration`. **However**, `App.tsx:14` imports `GenerationParams` from `./types` (the **other**, separate interface at `app/types.ts:59`), which is **untouched** by batch 4. Hence the `as any` casts at `App.tsx:1159-1180` and the trailing `} as any, token)` at line 1180 still don't drop. The api.ts edit is real, but the underlying duplication of `GenerationParams` between `app/types.ts` and `app/services/api.ts` makes the change cosmetic for the App.tsx side. |
| R2#1 — cover-jobs Map race after `consumeCoverState` (cancel mid-flight) | LOW | ❌ NOT FIXED | `cover-jobs.ts:78-83` still no `cancelledJobs` set. The fire-and-forget Promise can still resurrect a deleted Map entry. Net leak still bounded as before — ~150-300KB per cancel race. |
| R2#2 — backend destructure dropping 14 fields | LOW (pre-existing) | ✅ FIXED | This was the headline of batch 4. `routes/generate.ts:222-235` (GenerateBody) + `:387-407` (destructure) + `:491-507` (params object) — all 14 fields (`dcwEnabled, dcwMode, dcwScaler, dcwHighScaler, dcwWavelet, retakeSeed, retakeVariance, flowEditMorph, flowEditSourceCaption, flowEditSourceLyrics, flowEditNMin, flowEditNMax, flowEditNAvg, loraLoaded`) now wired. The persisted `params` JSON now mirrors what UI submits. |

### R3-targeted verifications

- **`App.tsx::cancelGeneration` removes from activeJobsRef + drainQueueWaiters?** ✅ YES. `App.tsx:781` deletes from `activeJobsRef.current`, `:782` updates `setActiveJobCount`, `:783` flips `setIsGenerating(false)` if empty, `:784` calls `drainQueueWaiters()`. Dep array correctly extended with `drainQueueWaiters` (line 790).
- **`App.tsx::resetSingleJob` drainQueueWaiters added?** ✅ YES. `App.tsx:814` calls it inside the existing `if (jobData)` block, dep array updated to `[token, drainQueueWaiters]` (line 816).
- **`routes/generate.ts` consumeCoverState on `failed` status?** ✅ YES. `generate.ts:619` calls `consumeCoverState(req.params.jobId)` inside the `aceStatus.status === 'failed' && aceStatus.error` branch. Pairs with the existing kickoff at `:601` so a CUDA OOM no longer leaks the Map slot.
- **api.ts GenerationParams: _tempId + DCW + FlowEdit + retake + loraLoaded?** ✅ YES (declared) but 🟡 effectively dead because the App.tsx-side `GenerationParams` is the duplicate from `app/types.ts`, not `api.ts`. See R1#7 row above.
- **routes/generate.ts GenerateBody + destructure: 14 fields?** ✅ YES. All three places (interface, destructure, params build) match.
- **Local-LM users with Pollinations OFF affected?** No-op as expected. The `consumeCoverState` on `failed` is a no-op when there's no Map entry. Backend destructure widening only adds optional-undefined fields that the local-LM path doesn't populate. cancelGeneration / resetSingleJob changes are mode-agnostic — they help any flow (including local-LM) that has the FIFO chain parked on `waitForJobsToDrain`.
- **Local-LM users with Pollinations ON: cover gen on `running`, attach via UPDATE?** ✅ Path intact at `generate.ts:582-603` (kickoff on `running`), `:788-801` (attach on `succeeded`). No regressions in batch 4.

---

## 2. New regressions

### 🟢 NONE found in batch 4 code paths.

Specifically simulated and verified clean:

1. **Простой + local LM 0.6B + bulk=10**: counter 0→10→…→0 cleanly; createSample serializes server-side per click; if any one createSample throws, that path now decrements on `App.tsx:1077` and the other 9 are unaffected. cancel-on-job-5 mid-run now removes job from activeJobsRef and drains waiters — a parked bulk-pre-flight click number 6+ (which was awaiting `waitForJobsToDrain`) resumes. **Was broken pre-batch-4 (R2 agent05 NEW-HIGH-R4)**, now fixed.
2. **Custom + local LM + Pollinations ON**: kickoff on first `running` poll, UPDATE on `succeeded` — unchanged. The new `consumeCoverState` on the `failed` branch correctly cleans up the Pending entry that would otherwise have been orphaned forever (it had no path to consumption since the success branch never fired). **This is a fix, not a regression.**
3. **User clicks reset on job 3 mid-bulk**: `resetSingleJob` now drains queue waiters → bulk-pre-flight resumes. Same family fix as above.
4. **`/api/generate/create-sample` failure (LLM down)**: `App.tsx:1077` `decrementPendingClicks(1)` already there from R2 batch 1; batch 4 didn't touch this path. ✅
5. **Backend destructure widening** doesn't break the local-LM path: simple-mode + Pollinations OFF means all 14 new fields are undefined; the `params` object still serializes (just with 14 more `undefined` keys, which JSON.stringify drops). No DB schema change involved (`generation_jobs.params` is opaque blob).
6. **`consumeCoverState` on `failed`** doesn't double-fire — the `aceStatus.status === 'failed'` block only runs when stored `job.status` differed (line 605: `if (aceStatus.status !== job.status)`). Re-polls with already-stored `failed` status skip the branch.

### Soft-flags (not regressions, just observations from R3)

- **NIT** — `cleanupJob` (`App.tsx:744-762`) calls `drainQueueWaiters()` but its `useCallback` dep array is `[]`. The other three (`cancelGeneration`, `resetSingleJob`, `cancelAllGenerations`) correctly list `drainQueueWaiters` in deps. Functionally OK because `drainQueueWaiters` only reads refs (no captured state), but inconsistent with the new style introduced in batch 4 and noisy in eslint-react-hooks if that lint is on. Pre-existing, not a R3 regression.
- **NIT** — The `as any` casts in `App.tsx:1159-1180` are now slightly more egregious because the api.ts side actually defines them; the casts are forced by the `app/types.ts:GenerationParams` duplication. A future cleanup should either drop `app/types.ts:GenerationParams` and import from `services/api.ts` everywhere, or merge the two. Out of scope.
- **NIT** — `cover-jobs.ts` cancel-race Map resurrection (R2#1) remains unfixed. Batch 4 explicitly reports closing the Map leak via the `failed`-branch consume; correct as far as it goes, but the in-flight Promise can still re-`set` after consume. Still LOW severity.

---

## 3. Net assessment + remaining open issues

**Batch 4 lands cleanly with zero new regressions in the local-LM path.** The two new high-impact fixes (cancelGeneration + resetSingleJob now drain queue waiters; failed-status branch consumes cover state) directly close two of the three R2-flagged HIGH/MEDIUM problems. The 14-field destructure widening on the backend closes the pre-existing data-fidelity gap that R2 surfaced.

The api.ts `GenerationParams` typing claim is **literally true** (the fields are declared) but **practically incomplete** because `app/types.ts` carries an independent duplicate `GenerationParams` interface that App.tsx actually imports. The casts are still needed.

### Remaining open items

| # | Severity | Source | Status | Where |
|---|---|---|---|---|
| 1 | NIT | R1#5 | open | `App.tsx:1048-1052` — `lmTemperature` not forwarded to `createSample`. |
| 2 | NIT | R1#6 | open | `CreatePanel.tsx:1766` — `lmModel: 'acestep-5Hz-lm-0.6B'` hardcoded. |
| 3 | NIT | R1#7 | partial | App.tsx still uses `as any` casts because of duplicated `GenerationParams` interface (`app/types.ts:59` vs `app/services/api.ts:279`). Resolution requires consolidating the two interfaces. |
| 4 | LOW | R2#1 | open | `cover-jobs.ts:78-83` — `consumeCoverState` doesn't poison the jobId, so the in-flight Promise inside `startCoverGen` can resurrect a deleted Map entry. ~300KB per cancel-race. |
| 5 | NIT | R3 obs | open | `cleanupJob` `useCallback` deps `[]` should include `drainQueueWaiters` for consistency with sibling handlers. |

**Recommendation:** ship as-is; defer NIT cleanup and the cover-jobs race to a follow-up batch.

---

**Path:** `D:\Projects\TEMP\ACE-Step-Studio\docs\reviews\2026-05-05-r3-agent01-local-llm.md`

| Category | Count |
|---|---|
| R2-FIXED-IN-BATCH-4 | 3 (cancelGeneration drain, resetSingleJob drain, backend 14-field destructure) |
| R2-STILL-FIXED (no regression of prior fix) | 4 |
| R2-STILL-PARTIAL | 1 (api.ts type claim — duplicate interface in types.ts) |
| R2-STILL-OPEN | 3 (R1#5, R1#6, R2#1 cover-jobs race) |
| NEW-REGRESSIONS | 0 |
| NEW-NIT-OBSERVATIONS | 1 (cleanupJob dep array) |
