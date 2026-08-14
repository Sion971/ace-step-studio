# Round-2 Local-LLM Path Regression Review (post-fix verification)

Scope: verify the 7 findings from `docs/reviews/2026-05-05-agent01-local-llm.md` (round-1) and hunt for new regressions in commits `bfc0e7527`, `ea73c3c98`, `10a87ab0e`, `2419f7d73`.

Verification corpus: `App.tsx`, `CreatePanel.tsx`, `app/server/src/routes/generate.ts`, `app/server/src/services/id3-tagger.ts`, `app/server/src/services/cover-jobs.ts`, `app/services/llm/openrouter.ts`, `app/services/llm/partialJson.ts`, `app/services/llm/prompts/system_generate.en.md`, `app/services/llm/prompts/system_format.en.md`, `app/services/api.ts`.

---

## 1. Verification of prior findings

| # | Severity | Status | Evidence |
|---|----------|--------|----------|
| 1 | MUST | ✅ FIXED | `decrementPendingClicks(1)` added at `app/App.tsx:1067` (commit `ea73c3c98`). The createSample inner-catch now releases the slot before `return`. |
| 2 | MUST | ✅ FIXED (Option A as recommended) | `app/services/llm/openrouter.ts:296-298` — defaults `(draft as any).coverPrompt = ''` if missing/non-string before the strict REQUIRED_FIELDS loop. Old custom system prompts stop tripping `INVALID_JSON`. |
| 3 | SHOULD | ✅ FIXED | `app/services/llm/partialJson.ts:5,9` — `coverPrompt` now in both `SONG_FIELDS` and `STRING_FIELDS`. |
| 4 | SHOULD | ✅ FIXED | `app/services/llm/prompts/system_generate.en.md:364` "All 9 fields present (incl. `coverPrompt`)?" + few-shot examples 1–4 (lines 395, 415, 435, 455) all carry realistic `coverPrompt`. `system_format.en.md:373,415,447` — same change for the format prompt's 2 examples. |
| 5 | NIT | ❌ NOT FIXED | `App.tsx:1038-1042` — `createSample` still doesn't forward `lmTemperature`. Out-of-scope for the batch fixes (NIT). |
| 6 | NIT | ❌ NOT FIXED | `CreatePanel.tsx:1766` — `lmModel: 'acestep-5Hz-lm-0.6B'` still hardcoded for simple mode. Out-of-scope (NIT). |
| 7 | NIT | 🟡 PARTIAL | `(params as any)._tempId` cast at `App.tsx:1169` still present. Batch-3 commit message claimed "_tempId added to GenerationParams type (api.ts)" but the actual diff only modified `id3-tagger.ts` — `api.ts:279-390` still does not declare `_tempId`, `dcwEnabled`, `flowEdit*`, `retake*`, `loraLoaded`, `prompt`. The `as any` tunnel and the trailing `} as any, token)` cast at `App.tsx:1170` keep runtime intact, but the typing claim is unrealized. |

Additional supporting fixes from batch 1 that are in-scope for round-1 findings:

- **App.tsx whitelist (15 missing fields)**: verified at `App.tsx:1149-1169`. Each field listed in `CreatePanel.tsx:1627-1739` (custom mode `customPayload`) and `:1740-1772` (simple-mode payload) is reflected. Local-LM users in custom mode now ship `dcwEnabled / dcwMode / dcwScaler / dcwHighScaler / dcwWavelet / retakeSeed / retakeVariance / flowEditMorph / flowEditSourceCaption / flowEditSourceLyrics / flowEditNMin / flowEditNMax / flowEditNAvg / loraLoaded / prompt / openrouterModel / pollinations / _tempId` in the request body.
- **`writingLyricsAndStyle` i18n key, not resolved string**: verified at `App.tsx:1037`. SongList does `t(song.stage)` so the bare key now translates dynamically. Key exists in all 5 locale files.
- **Chain firewall `.catch(() => null).then(...)`**: verified at `CreatePanel.tsx:1543`. Local-LM scope **untouched** — the entire block is gated by `!customMode && useOpenRouter && !activeLmModel` (`CreatePanel.tsx:1536`). When `activeLmModel !== ''` the firewall path is dead — no impact on local-LM users.
- **`cancel-all` consumes cover state**: verified at `routes/generate.ts:824` (cancel-all), `:795` (single cancel), `:852` (reset). For local-LM users with Pollinations OFF, no cover entry exists (cover-gen kickoff at `:533-552` is gated on `pol?.enabled && pol.model && pol.prompt`), so the new query+loop is a no-op for them. ✅
- **`cancelAllGenerations` (frontend)**: verified at `App.tsx:830-832` — calls `drainQueueWaiters()` and `setPendingClickCount(0)`, unblocking parked pre-flights and zeroing the badge.

