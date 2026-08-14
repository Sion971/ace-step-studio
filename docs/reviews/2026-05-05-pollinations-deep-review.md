# Deep code review — Pollinations.ai cover-generation integration

- **Branch / range:** `master`, `d8aab5bf2..HEAD` (HEAD = `6c39f42c5`)
- **Reviewer:** senior code review pass, 2026-05-05
- **Scope:** ~2,050 LOC across 27 files (frontend `CreatePanel`/`App.tsx`/`PollinationsPanel`/services + backend `generate.ts`/`cover-jobs.ts`/`pollinations.ts`/`id3-tagger.ts` + i18n)

---

## 1. Executive summary

**Overall grade: B−.** The integration ships with a coherent design (cover gen runs in parallel with audio gen and never blocks the audio pipeline; idempotent state machine; graceful picsum fallback). Tests for the state machine are solid. Most code reads cleanly.

But there is one **unambiguous BLOCKER** (API key is persisted unencrypted in the DB forever inside `generation_jobs.params`) and a small handful of MUST-fix correctness bugs in the pre-flight queue / pending-click counter math that are easy to hit with normal use (bulk + cancel). On top of that, the code path that this whole feature exists to serve — Pollinations cover-gen — has a **silently broken contract**: it never starts unless the user has OpenRouter on AND the LLM happens to return a non-empty `coverPrompt`, because the keyword fallback in `buildCoverPrompt` is computed on the client where `effCoverPrompt` is only filled by OR pre-flight.

Wait — re-read: `prompt: effCoverPrompt || buildCoverPrompt({...})`. The fallback IS used. So the path *does* work for non-OR users. Withdraw that one. Adjusted grade: **B**.

### Top 3 must-fix issues

1. **BLOCKER — API key leak.** `generate.ts` POST `/` (line ~468) JSON-stringifies the entire `params` object — including `pollinations.apiKey` — into `generation_jobs.params`. That column is read back by `/status/:jobId` and `/history`. It survives forever, in cleartext, in the SQLite file, in any backups, in any future support dump. A `pk_`/`sk_` token from `auth.pollinations.ai` can be used to drain the user's request quota or (depending on tier) be billed against their account.
2. **MUST — Pending-click counter goes wrong on partial bulk failure.** `CreatePanel.handleGenerate` claims `slotsClaimed = bulkCount` up front, but the loop calling `onGenerate(...)` per variant does not have a try/catch around each iteration. If the 3rd of 10 `onGenerate` synchronously throws (or `App.tsx::handleGenerate` rejects asynchronously), variants 0–2 have each decremented their slot via `decrementPendingClicks(1)` after `beginPollingJob`, but variants 3–9 are left orphaned: `releaseClaimedSlots()` will free `claimedSlotsRemaining` which is **still 10** because nobody decrements it as slots transfer to the active counter. Net: counter goes to `−7` (clamped to 0 by `Math.max`, so the badge UNDER-reports).
3. **MUST — `consumeCoverState` then second poll re-fires gen.** After audio finishes and the success branch consumes the cover state, the very next `/status/:jobId` poll the client makes will fall through the `if (['pending','queued','running'].includes(job.status) ...)` gate (status is now `succeeded`) so it will NOT re-fire — this one is fine, sorry. **But** if the success branch runs and `wasUpdated === false` (optimistic-lock loser, e.g. two parallel polls), `consumeCoverState` is never called for the loser — and the winner already deleted the entry — so the loser's `polEntry` reference (`getCoverState(req.params.jobId)`) is `undefined` and its `attachCover` block is skipped silently. That's actually correct for THIS poll, but the entry is also already gone. The real issue: for the rare path where the **first** polling sighting is `succeeded` (audio finished between two polls), `startCoverGen` and the song-INSERT both run in the SAME request — the success-branch attach code reads `getCoverState(jobId)` and finds the freshly-created `pending` entry, attaches cover async — fine. **But** while that attach is in flight, a CONCURRENT poll arriving 2s later hits the same gate (`!getCoverState(jobId)` is false — entry is pending), so it does not re-fire, then falls into the success branch (status === 'succeeded'), runs the optimistic UPDATE which fails (already done), wasUpdated=false, never enters the song-INSERT block, never reaches the attach block. Good. So this is actually safe — but it's fragile by accident, not by design (see §4).

### Biggest risks

- **Secret persistence** (item 1) is the hard blocker. Everything else is recoverable.
- **Pending-click counter correctness** (item 2) gets visible in the very common bulk=10 use case.
- **Dead import** of `awaitCoverWithTimeout` in `generate.ts` (line 29) — harmless but suggests the design originally intended a synchronous wait that was removed; the reviewer should make sure the deletion was complete.
- **`OpenRouterProvider` instantiated per click** — duplicates a lot of behaviour from `useOpenRouterGeneration` (no streaming UI, no error toast, no aggregate cost panel). Acceptable as a pragmatic shortcut but adds a second code path that will drift.

---

## 2. Per-file findings

### `app/server/src/routes/generate.ts`

