# Pollinations Backend — Agent 04 ROUND 2 Review

**Scope:** Verification of fixes from `2026-05-05-agent04-pollinations-backend.md`.
**Fix commits inspected:** `bfc0e7527`, `ea73c3c98`, `10a87ab0e`, `2419f7d73` (HEAD).
**Method:** Per-finding audit + regression hunt + mental simulation of bulk/cancel flows.

---

## Verification of prior findings

### #2 HIGH — Re-kickoff after consume on succeeded — **FIXED** ✅

Commit `ea73c3c98` `routes/generate.ts:533-536`:

```ts
if (
  aceStatus.status === 'running' &&
  !getCoverState(req.params.jobId)
) {
```

`'succeeded'` clause dropped. The accompanying comment (lines 524-532) explicitly
documents the trade-off: "ACE-Step turbo audio takes 30+s and we poll every 2s,
so we'll always catch at least one `running` poll between queued and succeeded".

This kills the post-`consumeCoverState` re-kickoff window. Verified.

---

### #4 HIGH — Cancel routes leak Map entries — **FIXED** ✅

Commit `ea73c3c98`. All three routes now consume cover state.

- `/cancel/:jobId` — `routes/generate.ts:795`: direct `consumeCoverState(jobId)` after `cancelJob`. Idempotent on missing key (Map.delete is no-op). ✅
- `/cancel-all` — `routes/generate.ts:819-824`: SELECT in-flight job IDs (`status IN ('queued','running','pending')`), loop `consumeCoverState(row.id)` BEFORE the UPDATE. ✅
- `/reset` — `routes/generate.ts:847-852`: same pattern as cancel-all. ✅

