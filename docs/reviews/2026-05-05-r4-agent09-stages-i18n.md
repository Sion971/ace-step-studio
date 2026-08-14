# Agent 09 — Round 4 review (stages, i18n, song-card status display)

**Scope:** master HEAD = `0fe60457f` (`fix: R3 review fixes batch 5`).
**Prior:** R1 `2026-05-05-agent09-stages-i18n.md`, R2 `2026-05-05-r2-agent09-stages-i18n.md`, R3 `2026-05-05-r3-agent09-stages-i18n.md`.
**Build:** `cd app && npm run build` → green, 2.22s, `dist/assets/index-DgAYuVNf.js` 1,505.24 kB / gzip 380.90 kB. **Bit-identical to R3 bundle hash** (no UI/runtime delta in this surface). Same chunk-size advisory; no errors.

Batch 5 (`0fe60457f`) touched only `app/App.tsx` (+22/-26), `app/types.ts` (+40/-1), `app/server/src/services/cover-jobs.ts`, `cover-jobs.test.ts`, `app/server/src/routes/generate.ts`, plus 10 R3 review docs. Per the commit message, the changes are: cover-jobs tombstone Set, `GenerationParams` field-set completion (24 lines), `App.tsx` whitelist drops 18 `(params as any)` casts + outer `as any`, `prompt` field added to backend `GenerateBody`. **No file under `app/i18n/` was touched. No `stage:` write-site was renamed.** Stage / i18n surface is unchanged from R3.

---

## A. Verification of carry-over R3 findings

### A.1 `'cancelled'` raw literal — STILL NOT ADDRESSED (4th round)

`App.tsx:787` (line unchanged from R3):

```ts
setSongs(prev => prev.map(s =>
  s.id === jobData.tempId ? { ...s, isGenerating: false, stage: 'cancelled' } : s
));
```

Comparator sites unchanged:
- `SongList.tsx:424`  — `item.song.stage === 'cancelled' && item.song.jobId`
- `SongList.tsx:843`  — `song.stage === 'cancelled' && onResetJob`

Locale grep for `stageCancelled` across `app/i18n/**` and any `.ts/.tsx` — **zero hits**. No `Song.isCancelled` flag was introduced. The R1 §4 / R2 A.4 / R3 A.1 recommendation stands and has now carried over **four rounds** without being touched.

**Severity: medium (carry-over, fourth round).** User-visible impact remains nil — visible label is `t('cancelGeneration')` at SongList.tsx:845, fully translated in all 5 locales. The hidden discriminator stays a raw English literal mixed in among the i18n-keyed `stage*` values. A future maintainer who tightens `Song.stage` to a `StageKey` enum will either break the cancel UX or have to special-case the literal.

Note (unchanged from R3): `'cancelled'` literals in `app/services/llm/types.ts`, `app/services/llm/useOpenRouterGeneration.ts`, `GenerationStatusPanel.tsx` belong to a separate state machine (`OpenRouterGenerationState.kind`) and are out of scope. New in R4 grep: `cover-jobs.ts:120` returns `reason: 'cancelled'` for tombstoned jobs — also a separate state-shape (cover-jobs `state: 'failed'` payload), not Song.stage.

### A.2 Stage write-site inventory — UNCHANGED

| file:line | value | i18n key? |
|---|---|---|
| `App.tsx:129` (`createTempSongForClick`) | `'stageWaitingInQueue'` | ✓ |
| `App.tsx:787` (`cancelGeneration`) | `'cancelled'` | **raw, A.1** |
| `App.tsx:~948` (poll tick `newStage`) | backend free-form `status.stage` | n/a (R1 §5) |
| `App.tsx:1018` (preCreatedId promotion) | `'stageStartingTrack'` | ✓ |
| `App.tsx:1047` (legacy LLM pre-flight) | `'writingLyricsAndStyle'` | ✓ |
| `CreatePanel.tsx:1549` (bulk OpenRouter) | `'stageGeneratingTextOpenRouter'` | ✓ |

Lines 129, 1018, 1047 — verified bit-identical to R3 via `git diff e53909eed..0fe60457f`. Line 1549 in CreatePanel — file untouched in batch 5. **No new write-sites introduced; no existing write-site mutated.** PASS for everything except A.1.

