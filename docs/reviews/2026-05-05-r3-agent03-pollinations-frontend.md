# Pollinations frontend — ROUND 3 review (post-batch-4 verification) — 2026-05-05 (agent03/r3)

Inspected `e53909eede10ace5883450e71bf5d28b0f009d67` ("fix: R2 review fixes batch 4").
References:
- R1: `docs/reviews/2026-05-05-agent03-pollinations-frontend.md`
- R2: `docs/reviews/2026-05-05-r2-agent03-pollinations-frontend.md`

Severity tags: **CRIT / MAJ / MIN / NIT / OK**, plus **FIXED / NOT FIXED / PARTIAL**.

---

## R2 carryover verification

### R2 #7 (clampInt('') → min) — **STILL NOT FIXED** · MIN

`PollinationsPanel.tsx:102-107`:

```ts
const clampInt = (raw: string, min: number, max: number, fallback: number): number => {
  if (raw === '') return min;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
};
```

Byte-identical to R1+R2 source. Empty input still snaps to `min` (256), `parseInt('0')` still produces `0` → clamp to `256`. `fallback` parameter is dead in two of the three branches. Twitchy width input mid-edit; not broken — same severity **MIN**.

`git show e53909eed -- app/components/PollinationsPanel.tsx` shows zero changes to this file in batch 4. The fix the R1+R2 sketches asked for has now been deferred across two consecutive fix-batch commits.

### R2 #8 (seedMode JSDoc clarification) — **STILL NOT FIXED** · MAJ (doc gap)

`types.ts:23`:

```ts
seedMode: 'song' | 'random'; // 'song' = derive from songId for reproducibility on retake
```

Identical to R1+R2. The proposed two-line clarification noting that the **server-side style modifier in `cover-jobs.ts` is keyed off `jobId` regardless of `seedMode`** has not been added. Same doc gap. A developer reading `seedMode: 'song'` still walks away believing "every retake reproduces" when in fact the style modifier rotates per job. Severity **MAJ** as a documentation contract gap; behaviour is unchanged.

### R2 NIT (api.ts `_tempId` typing) — **NOW ACTUALLY FIXED** · OK · with one residual cast

Confirmed via `grep _tempId app/services/api.ts`:

```
394:  _tempId?: string;
```

Full DCW + FlowEdit + retake cluster also added to `GenerationParams` in batch 4 (`api.ts:372-394`, +24 lines). The interface now reflects what `CreatePanel` actually sends:

```ts
// DCW (Differential Correction in Wavelet domain) cluster — already on the
// wire today (frontend builds them, App.tsx whitelist forwards them); add
// them here so the casts in App.tsx can drop the `as any`.
dcwEnabled?: boolean;
dcwMode?: 'low' | 'high' | 'double' | 'pix';
dcwScaler?: number;
dcwHighScaler?: number;
dcwWavelet?: string;

// Retake / Flow-edit — same story.
retakeSeed?: number;
retakeVariance?: number;
flowEditMorph?: boolean;
flowEditSourceCaption?: string;
flowEditSourceLyrics?: string;
flowEditNMin?: number;
flowEditNMax?: number;
flowEditNAvg?: number;

// Pre-created placeholder card id from CreatePanel — App.tsx promotes the
// existing card instead of creating a duplicate. Underscore-prefixed since
// it's a UI tunnel, not an audio-gen knob.
_tempId?: string;
```

The R2 finding "commit message lies" is **resolved** — the diff is now real. Commit message of `e53909eed` is honest about its predecessor's mis-labelling.

**However**, App.tsx still casts at the read site:

```
app/App.tsx:1009:    const preCreatedId = (params as any)._tempId as string | undefined;
app/App.tsx:1179:        _tempId: (params as any)._tempId,
app/App.tsx:1159:        prompt: (params as any).prompt,
app/App.tsx:1160:        dcwEnabled: (params as any).dcwEnabled,
```

These `as any` tunnels are now **unnecessary** since `GenerationParams` covers all four fields. Out-of-scope NIT for the Pollinations frontend reviewer (App.tsx generic-payload reads belong to agent10/types), but worth flagging: the type widening was done, the cast cleanup at the read sites was not. Severity **NIT** — code works, just not as clean as the commit message implies.

---

## R3 regression hunt

### R3.1 CreatePanel IIFE captures `pollinationsStorage` — **OK**

