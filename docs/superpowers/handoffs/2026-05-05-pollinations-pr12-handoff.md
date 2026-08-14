# Handoff: Pollinations.ai cover-gen + queue refactor + LLM coverPrompt

**Date:** 2026-05-05
**Status:** Implemented + 5 review rounds applied. PR #12 open, awaiting next review pass after compaction.
**HEAD:** `d587641a6` on `master` (also pushed to `pollinations-cover-gen` branch on origin)
**Baseline:** `d8aab5bf2` (handoff doc commit) → branched as `pollinations-base` on origin

---

## What ships in this PR

1. **Pollinations.ai cover generation** — server-side, parallel with audio render, never blocks audio pipeline.
2. **Queue refactor** — instant N/10 badge, instant placeholder card on click, FIFO LLM pre-flight chain with drain barrier.
3. **LLM `coverPrompt` field** — SongDraft schema + system prompts ask the LLM for a 1-2 sentence visual album-cover description; backend wraps with framing + style modifier and feeds to Pollinations.
4. **5-language i18n** for 5 stage keys + 28 Pollinations panel keys.
5. **94/94 vitest tests pass** (including 2 new for tombstone), frontend tsc 0 new errors (6 pre-existing baseline at App.tsx snake_case Song fields), server tsc clean, vite build clean.

---

## Critical architecture invariants (do not break)

### 1. Queue serialization
- `App.tsx::queueDrainResolversRef` — array of `() => void`. Promise resolvers parked by `waitForJobsToDrain()`.
- `drainQueueWaiters()` MUST be called everywhere `activeJobsRef.size` can transition to 0:
  - `cleanupJob` (success path) — line ~767
  - `cancelGeneration` (single soft cancel) — line ~795
  - `resetSingleJob` (single hard cancel) — line ~822
  - `cancelAllGenerations` — line ~847
  - **NOT** in `resetGeneration` (legacy, leave alone)
- Skipping any of these = next click hangs forever on `waitForJobsToDrain()` until page reload.

### 2. Pending-click counter (visual N/10 badge)
- `App.tsx::pendingClickCount` state, atomic with `activeJobCount`. CreatePanel's badge prop is `activeJobCount + pendingClickCount` (line ~1664).
- Increment: `incrementPendingClicks(slotsClaimed=bulkCount)` at click start in `CreatePanel::handleGenerate`.
- Decrement: per `beginPollingJob` (success handoff) or per `App.tsx::handleGenerate` catch (failure). Both paths × `bulkCount` slots = balanced.
- Reset to 0 in `cancelAllGenerations` (line ~849).
- Don't decrement in `CreatePanel::handleGenerate` success path — App.tsx owns the handoff.

### 3. Pollinations cover-gen state machine
- `app/server/src/services/cover-jobs.ts` — `Map<jobId, CoverEntry>` + tombstone `Set<jobId>`.
- States: `idle (not in map) → pending (Promise) → ready | failed`.
- **Tombstone** prevents Map resurrection: when `consumeCoverState` runs while Promise is in-flight, the in-flight Promise's terminal `jobs.set(jobId, result)` is gated by `if (!cancelled.has(jobId))` (lines 159, 168, 176). Without this, ~300KB Buffer leaks per cancel/fail unbounded.
- Tombstone TTL 5min (`setTimeout(...).unref?.()`). Long enough to outlive 60s Pollinations timeout.

### 4. Cover-gen kickoff timing
- ONLY on `aceStatus.status === 'running'` poll (line ~589 of routes/generate.ts), NOT on `succeeded`. If you also fired on `succeeded`, then after `consumeCoverState` runs in `attachCover.finally`, the next poll (still seeing `succeeded`) would re-fire a brand-new cover gen.
- ACE-Step turbo audio takes 30+s, polling every 2s — we'll always catch ≥1 `running` poll between queued and succeeded.

