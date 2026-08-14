# Agent 07 — Backend `routes/generate.ts` ROUND 4 Review

**Scope:** Verification of R3 fixes (batch 5) + regression hunt across the new
`prompt` plumbing and the `cover-jobs.ts` tombstone mechanism.
**Prior reviews:**
- `docs/reviews/2026-05-05-agent07-backend-routes.md` (R1)
- `docs/reviews/2026-05-05-r2-agent07-backend-routes.md` (R2)
- `docs/reviews/2026-05-05-r3-agent07-backend-routes.md` (R3)

**Fix commit inspected:** `0fe60457f` (`fix: R3 review fixes batch 5`)
**HEAD at review:** `0fe60457f`

Severities: **CRITICAL / HIGH / MEDIUM / LOW / NIT**.
Round-4 totals: **0 CRITICAL, 0 HIGH, 0 MEDIUM, 2 LOW, 2 NIT** (new findings only).
Round-3 verification: **2 of 2 verified resolved** (M7, L6), 3 deferred-as-noted
(L7, N5, N6).

---

## 1. Verification of round-3 findings

### M7 — Cover-state resurrection after `consumeCoverState` → **FIXED ✅**
**Verified at:** `services/cover-jobs.ts:66-101, 119-121, 159, 168, 176`.

The fix matches R3's recommended direction exactly:

1. **Tombstone Set added** (`cover-jobs.ts:74-75`):
   ```ts
   const cancelled = new Set<string>();
   const TOMBSTONE_TTL_MS = 5 * 60_000;
   ```
2. **`consumeCoverState` writes the tombstone** (lines 93-101):
   ```ts
   export function consumeCoverState(jobId: string): CoverEntry | undefined {
     const e = jobs.get(jobId);
     jobs.delete(jobId);
     cancelled.add(jobId);
     setTimeout(() => cancelled.delete(jobId), TOMBSTONE_TTL_MS).unref?.();
     return e;
   }
   ```
   `setTimeout().unref()` prevents the timer from keeping the Node event loop alive
   on shutdown — important for a desktop-app process model. The optional-chain
   (`.unref?.()`) is paranoid (vitest fake timers historically returned objects
   without `unref`), but harmless.
3. **All three IIFE `jobs.set` callsites guarded** (lines 159, 168, 176):
   ```ts
   if (!cancelled.has(jobId)) jobs.set(jobId, result);
   ```
   Guards the `null`-return failure branch, the `CoverReady` branch, and the
   `catch` branch — all three `jobs.set` paths flagged in R3.
