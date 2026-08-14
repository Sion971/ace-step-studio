# Agent 07 — Backend `routes/generate.ts` ROUND 2 Review

**Scope:** Verification of fixes for round-1 findings + regression hunt.
**Prior review:** `docs/reviews/2026-05-05-agent07-backend-routes.md`
**Fix commits inspected:** `bfc0e7527`, `ea73c3c98`, `10a87ab0e`, `2419f7d73`
**HEAD at review:** `2419f7d73`

Severities: **CRITICAL / HIGH / MEDIUM / LOW / NIT**.
Round-2 totals: **0 CRITICAL, 0 HIGH, 2 MEDIUM, 1 LOW, 1 NIT** (new findings only).
Round-1 verification: **5 of 5 verified resolved**, 1 deferred-as-discussed.

---

## 1. Verification of round-1 findings

### C1 — Cover-gen re-kickoff after `consumeCoverState` → **FIXED ✅**
**Verified at:** `routes/generate.ts:533-536`.

```ts
if (
  aceStatus.status === 'running' &&
  !getCoverState(req.params.jobId)
) {
```

`'succeeded'` was dropped from the status guard (was previously `(running || succeeded)`).
Comment block at 524-532 explicitly documents the rationale + the bounded-risk
argument (poll cadence 2 s vs ACE-Step turbo ≥ 30 s ⇒ at least one `running` poll
will be observed). Verified by reading `bfc0e7527 → ea73c3c98` diff.

The "missed transition" risk is acceptable: if audio truly finished between two
polls (e.g. dev hot-reload pause), no cover-gen runs — songs get the
synchronous picsum cover only. Acceptable for a local app.

---

### H1 — Cancel routes leak `cover-jobs` Map → **FIXED ✅**
**Verified at:**
- `/cancel/:jobId` — `routes/generate.ts:795` (`consumeCoverState(jobId)`)
- `/cancel-all` — `routes/generate.ts:824` (loop over `inFlight.rows`)
- `/reset` — `routes/generate.ts:852` (loop over `inFlight.rows`)

All three routes now drop the cover-state map entry before/around the DB UPDATE
that flips status to `failed`. `cancel-all` and `reset` first SELECT the user's
in-flight jobIds, then call `consumeCoverState(row.id)` for each.

Note: the in-flight Pollinations Promise still completes after consume (no
AbortController). For a home app this is acceptable — at worst one image
finishes uploading to disk after the user clicked cancel, but no DB UPDATE
matches the (now-failed) song row, so no `cover_url` is written. Orphan JPG
on disk. Documented in round-1 brief, accepted.

---

### M1 — Dead import `awaitCoverWithTimeout` → **FIXED ✅**
**Verified at:** `routes/generate.ts:26-30`.

```ts
import {
  startCoverGen,
  consumeCoverState,
  getCoverState,
} from '../services/cover-jobs.js';
```

`awaitCoverWithTimeout` removed. Confirmed by `git show ea73c3c98` (line 29
deletion).

---

### M2 — `downloadError` fallback skips `insertedSongIds` → **FIXED ✅**
**Verified at:** `routes/generate.ts:703`.

The fallback INSERT block (catch path of the audio-download try/catch) now
`insertedSongIds.push(songId)` after pushing the remote URL into `localPaths`.
Comment at 699-702 documents intent. So even when downloads fail and the song
row carries the remote URL, the cover-attach loop will still UPDATE its
`cover_url` once Pollinations finishes.

Caveat (already noted in brief, acceptable): the fallback song's MP3 is the
remote file — its embedded ID3 image is whatever the remote server tagged it
with, NOT our cover JPG. Only `songs.cover_url` (in-app UI) gets the
Pollinations art. When the user clicks "download", the file they get is the
remote MP3 with no/different cover. Per task brief: acceptable for home app.

---

### L2 (negative) — CSP `image.pollinations.ai` redundant → **DEFERRED**
**Verified at:** `app/server/src/index.ts:65`.

```ts
connectSrc: [..., 'https://image.pollinations.ai', 'https://gen.pollinations.ai', ...]
```

Backend now uses `gen.pollinations.ai` exclusively (`services/pollinations.ts:21`).
Frontend `services/pollinations/client.ts:19` also uses `gen.pollinations.ai`.
The only references to `image.pollinations.ai` left are i18n strings in 5 lang
files (`pollinations.modelPicker.pickHint`) — pure documentation, no fetch.

