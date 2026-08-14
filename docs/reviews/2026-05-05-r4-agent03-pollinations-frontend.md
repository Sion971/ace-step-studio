# Pollinations frontend — ROUND 4 review (post-batch-5 verification) — 2026-05-05 (agent03/r4)

Inspected `0fe60457fd0611c5666e4f6eb4589d00a6216853` ("fix: R3 review fixes batch 5").

References:
- R1: `docs/reviews/2026-05-05-agent03-pollinations-frontend.md`
- R2: `docs/reviews/2026-05-05-r2-agent03-pollinations-frontend.md`
- R3: `docs/reviews/2026-05-05-r3-agent03-pollinations-frontend.md`

Severity tags: **CRIT / MAJ / MIN / NIT / OK**, plus **FIXED / NOT FIXED / PARTIAL**.

Verified scope: `git diff e53909eed 0fe60457f -- app/components/PollinationsPanel.tsx app/services/pollinations/types.ts app/services/pollinations/storage.ts app/components/CreatePanel.tsx` returns **empty**. Batch 5 touched `app/App.tsx`, `app/types.ts`, `app/server/src/routes/generate.ts`, `app/server/src/services/cover-jobs.ts` plus a new test. Pollinations-frontend files were untouched this round.

---

## R3 carryover verification

### R3 #7 (`clampInt('') → min`) — **STILL NOT FIXED** · MIN (third consecutive batch skipped)

`app/components/PollinationsPanel.tsx:102-107`:

```ts
const clampInt = (raw: string, min: number, max: number, fallback: number): number => {
  if (raw === '') return min;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
};
```

Byte-identical to R1 / R2 / R3. Empty input still snaps to `min` (256), `parseInt('0')` still produces `0` then clamps to `256`. The `fallback` parameter remains dead in two of the three branches. Behavioural impact stays the same: width/height inputs are twitchy mid-edit (each backspace-to-empty re-paints the value to 256). Severity **MIN**, but the fix has now been deferred across **three** consecutive review-fix commits (`10a87ab0e` → `2419f7d73` → `e53909eed` → `0fe60457f`). Carrying it forward without action is becoming the norm; recommend either implementing the one-line fix (`if (raw === '' || raw === '0') return fallback;`) or explicitly marking it as a wontfix in the review log.

### R3 #8 (`seedMode` JSDoc clarification) — **STILL NOT FIXED** · MAJ (doc-gap)

`app/services/pollinations/types.ts:23`:

```ts
seedMode: 'song' | 'random'; // 'song' = derive from songId for reproducibility on retake
```

Identical to R1 / R2 / R3. The proposed clarification — that `cover-jobs.ts` rotates the **style modifier** by `jobId` regardless of `seedMode`, so even `seedMode: 'song'` does not produce byte-identical retakes — has not been added. A developer reading this comment in 2026-Q3 would still walk away believing "seedMode='song' = identical retakes", which is wrong by ~30% pixel-diff (different style suffix → different prompt → different image). Documentation contract gap unchanged. Severity **MAJ** (doc-only; behaviour is fine).

### R3.1a (Простой mode silently omits `pollinations` payload) — **STILL NOT FIXED** · MIN

`app/components/CreatePanel.tsx:1740-1772` (simple-mode branch of the `onGenerate(effectiveCustomMode ? {...} : {...})` ternary) still has **no `pollinations` key**. Confirmed by line scan of the entire simple-mode object literal (1740-1772). Closing `})` at line 1772, no `pollinations:` anywhere between.

Render-side check: `UsePollinationsToggle` mounts at `CreatePanel.tsx:3195` inside the `{showAdvanced && (...)}` block (which opens at line 2692, customMode-agnostic). It is **not** wrapped in any `{customMode && ...}` guard — verified by walking the structural lines `2589 → 2678` (customMode block closes well before the Pollinations section).

