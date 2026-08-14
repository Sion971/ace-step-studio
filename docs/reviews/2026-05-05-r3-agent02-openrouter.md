# OpenRouter Integration — Round 3 Review (agent02)

Scope: verify whether batch 4 (`e53909eed`) closes any R2 findings on the OpenRouter integration, and hunt for new regressions introduced by the batch-4 changes (App.tsx cancel/reset additions, generate.ts `consumeCoverState` on failed, generate.ts GenerateBody/destructure expansion, api.ts GenerationParams expansion).

HEAD at review time: `e53909eed`.
Prior reviews: `docs/reviews/2026-05-05-agent02-openrouter.md` (R1, 12 findings) and `docs/reviews/2026-05-05-r2-agent02-openrouter.md` (R2, 5 new + close-out).

Severity legend: **[BLOCKER]** ship-stopper · **[HIGH]** likely user-visible bug · **[MED]** subtle / partial breakage · **[LOW]** nit · **[FIXED]** resolved on HEAD · **[CONFIRMED OPEN]** still present on HEAD · **[DEFERRED]** acknowledged-not-landing.

Skipped per task brief: security review.

---

## Batch-4 surface area on OpenRouter integration

`git show e53909eed --stat` files of interest:
- `app/App.tsx` (+16,−3) — `cancelGeneration` + `resetSingleJob` add `drainQueueWaiters` and `activeJobsRef.delete`.
- `app/server/src/routes/generate.ts` (+53) — failed-status `consumeCoverState`, GenerateBody / destructure / persist expansion (DCW, FlowEdit, retake, lora).
- `app/services/api.ts` (+24) — `GenerationParams` expansion (DCW cluster, FlowEdit cluster, retake, `_tempId`).

Files NOT touched by batch 4:
- `app/components/CreatePanel.tsx` ← per-click pre-flight path. **Unchanged from R2.**
- `app/services/llm/openrouter.ts`, `partialJson.ts`, `prompts.ts`, `useOpenRouterGeneration.ts`, `prompts/system_*.en.md`, `storage.ts`. **Unchanged from R2.**

Confirmed via `git diff 2419f7d73..e53909eed -- <those files>` returning empty output.

**Net implication**: every R2 OpenRouter finding's status carries forward unchanged unless one of the touched files transitively interacts with OR. Below I verify each.

---

## R2 finding status on HEAD `e53909eed`

### R2 NR-1 [MED] Silent `coverPrompt = ''` post-parse default — **[CONFIRMED OPEN]**

`app/services/llm/openrouter.ts:290-298` (HEAD):
```ts
let draft: SongDraft;
try {
  draft = JSON.parse(stripCodeFence(raw));
  // Tolerate models / stale custom system prompts that don't emit `coverPrompt`
  // (the field was added later). Empty string is a valid value per types.ts;
  // the keyword fallback in buildCoverPrompt fills in for cover gen.
  if (typeof (draft as any).coverPrompt !== 'string') {
    (draft as any).coverPrompt = '';
  }
} catch { ... }
```

Verified unchanged. Batch 4 did not centralize this into a `coerceLegacyDraft` helper, did not flip to a stricter "missing-required" error, did not switch to retry-with-explanatory-nudge. Behavior is still: any 8-field response is silently upgraded to a 9-field `SongDraft` with `coverPrompt: ''`, so `REQUIRED_FIELDS` validation at `:312-321` cannot fire for `coverPrompt` — only for the other 8.

**Verdict**: still open. Defensive default still erodes the strictness of `REQUIRED_FIELDS`. Risk profile unchanged — this is intentional resilience, but a future schema addition will not get the same treatment automatically.

### R2 NR-2 / R2 #6 [MED] `lastOpenRouterModelId` off-by-one (first-click NULL) — **[CONFIRMED OPEN]**