`image.pollinations.ai` in CSP is dead weight. Status: **deferred** per brief
(L-tier, no functional impact). Worth dropping in a future cleanup pass along
with the i18n strings.

---

## 2. New findings (regressions / scenarios from round-1 brief)

### M5 (new) — `failed` status leaks cover-jobs Map entry
**Refs:** `routes/generate.ts:556-573` (status UPDATE block), nothing equivalent
to `consumeCoverState` on the failure branch.

**Scenario:**
1. Job transitions queued → running. Status poll #N kicks off `startCoverGen` —
   entry inserted into `cover-jobs.ts` Map.
2. ACE-Step audio-gen fails (CUDA OOM, timed-out, …). `aceStatus.status='failed'`.
3. Status poll observes failure. Block at 556-573 UPDATEs DB to `status='failed'`.
4. `wasUpdated === true`, but the `if (aceStatus.status === 'succeeded'...)`
   block at 576 is **skipped** (status is failed, not succeeded). Therefore the
   `insertedSongIds.length > 0 && polEntry` cleanup path at 716-749 never runs.
5. The map entry sits there. Pollinations HTTP call continues to completion,
   billing the user's apiKey. When done, the Promise's `.then` is never
   subscribed, the result is GC'd. Map entry leaks for the lifetime of the
   process.

**Severity:** MEDIUM — same flavor as round-1 H1 (which was fixed for *user-
initiated* cancel). This is the *automatic-failure* counterpart and was not
covered by the H1 patch. Symptom is bounded by failure rate × server uptime,
likely small in practice but trivial to fix.

**Fix direction (NOT applied):** add a parallel branch in the UPDATE block,
e.g.:
```ts
} else if (aceStatus.status === 'failed' && wasUpdated) {
  consumeCoverState(req.params.jobId);
}
```
or unconditionally `consumeCoverState` whenever `aceStatus.status` is terminal
(`succeeded` || `failed`) once we know `wasUpdated`.

---

### M6 (new) — `consumeCoverState` ordered BEFORE DB UPDATE in `/cancel/:jobId`
**Refs:** `routes/generate.ts:790-802`.

Order in `/cancel/:jobId`:
1. Line 790: `cancelJob(jobId)` — flips in-memory acestep status to `'failed'`.
2. Line 795: `consumeCoverState(jobId)` — drops cover-state map entry.
3. Line 798-802: DB UPDATE marks `generation_jobs.status='failed'`.

**Race:** If a concurrent status poll fires between (2) and (3):
- DB still has `status='running'` ⇒ poll enters the `getJobStatus()` block.
- `getJobStatus(acestep_task_id)` reads in-memory acestep job — already set to
  `'failed'` by step (1) above. Guard at line 533 requires `status==='running'`
  ⇒ **fails** ⇒ no re-kickoff.

**Conclusion:** the race is **defended** by the order of `cancelJob` (step 1)
which mutates the in-memory acestep job before `getJobStatus` is even called by
the poll. So in current code there is **no observable bug** from the consume-
before-UPDATE ordering.

But the defense is structural and easy to break. If a future refactor moves
`cancelJob()` after the DB UPDATE, or splits acestep status from the in-memory
state machine, the C1-style re-kickoff could resurface. Worth a comment.

For `/cancel-all` and `/reset` the same defense applies — `cancelAllJobs()` is
called first (line 815, 844) which iterates active jobs and flips their
in-memory status.

**Severity:** MEDIUM — design fragility, not a runtime bug today.

**Mitigation direction (NOT applied):** add comment `// must run AFTER
cancelJob() so the next poll sees acestep status='failed'` at line 795/824/852,
OR move consume after DB UPDATE so the DB itself becomes the source of truth
for the guard.

---

### L5 (new) — `cancel-all` / `reset` race: new job created between SELECT and consume
**Refs:** `routes/generate.ts:819-824` (cancel-all), `847-852` (reset).

Between the `SELECT id` (line 819) and the loop (line 824), POST `/api/generate`
could insert a new job and the polling endpoint could kick off cover-gen for it.
That new entry escapes the consume loop. Subsequent UPDATE at line 827 only
touches statuses that were already `(queued, running, pending)`, so the new
job's row ALSO escapes the cancel — meaning the cancel was racy as a whole, not
just the cover-state side.