- **BLOCKER** L466–469 — `pollinations.apiKey` written to DB unencrypted as part of `params` JSON. `pk_`/`sk_` tokens have real cost/quota implications.
  - Fix (suggested diff):
    ```diff
    -    await pool.query(
    -      `INSERT INTO generation_jobs (id, user_id, status, params, created_at, updated_at)
    -       VALUES (?, ?, 'queued', ?, datetime('now'), datetime('now'))`,
    -      [localJobId, req.user!.id, JSON.stringify(params)]
    -    );
    +    // Strip secrets before persisting params to DB.
    +    const persistableParams = {
    +      ...params,
    +      pollinations: params.pollinations
    +        ? { ...params.pollinations, apiKey: params.pollinations.apiKey ? '__REDACTED__' : '' }
    +        : undefined,
    +    };
    +    await pool.query(
    +      `INSERT INTO generation_jobs (id, user_id, status, params, created_at, updated_at)
    +       VALUES (?, ?, 'queued', ?, datetime('now'), datetime('now'))`,
    +      [localJobId, req.user!.id, JSON.stringify(persistableParams)]
    +    );
    ```
    The cover-gen path on first polling sighting (L534) reads `params.pollinations.apiKey` from the DB — that read needs a different source. Two options: (a) keep the original `params` object in an in-memory Map keyed by `localJobId` until the job finishes, indexed alongside the cover-jobs map; (b) accept that anonymous tier is the default and only stash the key if the user explicitly pinned it via a separate "remember" toggle. Option (a) is the smaller diff.
- **MUST** L29 — `awaitCoverWithTimeout` is imported but never called. Dead import.
  - Fix: `-  awaitCoverWithTimeout,`
- **MUST** L530–551 — first-sighting cover-gen kickoff happens inside the same `try` that surrounds ACE-Step status checks. If `getJobStatus(...)` throws (network blip), we catch and silently fall through to "return stored status" at L762; in that case `startCoverGen` was never called for this poll. Next poll re-tries — fine. But the `startCoverGen` call sits BEFORE the optimistic UPDATE that gates song-INSERT. That ordering is correct (we want cover gen to overlap audio), but it means **a job can have a pending cover entry even though we never wrote the `running` status to DB on this poll**. If the user cancels the job before the next poll, `cancelJob` → `UPDATE status='failed'` runs; the cover entry stays in the Map until either (a) the next status poll finds the failed status and skips the success branch entirely (so `consumeCoverState` is never called → memory leak) or (b) the cover gen completes and writes to a deleted song row (the UPDATE WHERE id=? is a no-op, the bytes go to disk and are orphaned).
  - Fix sketch:
    ```diff
     router.post('/cancel/:jobId', authMiddleware, async (req, res) => {
       try {
         const { jobId } = req.params;
         const cancelled = cancelJob(jobId);
    +    consumeCoverState(jobId); // drop any in-flight cover-gen entry
         await pool.query(...);
    ```
    Same in `/cancel-all` and `/reset` (these need to enumerate jobIds the user owns and `consumeCoverState` each — moderately invasive, but the alternative is a slow leak proportional to cancel rate).
- **MUST** L707–741 — `attachCover` writes to disk + DB via `storage.upload(...)` and `pool.query(... UPDATE songs ...)`, but does **not** verify the song still exists (or even belongs to the user that started the job). For SQLite UPDATE this is benign (row-not-found is a silent no-op, no orphaned bytes since the file is named `${songId}.jpg`), but the `storage.upload` of bytes for a song row that has been deleted (e.g. by a `DELETE /songs/:id` admin path) is wasted IO + a dangling object in S3-ish backends. Low priority because the songs table doesn't have a hard delete code path right now.
- **SHOULD** L713 — `attachCover` loops over `songIds` (potentially 2-3 variants from a multi-output ACE-Step run) and uploads the SAME `cover.buffer` under a per-song key. That's correct (we want each song to have its own cover_url), but it means N redundant S3 PUTs for the same bytes when N variants share a job. Acceptable, but a future optimization is to upload once and have the songs share `cover_url`.
- **SHOULD** L739 — the `else` branch (state === 'failed') calls `consumeCoverState(jobId)` but doesn't log the failure. We've already done warn-logs inside `cover-jobs.ts`/`pollinations.ts`, so this is duplicative — but a single info-log here would help debugging when a user complains "my cover never appeared".
- **NIT** L470–476 — comment is excellent; matches the design intent. Keep it.
- **NIT** L536 — `pol?.enabled && pol.model && pol.prompt` — three-way truthy-check. If LLM returns `coverPrompt: ""` AND keyword fallback returns empty (impossible — `buildCoverPrompt` always emits the prefix), `pol.prompt` would be falsy. Defensive, fine.

### `app/server/src/services/cover-jobs.ts`