`app/components/CreatePanel.tsx:1571-1583` (HEAD), unchanged from R2:
```ts
try {
  perClickDraft = await llmPreflightQueueRef.current;
  if (!perClickDraft) { releaseClaimedSlots(); return; }
  // Stamp the model id used for this song — `orHook` only updates this
  // for the explicit AI buttons, not the Простой-mode pre-flight, so
  // without this `params.openrouterModel` would always be null for
  // Простой+OR generations and the song-row badge tooltip would be empty.
  const orModelId = llmStorage.getOpenRouter().model;
  if (orModelId) setLastOpenRouterModelId(orModelId);
} catch (e) { ... }
```

Then at `:1647`:
```ts
openrouterModel: lastOpenRouterModelId,
```

Mental simulation of a fresh-session first click in Простой+OR+noLM:
1. User opens app for the first time. Initial state: `lastOpenRouterModelId = null` (`:255` `useState<string | null>(null)`).
2. User types description, clicks Создать.
3. `handleGenerate` enters per-click branch at `:1535`.
4. `llmPreflightQueueRef.current.catch(() => null).then(...)` runs the pre-flight.
5. Pre-flight resolves with a valid `SongDraft`.
6. `:1577` reads `orModelId = llmStorage.getOpenRouter().model` → e.g. `"anthropic/claude-3.5-sonnet"`.
7. `:1578`: `setLastOpenRouterModelId("anthropic/claude-3.5-sonnet")` is **enqueued** (React state setters are async — batched, never applied mid-callback).
8. Code proceeds synchronously to `:1647`. The `lastOpenRouterModelId` identifier here was **closure-captured at the start of `handleGenerate`'s render-cycle invocation**, before the `setState` was queued. Closure value: `null`.
9. Payload built with `openrouterModel: null`.
10. `onGenerate(payload)` fires; backend `generate.ts:710` inserts `params.openrouterModel || null` → song row stores **`openrouter_model = NULL`**.
11. After `handleGenerate` returns, React commits the state update; `lastOpenRouterModelId` becomes `"anthropic/claude-3.5-sonnet"` for click 2.

**This is the off-by-one regression confirmed.** Row 1 of every fresh session has `openrouter_model = NULL` even though OpenRouter was actively used.

The R2 review (line 152) suggested the cleanest fix:
```ts
openrouterModel: orModelId ?? lastOpenRouterModelId,
```
or capture into a local `const` immediately after the await and use that local in the payload. Neither was applied in batch 4. Backend `generate.ts:710` and `:747` are also unchanged.

**Verdict**: still open. First-click row NULL on every session.

### R2 NR-3 [LOW] `if (orModelId) setLastOpenRouterModelId(orModelId)` empty-model guard — **[CONFIRMED OPEN, ACCEPTABLE]**

Unchanged. Still a tiny defensive read; not a bug.

### R2 NR-4 [LOW] Chain firewall + `console.error`-only error path hides pre-flight failures from UI — **[CONFIRMED OPEN]**

`CreatePanel.tsx:1565-1568`:
```ts
} catch (e) {
  console.error('[Simple+OR] pre-flight failed:', e);
  return null;
}
```

And `:1582-1586`:
```ts
} catch (e) {
  console.error('[Simple+OR] queued pre-flight failed:', e);
  releaseClaimedSlots();
  return;
}
```

Both still log-only. No toast, no `GenerationStatusPanel` push, no error code surfacing of `OpenRouterError.code`. Combined with the chain firewall (`.catch(() => null).then(...)` at `:1543`), a misconfigured key / down provider produces:
- Click Создать → temp song card flashes → card silently disappears → user sees nothing.

Reproducer (unchanged from R2): toggle OR on, set an invalid API key in settings, click Создать.

**Verdict**: still open. Resilience-vs-observability trade-off unchanged. Recommendation from R2 stands: surface `OpenRouterError.code` through the existing toast or `GenerationStatusPanel` channel.

