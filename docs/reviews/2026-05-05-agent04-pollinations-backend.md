# Pollinations Backend — Agent 04 Review

**Scope:** `cover-jobs.ts` state machine, `pollinations.ts` HTTP client, `id3-tagger.ts` extensions, `routes/generate.ts` (status-poll cover kickoff + attachCover), `index.ts` CSP.
**Commit range:** `d8aab5bf2..HEAD` (most relevant: `bfc0e7527`, `ff7fe5934`).
**Context:** local home app, single user; security paranoia skipped per brief.

Severity legend: **CRITICAL** = correctness bug that fires in normal use · **HIGH** = real bug, hits a known edge case · **MEDIUM** = correctness/cleanliness, future-pain · **LOW** = nit/dead code · **INFO** = note, no action.

---

## 1. State machine concurrency window — INFO (no race)

`startCoverGen` is fully synchronous up to and including `jobs.set(jobId, pending)`:

```ts
// cover-jobs.ts:96-158
const existing = jobs.get(jobId);
if (existing) return existing;
// ...build promise (the IIFE returns a Promise instantly; the `await`
// inside happens AFTER set)...
const pending: CoverPending = { state: 'pending', startedAt, promise };
jobs.set(jobId, pending);
return pending;
```

The `await generatePollinationsCover(...)` lives **inside** the async IIFE that's invoked via `(async () => {...})()`. That returns a Promise immediately; control returns to `startCoverGen`, which then calls `jobs.set` synchronously. Node's event loop is single-threaded, so `get`+`set` are atomic w.r.t. JS code. **No race.**

The status-poll handler in `routes/generate.ts:530-551` does have an `await` between the DB query and `getCoverState(jobId)` check, but `startCoverGen` is itself synchronous — so even if two concurrent status-polls reach the `if (!getCoverState(...))` block at the same micro-tick, the first one to call `startCoverGen` synchronously inserts the entry, and the second's call sees `existing` and returns it. Idempotency holds.

**No fix needed.**

---

## 2. Re-kickoff after `consumeCoverState` — **CRITICAL**

This is a real bug. Walk-through:

1. Audio job is `running`, poll sees `running` → `getCoverState() === undefined` → `startCoverGen` → entry is `pending`.
2. Audio job transitions to `succeeded`. Status-poll line 521 condition `['pending','queued','running'].includes(job.status)` reads `job.status` from DB — that's the previous status (`running`) until the optimistic UPDATE fires, so we still enter the branch. Good.
3. Cover finishes; the `polEntry.promise.then(...).finally(consumeCoverState(jobId))` (line 737) deletes the map entry.
4. Frontend keeps polling (component unmount latency, multiple poll consumers). Next poll: `job.status` in the DB is now `succeeded`, so line 521 `['pending','queued','running'].includes(job.status)` is **false** — the entire ACE-status branch is skipped, including the `startCoverGen` kickoff. **No re-kickoff.**

So the worst case the brief described **does not actually fire** — it's gated by the `job.status` DB check, not just by `aceStatus.status`. Good.

But: there *is* a related bug. Suppose the optimistic-lock UPDATE (line 569) fails (another worker beat us). Then `wasUpdated === false`, the song-INSERT block is skipped, and `attachCover` is never wired up. But `getCoverState(jobId)` still has the pending entry. We never `consumeCoverState`. **Memory leak per losing-race poll.** In practice the optimistic lock only loses when two pollers race; the winner attaches+consumes. Loser just falls through to `res.json(...)` at line 745 and exits. Entry stays in the map forever for that jobId.

Also: the brief's specific scenario ("poll4 kicks off another cover gen") does not fire because `job.status === 'succeeded'` after the DB UPDATE skips the whole ACE branch. **However**, the kickoff condition on line 530 reads `aceStatus.status === 'succeeded'`. If somehow `job.status` is still `running` in the DB (because the UPDATE on line 569 was for a *different* race / a hot-cache job.params read), the `startCoverGen` could fire after `consumeCoverState` cleared the map. That requires a very specific interleaving — multiple pollers, with the song-INSERT path completing on poll N (deletes entry) but a parallel poll N' that read `job.status='running'` *before* poll N's UPDATE landed, then arrives at the kickoff check *after* poll N's `consumeCoverState`. Real but rare.

