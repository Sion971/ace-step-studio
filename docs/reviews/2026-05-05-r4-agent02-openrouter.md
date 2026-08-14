# OpenRouter Integration — Round 4 Review (agent02)

Scope: verify whether batch 5 (`0fe60457f`) closes any R3-open OpenRouter findings, and hunt for new regressions introduced by the batch-5 changes (App.tsx whitelist `as any` removal, types.ts GenerationParams widening including `openrouterModel?: string | null` and `pollinations?` blob, generate.ts `prompt` recovery, cover-jobs.ts tombstone Set).

HEAD at review time: `0fe60457f`.
Prior reviews:
- `docs/reviews/2026-05-05-agent02-openrouter.md` (R1, 12 findings)
- `docs/reviews/2026-05-05-r2-agent02-openrouter.md` (R2, 5 new + close-out)
- `docs/reviews/2026-05-05-r3-agent02-openrouter.md` (R3, 0 new + 7 carry-forward)

Severity legend: **[BLOCKER]** ship-stopper · **[HIGH]** likely user-visible bug · **[MED]** subtle / partial breakage · **[LOW]** nit · **[FIXED]** resolved on HEAD · **[CONFIRMED OPEN]** still present on HEAD · **[DEFERRED]** acknowledged-not-landing.

Skipped per task brief: security review.

---

## Batch-5 surface area on OpenRouter integration

`git diff e53909eed..0fe60457f --stat` files of interest:
- `app/App.tsx` (+22,−24) — `params._tempId` access without `as any`; whitelist drops 18 `(params as any)` casts; outer `as any` on the payload object removed.
- `app/types.ts` (+39,−1) — `GenerationParams` widened: `openrouterModel?: string | null` (was `string`), 24 lines added (DCW + FlowEdit + retake + loraLoaded + `_tempId` + pollinations blob).
- `app/server/src/routes/generate.ts` (+6) — `prompt` field added to `GenerateBody`/destructure/`params` blob (was being silently dropped per R3 agent07 L6).
- `app/server/src/services/cover-jobs.ts` (+33) — tombstone Set (R3-1/M7 leak fix).
- `app/server/src/services/cover-jobs.test.ts` (+29) — 2 new vitest tests for tombstone behavior.

Files NOT touched by batch 5 (re-confirmed by `git diff e53909eed..0fe60457f -- <path>` returning empty output):
- `app/components/CreatePanel.tsx` ← per-click pre-flight path. **Unchanged from R3.**
- `app/services/llm/openrouter.ts`, `partialJson.ts`, `prompts.ts`, `prompts/system_*.en.md`, `useOpenRouterGeneration.ts`, `storage.ts`. **Unchanged from R3.**
- `app/services/api.ts`. **Unchanged from R3** (already widened in batch 4).

**Net implication**: every R3-open OpenRouter finding's status carries forward unless `types.ts`/`App.tsx` widenings transitively interact with OR. Below I verify each.

---

## R3-open finding status on HEAD `0fe60457f`

### R1 #6 / R2 NR-2 [MED] `lastOpenRouterModelId` first-click off-by-one (row 1 NULL) — **[CONFIRMED OPEN]**

`app/components/CreatePanel.tsx:1577-1578` (HEAD):
```ts
const orModelId = llmStorage.getOpenRouter().model;
if (orModelId) setLastOpenRouterModelId(orModelId);
```

Then at `:1647`:
```ts
openrouterModel: lastOpenRouterModelId,
```

`grep -n` on the file confirms only four sites: declaration at `:255`, the orHook bridge at `:1101`, the per-click stamp at `:1578`, and the payload reader at `:1647`. No new local-`const` indirection, no ref hoisting, no `orModelId ?? lastOpenRouterModelId` fallback. Batch 5 did not touch CreatePanel.