### R2 NR-5 [LOW] Batch 3 (`2419f7d73`) was a no-op for OR — **[STILL CONFIRMED]**

Batch 3 only touched `app/server/src/services/id3-tagger.ts`. Carries forward unchanged.

---

## R1 finding status on HEAD `e53909eed`

### R1 #5 [HIGH] `AbortController` per-click pre-flight unwired — **[CONFIRMED OPEN, DEFERRED]**

`CreatePanel.tsx:1552-1564` (HEAD):
```ts
const client = new OpenRouterProvider();
const ac = new AbortController();
return await client.generate(
  {
    topic: songDescription,
    primary: 'lyrics',
    language: vocalLanguage || 'en',
    instrumental,
    durationSec: duration > 0 ? duration : undefined,
    thinking,
  },
  { signal: ac.signal, onEvent: () => {} },
);
```

`ac` is still local to the closure. Nothing calls `ac.abort()`. No `llmPreflightAbortRef`. Batch 4's App.tsx `cancelGeneration` improvements (drainQueueWaiters + activeJobsRef.delete) only affect the **post-submission audio-job lifecycle** — they don't propagate into the pre-flight LLM phase.

**Important interaction with batch 4**:
- `cancelGeneration` now properly removes the cancelled job from `activeJobsRef` and drains queue waiters (R2 agent05 NEW-HIGH-R4 fix).
- This means: if user clicks Создать (Простой+OR+bulk=10), the pre-flight queue starts firing one LLM call at a time, each followed by audio gen. If the user cancels track 1 mid-audio, batch 4 correctly frees the slot. **But** the LLM pre-flights for tracks 2..10 still fire one-by-one with no abort — the chain is uncancellable.
- Worse: the chain firewall's `.catch(() => null).then(...)` will keep the chain alive forever as long as the user keeps cancelling individual jobs. Each subsequent click adds another `await` link to the chain. There's no UI affordance to nuke the LLM queue.

**Verdict**: still open. R2 marked as deferred-acceptable for a local Studio app; that judgment carries.

### R1 #2 [HIGH] `SCHEMA_UNSUPPORTED` retry message lacks human-readable nudge — **[CONFIRMED OPEN, EFFECTIVELY NEUTRALIZED]**

