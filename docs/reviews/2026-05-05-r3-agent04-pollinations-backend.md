# Pollinations Backend — Agent 04 ROUND 3 Review

**Scope:** Verification of R2 fix-batch-4 + new regression hunt at HEAD `e53909eed` ("fix: R2 review fixes batch 4").
**Method:** Per-finding audit + resurrection-window mental simulation + new-regression sweep.
**Files inspected:** `app/server/src/routes/generate.ts`, `app/server/src/services/cover-jobs.ts`, `app/server/src/services/id3-tagger.ts`.

---

## Verification of R2 findings

### R2 M5 — failed-status branch leaked Map entry — **FIXED** ✅

`routes/generate.ts:613-620`:

```ts
} else if (aceStatus.status === 'failed' && aceStatus.error) {
  updateQuery += `, error = ?`;
  updateParams.push(aceStatus.error);
  // Audio gen failed (CUDA OOM, timeout, model error). The cover-jobs
  // entry never gets consumed by the success-path attachCover, so
  // drop it here to prevent a Map leak per failed job.
  consumeCoverState(req.params.jobId);
}
```

`consumeCoverState(req.params.jobId)` is now invoked inside the `else if (aceStatus.status === 'failed')` branch at line 619. With the comment block explicitly documenting the rationale (CUDA OOM / timeout / model error path). ✅

**Caveat — see new R3 finding below on resurrection.** The Map entry is deleted, but the `startCoverGen` async IIFE still has a live Promise; when it eventually resolves, it does `jobs.set(jobId, result)` at lines 134/143/151 of `cover-jobs.ts`, resurrecting the entry. Same root-cause class as the original R1 framing.

---

### R2 M6 — `consumeCoverState` ordering vs DB UPDATE in `/cancel/:jobId` — **NOT ADDRESSED** ⚠️

`routes/generate.ts:838-862` shows the current order in `/cancel/:jobId`:

```ts
// 1. cancel ACE-Step queue
const cancelled = cancelJob(jobId);

// 2. drop cover-gen Map entry
consumeCoverState(jobId);          // <-- line 848

// 3. UPDATE generation_jobs SET status='failed' ...
await pool.query(`UPDATE ...`, [jobId, req.user!.id]);  // <-- line 851
```

R2 M6 flagged that `consumeCoverState` should fire **after** the DB UPDATE (or use a guard sentinel), so a concurrent status-poll that already passed the optimistic-lock UPDATE can't sneak in and re-`startCoverGen` between the consume and the failed-write. Current ordering is consume-first → tiny window where:

1. Cancel handler calls `consumeCoverState(jobId)` (Map cleared).
2. Concurrent status-poll request enters `if (aceStatus.status === 'running' && !getCoverState(jobId))` → guard passes (Map is empty).
3. Status-poll calls `startCoverGen(jobId, polCfg)` — Map entry resurrected.
4. Cancel handler now runs the UPDATE → `status='failed'`.
5. The Pollinations promise eventually resolves; the song-INSERT block won't run on subsequent polls (DB status is `failed`), so `attachCover` chain is never wired up. Map entry leaks until process restart.

**Real but narrow.** Requires a `running` status-poll racing with the cancel handler's `consumeCoverState`-then-UPDATE pair. In single-user home app with 2s poll interval this firing window is ≤1ms — extremely rare in practice but not impossible. Re-classified as MED open per R2.

Fix would be: move `consumeCoverState(jobId)` to AFTER the `await pool.query(UPDATE)` line. Then the kickoff guard at line 582 — which reads job.params for `pol` config — would still work because the UPDATE only changes status, not params; but the UPDATE having already landed means the next status-poll will see `job.status === 'failed'` and skip the entire `['pending','queued','running'].includes(job.status)` branch (line 569), so it won't enter the `startCoverGen` kickoff at all. Done correctly, the resurrection window collapses.

Refs: `routes/generate.ts:843-855`. **Open.**

---

### R2 N4 — `_pol` rename in `fetchCoverImage` — **VERIFIED** ✅