**Severity downgraded from CRITICAL → HIGH.** Recommended fix: after `consumeCoverState`, gate `startCoverGen` on a "this job is fully done" sentinel. Easiest: stash a `consumed` Set<string> alongside the map, and skip kickoff if `consumed.has(jobId)`. Or — simpler — only kick off when `aceStatus.status === 'running'` (drop the `'succeeded'` clause); the running poll always precedes succeeded by at least one tick in practice.

Refs: `routes/generate.ts:521,530-551,707-740`.

```diff
-        if (
-          (aceStatus.status === 'running' || aceStatus.status === 'succeeded') &&
-          !getCoverState(req.params.jobId)
-        ) {
+        // Only kick off on running. The 'succeeded' window is too narrow
+        // (sub-second between aceStatus poll and our DB UPDATE) to justify
+        // the risk of post-consumption re-kickoff.
+        if (aceStatus.status === 'running' && !getCoverState(req.params.jobId)) {
```

---

## 3. `attachCover` race with cancel — **MEDIUM** (storage leak, acceptable)

`attachCover` writes the cover JPEG to storage *and* runs `UPDATE songs SET cover_url=? WHERE id=?`. If the user deletes the song between the INSERT (line 630) and `attachCover` (line 720) — e.g. `DELETE /api/songs/:id` cascades a hard delete — the UPDATE matches 0 rows but the JPEG is already on disk.

Storage leak per cancelled-after-INSERT-before-cover song. For local home app, trivial. Worth a one-line cleanup task in the cron sweep that already lives in `services/cleanup.ts` — sweep `audio/{userId}/covers/*.{jpg,png}` files where no row in `songs` has matching `cover_url`. Not blocking.

Refs: `routes/generate.ts:713-725`.

---

## 4. Cancel routes don't consume cover state — **HIGH** (memory leak)

`/cancel/:jobId` (777), `/cancel-all` (799), `/reset` (819) all UPDATE `generation_jobs SET status='failed'` but never call `consumeCoverState`. If cover gen kicked off (status was running), the entry stays `pending` until Pollinations resolves, then becomes `ready`/`failed` and **sits in the map forever** because the only consumer (the status-poll succeeded-path) is unreachable for a `failed`-status job (line 521 still allows it, but the song-INSERT is gated on `aceStatus.status === 'succeeded'` which won't happen for a cancelled job — and `cleanupJob(job.acestep_task_id)` was never reached).

Map grows unbounded across cancel-heavy sessions. Each entry holds a Buffer ref (~300KB) once resolved.

```diff
 router.post('/cancel/:jobId', authMiddleware, async (req, res) => {
   try {
     const { jobId } = req.params;
     const cancelled = cancelJob(jobId);
+    // Drop any pending cover-gen entry for this job (memory hygiene; the
+    // Pollinations promise itself can't be aborted, but the result will be
+    // GC'd once it resolves).
+    consumeCoverState(jobId);
     await pool.query(
       `UPDATE generation_jobs SET status = 'failed', ...`
```

For `/cancel-all` and `/reset` we don't have the jobId list directly — would need to query `SELECT id FROM generation_jobs WHERE user_id=? AND status IN ('queued','running','pending')` before the UPDATE, then loop `consumeCoverState`. Or expose a `_purgeCoverJobsForUser` helper that walks the map (it doesn't currently track userId, so this would require a schema change in `cover-jobs.ts` — keep CoverEntry tied to a userId for purge).

Refs: `routes/generate.ts:777-816,819-847`. **Fix needed.**

---

## 5. `awaitCoverWithTimeout` is dead code — **LOW**