- **MUST** L92–158 — `startCoverGen` reads-then-writes the Map without a CAS. The body is synchronous JS up to and including `jobs.set(jobId, pending)` (L157), so within a single Node event loop tick, two concurrent calls can't actually interleave — the V8 model serializes them. **However**: the `(async () => {...})()` IIFE captures `jobId` and runs through microtasks; if a NEW `startCoverGen(jobId, ...)` call lands while the IIFE is between `jobs.set(jobId, pending)` and the first `await`, the new call sees `existing` and returns it. Safe. So idempotency holds for single-process Node. **But** the test in `cover-jobs.test.ts` only exercises the synchronous read-write — a multi-process deployment (several Node workers behind nginx) would each have their own `jobs` Map and each would fire its own Pollinations request. That's actually the expected production shape (no shared memory). Worth a comment: "NOT idempotent across processes — relies on sticky-session routing".
- **SHOULD** L66 — `const jobs = new Map<string, CoverEntry>();` is module-level mutable state. No upper bound. If `consumeCoverState` is never called on a `failed` entry (see the cancel-path bug above), the map grows unbounded over the process lifetime. With ~64 KB Buffers held by `ready` entries, this is a real memory pressure point.
  - Fix: add a periodic sweep that drops entries older than e.g. 10 minutes:
    ```diff
    +const STALE_MS = 10 * 60_000;
    +setInterval(() => {
    +  const now = Date.now();
    +  for (const [k, v] of jobs) {
    +    const ts = v.state === 'pending' ? v.startedAt : v.finishedAt;
    +    if (now - ts > STALE_MS) jobs.delete(k);
    +  }
    +}, 60_000).unref();
    ```
- **NIT** L113–115 — `styleIdx = seedForVariety % STYLE_MODIFIERS.length`. When `seedMode === 'random'` we still call `songIdToSeed(jobId)` for the style index. That contradicts the user's "random" choice — the cover style is DETERMINISTIC by jobId regardless. Documented in the comment but the user toggle for "random" is misleading: random means "different image for the same prompt across runs", but on a retake (same songId) the style modifier is locked. Probably fine — the modifier is added on TOP of the user's prompt, not chosen instead of it — but worth a doc note in the toggle hint.
- **NIT** L101 — IIFE returns `Promise<CoverResult>` and the `Promise.race` in `awaitCoverWithTimeout` casts it through union types correctly. Good.

### `app/server/src/services/pollinations.ts`

- **SHOULD** L52–65 — query-param assembly looks correct; `Number.isFinite(input.seed)` correctly skips when `seed === undefined`.
- **SHOULD** L91–95 — `arrayBuffer.byteLength < 256` heuristic for "error placeholder" is a magic number with no upstream reference. Pollinations occasionally returns a small <1 KB SVG with a moderation error message. 256 bytes is probably fine; consider 1024 if false negatives surface.
- **NIT** L21 — comment claims "image.pollinations.ai silently routes everything to sana"; current endpoint is `gen.pollinations.ai/image`. Verify with `curl -I 'https://gen.pollinations.ai/image/prompt/test?model=flux'` before relying on this in prod — the upstream is known to flip routes.
- **NIT** L116–119 — `parseInt(hex, 16)` on the first 8 hex chars of a UUID gives ≤ 0xFFFFFFFF, masked with 0x7FFFFFFF. Stable, correct.

### `app/server/src/services/id3-tagger.ts`

- **SHOULD** L91–114 — `fetchCoverImage` declares signature `(songId, pol?: PollinationsCoverConfig)` but the only caller in `generate.ts` (L605) passes `undefined` for `pol`. So the `if (pol && pol.enabled && ...)` branch is dead from this caller. Either:
  - (a) keep the dual capability (Pollinations AND picsum), and route ID3 tag through Pollinations when the cover has finished by the time MP3 is being tagged (low-prob in 12-step turbo runs but possible);
  - (b) delete the Pollinations branch from `fetchCoverImage` since `cover-jobs.ts` handles it now.
  - I'd vote (b) — simplifies the code path. Current state has DRY violation across `cover-jobs.ts` and `id3-tagger.ts`.
- **NIT** L94 return type `{ buffer; mimeType; fromPollinations? }` — the `fromPollinations` flag is never read by callers. Dead.

### `app/services/pollinations/client.ts`

- **SHOULD** L42 — `fetchModels` cache is keyed on the API key, in module-level Map, in the browser. If the user changes the key, the previous key's entry is never evicted (memory leak, but bounded by user behaviour to a few entries). Fine.
- **SHOULD** L55–57 — non-OK status maps to a `PollinationsError` with the status code in the code path, but anonymous tier returns 200 even with a bogus key per the comment in `testPollinationsKey`. So `testPollinationsKey` is a "is the host reachable" check, not a real validation. UI labels this button "Test"; user expectation is "verify my key works". Two fixes:
  - (a) call a paid endpoint that requires auth (`/image/...` with a 1px size?) — costs $0 if the model is free-tier;
  - (b) re-label the button as "Reachability check" / "Ping" in i18n.
- **NIT** L19 — comment says "CORS: gen.pollinations.ai answers OPTIONS preflight with `Access-Control-Allow-Origin: *`". Browser will still preflight when an Authorization header is present. If Pollinations changes that header to `Access-Control-Allow-Origin: https://image.pollinations.ai`, this code breaks silently from the browser. Worth a fallback to the server proxy.

### `app/services/pollinations/storage.ts`