`openrouter.ts:226-231` unchanged. Still neutralized in practice by the few-shot fix (R1 #1) + auto-default (R2 NR-1). No code change in batch 4.

### R1 #4 [MED] LLM may emit empty `coverPrompt` — **[CONFIRMED OPEN, ACCEPTABLE]**

System prompt unchanged. Downstream fallback to `buildCoverPrompt` keyword default still works.

### R1 #7 [MED] Per-click flow doesn't fill form fields (UX regression) — **[CONFIRMED OPEN, ACCEPTABLE]**

`onEvent: () => {}` at `:1564` unchanged. `setBpm` / `setKeyScale` / `setStyle` still not called from the per-click `.then`. Compensating effective-value chain at `:1593-1602` still works for submission.

---

## New R3 regression hunt — does batch 4 affect OpenRouter?

### R3 NR-1 [LOW] `consumeCoverState` on failed audio status — orthogonal to OR

`generate.ts:619-622` (HEAD):
```ts
} else if (aceStatus.status === 'failed' && aceStatus.error) {
  updateQuery += `, error = ?`;
  updateParams.push(aceStatus.error);
  consumeCoverState(req.params.jobId);
}
```

`consumeCoverState` is the Pollinations cover-jobs Map (`app/server/src/services/cover-jobs.ts`). It is **only populated by `startCoverGen`**, which is only invoked in the queued→running transition for Pollinations-enabled jobs. A user with OR but no Pollinations: `cover-jobs.Map` never had an entry; `consumeCoverState` is a no-op delete. Verified by tracing `Grep`: only `routes/generate.ts` and `services/cover-jobs.ts` touch the Map.

**Path interaction**: a user has BOTH OR pre-flight on AND Pollinations on. Audio gen fails (CUDA OOM). Batch 4 now correctly cleans up the cover-jobs entry. The OR pre-flight already ran successfully and passed the `SongDraft` to the audio submission — that work is independent of cover-gen and is not affected by this cleanup.

**Verdict**: no OR impact. Neutral.

### R3 NR-2 [LOW] GenerateBody / destructure / persist additions — orthogonal to OR pre-flight

`generate.ts:222-235` adds DCW (`dcwEnabled`, `dcwMode`, `dcwScaler`, `dcwHighScaler`, `dcwWavelet`), retake (`retakeSeed`, `retakeVariance`), FlowEdit (`flowEditMorph`, `flowEditSourceCaption`, `flowEditSourceLyrics`, `flowEditNMin`, `flowEditNMax`, `flowEditNAvg`), and `loraLoaded` to `GenerateBody`. Destructure at `:391-405`. Persist into `params` blob at `:495-509`.

OR pre-flight is a **frontend-only** phase that runs before `onGenerate(...)` fires. The submission payload built at `CreatePanel.tsx:1614-1664` already lists `openrouterModel: lastOpenRouterModelId` — the new fields are pure additions that don't touch the OR slot. The backend persists `params.openrouterModel || null` at `:710` and `:747` unchanged.

**Verdict**: no OR impact. Neutral.

### R3 NR-3 [LOW] `api.ts` GenerationParams expansion (`_tempId`, DCW, FlowEdit, retake) — orthogonal to OR

`api.ts:372-395` adds the same cluster of fields plus `_tempId`. The `openrouterModel?: string | null` slot at `:398` is unchanged.

**Verdict**: no OR impact. Neutral. (Bonus: the new types make `lastOpenRouterModelId` typing relationship cleaner since `_tempId` is now typed too — no `as any` casts in CreatePanel.)

### R3 NR-4 [LOW] `App.tsx::cancelGeneration` drainQueueWaiters — does NOT propagate to OR pre-flight

Batch 4 `cancelGeneration` fix removes job from `activeJobsRef` and calls `drainQueueWaiters`. This addresses R2 agent05 NEW-HIGH-R4 (single-cancel left job as permanent occupant blocking next click's pre-flight `waitForJobsToDrain`).

**Interaction with OR**: positive but indirect. Before batch 4, a user could click Создать in Простой+OR, cancel the resulting audio job, then click Создать again — the second click's `waitForJobsToDrain` (called inside the OR pre-flight chain at `CreatePanel.tsx:1547`) would hang forever because the cancelled job stayed in `activeJobsRef`. Now it drains correctly and the OR pre-flight can proceed.

**Verdict**: no regression; in fact this is a **silent unblocker for the OR per-click chain in cancel scenarios**. Worth noting positively but not a finding.

### R3 NR-5 [LOW] No new R3 OR-specific regressions in batch 4

Re-scanned `git show e53909eed -- app/components/CreatePanel.tsx app/services/llm/openrouter.ts app/services/llm/partialJson.ts app/services/llm/prompts/ app/hooks/useOpenRouterGeneration.ts app/services/llm/storage.ts app/services/llm/prompts.ts` — all empty. Zero OR-related lines moved.

The only material new behavior with downstream effect on OR users is R3 NR-4 (positive: cancel→re-click chain unblocked).

---

## Mental simulations on HEAD

### Sim 1: Stale custom systemPromptGenerate, AI Generate Lyrics button

Setup: `cfg.systemPromptGenerate` is hand-edited from before `coverPrompt` existed. User clicks "AI Generate Lyrics" (orHook path).

1. `useOpenRouterGeneration.generate` → `OpenRouterProvider.generate()`.
2. Provider injects user's stale system prompt verbatim via `prompts.ts:resolveSystem`.
3. Model returns 8-field JSON (no `coverPrompt`).
4. `JSON.parse(stripCodeFence(raw))` succeeds at `openrouter.ts:292`.
5. `:296-298` sees `typeof draft.coverPrompt !== 'string'` → assigns `''`.
6. `REQUIRED_FIELDS` loop at `:312-321` finds all 9 keys present (the 8 from the model + the just-injected empty string `coverPrompt`).
7. Returns valid `SongDraft`. `onFinal` fires. Form fills with bpm/key/title/lyrics.
8. User clicks Создать → submission uses form values; `coverPrompt` is `''` → `buildCoverPrompt` keyword fallback covers it.

**Outcome**: success. R1 #3 (BLOCKER for stale-prompt users) remains closed.

### Sim 2: First click of session in Простой+OR+noLM

Setup: fresh session. User opens app, no AI button has been clicked yet. Types description, clicks Создать.

1. `handleGenerate` enters per-click branch at `CreatePanel.tsx:1535`.
2. Closure captures `lastOpenRouterModelId = null` (initial state).
3. Pre-flight chain runs through `llmPreflightQueueRef.current.catch(() => null).then(...)`.
4. `client.generate(...)` succeeds, returns SongDraft.
5. `:1577`: `orModelId = "anthropic/claude-3.5-sonnet"`.
6. `:1578`: `setLastOpenRouterModelId(...)` enqueued — **state not yet committed**.
7. Code falls through to `:1614-1664` payload construction.
8. `:1647`: `openrouterModel: lastOpenRouterModelId` reads closure-captured `null`.
9. `onGenerate({ ..., openrouterModel: null })`.
10. Backend `routes/generate.ts:710` inserts `params.openrouterModel || null` → song row `openrouter_model = NULL`.
11. React commits state. Click 2 inherits `lastOpenRouterModelId = "anthropic/claude-3.5-sonnet"` and submits correctly.

**Outcome**: row 1 of session has `openrouter_model = NULL`; rows 2..N correct.

R2 NR-2 / R1 #6 confirmed open on HEAD. **Not fixed by batch 4.**

### Sim 3: User cancels track 1 mid-audio, clicks Создать again

Setup: Простой+OR+noLM, bulk=1. User clicks Создать. Pre-flight succeeds, audio job starts. User clicks the Cancel button on the song card (calls `cancelGeneration`).

**Pre-batch-4**: `cancelGeneration` removed the polling but left the job in `activeJobsRef` → next click's `waitForJobsToDrain()` (inside the OR chain at `:1547`) waited forever for a phantom job. User had to reload.

**Post-batch-4**: `cancelGeneration` calls `activeJobsRef.delete(jobId)` and `drainQueueWaiters()`. Next click's `waitForJobsToDrain()` resolves immediately. Pre-flight fires. Chain works.

**Outcome**: cancel→re-click in Простой+OR is now functional. R3 NR-4 silent unblocker confirmed.

### Sim 4: User has Pollinations on + OR pre-flight, audio fails (CUDA OOM)

Setup: Простой+OR+Pollinations on. Click Создать. Pre-flight succeeds. Audio job submitted. Audio gen fails with CUDA OOM. Cover-gen had already started in the queued→running transition.

**Pre-batch-4**: failed-status branch updated `error` column but never called `consumeCoverState` → cover-jobs Map kept the entry forever (per-job leak).

**Post-batch-4**: `:622` `consumeCoverState(req.params.jobId)` cleans the Map. The OR `params.openrouterModel || null` was already persisted at song-row creation, but **wait** — songs are only inserted on `aceStatus.status === 'succeeded'` (`:629`). On failed status, no song row is created at all, so the OR model id is never persisted for failed jobs. The `params` blob (with `openrouterModel`) was stored on the `generation_jobs` row at submission time (`:530-560` area, `INSERT INTO generation_jobs`), so the OR model id IS preserved on the job row even when audio fails — just not on a song row (because no song exists).

**Outcome**: no OR-specific behavior change. Cover-jobs leak fix is independent of OR. R3 NR-1 neutral confirmed.

---

## Round-3 Summary Table

| Finding | Origin | R3 Status on `e53909eed` | Notes |
|---|---|---|---|
| R1 #1 BLOCKER few-shots | R1 | FIXED | (`10a87ab0e` from R2; carries forward) |
| R1 #2 HIGH SCHEMA_UNSUPPORTED retry msg | R1 | OPEN, neutralized | unchanged |
| R1 #3 HIGH stale custom prompts | R1 | FIXED | (`ea73c3c98` from R2; carries forward) |
| R1 #4 MED empty coverPrompt | R1 | OPEN, acceptable | unchanged |
| R1 #5 HIGH AbortController dead | R1 | **OPEN, deferred** | unchanged; batch 4 cancel fixes don't propagate to LLM |
| R1 #6 MED lastOpenRouterModelId | R1 | **OPEN (off-by-one row 1 NULL)** | not fixed by batch 4 |
| R1 #7 MED form-fill regression | R1 | OPEN, acceptable | unchanged |
| R1 #8 MED partialJson whitelist | R1 | FIXED | (`ea73c3c98` from R2) |
| R2 NR-1 MED silent coverPrompt='' default | R2 | **OPEN** | not centralized; behavior identical |
| R2 NR-2 LOW first-click race (= R1 #6) | R2 | **OPEN** | same finding, see R1 #6 |
| R2 NR-3 LOW empty-model-id guard | R2 | OPEN, acceptable | unchanged |
| R2 NR-4 LOW chain firewall hides errors | R2 | **OPEN** | unchanged; observability gap persists |
| R2 NR-5 LOW batch-3 no-op | R2 | CONFIRMED | unchanged |
| R3 NR-1 LOW consumeCoverState failed branch | R3 | NEUTRAL | orthogonal to OR |
| R3 NR-2 LOW GenerateBody field expansion | R3 | NEUTRAL | orthogonal to OR pre-flight |
| R3 NR-3 LOW api.ts GenerationParams expansion | R3 | NEUTRAL | orthogonal to OR |
| R3 NR-4 LOW App.tsx cancel drainQueueWaiters | R3 | POSITIVE (silent unblocker) | indirectly unblocks cancel→OR chain |
| R3 NR-5 LOW no new OR-specific regressions | R3 | CONFIRMED | zero OR lines touched in batch 4 |

---

## Counts

- **R3 confirmed-open from prior rounds**: 1 HIGH (R1 #5 deferred), 1 MED (R1 #6 / R2 NR-2 first-click NULL), 1 MED (R2 NR-1 silent default), 4 LOW (R1 #2, R1 #4, R1 #7, R2 NR-4).
- **R3 closed by prior batches, still green**: 1 BLOCKER (R1 #1), 1 HIGH (R1 #3), 1 MED (R1 #8).
- **R3 new findings from batch-4 hunt**: **0 BLOCKER · 0 HIGH · 0 MED · 5 LOW** (all neutral or positive — NR-1 through NR-5).
- **Net regression introduced by batch 4 in OpenRouter integration**: **none**.
- **Silent improvement**: R3 NR-4 — `cancelGeneration` drainQueueWaiters indirectly fixes the cancel→re-click hang for Простой+OR users.

Recommended follow-ups (priority unchanged from R2):
1. Pass `orModelId` directly through a local `const` into `CreatePanel.tsx:1647` payload (closes R1 #6 / R2 NR-2 — first-session-row NULL).
2. Surface `OpenRouterError.code` in the per-click `.catch` blocks (closes R2 NR-4 observability gap).
3. Hoist the per-click `AbortController` to a ref and wire into existing cancel UI (closes R1 #5) — or document as a known limitation.

Carry-forward verdict: **batch 4 is OpenRouter-clean.** No new bugs introduced; one accidental positive (cancel→re-click chain repair); R2's three open items still want one more batch.