Mental simulation re-run for a Простой-mode user with Pollinations toggle ON:
1. User selects Простой tab → `customMode = false`.
2. User opens advanced panel → `showAdvanced = true`.
3. User flips `UsePollinationsToggle` → `usePollinations = true` → `<PollinationsPanel />` mounts → user can paste apiKey, pick model, set width/height/seedMode.
4. User clicks Создать → `submit` runs → `effectiveCustomMode = customMode || (useOpenRouter && !activeLmModel)`.
   - With local-LM mode (no OpenRouter), `effectiveCustomMode = false` → simple-mode branch fires.
   - With OpenRouter + no local LM, `effectiveCustomMode = true` → custom-mode branch fires (Pollinations included). So this bug is **specific to Простой + local-LM-only**.
5. Simple-mode literal omits `pollinations` → backend `generate.ts` `pol = body.pollinations` evaluates `undefined` → cover-jobs is never started → `cover_url` stays `null` → frontend falls back to `picsum.photos/seed/{id}`.

User-facing symptom: **silent feature-off**. The toggle and panel are visible, the apiKey field accepts input, the model dropdown loads — but no cover ever generates. There is no error, no toast, no log line on the client. The user blames Pollinations / their apiKey / model choice, when actually the request never went out.

Severity **MIN** (silent UX trap, easy fix). Two options:

1. **Disable the toggle in Простой mode**: wrap the section at 3187-3197 with `{customMode && (...)}` — the simplest path, but removes a feature-tier from Простой. UX precedent in the same file is "advanced features show in both modes", so this would feel inconsistent.
2. **Carry the payload through simple-mode** (recommended): add the same `pollinations: usePollinations ? (() => {...})() : { enabled: false }` block to the simple-mode literal at line 1740. Backend handles both customMode and simple-mode coverage uniformly via `pol.enabled`.

Either way, the fix is ~10 LOC and zero risk.

### R3 NIT (loadMySongs vs loadFeed cover_url typing inconsistency) — **STILL NOT FIXED** · NIT

`app/App.tsx`:

- Line 418 (loadFeed `mapSong(s: any)`): `coverUrl: s.cover_url || s.coverUrl || ...` — no cast. `s` is typed `any` because the inner mapper is locally typed.
- Line 877 (loadMySongs): `coverUrl: (s as any).cover_url || (s as any).coverUrl || ...` — `s` here is **already** `Song` (the api.ts DTO from `getMySongs`), and that DTO **does** declare `cover_url?: string` at `app/services/api.ts:95`. So the cast is doubly redundant (the field exists on the static type, and even if it didn't `s` could be widened with a single `(s as any).cover_url || s.coverUrl` rather than two casts).

Same lines 893-895 inside loadMySongs cast `bpm/keyScale/timeSignature` similarly without any payoff (all three either exist on api.ts `Song` or are read with `s.bpm` already).

Severity **NIT**, dead-cast cleanup. Not in Pollinations critical path — the fallback chain works correctly in all observed cases. Out-of-strict-Pollinations-scope but flagged because the R3 review explicitly called it out and batch 5 didn't address it.

### R3 NIT residual `as any` in App.tsx (whitelist) — **NOW FIXED** · OK

Verified via `grep "as any" app/App.tsx` — zero matches inside the whitelist block (`AppContent.handleGenerate` at lines 1009-1178). The previously-cast reads now use direct property access:

```ts
// app/App.tsx:1006 (was: (params as any)._tempId as string | undefined)
const preCreatedId = params._tempId;

// 1154-1175 (was: (params as any).{prompt,dcwEnabled,dcwMode,...,pollinations,_tempId})
prompt: params.prompt,
dcwEnabled: params.dcwEnabled,
// ...
pollinations: params.pollinations,
_tempId: params._tempId,
```

The trailing `as any` on the whole literal (`} as any, token);`) is also gone — now `}, token);`. This was made possible by the type widening in `app/types.ts:147-190` adding the DCW + FlowEdit + retake + loraLoaded + `_tempId` + `pollinations` fields to `GenerationParams`.

Cross-check: `app/services/api.ts:402-413` declares `pollinations?: { enabled: boolean; apiKey?; model?; ... }` with the same shape. The structural-compat call `generateApi.startGeneration({ ..., pollinations: params.pollinations }, token)` works because both definitions are identical. No drift introduced.

Severity **OK**. Commit-message claim ("the App.tsx whitelist drops 18 '(params as any)' casts") matches reality this time.

---

## R4 regression hunt

### R4.1 Type widening (`types.ts:179-190` `pollinations?: {...}`) — does it affect PollinationsPanel? — **OK**

`PollinationsPanel.tsx:9` imports `PollinationsConfig` and `PolModelInfo` from `app/services/pollinations/types.ts` — **not** from the App-level `app/types.ts`. So adding the `pollinations` block to `GenerationParams` in `app/types.ts:179-190` has zero compile- or runtime-impact on the panel. Confirmed by grepping — `PollinationsPanel` does not import `GenerationParams`, `Song` (App-level), or `api.ts` at all.

Mental sim:
- Panel state is `useState<PollinationsConfig>(() => pollinationsStorage.getConfig())`.
- `setConfig`, `pushRecentModel`, `getRecentModels` all live in `app/services/pollinations/storage.ts` and operate on `PollinationsConfig`.
- The two type definitions (`PollinationsConfig` in `services/pollinations/types.ts` and the inline `pollinations?` block in `app/types.ts` + `api.ts`) are now **two near-duplicates**. They're consistent today (apiKey/model/width/height/seedMode/enhance/nologo/safe + an extra `prompt?` only on the GenerationParams blocks), but they could drift if one is updated and the others aren't.

Severity **NIT** new — type duplication risk. The cleanest move would be `pollinations?: PollinationsConfig & { prompt?: string }` in both `types.ts` and `api.ts`, but that would require importing into the App-level types file. Acceptable as-is.

### R4.2 Identical `pollinations` shape across `types.ts` and `api.ts` — **OK**

`app/types.ts:179-190` and `app/services/api.ts:402-413` are character-for-character identical aside from comment wording:

```ts
pollinations?: {
  enabled: boolean;
  apiKey?: string;
  model?: string;
  width?: number;
  height?: number;
  seedMode?: 'song' | 'random';
  enhance?: boolean;
  nologo?: boolean;
  safe?: boolean;
  prompt?: string;
};
```

CreatePanel emits `{ enabled: false }` when toggle is off — matches the discriminator pattern (the only required field is `enabled`). Backend route `app/server/src/routes/generate.ts:254` re-declares the same inline shape (third copy) — out of frontend scope but worth flagging. **OK** for R4 since shapes match.

### R4.3 Simple-mode payload omission re-tested — **CONFIRMED BUG** (R3.1a unchanged)

Mental sim, Простой mode + local LM + Pollinations ON:

1. `customMode = false`, `useOpenRouter = false`, `activeLmModel = 'acestep-5Hz-lm-0.6B'` (set).
2. Click Создать → `handleGenerate` → `effectiveCustomMode = false || (false && !'acestep') = false`.
3. Falls into `onGenerate({...})` with the simple-mode object literal at 1740-1772. Object keys: `_tempId, customMode:false, songDescription, prompt, lyrics:'', style:'', title:'', ditModel, instrumental, vocalLanguage, bpm, keyScale, timeSignature, duration:-1, inferenceSteps:12, guidanceScale:9.0, batchSize:1, randomSeed, seed:-1, thinking:false, enhance:false, audioFormat, inferMethod, lmBackend, lmModel, shift, taskType, getLrc, getScores:false, loraLoaded`.
4. **No `pollinations` field** → App.tsx whitelist passes `pollinations: params.pollinations` = `undefined` → `generateApi.startGeneration` body has no `pollinations`.
5. Backend `generate.ts:254`-ish reads `body.pollinations` = `undefined` → cover-jobs `startCoverGen` never invoked → `song.cover_url` stays `null`.
6. Frontend post-render loadMySongs / loadFeed picks up `cover_url=null` → fallback to `picsum.photos/seed/{id}/400/400`.

User experience: paid for the Pollinations integration, picked a model, got picsum. No error. No log. No way to discover the bug short of opening DevTools and inspecting the request body.

**Verdict**: R3.1a is still a real bug. Batch 5 did not address it (commit message confirms — fixes scoped to types.ts widening, generate.ts prompt destructure, and cover-jobs tombstone).

### R4.4 No new regressions from batch 5 — **OK**

Batch 5 changes that could affect Pollinations frontend:

1. `app/types.ts` GenerationParams +24 lines — strictly additive, no Pollinations-frontend consumer broken.
2. `app/App.tsx` whitelist `as any` removal — payload shape identical post-cast-removal (TS just enforces it now).
3. `app/server/src/services/cover-jobs.ts` tombstone Set — backend internal, frontend doesn't see it.
4. `app/server/src/routes/generate.ts` prompt destructure fix — only affects the lyric prompt, not the Pollinations cover prompt (which is built inside the IIFE in CreatePanel and shipped as `pollinations.prompt`).

None of these introduce a Pollinations-frontend regression.

### R4.5 IIFE closure capture re-verified for batch 5 — **OK**

`CreatePanel.tsx:1650-1673`:

```ts
pollinations: usePollinations ? (() => {
  const polCfg = pollinationsStorage.getConfig();
  return {
    enabled: true,
    apiKey: polCfg.apiKey,
    model: polCfg.model,
    width: polCfg.width,
    height: polCfg.height,
    seedMode: polCfg.seedMode,
    enhance: polCfg.enhance,
    nologo: polCfg.nologo,
    safe: polCfg.safe,
    prompt: effCoverPrompt || buildCoverPrompt({...}),
  };
})() : { enabled: false },
```

Byte-identical to R3-verified. All captured bindings (`pollinationsStorage`, `effCoverPrompt`, `effTitle`, `styleWithGender`, `songDescription`, `vocalLanguage`, `instrumental`, `buildCoverPrompt`, `usePollinations`) still resolve correctly. No drift.

### R4.6 Storage write-on-mount + debounce loader — **OK**

`PollinationsPanel.tsx:34` `useEffect(() => { pollinationsStorage.setConfig(cfg); }, [cfg]);` — unchanged. Pre-existing NIT (one extra IO write on mount with the just-read value) carried forward from R3.7.

Debounced reloadModels at `:47-51` — unchanged from R2 / R3. 400ms debounce intact. R3.3 verdict ("OK") still holds.

### R4.7 Click-outside picker cleanup — **OK**

`useEffect#3` (`:54-64`) listening on `mousedown` only when `modelPickerOpen` — unchanged. R3.9 verdict still holds.

---

## Severity summary (round 4)

| # | Topic | R1 sev | R2 status | R3 status | R4 status |
|---|---|---|---|---|---|
| 1 | CORS | OK | OK | OK | OK |
| 2 | Debounce | MIN→MAJ | FIXED | OK | OK |
| 3 | Test button copy | NIT | NOT FIXED (accepted) | NOT FIXED (accepted) | NOT FIXED (accepted) |
| 4 | LRU dedup-at-cap test | NIT | NOT FIXED (accepted) | NOT FIXED (accepted) | NOT FIXED (accepted) |
| 5 | Style modifier split | OK | OK | OK | OK |
| 6 | Multi-mount race | OK | OK | OK | OK |
| 7 | clampInt('') → min | MIN | NOT FIXED | NOT FIXED | **STILL NOT FIXED** (3 batches in a row) |
| 8 | seedMode JSDoc | MAJ doc | NOT FIXED | NOT FIXED | **STILL NOT FIXED** |
| 9 | Sidebar polReady | OK | OK | OK | OK |
| 10 | i18n keys | OK | OK | OK | OK |
| 11 | Image-only filter | OK | OK | OK | OK |
| 12 | IIFE closure | OK | OK | OK | OK |
| 13 | `\|\|` lazy eval | OK | OK | OK | OK |
| R2-NIT | api.ts `_tempId` typing | n/a | NOT ACTUALLY MADE | FIXED, residual `as any` reads | FIXED end-to-end (residuals gone in batch 5) |
| R3.1a | Простой mode silently omits pollinations | n/a | n/a | MIN | **STILL NOT FIXED** |
| R3.2a | loadMySongs `(s as any).cover_url` while loadFeed casts via `mapSong(s:any)` — inconsistent | n/a | n/a | NIT | **STILL NOT FIXED** |
| R3.6 | `pollinations` blob in GenerationParams now strictly typed | NIT | NIT | NIT | **NOW TYPED** (batch 5 added explicit shape; OK) |
| R3.7 | useEffect#1 writes same config on mount | n/a | n/a | NIT pre-existing | NIT pre-existing |
| R3.8 | exhaustive-deps suppress closure model | n/a | n/a | OK | OK |
| R3.9 | click-outside cleanup | n/a | n/a | OK | OK |

| New R4 | Topic | Severity |
|---|---|---|
| R4.1 | `pollinations` shape duplicated across `types.ts` + `api.ts` + `routes/generate.ts` (3 copies, currently in sync) | NIT (drift risk) |
| R4.2 | Identical inline shape in `types.ts` and `api.ts` — OK confirmation | OK |
| R4.3 | R3.1a Простой mode bug confirmed via fresh mental sim | MIN (carryover) |
| R4.4 | No new regressions from batch 5 changes | OK |
| R4.5 | IIFE closure capture re-verified | OK |
| R4.6 | Storage write-on-mount + debounce loader unchanged | OK |
| R4.7 | Click-outside picker cleanup unchanged | OK |

---

## Counts

- **R3 carryover findings re-checked:** 5
  - #7 clampInt — STILL NOT FIXED (third consecutive batch) · MIN
  - #8 seedMode JSDoc — STILL NOT FIXED · MAJ doc-gap
  - R3.1a Простой mode payload — STILL NOT FIXED · MIN
  - R3 NIT loadMySongs/loadFeed cover_url cast inconsistency — STILL NOT FIXED · NIT
  - R3 NIT residual `as any` in App.tsx whitelist — **FIXED** · OK
- **R4 new findings:** 7 entries (1 NIT type-duplication risk, 6 OK confirmations / re-verifications)
- **OK** total this round: 17 / **NIT**: 4 / **MIN**: 2 (#7 + R3.1a) / **MAJ**: 1 (#8 doc-gap) / **CRIT**: 0

Net: **0 CRIT, 0 net-new MAJ, 0 net-new MIN, 1 net-new NIT (R4.1 type duplication risk)**.

---

## Top 3 still-open actions (unchanged from R3, with stale-counter)

1. **#7 `clampInt('')`** — accept `''`/`'0'` → `fallback`, not `min`. **Three consecutive fix-batches have skipped this.** Cheapest fix in the file (one boolean OR).
2. **#8 seedMode JSDoc** — one comment block in `app/services/pollinations/types.ts:23` clarifying that the style modifier in `cover-jobs.ts` rotates per `jobId` regardless of `seedMode`, so retakes are not byte-identical even with `seedMode='song'`. Doc-only.
3. **R3.1a Простой-mode toggle** — either disable the UsePollinations section when `!customMode` (wrap line 3187-3197 in `{customMode && (...)}`) or carry the same `pollinations:` IIFE block through the simple-mode literal at `CreatePanel.tsx:1740`. Currently a silent feature-off in Простой + local-LM mode.

Out-of-Pollinations-scope follow-ups (for agent10/types):
- **R4.1 type duplication** — `pollinations` shape lives in three files (`types.ts`, `api.ts`, `routes/generate.ts`). Consolidate to `import type { PollinationsConfig }` once a shared schema package is acceptable.
- **R3.2a / R4 loadMySongs casts** — drop `(s as any)` at lines 877, 893-895; `Song` from api.ts already declares the keys.
