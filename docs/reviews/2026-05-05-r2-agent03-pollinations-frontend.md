# Pollinations frontend — ROUND 2 review (post-fix verification) — 2026-05-05 (agent03/r2)

Scope: same as round 1. Verifies fix commits `ea73c3c98`, `10a87ab0e`, `2419f7d73` against
`docs/reviews/2026-05-05-agent03-pollinations-frontend.md`.

Severity tags: **CRIT**, **MAJ**, **MIN**, **NIT**, **OK**, plus **FIXED** / **NOT FIXED** / **PARTIAL**.

---

## Status of round-1 findings

### #1 CORS — **OK (still healthy)**
No code change to `client.ts:21-25,51,108`. Anonymous + authed both still hit the same fetch path with no `credentials`. Nothing regressed.

### #2 Models picker debounce — **FIXED** (commit `10a87ab0e`)
`PollinationsPanel.tsx:47-51`:
```ts
useEffect(() => {
  const id = setTimeout(() => reloadModels(false), 400);
  return () => clearTimeout(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [cfg.apiKey]);
```
Cleanup function clears the timer on every dep change AND on unmount — verified line 49. Mental run:

| Action | Effect |
|---|---|
| Mount, key='' | timer scheduled, fires 400ms later → 1 anon `/image/models` |
| Type 's' (50ms in) | cleanup cancels prior timer, new one scheduled |
| Type 'sk_xxxxxx' over 600ms | each keystroke cancels-and-reschedules; **only the final timer fires** ~400ms after last keystroke |
| Unmount mid-typing | cleanup clears pending timer, no orphan fetch |

Behaviour matches the round-1 diff sketch exactly. Rate-limit hammering (the MAJ-if-bites scenario) is gone.

Side-effect note (NIT, NEW): on first mount with `apiKey=''` the panel shows `models=[]` for the first 400ms before the anonymous `/image/models` returns. The dropdown isn't open by default (it's gated by `modelPickerOpen`), and `modelsLoading` is set inside `reloadModels` — but `reloadModels` is now invoked 400ms LATE, so during that window `modelsLoading=false` and `models=[]`. If the user clicks the picker button within that 400ms they see empty state instead of the loading spinner. Not disruptive in practice (humans rarely click within 400ms of mount), but a tighter implementation would `setModelsLoading(true)` synchronously before the timer, or fire-immediately on mount and only debounce subsequent changes (e.g. `useEffect(() => { if (firstRun.current) { reloadModels(false); firstRun.current=false; return; } const t = setTimeout(...) ...}, [cfg.apiKey])`). Severity NIT.

### #3 Test button copy — **NOT FIXED** (NIT, accepted)
`pollinations.testKey` still labelled `'Test'` in all 5 langs; `keyHint` unchanged. Round 1 marked this as acceptable-as-is per the file header comment. No regression.

### #4 LRU dedup-at-capacity test — **NOT FIXED** (NIT, accepted)
`storage.test.ts` still has only "caps at 5" + "deduplicates" — no combined `dedup-at-cap` test. Implementation in `storage.ts:59-66` remains correct (`filter !== id`, `unshift`, `slice(0,5)`). NIT accepted.

### #5 Style modifier split — **OK (still healthy)**
`cover-jobs.ts:21,109-115` unchanged. `prompts.ts:13-39` unchanged. Architecture intact.

### #6 Multi-mount race — **OK (still healthy)**
`PollinationsPanel.tsx:23,34` unchanged. Single-mount invariant holds (`CreatePanel.tsx:3185`-ish, gated by `usePollinations`). Theoretical only.

### #7 `clampInt('') → min` — **NOT FIXED**
`PollinationsPanel.tsx:102-107`:
```ts
const clampInt = (raw: string, min: number, max: number, fallback: number): number => {
  if (raw === '') return min;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
};
```
Identical to round-1 source. Empty input still snaps to `min` (256), not `fallback`. Typing `0` still silently becomes `256`. Round-1 fix sketch was not applied. Severity remains **MIN** — twitchy, not broken.

### #8 Style-modifier always uses jobId — **NOT FIXED**
`types.ts:23` still reads:
```ts
seedMode: 'song' | 'random'; // 'song' = derive from songId for reproducibility on retake
```
No JSDoc clarification added re: server-side style modifier always being keyed off `jobId`. The contract gap that round 1 flagged (developer reads `seedMode: 'song'` and assumes "everything reproducible", but style varies per retake regardless) persists. Severity remains **MAJ** as a doc gap.

Note: searched `types.ts`, `prompts.ts`, `cover-jobs.ts` for any new comment about "style ... jobId" or "always keyed" — none added.

### #9 Sidebar IMG row colour semantics — **OK (still healthy)**
`Sidebar.tsx:60-64,173-181` unchanged.

### #10 i18n keys (27 across 5 langs) — **OK (still healthy)**
No new keys added in any of the 3 fix commits to `app/i18n/{en,ru,zh,ja,ko}.ts` (`git show` confirms). Parity preserved.