This is a pre-existing class of bug, present before the round-1 patch. The
round-1 brief accepted this race ("Acceptable").

**Severity:** LOW — pre-existing, no regression introduced by R1 fixes,
acceptable for local app.

---

### N4 (new) — `_pol` parameter rename in `id3-tagger.fetchCoverImage`
**Refs:** `services/id3-tagger.ts:92-95`, `routes/generate.ts:608` (only
caller).

```ts
export async function fetchCoverImage(
  songId: string,
  _pol?: PollinationsCoverConfig
): Promise<...>
```

Caller passes `undefined` (`fetchCoverImage(songId, undefined)`). No caller
still passes `pol`. The underscore-prefix idiom signals "intentionally unused"
to most TS lint configs. Comment at lines 87-90 explains why the param is kept
on the signature.

**Severity:** N/A — verified safe.

---

## 3. Mental simulation walkthrough

| # | Scenario | Behaviour observed in code |
|---|---|---|
| 1 | Cold start, single job, audio gen 30 s | Poll 1 sees `running` → `startCoverGen`. Polls 2-15 see `running`, guard fails on `getCoverState !== undefined`. Audio finishes → poll N sees `succeeded`, optimistic UPDATE wins, INSERTs songs, `attachCover`, `consumeCoverState`. Subsequent polls see `succeeded`+`getCoverState === undefined`, but kickoff guard requires `running` ⇒ no re-fire. ✅ |
| 2 | Audio fails (CUDA OOM) after cover kicked off | Poll N sees `failed`, UPDATE flips DB to `failed`. `succeeded`-branch skipped. `cover-jobs` Map entry leaks. ❌ — see **M5**. |
| 3 | User cancels `/cancel/:jobId` | `cancelJob` mutates acestep state→failed. `consumeCoverState` drops Map. DB UPDATE failed. In-flight Pollinations Promise completes, `.then(attachCover)` writes JPG to disk, `UPDATE songs WHERE id=sid` matches 0 rows (song never INSERTed because cancel happened pre-success). Orphan JPG on disk. ✅ acceptable |
| 4 | Concurrent polls during `succeeded` transition (M3 in R1) | Both polls observe `running` → both pass guard → second `startCoverGen` is **idempotent** in `cover-jobs.ts:96-97` (returns existing entry). No double-fire. ✅ |
| 5 | Download all failures (M2 in R1, fixed) | Each catch-block INSERT now also `insertedSongIds.push(songId)`. `attachCover` UPDATEs every song's `cover_url`. ✅ |
| 6 | `getJobStatus` throws (N2 in R1) | `aceStatus` never assigned, kickoff block never executed (TDZ-ish guard via try/catch wrapping). Falls through to stored DB status. ✅ |

---

## 4. Summary table

| ID | Severity | Status | Item |
|---|---|---|---|
| C1 | CRITICAL | **FIXED** ✅ | guard now `aceStatus.status === 'running'` only (line 534) |
| H1 | HIGH | **FIXED** ✅ | `consumeCoverState` in all three cancel routes (795, 824, 852) |
| M1 | MEDIUM | **FIXED** ✅ | dead import removed (lines 26-30) |
| M2 | MEDIUM | **FIXED** ✅ | fallback INSERT now `insertedSongIds.push` (line 703) |
| L2 | LOW | deferred | `image.pollinations.ai` in CSP — i18n-strings-only |
| **M5** | **MEDIUM (new)** | open | `failed` status path leaks Map entry (line 564-567) |
| **M6** | **MEDIUM (new)** | open | consume-before-UPDATE ordering relies on `cancelJob` side-effect, fragile |
| **L5** | **LOW (new)** | accepted | `/cancel-all` & `/reset`: new-job-during-cancel race (pre-existing) |
| **N4** | **NIT (new)** | clean | `_pol` param rename verified — only caller passes `undefined` |

**Overall:** All round-1 CRIT/HIGH/MED items resolved cleanly. Two new MEDIUM
findings flagged (M5, M6), both same family (Map leak / ordering brittleness)
and both trivial to fix in a 5-line patch:

```ts
// at line 567, after the failed-status UPDATE:
} else if (aceStatus.status === 'failed' && wasUpdated) {
  consumeCoverState(req.params.jobId);
}
```

Recommend a third batch (`fix: review fixes batch 4`) covering M5 and an order-
swap or safety comment for M6.