`services/id3-tagger.ts:92-95`:

```ts
export async function fetchCoverImage(
  songId: string,
  _pol?: PollinationsCoverConfig
): Promise<{ buffer: Buffer; mimeType: string } | undefined> {
```

Parameter renamed `_pol` to mark unused. Doc-comment lines 87-90 explicitly call out the intent ("kept on the signature for backwards compatibility … if/when Pollinations gen is fast enough to embed inline, this could fork on `pol.enabled` again"). Grep confirms only one occurrence of `_pol` in source (line 94). ✅

---

### R2 L5 — `/cancel-all` + `/reset` SELECT-then-consume race — **NOT ADDRESSED** ⚠️

`routes/generate.ts:872-877` (`/cancel-all`) and `routes/generate.ts:900-905` (`/reset`):

```ts
const inFlight = await pool.query(
  `SELECT id FROM generation_jobs
   WHERE user_id = ? AND status IN ('queued', 'running', 'pending')`,
  [req.user!.id]
);
for (const row of inFlight.rows) consumeCoverState(row.id);
// THEN: UPDATE generation_jobs SET status='failed' ...
```

Same pre-existing race window as R2 noted: between the SELECT at line 872 and the UPDATE at line 880, a parallel status-poll for one of those jobIds could call `startCoverGen` again (because the Map was just cleared). Then UPDATE runs → status flips to `failed` → resurrected entry leaks.

**Pre-existing per R2 deferred.** Same fix shape as R2 M6: move `consumeCoverState` loop to after the UPDATE. Open.

---

### R2 carry-over status

| R1/R2 finding | Status at HEAD `e53909eed` |
|---------------|----------------------------|
| M3 — orphan JPEGs cron sweep in `cleanup.ts` | Still **open**, deferred per home-app brief. |
| M13 — missing tests (concurrent kickoff, cancel integration) | Still **open**, no `*.test.ts` deltas in batch 4. |
| L9 — `image.pollinations.ai` redundant in CSP | Still **open** (cosmetic). |

All three deferred per original "low priority for home app" classification. No regressions.

---

## R3 new findings

### R3-1 — Resurrection of consumed Map entry by in-flight Promise — **MEDIUM** ⚠️ (NEW REGRESSION CLASS)

**Mental simulation, CUDA-OOM scenario:**

1. `t=0s`: status-poll #1 sees `aceStatus.status === 'running'` → `startCoverGen(jobId, polCfg)`.
   - Map: `{ jobId: { state: 'pending', promise } }`.
   - Async IIFE inside `startCoverGen` is awaiting `generatePollinationsCover(...)` (~5-30s).
2. `t=2s`: status-poll #2 sees `aceStatus.status === 'failed'` (CUDA OOM during VAE decode).
   - Enters `else if` at line 613.
   - UPDATE writes `status='failed'`, `error='CUDA out of memory…'`.
   - Line 619: `consumeCoverState(req.params.jobId)` → `jobs.delete(jobId)`. Map empty.
3. `t=2s+ε`: status-poll #2 returns response. Frontend may re-poll, but DB status is now `'failed'` so line 569 guard `['pending','queued','running'].includes(job.status)` is FALSE → `startCoverGen` cannot be re-fired. Good.
4. `t=10s`: the Pollinations promise from step 1 resolves with a `CoverReady` buffer.
   - Inside the IIFE at `cover-jobs.ts:143`: `jobs.set(jobId, result)` runs. **Map entry RESURRECTED** with `{ state: 'ready', buffer: ~300KB, … }`.
5. **No consumer.** The success-path `attachCover` chain (`generate.ts:768-801`) is never wired up because that code only runs inside the song-INSERT block which is gated on `aceStatus.status === 'succeeded' && wasUpdated` — won't happen for a CUDA-OOM failed job. The resurrected entry sits in the Map indefinitely.

