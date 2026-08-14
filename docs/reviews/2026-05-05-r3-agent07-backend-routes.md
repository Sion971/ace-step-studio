# Agent 07 — Backend `routes/generate.ts` ROUND 3 Review

**Scope:** Verification of R2 fixes (batch 4) + regression hunt across the new
14-field destructure/params plumbing.
**Prior reviews:**
- `docs/reviews/2026-05-05-agent07-backend-routes.md` (R1)
- `docs/reviews/2026-05-05-r2-agent07-backend-routes.md` (R2)

**Fix commit inspected:** `e53909eed` (`fix: R2 review fixes batch 4`)
**HEAD at review:** `e53909eed`

Severities: **CRITICAL / HIGH / MEDIUM / LOW / NIT**.
Round-3 totals: **0 CRITICAL, 0 HIGH, 1 MEDIUM, 2 LOW, 2 NIT** (new findings only).
Round-2 verification: **1 of 1 verified resolved** (M5), 2 deferred (M6, L5), 1
clean-confirmed (N4).

---

## 1. Verification of round-2 findings

### M5 — `failed` status leaks `cover-jobs` Map entry → **FIXED ✅**
**Verified at:** `routes/generate.ts:613-620`.

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

Placement is **inside** the outer `if (aceStatus.status !== job.status)`
branch (line 605). Idempotency walkthrough:

| Poll | `job.status` (DB) | `aceStatus.status` | `!==` outer guard | Branch fires? |
|------|------------------|-------------------|-------------------|---------------|
| 1 | `pending` | `failed` | true | ✅ consume + UPDATE |
| 2 | `failed` (after 1) | `failed` | false | skipped |
| n | `failed` | `failed` | false | skipped |

Idempotent, no double-consume. ✅

### M6 — `consumeCoverState` ordered BEFORE DB UPDATE in cancel routes → **DEFERRED**
**Verified at:** `routes/generate.ts:843-854` (`/cancel/:jobId`),
`867-884` (`/cancel-all`), `894-912` (`/reset`).

No reordering, no comment added. The structural defense via `cancelJob()` /
`cancelAllJobs()` (which mutate in-memory acestep state before consume) still
holds — so no observable runtime bug — but the design fragility flagged in R2
is unchanged. Status: **deferred** (acceptable for local app, batch 5 candidate).

### L5 — `cancel-all` / `reset` race: new job between SELECT and consume → **DEFERRED**
**Verified at:** `routes/generate.ts:872-884`, `900-912`.

Unchanged. Pre-existing race, accepted in R1 brief. Status: **deferred**.

### N4 — `_pol` parameter rename → **CLEAN-CONFIRMED**
No regression. Unchanged from R2.

---

## 2. New findings (R3)

### M7 (new) — Cover-state **resurrection** after `consumeCoverState` on `failed`
**Refs:** `routes/generate.ts:619` (consume call), `services/cover-jobs.ts:101-153`
(async IIFE that re-inserts result entries unconditionally).

**Mechanism:**
1. `startCoverGen(jobId, polCfg)` is called from the kickoff block (line 601)
   when the audio job first transitions to `running`. The IIFE at
   `cover-jobs.ts:101` is in flight (Pollinations HTTP fetch, ~10–60 s).
2. ACE-Step audio gen fails (OOM/timeout). Status poll observes `failed`,
   line 619 calls `consumeCoverState(jobId)` → `jobs.delete(jobId)`. ✅
3. ~30 s later, the in-flight Pollinations IIFE resolves. It hits one of:
   - `cover-jobs.ts:134` — `jobs.set(jobId, result)` for `null` returns
   - `cover-jobs.ts:143` — `jobs.set(jobId, result)` for `CoverReady`
   - `cover-jobs.ts:151` — `jobs.set(jobId, result)` in `catch`
4. The Map entry is **resurrected** (300 KB JPG buffer for the success branch).
5. Subsequent status polls observe `job.status='failed'` (no longer in
   `['pending','queued','running']` at line 569) → `getJobStatus` block
   skipped → kickoff guard never re-evaluated → `consumeCoverState` never
   re-called → entry persists for the lifetime of the process.

**Quantified leak:** worst-case ~300 KB per failed job (1024×1024 JPEG with
quality ~0.8). Over a week with 30 OOM events ⇒ ~9 MB. Trivial absolute
size, but **unbounded**: process uptime is multi-day for a desktop app, and
the leak compounds with every failed gen.

**Note:** The same family applies to `/cancel/:jobId`, `/cancel-all`, `/reset`
— all of them call `consumeCoverState` while the IIFE is in flight, and the
IIFE later re-inserts. R2 §1 (H1 verification) already noted "Pollinations
Promise still completes after consume" but bounded the impact to disk-side
orphans only; the **Map-side resurrection** is the missed half of that
observation.

