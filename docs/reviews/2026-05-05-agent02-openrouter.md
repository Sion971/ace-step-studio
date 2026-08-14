# OpenRouter Integration Review — 2026-05-05 (agent02)

Scope: commits `d8aab5bf2..HEAD` (HEAD = `6c39f42c5`).
Focus: `useOpenRouterGeneration` hook (singleton) vs per-click `new OpenRouterProvider()` in `CreatePanel.handleGenerate`, plus the `coverPrompt` schema expansion ripple.

Severity legend: **[BLOCKER]** ship-stopper · **[HIGH]** likely user-visible bug · **[MED]** subtle / partial breakage · **[LOW]** nit / future-proofing.

---

## 1. [BLOCKER] System-prompt few-shots are missing `coverPrompt` — strict schema will reject every imitating model

`app/services/llm/prompts/system_generate.en.md` and `system_format.en.md` declare in the OUTPUT FORMAT block:

```
{
  ...
  "durationSec":    integer (15–600)
  "coverPrompt":    string  ...
}
```

…but ALL four FEW-SHOT EXAMPLES in `system_generate.en.md:386-453` and both examples in `system_format.en.md:406-447` end with `"durationSec": …\n}` and **omit `coverPrompt` entirely**. Models trained on imitation (most of them) will copy the few-shot shape and produce JSON without `coverPrompt`. Combined with `SCHEMA.strict = true` (`openrouter.ts:19`) and `additionalProperties: false` + required-array (line 23), strict-mode capable models will reject server-side; non-strict models will produce JSON that fails the `REQUIRED_FIELDS` loop at `openrouter.ts:304-315` and trigger the retry — and the retry message (#2) does not name `coverPrompt` either.

Also stale: the FINAL CHECK checklists still say `All 8 fields present?`:
- `system_generate.en.md:364`
- `system_format.en.md:373`

Also stale: `system_generate.en.md:25` says "Return one JSON object with all 9 required fields" but the comment block above the table (line 23) hasn't been re-counted; the items list shows 9 — fine — but the few-shots contradict. Worse, `system_format.en.md:31` says "all 9 required fields" yet Example 2 output keeps `"durationSec": 210` as the trailing field.

**Fix shape**: append `"coverPrompt": "<concrete visual sentence>"` to every few-shot output and update both checklists' "All 8 → All 9 fields present" line.

---

## 2. [HIGH] `SCHEMA_UNSUPPORTED` retry message does NOT instruct on `coverPrompt`

`openrouter.ts:226-231`:

```ts
if (code === 'SCHEMA_UNSUPPORTED' && attempt === 0) {
  const fallback: ChatMessage[] = [
    ...messages,
    { role: 'user', content: `Match this exact JSON shape:\n${JSON.stringify(SCHEMA.schema)}` },
  ];
  return this.run(fallback, opts, 1, extra);
}
```

`JSON.stringify(SCHEMA.schema)` produces:
```
{"type":"object","additionalProperties":false,"required":["title","caption","lyrics","tags","bpm","keyScale","timeSignature","durationSec","coverPrompt"],"properties":{"title":{"type":"string"},...,"coverPrompt":{"type":"string"}}}
```
Technically `coverPrompt` is in there. **But**: this message arrives AFTER the same conversation already showed the system prompt with few-shots that omit `coverPrompt`. Many non-strict models will weight the natural-language few-shots over the JSON-Schema block. Net effect: retry still produces the same field-missing JSON, hits the second `attempt === 0` branch at `openrouter.ts:294-302` / `:304-315` — but those branches require `attempt === 0`, so on attempt 1 they immediately throw `INVALID_JSON: missing field: coverPrompt`. No further retry.

**Recommendation**: add an explicit human-readable sentence: ``Match this exact JSON shape (note `coverPrompt` is required — a 1-2 sentence English visual description of the cover; empty string `""` is allowed):\n${JSON.stringify(SCHEMA.schema)}``.

---

## 3. [HIGH] Stale custom system prompts in localStorage will permanently break OpenRouter for affected users

`storage.ts:24-25`:
```ts
systemPromptGenerate: '',
systemPromptFormat: '',
```

`prompts.ts:13-16`:
```ts
function resolveSystem(override: string | undefined, fallback: string): string {
  if (override && override.trim().length > 0) return override;
  return fallback;
}
```

Any user who edited the system prompt **before `coverPrompt` was added** has a custom string in `localStorage[acestep.llm.openrouter].systemPromptGenerate` (or `…Format`). That string still says "8 required fields" and shows few-shots without `coverPrompt`. The model produces no `coverPrompt`, schema-validation fails, retry from #2 also fails, user sees `INVALID_JSON: missing field: coverPrompt`.

Recovery path today: `LmProviderPanel.tsx:408-412` and `:448-452` show a "Reset to default" button per prompt — but only the user can find and click it.

**Options**:
- **(A)** When parsing fails with `missing field: coverPrompt`, append a one-shot fallback message: `If your output has no coverPrompt field, add "coverPrompt": "" — empty string is valid.` This rescues today's broken users without touching their edits.
- **(B)** Bump a `systemPromptVersion` field in `OpenRouterConfig`; on load if `version < 2` and `systemPromptGenerate` is non-empty, blank it (with a UI toast: "Built-in prompt updated for cover prompts — your custom edit was reset").
- **(C)** Detect the substring `"coverPrompt"` in the override; if absent, append a small instructional paragraph automatically inside `resolveSystem`.

(A) is the cheapest; (C) is the safest for users who really want their custom prompt preserved.

---

## 4. [MED] LLM may emit `coverPrompt: ""` for non-English / unusual languages, blanking the cover

`types.ts:48` permits empty string; `SCHEMA.properties.coverPrompt: { type: 'string' }` (`openrouter.ts:33`) does NOT enforce `minLength`. So strict-mode validation passes on empty.

System prompt at `system_generate.en.md:43-49` is solid: "1-2 sentences", "English only", concrete examples — for capable models (Claude, GPT-4o, DeepSeek-R1) this works.

Risk surface:
- Smaller / cheaper models (Llama 3.1 8B, Mistral 7B) often skip "long" string fields when token budget is squeezed by `maxTokens: 2000` (`storage.ts:22`) — a 200-tag caption + 200-word Russian lyrics + a real `coverPrompt` can come close.
- Non-English prompts: when user types Russian description, the model sometimes fills `coverPrompt` in Russian despite the rule. The Pollinations consumer treats it as a string and sends to the image model — Pollinations does accept non-English but quality drops. Not a bug per se, just a quality-of-life note.

`CreatePanel.tsx:1591`:
```ts
const effCoverPrompt = d?.coverPrompt || '';
```
…and `:1654`:
```ts
prompt: effCoverPrompt || buildCoverPrompt({ … }),
```

The `||` correctly falls through to the keyword default when `coverPrompt` is `""`. **Chain works**. No code change needed here, but the system prompt should explicitly say: "If you cannot tailor a visual, return empty string" — currently the prompt strongly demands a concrete sentence with no escape hatch, which pushes weak models into hallucinating generic fillers (`"A girl singing into a microphone"` — explicitly listed as BAD on line 49 of the system prompt; weak models still produce it).

---

## 5. [HIGH] `AbortController` in `handleGenerate` per-click flow is dead — pre-flight LLM cannot be cancelled

`CreatePanel.tsx:1547-1559`:
```ts
const client = new OpenRouterProvider();
const ac = new AbortController();
return await client.generate(
  { … },
  { signal: ac.signal, onEvent: () => {} },
);
```

`ac` is local to the closure; nothing ever calls `ac.abort()`. Three concrete consequences:

1. The user has **no UI affordance to cancel a per-click LLM pre-flight**. The "Cancel" button visible during streaming is `orHook.cancel` (`:2312-2322`, `:2436-2446`) — which only aborts the singleton hook, not the per-click providers.
2. If the user clicks "Создать" then immediately closes the panel / navigates away / starts a new bulk run, the previous `client.generate` continues to completion (or to the OpenRouter request timeout, which can be 60+ seconds for reasoning models). Network + token cost is incurred.
3. If the user fires `bulkCount: 10`, the chained `llmPreflightQueueRef` (line 1538) sequences each through the queue but every call is uncancellable — pressing any "stop" UI does nothing for the LLM phase.

This compounds with `waitForJobsToDrain` (line 1540): after the first track is generated, the second click waits for the first track's audio + cover. If the user gives up halfway, all remaining LLM pre-flights still fire one by one as previous jobs drain.

**Fix**: hoist the AbortController to a ref `llmPreflightAbortRef`, wire it into the existing UI cancel paths (e.g., the same control that calls `orHook.cancel`), and inside `releaseClaimedSlots` call `.abort()` so the chained `.then` early-returns on its catch.

---

## 6. [MED] `lastOpenRouterModelId` never updates in the per-click pre-flight path → backend always receives `openrouterModel: null` for Простой+OR

`CreatePanel.tsx:255`:
```ts
const [lastOpenRouterModelId, setLastOpenRouterModelId] = useState<string | null>(null);
```

Set only by `orHook.onFinal` callback (`:1100-1102`):
```ts
onFinal: (_draft: SongDraft) => {
  setLastOpenRouterModelId(llmStorage.getOpenRouter().model);
},
```

The per-click `client.generate` at `:1549-1559` does NOT update this state. Result: every Простой+OR generation submits with `openrouterModel: lastOpenRouterModelId` (`:1636`) which is either `null` (if user hasn't pressed an AI-Generate button this session) or the LAST AI-button model (which may differ from the model ACTUALLY used right now — though they read the same `cfg.model` so currently always equal).

If the backend stores this for analytics / billing reconciliation, Простой-mode rows will be NULL even though the model was used. Trivial fix:

```ts
return await client.generate(...);
// after successful await:
setLastOpenRouterModelId(llmStorage.getOpenRouter().model);
```

Or just read `llmStorage.getOpenRouter().model` directly at submission time (line 1636) — eliminates the state entirely.

---

## 7. [MED] `effBpm` / `effKeyScale` / `effDuration` fallback chain has a real edge case

`CreatePanel.tsx:1585`:
```ts
const effBpm = effectiveCustomMode && (d?.bpm || bpmRef.current) > 0 ? (d?.bpm || bpmRef.current) : bpm;
```

Two cases:

- **Per-click (Простой+OR)**: `d` is `perClickDraft` from line 1581 — it has `bpm` because schema requires it. `d.bpm > 0` ✓ → `effBpm = d.bpm`. Works.
- **Custom mode without OR pre-flight**: `d` is `null`. Expression becomes `(null || bpmRef.current) > 0`. `bpmRef.current` is whatever the user set in the form (or 0 if Auto). If the user previously triggered an AI-Generate button (orHook), `onPartial` filled `setBpm(partial.bpm)` (line 1092) ONLY if `bpmRef.current === 0`. So in subsequent clicks, the BPM that was AI-filled persists in state and `bpmRef.current`. ✓
- **Edge case — Custom mode + user typed a value, then triggered AI-Generate, then CLEARED the form to 0, then clicked Создать**: `bpmRef.current === 0`, `d === null`, `effBpm = bpm = 0`. Backend gets `bpm: 0` which (in your code) means Auto. Acceptable.

Per-language: `d?.bpm || bpmRef.current` — short-circuit `||` treats `0` as falsy, so if the LLM returned `bpm: 0` (illegal per schema but possible), it falls through to `bpmRef.current`. Defensive enough.

`effDuration` at `:1588`:
```ts
const effDuration = effectiveCustomMode && (d?.durationSec || durationRef.current) > 0 ? (d?.durationSec || durationRef.current) : duration;
```
Same shape, same conclusion. **OK as written**, just brittle.

The CRITICAL behavioral change vs `c6fdd96fe` (which was reverted into per-click): the OLD path streamed via `orHook` and filled `setBpm` / `setKeyScale` / `setStyle` etc. as it streamed → after pre-flight the form is updated and visible to the user. The NEW per-click path uses `onEvent: () => {}` (line 1558) so NOTHING fills the form. The user sees the "Простой" box then the track appears with BPM=174 from the LLM but the form's "Быстрые настройки" panel still shows BPM=Auto. **Subtle UX regression** — the form no longer reflects what was sent. Users who flip to Custom mode after generating will not see the LLM's recommendations.

If this is desired (clean Простой UX), document it. If not, reuse `orHook`'s onPartial wiring or have the per-click path call `setBpm`/etc. on success.

---

## 8. [MED] `partialJson.ts` does NOT know about `coverPrompt` — streaming preview will never show it

`app/services/llm/partialJson.ts:4-10`:
```ts
const SONG_FIELDS: (keyof SongDraft)[] = [
  'title', 'caption', 'lyrics', 'tags', 'bpm', 'keyScale', 'timeSignature', 'durationSec',
];

const STRING_FIELDS: (keyof SongDraft)[] = [
  'title', 'caption', 'lyrics', 'keyScale', 'timeSignature',
];
```

Missing: `coverPrompt` from both arrays.

Effect:
- `extractPartial(raw)` at `:157` will skip `coverPrompt` even after the model has fully emitted it.
- The `chunk` event's `partial` (`openrouter.ts:277-280`) will never have `coverPrompt`.
- `findOpenStringField` (`:139`) will not return `{name:'coverPrompt'}` either, because `STRING_FIELDS.includes('coverPrompt')` is false.

User-visible impact: today small. Nothing in the UI streams the cover prompt char-by-char (no textarea bound to it). BUT: the FINAL `JSON.parse(stripCodeFence(raw))` at `openrouter.ts:292` does pick up `coverPrompt` correctly because that's a full parse. So the per-click flow's `perClickDraft.coverPrompt` works end-to-end.

Future risk: anyone adding a "cover preview" component bound to streamed partial will silently get nothing. Add to both arrays:

```ts
const SONG_FIELDS: (keyof SongDraft)[] = [
  'title', 'caption', 'lyrics', 'tags', 'bpm', 'keyScale', 'timeSignature', 'durationSec', 'coverPrompt',
];
const STRING_FIELDS: (keyof SongDraft)[] = [
  'title', 'caption', 'lyrics', 'keyScale', 'timeSignature', 'coverPrompt',
];
```

`partial-json` itself handles arbitrary keys; the bottleneck is this whitelist.

---

## 9. [LOW] `stripCodeFence()` works fine with the new field

`openrouter.ts:136-145` is field-agnostic — it strips a leading ` ```json ` and trailing ``` `. Adding `coverPrompt` to the schema doesn't affect it. ✓

---

## 10. [LOW] Two-providers-paths divergence inventory

| Aspect | `orHook` (singleton, AI buttons) | per-click `new OpenRouterProvider()` (handleGenerate pre-flight) |
|---|---|---|
| Re-entry guard | `isBusy()` blocks (`useOpenRouterGeneration.ts:152`) | `llmPreflightQueueRef` chains via `.then` (`CreatePanel.tsx:1538`) |
| Cancellation | `cancel()` aborts (`:141`) | **none — `ac` never used** (#5) |
| onPartial | streams to form fields (`CreatePanel.tsx:1067-1099`) | `onEvent: () => {}` — silent (#7) |
| onFinal | sets `lastOpenRouterModelId` (`:1100`) | not called (#6) |
| Error UI | `GenerationStatusPanel` (`:2486`) | `console.error` only (`:1561`, `:1569`) |
| Schema retry | shared (same `provider.run`) | shared |
| `cfg.systemPromptGenerate` override | shared (#3 affects both) | shared |

Both paths spawn a separate provider per render (singleton `providerRef` in hook, `new OpenRouterProvider()` per-click), but `OpenRouterProvider` itself is stateless (config read inside `generate()` from `llmStorage` each time — `openrouter.ts:149`), so this duplication is harmless except for the `modelsCache` map which is module-level (line 53) so both share it. ✓

The big asymmetry is **error visibility**: pre-flight failures only log to console. A user with a stale custom prompt (#3) clicks Создать, sees nothing happen (the slots release, the temp song cards disappear), and gets no toast / banner. They will not know the LLM rejected their request.

**Fix**: when pre-flight fails, surface it through whatever notification channel the rest of the app uses (the existing `GenerationStatusPanel` if reachable, or a toast). At minimum show the error code.

---

## 11. [LOW] Recent commits compatibility

- `005a4e594 fix(ui): defer default-ON toggle…` — gates `setUseOpenRouter(true)` on `serverPollSeen`. Independent of the per-click flow; pending-click counter wiring (`incrementPendingClicks` / `decrementPendingClicks`) is in `handleGenerate` and `App.tsx`'s `beginPollingJob`. The default-ON effect runs on mount + after first poll only. **No interaction**, ✓.
- `c6fdd96fe fix(ui): Простой mode + OpenRouter — pre-flight…` — was the original blocking path via shared `orHook`; replaced by per-click. Confirmed via `git show c6fdd96fe`. The replacement preserves BPM/key/duration filling **into the submission payload** (#7) but loses the side-effect of streaming into the visible form fields (regression noted in #7). The original used a `setInterval`-poll on `wrappedHook.state.kind` which was racy (could miss the success transition); the new per-click `await client.generate()` resolves directly on streamDone — a structural improvement. ✓

---

## 12. [LOW] `coverPrompt` end-to-end flow trace

1. SCHEMA requires it (`openrouter.ts:23,33`) ✓
2. System prompts describe it (`system_generate.en.md:37, 41-49`) ✓ — but few-shots contradict (#1)
3. Provider returns it via final `JSON.parse` (`openrouter.ts:292`) ✓
4. Required-field loop validates it (`:304-315`) ✓
5. Per-click pre-flight captures it (`CreatePanel.tsx:1581, 1591`) ✓
6. Submission payload uses it (`:1654`) ✓
7. Empty-string fallback to `buildCoverPrompt` works (`||` at line 1654) ✓
8. Streaming-partial does NOT see it (#8) — non-blocking today

End-to-end works on capable models that ignore the few-shot omission. On weaker models, expect intermittent retries → final `INVALID_JSON: missing field: coverPrompt` errors. **Fix #1 first**, that's the unlock.

---

# Summary

- **Blockers (1)**: few-shots contradict the schema → `coverPrompt` will be missing from many models' outputs.
- **High (3)**: schema-retry message doesn't mention coverPrompt explicitly; stale custom prompts in localStorage will permanently break OR for those users with no auto-recovery; the per-click `AbortController` is dead — uncancellable LLM calls.
- **Medium (3)**: `lastOpenRouterModelId` not updated in per-click path (analytics gap); per-click flow no longer streams into form fields (UX regression vs c6fdd96fe); `partialJson.ts` whitelist missing coverPrompt (latent — no current consumer).
- **Low (3)**: `stripCodeFence` fine; two-paths inventory mostly clean except error-visibility gap; recent commits compatibility OK.

Counts: **1 BLOCKER · 3 HIGH · 3 MED · 3 LOW** (10 findings total).

Recommended order to land: #1 (prompt few-shots + checklists) → #3 (stale-prompt recovery) → #2 (retry message) → #5 (Abort wiring) → #6 (model id) → #7 (form-fill on per-click) → #8 (whitelist).