Mental simulation of fresh-session first click in Простой+OR+noLM (re-run on HEAD `0fe60457f`):
1. Initial state: `lastOpenRouterModelId = null` (`:255` `useState<string | null>(null)`).
2. User types description, clicks Создать.
3. `handleGenerate` enters per-click branch at `:1536`.
4. The `handleGenerate` closure was instantiated when this render committed; at that moment `lastOpenRouterModelId === null`. The closure captures **that** `null` for the entire duration of this `handleGenerate` invocation.
5. `llmPreflightQueueRef.current.catch(() => null).then(...)` runs the pre-flight, resolves with a valid `SongDraft`.
6. `:1577`: `orModelId = "anthropic/claude-3.5-sonnet"` (or whatever the user picked).
7. `:1578`: `setLastOpenRouterModelId(orModelId)` is **enqueued**. React 18+ state setters are async — the update is scheduled into the next render's prepare phase. The current closure's `lastOpenRouterModelId` binding does **not** update.
8. Code falls through synchronously to the `for (let i = 0; i < bulkCount; i++)` loop at `:1612`.
9. `:1647`: `openrouterModel: lastOpenRouterModelId` reads the closure-captured `null`.
10. `onGenerate({ ..., openrouterModel: null })` → `App.tsx::handleGenerate` → `generateApi.startGeneration(...)`.
11. Backend `routes/generate.ts:710` inserts `params.openrouterModel || null` → song row `openrouter_model = NULL`.
12. After `handleGenerate` returns, React commits the state update; subsequent click's `handleGenerate` closure captures the new value.

**Outcome unchanged from R3**: row 1 of every fresh session has `openrouter_model = NULL` despite OpenRouter being actively used. Rows 2..N populate correctly because the setState committed by then.

The R2/R3 recommended fix (capture `orModelId` into a local `const` and reference it directly at `:1647`, e.g. `openrouterModel: orModelId ?? lastOpenRouterModelId`) was **not** applied in batch 5.

**Suggested fix for batch 6** (synchronous read instead of async state):
```ts
// near :255
const lastOpenRouterModelIdRef = useRef<string | null>(null);
const [lastOpenRouterModelId, _setLastOpenRouterModelId] = useState<string | null>(null);
const setLastOpenRouterModelId = (v: string | null) => {
  lastOpenRouterModelIdRef.current = v;       // synchronous — closure-readable now
  _setLastOpenRouterModelId(v);               // async — for re-renders/UI
};
// at :1647
openrouterModel: lastOpenRouterModelIdRef.current,
```
A ref's `.current` is mutable and read synchronously inside the same closure invocation — no off-by-one window. The accompanying `useState` keeps any UI consumers (badge tooltip, etc.) in sync via the normal render cycle.

Cheaper alternative if no UI consumer reads the state: inline the storage call into the payload, dropping the state entirely:
```ts
openrouterModel: llmStorage.getOpenRouter().model || null,
```
This always reflects the model **at submission time** rather than "the model used for the last successful pre-flight" — semantics are identical for single-click flows but slightly different for bulk loops if the user changes the model mid-loop (extremely unlikely).

**Verdict**: still open after 5 batches. Not fixed by R3-promised batch 5.

### R2 NR-1 [MED] Silent `coverPrompt = ''` post-parse default — **[CONFIRMED OPEN]**

`app/services/llm/openrouter.ts` last touched in `10a87ab0e` (batch 2). Batch 5 file diff empty. Behavior at `:290-298` unchanged: any 8-field response is silently upgraded to a 9-field `SongDraft` with `coverPrompt: ''`; `REQUIRED_FIELDS` validation cannot fire for `coverPrompt`.

**Verdict**: still open. Defensive default still erodes strictness; risk profile unchanged.

### R2 NR-4 [LOW] Chain firewall + `console.error`-only error path hides pre-flight failures — **[CONFIRMED OPEN]**

`CreatePanel.tsx:1565-1568` and `:1579-1583` unchanged. Both still log-only — no toast push, no `GenerationStatusPanel` push, no `OpenRouterError.code` surfacing. Combined with the chain firewall (`.catch(() => null).then(...)` at `:1543`), a misconfigured key / down provider produces a silent disappearing temp-song card.

**Verdict**: still open. Observability gap persists.

### R1 #5 [HIGH, DEFERRED] `AbortController` per-click pre-flight unwired — **[CONFIRMED OPEN, DEFERRED]**

`CreatePanel.tsx:1552-1564` unchanged. `ac` is still local to the closure; nothing calls `ac.abort()`; no `llmPreflightAbortRef`.

R3 noted this is effectively neutralized for the audio-job path by R2's `cancelGeneration` drainQueueWaiters fix (the audio side now cleans up correctly), but the LLM pre-flight chain itself remains uncancellable in the bulk=N case. Batch 5 did not touch this.

**Verdict**: still open. R3 deferred-acceptable judgment carries.

### R1 #2 / R1 #4 / R1 #7 — **all CONFIRMED OPEN, all neutralized/acceptable per R3**

