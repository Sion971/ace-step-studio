# Agent 09 — Round 3 review (stages, i18n, song-card status display)

**Scope:** master HEAD = `e53909eed` (`fix: R2 review fixes batch 4`).
**Prior:** `docs/reviews/2026-05-05-agent09-stages-i18n.md` (R1), `docs/reviews/2026-05-05-r2-agent09-stages-i18n.md` (R2).
**Build:** `cd app && npm run build` → green, 2.24s, `dist/assets/index-DgAYuVNf.js` 1,505.24 kB / gzip 380.90 kB. Same chunk-size advisory as R1/R2; no errors.

Batch 4 (`e53909eed`) touched `App.tsx`, `app/server/src/routes/generate.ts`, `app/services/api.ts` plus 10 R2 review docs. Per the commit message, the Frontend changes target queue/cancel hygiene (drainQueueWaiters, activeJobsRef cleanup) and `GenerationParams` type completion. **No file under `app/i18n/` was touched. No `stage:` write-site was renamed.** Stage / i18n surface is therefore unchanged from R2 except for line-number drift inside `App.tsx`.

---

## A. Verification of carry-over R2 findings

### A.1 `'cancelled'` raw literal — STILL NOT ADDRESSED

`App.tsx:787` (was `:780` in R2; shifted +7 because batch 4 inserted the `activeJobsRef.current.delete(jobId)` / `setActiveJobCount` / `drainQueueWaiters()` lines at L781-784):

```ts
setSongs(prev => prev.map(s =>
  s.id === jobData.tempId ? { ...s, isGenerating: false, stage: 'cancelled' } : s
));
```

Comparator sites unchanged:
- `SongList.tsx:424`  — `item.song.stage === 'cancelled' && item.song.jobId`
- `SongList.tsx:843`  — `song.stage === 'cancelled' && onResetJob`

No `stageCancelled` key was added to any locale; no `Song.isCancelled` flag was introduced. The R1 §4 / R2 A.4 recommendation stands. **Severity: medium (carry-over, third round).**

User-visible impact remains nil (visible label is `t('cancelGeneration')` at SongList.tsx:845 which IS translated). The hidden discriminator is still a raw English literal mixed in among the i18n-keyed `stage*` values.

Note: `'cancelled'` literals also appear in `app/services/llm/types.ts` and `app/services/llm/useOpenRouterGeneration.ts` and `GenerationStatusPanel.tsx` — these are a **separate state machine** (`OpenRouterGenerationState.kind`) and unrelated to `Song.stage`. Not in scope.

### A.2 Other stage write-sites — ALL CONFIRMED I18N KEYS

Inventory after batch 4 (line-numbers re-resolved):

| file:line | value | i18n key? |
|---|---|---|
| `App.tsx:129` (`createTempSongForClick`) | `'stageWaitingInQueue'` | ✓ |
| `App.tsx:787` (`cancelGeneration`) | `'cancelled'` | **raw, A.1** |
| `App.tsx:948` (poll tick `newStage`) | backend free-form `status.stage` | n/a (R1 §5) |
| `App.tsx:1018` (preCreatedId promotion) | `'stageStartingTrack'` | ✓ |
| `App.tsx:1047` (legacy LLM pre-flight) | `'writingLyricsAndStyle'` | ✓ |
| `CreatePanel.tsx:1549` (bulk OpenRouter) | `'stageGeneratingTextOpenRouter'` | ✓ |

No new write-sites introduced. **PASS** for everything except A.1.

### A.3 SongList `t(song.stage) || song.stage` — UNCHANGED

`SongList.tsx:677` and `:832` retain the R1/R2 fallback chain. Dead-arm discussion from R1 §3 still applies. Not addressed in any of the four batches. **Severity: low (pre-existing, cleanup).**

### A.4 `tags: ['queued'|'custom'|'simple']` — UNCHANGED

`App.tsx:130`, `:1017`, `:1031` still write tags as raw English literals. Out of scope per R1 §6 / R2 A.5. **Confirmed unchanged.**

### A.5 `stageGeneratingCover` setter — STILL ABSENT

Frontend grep over `app/**/*.{ts,tsx}` returns hits only in the 5 i18n files. Same as R1/R2. Server-side cover-jobs flow does not surface a stage to the song row. **Acceptable per prompt; flagged dead key.**

---

## B. Hunt for new R3 regressions

### B.1 Diff scope (batch 4) intersected with stage/i18n surface

`git show --stat e53909eed`:

- `app/App.tsx` — touched `cancelGeneration` (L774-789) + `resetSingleJob` (L803-815). Neither callsite changed the `stage:` literal; only added queue-drain plumbing. `'cancelled'` literal preserved at L787.
- `app/server/src/routes/generate.ts` — added `consumeCoverState` on `aceStatus.status === 'failed'`, plus 14 new fields in `GenerateBody` / destructure / params. None of these touch the `stage` field that flows back to the frontend (`stage: aceStatus.stage` at L759 unchanged).
- `app/services/api.ts` — extended `GenerationParams` with `_tempId`, DCW/FlowEdit/retake/lora clusters. **No `stage` field added** (the song's stage is on `Song`, not `GenerationParams`). No collision.

No i18n file modified, no `stage:` write-site mutated. **No new regression introduced by batch 4 in this surface.**

### B.2 Build status

```
> ace-step-ui@1.0.0 build
> vite build
✓ 2350 modules transformed.
dist/assets/index-DgAYuVNf.js  1,505.24 kB │ gzip: 380.90 kB
✓ built in 2.24s
```

Bundle delta vs R2: +0.08 kB raw, gzip identical (380.90 kB). Within noise; consistent with the small `api.ts` / `generate.ts` additions. **PASS.**

### B.3 Multi-locale mental simulation post-batch-4

Batch 4 changes user flow only when **cancel** is invoked:

1. User clicks "Cancel" on a running job → `cancelGeneration` POSTs `/api/generate/cancel/:jobId` (soft cancel).
2. New batch-4 lines at L781-784 remove the job from `activeJobsRef`, decrement `activeJobCount`, drain queue waiters. Card stays visible.
3. L786-788 patch: `{ isGenerating: false, stage: 'cancelled' }`.
4. SongList renders the card. The "Reset" button shows because `song.stage === 'cancelled'` matches at SongList.tsx:843; label is `t('cancelGeneration')` which IS translated across all 5 locales (en/ru/zh/ja/ko all define `cancelGeneration`).
5. Title fallback flow: `song.title || (song.isGenerating ? ...) : t('untitled') || 'Untitled'`. Since `isGenerating` is now `false`, the "untitled" branch fires — user sees "Без названия" (ru) / "Untitled" (en) / etc. The **stage discriminator** `'cancelled'` is invisible plumbing; the visible text is locale-correct.

So in practice — even though A.1 is still flagged for code hygiene — the cancel-then-reset UX is fully translated. Same behavior in all 5 locales. **No user-visible regression from batch 4.**

### B.4 Mid-cancel locale switch

If user cancels in `ru` then switches to `en`, the Reset button label flips from "Отменить генерацию" to "Cancel Generation" via `t('cancelGeneration')`. The `'cancelled'` discriminator is locale-agnostic since it's never displayed. **PASS.**

### B.5 Cancel + new generation interaction (batch 4 main fix)

Batch 4's core purpose was unblocking the "cancel → click again hangs forever" bug (R2 agent05 NEW-HIGH-R4). After cancel, `activeJobsRef` is now drained, so next click's pre-flight (waitForJobsToDrain) resolves. The cancelled card with `stage: 'cancelled'` remains in `songs[]` until the user clicks Reset. **No interaction with stage/i18n keys.**

---

## C. Findings table

| # | finding | status after R3 | severity |
|---|---|---|---|
| A.1 | `'cancelled'` raw literal at App.tsx:787 + 2 SongList comparators | **STILL NOT addressed (3rd round)** | medium (carry-over) |
| A.2 | Other stage writes use bare i18n keys (5 sites) | confirmed, line-numbers shifted +7/+10 | none |
| A.3 | SongList `t(song.stage) || song.stage` dead-fallback tail | unchanged | low (pre-existing) |
| A.4 | `tags: ['queued'/'custom'/'simple']` raw | unchanged | low (pre-existing) |
| A.5 | `stageGeneratingCover` defined, no setter | unchanged | low (SHOULD) |
| B.1 | batch 4 diff does not intersect stage/i18n surface | verified | none |
| B.2 | build green, 1505.24 kB / 380.90 kB gzip, 2.24s | verified | none |
| B.3 | post-cancel UX fully translated in 5 locales | verified | none |
| B.4 | mid-cancel locale switch flips Reset button label | verified | none |
| B.5 | cancel→regen no longer hangs (batch 4 core fix) — no i18n side-effect | verified | none |

**Counts:** 10 findings inspected; 0 fixes landed for this surface in batch 4 (expected — batch 4 was queue/cancel hygiene + types); 5 carry-over confirmed unchanged (A.1 medium + A.3, A.4, A.5 low + R1 §5 backend free-form Python stage); 5 multi-locale / build / regression checks pass; 0 new regressions; build green.

**Top remaining gap (3rd round):** A.1 — `'cancelled'` is still a raw English literal masquerading as a stage value. The R1 §4 / R2 A.4 / R3 A.1 recommendation stands and has now been carried over three rounds without being touched. The user-visible behavior is correct, but the convention is split: `stage*` are i18n keys, `'cancelled'` is a magic literal that happens to also drive the Reset-button gating logic. A future maintainer who tightens `Song.stage` to a `StageKey` enum will either break the cancel UX or have to special-case the literal.

**Caveat — out of scope for batch 4:** the prompt for batch 4 was queue/types fixes per R2 reviews of agents 05/07/10; agent 09's findings were not in that batch's mandate. No criticism of the batch — just noting that A.1 has now been visible to three review passes and remains the only medium-severity stage/i18n issue in the tree.