Imported in `routes/generate.ts:29` but the production code path uses `polEntry.state === 'ready' ? Promise.resolve.then(attachCover) : polEntry.promise.then(...)` (lines 727-740). `awaitCoverWithTimeout` is exported and tested but never invoked at runtime.

```diff
 import {
   startCoverGen,
   consumeCoverState,
-  awaitCoverWithTimeout,
   getCoverState,
 } from '../services/cover-jobs.js';
```

Either remove the import + the helper itself + its tests, or keep the helper for future use and just drop the import. Tests at `cover-jobs.test.ts:110-135` exercise it well, so keeping it is cheap. **Just drop the unused import.**

Refs: `routes/generate.ts:29`, `cover-jobs.ts:167-185`, `cover-jobs.test.ts:110-135`.

---

## 6. Pollinations 60s timeout failure path — INFO (correctly silent-failed)

```ts
// routes/generate.ts:734-737
polEntry.promise
  .then((result) => { if (result.state === 'ready') return attachCover(result); })
  .catch((e) => console.warn(`[cover] background attach failed for job ${jobId}:`, e))
  .finally(() => consumeCoverState(jobId));
```

When `result.state === 'failed'` (timeout / 5xx / abort), the `.then` callback returns `undefined`, the `.catch` doesn't fire (the promise didn't reject — it resolved with a `CoverFailed`), and `.finally` consumes the entry. `cover_url` stays NULL in DB. UI falls through to its seeded gradient.

This is correct and matches the documented intent. Confirmed.

Refs: `routes/generate.ts:733-740`, `cover-jobs.ts:128-136`.

---

## 7. URL length — INFO (within limits)

`gen.pollinations.ai/image/{encodeURIComponent(prompt)}?model=...&width=...`. Prompt budget:
- `pol.prompt` from frontend buildCoverPrompt: typical ~150-250 chars
- `, ${styleHint}`: ~30-90 chars (longest is `'minimalist vector illustration, two-tone palette, lots of negative space'` = 73 chars)
- `encodeURIComponent` ~1.5x bloat for spaces/commas (commas → %2C, spaces → %20)

Worst case: `(250 + 90) * 1.5 + ENDPOINT(36) + ?model=zimage&width=1024&height=1024&seed=2147483647&nologo=true&enhance=true&safe=true&apiKey=...` (params ~150) ≈ **~700 chars**. Well below the 8K Node `fetch`/HTTP server typical limit, well below Cloudflare's 16K, well below Pollinations' practical limit (they return 414 for >2K). No action.

Refs: `pollinations.ts:56-68`, `cover-jobs.ts:115`.

---

## 8. `songIdToSeed` — INFO (deterministic by design)

`parseInt(uuid.replace(/-/g,'').slice(0,8), 16) & 0x7fffffff` → 31-bit positive int. Used both as seed AND `% STYLE_MODIFIERS.length` for style index. Same jobId always produces same style + same seed, so retake-on-failure produces identical output. Documented design choice ("for reproducible covers on retake"). The retake flow in this codebase regenerates the *audio* under a new jobId, so the cover also changes.

If user wants a different cover for the same song-jobId, they'd need to DELETE the song and regen — at which point a new jobId is minted. Acceptable for the home use case.

Refs: `pollinations.ts:115-120`, `cover-jobs.ts:106-114`.

---

## 9. CSP — **LOW** (image.pollinations.ai redundant)

`index.ts:65` lists `https://image.pollinations.ai` and `https://gen.pollinations.ai` in `connectSrc`. Cover bytes are fetched server-side (Node `fetch`, not browser), so the browser-side `connectSrc` only matters for whatever `client.ts` calls directly.

Looking at the code, the client probably only hits `/api/...` endpoints (the server proxies to Pollinations). If the client ever calls `gen.pollinations.ai/models` directly for the model picker, that needs `gen.pollinations.ai` in `connectSrc`. `image.pollinations.ai` is the legacy host and is referenced nowhere in this commit set (only `gen.pollinations.ai`). Keep for safety, but it's redundant.

