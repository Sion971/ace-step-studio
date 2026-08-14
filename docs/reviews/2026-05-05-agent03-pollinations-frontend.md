# Pollinations frontend review — 2026-05-05 (agent03)

Scope: `app/services/pollinations/{types,storage,storage.test,client,prompts,prompts.test}.ts`,
`app/components/{PollinationsPanel,UsePollinationsToggle,Sidebar,CreatePanel}.tsx`,
`app/i18n/{en,ru,zh,ja,ko}.ts` (`pollinations.*`).

Severity tags: **CRIT** (broken UX), **MAJ** (visible bug or footgun), **MIN** (polish), **NIT** (style/doc), **OK** (verified, no change).

---

## 1. CORS — Bearer auth on `/image/models`  · **OK**

`client.ts:21-25,51,108` builds `Authorization: Bearer <key>` and fires `fetch` against `https://gen.pollinations.ai/image/models` with no `mode`/`credentials` overrides — i.e. simple-CORS-with-non-simple-header preflight. The header doc on `client.ts:16-18` explicitly states the host returns `Access-Control-Allow-Origin: *` + `Access-Control-Allow-Headers: *`, and that matches what was confirmed by curl earlier in chat.

Verdict: works in browser. No origin restriction on the server side, so anonymous + authed both succeed.

Edge case worth noting (NIT): if a future deployment sets `crossOriginIsolated` / COEP on the host page, `Access-Control-Allow-Origin: *` is incompatible with `credentials: 'include'`, but the client never sets credentials, so this is a non-issue.

---

## 2. Models picker cache invalidation  · **MIN**

`client.ts:39-47,86`: `modelsCache` keyed on `apiKey || '__anon__'`. Anonymous and authed get separate slots — good, that part is correct.

But `PollinationsPanel.tsx:45-48` re-fires `reloadModels(false)` on every `cfg.apiKey` change. Behaviour:

| User action | Cache hit? | Network call? |
|---|---|---|
| Mount, no key | new entry `__anon__` | yes |
| Type `s` (apiKey='s') | new entry `'s'` | yes |
| Type `sk` (apiKey='sk') | new entry `'sk'` | yes |
| ...continues per keystroke | new entry per partial key | **yes per keystroke** |

So while typing the API key the panel hammers `/image/models` once per character. With 1 req/15s anonymous rate-limit it will start producing 429s mid-typing and the cache-on-error path swallows them (`.catch(() => setModels([]))`) → models list flickers to empty.

**Fix (MAJ if rate-limit bites):** debounce the apiKey effect by ~500ms, or only refire when key length crosses a `pk_`/`sk_` prefix threshold.

Diff sketch:

```diff
   useEffect(() => {
-    reloadModels(false);
+    const t = setTimeout(() => reloadModels(false), 400);
+    return () => clearTimeout(t);
   }, [cfg.apiKey]);
```

Alternatively gate on `cfg.apiKey === '' || /^(pk_|sk_)/.test(cfg.apiKey)` so partial garbage keys don't trigger fetches.

---

## 3. Test button is a reachability ping  · **NIT**

`client.ts:98-116` doc-comment correctly admits Pollinations returns 200 for invalid tokens, so `testPollinationsKey` only validates network reachability + that the key character set didn't break the header (rare). The button label `pollinations.testKey: 'Test'` (`PollinationsPanel.tsx:139`) implies validation that doesn't happen.

**Suggested rename** (MIN): `pollinations.testKey: 'Ping' / 'Проверить связь'` or keep "Test" but clarify hint:

```diff
- 'pollinations.keyHint': 'Anonymous tier works (1 req/15s). Get a free token at auth.pollinations.ai for higher rate + no watermark.',
+ 'pollinations.keyHint': 'Anonymous tier works (1 req/15s). Token from auth.pollinations.ai → higher rate + no watermark. The Test button only confirms reachability — Pollinations does not 401 invalid keys; real validation happens on first generation.',
```

Acceptable as-is per the file header comment.

---

## 4. `pushRecentModel` LRU coverage  · **MIN**

`storage.test.ts:73-83`:

- "caps at 5 most recent" pushes `m0..m6` and expects `['m6','m5','m4','m3','m2']` — covers eviction + insertion order. ✓
- "deduplicates" covers re-push reordering for size-2. ✓

**Missing**: combined dedup + cap. e.g. fill to capacity then re-push an older entry — does it move to head and not exceed 5? Implementation in `storage.ts:59-66` does `filter !== id` then `unshift` then `slice(0,5)`, which is correct, but no test asserts the ordering after dedup at capacity.

Diff:

```diff
+    it('moves existing entry to head without growing past 5', () => {
+      ['a','b','c','d','e'].forEach(id => pollinationsStorage.pushRecentModel(id));
+      pollinationsStorage.pushRecentModel('b');
+      expect(pollinationsStorage.getRecentModels()).toEqual(['b','e','d','c','a']);
+    });
```

Severity NIT — implementation is correct, just untested edge.

---

## 5. Style modifiers split between front (prompt) and back (`cover-jobs.ts`)  · **OK**