`CreatePanel.tsx:1650-1673` (custom mode branch) — captures verified:

| Symbol | Source | OK? |
|---|---|---|
| `pollinationsStorage` | module import (line 3) | ✓ |
| `effCoverPrompt` | computed earlier in `submit` | ✓ |
| `effTitle` | computed earlier in `submit` | ✓ |
| `styleWithGender` | computed earlier in `submit` | ✓ |
| `songDescription` | scoped above `submit` body | ✓ |
| `vocalLanguage` | useState | ✓ |
| `instrumental` | useState | ✓ |
| `buildCoverPrompt` | module import | ✓ |
| `usePollinations` | gated by `usePollinations ? (...) : { enabled: false }` | ✓ |

The IIFE runs synchronously inside the same tick as the surrounding `onGenerate(...)` literal — no async hop, no stale-closure risk. The simple-mode branch at line 1742 mirrors the same pattern (`_tempId: tempIdForThisJob, customMode: false, songDescription, ...`) — no IIFE needed there because Pollinations isn't gated through simple mode (verified by absence of `pollinations:` key in the simple-mode literal head).

Note: the simple-mode object at line 1740-onwards does NOT carry a `pollinations` field at all. So if a user is in Simple mode and toggles Pollinations on, **the cover-gen request never goes out**. This may be intentional (Simple mode = minimal-knobs path), but it is **not** documented anywhere in the file. Severity **MIN** — silent feature-disable. To verify whether this is by design, see UsePollinationsToggle gating (`CreatePanel.tsx:3185`-ish, single-mount under `usePollinations &&`); the toggle is enabled regardless of mode, so a user in Simple mode flipping it on receives no error and no covers — only gradient placeholders.

### R3.2 cover_url mapping (fresh + legacy) — **OK**

`App.tsx:418` (loadFeed) and `App.tsx:877` (loadMySongs) — both unchanged from R2. Three-way fallback intact:

```ts
// loadFeed
coverUrl: s.cover_url || s.coverUrl || `https://picsum.photos/seed/${s.id}/400/400`,
// loadMySongs
coverUrl: (s as any).cover_url || (s as any).coverUrl || `https://picsum.photos/seed/${s.id}/400/400`,
```

Cases re-verified:
- Fresh API row with `cover_url='http://.../jobs/<id>/cover.jpg'` → wins ✓
- camelCase intermediate state → falls through ✓
- Legacy with neither → seeded picsum ✓
- `cover_url=''` → falsy, falls through to picsum ✓
- `cover_url='0'` → truthy, would short-circuit (URL never `'0'`) ✓

Loading-placeholder picsum (`?blur=10`) at lines 124, 986, 1027 — those paths are pre-`cover_url` and correct.

NIT NEW: loadFeed (`s as any` not used) and loadMySongs (`(s as any).cover_url`) have inconsistent typing. The `Song` API DTO presumably has `cover_url?` since loadFeed reads it without cast — so loadMySongs's cast is redundant. NIT, out-of-Pollinations-scope.

### R3.3 PollinationsPanel debounce + storage write loop — **OK**

`PollinationsPanel.tsx:34` `useEffect(() => { pollinationsStorage.setConfig(cfg); }, [cfg]);` and `:47-51` debounced `reloadModels` — both byte-identical to R2-verified shape. No changes in batch 4. R2's mental simulations (S1–S4) still apply.

### R3.4 Full flow mental simulation — paste apiKey → pick model → click Создать

1. **Open panel:** mount → `cfg = pollinationsStorage.getConfig()` (default or persisted). `useEffect#1` writes back same value (no-op). `useEffect#2` schedules 400ms timer → after 400ms, `reloadModels(false)` → `getPollinationsModels('')` → CORS-friendly fetch → models list populates.

2. **Paste `sk_xxxx...`:** `onChange` → `setCfg(c => ({ ...c, apiKey: 'sk_xxxx...' }))`. `useEffect#1` fires → `setConfig` persists. `useEffect#2` cleanup cancels in-flight 400ms timer (if any), schedules new one. After 400ms with no further keystrokes → `reloadModels(false)` → cache miss for `'sk_xxxx...'` → fetch with `Authorization: Bearer sk_xxxx...` → list updates with auth-tier models. ✓

