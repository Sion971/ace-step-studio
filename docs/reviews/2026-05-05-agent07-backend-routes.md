# Agent 07 — Backend `routes/generate.ts` Review

**Scope:** `app/server/src/routes/generate.ts` (1623 lines)
**Range:** `d8aab5bf2..HEAD` (8 commits, latest `6c39f42c5`)
**Focus:** GenerateBody type, destructure, params build, INSERTs, status polling, attachCover, cancel/reset.

Severities used: **CRITICAL / HIGH / MEDIUM / LOW / NIT**.
Total findings: **13** (1 CRITICAL, 1 HIGH, 4 MEDIUM, 4 LOW, 3 NIT).

---

## CRITICAL

### C1. `attachCover.finally(consumeCoverState)` + late poll → second cover-gen kicked off
**Refs:** `generate.ts:525-551` (kickoff guard), `generate.ts:707-741` (consume after attach).

The kickoff guard in the polling endpoint is:

```ts
if ((aceStatus.status === 'running' || aceStatus.status === 'succeeded') &&
    !getCoverState(req.params.jobId)) {
  ...
  startCoverGen(req.params.jobId, polCfg);
}
```

After the song-INSERT block runs, the cover-attach handler always calls `consumeCoverState(jobId)` in `.finally()` (lines 732, 737, 739). That **deletes** the entry from the in-memory map.

The route still re-runs whenever the frontend keeps polling (frontend currently polls a few extra times after `succeeded` to fetch the final result). On the next poll:
1. `aceStatus.status === 'succeeded'` (still true).
2. `getCoverState(jobId)` returns `undefined` (we just consumed).
3. Guard passes → `startCoverGen()` fires **again**.
4. New Pollinations call, pure waste. The orphan entry then sits in the map forever (no `insertedSongIds.length > 0` path will run again because `wasUpdated` is false the second time).

**Severity:** CRITICAL — silent duplicate billable image-gen request per finished job, plus permanent map leak per duplicate.

**Suggested fix direction (NOT applied):** keep a `consumedJobIds: Set<string>` tombstone, OR gate the kickoff additionally on `job.status !== 'succeeded'` (read from DB row, not aceStatus), OR don't call `consumeCoverState` — let entries age out via TTL.

---

## HIGH

### H1. Cancel / cancel-all / reset routes leak `cover-jobs` map entries
**Refs:** `generate.ts:777-816` (`/cancel/:jobId`, `/cancel-all`), `generate.ts:819-847` (`/reset`).

All three routes update `generation_jobs.status = 'failed'` but never touch the `cover-jobs.ts` Map. If cover-gen was already kicked off by a previous status poll (job had transitioned to `running`), the entry sits in the map until process exit. For `/cancel-all` and `/reset` this can leak an unbounded number of entries (one per active job at the time of reset).

A second-order effect: because the entries are still `pending`, they continue running the Pollinations HTTP call to completion, billing the user's apiKey for an image whose songs will never be inserted (status went to `failed`, the `if (aceStatus.status === 'succeeded' && wasUpdated)` block doesn't run).

**Severity:** HIGH — money + memory leak on cancel, observable in any bulk-queue use.

**Mitigation direction (NOT applied):** call `consumeCoverState(jobId)` for every cancelled jobId after marking failed. For `/cancel-all` and `/reset`, iterate the user's active jobIds. Optionally abort the in-flight Pollinations promise (`AbortController`) — out of scope unless `pollinations.ts` is restructured.

---

## MEDIUM

### M1. Unused import `awaitCoverWithTimeout`
**Refs:** `generate.ts:29`.

```ts
import {
  startCoverGen,
  consumeCoverState,
  awaitCoverWithTimeout,   // <- never referenced anywhere in this file
  getCoverState,
} from '../services/cover-jobs.js';
```

Verified — only `startCoverGen`, `consumeCoverState`, `getCoverState` are referenced (lines 532, 549, 707, 732, 737, 739). The function exists in `cover-jobs.ts:167` and is exported, but nothing in `routes/generate.ts` calls it. Dead import.

**Severity:** MEDIUM — TS strict will flag this; if `noUnusedLocals=true` the build will fail.

---

### M2. `insertedSongIds.length === 0` ⇒ map leak
**Refs:** `generate.ts:708`.