Verified via `cover-jobs.ts:21,113-115`:

```
const styleIdx = seedForVariety % STYLE_MODIFIERS.length;
const styleHint = STYLE_MODIFIERS[styleIdx];
const enrichedPrompt = `${pol.prompt}, ${styleHint}`;
```

So 16 server-side style modifiers append to whatever frontend sends. Frontend `buildCoverPrompt` (`prompts.ts:13-39`) does NOT include any style modifier — only "square music album cover artwork, high quality, professional, atmospheric, cinematic lighting, [genre/mood], [topic], [instrumental], [no-text negatives]".

No duplication. Architecture is intentional: **frontend = stable per song**, **backend = per-job variety dial keyed off jobSeed**. Documented in `prompts.ts:8-12` (title-omission rationale) and `cover-jobs.ts:21,109-114` (variety rationale). 

The "no title rendering" guard (`prompts.ts:21-22`, `prompts.test.ts:12-16`) is correctly tested — Cyrillic title not present in output.

---

## 6. PollinationsPanel multi-mount race  · **OK / NIT**

`PollinationsPanel.tsx:23,34`: `useState(() => getConfig())` + `useEffect(setConfig, [cfg])`. Two simultaneous mounts would each have an independent `cfg` snapshot and last-writer-wins on every keystroke. In this codebase `PollinationsPanel` is mounted once inside CreatePanel under `usePollinations &&` (`CreatePanel.tsx:3185`), so the race is theoretical.

**No action.** If the panel ever appears in a settings modal in parallel, switch to a `BroadcastChannel` or storage-event listener for cross-instance sync.

---

## 7. `clampInt` inconsistency: `''` → `min`, not fallback  · **MIN**

`PollinationsPanel.tsx:99-104`:

```ts
if (raw === '') return min;            // → 256
const n = parseInt(raw, 10);
if (!Number.isFinite(n)) return fallback;  // e.g. existing width
return Math.max(min, Math.min(max, n));
```

User clears the field → width snaps to 256 (the lowest legal value), not back to current/fallback. Width input visibly jumps to 256 mid-edit.

Also `parseInt('0', 10) === 0` → finite → clamped to 256. Typing `0` over a `1024` value silently jumps to 256. Compare to seed UX (which the brief calls out using `''` for "random") — there's an inconsistency in mental model, but seed input lives elsewhere and uses a different control.

**Fix:**

```diff
-    if (raw === '') return min;
+    if (raw === '') return fallback;   // keep last legal value while editing
     const n = parseInt(raw, 10);
     if (!Number.isFinite(n)) return fallback;
-    return Math.max(min, Math.min(max, n));
+    if (n < min) return fallback;      // don't snap-down mid-typing "10" → "1024"
+    return Math.min(max, n);
```

Or use `onBlur` for clamping and `onChange` only for raw passthrough (preferred React pattern). Severity MIN — current behavior isn't broken, just twitchy.

---

## 8. Random seed mode + deterministic style  · **MAJ**

Brief is correct: `cover-jobs.ts:109-114` derives `seedForVariety` from `jobId` (or seed). With `seedMode: 'random'` the user expects **different** covers per retake; the *image seed* changes (`seedMode='random'` → Pollinations picks one), but the **style modifier** is still indexed by `seedForVariety = jobId hash`. New job → new `jobId` → new `styleIdx` → so style DOES change per retake. Re-run on the **same** job (rare in this UI) keeps the style. 

Sub-issue: with `seedMode: 'song'` two different songs in a multi-song bulk run share the song-derived seed only if they share `songId` — they don't, so each gets its own style. ✓