### #11 Image-only model filter — **OK (still healthy)**
`client.ts:71-72` unchanged.

### #12 CreatePanel payload IIFE — see "regression hunt" below
Round 1 marked OK — re-verified after the `effCoverPrompt`/`_tempId` reshuffle of batch 1 + 3.

### #13 `||` lazy eval — **OK (still healthy)**
`CreatePanel.tsx:1665-1672` (formerly 1654-1660) — same `effCoverPrompt || buildCoverPrompt(...)` shape. Short-circuit preserved.

---

## Round-2 regression hunt (Pollinations frontend specifically)

### R1. Debounce intro window — **NIT** (covered above under #2)
Empty list visible 0–400ms post-mount. Acceptable; user-visible only on race-of-clicks.

### R2. `_tempId` typing change — **NOT ACTUALLY MADE; commit message lies**
Commit `2419f7d73`'s message says:
> `_tempId` added to GenerationParams type (api.ts) — removes 'as any' tunnel

But `git show 2419f7d73` only touches `app/server/src/services/id3-tagger.ts` (48 lines). `api.ts` was **not** modified.

Verified by:
- `Grep _tempId` in `app/services/api.ts` → **0 matches**
- `app/services/api.ts:279-390` `GenerationParams` shows no `_tempId` field
- `CreatePanel.tsx:1628,1742` still passes `_tempId: tempIdForThisJob` inside the object literal — TypeScript accepts this only because the literal flows into `onGenerate` whose type accepts `GenerationParams` via excess-property-check… actually, **excess property checks fire on object literals**, so this would be a type error UNLESS `onGenerate`'s param type is widened or `as any` is used somewhere upstream.
- `App.tsx:999,1169` reads `(params as any)._tempId` — confirmed `as any` tunnel still present.

So: the typing cleanup that the commit claims happened, didn't. Either (a) the commit was reverted/never staged, or (b) the message is wrong. Either way, **`as any` cast in App.tsx still present at lines 999 and 1169**, and the `_tempId` field flows through untyped.