```ts
if (insertedSongIds.length > 0 && polEntry) { ... }
```

If every audio download throws *before* the first `await pool.query(INSERT)` finishes (network outage, malformed remote URL, etc.), `insertedSongIds` is empty. The `else` branch is missing — `polEntry` stays in the map forever, *and* the Pollinations call continues to completion with no consumer for the result.

Note: the current fallback path in the `catch (downloadError)` block (line 661-696) ALSO inserts a song row but does **not** push to `insertedSongIds`. So if all download calls hit the catch path, every song is INSERTed but `insertedSongIds` is `[]` ⇒ no cover attach + leaked entry. This is buggy — the fallback songs deserve covers too.

**Severity:** MEDIUM — correctness bug under download failure.

**Fix direction (NOT applied):** add `insertedSongIds.push(songId)` inside the catch block, OR guarantee a `consumeCoverState(jobId)` in the no-attach branch.

---

### M3. Status route always calls `getJobStatus()`, even after first `succeeded`
**Refs:** `generate.ts:521-523`.

```ts
if (['pending', 'queued', 'running'].includes(job.status) && job.acestep_task_id) {
  const aceStatus = await getJobStatus(job.acestep_task_id);
  ...
}
```

OK on the surface — `succeeded`/`failed` rows skip the block. BUT once the local DB row has been UPDATEd to `succeeded` by the optimistic-lock path, subsequent polls take the fall-through branch at line 762 (returns stored status). That means the **second poll** after success will *not* re-enter the block. Combined with C1 above: the C1 race only happens if the user triggers **two near-simultaneous** poll requests, both observing `job.status === 'running'` while ACE-Step has already moved to `succeeded`. Both pass the kickoff guard before either does the optimistic UPDATE. Plausible under the existing 1-2s frontend poll cadence with an HTTP retry.

**Severity:** MEDIUM — race scenario for C1; same root cause, separate manifestation.

---

### M4. `cleanupJob(job.acestep_task_id)` vs cover-state key (`localJobId`)
**Refs:** `generate.ts:700`, vs `cover-jobs.ts` keyed by `localJobId`.

The local `cover-jobs` Map is keyed by `localJobId` (UUID generated in POST `/`, line 464). `cleanupJob` clears the ACE-Step task cache keyed by `acestep_task_id`. No conflict, but the asymmetry means there is **no central place that owns the localJobId lifecycle**. Any new code path that needs to "release" a job must remember to call `consumeCoverState` separately. Easy to miss (see H1).

**Severity:** MEDIUM — design smell, not a runtime bug today.

---

## LOW

### L1. `savedCoverUrl` is dead — always null
**Refs:** `generate.ts:621`, `generate.ts:655`.

```ts
const savedCoverUrl: string | null = null;
...
savedCoverUrl,   // INSERT param, line 655
```

Per-finding: the previous `cover.fromPollinations` branch was removed when `fetchCoverImage` was simplified to picsum-only. `savedCoverUrl` is initialized to `null` and never reassigned. The variable could be inlined as `null` (matches what the `catch` fallback path does at line 692). Pure cosmetic.

**Severity:** LOW — readability.

---

### L2. `coverNoiseStrength` destructured then dropped
**Refs:** `generate.ts:357` destructure → `generate.ts:443` re-pack.

Verified that `coverNoiseStrength` flows through. Quick check across all 60+ destructured fields confirms each is re-packed into `params`. **No unused destructures found except** the reasonably-large surface where some fields may be unused by `generateMusicViaAPI`. Out of scope for this review.

**Severity:** N/A — scan negative.

---

### L3. `apiKey: pol.apiKey || ''` — defensive vs PolCfg type
**Refs:** `generate.ts:539`.

`PollinationsCoverConfig.apiKey` is typed `string | undefined`. The `|| ''` coercion is unnecessary; `cover-jobs.ts:126` already does `pol.apiKey || undefined` before the HTTP call. Minor: passes `''` where `undefined` would be more idiomatic. Functionally equivalent.

**Severity:** LOW — style.

---

### L4. Storage duplication for bulk batches
**Refs:** `generate.ts:715-720`.

For batchSize=10, the same cover JPEG bytes are uploaded under 10 different keys (`{userId}/covers/{songId}.jpg`). At ~50-200 KB per cover, peak ~2 MB extra disk per bulk-of-10. Acceptable per task brief.