Untouched by batch 5; no new evidence to re-evaluate.

---

## R4 new regression hunt — does batch 5 affect OpenRouter?

### R4 NR-1 [LOW] `types.ts::GenerationParams.openrouterModel` widened from `string` to `string | null` — **[NEUTRAL on OR runtime, MICRO-DRIFT in api.ts Song]**

Diff:
```diff
-  openrouterModel?: string;
+  openrouterModel?: string | null;
```

This widening is the right move — `lastOpenRouterModelId` is `useState<string | null>` and the App.tsx whitelist at `:1173` now passes it bare (`openrouterModel: params.openrouterModel`) without `as any`. Pre-batch-5 the type said `string`, the runtime value was `null`, and the cast was hiding the lie. Batch 5 makes the type honest.

**Backend impact**: `routes/generate.ts:710` does `params.openrouterModel || null` → string truthy stored, falsy (null/empty/undefined) becomes literal `null`. Identical SQL output for `null` and `undefined` and `''` — all three insert NULL. **No behavior change.**

**Micro-drift**: `app/services/api.ts:115` still has `openrouterModel?: string;` on the `Song` interface (the response-shape type, not GenerationParams). The four assignments at `:133`, `:168`, `:188`, `:232` use `s.openrouter_model || s.openrouterModel` which yields `string | undefined` — so functional behavior is unaffected. But strictly speaking `openrouter_model` columns can be NULL in the DB; the in-memory `Song.openrouterModel` slot now diverges from `GenerationParams.openrouterModel` (the request shape was widened to `string | null` in batch 4 already, both `app/types.ts:151` and `app/services/api.ts:397`; only the response-side `Song` interface remains narrow).

**Why this is LOW**: the `||` pattern collapses `null` to `undefined` at the boundary, so consumers reading `song.openrouterModel` already see `string | undefined`, matching the type. The drift is purely cosmetic and would only surface if a future refactor passed the raw row directly without the `||` collapse. Not a bug today.

**Verdict**: neutral on OR runtime; recommend widening `Song.openrouterModel?: string | null` to match the rest of the codebase in a future pass.

### R4 NR-2 [LOW] `types.ts::GenerationParams.pollinations.prompt?: string` is optional — **[NEUTRAL, backend guards]**

Diff (new field):
```ts
pollinations?: {
  enabled: boolean;
  ...
  prompt?: string;
};
```

CreatePanel's IIFE at `:1650-1673` always assigns a non-empty `prompt` when `usePollinations` is on:
```ts
prompt: effCoverPrompt || buildCoverPrompt({ ... })
```
`effCoverPrompt` is `d?.coverPrompt || ''` (`:1602`); when empty, `buildCoverPrompt` returns a keyword-derived string that is always non-empty. So at runtime the `prompt` field is always a non-empty string when `enabled: true`.

**Backend guard at `routes/generate.ts:594`**:
```ts
if (pol?.enabled && pol.model && pol.prompt) {
  ...
  startCoverGen(req.params.jobId, polCfg);
}
```
Empty / undefined `prompt` simply skips cover gen — no crash, no malformed request to Pollinations. Safe even if a future caller sets `enabled: true, prompt: undefined`.

**Verdict**: neutral. Type optionality matches the `enabled: false` case where the IIFE returns `{ enabled: false }` with no prompt.

### R4 NR-3 [NEUTRAL] App.tsx whitelist drops `(params as any).openrouterModel` cast — **[CLEANER, no behavior change]**

Pre-batch-5 (`e53909eed`):
```ts
openrouterModel: (params as any).openrouterModel,
```
Post-batch-5 (`0fe60457f`):
```ts
openrouterModel: params.openrouterModel,
```

Possible because `app/types.ts:151` was widened in this same commit (`string` → `string | null`) and the App's `import { ... GenerationParams } from './types'` (`App.tsx:14`) resolves to the wider type. Outer `as any` on the payload object also dropped. Pure type-level cleanup, zero runtime impact.

**Verdict**: neutral cleanup. Worth noting positively. Reduces type-debt surface.

### R4 NR-4 [NEUTRAL] `routes/generate.ts` `prompt` field recovery — **[orthogonal to OR pre-flight]**

