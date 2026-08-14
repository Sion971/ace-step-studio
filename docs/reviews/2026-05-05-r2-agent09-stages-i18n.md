# Agent 09 — Round 2 review (stages, i18n, song-card status display)

**Scope:** master HEAD = `2419f7d73`. Re-audit after fix commits `ea73c3c98`, `10a87ab0e`, `2419f7d73`.
**Prior:** `docs/reviews/2026-05-05-agent09-stages-i18n.md`.
**Build:** `app/ npm run build` → green, 2.20s, `dist/assets/index-Ce3uV6nd.js` 1,505.16 kB / gzip 380.90 kB. Same chunk-size warning as round 1, no new errors.

---

## A. Verification of fixes claimed in commit messages

### A.1 App.tsx ~line 1028 (now 1037): `t('writingLyricsAndStyle')` → `'writingLyricsAndStyle'` — VERIFIED

`app/App.tsx:1037`:
```ts
setSongs(prev => prev.map(s => s.id === tempId ? { ...s, stage: 'writingLyricsAndStyle' } : s));
```
Comment at L1034-1036 explicitly documents the rationale (mid-generation language switch). The previous form `t('writingLyricsAndStyle') || 'Writing lyrics & style...'` is gone. **PASS.**

`writingLyricsAndStyle` key is defined in all five locales (`en/ru/zh/ja/ko`), so `t(song.stage)` in SongList resolves correctly. **PASS.**

### A.2 All other stage assignments use bare keys — VERIFIED for the new code path

Inventory of every `stage:` write site in `app/`:

| file:line | value | category |
|---|---|---|
| `App.tsx:129` (`createTempSongForClick`) | `'stageWaitingInQueue'` | i18n key ✓ |
| `App.tsx:780` (`cancelGeneration`) | `'cancelled'` | **raw literal — not addressed** |
| `App.tsx:938` (poll tick) | `newStage` from `status.stage` (backend free-form) | pre-existing, not addressed |
| `App.tsx:1008` (preCreatedId promotion) | `'stageStartingTrack'` | i18n key ✓ |
| `App.tsx:1037` (LLM pre-flight start) | `'writingLyricsAndStyle'` | i18n key ✓ |
| `CreatePanel.tsx:1549` (bulk OpenRouter) | `'stageGeneratingTextOpenRouter'` | i18n key ✓ |
| `server/.../acestep.ts:854` | server-side passthrough | n/a |
| `server/.../generate.ts:759,774` | server-side passthrough | n/a |

`createTempSongForClick` (L116-135): writes `'stageWaitingInQueue'` only. **PASS.**

`preCreatedId` promotion path in `handleGenerate` (L995-1027): when an instant-card was pre-created, the song row is patched with `stage: 'stageStartingTrack'` (L1008) just before the LLM pre-flight. Then if LLM is needed (`!params.customMode && songDescription && token`), L1037 overwrites with `'writingLyricsAndStyle'`. After LLM completes, code falls through to the API call but does NOT set a "stageGeneratingTrack" before `generateApi.createSong` — the next stage label only arrives via the poll tick (L938 reads `status.stage` from backend). Briefly the card displays the `'writingLyricsAndStyle'` (or `'stageStartingTrack'` for custom mode) until the first poll tick (~2s). Acceptable.

### A.3 `SongList` rendering pattern — UNCHANGED, still `t(song.stage) || song.stage` — VERIFIED

`SongList.tsx:677` and `:832` both use:
```tsx
t(song.stage) || song.stage || t('creating') || 'Creating...'
```
identical to round 1. The dead-fallback discussion from round 1 §3 still applies (since `t()` returns the key itself on miss, the `|| song.stage` arm is unreachable for known keys; only fires when `song.stage === undefined`). Not addressed in fix batches. **Severity: low (pre-existing, cleanup only).**

### A.4 `'cancelled'` literal stage — STILL RAW, NOT ADDRESSED