**Per-failed-job leak:** ~300KB Buffer ref held alive by the Map. No garbage collection mechanism exists in `cover-jobs.ts` (no TTL, no periodic sweep). Across a long-running session with N failures, the leak compounds linearly: 100 failed jobs ≈ 30MB held forever. Not catastrophic, but real and unbounded over a long session.

**Same root cause for R2 M6 + L5 races** — anywhere `consumeCoverState` fires while the IIFE is still awaiting Pollinations, the eventual `jobs.set` resurrects.

**Fix shape (analytical, not prescriptive):** the cleanest mitigation is a per-job "consumed" sentinel — either:
- A separate `Set<string>` of consumed jobIds checked inside the IIFE before calling `jobs.set`, OR
- An `aborted: boolean` flag on the `CoverPending` entry (but the entry is gone post-consume, so this doesn't help directly), OR
- Pass an `AbortController` into `generatePollinationsCover` and call `controller.abort()` from `consumeCoverState` to short-circuit the request.

The AbortController approach is most surgical because it also cancels the in-flight HTTP fetch to Pollinations (frees a network slot, avoids burning quota on a cancelled job). The existing `pollinations.ts` already wraps an internal AbortController for the 60s timeout — it would need to accept an external `signal` to compose with cancel.

Refs: `cover-jobs.ts:101-154`, `routes/generate.ts:613-620,848`. **MED open.**

---

### R3-2 — New `GenerateBody` fields (DCW/FlowEdit/retake/loraLoaded) cover-gen impact — **INFO (no impact)** ✅

`routes/generate.ts:222-236` defines the new optional fields, threaded through `params` at `routes/generate.ts:399-407,500-508`. The cover-gen path reads from `params.pollinations` (line 587) only. None of the new fields touch the Pollinations config object. The `polCfg` builder at `routes/generate.ts:589-600` constructs a fresh `PollinationsCoverConfig` from `pol.{model,width,height,seedMode,enhance,nologo,safe,prompt}` — the new fields don't appear.

The cover prompt comes from `pol.prompt` (built on the frontend by `buildCoverPrompt` from style/lyrics/caption hints), not from the new fields. So FlowEdit / retake / DCW / loraLoaded changes do not affect the cover-gen image content even when those modes are active. ✅

No regression introduced.

---

### R3-3 — `/cancel/:jobId` ordering: consume-before-UPDATE fragility — **MEDIUM** ⚠️

Already noted under R2 M6 verification above. Restated here as a standalone R3 finding because the impact compounds with R3-1 (resurrection):

If the `consumeCoverState`-before-UPDATE order in `/cancel` triggers a status-poll race that re-`startCoverGen`s, the resurrected entry from R3-1 mechanism is GUARANTEED to leak (DB status is now `failed`, success-path attach unreachable). The two findings together produce a deterministic leak under that interleaving — not just a probabilistic one.

Same fix as R2 M6: swap order of `consumeCoverState` + UPDATE. Refs: `routes/generate.ts:843-855`. **MED open.**

---

### R3-4 — `awaitCoverWithTimeout` setTimeout leak on first-branch return — **LOW** ⚠️

`cover-jobs.ts:171-185`:

```ts
const e = jobs.get(jobId);
if (!e) return null;
if (e.state !== 'pending') return e;

let timer: NodeJS.Timeout | undefined;
const timeout = new Promise<null>((resolve) => {
  timer = setTimeout(() => resolve(null), timeoutMs);
});
try {
  const winner = await Promise.race([e.promise, timeout]);
  return winner ?? null;
} finally {
  if (timer) clearTimeout(timer);
}
```

The early-return branches (`if (!e) return null;` and `if (e.state !== 'pending') return e;`) execute before the `setTimeout` is created, so no timer leak there. The race-branch correctly clears the timer in `finally`. Verified clean.

(Originally suspected leak — turns out NOT a leak. Marking INFO instead.)

Refs: `cover-jobs.ts:167-185`. **INFO.**

---

### R3-5 — Cover-gen kickoff happens BEFORE optimistic-lock UPDATE — **INFO** ✅

`routes/generate.ts:582-603` fires `startCoverGen` based purely on `aceStatus.status === 'running'` and `!getCoverState(jobId)`. This runs **before** the DB UPDATE on line 625. So if two pollers race the optimistic-lock, BOTH may have already kicked off the cover gen — but `startCoverGen` is idempotent (`if (existing) return existing;` at `cover-jobs.ts:96-97`), so only one underlying Pollinations request fires.

No regression. ✅

---

### R3-6 — `consumeCoverState` is invoked TWICE on success path — **INFO (correct, idempotent)** ✅

Walk-through for the happy path:

1. status-poll catches `running` → `startCoverGen` → Map: pending.
2. status-poll catches `succeeded` → song-INSERT block runs → wires `polEntry.promise.then(attachCover).finally(consumeCoverState(jobId))`.
3. Pollinations resolves → `attachCover` runs → finally fires → `consumeCoverState(jobId)` → Map delete.

If between steps 2 and 3 another poll arrives and hits the `failed` branch (impossible in normal flow — status was `succeeded` at step 2 and won't transition back), there's no double-consume. Even if there were, `Map.delete` is idempotent — safe.

Verified.

---

## Summary — Round 3

| ID | Status | Severity | Notes |
|----|--------|----------|-------|
| R2 M5 | **FIXED** | (was MED) | `consumeCoverState` added at `generate.ts:619` in failed-status branch. |
| R2 M6 | **OPEN** | MED | `/cancel/:jobId` still consumes before UPDATE. Race + R3-1 → guaranteed leak under interleaving. |
| R2 N4 | **VERIFIED** | INFO | `_pol` rename intact in `id3-tagger.ts:94`. |
| R2 L5 | **OPEN** | LOW (deferred) | `/cancel-all` + `/reset` SELECT-then-consume race remains. |
| R1 M3 | **OPEN** | MED (deferred) | Orphan JPEG cron sweep — still on backlog. |
| R1 M13 | **OPEN** | MED (deferred) | No tests added in batch 4. |
| R1 L9 | **OPEN** | LOW | CSP `image.pollinations.ai` redundant. |

| R3 ID | Severity | Item | Action |
|-------|----------|------|--------|
| R3-1 | **MED** | Resurrection of consumed Map entry by in-flight Promise (failed-status path) | Add AbortController-from-consume OR consumed-sentinel checked inside IIFE before `jobs.set`. |
| R3-2 | INFO | New `GenerateBody` fields don't touch cover-gen path | None. |
| R3-3 | **MED** | `/cancel` ordering fragility compounds R3-1 | Move `consumeCoverState` after the UPDATE (collapses resurrection window). |
| R3-4 | INFO | `awaitCoverWithTimeout` setTimeout placement audited | None — clean. |
| R3-5 | INFO | Kickoff before optimistic UPDATE → idempotent guarded | None. |
| R3-6 | INFO | Happy-path `consumeCoverState` invocation audited | None — idempotent. |

**Counts:** 0 BLOCKER · 0 HIGH · 2 MED new (R3-1, R3-3) · 0 LOW new · 4 INFO new.
**Carry-over open:** 1 MED (M3), 1 MED (M13), 1 LOW (L5), 1 LOW (L9), plus R2 M6 (now MED, paired with R3-1).
**Fixed in batch 4:** 1 (R2 M5).

---

**Verdict on batch 4:** R2 M5 closed cleanly. R2 M6 left untouched — because of the resurrection mechanism (R3-1), this combination produces a deterministic per-failed-job memory leak (~300KB Buffer × N failures, unbounded). The fix is mechanical (move `consumeCoverState` after the UPDATE in `/cancel`, `/cancel-all`, `/reset`, and add an abort signal into the IIFE), but until landed, the leak persists. For a single-user home app with infrequent failures this is acceptable; for any session with repeated CUDA OOMs (e.g., model-merger experimentation while gen running) the Map will grow noticeably over hours.

No new regressions from the unrelated `GenerateBody` field additions (DCW/FlowEdit/retake/loraLoaded) — those don't touch the cover-gen path. ✅