Batch 5 adds `prompt` to `GenerateBody`, destructure, and `params` blob. CreatePanel always passes `prompt: effLyrics` at `:1630` for customMode (which is forced on for OR per-click via `effectiveCustomMode = customMode || (useOpenRouter && !activeLmModel)` at `:1588`). Pre-batch-5 this field was destructured but never persisted to the `params` JSONB blob — only read into local code paths. R3 agent07 L6 flagged it; batch 5 fixes.

**OR interaction**: zero. The OR pre-flight produces `lyrics`/`caption`/`title`/`bpm`/`keyScale`/`timeSignature`/`durationSec`/`coverPrompt` and CreatePanel maps `lyrics → prompt` for backward compat with the audio backend. Whether `prompt` is now also stored on the job's params blob doesn't change OR pre-flight behavior.

**Verdict**: orthogonal. Neutral.

### R4 NR-5 [NEUTRAL] cover-jobs tombstone Set — **[orthogonal to OR pre-flight]**

R3-1/M7 leak fix. Affects only the Pollinations Map lifecycle. OR pre-flight produces `coverPrompt`; whether downstream cover-gen leaks Buffer on cancel is unrelated to OR.

For users with **both** OR and Pollinations enabled, the tombstone fix prevents a ~300KB-per-cancel Buffer leak. This is a positive interaction — silent improvement for OR+Pollinations users.

**Verdict**: orthogonal to OR pre-flight; positive for combined OR+Pollinations users.

### R4 NR-6 [NEUTRAL] `_tempId` typed as `string` (not `string | undefined`-required) — **[no OR impact]**

Diff adds `_tempId?: string;` to `GenerationParams`. CreatePanel `:1628` always passes it for customMode. App.tsx `:1009` reads `params._tempId` — bare access now type-checks because the field exists. No behavior change. No OR interaction.

**Verdict**: neutral cleanup.

### R4 NR-7 [NEUTRAL] No new OR-specific files touched — **[CONFIRMED]**

`git log --oneline -- app/services/llm/ app/hooks/useOpenRouterGeneration.ts app/components/CreatePanel.tsx` last commit is `10a87ab0e` (batch 2) for openrouter.ts/storage.ts and `2e2fdb768`/older for CreatePanel — both predate batch 5. Zero OR lines moved in `0fe60457f`.

**Verdict**: confirmed. Batch 5 is OR-source-clean.

---

## Mental simulations on HEAD `0fe60457f`

### Sim 1: First click of session in Простой+OR+noLM (regression check)

Identical to R3 Sim 2. No code change in CreatePanel. Same outcome: row 1 `openrouter_model = NULL`, rows 2..N correct. **R1 #6 / R2 NR-2 still open.**

### Sim 2: Stale custom systemPromptGenerate, AI Generate Lyrics button

Identical to R3 Sim 1. No code change in openrouter.ts. R1 #1 / R1 #3 still closed; the silent `coverPrompt = ''` default still papers over missing-field cases (R2 NR-1 still open by design).

### Sim 3: Type-level — App.tsx compiles cleanly with widened `string | null`

`handleGenerate(params: GenerationParams)` → `params.openrouterModel: string | null | undefined` → passed bare to `generateApi.startGeneration` whose `GenerationParams.openrouterModel?: string | null` (`api.ts:397`). Assignable. ✓

### Sim 4: User has Pollinations on + OR pre-flight, bulk=10, cancels track 5

Setup: Простой+OR+Pollinations on, bulkCount=10. User clicks Создать. Pre-flight succeeds for track 1, audio gen begins. Pre-flight for tracks 2..5 chained sequentially in `llmPreflightQueueRef`. User cancels track 5 mid-audio.