- **SHOULD** L43–46 — `setConfig(patch)` does `{...this.getConfig(), ...patch}` then writes the merged object. So `pollinationsStorage.setConfig(cfg)` from `PollinationsPanel` (L34) writes the full cfg every render that touches a field. That's fine in isolation, but combined with `useEffect(() => setConfig(cfg), [cfg])` it generates a lot of localStorage writes (1 per keystroke in width/height inputs). Not a perf issue at human scale.
- **NIT** L11 — `model: ''` default plus an amber border in `PollinationsPanel.tsx` L184 nudges the user. Good UX.
- **NIT** L60 — `pushRecentModel` mutates list via filter+unshift+slice. Pure, fine.

### `app/services/pollinations/prompts.ts`

- **NIT** L13–39 — clean, no logic faults. The "absolutely no text" string at L36 is a known mitigation for diffusion-models-rendering-titles; verified to help in zimage/flux per the Pollinations community. Fine.

### `app/components/PollinationsPanel.tsx`

- **SHOULD** L78 — `maskedKey = '••••••' + cfg.apiKey.slice(-4)`. If the key is <4 chars, `slice(-4)` returns the whole string. Edge case, not material. But the `placeholder={cfg.apiKey ? maskedKey : '...'}` (L120) uses the masked key as the **placeholder** — which is odd because the actual `value={cfg.apiKey}` is the real key. So the placeholder never shows in practice (input is non-empty). Can be deleted to simplify.
- **SHOULD** L78–79 — `cfg.apiKey` is rendered in plaintext via `<input type={showKey?'text':'password'} value={cfg.apiKey}>`. Plain `password` input does NOT prevent screen-reader / dev-tools / autocomplete from leaking the value. For a key field, consider `autoComplete="off"` and `spellCheck={false}` — currently absent.
- **SHOULD** L150 — `keyHint` mentions `1 req/15s` as anonymous tier — verify against current Pollinations docs; this rate has changed twice in the last year.
- **NIT** L184 — `border-amber-500/60` for unset model is good. Consider also disabling the parent `Создать` button when `usePollinations && !cfg.model` — currently the user can submit, the request lands on the server, and the server's `pol.enabled && pol.model && pol.prompt` gate at `generate.ts:L536` silently drops Pollinations and falls through to picsum. Silent failure.
- **NIT** L99–104 — `clampInt` returns `min` for empty string, but the input `<input type="number" min={256} ...>` will fire onChange with empty string when user is mid-edit. So typing "1" briefly clears the field then snaps to 256 — janky. Prefer letting the empty-string state pass through and clamping only on blur.

### `app/components/UsePollinationsToggle.tsx`

- Clean. No findings.

### `app/components/CreatePanel.tsx`

- **MUST** L1487–1491 — `let perClickDraft: SongDraft | null = null;` is declared at module function scope, NOT inside `handleGenerate`. Any concurrent invocation of `handleGenerate` (theoretical — UI prevents it via `isGenerating`, but a fast double-click before `setIsGenerating(true)` propagates is possible because state is async) would clobber the variable. Move it inside the function.
- **MUST** L1502–1556 — the FIFO chain semantics are subtle and only PARTIALLY correct:
  - The chain assigns `llmPreflightQueueRef.current = previousChain.then(async () => {...})`.
  - **Inside** the `then`, it does `await waitForJobsToDrain()` — this runs after the previous click's LLM finished but ALSO waits until the previous click's full pipeline (audio + cover) drains. That is the intent.
  - However, the previous chain's resolved value is `SongDraft | null` (the last click's draft). Stitching N clicks into the chain like this means click K's `then` callback receives click K-1's `SongDraft` as its argument and ignores it. Fine, but it ALSO means if click K-1's `then` THROWS (uncaught — note the only catch is on `client.generate`, not on `waitForJobsToDrain`), the chain becomes a rejected promise and click K+1's `.then(async () => {...})` body **never runs** because `.then(onFulfilled)` short-circuits on rejection. The current code calls `await llmPreflightQueueRef.current` which would reject and propagate to the `catch` block at L1556 — releasing the slots — so click K+1's UI is correct. **But** the chain ref itself is now a rejected promise FOREVER, so click K+2 onward will also short-circuit and the bulk queue dies until page reload.
  - Fix:
    ```diff
    -      llmPreflightQueueRef.current = llmPreflightQueueRef.current.then(async () => {
    +      llmPreflightQueueRef.current = llmPreflightQueueRef.current
    +        .catch(() => null) // never let prior failure poison the chain
    +        .then(async () => {
    ```
- **MUST** L1494–1500 — `slotsClaimed = bulkCount`; `incrementPendingClicks(slotsClaimed)`. Slot accounting:
  - On success, the loop at L1601 calls `onGenerate(...)` `bulkCount` times. Each `onGenerate` triggers `App.tsx::handleGenerate` which calls `decrementPendingClicks(1)` after `beginPollingJob` (App.tsx L1144) — N decrements net, fine.
  - On failure path inside the loop (e.g. `onGenerate` throws on iteration 3 of 10): variants 0-2 have already submitted to `App.tsx::handleGenerate` (which is async fire-and-forget — `onGenerate` returns void, not a Promise here? let me re-verify). Looking at `App.tsx` L979 `handleGenerate = async (params) => ...` — yes async. `CreatePanel` calls it without `await` so each call returns a promise that resolves later. Variants 0-2 will eventually hit `decrementPendingClicks(1)` from inside their async App.tsx handlers; variants 3-9 won't — and `releaseClaimedSlots()` will free `claimedSlotsRemaining = 10` (because it never decrements when `onGenerate` is fire-and-forget). Net: 3 slots double-decremented, counter drifts negative, clamped to 0.
  - This matches the deferred concern in the review prompt. Cleaner invariant: track per-variant slot ownership via a Set of tempIds, and only `decrementPendingClicks` for slots that are still in the Set when a release event fires.