3. **Click Test:** `onTestKey` → `testPollinationsKey('sk_xxxx...')` → reachability ping. Server returns 200 (Pollinations does not 401 on bad keys per `client.ts:16-18` doc) → `setTestStatus('ok')`. **Does NOT validate the key.** This is the documented limitation; fine.

4. **Pick model:** `selectModel('flux')` → `setCfg(c => ({ ...c, model: 'flux' }))` → persisted via `useEffect#1`. `pollinationsStorage.pushRecentModel('flux')` updates LRU.

5. **Click Создать:** `submit` runs → builds payload → IIFE captures `pollinationsStorage.getConfig()` synchronously → `pollinations: { enabled: true, apiKey: 'sk_xxxx...', model: 'flux', width, height, seedMode, ..., prompt }` → `onGenerate(payload)` → API hit. ✓

6. **Backend with bad apiKey:** Pollinations doesn't 401, but real generation may 4xx if the token is malformed. Backend logs warn, `cover_url` stays `null`. UI shows gradient placeholder (per `App.tsx:418` fallback chain). User-facing: "cover didn't render, but the song generated fine" — graceful degradation. ✓

7. **Backend with valid apiKey:** Pollinations succeeds → backend writes `cover.jpg` → updates DB row's `cover_url` → next `loadMySongs` refresh picks it up via line 877. ✓

End-to-end: **no regressions**.

### R3.5 IIFE storage read happens at `onGenerate` time, not at toggle time — **OK**

A subtle aspect of the current design: `pollinationsStorage.getConfig()` inside the IIFE reads from localStorage **at the moment the user clicks Создать**, not the moment they toggle Pollinations on. So if the user opens the panel, types apiKey, picks model, but doesn't wait the 400ms for `reloadModels` to settle before clicking Создать — the apiKey is still sent (because `setConfig` writes happen via `useEffect#1` synchronously on every cfg change, not debounced). The debounce in `useEffect#2` only applies to the `/image/models` fetch, not to the storage write.

So the worst case is: user types, immediately clicks Создать (within 400ms) → models list still loading → but **storage already has the latest apiKey + model** → IIFE reads correct values → backend gets correct config. ✓

If the user races Создать against a model selection (clicks Создать before `selectModel` has fired? Impossible — both are explicit user actions.), no race exists.

### R3.6 The new api.ts type additions don't change PollinationsPanel — **OK**