**Severity:** MEDIUM — process-lifetime memory leak, unbounded over weeks.
Trivial in dev but non-trivial for users who keep the app open as a
background generation worker.

**Fix direction (NOT applied):** introduce a per-jobId "cancelled" tombstone
in `cover-jobs.ts`. The IIFE checks it before each `jobs.set`:

```ts
// services/cover-jobs.ts
const cancelled = new Set<string>();

export function consumeCoverState(jobId: string): CoverEntry | undefined {
  cancelled.add(jobId);
  const e = jobs.get(jobId);
  jobs.delete(jobId);
  // GC the tombstone after a generous TTL, since the Pollinations IIFE
  // is bounded by the fetch timeout (~60 s).
  setTimeout(() => cancelled.delete(jobId), 5 * 60_000).unref();
  return e;
}
```

Then guard each `jobs.set` in the IIFE:
```ts
if (cancelled.has(jobId)) return result;  // skip set, just return
jobs.set(jobId, result);
```

R2 agent01 also noted this same family in their review — recommend coordinating
in batch 5.

---

### L6 (new) — Frontend forwards `prompt` (top-level alias) — backend silently drops it
**Refs:** `App.tsx:1159` (`prompt: (params as any).prompt`), `generate.ts:316-408`
(no `prompt` in destructure), `generate.ts:420-509` (no `prompt` in params blob).

The R2 agent10 §2 finding ("prompt alias recovered via review") was applied on
the frontend side: App.tsx now sends a top-level `prompt` field on every
`/api/generate` POST. The backend never destructures it, never echoes it into
the persisted params blob, and never reads it.

The only `prompt` the backend uses is the nested `pollinations.prompt` (used
at line 599 to build the cover-gen request). The top-level alias is
documentation-only on the wire — confusing for anyone reading network traces
expecting it to surface in the params blob.

**Severity:** LOW — non-functional, type-safe (req.body excess properties are
allowed). Either drop the field on the frontend (and the agent10 §2 commit
message), or destructure+persist on the backend for symmetry. Pick one.

---

### L7 (new) — Behaviour change unannounced: DCW/retake/flowEdit fields now reach acestep at runtime
**Refs:** `routes/generate.ts:394-408` (new destructure), `420-509` (new params
object), `services/acestep.ts:209,245,247-252` (consumers).

The batch-4 commit message frames the fix as "persisted params blob mirrors
what the user submitted (used by reuse-as-template, audit trails)." That
under-states the impact. The same `params` object built on lines 420-509 is
also passed to `generateMusicViaAPI(params)` at line 528, and `acestep.ts:209`
reads `params.dcwEnabled ?? true`, `:245` reads `params.retakeSeed ?? -1`,
`:247-252` read all five `flowEdit*` fields.

**Before batch 4:** these fields were undefined on `params` (because the
destructure dropped them) → `acestep.ts` fell back to its `??` defaults on
every request. UI controls for DCW / retake / flowEdit were **runtime-no-ops**
regardless of what the user picked.

**After batch 4:** the fields propagate. Users who previously saw "the same
DCW behaviour no matter what I picked" will now see the controls actually
take effect. This is a positive fix, but it's a behaviour change for users
with saved templates that include explicit DCW/retake choices.

`loraLoaded` is a frontend status flag (acestep.ts does not read it). Safe.

**Severity:** LOW — desirable behaviour change, but undocumented in the
commit message and CHANGELOG. Worth a one-line note in the next batch's
commit body or a follow-up CHANGELOG entry: "DCW/retake/flowEdit UI
controls now actually apply to gen (previously dropped server-side)."

---

### N5 (new) — Type drift: `samplerMode` / `repaintMode` between frontend and backend
**Refs:** `services/api.ts:355` (`samplerMode?: 'euler' | 'heun'`),
`services/api.ts:367` (`repaintMode?: 'conservative' | 'balanced' | 'aggressive'`),
`generate.ts:204` (`samplerMode?: string`),
`generate.ts:216` (`repaintMode?: 'conservative' | 'balanced' | 'aggressive' | 'most_natural'`).

Memory note in CLAUDE.md flags 10 samplers in this project (euler/heun/midpoint/
a2s/pingpong/bogacki/rk4/dopri5/deis/ipndm). Frontend type lies — only allows
`'euler' | 'heun'`. Backend is permissive (`string`). At runtime the value
flows through unchanged — no runtime bug — but the frontend type would reject
the other 8 samplers if anyone tried to assign them via TS. Pre-existing,
not introduced by R3.

`repaintMode` has the inverse drift — backend permits `'most_natural'`,
frontend doesn't.

**Severity:** NIT — pre-existing type drift, no runtime impact. Worth a
unification pass alongside R2 agent10 type-shape work.

---