Edge case worth highlighting (MAJ): if backend ever uses `pol.seedMode === 'random'` to also bypass the style modifier (it doesn't, currently), behavior would change. The brief's concern resolves to **no bug**, but the contract is undocumented. Add a one-liner to `types.ts` PollinationsConfig.seedMode JSDoc:

```diff
-  seedMode: 'song' | 'random'; // 'song' = derive from songId for reproducibility on retake
+  seedMode: 'song' | 'random'; // 'song' = derive image seed from songId for reproducibility on retake.
+                                // Style modifier (server-side, see cover-jobs.ts) is ALWAYS keyed off jobId,
+                                // independent of this setting — so retakes vary in style even on 'song'.
```

---

## 9. Sidebar IMG row colour semantics  · **OK**

`Sidebar.tsx:60-64,173-181`:

```
const polReady = !!(polCfg && polCfg.model);
```

Anonymous tier (no apiKey) but model picked → `polReady=true` → green dot + model name. This is correct: anonymous tier works, the only requirement for a successful generation is that a model is selected. `apiKey` requirement was never strict.

States enumerated:
- toggle off → grey "off"
- toggle on, no model → yellow "no model"
- toggle on, model picked (any apiKey) → green model name

Matches the OR row's colour palette. Verdict: ✓.

---

## 10. i18n keys — used vs defined  · **OK**

Cross-referenced 5 langs against `PollinationsPanel.tsx` + `UsePollinationsToggle.tsx` + `CreatePanel.tsx:3182`.

**Defined keys (27 in en.ts, 27 each in other 4 langs):**

| Key | Used in |
|---|---|
| sectionTitle | CreatePanel.tsx:3182 |
| useToggle | UsePollinationsToggle.tsx:22,29 |
| useToggleHint | UsePollinationsToggle.tsx:20 |
| apiKey | PollinationsPanel.tsx:111 |
| optional | PollinationsPanel.tsx:112 |
| testKey | PollinationsPanel.tsx:139 |
| keyHint | PollinationsPanel.tsx:147 |
| modelPicker.search | PollinationsPanel.tsx:156 |
| modelPicker.placeholder | PollinationsPanel.tsx:183 |
| modelPicker.loading | PollinationsPanel.tsx:183,235 |
| modelPicker.refresh | PollinationsPanel.tsx:166 |
| modelPicker.refreshing | PollinationsPanel.tsx:166 |
| modelPicker.recentlyUsed | PollinationsPanel.tsx:196 |
| modelPicker.searchResults | PollinationsPanel.tsx:216 |
| modelPicker.allModels | PollinationsPanel.tsx:216 |
| modelPicker.empty | PollinationsPanel.tsx:235 |
| modelPicker.pickHint | PollinationsPanel.tsx:188 |
| width | PollinationsPanel.tsx:246 |
| height | PollinationsPanel.tsx:260 |
| dimsHint | PollinationsPanel.tsx:274 |
| seedMode | PollinationsPanel.tsx:281 |
| seedSong | PollinationsPanel.tsx:291 |
| seedRandom | PollinationsPanel.tsx:300 |
| enhance | PollinationsPanel.tsx:308 |
| nologo | PollinationsPanel.tsx:313 |
| safe | PollinationsPanel.tsx:318 |
| resetDefaults | PollinationsPanel.tsx:331 |

No orphans, no missing references. Brief said "28" — actual count is **27**. All 5 langs have parity. ✓

---

## 11. Image-only model filter  · **OK**

`client.ts:71-72`:

```
const out = obj.output_modalities;
if (Array.isArray(out) && !out.includes('image')) return null;
```

Logic: drop only when `output_modalities` exists AND lacks 'image'. Models without the field (legacy free tier returning bare strings, or objects without modalities metadata) pass through — correct conservative default.

This filters out documented video models like `ltx-2`, `nova-reel` whose `output_modalities` includes only `'video'`. ✓

Risk (NIT): if Pollinations adds e.g. `{ output_modalities: ['audio', 'image'] }` for a multimodal model, it survives. Probably fine — user can still pick it and it produces an image.

---

## 12. CreatePanel payload IIFE closure capture  · **OK**

`CreatePanel.tsx:1639-1662`. The IIFE captures `effTitle, styleWithGender, songDescription, vocalLanguage, instrumental, effCoverPrompt`. All are `const`s computed on lines `1583-1614` (within the same `submit` function scope, before line 1639 in the same synchronous tick). No async hop between definition and capture. ✓

`songDescription` is assumed defined earlier in the same scope (not shown in my excerpt) — verify on a full read, but given the build hasn't broken in practice, it's fine.

---

## 13. `effCoverPrompt || buildCoverPrompt(...)` lazy eval  · **OK**

`CreatePanel.tsx:1654-1660`: JS `||` short-circuits — if `effCoverPrompt` is a non-empty string, `buildCoverPrompt` is **not invoked** and its argument object is **not constructed** (the object literal is the function argument, only built when the call happens). Verified: when LLM-tailored prompt is present, no wasted work. ✓

Ditto `prompts.ts:13` is pure — no side effects, so there'd be no observable difference even if it were called eagerly.

---

# Severity summary

| # | Topic | Severity |
|---|---|---|
| 1 | CORS | OK |
| 2 | Models picker debounce / per-keystroke fetch | **MIN** (MAJ if 429 is hit in practice) |
| 3 | Test button copy | NIT |
| 4 | LRU dedup-at-capacity test missing | NIT |
| 5 | Style modifier split | OK |
| 6 | Multi-mount race | OK |
| 7 | clampInt empty/zero behaviour | **MIN** |
| 8 | Random seed + deterministic style — doc clarity | **MAJ** (only as doc gap) |
| 9 | Sidebar polReady semantics | OK |
| 10 | i18n keys (27, all used, parity across 5 langs) | OK |
| 11 | Image-only model filter | OK |
| 12 | CreatePanel closure capture | OK |
| 13 | `||` lazy eval of buildCoverPrompt | OK |

**Counts:** OK 8, NIT 2, MIN 2, MAJ 1, CRIT 0. Total findings 13.

Top 3 actions if shipping today:
1. Debounce `cfg.apiKey` effect in `PollinationsPanel.tsx:45-48` (~400ms).
2. JSDoc note on `seedMode` in `types.ts` re: style is jobId-keyed regardless.
3. Fix `clampInt('') → fallback` (not `min`) in `PollinationsPanel.tsx:99-104`.