**Severity:** LOW — efficiency NIT, accepted by spec.

---

## NIT

### N1. `apiKey` stored unencrypted in `generation_jobs.params`
**Refs:** `generate.ts:468`.

Per task brief, security paranoia is skipped. Flagged as NIT.

### N2. `ACE-Step status check error` swallowed → returns stored status
**Refs:** `generate.ts:756-758`.

```ts
} catch (aceError) {
  console.error('ACE-Step status check error:', aceError);
}
```

When `getJobStatus` throws (ACE-Step process restart, task_id evicted), the catch logs and falls through to the stored-status response at line 762. `aceStatus` is never assigned, so the inner `if (aceStatus.status...)` block was never entered. Return path is fine: returns the last-known DB status. Only side effect: `cover-jobs` kickoff is skipped on this poll, will retry on the next. Correct behavior.

**Severity:** N/A — verified safe.

### N3. SQLite `datetime('now')` consistency
**Refs:** `generate.ts:720`.

UPDATE uses `datetime('now')` (UTC). Matches existing INSERT `created_at` / `updated_at` convention. Consistent.

---

## Verified-clean items (per task brief checklist)

| # | Item | Result |
|---|---|---|
| 1 | `GenerateBody.pollinations` shape matches frontend & `PollinationsCoverConfig` | OK — 9 fields, all optional under `pollinations?` (only `enabled` required if present). |
| 2 | All destructured fields used in body | OK — `pollinations` and `openrouterModel` both flow through to `params`. |
| 3 | `params` object construction includes both `pollinations` and `openrouterModel` | OK — lines 459-460. |
| 4 | POST `/` no longer kicks off cover-gen | OK — only `generateMusicViaAPI(params)` is called; comment at 471-475 explains. |
| 5 | Status-route kickoff guard | **BUG** — see C1. |
| 6 | `succeeded` path: `savedCoverUrl=null`, background UPDATE later | OK — confirmed dance works for happy path. |
| 7 | `insertedSongIds` closure capture across delayed UPDATE | OK — array captured by ref; deletion mid-flight is no-op. |
| 8 | Per-song bytes duplication | LOW — accepted. |
| 9 | UPDATE SQL syntax | OK. |
| 10 | Type-only import `PollinationsCoverConfig` w/ `.js` extension | OK. |
| 11 | Cancel routes leak Map | **BUG** — see H1. |
| 12 | `cleanupJob` vs cover-state keys | OK but asymmetric — see M4. |
| 13 | `activeLmModel = ''` stored as `null` | OK — `'' \|\| params.lmModel \|\| null` falls through to null. |
| 14 | `downloadAudioToBuffer` failure path inserts with remoteUrl + null cover | OK runtime; but cover-attach skips fallback songs (M2). |
| 15 | All-failures empty `insertedSongIds` leaks Map | **BUG** — see M2. |
| 16 | `req.params.jobId` SQLi | OK — parameterized. |
| 17 | `apiKey` plaintext in JSON column | NIT N1. |
| 18 | `cover_url` schema | OK — already in baseline. |
| 19 | JSON_extract paths in test queries | trivia, no prod impact. |
| 20 | `getJobStatus` throws → stale aceStatus | OK — see N2. |

---

## Summary table

| ID | Severity | Item |
|---|---|---|
| C1 | CRITICAL | Cover-gen re-kickoff after `consumeCoverState` |
| H1 | HIGH | Cancel / reset leaks cover-jobs Map + bills user |
| M1 | MEDIUM | Unused import `awaitCoverWithTimeout` |
| M2 | MEDIUM | All-fail download path leaks Map + skips covers |
| M3 | MEDIUM | Race on near-simultaneous polls compounds C1 |
| M4 | MEDIUM | Two cleanup keyspaces (acestep_task_id vs localJobId) |
| L1 | LOW | Dead `savedCoverUrl` variable |
| L2 | LOW | (clean — no unused destructures found) |
| L3 | LOW | `pol.apiKey \|\| ''` vs `undefined` style |
| L4 | LOW | Cover bytes duplicated per song (accepted) |
| N1 | NIT | apiKey unencrypted in JSON column (paranoia skipped) |
| N2 | NIT | `getJobStatus` throw path verified safe |
| N3 | NIT | datetime('now') UTC consistency confirmed |