---

## 2. New regressions found

### 🟡 LOW — Cover-state Map can be resurrected after `consumeCoverState` (cancel race)

**File:** `app/server/src/services/cover-jobs.ts:101-153`

**Path:** Local-LM user with Pollinations ON. User cancels mid-generation. Sequence:
1. `/cancel-all` deletes the Map entry via `consumeCoverState(jobId)` (`routes/generate.ts:824`).
2. The fire-and-forget Promise inside `startCoverGen` is still running.
3. Pollinations resolves/rejects → the Promise's body executes `jobs.set(jobId, result)` at line 134, 143, or 151 — re-creating the entry.
4. Nothing ever consumes the resurrected entry: the song row is already `failed`, the status poller won't fire `succeeded`-branch attach. The Map entry leaks until process restart.

**Severity:** LOW. JobIds are UUIDv4 (no key collision), so leak is bounded by `(cover-cancel-races) × ~1MB-per-CoverReady`. Each cover image is 1024×1024 JPEG (~150-300 KB). Realistic worst case: a user spam-cancels 100 jobs with covers nearly done = 30 MB stuck in V8 heap until restart.

**Pre-existing comparison:** Before batch 1, the Map leaked on EVERY cancel (no `consumeCoverState` call existed). Net: large improvement, but the race window remains.

**Fix (unified diff):**

```diff
--- a/app/server/src/services/cover-jobs.ts
+++ b/app/server/src/services/cover-jobs.ts
@@ -78,9 +78,15 @@ export function getCoverState(jobId: string): CoverEntry | undefined {
 }

 /** Drop the entry once consumer has handled it. */
 export function consumeCoverState(jobId: string): CoverEntry | undefined {
   const e = jobs.get(jobId);
   jobs.delete(jobId);
+  // Mark this jobId as cancelled so the in-flight Promise inside startCoverGen
+  // (which runs `jobs.set(jobId, result)` on completion) skips its set when
+  // the user has cancelled. Without this, the Map entry can be resurrected
+  // after we deleted it, leaking ~150-300KB-1MB per cancelled cover.
+  cancelledJobs.add(jobId);
+  // Auto-evict the cancelled marker after 5 min so it doesn't grow unbounded.
+  setTimeout(() => cancelledJobs.delete(jobId), 5 * 60_000).unref?.();
   return e;
 }

+const cancelledJobs = new Set<string>();
+
 /**
  * Start cover gen for a jobId. Idempotent — re-calling for the same jobId
  * returns the existing entry.
@@ -127,7 +133,7 @@ export function startCoverGen(
       });
       if (!r) {
         const result: CoverFailed = {
           state: 'failed',
           reason: 'pollinations returned undefined (timeout/error)',
           finishedAt: Date.now(),
         };
-        jobs.set(jobId, result);
+        if (!cancelledJobs.has(jobId)) jobs.set(jobId, result);
         return result;
       }
       const result: CoverReady = {
@@ -141,7 +147,7 @@ export function startCoverGen(
         mimeType: r.mimeType,
         finishedAt: Date.now(),
       };
-      jobs.set(jobId, result);
+      if (!cancelledJobs.has(jobId)) jobs.set(jobId, result);
       return result;
     } catch (e: any) {
       const result: CoverFailed = {
@@ -149,7 +155,7 @@ export function startCoverGen(
         reason: String(e?.message || e),
         finishedAt: Date.now(),
       };
-      jobs.set(jobId, result);
+      if (!cancelledJobs.has(jobId)) jobs.set(jobId, result);
       return result;
     }
   })();
```