- **MUST** L1582–1588 — `(d?.bpm || bpmRef.current) > 0` — `d?.bpm` is `number | undefined`; if `bpm` is 0 from the LLM, this falls through to `bpmRef.current`. That's the intent. But `(d?.durationSec || durationRef.current) > 0` — if LLM returns `durationSec: 30` AND `durationRef.current = 0`, `(30 || 0) > 0` = true, so we use 30. Good. If LLM returns `durationSec: 0`, `(0 || 0) > 0` = false, fall through to `duration`. Good. Edge case: `durationSec: -1` (some local LM frameworks use sentinel) — `(-1 || 0) > 0` = false, fall through. Fine.
- **SHOULD** L1639–1662 — building the `pollinations` blob inline as an IIFE is hard to read; the `usePollinations` truthy check + IIFE + spread of `polCfg` all within an object literal makes this 23 lines of one expression. Extract to a helper `buildPollinationsPayload(usePollinations, effCoverPrompt, ...)`.
- **SHOULD** L1639 — passes `polCfg.apiKey` straight through. As flagged in BLOCKER #1, this is the secret-leakage source.
- **SHOULD** L233 — `const llmPreflightQueueRef = useRef<Promise<SongDraft | null>>(Promise.resolve(null));` is OK as a per-component ref but if the user navigates away and back, the ref resets to `Promise.resolve(null)` which is desired. Fine.
- **SHOULD** L256–258 — `pollinationsStorage.getUsePollinations() ?? false` — null coalescing. If localStorage is disabled (private mode in some browsers), `getUsePollinations()` returns null per `storage.ts:24`. Fine.
- **NIT** L1487 — comment says `let perClickDraft: SongDraft | null = null;` — it's a function-scope `let` re-initialized every render (since CreatePanel re-runs on every state change). Actually it IS declared at function scope inside `CreatePanel`, not inside `handleGenerate` — so it lives across handler invocations. That's the MUST above.

### `app/App.tsx`

- **MUST** L86–104 — `queueDrainResolversRef` + `waitForJobsToDrain` + `drainQueueWaiters`:
  - `waitForJobsToDrain` reads `activeJobsRef.current.size` synchronously and either resolves immediately or pushes a resolver.
  - `drainQueueWaiters` is called from `cleanupJob` (L761) AFTER `activeJobsRef.current.delete(jobId)` and `setActiveJobCount(...)`. Good ordering.
  - **Race:** caller does `if (activeJobsRef.current.size === 0) return Promise.resolve()` — a resolver pushed AFTER `cleanupJob` has done its delete and BEFORE `cleanupJob` calls `drainQueueWaiters` would be missed if there's intervening async work. There isn't here (both are synchronous, contiguous calls), so this is safe **today**. Fragile against future refactors.
- **MUST** L116–135 — `createTempSongForClick` makes a `tempId` like `temp_${Date.now()}_${rand}`. Two clicks in the same millisecond can produce the same Date.now()-prefix; randomness disambiguates. Fine. The `setSongs(prev => [tempSong, ...prev])` prepends — if another temp song exists, both render side by side. Good.
- **MUST** L1138–1145 — on success path, `decrementPendingClicks(1)` runs after `beginPollingJob`. That hands one slot off per `onGenerate` invocation. But `onGenerate` is called `bulkCount` times in the loop; each loop iteration in `CreatePanel.handleGenerate` spawns its own `App.tsx::handleGenerate(params)` async. Each one does `try{ await generateApi.startGeneration(...); decrementPendingClicks(1); } catch { decrementPendingClicks(1); }`. Pair seems balanced. **But** if `setIsGenerating(true)` is set on the FIRST handler and the LAST handler's catch sets `isGenerating(false)` — between first and last, multiple React state updates land. The line `if (activeJobsRef.current.size === 0) setIsGenerating(false);` (L1149) is right.
- **SHOULD** L416 — `coverUrl: s.cover_url || s.coverUrl || \`https://picsum.photos/seed/${s.id}/400/400\`` — the fallback to picsum even for songs with no cover_url is a UI-gap mitigation. Acceptable. Consider switching to an inline SVG gradient rendered locally to avoid a third-party image dependency that's flaky in some regions (China, Russia).
- **NIT** L993 — `(params as any)._tempId` — the `as any` hole is noted in the review brief. Cleaner: extend `GenerationParams` with an optional `_tempId?: string` metadata field, or pass it as a second argument to `onGenerate(params, options?)`. The `as any` cast lets a stale `_tempId` from a misbehaving caller create a phantom card.

### `app/services/llm/openrouter.ts`