No fix.

Refs: `index.ts:65`, `pollinations.ts:21`.

---

## 10. `fetchCoverImage` legacy path — INFO (verified)

When `pol === undefined`, the function skips the Pollinations branch entirely (line 96 condition is false) and falls through to picsum at line 119. The status-poll always calls `fetchCoverImage(songId, undefined)` at line 605, so the picsum fast-path is the only path that fires from the audio-gen flow.

Verified: `routes/generate.ts:605` always passes `undefined`. The Pollinations branch in `fetchCoverImage` is therefore unreachable from this codebase post-refactor.

Refs: `id3-tagger.ts:91-131`, `routes/generate.ts:605`.

---

## 11. `fromPollinations` flag is dead — **MEDIUM**

`fetchCoverImage` returns `{ buffer, mimeType, fromPollinations?: boolean }`. The flag is set to `true` on line 110 when Pollinations succeeds. **Nothing reads it.** Grep confirms: zero consumers of `.fromPollinations` in the codebase post-refactor.

This is fallout from the old design where `fetchCoverImage` would do both ID3 + cover-gen and the caller would conditionally persist the buffer to disk if `fromPollinations`. Now cover-gen lives in `cover-jobs.ts` and `fetchCoverImage` is only called with `pol=undefined` for the picsum fast-path.

```diff
 export async function fetchCoverImage(
   songId: string,
   pol?: PollinationsCoverConfig
-): Promise<{ buffer: Buffer; mimeType: string; fromPollinations?: boolean } | undefined> {
+): Promise<{ buffer: Buffer; mimeType: string } | undefined> {
   // Try Pollinations first when the user opted in and supplied a model.
   if (pol && pol.enabled && pol.model && pol.prompt) {
     // ...
-    if (result) {
-      return { buffer: result.buffer, mimeType: result.mimeType, fromPollinations: true };
-    }
+    if (result) return { buffer: result.buffer, mimeType: result.mimeType };
```

Plus: the entire Pollinations branch inside `fetchCoverImage` (lines 95-114) is now dead — no caller passes a defined `pol`. Either rip the branch out or delete the `pol?` parameter and the import of `generatePollinationsCover`/`songIdToSeed` at the top of `id3-tagger.ts`. The `PollinationsCoverConfig` interface itself is still consumed by `routes/generate.ts:537` for typing — keep that export, drop only the cover-gen branch.

Refs: `id3-tagger.ts:1-2,91-114`, `routes/generate.ts:25,605`.

---

## 12. MP3 ID3 contains picsum, not Pollinations cover — INFO (documented trade-off)

`fetchCoverImage(songId, undefined)` on line 605 → picsum bytes embedded in MP3 ID3. Pollinations cover lands later as a separate JPEG on disk + DB `cover_url`. Downloaded MP3 file has the picsum thumbnail; the in-app UI renders the Pollinations cover from `cover_url`.

Trade-off: re-tagging the MP3 with the Pollinations cover after `attachCover` would require:
- re-downloading the MP3 from storage (or holding the buffer in memory across the async cover-gen wait)
- re-running `tagMp3Buffer`
- re-uploading to storage (overwriting the same key)

For the home app this is acceptable. If the user cares, they can right-click → "use cover" or similar in any tag editor.

Could be addressed by storing the post-INSERT MP3 buffer in a small LRU keyed by songId until cover gen finishes (memory: ~5MB × N pending jobs). Not a priority.

Refs: `routes/generate.ts:602-617,713-725`, `id3-tagger.ts:62-68`.

---

## 13. Test coverage gaps — **MEDIUM**

`cover-jobs.test.ts` (190 lines) covers:
- idle → pending → ready
- failed (undefined response, thrown error)
- idempotency (same jobId returns same entry)
- consume removes from map
- awaitCoverWithTimeout (3 cases)
- config passthrough (style modifier appended)
- two jobIds → different style
- seedMode 'random' omits seed
- seedMode 'song' derives seed

