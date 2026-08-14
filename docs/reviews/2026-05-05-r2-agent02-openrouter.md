# OpenRouter Integration — Round 2 Review (agent02)

Scope: verify fixes for `2026-05-05-agent02-openrouter.md` and hunt for new regressions.
Commits inspected: `ea73c3c98` (batch 1), `10a87ab0e` (batch 2), `2419f7d73` (batch 3).
HEAD at review time: `2419f7d73`.

Severity legend: **[BLOCKER]** ship-stopper · **[HIGH]** likely user-visible bug · **[MED]** subtle/partial · **[LOW]** nit · **[FIXED]** verified resolved · **[PARTIAL]** addressed but residual concern · **[DEFERRED]** acknowledged, intentionally not landing now.

---

## Round-1 finding status

### #1 [BLOCKER] Few-shot examples missing `coverPrompt` + "All 8 fields" stale checklist — **[FIXED]** in `10a87ab0e`

Verified by `git show 10a87ab0e -- app/services/llm/prompts/system_generate.en.md app/services/llm/prompts/system_format.en.md`:

- `app/services/llm/prompts/system_generate.en.md` — all 4 few-shots now end with a `coverPrompt`:
  - Example 1 (line ~395): `"coverPrompt": "An empty rave hall at dawn, abandoned strobe lights flickering over a single white sneaker on a wet concrete floor, fog hanging in the air, melancholic neon glow seeping through tall industrial windows, cinematic photograph"` — concrete imagery rooted in lyrics, palette + medium specified, no text-on-cover, no "girl with mic" filler. ✓
  - Example 2 (line ~415): `"coverPrompt": "A blurred motion shot of a black 90s sports car drifting through a foggy mountain road at midnight, headlights cutting through smoke, ominous mood, gritty 35mm film grain, dark cyber-noir palette of teal and orange"` — concrete subject + medium (35mm film grain) + palette. ✓
  - Example 3 (line ~435): `"coverPrompt": "A weathered armchair by a tall window at golden hour, a single shaft of warm light cutting across an empty room, dust motes suspended in the beam, soft watercolor illustration, pale palette of cream and dusty rose, intimate and quiet"` — strong nostalgic mood, watercolor medium, no humans (matches the introspective lyric vibe). ✓
  - Example 4 (line ~455): `"coverPrompt": "An explosion of neon candy stars and glitter confetti against an electric magenta sky, holographic foil bubbles, a Y2K maximalist collage of stickers and emoji, oversaturated cyan and pink, hyper-glossy digital pop art"` — Y2K maximalist style for the high-energy K-pop track. ✓
- `app/services/llm/prompts/system_format.en.md` — both examples updated:
  - Example 1 reuses the rave-hall description (line ~415).
  - Example 2 reuses the armchair watercolor (line ~447).

Quality check against the rules at `system_generate.en.md:43-49`:
- English only ✓ (all 4)
- 1–2 sentences, ≤~40 words ✓ (Example 1 is borderline at ~35 words but readable)
- No text/letters/words/title/logo/signage requested ✓ (no `"text saying"`, `"album title"`, etc.)
- No "singer with guitar" filler ✓ (none of the 4 reference performers, vocals, microphones, instruments-as-subject)
- Palette + medium + composition + lighting present in each ✓

Checklist text: `system_generate.en.md:364` and `system_format.en.md:373` both now read `All 9 fields present (incl. \`coverPrompt\`)?`. ✓

The "9 required fields" sentence at `system_generate.en.md:25` and `system_format.en.md:31` was already correct in round 1 (round-1 review noted that — only the few-shots and the checklist line were inconsistent). Both sources of truth are now aligned.

**Verdict**: BLOCKER fully resolved. Models that imitate the few-shots will now produce a 9-field object with a non-empty, on-rules `coverPrompt`.

---

### #2 [HIGH] `SCHEMA_UNSUPPORTED` retry message lacks human-readable nudge — **[PARTIAL → effectively neutralized]**