### A.3 SongList `t(song.stage) || song.stage` — UNCHANGED

SongList.tsx untouched in batch 5. Lines 677 / 832 fallback chain identical to R1/R2/R3. Dead-arm discussion from R1 §3 still applies (since `t()` returns the key on miss, the `|| song.stage` arm is unreachable for known keys). Not addressed. **Severity: low (pre-existing, cleanup only).**

### A.4 `tags: ['queued'|'custom'|'simple']` — UNCHANGED

`App.tsx:130`, `:1017`, `:1031` raw English tag literals. Out of scope per R1 §6 / R2 A.5 / R3 A.4. Confirmed unchanged.

### A.5 `stageGeneratingCover` setter — STILL ABSENT

Frontend grep over `app/**/*.{ts,tsx}` returns hits only in the 5 i18n files. Server-side `cover-jobs.ts` flow (now hardened with the R4 tombstone Set) does not surface a stage to the song row. Same as R1/R2/R3. **Acceptable per prompt; flagged dead key.**

---

## B. Hunt for new R4 regressions

### B.1 Diff scope (batch 5) intersected with stage/i18n surface

`git diff --stat e53909eed..0fe60457f -- app/i18n/ app/App.tsx app/components/SongList.tsx app/components/CreatePanel.tsx app/types.ts`:

```
 app/App.tsx  | 48 ++++++++++++++++++++++++-------------------------
 app/types.ts | 41 ++++++++++++++++++++++++++++++++++++++++-
```

- `app/App.tsx` — pure cast-removal pass: `(params as any).foo` → `params.foo` for 18 fields in the whitelist (L1144-1170 region) plus dropping the outer `as any` on the `apiParams` object literal. `git diff … -- app/App.tsx | grep -E '^[+-].*(stage|cancelled)'` returns **empty** — no stage write-site or comparator was touched.
- `app/types.ts` — extended `GenerationParams` with 24 lines: DCW (5), retake/flow-edit (8), `loraLoaded` (1), `_tempId` (1), `pollinations` blob (10). **No change to `Song.stage` typing** (still `stage?: string` in the `Song` interface). No new union, no `StageKey` brand.
- `app/i18n/` — untouched.
- `app/components/SongList.tsx`, `app/components/CreatePanel.tsx` — untouched.
- `app/server/src/routes/generate.ts` — added `prompt` plumbing; `stage: aceStatus.stage` passthrough at L759 unchanged.
- `app/server/src/services/cover-jobs.ts` — tombstone Set added; `consumeCoverState` callers in routes/generate.ts unchanged in semantics for the song.stage surface.

**No stage/i18n surface mutation. No new regression from batch 5.**

### B.2 Build status

```
✓ 2350 modules transformed.
dist/assets/index-DgAYuVNf.js  1,505.24 kB │ gzip: 380.90 kB
✓ built in 2.22s
```

Bundle hash `index-DgAYuVNf.js` is **byte-identical** to R3's output (R3 also reported `index-DgAYuVNf.js  1,505.24 kB / 380.90 kB`). This is the strongest possible evidence that batch 5 is a no-op for emitted JS in the user-facing UI surface (App.tsx cast-removals are erased by esbuild; types.ts is type-only). Server-side `cover-jobs` and `routes/generate.ts` changes don't ship to the browser bundle. **PASS.**

### B.3 Multi-locale mental simulation post-batch-5

Per-locale flow unchanged from R3 §B (which already covered the cancel path post-batch-4). Stage labels in all 5 locales render identically to R3:

- ru: "Ожидает в очереди…" → "Пишу текст через OpenRouter…" → "Запускаю трек…" → "Пишу текст и стиль…" → backend free-form Python text on poll tick.
- en/zh/ja/ko: same key resolution, locale-correct.
- Cancel state: hidden discriminator `'cancelled'`, visible label `t('cancelGeneration')` translated in all 5.
- Mid-generation locale switch: re-renders all `stage*` keys correctly; `'cancelled'` is locale-agnostic plumbing.