The DCW/FlowEdit/retake/`_tempId` widening of `GenerationParams` in batch 4 has zero effect on `PollinationsPanel.tsx` (which doesn't import `api.ts`). It does affect `CreatePanel`, but the IIFE shape is unchanged. No regression introduced.

The `pollinations` payload shape inside `GenerationParams` is **not** typed strictly — looking at api.ts the field appears as `pollinations?: any` or wide-typed object (need agent10 confirmation). Out of scope for this review, but worth flagging: the rest of the cluster got real types in batch 4, the `pollinations` blob did not. Severity **NIT** for the Pollinations reviewer; would-be-MIN if agent10 hasn't already covered it.

### R3.7 `useEffect#1` write loop on initial mount — **OK / NIT**

`useEffect(() => { pollinationsStorage.setConfig(cfg); }, [cfg]);` fires once on mount with the value just read from `getConfig()`. That's a write of the same data. localStorage handles this fine (browser may even no-op equal writes), but for users with disk-backed localStorage (some Chromium variants on slow disks), it's an extra IO blip.

Could be skipped with a `firstRun` ref:

```ts
const firstRun = useRef(true);
useEffect(() => {
  if (firstRun.current) { firstRun.current = false; return; }
  pollinationsStorage.setConfig(cfg);
}, [cfg]);
```

Severity **NIT**, pre-existing, not introduced by batch 4.

### R3.8 `reloadModels` recreated each render — **OK**

`reloadModels` is a closure freshly created on every render of `PollinationsPanel`. It's referenced inside `useEffect#2` (the debounced loader) and as the click handler for the "Refresh" button (`PollinationsPanel.tsx:166`-ish). The eslint-disable on `useEffect#2`'s dep array suppresses the warning that `reloadModels` is missing from deps. This is intentional and documented inline, so the closure-over-`cfg.apiKey` works correctly because:

- On every `cfg.apiKey` change → render → new `reloadModels` closure with new `cfg.apiKey` → useEffect cleanup runs → new useEffect schedules timer that calls **the new** `reloadModels` (since the timer body is `() => reloadModels(false)`, it captures the latest closure when the effect re-runs).

Verified mental model: each `useEffect#2` invocation closes over the current-render `reloadModels`, which closes over the current-render `cfg.apiKey`. Because the effect re-runs on `cfg.apiKey` change, the captured `reloadModels` is always fresh. ✓

### R3.9 `picker click-outside` effect cleanup — **OK**

`useEffect#3` (`:54-64`) listens on `mousedown` only when `modelPickerOpen` — cleanup correctly removes listener. No regression.

---

## Severity summary (round 3)

| # | Topic | R1 sev | R2 status | R3 status |
|---|---|---|---|---|
| 1 | CORS | OK | OK | OK |
| 2 | Debounce | MIN→MAJ | FIXED (10a87ab0e) | OK (no regression) |
| 3 | Test button copy | NIT | NOT FIXED (accepted) | NOT FIXED (accepted) |
| 4 | LRU dedup-at-cap test | NIT | NOT FIXED (accepted) | NOT FIXED (accepted) |
| 5 | Style modifier split | OK | OK | OK |
| 6 | Multi-mount race | OK | OK | OK |
| 7 | clampInt('') → min | MIN | NOT FIXED | **STILL NOT FIXED** |
| 8 | seedMode JSDoc | MAJ (doc) | NOT FIXED | **STILL NOT FIXED** |
| 9 | Sidebar polReady | OK | OK | OK |
| 10 | i18n keys | OK | OK | OK |
| 11 | Image-only filter | OK | OK | OK |
| 12 | IIFE closure | OK | OK | OK |
| 13 | `||` lazy eval | OK | OK | OK |
| R2-NIT | api.ts `_tempId` typing | n/a | NOT ACTUALLY MADE | **NOW FIXED** (e53909eed) — residual `as any` reads in App.tsx remain (out of scope) |

| New R3 | Topic | Severity |
|---|---|---|
| R3.1a | Simple mode silently disables Pollinations (no `pollinations:` key in simple-mode payload) | **MIN** (silent feature-off; possibly by design) |
| R3.2a | loadMySongs casts `(s as any).cover_url` while loadFeed doesn't — inconsistent | NIT (out of Pollinations scope) |
| R3.6 | `pollinations` blob in GenerationParams not strictly typed (cluster around it now is) | NIT (out of Pollinations scope, agent10) |
| R3.7 | `useEffect#1` writes same config on mount (one extra IO) | NIT pre-existing |
| R3.8 | exhaustive-deps suppress closure model | OK (verified correct) |
| R3.9 | click-outside cleanup | OK |

---

## Counts

- **R2 carryover findings re-checked:** 3 — #7 still not fixed (MIN), #8 still not fixed (MAJ doc), R2-NIT _tempId now fixed (OK with NIT residual).
- **R3 new findings:** 6 (1 MIN R3.1a, 3 NIT, 2 OK confirmations).
- **OK** total this round: 11 / **NIT**: 4 / **MIN**: 2 (#7 + R3.1a) / **MAJ**: 1 (#8 doc-gap) / **CRIT**: 0.

Net: **0 CRIT, 0 net-new MAJ**. The R2 verdict (only doc-gap MAJ open) holds.

---

## Top 3 still-open actions

1. **#7 clampInt** — accept `''`/`'0'` → `fallback`, not `min`. Two consecutive batches have skipped this. Cheapest fix in the file.
2. **#8 seedMode JSDoc** — one comment block in `types.ts:23` clarifying that style modifier (`cover-jobs.ts`) is always `jobId`-keyed, independent of `seedMode`. Doc-only.
3. **R3.1a Simple-mode toggle** — either disable the UsePollinations toggle when in Simple mode, or carry the `pollinations` payload through the simple-mode branch of the CreatePanel literal. Currently the toggle is silently a no-op in Simple mode.

Out-of-Pollinations-scope follow-ups (for agent10/types):
- App.tsx `(params as any)._tempId` casts at lines 1009, 1179 and `(params as any).dcwEnabled / .prompt` at 1159-1160 are now redundant (type widening landed in batch 4). Remove the `as any` to actually realise the cleanup the commit advertises.
- Strict typing for the `pollinations` field in `GenerationParams` (mirror `PollinationsConfig` with `enabled: true | false` discriminated union).