- Batch 4's `cancelGeneration` properly removes track 5 from `activeJobsRef` and drains queue waiters → audio side recovered.
- Batch 5's tombstone Set ensures cover-jobs Map for track 5 doesn't leak the buffered Pollinations PNG.
- LLM pre-flight chain for tracks 6..10 continues uncancellable (R1 #5 deferred).
- Track 1 had `openrouterModel = null` (closure-captured initial state); tracks 2..10 had the correct model id from state-committed updates.

**Outcome**: track 1 still wrong, tracks 2..10 correct, no Buffer leak on track 5 cancel. The OR-related symptom is unchanged — the leak fix is independent.

---

## Round-4 Summary Table

| Finding | Origin | R4 Status on `0fe60457f` | Notes |
|---|---|---|---|
| R1 #1 BLOCKER few-shots | R1 | FIXED | (`10a87ab0e` from R2; carries forward) |
| R1 #2 HIGH SCHEMA_UNSUPPORTED retry msg | R1 | OPEN, neutralized | unchanged |
| R1 #3 HIGH stale custom prompts | R1 | FIXED | (`ea73c3c98` from R2; carries forward) |
| R1 #4 MED empty coverPrompt | R1 | OPEN, acceptable | unchanged |
| R1 #5 HIGH AbortController dead | R1 | **OPEN, deferred** | unchanged |
| R1 #6 / R2 NR-2 MED first-click NULL | R1/R2 | **OPEN (5th batch, still not fixed)** | recommended ref-based fix above |
| R1 #7 MED form-fill regression | R1 | OPEN, acceptable | unchanged |
| R1 #8 MED partialJson whitelist | R1 | FIXED | (`ea73c3c98` from R2) |
| R2 NR-1 MED silent coverPrompt='' default | R2 | **OPEN** | not centralized |
| R2 NR-3 LOW empty-model-id guard | R2 | OPEN, acceptable | unchanged |
| R2 NR-4 LOW chain firewall hides errors | R2 | **OPEN** | observability gap persists |
| R2 NR-5 LOW batch-3 no-op | R2 | CONFIRMED | n/a |
| R3 NR-1..NR-5 (batch-4 hunt) | R3 | NEUTRAL/POSITIVE | unchanged |
| R4 NR-1 LOW openrouterModel widening | R4 | NEUTRAL | type cleanup; api.ts:115 micro-drift on Song |
| R4 NR-2 LOW pollinations.prompt? optional | R4 | NEUTRAL | backend guards on truthiness |
| R4 NR-3 NEUTRAL App.tsx whitelist as-any drop | R4 | POSITIVE | type-debt reduction |
| R4 NR-4 NEUTRAL prompt field recovery | R4 | NEUTRAL | orthogonal to OR pre-flight |
| R4 NR-5 NEUTRAL cover-jobs tombstone | R4 | POSITIVE for OR+Pol users | leak fix |
| R4 NR-6 NEUTRAL `_tempId` typed | R4 | NEUTRAL | cleanup |
| R4 NR-7 NEUTRAL no OR-source touched | R4 | CONFIRMED | n/a |

---

## Counts

- **R4 confirmed-open from prior rounds**: 1 HIGH (R1 #5 deferred), 1 MED (R1 #6 / R2 NR-2 first-click NULL), 1 MED (R2 NR-1 silent default), 4 LOW (R1 #2, R1 #4, R1 #7, R2 NR-4).
- **R4 closed by prior batches, still green**: 1 BLOCKER (R1 #1), 1 HIGH (R1 #3), 1 MED (R1 #8).
- **R4 new findings from batch-5 hunt**: **0 BLOCKER · 0 HIGH · 0 MED · 7 NEUTRAL/POSITIVE LOW** (NR-1 micro-drift, NR-2 typed-prompt safe, NR-3 cleanup, NR-4 prompt recovery, NR-5 tombstone leak fix, NR-6 `_tempId` typed, NR-7 zero OR-source touched).
- **Net regression introduced by batch 5 in OpenRouter integration**: **none**.
- **Silent improvements from batch 5 for OR users**: type-debt reduction (NR-3); ~300KB-per-cancel Buffer leak fixed for combined OR+Pollinations users (NR-5).

Recommended follow-ups (priority unchanged + 1 micro):
1. **(STILL THE SAME, 5 BATCHES IN)** Fix R1 #6 / R2 NR-2 first-click NULL via the ref-based pattern shown in §R1 #6 above — or inline `llmStorage.getOpenRouter().model` directly into the payload at `CreatePanel.tsx:1647`.
2. Surface `OpenRouterError.code` in the per-click `.catch` blocks (closes R2 NR-4 observability gap).
3. Hoist the per-click `AbortController` to a ref (closes R1 #5) — or document as a known limitation.
4. **Micro (NR-1 follow-up)**: widen `app/services/api.ts:115` `Song.openrouterModel?: string | null` to match the rest of the codebase, eliminating the cosmetic drift between request and response interfaces.

Carry-forward verdict: **batch 5 is OpenRouter-clean.** No new bugs introduced; one accidental positive (type-debt reduction via widening); R3's three open items still want one more batch — and item 1 (first-click NULL) has now survived five batches without a fix.
