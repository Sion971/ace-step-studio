# Agent 09 — Stages, i18n, song-card status display

**Scope:** master `d8aab5bf2..HEAD` (8 commits, ending at `6c39f42c5 i18n: stage keys in en/zh/ja/ko (round 2)`).
**Files audited:** `app/i18n/{en,ru,zh,ja,ko}.ts`, `app/i18n/translations.ts`, `app/context/I18nContext.tsx`, `app/components/SongList.tsx`, `app/components/CreatePanel.tsx`, `app/components/PollinationsPanel.tsx`, `app/components/UsePollinationsToggle.tsx`, `app/App.tsx`, `app/types.ts`, `app/server/src/routes/generate.ts`.
**Build:** `npm run build` from `app/` succeeds in 2.21s — `dist/assets/index-DJ0oVVZK.js` 1503.01 kB / gzip 380.22 kB. No TS-emit-blocking errors (vite uses esbuild; tsconfig has `noEmit: true` and no `strict`).

---

## 1. Stage i18n key coverage — PASS

All five stage keys present in all five locales. Verified via grep `stageWaitingInQueue|stageGeneratingTextOpenRouter|stageStartingTrack|stageGeneratingTrack|stageGeneratingCover` over `app/i18n/`.

| key | en | ru | zh | ja | ko |
|---|---|---|---|---|---|
| `stageWaitingInQueue` | 136 | 137 | 135 | 135 | 135 |
| `stageGeneratingTextOpenRouter` | 137 | 138 | 136 | 136 | 136 |
| `stageStartingTrack` | 138 | 139 | 137 | 137 | 137 |
| `stageGeneratingTrack` | 139 | 140 | 138 | 138 | 138 |
| `stageGeneratingCover` | 140 | 141 | 139 | 139 | 139 |

5 keys × 5 langs = 25 entries — all present. **Severity: none.**

CJK indentation: `ja.ts` uses 2-space indent (file-wide, original style); `en/ru/zh/ko` use 4-space. Consistent within each file, parses fine, no functional impact. **Severity: cosmetic.**

Insertion ordering: stage keys land between `writingLyricsAndStyle` and `queued` in all five files. No syntax breakage from the Edit-tool insertions.

---

## 2. Pollinations panel keys — count mismatch in spec, all keys cover real call-sites

The prompt enumerated 28 keys, but only **27 distinct keys** were enumerated (sectionTitle, useToggle, useToggleHint, apiKey, optional, testKey, keyHint = 7 + modelPicker.* (10) + width/height/dimsHint (3) + seedMode/seedSong/seedRandom (3) + enhance/nologo/safe/resetDefaults (4) = 27). Each locale defines exactly 27 `'pollinations.*'` entries (`grep -c "'pollinations\." app/i18n/$f.ts` → 27 for all five). **No coverage gap.**

Call-site verification:
- `PollinationsPanel.tsx` references 22 keys (apiKey, optional, testKey, keyHint, modelPicker.* all 10, width, height, dimsHint, seedMode, seedSong, seedRandom, enhance, nologo, safe, resetDefaults).
- `UsePollinationsToggle.tsx` uses `pollinations.useToggle` (×2 incl. aria-label) and `pollinations.useToggleHint`.
- `CreatePanel.tsx:3182` uses `pollinations.sectionTitle`.

Every defined key is read somewhere, every read key is defined. **Severity: none.**

---

## 3. `t(song.stage)` resolves to literal key on miss — by design (semantic info)

`app/context/I18nContext.tsx:25-27`:

```ts
const t = (key: TranslationKey): string => {
  return translations[language][key] || key;
};
```

`t` **never returns falsy** — on miss it returns the input key. Therefore in
`SongList.tsx:677` and `:832`:

```ts
song.title || (song.isGenerating ? (song.queuePosition ? t('queued') || "Queued..." : (t(song.stage) || song.stage || t('creating') || "Creating...")) : t('untitled') || "Untitled")
```

…the `|| song.stage || t('creating') || "Creating..."` tail is **dead code** for the i18n fallback path: if the key is missing, the user already sees the literal key string (e.g. `stageWaitingInQueue`). The fallback chain only fires if `song.stage` is `undefined` (then `t(undefined as any)` falls into `translations[lang][undefined]` → `undefined || undefined` → falsy → `song.stage` is also undefined → `t('creating')`).

**Severity: low (cleanup).** Consider:
- `t(song.stage as TranslationKey, { fallback: '' })` pattern, **or**
- explicit `song.stage && translations[lang][song.stage]` check, **or**
- accept current behavior and just drop the unreachable arms.

TypeScript hole: `song.stage: string` is silently widened into `(key: TranslationKey)`. Vite/esbuild does not type-check; `tsc --noEmit` would flag it but isn't wired into the build. **Severity: low.**

---

## 4. `stage: 'cancelled'` — namespace collision, no i18n

`App.tsx:780` sets `{ ...s, isGenerating: false, stage: 'cancelled' }` after a user cancel. `SongList.tsx:843` and `:424` special-case the literal string `'cancelled'`:

```tsx
) : song.stage === 'cancelled' && onResetJob ? (
```

This string is **not** an i18n key (no `cancelled` entry in any locale; only `cancelGeneration` / `resetGeneration` exist). Mixing `stage*` i18n keys with the magic string `'cancelled'` is inconsistent. The user-facing label at `SongList.tsx:845` is `t('cancelGeneration')` which IS translated, so visually it's fine — but the **stage discriminator** is a raw English literal.

**Severity: medium (consistency).** Recommended:

- **Option A** (minimal): add five entries `stageCancelled: 'Cancelled'` (and translations) to each locale, rename App.tsx setter to `'stageCancelled'`, update both SongList comparators.
- **Option B** (cleaner): introduce `Song.isCancelled?: boolean` and stop overloading `.stage` for state-machine flags. Keeps `.stage` purely an i18n key.

Diff (Option A, en.ts):
```ts
+    stageCancelled: 'Cancelled',
```
…plus `App.tsx:780 'cancelled' → 'stageCancelled'` and `SongList.tsx:424,:843 === 'cancelled' → === 'stageCancelled'`.

---

## 5. Backend `aceStatus.stage` overrides i18n keys — raw English/whatever ACE-Step emits

`app/server/src/routes/generate.ts:751` returns `stage: aceStatus.stage` from the Python ACE-Step worker. `App.tsx:925` blindly assigns `newStage = status.stage ?? song.stage`. Python emits free-form strings like `loading`, `Step 5/12`, `writing audio`. These never match a `TranslationKey`, so `t()` returns the literal — user sees raw English (or whatever the Python locale is) regardless of UI language.

**Severity: medium (design).** Acceptable for v1 per prompt. Long-term options:
- map known Python stages to `stageGeneratingTrack` etc. in the polling callback (`App.tsx:925`).
- expose a stage **enum** (machine code) from the backend and a separate `stageMessage` (already-localized or i18n-key) — frontend prefers enum.

Briefly visible: `stageStartingTrack` is set in `App.tsx:1002` immediately before `beginPollingJob`, then overwritten by the next poll tick (every 2s). Acceptable.

---

## 6. `tags: ['queued' | 'custom' | 'simple']` — pre-existing untranslated literals

`App.tsx:130` (`createTempSongForClick`), `App.tsx:974`, `App.tsx:1001`. Tags render in `RightSidebar.tsx:497` as raw strings. Not introduced this session. **Severity: low (pre-existing).** If addressed, treat tags as i18n keys consistent with the new stage approach.

---

## 7. `stageGeneratingCover` defined but never set

Searched for any frontend code path that assigns `song.stage = 'stageGeneratingCover'` — **zero hits**. Cover gen runs server-side after `succeeded` and updates `cover_url` asynchronously via `cover-jobs.ts`. The frontend currently has no signal to drive this stage label; the song card transitions directly from `stageGeneratingTrack` → succeeded (placeholder cover blurred) → eventually real cover lands on next refresh.

**Severity: low (SHOULD).** To use this i18n key, add a `cover_status` field to the song response (idle / generating / succeeded / failed) or push it via the existing polling endpoint. Until then, the key is dead but harmless.

---

## 8. `stageGeneratingTextOpenRouter` — bulk update is correct

`CreatePanel.tsx:1544`:
```ts
tempIds.forEach(id => updateTempSongForClick(id, { stage: 'stageGeneratingTextOpenRouter' }));
```
All bulk-card placeholders share one OpenRouter call, so updating them all simultaneously is semantically right. **Severity: none.**

---

## 9. `Song.stage?: string` type — no compile-time guard

`types.ts:13`:
```ts
stage?: string;
```
Permits any string. A typo like `'stageWatingInQueue'` will silently fall back to literal-display. Tightening:

```ts
type StageKey =
  | 'stageWaitingInQueue'
  | 'stageGeneratingTextOpenRouter'
  | 'stageStartingTrack'
  | 'stageGeneratingTrack'
  | 'stageGeneratingCover'
  | 'stageCancelled'; // if Option A from #4 lands

stage?: StageKey | string; // keep `string` if backend still streams free-form
```

Even branded form would only catch typos; the backend free-form stream forces a `| string` fallback anyway. **Severity: low.**

---

## 10. Ellipsis style — mixed but per-key consistent

New `stage*` keys use Unicode `…` (U+2026) across all 5 locales. Legacy keys (`queued: 'Queued...'`, `creating: 'Creating...'`, `writingLyricsAndStyle: 'Writing lyrics & style...'`) use ASCII `...`. Each individual key is consistent across locales — only the overall file has both styles. **Severity: cosmetic.** Optional future pass to normalize to `…`.

---

## 11. Build status — green

```
> ace-step-ui@1.0.0 build
> vite build
✓ 2350 modules transformed.
dist/assets/index-DJ0oVVZK.js  1,503.01 kB │ gzip: 380.22 kB
✓ built in 2.21s
```

Bundle exceeds 500 kB warning threshold (pre-existing — not caused by this session's i18n additions; +5 keys × 5 locales adds ~1 kB to source, negligible after minification).

---

## Summary

| # | finding | severity |
|---|---|---|
| 1 | 25/25 stage entries present, ja 2-space indent OK | none / cosmetic |
| 2 | 27 (not 28) pollinations keys × 5 langs, all referenced | none |
| 3 | `t()` returns key on miss → fallback chain in SongList partly dead | low |
| 4 | `'cancelled'` literal mixes with `stage*` i18n keys | **medium** |
| 5 | Backend `aceStatus.stage` is free-form Python text, bypasses i18n | medium |
| 6 | `tags: ['queued'|'custom'|'simple']` untranslated | low (pre-existing) |
| 7 | `stageGeneratingCover` defined but no setter | low (SHOULD) |
| 8 | OpenRouter bulk stage update is correct | none |
| 9 | `Song.stage?: string` no enum guard | low |
| 10 | mixed `…` vs `...` ellipsis | cosmetic |
| 11 | build green, 1503 KB / 380 KB gzip | none |

**Top recommendation:** rename `'cancelled'` → `'stageCancelled'` (or split into `Song.isCancelled` flag) and add the i18n entries — that's the only finding that produces a user-visible inconsistency today (cancelled-state discriminator is a hidden English literal even though the visible label is translated). Everything else is design hygiene or pre-existing.