`App.tsx:780`, `SongList.tsx:424`, `SongList.tsx:843` — all three sites unchanged from round 1.

Round 1 §4 flagged this as **medium** (mixed convention: i18n keys for normal stages, raw English string `'cancelled'` for cancel state). Fix batches 1/2/3 did not touch any of those lines. **Still flagged.** Recommendation unchanged: rename to `'stageCancelled'` and add 5 locale entries, or split into `Song.isCancelled` flag.

User-visible impact remains zero (the actual visible text is `t('cancelGeneration')` which is translated), but the stage discriminator is still a hidden English literal — a future i18n contributor will assume `stage` is always a translation key and either drop the special-case or break it.

### A.5 `tags: ['queued' | 'custom' | 'simple']` — UNCHANGED, PRE-EXISTING

`App.tsx:130 tags: ['queued']`, `App.tsx:1007 tags: params.customMode ? ['custom'] : ['simple']`, `App.tsx:1021` same. Not touched by the fix batches. Not in scope of this round (round 1 §6 marked low/pre-existing). **Confirmed unchanged.**

### A.6 `stageGeneratingCover` setter — STILL ABSENT

Frontend grep for `'stageGeneratingCover'` returns hits only in the i18n files (5) plus this and the round 1 review. **Zero setters in any `.ts/.tsx` outside i18n.** Cover gen for Pollinations runs server-side via `cover-jobs.ts` (background, non-blocking); the song card transitions `stageGeneratingTrack` → succeeded → eventual cover swap on next list refresh. The i18n key is defined in 5 locales but unused at runtime. **Acceptable per prompt (server-side flow), flagged as documented dead key.**

To wire it up later: backend would need to expose `cover_status` per song row, frontend poller writes `stage: 'stageGeneratingCover'` while it's `generating`. Out of scope for this round.

---

## B. Multi-locale mental simulation

### B.1 `locale=ru`, click "Создать" (Простой mode + OpenRouter)

1. Click handler in `CreatePanel` calls `createTempSongForClick` → row appears with `stage: 'stageWaitingInQueue'` → SongList shows **"Ожидает в очереди…"** (ru.ts:137).
2. CreatePanel runs OpenRouter pre-flight (bulk path, L1549) → patches `stage: 'stageGeneratingTextOpenRouter'` → **"Пишу текст через OpenRouter…"** (ru.ts:138).
3. Returns to `handleGenerate`. `preCreatedId` branch fires → `stage: 'stageStartingTrack'` → **"Запускаю трек…"** (ru.ts:139).
4. If Простой path (which `App.tsx:1032` re-runs `createSample` if `!customMode && songDescription && token`) — sets `stage: 'writingLyricsAndStyle'` → **"Пишу текст и стиль…"** (ru.ts has this key with the legacy `...` ellipsis).
5. `generateApi.createSong` returns; first poll tick replaces `stage` with backend `status.stage` (free-form Python: `loading`, `Step 5/12`, etc.) → user sees **raw English** (or whatever Python emits). Pre-existing issue (round 1 §5).
6. On `succeeded`, the temp row is replaced by the real song row. Visible label flow OK except step 5.

Note: in the OpenRouter-bulk path (CreatePanel.tsx:1549) the LLM call is the OpenRouter one and the `stageGeneratingTextOpenRouter` label fits. In `handleGenerate`'s legacy fallback (App.tsx:1037), the call is the local `/api/generate-sample` (Gradio backend, not OpenRouter), so `'writingLyricsAndStyle'` is more accurate than `'stageGeneratingTextOpenRouter'` — the labels are correctly differentiated by code path.

### B.2 Mid-generation locale switch (ru → en)

Since SongList renders `t(song.stage)`, and `t` reads `translations[language][key]`, switching `language` re-renders all songs immediately with the new locale. Stage rows showing `'stageWaitingInQueue'` flip from "Ожидает в очереди…" to "Waiting in queue…". **PASS** for all 5 keys.