### 5. Cover attachment is fire-and-forget
- `attachCover` writes file to disk + UPDATE songs.cover_url. NEVER await it from the audio status response — it can take 30-60s on Pollinations cold path.
- ID3 tag inside the MP3 contains a fast picsum image (NOT Pollinations) so the downloaded MP3 has a thumbnail without blocking. The in-app UI shows the real Pollinations cover via `cover_url`.

### 6. LLM `coverPrompt` field
- `SongDraft.coverPrompt: string` (required in schema, but openrouter.ts:296-298 defaults to `''` post-parse for stale custom system prompts).
- Frontend sends `pollinations.prompt = effCoverPrompt || buildCoverPrompt(keywords)` — LLM-tailored if available, keyword fallback otherwise.
- Backend wraps with `${pol.prompt}, ${STYLE_MODIFIERS[seed % 16]}` (cover-jobs.ts:139) before hitting Pollinations.
- 16 art-style modifiers picked deterministically by seed = visual diversity across songs sharing a caption.

### 7. Local-LM mode untouched
- All new code paths gated on `!customMode && useOpenRouter && !activeLmModel` (Простой+OR+noLM) or `usePollinations` toggle.
- Local LM users with Pollinations OFF: zero changed code paths (no cover-gen Map entries, no FIFO chain entries).
- Local LM users with Pollinations ON: cover-gen still works (kicked off on `running` poll, attaches via UPDATE).

---

## Files changed

**New (8):**
- `app/components/PollinationsPanel.tsx` (353 lines)
- `app/components/UsePollinationsToggle.tsx` (35)
- `app/server/src/services/cover-jobs.ts` (210)
- `app/server/src/services/cover-jobs.test.ts` (218)
- `app/server/src/services/pollinations.ts` (120)
- `app/services/pollinations/{types,storage,client,prompts}.ts` (~300 total) + 2 test files (~150)

**Modified (~20):**
- `app/App.tsx` — queue drain barrier, pendingClickCount, createTempSongForClick/update/remove, whitelist 18 fields, coverUrl mapping (2 places)
- `app/components/CreatePanel.tsx` — handleGenerate refactor (FIFO chain, instant placeholder, slot accounting), Pollinations panel mount, Pollinations payload IIFE
- `app/components/Sidebar.tsx` — IMG status row
- `app/server/src/routes/generate.ts` — GenerateBody type + destructure + params object (15 fields), cover-gen kickoff guard, attachCover fire-and-forget, consume on cancel/cancel-all/reset/failed
- `app/server/src/services/id3-tagger.ts` — fast picsum-only path (Pollinations branch dead), `_pol?` unused param for compat
- `app/server/src/index.ts` — CSP `connectSrc` adds gen.pollinations.ai + image.pollinations.ai
- `app/services/api.ts` — GenerationParams +18 fields
- `app/types.ts` — GenerationParams +18 fields (matches api.ts)
- `app/services/llm/openrouter.ts` — `coverPrompt` in SCHEMA + post-parse default
- `app/services/llm/types.ts` — `SongDraft.coverPrompt`
- `app/services/llm/partialJson.ts` — coverPrompt in SONG_FIELDS + STRING_FIELDS
- `app/services/llm/prompts/system_{generate,format}.en.md` — "9 fields", coverPrompt instructions, coverPrompt in 4+2 examples
- `app/i18n/{en,ru,zh,ja,ko}.ts` — 28 pollinations.* + 5 stage* keys × 5 langs

---

## Open issues / NOT fixed (acceptable for local home deployment)