- **SHOULD** L23 — `coverPrompt` added to `required` array — strict. If a user has OpenRouter ON and the LLM returns 8 of 9 fields, the validation loop at L304 retries with a stronger fallback message. That's adequate. But the SCHEMA `strict: true` mode should already enforce this server-side at OpenRouter; check that the model picked supports `structured_outputs`.
- **NIT** Adding `coverPrompt` after `durationSec` aligns with system_generate.en.md ordering. Good.

### `app/services/llm/types.ts`

- **NIT** clean.

### `app/services/llm/prompts/system_*.en.md`

- **NIT** clean. The "examples (good/bad)" block is helpful for steering.
- **SHOULD** Only the English prompts were updated. If `system_generate.{ru,zh,ja,ko}.md` files exist, they need parallel coverPrompt additions or the LLM returns the field in mixed languages.

### `app/i18n/{en,ru,zh,ja,ko}.ts`

- **SHOULD** stage keys are spread across `pollinations.*` and bare `stage*` keys at the top of `songs` block. No CONSTANT export — string literals like `'stageWaitingInQueue'` are typed in `App.tsx:L129`, `1002`, `CreatePanel.tsx:L1531`. One typo and a stage falls through to its raw key text.
  - Fix: export a `const STAGES = { waitingInQueue: 'stageWaitingInQueue', ...} as const;` from `app/i18n/stages.ts` and import everywhere.
- **NIT** RU/EN/ZH/JA/KO i18n key sets match — good.

### `app/server/src/services/cover-jobs.test.ts`

- **SHOULD** Coverage of state transitions is solid (idempotency, ready/failed/timeout, seed mode). **Missing:**
  - Concurrent double-`startCoverGen` from two callers in the same tick — i.e. assert that `mockGenerate` was called once even when 5 parallel `startCoverGen('same-id', cfg)` fire.
  - `consumeCoverState` of a `pending` entry — does the IIFE still complete? (Yes, but the test would document the contract.)
  - Memory-leak proof: spawn 100 jobs, never consume, confirm map size grows (illustrates the unbounded-map issue from `cover-jobs.ts` review).
- **NIT** L142 — `expect.objectContaining({...})` doesn't include `prompt` — the next assertion at L153 covers the prompt prefix separately. Fine.

### `app/server/src/index.ts`

- **NIT** L65 — CSP `connect-src` adds both `image.pollinations.ai` and `gen.pollinations.ai`. Only `gen.pollinations.ai` is currently used by client.ts, but the server fetches from `gen.pollinations.ai/image/...` — no browser request to either host from `client.ts` mentions image.pollinations.ai. Either remove the unused entry or keep it as a forward-compat hedge (acceptable).

### `app/components/Sidebar.tsx`

- **NIT** L62–66 — IMG status row is a useful at-a-glance indicator. The yellow "model not picked" state correctly tracks `polEnabled && !polReady`. Clean.

---

## 3. Architectural concerns

### A. Two parallel cover-fetching code paths

`fetchCoverImage` in `id3-tagger.ts` still has a Pollinations branch (L96–113), but the only call site in `generate.ts:L605` passes `undefined` for `pol`. Meanwhile `cover-jobs.ts` is the live path. The dead-pol-branch in `id3-tagger.ts` is misleading documentation; either delete it or wire it up as a "synchronous fast-path if cover is ready when ID3 tagging starts".

### B. Slot accounting is the wrong abstraction