Out-of-scope alternative: a cooperative `AbortController` threaded through `generatePollinationsCover` would also kill the request itself, saving Pollinations bandwidth.

### 🟡 LOW — Backend `/api/generate` POST destructure still drops 14 fields (pre-existing, but exposed by the new whitelist)

**File:** `app/server/src/routes/generate.ts:300-374` (destructure), `:386-460` (params object built).

The App.tsx whitelist correctly forwards `dcwEnabled, dcwMode, dcwScaler, dcwHighScaler, dcwWavelet, retakeSeed, retakeVariance, flowEditMorph, flowEditSourceCaption, flowEditSourceLyrics, flowEditNMin, flowEditNMax, flowEditNAvg, loraLoaded, prompt, _tempId` — but the backend `req.body` destructure does **not** name any of them. They go into `req.body` but never make it into the persisted `params` blob (which is the snapshot used by the Pollinations cover-prompt fallback at `generate.ts:537-552` and by `generateMusicViaAPI(params)` at `:479`).

**Status:** **Pre-existing**, NOT a new regression — verified by checking `git show 4337c40f7:app/server/src/routes/generate.ts` (the upstream sync commit before any of the round-2 work). The destructure was already incomplete in October 2024. The whitelist fix in App.tsx merely makes the front-end side correct; the back-end gap is untouched.

**Out of scope for round-2** (it was not flagged in round-1 either — it's a pre-existing back-end issue that agent10 may have hinted at but agent01 didn't own). Flagging here so it's not lost.

### ✅ NO REGRESSIONS in MUST/HIGH/SHOULD-fix code paths.

Specifically verified clean:

- **id3-tagger picsum-only path**: `_pol` arg ignored, picsum still fetched, embed still happens (`id3-tagger.ts:92-109`). MP3 tag image survives for local-LM + Pollinations-OFF users. ✅
- **Cover-gen kickoff dropped `'succeeded'` branch** (`generate.ts:534`): no double-fire. The "missed transition" rationale (audio takes 30s, poll every 2s) is sound.
- **Chain firewall in `CreatePanel.tsx:1543`**: gated to OR-only, doesn't touch local-LM clicks.
- **`drainQueueWaiters()` + `setPendingClickCount(0)` in `cancelAllGenerations`** (`App.tsx:830-832`): correctly wired. Verified `drainQueueWaiters` is in the dep array and `setPendingClickCount` is the same setter as `incrementPendingClicks` / `decrementPendingClicks`.
- **`insertedSongIds.push(songId)` in fallback INSERT** (`generate.ts:703`): cover attach loop now also runs UPDATE on download-failed song rows.

---

## 3. End-to-end mental simulation

### Scenario A — Простой + local LM 0.6B + Pollinations OFF + bulk=1