**Race window noted in brief** (DB query → consumeCoverState loop, status-poll might also try to consume): confirmed acceptable. `consumeCoverState` is `Map.delete()` which is idempotent — deletion of an already-deleted key is a no-op. Worst case: a status-poll attaches a cover for a song that was just cancelled (orphan JPEG written, see #3). Not a memory bug.

---

### #11 MED — `fromPollinations` flag + dead Pollinations branch in `fetchCoverImage` — **FIXED** ✅

Commit `2419f7d73` `services/id3-tagger.ts`:

- Pollinations branch fully removed (was lines 95-114 in old code).
- `_pol?` parameter retained on signature (renamed to `_pol` to mark unused) — backwards compat per the JSDoc comment at line 87-90.
- Return type narrowed to `{ buffer: Buffer; mimeType: string } | undefined` (line 95) — no `fromPollinations` field.
- Imports for `generatePollinationsCover` and `songIdToSeed` removed (file is now `import NodeID3 from 'node-id3';` only at line 1).
- `PollinationsCoverConfig` interface still exported (consumed by `routes/generate.ts:25` for typing). Correct.

Grep confirms zero `fromPollinations` references in source code (only in old review docs).

---

### #5 LOW — Dead `awaitCoverWithTimeout` import — **FIXED** ✅

Commit `ea73c3c98` `routes/generate.ts:26-30`:

```ts
import {
  startCoverGen,
  consumeCoverState,
  getCoverState,
} from '../services/cover-jobs.js';
```

Import removed. Helper itself + tests retained in `cover-jobs.ts:167` and `cover-jobs.test.ts:110-135` — sensible choice (cheap to keep, well-tested).

---

### #3 MED — Orphan JPEGs after cancel — **NOT ADDRESSED** ⚠️

No on-disk cover deletion added on cancel paths. The cancel flow now consumes
the Map entry but if the Pollinations promise has already resolved AND
`attachCover` already wrote the JPEG to `audio/{userId}/covers/{songId}.{jpg|png}`
before/concurrent to the cancel UPDATE, the file is on disk with no DB row
referencing it (UPDATE matched 0 rows).

Bounded leak: ~300KB per cancelled-mid-flight cover. Acceptable for home app per original brief. **Still recommended:** add a sweep in `services/cleanup.ts` that walks `audio/*/covers/` and deletes files with no matching `songs.cover_url`. Open.

---

### #13 MED — Test coverage gaps — **NOT ADDRESSED** ⚠️

No new tests added in any of the four fix commits (`git show 2419f7d73 --stat`
and similar for batches 1-2 confirm zero `*.test.ts` deltas). Specifically still
missing:

- Concurrent `startCoverGen` race test (two synchronous calls in same tick).
- Cancel-route integration test (would exercise the new `consumeCoverState` calls in `/cancel`, `/cancel-all`, `/reset`).
- Kickoff-on-`running`-only regression test (locks down the #2 fix).

**Recommend** before next release: add at minimum a supertest harness covering the cancel routes — without it, a future refactor could silently re-introduce the Map leak.

---

### #9 LOW — `image.pollinations.ai` redundant in CSP — **NOT ADDRESSED** ⚠️

`server/src/index.ts:65` still lists both `https://image.pollinations.ai` and `https://gen.pollinations.ai` in `connectSrc`. Cosmetic, no impact. Open per original "low priority" tag.

---

## New regressions hunted

### R1 — `'running'`-only kickoff: very-fast-job edge case — **INFO**

**Hypothetical scenario:** poll #N reads `aceStatus.status === 'queued'`, audio gen completes in <2s (next poll interval), poll #N+1 reads `succeeded` → kickoff condition (`running` only) never matches → cover NEVER kicks off → `cover_url` stays NULL → UI falls through to seeded gradient.

**Code reality:** the comment at `routes/generate.ts:530-532` explicitly acknowledges this:

```
The "missed transition" risk is bounded: ACE-Step turbo audio takes
30+s and we poll every 2s, so we'll always catch at least one
`running` poll between queued and succeeded.
```

On RTX 4090 turbo, generation_time per song is observed ~30-60s for typical 3-5min tracks. With a 2s status-poll interval, missing the `running` window would require the entire diffusion+VAE+vocoder pass to complete in <2s — physically impossible at current model size. **Acceptable design trade-off, properly documented.** No fix needed.

---

### R2 — `insertedSongIds.push` in downloadError fallback — **VERIFIED CORRECT** ✅

Commit `ea73c3c98` `routes/generate.ts:703`. Confirmed: when `downloadAudioToBuffer` fails for an output, the code INSERTs the song with `audio_url = remoteUrl` (no local MP3, no ID3 tagging applied), and now pushes the songId into `insertedSongIds`. The downstream `attachCover` loop at lines 715-749 then UPDATEs `cover_url` for that song, **just like a normal song**.

This is correct: the song row exists with a real (remote) MP3 URL, and the cover is a separate `cover_url` column — they don't depend on each other. The user gets a streaming-playable song row with a Pollinations cover but no embedded ID3 tag in the streaming audio. The MP3 will not have an embedded cover in its tag, but the in-app UI shows the Pollinations cover from `cover_url`. Same trade-off as the picsum-vs-Pollinations split documented in finding #12 of round 1.

---

### R3 — Cancel-all DB query cost — **INFO** ⚠️

`routes/generate.ts:819-823`:

```sql
SELECT id FROM generation_jobs
WHERE user_id = ? AND status IN ('queued', 'running', 'pending')
```

For a single user with N in-flight jobs, this returns N rows then loops N `Map.delete()` calls. Cost is O(N) DB query (with an index on `(user_id, status)` — verify in `db/schema.sql` if needed) plus O(N) Map ops.

**Realistic ceiling:** the user-side queue is bulk=10 max. Even if a user spam-clicks, the queue gates at 10 concurrent. So N ≤ 10 for normal sessions. Pathological case (10000 stuck jobs) would still complete in <100ms on SQLite. Not a concern.

**Minor cleanup opportunity:** the SELECT happens twice if the user calls `/cancel-all` then `/reset` quickly, but each is independent. Not worth dedup'ing.

---

### R4 — Cancel mid-flight: orphan JPEG — **CONFIRMED LOW IMPACT** ⚠️

Mental sim (per brief):

1. `startCoverGen(jobId, polCfg)` — Pollinations request fires, promise pending.
2. User hits `/cancel/:jobId`. `consumeCoverState(jobId)` deletes Map entry.
3. UPDATE flips status to `failed`. Song row was never INSERTed (because `aceStatus.status !== 'succeeded'` so the song-INSERT block was never entered). DB clean.
4. Pollinations request completes seconds later. The `polEntry.promise.then((result) => attachCover(result))` chain at `routes/generate.ts:742-745` was the consumer — but that chain only existed if the song-INSERT block ran AND `getCoverState(jobId)` returned the entry at line 715. Since the song-INSERT never ran, `attachCover` was never wired up. **Promise resolves to garbage.** No file written.

**Wait — re-read.** The `polEntry.promise.then(attachCover)` chain is wired up *inside* the song-INSERT block. If we cancelled before INSERT, no chain → no `attachCover` call → no file write. JPEG never lands on disk. The promise just resolves with a buffer that gets GC'd. **No orphan in this path.**

The orphan-JPEG case (#3) only fires if: song was INSERTed (success path), `attachCover` chain wired up, then a second cancel races with the UPDATE before attachCover's UPDATE landed — but this would require the user to delete the song through a separate `DELETE /api/songs/:id` route AFTER successful gen. That's not a cancel — that's a delete. Actual cancel only stops in-flight jobs (where audio-gen hasn't completed).

**Re-classifying R4: orphan JPEG is even narrower than originally stated.** Real but extremely rare (DELETE song faster than the cover-attach finally runs).

---

### R5 — Bulk=10 mental sim — **VERIFIED CORRECT** ✅

Per brief's walk-through:

1. User clicks bulk=10 → 10 jobs INSERTed with `status='queued'`.
2. ACE-Step pipeline picks them up sequentially → each transitions queued→running→succeeded.
3. Each `running` poll fires `startCoverGen(jobId, polCfg)` → Map entry created.
4. Each `succeeded` poll: kickoff guard (line 533) checks `aceStatus.status === 'running'` → FALSE → no re-kickoff. ✅ Then enters the song-INSERT block, wires `attachCover` to `polEntry.promise.then`, eventual `consumeCoverState(jobId)` in `.finally`.
5. Subsequent polls of the same job (frontend hasn't unmounted yet) see `job.status === 'succeeded'` in DB → the entire ACE-status branch (line 520) is skipped because `['pending','queued','running'].includes('succeeded')` is FALSE → no re-INSERT, no kickoff. Map stays clean.

**Verified:** the kickoff guard fix (HIGH #2) plus the existing job.status DB gate together make the post-consume state stable. Bulk=10 behaves correctly end-to-end.

---

### R6 — Lost-optimistic-lock memory leak — **STILL OPEN** ⚠️

Original review noted (line 45): "if optimistic UPDATE fails (another worker beat us), `wasUpdated === false` → song-INSERT skipped → `attachCover` never wired → `consumeCoverState` never called → Map entry leaks for that jobId."

Looking at the current code at `routes/generate.ts:572-575`:

```ts
const updateResult = await pool.query(updateQuery, updateParams);
const wasUpdated = updateResult.rowCount > 0;
```

The branch where `wasUpdated === false` — code falls through past the song-INSERT block (gated on `wasUpdated && aceStatus.status === 'succeeded'`) and the cover-wiring block (gated on `getCoverState(req.params.jobId)` AND `insertedSongIds.length > 0`). The losing poll calls `res.json` and exits. **Map entry stays.** ⚠️

**However** — the *winning* poll calls `consumeCoverState(jobId)` in its `.finally` chain. So the entry IS cleaned up by the winner. The "leak per losing-race poll" framing in round 1 was wrong: there's only one Map entry per jobId, and exactly one of the racing pollers will consume it. **Not a leak after all.** Re-classify: NOT A BUG.

If the winner's `attachCover` chain rejects/aborts before `.finally` runs (e.g., process crash), the entry leaks until restart. Acceptable for home app.

---

## Summary — Round 2

| # | Severity (R1) | Status | Notes |
|---|---------------|--------|-------|
| 2 | HIGH | **FIXED** | `'succeeded'` removed from kickoff guard (`generate.ts:533-536` in `ea73c3c98`). |
| 4 | HIGH | **FIXED** | All three cancel routes call `consumeCoverState` (`ea73c3c98`). |
| 11 | MED | **FIXED** | Dead Pollinations branch removed from `fetchCoverImage` (`2419f7d73`). |
| 5 | LOW | **FIXED** | Dead `awaitCoverWithTimeout` import removed (`ea73c3c98`). |
| 3 | MED | **OPEN** | Orphan JPEGs after cancel — not addressed. Recommended cron sweep in `cleanup.ts`. Low impact. |
| 13 | MED | **OPEN** | No tests added. Recommend cancel-route integration tests. |
| 9 | LOW | **OPEN** | `image.pollinations.ai` redundant in CSP — cosmetic, ignore. |

**New findings (round 2):**

| #  | Severity | Item                                        | Action |
|----|----------|---------------------------------------------|--------|
| R1 | INFO     | Very-fast-job missed-`running` window       | None — properly documented in code comment, physically impossible on real hardware. |
| R2 | INFO     | `insertedSongIds.push` in fallback verified | None — works correctly. |
| R3 | INFO     | Cancel-all DB query cost                    | None — bounded by bulk=10 ceiling. |
| R4 | INFO     | Cancel mid-flight orphan JPEG narrowed      | None — narrower than originally stated. |
| R5 | INFO     | Bulk=10 end-to-end simulation               | None — clean. |
| R6 | INFO     | Lost-optimistic-lock leak re-analyzed       | None — only one Map entry per jobId, winner consumes. R1 framing was wrong. |

**Counts:** 0 BLOCKER · 0 HIGH (was 2 in R1, both fixed) · 1 MED open + 1 MED tests open · 1 LOW open · 6 INFO new.

**Total open from R1:** 3 (#3 storage cron sweep, #13 tests, #9 CSP cleanup) — all acceptable for home app.
**Total fixed in R2:** 4 of 7 actionable findings (HIGH #2, HIGH #4, MED #11, LOW #5).
**No new regressions introduced by the fix commits.**

---

**Verdict:** The fix batches are clean. Both HIGH-severity findings closed with correct, minimal patches. The MED #11 dead-code rip is properly scoped (kept `_pol?` for backwards compat, kept `PollinationsCoverConfig` for typing). LOW #5 cleanup good. Outstanding items are all acceptable open trade-offs documented in the original review.