Missing:
- **Concurrent `startCoverGen` race**: two synchronous calls in same tick → same entry, single underlying gen.
- **Partial-failure retry semantics**: failed entry retained until consume; second `startCoverGen` returns the failed entry (does NOT re-run gen). Confirm this is desired — currently it is, since `if (existing) return existing`.
- **No status-poll integration test**: the chain `poll → startCoverGen → polEntry.promise.then(attachCover) → consumeCoverState` is exercised only at the unit level. A supertest harness on the Express router would catch the cancel-doesn't-consume bug (item 4).

Recommend adding the supertest layer when tackling item 4.

---

## 14. AbortController timeout — INFO (correct)

`pollinations.ts:76-107`: AbortController + 60s setTimeout, returns `undefined` on `AbortError`, `clearTimeout` in `finally`. Caller (`cover-jobs.ts:128`) maps `undefined` to `CoverFailed`. Clean, correct.

---

## 15. Memory pressure — INFO (negligible)

10 concurrent jobs × ~300KB JPEG buffer ref in `jobs` Map = 3MB. Trivial. Confirmed by reading `CoverReady` shape (`buffer: Buffer`).

The leak from items 4 (cancel doesn't consume) and 2 (lost optimistic-lock race) is more concerning over a long-running session — but each entry is bounded at the same ~300KB, so even 100 leaked entries = 30MB. Annoying, not catastrophic.

---

## 16. URL encoding — INFO (correct)

`encodeURIComponent(input.prompt)` correctly encodes spaces, commas, quotes, Cyrillic, %, ?, #. Tested implicitly by the prompt+style concat. No double-encoding issue.

Refs: `pollinations.ts:56`.

---

## Severity Summary

| #  | Severity | Item                                              | Action                            |
|----|----------|---------------------------------------------------|-----------------------------------|
| 1  | INFO     | Concurrency window in `startCoverGen`             | None                              |
| 2  | HIGH     | Re-kickoff after consumeCoverState (narrow window)| Drop `'succeeded'` from kickoff or add consumed-sentinel |
| 3  | MEDIUM   | Storage leak on song-cancel                       | Optional cron sweep               |
| 4  | HIGH     | Cancel routes leak Map entries                    | Add `consumeCoverState` to cancel/cancel-all/reset |
| 5  | LOW      | `awaitCoverWithTimeout` dead import               | Remove import line                |
| 6  | INFO     | Failed-state silently swallowed                   | None                              |
| 7  | INFO     | URL length within limits                          | None                              |
| 8  | INFO     | songIdToSeed deterministic                        | None                              |
| 9  | LOW      | image.pollinations.ai redundant CSP entry         | None                              |
| 10 | INFO     | Picsum fallback verified                          | None                              |
| 11 | MEDIUM   | `fromPollinations` flag + dead Pollinations branch in `fetchCoverImage` | Strip dead branch + flag |
| 12 | INFO     | MP3 contains picsum, on-disk cover is Pollinations| Documented trade-off              |
| 13 | MEDIUM   | Test gaps (concurrent kickoff, cancel, integration) | Add tests when fixing #4        |
| 14 | INFO     | AbortController correct                           | None                              |
| 15 | INFO     | Memory pressure negligible                        | None                              |
| 16 | INFO     | URL encoding correct                              | None                              |

**Counts:** 0 CRITICAL · 2 HIGH · 3 MEDIUM · 2 LOW · 9 INFO. **Total: 16 findings.**

**Top fixes (must-fix before next release):**
1. **#4** — Cancel routes leaking Map entries (memory leak, multi-session).
2. **#2** — Drop `'succeeded'` from the kickoff condition (or sentinel).
3. **#11** — Strip the dead Pollinations branch from `fetchCoverImage` (clarity).

**Nice-to-have:** **#5** drop unused import; **#13** add cancel/integration tests.