The Python free-form stage from poll tick remains as-is (raw Python text), unchanged across locales. Pre-existing, round 1 §5.

The `'cancelled'` literal — also unchanged across locales. Visible text uses `t('cancelGeneration')` so it does flip; the stage discriminator `'cancelled'` is invisible plumbing. **No user-visible bug.**

### B.3 `locale=zh` parity check

`zh.ts` lines 135-139:
```ts
stageWaitingInQueue: '在队列中等待…',
stageGeneratingTextOpenRouter: '通过 OpenRouter 生成文本…',
stageStartingTrack: '启动音轨…',
stageGeneratingTrack: '生成音轨…',
stageGeneratingCover: '生成封面…',
```
All 5 keys present, properly translated, Unicode `…`. **PASS.** Same coverage in `ja.ts`, `ko.ts`, `en.ts`, `ru.ts` (round 1 confirmed).

`writingLyricsAndStyle` legacy key — present in all 5 locales (round 1 spot-check + this round's grep over `app/i18n/`). Resolves to "Writing lyrics & style…" / "Пишу текст и стиль…" / etc. **PASS.**

---

## C. New regressions introduced by the fixes

Inspected diff scope of each fix commit:

- `ea73c3c98 (batch 1)` touched `App.tsx`, `CreatePanel.tsx`, `generate.ts`, `openrouter.ts`, `partialJson.ts` plus reviews. Stage-related changes: only the L1037 key fix. **No regression.**
- `10a87ab0e (batch 2)` touched `CreatePanel.tsx`, `PollinationsPanel.tsx`, prompt `.md` files. No stage/i18n changes. **No regression.**
- `2419f7d73 (batch 3)` touched `id3-tagger.ts` (server, dropped Pollinations dead branch) + `api.ts` (`_tempId` typed). No frontend stage/i18n changes. **No regression.**

The whitelist expansion in `App.tsx:1144-1170` (15 fields including `_tempId`) is unrelated to stage/i18n; verified it does not collide with the `stage` key path.

`_tempId` was added to `GenerationParams` in `api.ts` per batch 3 commit message — removes the `as any` cast at App.tsx:1170. Confirms the preCreatedId promotion path is no longer using a tunnel.

---

## D. Findings table

| # | finding | status after R2 | severity |
|---|---|---|---|
| A.1 | `'writingLyricsAndStyle'` key fix at App.tsx:1037 | **fixed** | none |
| A.2 | Other stage writes use bare keys (5 sites verified) | confirmed | none |
| A.3 | SongList `t(song.stage) || song.stage` pattern with dead-fallback tail | unchanged from R1 | low (pre-existing) |
| A.4 | `'cancelled'` raw literal — mixed convention | **NOT addressed** | medium (carry-over) |
| A.5 | `tags: ['queued'/'custom'/'simple']` raw | unchanged from R1 | low (pre-existing) |
| A.6 | `stageGeneratingCover` defined, no setter (server-side cover flow) | unchanged, acceptable per prompt | low (SHOULD) |
| B.1 | ru flow renders 4 distinct stage labels correctly | verified | none |
| B.2 | Mid-generation language switch re-translates stage labels | verified | none |
| B.3 | zh has all 5 stage* keys | verified | none |
| C | No new regressions from `ea73c3c98 / 10a87ab0e / 2419f7d73` | verified | none |
| build | `app/ npm run build` green, 1505.16 kB / 380.90 kB gzip, 2.20s | verified | none |

**Counts:** 11 findings inspected; 1 fix verified (A.1); 5 carry-over confirmed unchanged (A.3, A.4, A.5, A.6 + Python free-form stage from R1 §5); 4 multi-locale flow checks pass; 0 new regressions; build green.

**Top remaining gap:** A.4 — `'cancelled'` is still a raw English literal masquerading as a stage value. R1 §4 recommendation stands (rename to `'stageCancelled'` + 5 locale entries, OR split to `Song.isCancelled: boolean`). Fix not attempted in any of the three batches.