1. Click "Создать". `CreatePanel` calls `incrementPendingClicks(1)` (badge: 1/1).
2. `customMode=false, useOpenRouter=false, activeLmModel='acestep-5Hz-lm-0.6B'` → the OR-pre-flight block at `CreatePanel.tsx:1536` is skipped (third condition `!activeLmModel` is false).
3. `onGenerate(...)` fires → `App.tsx:handleGenerate`. `_tempId` set, placeholder card already exists (created in CreatePanel before onGenerate).
4. Inner createSample runs (LLM ready) → `setSongs` updates stage to `'writingLyricsAndStyle'` (i18n key).
5. `enrichedParams` filled, `startGeneration` POSTs body to `/api/generate`. Backend persists `params` (without `pollinations` since it's `{ enabled: false }`).
6. `decrementPendingClicks(1)` at `App.tsx:1178` (badge: 0/1) → handoff to active counter. Badge stays at 1 until job completes (active counter).
7. Job runs. Status poll. Cover-gen kickoff at `generate.ts:533-552` checks `pol?.enabled && pol.model && pol.prompt` — `pol = { enabled: false }` so `pol.model && pol.prompt` is undefined → kickoff skipped.
8. Job succeeds → INSERT song with `cover_url = null`. `insertedSongIds = [songId]`. `getCoverState(jobId)` returns undefined → attach loop skipped.
9. MP3 has picsum thumbnail in ID3 (`generate.ts:608` calls `fetchCoverImage(songId, undefined)` → picsum branch).
10. UI: `song.cover_url = null` → SongList renders the deterministic gradient cover. ✅

**Counter trace**: 0 → 1 (incr at click) → 0 (handoff after startGeneration succeeds) → 0 (no further changes; active counter shows job until completion). Clean.

### Scenario B — Простой + local LM + Pollinations OFF + bulk=10

1. `incrementPendingClicks(10)` → badge 10/10.
2. Loop spawns 10 placeholder cards + 10 `onGenerate` calls (sequential — no Promise.all in CreatePanel:1627 loop body, but fire-and-forget — the `await` is on the outer try).
3. Each `App.tsx:handleGenerate` call runs createSample (LLM serializes server-side: createSample takes ~1-3s each), then `startGeneration` (~50ms HTTP), then `decrementPendingClicks(1)`. 
4. After 10 successful cycles: badge 0/10.
5. Active counter (`activeJobsRef`) tracks 10 polls. Each completes, removes from active.

**Counter trace**: 0 → 10 → 9 → 8 → ... → 0. Clean.

**Caveat**: if createSample fails on one of the 10 mid-loop, that path's `decrementPendingClicks(1)` (line 1067) fires, releasing that slot. Other 9 unaffected. ✅

### Scenario C — Custom mode + local LM + Pollinations ON

1. `incrementPendingClicks(1)`, click handler dispatches `onGenerate({ customMode: true, pollinations: { enabled: true, model, prompt, ... }, ... })`.
2. `App.tsx:handleGenerate` skips `createSample` (customMode=true).
3. `startGeneration` POSTs the body including `pollinations`.
4. Backend stores in `params`. Job goes queued → running.
5. First `running` poll at `generate.ts:533-552` → `pol.enabled && pol.model && pol.prompt` all truthy → `startCoverGen(jobId, polCfg)` fires. Map entry pending.
6. Audio finishes → `succeeded` poll. `polEntry = getCoverState(jobId)` = pending. INSERT song row with `cover_url = null`. `attachCover` registered as `polEntry.promise.then(...)`.
7. Pollinations resolves → buffer uploaded → UPDATE songs SET cover_url. `consumeCoverState(jobId)` in `.finally()` drops Map entry. ✅

### Scenario D — Cancel mid-generation (local-LM)

1. User clicks cancel. Frontend hits `/cancel/:jobId`.
2. Backend: `cancelJob(jobId)` (acestep queue) → `consumeCoverState(jobId)` (Map drop) → `UPDATE generation_jobs SET status='failed'`.
3. Song row stays in `generation_jobs` with `status='failed'`. No song INSERT happened (didn't reach the `succeeded` branch).
4. **Map leak edge case** flagged in §2: if cover-gen Promise was in-flight, it will resurrect the Map entry on completion. Frontend impact: none (no consumer reads it). Memory impact: ~300KB per race. Tracked as 🟡 LOW.

---

## Net assessment

**Round-1 fixes landed cleanly.** All 2 MUST and both SHOULD findings are correctly addressed in `ea73c3c98` + `10a87ab0e`. The recommended Option A for MUST-2 was applied (tolerate-missing rather than schema-strip). Few-shot examples and self-check both updated. The local-LM core paths (Простой+local-LM, Custom+local-LM, AI Generate/Format buttons with local-LM available) are functional with no new breakage.

The 3 NIT findings are unaddressed (out of scope for the surgical batches by design).

**One genuinely new minor regression**: the `consumeCoverState` race in `cover-jobs.ts` — fix introduced a smaller leak inside the larger leak it closed. Net win, but worth a follow-up commit.

**One pre-existing issue surfaced (not a regression)**: backend `/api/generate` destructure drops 14 of the 15 newly-whitelisted custom-mode fields. App→server payload widening must be paired with server-side destructure widening to actually reach Gradio.

**Path:** `D:\Projects\TEMP\ACE-Step-Studio\docs\reviews\2026-05-05-r2-agent01-local-llm.md`

| Category | Count |
|----------|-------|
| FIXED | 4 |
| PARTIAL | 1 |
| NOT-FIXED | 2 |
| NEW-REGRESSIONS | 1 (LOW) |