### N6 (new) — `_tempId` field forwarded by frontend, dropped by backend
**Refs:** `App.tsx:1179` (`_tempId: (params as any)._tempId`), no backend
destructure.

Frontend-only placeholder id (used for instant-card UI feedback at click time,
per `1e833ab37`). Sending it to the server is harmless — nothing reads it,
nothing persists it — but it's wire noise. No impact, no fix needed unless
batch-5 also touches the GenerateBody field list.

**Severity:** NIT.

---

## 3. Mental simulation walkthrough (R3-relevant scenarios)

| # | Scenario | Behaviour observed in code |
|---|---|---|
| 1 | Job fails on first poll (CUDA OOM during very first run) | Poll sees `pending → failed`. Outer guard `!==` is **true** ⇒ enters `else if (failed && error)` ⇒ `consumeCoverState` runs ⇒ DB UPDATE. Idempotent on subsequent polls (status now `failed` in DB, outer guard `failed === failed` ⇒ false ⇒ branch skipped). ✅ |
| 2 | Same as #1, but Pollinations gen still in flight | After consume, the IIFE in `cover-jobs.ts:101` continues. ~30 s later it calls `jobs.set(jobId, result)`. Map entry resurrected. No reader. **Leak — see M7.** |
| 3 | DCW user toggles "double" mode in UI | App.tsx sends `dcwMode: 'double'`. Pre-batch-4: backend drops, acestep gets `undefined`, falls back to `dcw_enabled: true` only (no mode override). Post-batch-4: `params.dcwMode === 'double'` reaches acestep. **Behaviour change — see L7.** |
| 4 | User submits `prompt: 'epic guitar solo'` (top-level alias from agent10 §2) | Backend destructure ignores it. Persisted params blob lacks `prompt`. Reuse-as-template will not recover it. **See L6.** |
| 5 | 14-field destructure with `as GenerateBody` cast | TS validates field names & types. Each field appears once in destructure, once in params object. No collisions with existing names (`loraLoaded` is the only lora-prefixed field on the route — no `loraEnabled`/`loraScale`/`loraPath` in this file). ✅ |
| 6 | Concurrent failed-then-still-pending poll | Poll-A sees `failed`, UPDATEs DB, calls `consumeCoverState`. Poll-B (raced, started before A's UPDATE) sees `running` in stored job (DB read happened before A's UPDATE), runs `getJobStatus`, sees `failed` from acestep, `!==` outer guard fires, tries UPDATE WHERE `status='running'` (optimistic lock) — UPDATE matches 0 rows (A already updated to `failed`), `wasUpdated=false`. But `consumeCoverState` is unconditional inside the `else if` branch — it runs regardless of `wasUpdated`. Idempotent (`Map.delete` on already-deleted key is no-op). ✅ Slight inelegance: should probably gate on `wasUpdated`, but harmless. |

---

## 4. Summary table

| ID | Severity | Status | Item |
|---|---|---|---|
| M5 | MEDIUM | **FIXED** ✅ | `consumeCoverState` on `aceStatus.status === 'failed'` (line 619) |
| M6 | MEDIUM | deferred | consume-before-UPDATE ordering, structural defense unchanged |
| L5 | LOW | deferred | `/cancel-all` race, pre-existing |
| N4 | NIT | clean | `_pol` rename — no regression |
| **M7** | **MEDIUM (new)** | open | cover-state **resurrection** by in-flight IIFE after consume |
| **L6** | **LOW (new)** | open | top-level `prompt` alias forwarded by FE, dropped by BE |
| **L7** | **LOW (new)** | acceptable | unannounced runtime behaviour change for DCW/retake/flowEdit |
| **N5** | **NIT (new)** | pre-existing | `samplerMode`/`repaintMode` type drift FE↔BE |
| **N6** | **NIT (new)** | acceptable | `_tempId` forwarded but unused on BE |

**Overall:** R2's M5 fixed cleanly with idempotent placement. The **M7
resurrection** is the structurally-deeper version of the same Map-leak
family — every consume-while-IIFE-pending path (cancel/cancel-all/reset/failed)
suffers from it. Recommend a single batch-5 patch in `cover-jobs.ts` (cancelled-
tombstone + IIFE guard), 5–10 lines, fixes all four call sites at once.

L6 is a minor symmetry issue — the agent10 §2 "prompt alias" survived as a FE
addition but the BE half wasn't applied. Pick a side.

L7 is a positive change badly described. One-line CHANGELOG note suffices.

Recommended batch 5 scope:
1. cover-jobs.ts: cancelled-tombstone (M7).
2. routes/generate.ts: comment at lines 848/877/905 documenting the
   `cancelJob()`-must-run-first invariant (M6).
3. (optional) routes/generate.ts: destructure + persist top-level `prompt`
   for symmetry with FE (L6).
4. CHANGELOG: note DCW/retake/flowEdit runtime behaviour now applies (L7).