4. **Bonus: `startCoverGen` short-circuits on tombstoned jobIds** (lines 119-121):
   ```ts
   if (cancelled.has(jobId)) {
     return { state: 'failed', reason: 'cancelled', finishedAt: Date.now() };
   }
   ```
   Returns synchronously without firing a Pollinations call. This is the right
   behaviour for the cancel/cancel-all/reset flows, where the status-poller may
   re-enter `startCoverGen` after the job is tombstoned but before the DB UPDATE
   propagates (more on the race window below — it's harmless).
5. **Two new vitest cases** (`cover-jobs.test.ts:180-198, 200-207`) cover both
   the resurrection and the tombstoned-then-startCoverGen paths. Mock pattern
   uses `new Promise(r => { resolveFn = r })` to deterministically reproduce
   the mid-flight cancel. Solid.

**Walkthrough — failed audio + in-flight Pollinations (M7's worst case):**
- Poll @ T+0s: `aceStatus='failed'` → enter `else if` branch at line 619 →
  `consumeCoverState(jobId)` → `jobs.delete(jobId)` + `cancelled.add(jobId)`.
- T+30s: Pollinations IIFE resolves → `if (!cancelled.has(jobId)) jobs.set(...)`
  → guard returns false → `jobs.set` skipped → no resurrection. ✅
- T+5min: tombstone TTL fires → `cancelled.delete(jobId)`. By this point the
  IIFE has long since terminated (Pollinations 60s timeout), so the tombstone
  is safe to drop. No subsequent poll will re-enter `getJobStatus` for this
  job either, because `job.status='failed'` and the outer guard at line 575
  excludes it.

Idempotent, leak-proof, no observable side-effects beyond a 5-min Set entry
per failed/cancelled job. ✅

### L6 — Top-level `prompt` field forwarded by FE, dropped by BE → **FIXED ✅**
**Verified at:** `routes/generate.ts:136-137` (interface), `321-323` (destructure
+ comment), `428` (params object).

```ts
// GenerateBody (line 134-137):
songDescription?: string;
/** ACE-Step text prompt — alias of lyrics for custom mode. */
prompt?: string;

// destructure (line 321-323):
songDescription,
// `prompt` is the ACE-Step text prompt — frontend sends it for custom mode
// (alias of lyrics). Was being silently dropped before.
prompt,

// params blob (line 426-428):
customMode,
songDescription,
prompt,
```

Field appears once in each of the three layers. Matches the existing
14-field destructure pattern from batch 4. ✅

**Caveat (becomes finding L8 below):** the persisted blob now contains
`prompt`, so reuse-as-template will replay it into the form. But
`acestep.ts:155` still derives the runtime caption from `params.style ||
'pop music'` (custom mode) or `params.songDescription` (simple mode). The
new `params.prompt` is **not read** by acestep.ts at all — it's a DB-only
field. See L8.

### L7 — CHANGELOG note re: DCW/retake/flowEdit runtime impact → **DEFERRED**
No CHANGELOG entry added. Commit message does mention "DCW + FlowEdit + retake"
in batch 5 description, but it's framed as type-cleanup, not behaviour-change.
Status: **deferred** (still acceptable, R3 noted this as one-line follow-up).

### N5 — `samplerMode`/`repaintMode` type drift FE↔BE → **DEFERRED**
Unchanged. Pre-existing. Status: **deferred**.

### N6 — `_tempId` forwarded by FE, dropped by BE → **DEFERRED**
Unchanged. Status: **deferred** (R3 noted as acceptable wire noise).

---

## 2. New findings (R4)

### L8 (new) — `prompt` persisted to DB blob but **never reaches acestep.ts at runtime**
**Refs:** `routes/generate.ts:323,428` (destructure + persist),
`services/acestep.ts:155` (runtime caption derivation).

The R3-L6 fix added `prompt` to the destructure and the persisted params blob,
which closes the audit-trail / reuse-as-template symmetry gap. But the runtime
side is still not wired:

```ts
// services/acestep.ts:155
const prompt = params.customMode ? caption : (params.songDescription || caption);
//                                  ↑                                     ↑
//                            caption = params.style || 'pop music'       (line 154)
```

`acestep.ts` reads `params.style`, `params.songDescription`, `params.lyrics` —
but not the new top-level `params.prompt`. So:

- **Custom mode submit**: form sends `{ style: "synth-pop", prompt: "epic
  guitar solo", lyrics: "...", customMode: true }`. Backend persists all four.
  Acestep call uses `caption = "synth-pop"` (style), ignores `prompt`. The
  ACE-Step model never sees `"epic guitar solo"`.
- **Reuse-as-template**: the saved DB blob contains `prompt: "epic guitar
  solo"` → form repopulates → user re-clicks Generate → same outcome (prompt
  stored, not used).

Two reasonable interpretations:

1. **The frontend is wrong.** `params.prompt` was added to the App.tsx
   whitelist by the agent10 §2 review, but the field has no runtime consumer
   on either side of the wire. Drop it from the whitelist and from
   GenerateBody — it's dead state.
2. **The backend is incomplete.** If the intent is for `prompt` to override
   `style` as the ACE-Step caption when `customMode=true`, then
   `acestep.ts:155` should be:
   ```ts
   const prompt = params.customMode
     ? (params.prompt || caption)
     : (params.songDescription || caption);
   ```
   …but this is a behaviour change that should land with an explicit decision
   and a CHANGELOG note (cf. L7 from R3).

**Severity:** LOW — non-functional today (prompt is just DB ballast), but
type/wire symmetry suggests one of the two paths above should be picked.
Pre-existing semantically (the FE has been forwarding `prompt` since agent10's
review); R3's L6 fix made the asymmetry persisted-DB-side rather than
silently-dropped-on-the-floor, which is arguably worse for a reader debugging
"why doesn't my prompt do anything".

**Fix direction (NOT applied):** raise as a product question — does
`customMode` use `style` or `prompt` for ACE-Step caption? Then either drop
the field or wire it.

---

### L9 (new) — `startCoverGen` re-fires synchronously every 2s for tombstoned jobs in cancel-during-running window
**Refs:** `routes/generate.ts:588-608` (kickoff guard), `cover-jobs.ts:119-121`
(tombstone short-circuit).

Sequence:
1. Job is in `running` state. Cover-gen has been kicked off; entry exists
   in `jobs` map.
2. User clicks "Cancel". `/cancel/:jobId` runs → `cancelJob(jobId)` →
   `consumeCoverState(jobId)` (deletes entry, adds tombstone) → DB UPDATE
   to `status='failed'`.
3. Race: a status-poll request that started before step 2 reads job.status
   from DB before the UPDATE commits → sees `'running'` → calls
   `getJobStatus(acestep_task_id)` → may still return `'running'` (depends
   on whether `cancelJob` propagated to the in-process queue first; usually
   does, but not guaranteed).
4. If `aceStatus.status === 'running'` and `!getCoverState(jobId)` (true,
   consumed at step 2), kickoff guard at line 588-590 fires:
   ```ts
   if (aceStatus.status === 'running' && !getCoverState(req.params.jobId)) {
     // ...
     startCoverGen(req.params.jobId, polCfg);
   }
   ```
5. `startCoverGen` enters the tombstone short-circuit (`cancelled.has(jobId)`
   → return `{state:'failed'}`), and notably **does not insert into `jobs`
   map**. So `getCoverState(jobId)` remains `undefined`.
6. Each subsequent poll (every 2s) repeats steps 3-5: `aceStatus` may still
   read `running` for one more poll, `getCoverState` is still undefined,
   guard fires, `startCoverGen` short-circuits. No work, no leak — but it's
   in a tight 2-second poll loop.

**Quantified impact:** at most a few iterations per cancel (2-4 polls before
the DB UPDATE propagates and the outer `['pending','queued','running']`
guard at line 575 starts excluding the job). Each iteration is a Set.has
(O(1)) and an object allocation for the returned `CoverFailed`. Tens of
nanoseconds. Effectively free.

**Severity:** LOW — wasted work, not a bug. Worth a one-line comment at
line 588-590 noting that `startCoverGen` is tombstone-safe (so future
readers don't worry about the missing `getCoverState(...) === undefined` →
"oh no a Map leak" inference).

**Fix direction (NOT applied):** either tighten the kickoff guard to also
check the tombstone (export a `isTombstoned(jobId): boolean` from
`cover-jobs.ts` and check it alongside `getCoverState`), or add a comment.
The comment is the cheaper, less-coupled choice.

---

### N7 (new) — Optional-chain on `setTimeout().unref?.()` in `consumeCoverState`
**Refs:** `services/cover-jobs.ts:99`.

```ts
setTimeout(() => cancelled.delete(jobId), TOMBSTONE_TTL_MS).unref?.();
```

Node's `setTimeout` always returns a `Timeout` object with `.unref()` (since
Node 0.9). The optional chain is paranoid — only matters if a test runner
stubs `setTimeout` with a function that returns a non-Timeout (vitest fake
timers historically did this). Harmless, but slightly wire-noisy.

**Severity:** NIT — leave it; the cost is one extra branch on a path that
runs once per cancel.

---

### N8 (new) — `prompt` field in `GenerateBody` typed as optional, in frontend `GenerationParams` typed as required
**Refs:** `routes/generate.ts:137` (`prompt?: string`), `app/types.ts:67`
(`prompt: string`).

Frontend's `GenerationParams.prompt` is required (no `?`). Backend's
`GenerateBody.prompt` is optional. At runtime there's no observable
difference (frontend always sends it, backend always destructures), but it's
a small type-shape drift that joins the existing `samplerMode`/`repaintMode`
drift family (R3 N5).

**Severity:** NIT — pre-existing-ish (the frontend type pre-dates this PR;
the backend only added `prompt?:` in batch 5). Worth a unification pass
alongside R3's N5 work if anyone touches the type-shape file.

---

## 3. Mental simulation walkthrough (R4-relevant scenarios)

| # | Scenario | Behaviour observed in code |
|---|---|---|
| 1 | Custom mode click with `prompt="epic guitar"`, `style="synth-pop"`, `customMode=true` | FE sends both. BE destructures both (line 321-326). Both persisted to DB blob (line 426-431). `generateMusicViaAPI(params)` called. acestep.ts:155 builds runtime `prompt = caption` where `caption = params.style = "synth-pop"`. Top-level `params.prompt` is ignored. **DB has both, runtime uses style. See L8.** |
| 2 | Reuse-as-template on a job from #1 | DB row's `params` JSON contains both `prompt` and `style`. Form repopulates with `prompt="epic guitar"`, `style="synth-pop"`. User clicks Generate again → same as #1: persisted both, runtime uses style. **Round-trips faithfully but silently. See L8.** |
| 3 | Failed audio, cover still pending (M7's worst case) | Status poll @ T+0 sees `aceStatus='failed'` → enters line 619 → `consumeCoverState(jobId)` → tombstone added, jobs entry deleted. T+30s: Pollinations IIFE resolves → `if (!cancelled.has(jobId)) jobs.set(...)` → guard false → `jobs.set` skipped. **No leak. See M7 verified.** |
| 4 | Cancel during running — race between DB read and DB UPDATE | Poll-A reads `job.status='running'` from DB (race window before /cancel UPDATE commits) → calls `getJobStatus` → returns `running` → kickoff guard fires `!getCoverState` (true, consumed) → `startCoverGen` enters tombstone short-circuit → returns `failed`, **does not insert into jobs**. Next poll repeats until DB UPDATE propagates and outer guard at 575 excludes the job. **Wasted work, not a bug. See L9.** |
| 5 | Cancel-all → 5 in-flight Pollinations IIFEs | DB SELECT returns 5 rows → loop calls `consumeCoverState(row.id)` 5× → 5 tombstones added. Each in-flight IIFE eventually resolves and is guarded. **No leak.** Pre-existing race (jobs created during the SELECT-then-loop window) accepted in R1 brief. |
| 6 | Tombstone TTL expires before Pollinations IIFE resolves | Tombstone TTL is 5min, Pollinations timeout is ~60s. So this is impossible by design (5min ≫ 60s). If somehow Pollinations exceeded 5min, the IIFE would call `jobs.set(jobId, result)` after tombstone expired → entry resurrected. But: at that point no reader cares (the audio job is long since `failed` in DB), and the entry would just sit until process death. Acceptable, and prevented in practice. ✅ |
| 7 | Test idempotency — `_resetCoverJobs` between tests | New `_resetCoverJobs` clears both `jobs` AND `cancelled` (line 78-81). So tests don't leak tombstones between cases. ✅ |

---

## 4. Summary table

| ID | Severity | Status | Item |
|---|---|---|---|
| M7 | MEDIUM | **FIXED** ✅ | cover-state resurrection — tombstone in cover-jobs.ts |
| L6 | LOW | **FIXED** ✅ | top-level `prompt` destructured & persisted |
| L7 | LOW | deferred | CHANGELOG note for DCW/retake/flowEdit runtime impact |
| N5 | NIT | deferred | `samplerMode`/`repaintMode` FE↔BE drift |
| N6 | NIT | deferred | `_tempId` wire noise |
| **L8** | **LOW (new)** | open | `prompt` persisted to DB but never read by acestep.ts |
| **L9** | **LOW (new)** | open | `startCoverGen` re-fires for tombstoned jobs in cancel race window (harmless) |
| **N7** | **NIT (new)** | acceptable | `setTimeout().unref?.()` optional-chain paranoia |
| **N8** | **NIT (new)** | open | `prompt` required on FE, optional on BE — type drift |

**Overall:** Batch 5 cleanly fixes the two open R3 findings — M7's
resurrection is solved by a tombstone Set with `unref`'d 5-min TTL and
guards at all three IIFE `jobs.set` callsites, plus a synchronous
short-circuit in `startCoverGen` that prevents re-firing network calls for
tombstoned jobs. L6's `prompt` plumbing is in place at the destructure,
interface, and params-blob level.

The new R4 findings are all LOW/NIT:
- **L8** is the most interesting: the `prompt` field round-trips through
  the DB but is **dead at runtime** — `acestep.ts:155` reads `params.style`,
  not `params.prompt`. R3's L6 fix made this asymmetry louder (now persisted
  rather than silently dropped). Needs a product decision: is `prompt` a
  separate ACE-Step caption, or is it identical to `style` and the FE
  should drop it from the whitelist?
- **L9** is a tight-loop wasted-work edge case in the cancel race window;
  bounded to 2-4 polls. A one-line comment would suffice.
- **N7/N8** are pure cosmetic.

No new structural issues. The cover-jobs.ts state machine is now correct
under all the failure modes that R1/R2/R3 enumerated.

Recommended next batch (if any):
1. Decide on `prompt` semantics (L8). Either:
   a. Drop `prompt` from FE whitelist, BE destructure, BE GenerateBody, DB
      blob (4-line revert) — if it's truly a duplicate of `style`/`lyrics`.
   b. Wire it into `acestep.ts:155` as the canonical custom-mode caption,
      with `style` as fallback — if it's meant to be a separate ACE-Step
      "captions" input. Add CHANGELOG note (L7+L8 combined).
2. Comment at `routes/generate.ts:588-590` documenting tombstone-safety of
   `startCoverGen` re-entry (L9).
3. (cosmetic) Unify `prompt`/`samplerMode`/`repaintMode` types across
   `app/types.ts` and `routes/generate.ts` (N5 + N8).