`pendingClickCount + activeJobCount` is two counters that need to sum to the truth. The handoff (`decrementPendingClicks(1)` immediately after `beginPollingJob`) ASSUMES bulk loop variants land 1:1 in the active pool. They DO under happy path but the failure case (BLOCKER #2) breaks the invariant.

A single counter modeled as a Set of "in-flight tokens" would eliminate the math entirely:
```
inflight: Set<string>  // tempId
add on click → tempId in set; visible badge size = set.size
remove when (a) beginPollingJob registers it (transfer to activeJobsRef which lives in the same set), OR (b) it fails before submission, OR (c) cancel clears it
```
The current dual-counter design optimizes for "instant visual feedback" but at the cost of correctness on partial failure.

### C. Magic `_tempId` field

Placeholder-card promotion is implemented by tunnelling `_tempId` through the `GenerationParams` interface via `as any`. Cleaner: change `onGenerate` to accept a second metadata arg:
```ts
onGenerate(params: GenerationParams, meta?: { tempId?: string }): void
```
Same end behavior, no type-safety hole.

### D. Cover prompt enrichment happens in two places

The frontend builds the prompt via `buildCoverPrompt(...)` (or LLM-tailored `coverPrompt`). The backend then PREPENDS a 16-style modifier in `cover-jobs.ts:L113–115`. The user sees the frontend prompt in `pol.prompt` (sent in the payload, persisted in `params` JSON), but the actual call to Pollinations uses prompt + ", " + style. Two consequences:
- (a) Reproducibility: same songId → same style modifier → reproducible. Good.
- (b) Logging: when a user complains "cover doesn't match my prompt", reading the persisted params shows them what they think they sent, not what we actually sent. Add a log line at `cover-jobs.ts:L116` that emits the enriched prompt. The `PolImageResult` interface even has an `effectivePrompt` field (`types.ts:L65`) that is currently unused — populate it.

### E. CSRF + rate abuse

`generate.ts:POST /` is auth-gated, so CSRF is not an immediate risk. But a malicious authenticated user can submit `pollinations.apiKey = "<some-other-user's-token>"` — the server fires Pollinations on the OTHER user's quota. There's no validation that the apiKey belongs to the requester. Mitigation: server should optionally proxy through a server-owned key, or validate the token against Pollinations' /me endpoint at first-use.

---

## 4. Concurrency analysis — annotated lifecycle walkthrough

### Click → cover_url

```
T0  user clicks "Создать" with bulkCount=10
T0+ε   CreatePanel.handleGenerate runs synchronously:
       - slotsClaimed = 10
       - incrementPendingClicks(10)  ← pendingClickCount = 10, badge shows 10/10
       - createTempSongForClick × 10  ← 10 cards prepended to songs[]
       - llmPreflightQueueRef.current = previous.then(...) ← FIFO chain link
       - perClickDraft = await llmPreflightQueueRef.current
         (which awaits await waitForJobsToDrain() first → resolves immediately if 0 active)
         then calls new OpenRouterProvider().generate(...)
         RACE WINDOW #1: if a previous click's chain rejected, this await throws,
         we hit catch at L1556 → releaseClaimedSlots() → counter goes to 0,
         BUT the chain ref is now poisoned for click N+1.
T0+1s  perClickDraft resolves with SongDraft (or null on failure)
T0+1s  for-loop iter 0..9:
         onGenerate(params, _tempId=tempIds[i])  ← async, fire-and-forget
         RACE WINDOW #2: if onGenerate throws synchronously on iter 5,
         iters 6-9 never run; releaseClaimedSlots frees 10 slots, but iters
         0-4 already async-decrement 5 → counter = 0 - 5 = clamp 0 (under-report).

T1   App.tsx::handleGenerate(params0) starts (one per iter):
       - tempId reused; setSongs(... title,style,stage='stageStartingTrack' ...)
       - generateApi.startGeneration(POST /api/generate/) ← network
T1+ε   server: INSERT generation_jobs row with params (INCLUDING apiKey)
       server: await generateMusicViaAPI(params) ← Gradio submit, returns hfJobId
       server: UPDATE generation_jobs SET acestep_task_id=?, status='running'
       server: 200 { jobId }
T1+200ms App.tsx receives jobId
       - setSongs(... jobId ...)
       - beginPollingJob(jobId, tempId) ← installs setInterval(2s)
       - decrementPendingClicks(1) ← pendingClickCount -= 1
       - activeJobCount += 1 (via setActiveJobCount inside beginPollingJob)
       Net: badge unchanged — handoff is clean.

T2..Tn polling tick (every 2s):
       - GET /status/:jobId
       - server: getJobStatus(hfJobId)
       - if aceStatus.status in ['running','succeeded'] AND !getCoverState(jobId):
           startCoverGen(jobId, polCfg)  ← idempotent gate
           RACE WINDOW #3: two concurrent polls (network reorder) could both
           pass the !getCoverState check before either calls startCoverGen.
           BUT JS event-loop serializes: each poll handler runs its sync body
           in one tick before yielding. The check + the set in startCoverGen
           are both sync. Safe within a single Node process.
       - if aceStatus.status changed → optimistic UPDATE WHERE status=oldStatus
       - if newStatus='succeeded' AND wasUpdated:
           For each audio variant:
             songId = generateUUID()
             buffer = downloadAudio()
             fastCover = fetchCoverImage(songId, undefined)  ← picsum
             buffer = tagMp3Buffer(buffer, ...) with picsum cover for ID3
             storage.upload(audio bytes)
             INSERT songs row with cover_url=NULL  ← intentional, will UPDATE later
           polEntry = getCoverState(jobId)
           if polEntry?.state==='ready':
             Promise.resolve().then(attachCover).finally(consumeCoverState)
           elif polEntry?.state==='pending':
             polEntry.promise.then(attachCover).finally(consumeCoverState)
           else: consumeCoverState(jobId)
           RACE WINDOW #4: if Pollinations call rejects mid-attach, attachCover
           is never called; consumeCoverState still runs in finally — fine.
           RACE WINDOW #5: if user DELETEs the song between INSERT and attachCover's
           UPDATE, the UPDATE is a no-op. But storage.upload still wrote bytes
           to /covers/{songId}.jpg with no row pointing to it. ORPHAN.
           RACE WINDOW #6: if user CANCELs the job between startCoverGen and
           the success branch, cancel route doesn't call consumeCoverState,
           the entry leaks.

T_done audio finishes; client polls one more time, gets succeeded status,
       refreshSongsList() loads songs (with cover_url=NULL still — Pollinations
       hasn't finished). Card shows picsum fallback. Within 5-30s, attachCover
       resolves, UPDATEs cover_url. NEXT refreshSongsList shows real cover.
       USER NEVER SEES THE TRANSITION because they have to navigate away and
       back, OR there's an explicit refetch trigger I'm missing. Verify.
```

The most concerning race windows:
- **#1 (FIFO chain poisoning)** — high probability over time, fix is one-line.
- **#2 (partial bulk failure)** — moderate probability with bulk=10 + flaky network.
- **#5 (orphan cover bytes)** — low probability now, will matter when delete-song lands.
- **#6 (cancel leaks cover entry)** — moderate probability, fix is to call `consumeCoverState` in cancel routes.

---

## 5. Test gaps

Tests that should exist:

- **`cover-jobs.test.ts`**
  - Concurrent double-`startCoverGen('id', cfg)` in same tick → only one underlying call.
  - `consumeCoverState` mid-pending → IIFE completes; map is clean afterwards.
  - 100-job churn without consumes → demonstrates leak (or, after fix, demonstrates eviction).
- **`generate.test.ts`** (does not exist — should)
  - Status endpoint cover kickoff is idempotent across polls.
  - Cancel endpoint drops cover state.
  - INSERT path stores `cover_url=NULL` initially.
  - Optimistic-lock loser does NOT fire attachCover.
  - apiKey not present in persisted `params` JSON column (regression test for the BLOCKER).
- **`pollinations.test.ts`** (does not exist — should)
  - URL encoding of UTF-8 prompt (Cyrillic, emoji).
  - Timeout abort: AbortController fires `controller.abort()` after 60s; result is `undefined`.
  - 5xx response → undefined.
  - Non-image content-type → undefined.
  - <256 byte body → undefined.
- **`prompts.test.ts` / `storage.test.ts`** — already exist, fine.
- **`CreatePanel.tsx` integration / hook test**
  - FIFO chain: 3 sequential clicks → exactly 3 OR calls, in order, second waits for first to finish (mock `waitForJobsToDrain`).
  - FIFO chain rejection on click 1 does NOT poison click 2 (regression for MUST #2 in CreatePanel).
  - Partial bulk failure: bulkCount=5, mock `onGenerate` to throw on iter 3 → counter ends at 0, no orphan placeholder cards.

---

## 6. Deferred / acceptable

- **`OpenRouterProvider` instantiated per click in `CreatePanel.handleGenerate`.** Yes, it duplicates the `useOpenRouterGeneration` hook's logic, but the hook is single-flight and reserves the streaming UI pipe. A cleaner refactor would expose a `client.singleShot(input)` method on the hook's underlying provider — but that's a 100+ LOC restructure. Current pragmatic split is fine.
- **`buildCoverPrompt` keyword-fallback when LLM returns empty `coverPrompt`.** The LLM is hard-required to return it (in SCHEMA.required), but with local LM (no OpenRouter) the path is `useOpenRouter && !activeLmModel` — pre-flight runs only when this is true. If user has local LM ON but OpenRouter OFF, pre-flight does NOT run, `perClickDraft` stays null, `effCoverPrompt = ''`, the fallback `buildCoverPrompt` correctly fires. Good.
- **Cover bytes path traversal.** `${userId}/covers/${songId}{.jpg|.png}` — both userId and songId are server-generated UUIDs. No traversal risk.
- **CSP additions.** Both Pollinations hosts whitelisted; safe and minimally scoped.
- **In-memory `jobs` Map size.** Bounded by audio-gen queue size in normal operation; only the cancel-leak (race #6) can grow it. After fixing cancel routes, no further work needed.
- **STYLE_MODIFIERS array.** Module-level constant, fine.
- **Static dimensions UI clamp.** Pollinations free-tier ignores width/height for some models — comment on PollinationsPanel L274 acknowledges this. Fine.
- **Pollinations apiKey passed in body, not header, between client→server.** The client→server channel is on-origin HTTPS — fine. Concern is server-side persistence (BLOCKER #1), not the wire.
- **`fromPollinations` flag on `fetchCoverImage` return.** Dead. Cosmetic NIT, not worth a fix until the dual-path is collapsed.
- **`testPollinationsKey` only tests reachability, not validity.** Documented in code comment at L99–104. Acceptable for now; relabel button if user complaints surface.

---

## Closing notes

The integration is structurally sound. The state-machine + fire-and-forget design genuinely keeps the audio-gen flow unblocked, which is the right priority. The slot-counter and FIFO-chain machinery is clever but fragile — in particular, item 2 (partial bulk failure) and the chain-poisoning race (CreatePanel MUST L1502) are both real and reachable in normal use.

**Action recommendation order:**
1. Redact apiKey before writing `params` JSON (BLOCKER #1).
2. Add `.catch(() => null)` link to FIFO chain (CreatePanel MUST L1502).
3. Wrap each `onGenerate(...)` loop iteration in try/catch and decrement `claimedSlotsRemaining` per success (CreatePanel MUST L1494).
4. Add `consumeCoverState(jobId)` to all three cancel routes (generate.ts MUST L530).
5. Delete unused `awaitCoverWithTimeout` import (generate.ts NIT L29).
6. Stale-entry sweeper for `jobs` Map (cover-jobs.ts SHOULD L66).
7. Stage-key constants export (i18n SHOULD).
8. Concurrent-double-startCoverGen test, partial-bulk-failure test (test gaps §5).

Total estimated effort: **~1 day of focused work.**