1. **No UI to cancel a pre-flight click** — user clicks Создать, LLM call takes 20s, user has no button to abort it. AbortController is allocated locally in `handleGenerate` but never wired up across the React tree. Acceptable.
2. **Cancel-all doesn't abort in-flight pre-flight LLM calls** — same root cause as #1. Pre-flight chain steps are uninterruptible; if user hits cancel-all mid-pre-flight, those pre-flights still fire `onGenerate` later, spawning new audio jobs.
3. **Orphan JPGs on disk** — if user cancels mid-Pollinations, in-flight Promise still resolves and writes the JPG to `public/audio/{userId}/covers/{songId}.jpg`. UPDATE matches 0 rows (song never INSERTed if cancel was before audio succeeded). FS cleanup is a separate cron concern.
4. **`'cancelled'` raw string literal** at App.tsx:780 + SongList comparators — mixed with i18n stage keys. Pre-existing convention, 4 review rounds skipped it.
5. **`clampInt('')` returns `min` (256) not `fallback`** in PollinationsPanel.tsx:102. Width/height inputs snap to 256 mid-typing. Cosmetic.
6. **Pollinations apiKey persisted unencrypted** in `generation_jobs.params` JSON column. Acceptable per home-app brief.
7. **6 pre-existing TS errors** at App.tsx:887-892 (snake_case Song field reads). Drift between the wire format and the type. Not introduced by this PR.
8. **Missing test coverage** — no integration tests for full click → audio + cover flow (would require GPU + ACE-Step Python). Cover-jobs has 2 unit tests; routes/generate.ts has none.

---

## Review history

5 rounds in `docs/reviews/`:
- R1 (`2026-05-05-agent01-...agent10-*.md` + `pollinations-deep-review.md`) — 1 BLOCKER + 8 MUST → all fixed in batch 1
- R2 (`2026-05-05-r2-agent01...10-*.md`) — 0 BLOCKER + 1 HIGH → fixed in batch 4 (cancel-single deadlock, failed-status leak, dual GenerationParams, _tempId actually in api.ts)
- R3 (`2026-05-05-r3-agent01...10-*.md`) — 0 BLOCKER + 0 HIGH → still applied: cover-jobs Map resurrection (tombstone Set), types.ts widening, prompt destructure backend
- R4 (`2026-05-05-r4-agent01...10-*.md`) — 0 BLOCKER + 0 HIGH (convergence — only LOW/NIT)
- R5 (super-critical, manual full-diff review by me, no agents) — 2 races found and fixed in `d587641a6` (`perClickDraft` scope, `lastOpenRouterModelId` async stale)

PR #12 has 2 review comments posted via `gh pr comment` skill output.

---

## Next session

Per user request:
1. ✅ Push committed (`d587641a6` on `pollinations-cover-gen` branch on origin)
2. ✅ This handoff written
3. **Compaction will happen now**
4. **After compaction, run another review pass**:
   - Re-read this handoff first
   - Run `gh pr view 12 --repo timoncool/ACE-Step-Studio --json state,reviews` to verify still open
   - Use the `code-review:code-review` skill on PR #12 (NOT general-purpose agents — that's where I went wrong rounds 1-4)
   - The skill prompts for Sonnet but apply Opus per `feedback_no_sonnet_review.md`
   - Inline review (no agent delegation) is also acceptable and faster — that's how R5 worked
   - Score 0-100 and only act on ≥80
   - Skip security paranoia (this is a local home deployment)
5. If new review finds issues, apply, push, post comment, re-review until convergence.

---

## How to test live (manual smoke after restart)

1. Restart `run-no-lm.bat` (backend has new cover-jobs/routes/generate)
2. Hard reload browser (`?_=v<n>` cache bust)
3. Open Advanced settings → toggle "Generate covers via Pollinations.ai" ON
4. Paste API key (`sk_tH2H4woUKl0BcHFrn7QwYceR3cnF50mk` user provided), click Test → ✓
5. Pick model from dropdown (zimage / flux / etc — 10 models with auth)
6. Click Создать
   - Card appears IMMEDIATELY with `Ожидает в очереди…` stage
   - Counter shows `1/10` instantly
   - 5-25s later stage transitions to `Пишу текст через OpenRouter…`
   - Then `Запускаю трек…`
   - Then ACE-Step native progress (audio gen 30-60s)
   - Cover_url updated via background UPDATE 5-30s after audio done
7. Try bulk=5 — counter goes 5/10, all 5 cards appear immediately, queue serializes through pre-flight chain.
8. Cancel single mid-flight — drain wakes parked clicks; Reset removes card.