Impact on Pollinations frontend: **none** (PollinationsPanel doesn't touch `_tempId`). But it's a legitimate finding: the round-1 review of agent10-types presumably called this out and the "fix" landed as a no-op for `api.ts`. Severity **NIT** for Pollinations scope; flag for whoever owned that finding.

### R3. CreatePanel IIFE captures — **OK**
At `CreatePanel.tsx:1650-1673` the pollinations IIFE captures (in lexical scope, all `const`/`let` defined earlier in `submit`):
- `pollinationsStorage` (module import) ✓
- `effCoverPrompt` ✓ (defined upstream in same `submit` body)
- `effTitle`, `styleWithGender`, `songDescription`, `vocalLanguage`, `instrumental` ✓ (all defined before line 1650)
- `buildCoverPrompt` (module import) ✓

No async hop between definition and capture inside the IIFE — it runs synchronously in the same tick as the `onGenerate(...)` call. ✓

### R4. cover_url mapping — **OK for both fresh & legacy**
`App.tsx:418` (`loadFeed` flow) and `App.tsx:867` (`loadMySongs` flow):
```ts
coverUrl: s.cover_url || s.coverUrl || `https://picsum.photos/seed/${s.id}/400/400`
```

Cases:
- **Fresh song from API (snake_case)**: `s.cover_url = 'http://.../jobs/<id>/cover.jpg'` → wins. ✓
- **Fresh song just-after-creation (camelCase, before refetch)**: `s.coverUrl` falls through if first slot is null/undefined. ✓
- **Legacy song without any cover** (`cover_url = null` or absent + `coverUrl` absent): falls to picsum. ✓
- **Edge: `cover_url = ''` (empty string)** — falsy, falls through. Probably never sent by backend, but safe.
- **Edge: `cover_url = '0'`** — truthy, would short-circuit. Won't happen with real URLs. ✓

`App.tsx:124,976,1017` keep the loading-placeholder picsum (`?blur=10`) for in-flight cards — correct, those don't see `cover_url` yet.

### R5. PollinationsPanel storage write loop — **OK**
`PollinationsPanel.tsx:34`: `useEffect(() => { pollinationsStorage.setConfig(cfg); }, [cfg]);` — unchanged. Initial mount writes the same `getConfig()` snapshot back, which is a no-op write. No regression introduced by the debounce.

### R6. `reloadModels` & cleanup interaction — **OK**
The 400ms timer runs `reloadModels(false)` which itself runs:
1. `setModelsLoading(true)` (synchronous)
2. `getPollinationsModels(cfg.apiKey).then(setModels).catch(...).finally(setModelsLoading(false))`

If the component unmounts after the fetch fires but before it resolves, React 18 will warn about state updates on unmounted components. This was true pre-fix too — debounce doesn't change it. NIT.

### R7. `eslint-disable-next-line` placement — **OK**
Round-1 had the disable above `}, [cfg.apiKey]);`. Round-2 keeps it in the same logical position (line 50) — eslint's `react-hooks/exhaustive-deps` rule still suppressed for the intentional omission of `reloadModels` from deps (closure over `cfg.apiKey` is sufficient because `reloadModels` re-reads `cfg.apiKey` via outer closure too — but `reloadModels` is recreated each render). Pre-existing behaviour. Acceptable; suppress is intentional.

---

## Mental simulations (post-fix)

### S1. First-time open, `apiKey=''`
1. Mount → `cfg.apiKey=''` → `useEffect` schedules 400ms timer.
2. T+400ms → `reloadModels(false)` → `getPollinationsModels('')` → cache miss for `__anon__` → fetch `/image/models` with no Authorization header → server returns `["sana"]` (or richer list on free tier) → `modelsCache.__anon__` set → `setModels(['sana'])` → list renders.
3. Subsequent toggles of the panel without changing apiKey reuse cached `__anon__` slot in `getPollinationsModels` (`client.ts:39-47`) — but the `useEffect` still re-fires `reloadModels` on each `cfg.apiKey` change… ah, `cfg.apiKey` didn't change, so `useEffect` does NOT re-fire. ✓ Single fetch, then cached.

### S2. Paste `apiKey='sk_xxxxxxxx'` in one go
1. `cfg.apiKey` flips from `''` → `'sk_xxxxxxxx'` in one render.
2. Cleanup of any pending anon timer fires (clears prior 400ms-anon-timer if mid-flight).
3. New 400ms timer scheduled.
4. T+400ms → `reloadModels(false)` → cache miss for `'sk_xxxxxxxx'` → fetch with `Authorization: Bearer sk_xxxxxxxx` → returns 10 authed models → list re-renders with bigger set. ✓

### S3. Type `'sk_partial'` slowly (10 keystrokes over 1500ms, ~150ms/char)
- Each keystroke: cleanup cancels the not-yet-fired timer, schedules a new 400ms.
- During typing: 10 timers scheduled, 9 cancelled.
- 400ms after the LAST keystroke: 1 timer fires → 1 fetch with `Authorization: Bearer sk_partial`.
- Server likely returns `["sana"]` (invalid token treated as anon) — cached under the partial key string.
- Total network calls: **1** (down from 10 in round-1 code). ✓

If the user keeps typing past 400ms-from-last-keystroke (e.g. paste then type a suffix), each "settled" pause >400ms triggers one extra fetch — bounded and reasonable.

### S4. Paste then immediately blur/unmount
- Paste → 400ms timer scheduled.
- Blur within 100ms → unmount → cleanup runs → timer cleared → **0 fetches**. ✓ No orphan request.

---

## Severity summary (round 2)

| # | Topic | R1 sev | R2 status |
|---|---|---|---|
| 1 | CORS | OK | OK (no change) |
| 2 | Debounce | MIN→MAJ | **FIXED** (10a87ab0e) |
| 3 | Test button copy | NIT | NOT FIXED (accepted) |
| 4 | LRU dedup-at-cap test | NIT | NOT FIXED (accepted) |
| 5 | Style modifier split | OK | OK |
| 6 | Multi-mount race | OK | OK |
| 7 | clampInt('') → min | MIN | **NOT FIXED** |
| 8 | seedMode JSDoc clarification | MAJ (doc) | **NOT FIXED** |
| 9 | Sidebar polReady | OK | OK |
| 10 | i18n keys | OK | OK |
| 11 | Image-only filter | OK | OK |
| 12 | IIFE closure | OK | OK |
| 13 | `||` lazy eval | OK | OK |

| New | Topic | Severity |
|---|---|---|
| R1 | Debounce 400ms intro window (empty state visible) | NIT |
| R2 | `_tempId` typing — commit message claims fix not applied; `as any` still in App.tsx:999,1169 | NIT (out-of-scope for this review, flag for agent10) |
| R3 | CreatePanel IIFE captures | OK |
| R4 | cover_url mapping (fresh + legacy) | OK |
| R5 | Storage write loop | OK |
| R6 | `reloadModels` unmount race | NIT (pre-existing) |
| R7 | exhaustive-deps suppress | OK |

**Round-2 counts:** FIXED 1 (the only MAJ-if-bites). NOT FIXED 3 (1× MAJ doc-gap #8, 1× MIN #7, 2× NIT accepted #3 #4). New findings: 7 (1 NIT regression-window R1, 1 NIT mis-labelled-commit R2, 5 OK confirmations).

Top 3 still-open actions:
1. **#7** — `clampInt('') → fallback` (and reject `n < min` mid-typing). Twitchy width input.
2. **#8** — JSDoc note on `seedMode` in `types.ts:23` re: style modifier always keyed off jobId. Doc-only.
3. **R2 follow-up** — agent10 owner: verify `_tempId` cleanup actually landed; commit message of `2419f7d73` overstates the diff. Currently `as any` cast persists at `App.tsx:999` and `App.tsx:1169`.