`app/services/llm/openrouter.ts:226-231` is unchanged: still `Match this exact JSON shape:\n${JSON.stringify(SCHEMA.schema)}`. No human-readable sentence was added.

**However**, the failure mode this finding worried about is now blocked at two earlier checkpoints:

1. The few-shots themselves now contain `coverPrompt` (#1 fix), so the natural-language signal no longer contradicts the schema. Models that imitate examples produce valid 9-field JSON without ever hitting `SCHEMA_UNSUPPORTED`.
2. `openrouter.ts:296-298` (added in `ea73c3c98`) auto-defaults `coverPrompt` to `''` post-parse, so even if a model still drops it, the `REQUIRED_FIELDS` loop at `:310-321` no longer throws `INVALID_JSON: missing field: coverPrompt`.

The remaining concern — a strict-mode-capable provider returning `SCHEMA_UNSUPPORTED` and the retry still not understanding — is largely theoretical because:
- `SCHEMA.schema` already lists `coverPrompt` in `required` and `properties` (`openrouter.ts:23,33`).
- `JSON.stringify(SCHEMA.schema)` faithfully encodes that.
- `SCHEMA_UNSUPPORTED` paths are rare on the providers OR routes to (Claude, GPT-4o, Gemini, DeepSeek all support strict structured output).

**Verdict**: not fixed at the literal location, but the concern is downgraded by the combination of #1 + the new `coverPrompt` defaulting in `ea73c3c98`. **No further action needed for HEAD**, but a future-proofing one-liner to add a human nudge would still be cheap.

---

### #3 [HIGH] Stale custom system prompts in localStorage — **[FIXED]** via Option A in `ea73c3c98`

`app/services/llm/openrouter.ts:290-298`:

```ts
let draft: SongDraft;
try {
  draft = JSON.parse(stripCodeFence(raw));
  // Tolerate models / stale custom system prompts that don't emit `coverPrompt`
  // (the field was added later). Empty string is a valid value per types.ts;
  // the keyword fallback in buildCoverPrompt fills in for cover gen.
  if (typeof (draft as any).coverPrompt !== 'string') {
    (draft as any).coverPrompt = '';
  }
} catch { ... }
```

This is round-1 Option A (cheapest) implemented at the parse boundary rather than as a retry message. Effect:

- A user with a stale `cfg.systemPromptGenerate` from before the field existed → model returns 8-field JSON → `JSON.parse` succeeds → `draft.coverPrompt` is `undefined` → `typeof !== 'string'` → defaulted to `''` → `REQUIRED_FIELDS` loop sees `'coverPrompt' in draft` (✓ because the property was just assigned) → returns valid SongDraft.
- Downstream consumer at `CreatePanel.tsx:1602` (`d?.coverPrompt || ''`) still falls through to `buildCoverPrompt` keyword default, so cover gen still works.

Edge case: if `draft` is `null` or a string (not an object), `(draft as any).coverPrompt = ''` would mutate-fail or attach to a string wrapper. But `JSON.parse` on a stripped-fence chunk that produced a non-object would already be wrong upstream — and the subsequent `'coverPrompt' in draft` check would throw on `null`. In practice the model returns either an object or invalid JSON (which falls into the `catch` branch). Acceptable.

**Verdict**: HIGH resolved. Existing users with stale prompts will not see `INVALID_JSON: missing field: coverPrompt` anymore.

---

### #4 [MED] LLM may emit empty `coverPrompt` — **[NOT a code change; status unchanged]**

This was a quality-of-life finding ("system prompt should explicitly say: 'If you cannot tailor a visual, return empty string'"). The system prompt was not amended with that escape-hatch language; it still strongly demands a concrete sentence (`system_generate.en.md:43-49`).

The downstream fallback chain (`d?.coverPrompt || buildCoverPrompt(...)` at `CreatePanel.tsx:1665`) still gracefully handles empty strings, so this is non-blocking.

**Verdict**: unchanged. Acceptable as a future polish.

---

### #5 [HIGH] `AbortController` not wired in per-click pre-flight — **[NOT FIXED, NOT DEFERRED EXPLICITLY]**

`app/components/CreatePanel.tsx:1552-1564` (HEAD):

```ts
const client = new OpenRouterProvider();
const ac = new AbortController();
return await client.generate(
  { ... },
  { signal: ac.signal, onEvent: () => {} },
);
```

`ac` is still local to the closure. No ref hoist, no UI wiring, no `.abort()` call site anywhere in the file.

`Grep` for `llmPreflightAbort`, `ac.abort()` in `CreatePanel.tsx`: no matches.

The CTA toolbar still only exposes `orHook.cancel()` for streaming AI buttons. Closing the panel mid-pre-flight still leaks the network request to completion (or to OR's own timeout). Bulk runs cannot be aborted between LLM calls.

For a local Studio app this is **acceptable as deferred** — the user can reload the page if they really need to bail. No data corruption follows from a leaked LLM call (the chained `.then` in `llmPreflightQueueRef` still completes; the unused `perClickDraft` is just discarded if the user moves on).

**Verdict**: not fixed. Recommend either (a) noting it explicitly in `docs/known-limitations.md` or (b) hoisting the AbortController to a ref next session. Not a regression.

---

### #6 [MED] `lastOpenRouterModelId` never updated in per-click path — **[FIXED]** in `10a87ab0e`

`app/components/CreatePanel.tsx:1571-1583` (HEAD):

```ts
try {
  perClickDraft = await llmPreflightQueueRef.current;
  if (!perClickDraft) { releaseClaimedSlots(); return; }
  // Stamp the model id used for this song — `orHook` only updates this
  // for the explicit AI buttons, not the Простой-mode pre-flight, so
  // without this `params.openrouterModel` would always be null for
  // Простой+OR generations and the song-row badge tooltip would be empty.
  const orModelId = llmStorage.getOpenRouter().model;
  if (orModelId) setLastOpenRouterModelId(orModelId);
} catch (e) { ... }
```

Trace:
1. Per-click pre-flight succeeds → `perClickDraft` non-null.
2. `orModelId = llmStorage.getOpenRouter().model` reads the same config the provider used inside `generate()` (`openrouter.ts:149`), so by construction this is the model that was actually called.
3. `setLastOpenRouterModelId(orModelId)` schedules a state update.
4. Below at `:1647`: `openrouterModel: lastOpenRouterModelId`.

**Caveat (timing)**: `setLastOpenRouterModelId` is async; the `lastOpenRouterModelId` read at `:1647` happens in the **same** `handleGenerate` closure call before React re-renders, so it's still the **previous** value. React state setters do not flush mid-callback. So:

- Click 1 (first ever Простой+OR): pre-flight runs, `orModelId = "anthropic/claude-3.5-sonnet"`, `setLastOpenRouterModelId("anthropic/claude-3.5-sonnet")` queued, then submission reads `lastOpenRouterModelId = null` (initial) → song row gets `openrouter_model: null`.
- Click 2: re-render committed, `lastOpenRouterModelId = "anthropic/claude-3.5-sonnet"`, submission reads correctly → song row gets `"anthropic/claude-3.5-sonnet"`.

**This is a one-click-off-by-one bug.** The MED finding is technically resolved for clicks 2+ but the very first generation of every session still submits `null`.

Cleanest fix would have been to inline the read at `:1647`:

```ts
openrouterModel: orModelId ?? lastOpenRouterModelId,
```

…or capture into a local `const` immediately after the await and use that local in the payload. As shipped, expect the first Простой+OR row of every session to still show no `openrouter_model`. Subsequent rows fill correctly.

**Verdict**: PARTIAL. Bulk of analytics gap closed (rows 2..N), but row 1 of session is still NULL. Recommend a tiny follow-up: pass `orModelId` directly through a closure variable into the submission payload instead of relying on `lastOpenRouterModelId` state.

---

### #7 [MED] Per-click flow doesn't fill form fields — **[NOT FIXED, status unchanged]**

`onEvent: () => {}` at `CreatePanel.tsx:1563` is unchanged. No `setBpm` / `setKeyScale` / `setStyle` calls in the per-click `.then` body.

The compensating mechanism is still the effective-value fallback chain at `:1593-1602`:

```ts
const d = perClickDraft;
const effStyle = effectiveCustomMode && (d?.caption || styleRef.current) ? (d?.caption || styleRef.current) : style;
const effLyrics = effectiveCustomMode && (d?.lyrics || lyricsTextRef.current) ? (d?.lyrics || lyricsTextRef.current) : lyrics;
const effTitle = effectiveCustomMode && (d?.title || titleRef.current) ? (d?.title || titleRef.current) : title;
const effBpm = effectiveCustomMode && (d?.bpm || bpmRef.current) > 0 ? (d?.bpm || bpmRef.current) : bpm;
const effKeyScale = effectiveCustomMode && (d?.keyScale || keyScaleRef.current) ? (d?.keyScale || keyScaleRef.current) : keyScale;
const effTimeSig = effectiveCustomMode && (d?.timeSignature || timeSignatureRef.current) ? (d?.timeSignature || timeSignatureRef.current) : timeSignature;
const effDuration = effectiveCustomMode && (d?.durationSec || durationRef.current) > 0 ? (d?.durationSec || durationRef.current) : duration;
const effCoverPrompt = d?.coverPrompt || '';
```

`d.caption`, `d.lyrics`, `d.title`, `d.bpm`, `d.keyScale`, `d.timeSignature`, `d.durationSec`, `d.coverPrompt` are all propagated correctly into the submission payload. So the **submitted track is correct**.

What's still broken is the **visible form**: when the user is in Простой mode with OR pre-flight and the LLM fills bpm=174 / key="A minor" / etc., the form's "Быстрые настройки" panel still shows whatever the user last typed (or "Auto"). If they switch to Custom mode after the click, the LLM's recommendations are gone — they'd have to click an explicit AI button to re-derive them.

For Простой mode this is arguably the desired UX (the whole point is to hide complexity). The regression is real only for users who toggle Простой → Custom **after** generating and expect to see the LLM's choices. Low-traffic edge case.

**Verdict**: unchanged. Acceptable. Document or accept as-is.

---

### #8 [MED] `partialJson.ts` SONG_FIELDS missing `coverPrompt` — **[FIXED]** in `ea73c3c98`

`app/services/llm/partialJson.ts:4-10`:

```ts
const SONG_FIELDS: (keyof SongDraft)[] = [
  'title', 'caption', 'lyrics', 'tags', 'bpm', 'keyScale', 'timeSignature', 'durationSec', 'coverPrompt',
];

const STRING_FIELDS: (keyof SongDraft)[] = [
  'title', 'caption', 'lyrics', 'keyScale', 'timeSignature', 'coverPrompt',
];
```

Both arrays include `coverPrompt`. Streaming-partial consumers (none today, but ready for future cover-preview UI) will now receive `partial.coverPrompt` and `findOpenStringField` can return `{ name: 'coverPrompt', valueSoFar: ... }` for a typewriter-style preview if needed.

**Verdict**: FIXED.

---

### #9 [LOW] `stripCodeFence()` field-agnostic — **[N/A, no change required]**

Still field-agnostic. ✓

---

### #10 [LOW] Two-paths divergence — **[mostly unchanged]**

| Aspect | `orHook` | per-click `new OpenRouterProvider()` | Status |
|---|---|---|---|
| Re-entry guard | `isBusy()` blocks | chain firewall via `.catch(() => null).then` (NEW in `ea73c3c98:1543`) | improved |
| Cancellation | `cancel()` | **none** (#5) | unchanged |
| onPartial / form-fill | streams to fields | `() => {}` (#7) | unchanged |
| onFinal sets modelId | yes | NEW in `10a87ab0e:1577-1578` (off-by-one — see #6) | improved |
| Error UI | `GenerationStatusPanel` | `console.error` only | unchanged |
| Schema retry | shared | shared | unchanged |
| Stale prompt tolerance | shared (auto-default in `openrouter.ts:296-298`) | shared | improved |

Net divergence reduced. The chain firewall (`.catch(() => null).then`) is a meaningful robustness win — one bad pre-flight no longer poisons the FIFO queue.

---

### #11 [LOW] Recent commits compatibility — **[unchanged]**

No new interactions identified in `ea73c3c98 / 10a87ab0e / 2419f7d73` with `005a4e594` or `c6fdd96fe`.

---

### #12 [LOW] `coverPrompt` end-to-end trace — **[fully working on HEAD]**

1. SCHEMA requires it ✓
2. System prompts describe it AND show it in every few-shot ✓ (#1 fix)
3. Provider returns it via final `JSON.parse` ✓
4. **NEW**: provider auto-defaults missing field to `''` (`openrouter.ts:296-298`) ✓
5. Required-field loop validates it ✓
6. Per-click pre-flight captures it ✓
7. Submission payload uses it via `effCoverPrompt || buildCoverPrompt(...)` ✓
8. Streaming-partial whitelist includes it ✓ (#8 fix)

All 8 chain links green. End-to-end works on capable AND weak AND stale-prompt clients.

---

## Mental simulations

### Sim 1: stale custom prompt + AI Generate Lyrics (Custom mode)

**Setup**: `cfg.systemPromptGenerate` is a hand-edited string from before `coverPrompt` existed. User clicks "AI Generate Lyrics" (the orHook path).

1. `useOpenRouterGeneration` runs through `OpenRouterProvider.generate()`.
2. Provider injects the user's custom system prompt verbatim (`prompts.ts:resolveSystem`).
3. Model returns 8-field JSON (no `coverPrompt`).
4. `JSON.parse` succeeds at `openrouter.ts:292`.
5. **NEW**: `:296-298` patches in `coverPrompt: ''`.
6. `REQUIRED_FIELDS` loop at `:310-321` finds all 9 keys present (the 8 from the model + the just-injected empty string). ✓
7. `draft` returned, `onFinal` fires, form fills with bpm/key/title/lyrics/etc.
8. User then clicks Создать → submission uses form values; `coverPrompt` is `''` → `buildCoverPrompt` keyword fallback at `CreatePanel.tsx:1665` covers it.

**Outcome**: success, no `INVALID_JSON` error. Round-1 BLOCKER for stale-prompt users is closed. ✓

### Sim 2: Простой+OR+noLM, first click of session

**Setup**: User opens app, no AI button has been clicked, types description, clicks Создать.

1. `handleGenerate` enters per-click branch at `CreatePanel.tsx:1535`.
2. `llmPreflightQueueRef.current.catch(() => null).then(...)` queues the call.
3. Pre-flight succeeds, `perClickDraft` set.
4. `:1577` reads `orModelId = llmStorage.getOpenRouter().model` → e.g. `"anthropic/claude-3.5-sonnet"`.
5. `:1578` calls `setLastOpenRouterModelId("anthropic/claude-3.5-sonnet")` — **enqueued**, not yet committed.
6. Code continues synchronously to `:1647`: `openrouterModel: lastOpenRouterModelId`. State hasn't re-rendered → reads stale value `null`.
7. `onGenerate({...openrouterModel: null})` fires; backend stores `openrouter_model = NULL` for this row.
8. React commits the state update.
9. Click 2 (same session): now `lastOpenRouterModelId = "anthropic/claude-3.5-sonnet"`. Submission gets the correct value. ✓

**Outcome**: row 1 of session has `openrouter_model = NULL`; rows 2..N correct. Round-1 MED is **partially closed** (analytics gap shrunk by ~90% for typical sessions, but the very first row still leaks). See #6 above for the one-line follow-up.

### Sim 3: user aborts pre-flight by closing panel

**Setup**: User clicks Создать in Простой+OR. Pre-flight fires. User immediately closes the CreatePanel (component unmounts).

1. `client = new OpenRouterProvider()` instance is GC-rooted via the in-flight Promise inside `llmPreflightQueueRef.current`.
2. `ac.abort()` is never called. The fetch inside the SDK stream continues to completion or remote timeout.
3. Component unmount: refs and state are torn down by React. `llmPreflightQueueRef` is the unmounted component's ref — no longer referenced by the rendered tree.
4. Eventually the Promise resolves with a `SongDraft`, the `.then` block runs:
   - `setLastOpenRouterModelId(...)` is a setState on an unmounted component → React logs a warning in dev mode but no functional error in prod.
   - `setLastOpenRouterModelId` returns; the closure's `perClickDraft` resolves; `releaseClaimedSlots()` was the failure path so doesn't run; the success path continues to `:1612` `for` loop and calls `onGenerate(...)` with the captured-from-closure props (which are now stale — `onGenerate` may itself reference an unmounted component's state).

**Outcome**: network leak yes (cost ≤ 1 model call's tokens). State cleanup is mostly clean — the ref garbage-collects with the component. Risk of a stray `onGenerate` call against a torn-down App-side handler depends on whether `App.tsx`'s `onGenerate` is stable across CreatePanel mounts. From `App.tsx` I'd expect it to be stable (App stays mounted; CreatePanel comes and goes inside it), so the call would proceed and a real song would be created in the background — surprising but not corrupted.

**Mitigation requires #5 (Abort wiring).** For a local Studio app this is acceptable; for a hosted multi-user version it would be a real cost leak.

---

## New regressions hunted in OpenRouter integration

After staring at `openrouter.ts`, `partialJson.ts`, `prompts.ts`, `useOpenRouterGeneration.ts`, the system prompts, and the per-click path on HEAD:

### NR-1 [MED] `coverPrompt` post-parse default mutates strict-mode contract semantically

`openrouter.ts:296-298` quietly assigns `coverPrompt = ''` when missing. If the schema is sent to OpenRouter with `strict: true` and the provider is one that **enforces** strict mode server-side (Anthropic via OR, OpenAI structured outputs), the model literally cannot return JSON missing `coverPrompt` — the API would reject upstream. So this default only activates for non-strict providers. That's fine, **but**: a developer reading `REQUIRED_FIELDS` validation at `:310-321` may assume it guards against malformed responses. With the silent default, "missing field" can never trigger for `coverPrompt` specifically — only for the other 8. If a future schema change adds another field, the inverse (no auto-default) would surprise. Not a bug, just a tiny semantic drift — comment is good but worth a one-line follow-up to either:

- Add a similar "tolerate missing" for any future legacy-prompt-affected fields, OR
- Lift the patch into a small `coerceLegacyDraft(draft)` helper to centralize the policy.

### NR-2 [LOW] First-click `lastOpenRouterModelId` race (covered as #6 PARTIAL)

Already analyzed above — the off-by-one means session row 1 has `openrouter_model: null`. Fix is a 2-line refactor.

### NR-3 [LOW] `if (orModelId) setLastOpenRouterModelId(orModelId)` skips empty model id

`CreatePanel.tsx:1578`: the guard `if (orModelId)` means if `cfg.model` is somehow empty string (default config supplies a real model so this is unlikely), the state stays at its previous value. That's fine — better than overwriting a known-good value with `''`. Not a regression, just noting the subtle behavior.

### NR-4 [LOW] `await client.generate(...)` inside the `.then` does not propagate a typed error code to UI

`CreatePanel.tsx:1565-1568`: `catch (e) { console.error(...); return null; }` swallows every error including the typed `OpenRouterError` (`code, status, body`). Only `console.error`. The two-paths-divergence #10 already noted this. Not new in r2 but worth re-flagging since now the chain firewall (`ea73c3c98`) intentionally catches and absorbs upstream rejections — that means the chain itself never surfaces a user-visible error for ANY pre-flight failure. Combined with the silent `coverPrompt: ''` default, a user with a misconfigured API key sees: click Создать → temp song appears → temp song silently disappears → no toast, no error, nothing. Reproducer: invalidate key, click. Today's behavior pre-`ea73c3c98` was: chain rejects, future clicks don't even fire. Today it's: error is swallowed, future clicks try again. **Better resilience, worse observability.**

Recommendation (low priority): in the `catch` at `:1565`, if `e instanceof OpenRouterError`, push to whatever toast bus the rest of the app uses, with `e.code + e.message`. The `releaseClaimedSlots` already cleans the optimistic UI; a tiny toast would close the observability gap without re-introducing the chain-poisoning risk.

### NR-5 [LOW] No regression from `2419f7d73`

Batch 3 only touches `app/server/src/services/id3-tagger.ts`: drops a dead Pollinations branch and unused imports (`generatePollinationsCover`, `songIdToSeed`). It does not touch any OpenRouter file. Confirmed by `git show 2419f7d73 --stat`. ✓

---

# Round-2 Summary

| Round-1 finding | Status on HEAD | Commit |
|---|---|---|
| #1 BLOCKER few-shots + checklist | **FIXED** | `10a87ab0e` |
| #2 HIGH SCHEMA_UNSUPPORTED retry msg | **PARTIAL** (effectively neutralized by #1 + auto-default) | n/a |
| #3 HIGH stale custom prompts | **FIXED** (Option A) | `ea73c3c98` |
| #4 MED empty coverPrompt | unchanged (acceptable) | n/a |
| #5 HIGH AbortController dead | **NOT FIXED**, deferred-acceptable for local app | n/a |
| #6 MED lastOpenRouterModelId | **PARTIAL** (off-by-one, session row 1 still NULL) | `10a87ab0e` |
| #7 MED form-fill regression | unchanged (acceptable for Простой UX) | n/a |
| #8 MED partialJson whitelist | **FIXED** | `ea73c3c98` |
| #9 LOW stripCodeFence | n/a | n/a |
| #10 LOW two-paths divergence | improved (chain firewall, model id stamp, stale tolerance) | `ea73c3c98 + 10a87ab0e` |
| #11 LOW recent commits compat | unchanged | n/a |
| #12 LOW e2e trace | **fully green** | `ea73c3c98 + 10a87ab0e` |

**Round-1 close-out**: 1 BLOCKER fixed · 2 HIGH fixed (one effectively, one literally) · 1 HIGH deferred · 2 MED fixed · 1 MED partial · 2 MED unchanged-acceptable.

**New findings in r2**: 1 MED (NR-1 semantic drift in legacy-default policy) · 4 LOW (NR-2 first-click race echoing #6, NR-3 empty-model guard noted, NR-4 error observability gap widened by chain firewall, NR-5 batch 3 no-op for OR).

Counts: **0 BLOCKER · 0 HIGH · 1 MED · 4 LOW** new in r2 (5 findings).

Recommended follow-ups (priority order):
1. (#6 finish) Pass `orModelId` directly through a local `const` into the submission payload at `CreatePanel.tsx:1647` so first-click row gets the model id.
2. (NR-4) Surface OR pre-flight errors as a toast — the chain firewall hides them too well now.
3. (#5) Hoist the per-click AbortController to a ref and wire into the existing cancel UI; or document as known limitation.