Since batch 5 ships zero browser-runtime delta in the SongList/CreatePanel/i18n surface, the R3 simulation transfers verbatim. **No new locale-specific behavior to verify.**

### B.4 Cover-jobs tombstone — does it leak through to song.stage?

Batch 5 added `tombstones: Set<string>` to `cover-jobs.ts`. `startCoverGen` checks the tombstone before firing; `consumeCoverState` adds the jobId to the tombstone Set with a 5-min auto-evict. The state-machine values on the cover-jobs side are `'idle' | 'generating' | 'succeeded' | 'failed'` plus the new `reason: 'cancelled'` payload on failed. **None of these flow back to `Song.stage`** — the cover-jobs result is consumed at `routes/generate.ts` and its `state` ends up shaping the song's `cover_url` / `cover_status` (not exposed to frontend stage), not `stage`. **No interaction with the i18n key surface.**

### B.5 `GenerationParams` extension does not collide with stage

The 24 new fields in `GenerationParams` (DCW, FlowEdit, retake, lora, `_tempId`, pollinations) are all **input** parameters sent to `/api/generate/createSong`. None of them is named `stage`. `Song.stage` lives on `Song`, not `GenerationParams`. `_tempId` flows through to `routes/generate.ts:759` which still emits `stage: aceStatus.stage` from Python. **No collision.**

---

## C. Findings table

| # | finding | status after R4 | severity |
|---|---|---|---|
| A.1 | `'cancelled'` raw literal at App.tsx:787 + 2 SongList comparators | **STILL NOT addressed (4th round)** | medium (carry-over) |
| A.2 | Other stage writes use bare i18n keys (5 sites, line-numbers stable) | confirmed unchanged | none |
| A.3 | SongList `t(song.stage) || song.stage` dead-fallback tail | unchanged | low (pre-existing) |
| A.4 | `tags: ['queued'/'custom'/'simple']` raw | unchanged | low (pre-existing) |
| A.5 | `stageGeneratingCover` defined, no setter | unchanged (cover-jobs hardened, but no stage signal added) | low (SHOULD) |
| B.1 | batch 5 diff does not intersect stage/i18n surface | verified (App.tsx grep empty for stage/cancelled, i18n untouched) | none |
| B.2 | build green, **bit-identical bundle hash** to R3 (`index-DgAYuVNf.js`, 1505.24 kB / 380.90 kB) | verified | none |
| B.3 | post-cancel UX fully translated in 5 locales (carries from R3 §B) | verified | none |
| B.4 | cover-jobs tombstone state never flows into `Song.stage` | verified | none |
| B.5 | `GenerationParams` extension has no `stage` field — no collision | verified | none |

**Counts:** 10 findings inspected; 0 fixes landed for this surface in batch 5 (expected — batch 5 was cover-jobs leak fix + types/whitelist hygiene per R3 reviews of agents 06/07/10); 5 carry-over confirmed unchanged (A.1 medium + A.3, A.4, A.5 low + R1 §5 backend free-form Python stage); 5 multi-locale / build / regression checks pass; 0 new regressions; build green; bundle byte-identical to R3.

**Top remaining gap (4th round):** A.1 — `'cancelled'` is still a raw English literal masquerading as a stage value. The recommendation has been carried over four rounds without being touched. User-visible behavior remains correct; the convention split (`stage*` are i18n keys, `'cancelled'` is a magic literal) persists. Two-line fix unchanged: rename the App.tsx setter to `'stageCancelled'`, update both SongList comparators, add `stageCancelled: 'Cancelled'` (en) / `'Отменено'` (ru) / `'已取消'` (zh) / `'キャンセルしました'` (ja) / `'취소됨'` (ko) — five locale entries — **OR** introduce `Song.isCancelled?: boolean` and stop overloading `.stage`.

**Caveat — out of scope for batch 5:** the prompt for batch 5 was cover-jobs leak (R3 agent_pollinations_backend) + types/whitelist hygiene (R3 agent10/agent08). Agent 09's findings were not in that batch's mandate. No criticism of the batch — just noting that A.1 has now been visible to **four review passes** and remains the only medium-severity stage/i18n issue in the tree.
