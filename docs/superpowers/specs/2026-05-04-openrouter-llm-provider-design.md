# OpenRouter LLM Provider — Design Spec

**Date:** 2026-05-04
**Status:** Draft → pending user approval
**Author:** Claude (brainstorming session)

## Goal

Add OpenRouter as **the alternative LM backend** in ACE-Step Studio, switched via
a single toggle that is **mutually exclusive** with the local 5Hz LM. When
OpenRouter is ON, **every existing text-generation button in CreatePanel** routes
through OpenRouter instead of the local LM:

| Button (icon)        | Today calls                       | When toggle ON, calls            |
|----------------------|-----------------------------------|----------------------------------|
| Generate Lyrics (Wand2, line 1979)  | `generateApi.createSample` | `provider.generate({primary:'lyrics'})` |
| Format Lyrics (Sparkles, line 1987) | `generateApi.formatInput`  | `provider.format({primary:'lyrics'})`   |
| Generate Style (Wand2, line 2099)   | `generateApi.createSample` | `provider.generate({primary:'caption'})`|
| Format Style (Sparkles, line 2107)  | `generateApi.formatInput`  | `provider.format({primary:'caption'})`  |

Each button keeps its current position, icon, and disabled-state logic. Only the
underlying call swaps. Local-LM controls (`lmModel` select, LM Parameters Expert
block) are hidden while toggle is ON.

In **no-LM mode** (`run-no-lm.bat` / `INIT_LLM=false`), the toggle defaults to ON
— that mode is now effectively "External-LLM mode". `run-no-lm.bat` is updated
to reflect this in its banner / hint text.

**Important coupling: text vs audio LM.** OpenRouter handles only the four
**text-generation buttons**. ACE-Step's audio pipeline still uses the local
LM at audio-generate time when `thinking=true` (and the related CoT flags are
true). The interaction is:

- `INIT_LLM=true` + toggle ON  → text via OpenRouter, audio via local LM. All
  audio features (thinking/CoT) remain available. Local LM Parameters Expert
  block stays visible (it tunes the local LM that's still being used for
  audio).
- `INIT_LLM=false` + toggle ON  → text via OpenRouter, audio without LM. The
  UI must **force `thinking=false`** when sending audio generation, and show a
  small disabled chip on the Thinking switch with tooltip "Requires local LM
  — run with `run.bat` to enable". Same for CoT-related flags.
- toggle OFF in either mode → no behavior change.

Non-goal: changing anything inside the Python pipeline. No Gemini — the dead
`app/services/geminiService.ts` AND the `process.env.API_KEY` / `GEMINI_API_KEY`
defines in `vite.config.ts` (lines 39-40) are removed as part of this work
(they currently leak any configured key into the browser bundle).

## HTTP layer

A thin **`fetch`-based client** in `app/services/llm/openrouterClient.ts`,
hitting the OpenAI-compatible OpenRouter REST API at
`https://openrouter.ai/api/v1`. Uses native browser `fetch`, `AbortSignal`,
and `ReadableStream` for SSE parsing. No external SDK dependency.

Why not `@openrouter/sdk`: that package is ESM-only and ships Node-style
polyfills that may not tree-shake cleanly under Vite (the existing
`vite.config.ts` already has to special-case `@ffmpeg/*` for similar
reasons). A thin REST client over OpenRouter's stable v1 API is ~150 lines,
has zero bundling risk, and exposes every parameter we want without
dependency churn. We get TypeScript types from our own
`OpenRouterChatRequest` / `OpenRouterChatResponse` definitions.

If, during implementation, the SDK turns out to bundle cleanly and ergonomics
win, swapping the client behind the existing `OpenRouterProvider` interface is
trivial — but the spec's contract is fetch.

## Where it plugs in

Existing LM controls live in `app/components/CreatePanel.tsx` around line 2766 —
a "LM Model" `<select>` with options `acestep-5Hz-lm-0.6B / 1.7B / 4B`, plus an
"LM Parameters" Expert block (lmTemperature / lmCfgScale / lmTopK / lmTopP /
lmNegativePrompt).

**New toggle "Use OpenRouter" is added directly above the LM Model select.** When
OFF, everything looks like today (local LM dropdown + LM Parameters Expert
block). When ON:
- a new **OpenRouter Settings** sub-panel appears under the toggle,
- the local **LM Model select** is hidden (no point picking a 5Hz LM when text
  goes to OpenRouter),
- the **LM Parameters Expert block** stays visible **iff `activeLmModel !== ''`**
  (i.e., a local LM is actually loaded). When `INIT_LLM=false` it's hidden
  because there is nothing to tune. When `INIT_LLM=true` it remains visible
  because those knobs control the local LM that's still being used during
  audio generation (`thinking=true`, CoT flags). Same logic regardless of
  toggle state.

Toggle state is per-user, persisted in localStorage. **Default value** comes
from the existing `GET /api/generate/model-status` endpoint that the frontend
already polls (returns `activeLmModel`): if `activeLmModel === ''` AND
localStorage has no saved value, default ON; otherwise OFF.

## Architecture overview

OpenRouter is reached **directly from the browser** — OpenRouter's API supports
CORS so a backend proxy adds nothing useful, just latency and code. The API key
lives in **`localStorage`** (single-user portable app on user's own machine —
same threat model as any desktop app's settings file).

That keeps the change tight: **no new Express routes, no DB schema changes, no
server-side secrets handling**. Pure frontend.

The generation is a **first-class long-running operation** with a state machine,
streaming, and a dedicated status UI — not a fire-and-forget that silently
fills fields. See "Generation UX" below.

```
User toggles "Use OpenRouter" ON, fills key / model / knobs
User clicks "Generate with AI"
  → openrouter.ts: state=connecting → state=streaming
    → SDK chat.completions.create({ stream: true, response_format: json_schema, signal: abort })
    ← chunk → chunk → chunk ...   (raw JSON tokens stream in)
       ↳ GenerationStatusPanel updates: stage label, elapsed time, raw preview
       ↳ partial-JSON parser tries to extract fields as they complete and live-fills them
  → state=parsing → final SongDraft validated against schema
  → state=success: token usage + cost shown, applied to fields
User reviews / edits → clicks Generate (existing flow unchanged)
  → existing /api/generate → Python ACE-Step pipeline → audio
```

## Operations

Two OpenRouter operations cover the four buttons:

### `generate(input, primary)` — from-scratch (replaces `createSample`)

Produces a fresh `SongDraft`. Used by **Generate Lyrics** and **Generate Style**.
The `primary` field (`'lyrics' | 'caption'`) controls the field-mapping policy
(see "Field-mapping rules" below) but the underlying LLM call is the same — we
get the full `SongDraft` back so the appropriate aux fields are also available.

`input`:
```ts
{
  topic: string;          // = current `style` textarea (the user's brief)
  primary: 'lyrics' | 'caption';
  language: string;       // = vocalLanguage, default 'en'
  instrumental: boolean;  // only meaningful for 'caption' button (lyrics path forces false to match today's behavior)
}
```

JSON schema: full `SongDraft` (below).

### `format(input, primary)` — refine-existing (replaces `formatInput`)

Takes the user's current draft (caption, lyrics, optional bpm/key/etc.) and
returns a refined version. Used by **Format Lyrics** and **Format Style**.
Same `primary` semantics.

`input`:
```ts
{
  caption: string;          // current `style` textarea
  lyrics: string;           // current `lyrics` textarea
  bpm?: number;
  durationSec?: number;
  keyScale?: string;
  timeSignature?: string;
  language: string;
  primary: 'lyrics' | 'caption';
}
```

JSON schema: same `SongDraft` schema as `generate` — strict, all fields
required. The user's existing values are passed in the system prompt so the
model knows what to refine vs invent.

Both operations share the same streaming pipeline, state machine, status
panel, and error handling.

## Field naming at the API boundary

The OpenRouter `SongDraft` uses **camelCase** (`keyScale`, `timeSignature`,
`durationSec`). Today's existing endpoints use a mix:

- `generateApi.createSample` returns `keyScale`, `timeSignature`, `duration`
  (camelCase + non-suffixed `duration`).
- `generateApi.formatInput` returns `key_scale`, `time_signature`, `duration`
  (snake_case).

The `applyDraftToFields` helper accepts the OpenRouter camelCase shape; the
existing local-LM code paths are not touched (they keep their snake_case
mapping in CreatePanel.tsx:1029-1033 and 1056-1060). The two paths converge
only at the React state setters (`setKeyScale`, `setTimeSignature`, `setBpm`,
`setDuration`), which take primitives — no shared DTO.

`durationSec` (OpenRouter) is mapped to React state `duration` (seconds, same
unit) at the boundary.

## SongDraft JSON schema (canonical)

```json
{
  "name": "SongDraft",
  "strict": true,
  "schema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["title", "caption", "lyrics", "tags", "bpm", "keyScale", "timeSignature", "durationSec"],
    "properties": {
      "title": {
        "type": "string",
        "description": "Short evocative song title, 1-6 words. Must match the requested style and topic."
      },
      "caption": {
        "type": "string",
        "description": "ACE-Step audio prompt: concise comma-separated tags/phrases describing genre, mood, instrumentation, vocal style, tempo. NO full sentences, NO meta-commentary. Example: 'energetic punk rock, male vocals, 140bpm, distorted guitar, driving drums'."
      },
      "lyrics": {
        "type": "string",
        "description": "Full song lyrics with [Verse], [Chorus], [Bridge] structure markers on their own lines. Use the requested language. If instrumental=true, return literally '[Instrumental]' and nothing else."
      },
      "tags": {
        "type": "array",
        "minItems": 3,
        "maxItems": 6,
        "items": { "type": "string" },
        "description": "3-6 short style tags, e.g. 'rock', 'energetic', 'male vocals'."
      },
      "bpm": {
        "type": "integer",
        "minimum": 40,
        "maximum": 220,
        "description": "Tempo in beats per minute, plausible for the chosen style."
      },
      "keyScale": {
        "type": "string",
        "description": "Musical key with scale, e.g. 'C major', 'A minor', 'F# minor'."
      },
      "timeSignature": {
        "type": "string",
        "description": "Time signature, e.g. '4/4', '3/4', '6/8'."
      },
      "durationSec": {
        "type": "integer",
        "minimum": 15,
        "maximum": 600,
        "description": "Target song duration in seconds. Honor user hint if provided."
      }
    }
  }
}
```

## OpenRouter knobs exposed in UI

OpenRouter SDK accepts the full OpenAI-compatible parameter set. We expose the
ones that match the existing local "LM Parameters" block plus the obvious ones
every model has, so the user has the same level of control as with the local LM:

| UI knob             | OpenRouter param      | Default | Range / notes                                  |
|---------------------|-----------------------|---------|------------------------------------------------|
| Temperature         | `temperature`         | 0.9     | 0.0..2.0 slider                                |
| Top-P               | `top_p`               | 1.0     | 0.0..1.0 slider                                |
| Top-K               | `top_k`               | 0       | 0..200 input (0 = disabled)                    |
| Min-P               | `min_p`               | 0.0     | 0.0..1.0 slider                                |
| Frequency penalty   | `frequency_penalty`   | 0.0     | -2.0..2.0 slider                               |
| Presence penalty    | `presence_penalty`    | 0.0     | -2.0..2.0 slider                               |
| Repetition penalty  | `repetition_penalty`  | 1.0     | 0.0..2.0 slider                                |
| Max tokens          | `max_tokens`          | 2000    | integer input                                  |
| Seed                | `seed`                | empty   | integer input, empty = random                  |
| System prompt — Generate | (prepended message in `generate` op) | built-in default rendered as initial textarea value | editable textarea, "Reset to default" button reverts to built-in |
| System prompt — Format   | (prepended message in `format` op)   | built-in default rendered as initial textarea value | editable textarea, "Reset to default" button reverts to built-in |

Reasoning / web-search / verbosity are NOT exposed — out of scope for songwriting,
adds noise to UI. SDK still accepts them if a power-user sets a system prompt
referencing reasoning, but no dedicated UI.

## Generation UX

Generation is a real operation, not a one-shot promise. It has a state machine,
visible progress, streaming preview, cancellation, and post-run telemetry.

### State machine

```
   idle
    │  user clicks "Generate with AI"
    ▼
 connecting       (fetching first chunk from OpenRouter)
    │  first chunk
    ▼
 streaming        (chunks arriving, partial JSON parsed live)
    │  stream done
    ▼
  parsing         (final JSON.parse + schema validation)
    │  ok
    ▼
 success          (fields applied, usage/cost shown for ~5 s, then back to idle)


From any non-idle state:
   user clicks Cancel  →  cancelled  →  (after 1.5 s)  idle
   network/SDK error    →  error      →  (stays until dismissed or new run)
   parse failure        →  retry once with "JSON only" follow-up;
                           if retry also fails → error
```

State lives in a React `useReducer` keyed `generationState` inside CreatePanel
(or a dedicated `useOpenRouterGeneration` hook for testability — implementation
plan picks). State shape:

```ts
type GenStage =
  | { kind: 'idle' }
  | { kind: 'connecting'; startedAt: number }
  | { kind: 'streaming'; startedAt: number; bytesReceived: number; rawPreview: string; partial: Partial<SongDraft> }
  | { kind: 'parsing';   startedAt: number }
  | { kind: 'success';   draft: SongDraft; usage: { promptTokens: number; completionTokens: number; costUsd: number | null }; finishedAt: number }
  | { kind: 'cancelled'; finishedAt: number }
  | { kind: 'error';     message: string; code: ErrorCode; finishedAt: number };
```

### Status UI: `<GenerationStatusPanel>`

New component `app/components/GenerationStatusPanel.tsx` renders a fixed
status card right under the "Generate with AI" button (always present in DOM
when toggle is ON, content depends on state):

- **idle** — hidden.
- **connecting** — spinner + label `t('aiGenerate.status.connecting')`
  ("Connecting to OpenRouter…"). Cancel button.
- **streaming** — animated progress bar (indeterminate, no fake percentages)
  + label `t('aiGenerate.status.streaming')` ("Generating song…")
  + elapsed timer `mm:ss` since `startedAt`
  + bytes counter `1.4 KB`
  + collapsible **raw preview** (`<details>` element) showing `rawPreview`
    streaming in real time (read-only mono textarea, auto-scroll to bottom)
  + Cancel button.
- **parsing** — spinner + label `t('aiGenerate.status.parsing')`
  ("Validating response…"). No cancel (negligible duration).
- **success** — green checkmark + label `t('aiGenerate.status.success')`
  + line `Tokens: 1234 in / 5678 out · $0.0123` (cost optional, only if
    OpenRouter returned `usage.cost` or pricing is known from the cached
    `/models` payload). Auto-dismiss after 5 s, or until next run.
- **cancelled** — neutral icon + label `t('aiGenerate.status.cancelled')`,
  auto-dismiss after 1.5 s.
- **error** — red icon + the mapped error message + a "Retry" button +
  a "Copy details" button (copies `code`, `message`, model id, and last 500 chars
  of `rawPreview` to clipboard for bug reports). Stays until dismissed or
  next run starts.

The "Generate with AI" button itself becomes a **toggle**: while a run is
in-flight it shows `t('aiGenerate.cancel')` and clicking it triggers Cancel
(same effect as the panel's Cancel button — duplicate is fine, both are
discoverable).

### Live field fill via partial JSON

While streaming, the raw concatenated `delta.content` is fed into a tolerant
partial-JSON parser (small dependency `partial-json` ~3 kB or hand-rolled
balanced-brace state machine — implementation plan picks). Whenever a complete
top-level field becomes parseable (e.g. `"title": "..."` is fully closed), we
update `partial: Partial<SongDraft>` and live-apply that field to the UI:

- `title`, `caption`, `tags[]` arrive early → fill immediately, with a subtle
  "shimmer" highlight (CSS `@keyframes`, fades after 800 ms) on the field that
  was just filled.
- `lyrics` arrives last and is the longest field → its content streams into
  the lyrics textarea **character-by-character** as it's parsed (using
  `openStringField.valueSoFar` from `partialJson.ts`, JSON-unescaped so the
  user sees real newlines, not literal `\n`). Cursor stays at end while
  streaming. Half-escape sequences (`\` at end of buffer) are withheld until
  the next chunk arrives.
- Numeric fields (`bpm`, `durationSec`) and short string fields
  (`keyScale`, `timeSignature`) → fill once when complete.

If a field is not yet empty/default in the UI when its partial value arrives,
we **skip live-fill** for that field and apply only at the end via
`applyDraftToFields` (same conservative rule as before — don't clobber).

### Cancellation

`AbortController` is created at run start and passed to
`client.chat.completions.create({ signal })`. Cancel button calls
`controller.abort()`. The streaming reader breaks, the reducer transitions to
`cancelled`. Already-filled fields are **not rolled back** — the user got
partial output and can keep it.

### Error mapping (`ErrorCode`)

```ts
'KEY_MISSING'         // empty apiKey in localStorage
'KEY_INVALID'         // 401 from OpenRouter
'RATE_LIMITED'        // 429
'INSUFFICIENT_FUNDS'  // 402
'MODEL_UNAVAILABLE'   // 404 / 503 from OpenRouter
'SCHEMA_UNSUPPORTED'  // 400 unsupported_response_format → triggers schema fallback
'SCHEMA_NONCOMPLIANT' // mid-stream sanity check failed → triggers same fallback
'INVALID_JSON'        // both parse retries failed
'TIMEOUT'             // 30 s without first chunk OR 120 s total
'NETWORK'             // fetch error
'UNKNOWN'
```

Each maps to an i18n key under `aiGenerate.error.<code>` with a user-friendly
message. The "Open settings" CTA is added to the toast ONLY for `KEY_MISSING`
and `KEY_INVALID`.

### Telemetry

Per run, when finished, a single object is logged to console (dev) and kept in
an in-memory ring buffer (last 20) accessible via a debug command — no
disk/DB persistence in scope. Fields: `model, durationMs, promptTokens,
completionTokens, costUsd, finalState, errorCode?`. The "Copy details" button
on errors uses the same shape.

## Components

### 1. Frontend LLM provider layer

New directory `app/services/llm/`:

- **`types.ts`** — shared types. All `SongDraft` fields required:
  ```ts
  export interface SongDraftInput {
    topic: string;
    style?: string;
    language?: string;
    instrumental?: boolean;
    durationSec?: number;
  }

  export interface SongDraft {
    title: string;
    caption: string;
    lyrics: string;
    tags: string[];
    bpm: number;
    keyScale: string;
    timeSignature: string;
    durationSec: number;
  }

  export interface OpenRouterConfig {
    apiKey: string;
    model: string;
    temperature: number;
    topP: number;
    topK: number;
    minP: number;
    frequencyPenalty: number;
    presencePenalty: number;
    repetitionPenalty: number;
    maxTokens: number;
    seed: number | null;
    systemPromptGenerate: string;  // empty string => use built-in default from system_generate.en.md
    systemPromptFormat: string;    // empty string => use built-in default from system_format.en.md
  }
  ```

- **`openrouter.ts`** — `OpenRouterProvider`, built on `@openrouter/sdk`.
  - `generate(input, { signal, onEvent }): Promise<SongDraft>` and
    `format(input, { signal, onEvent }): Promise<SongDraft>` — the two
    operations described above. They differ only in the prompt builder used
    (`prompts.buildGenerate(input)` vs `prompts.buildFormat(input)`); the
    streaming, schema, parsing, and error paths are identical and live in
    a shared private `runStreamed(messages, onEvent, signal)` helper.
  - The hook calls one or the other based on which button was clicked.
  - Each calls the fetch client with
    `{ stream: true, response_format: { type: 'json_schema', json_schema: <SongDraft schema, strict> }, signal }`,
    iterates SSE chunks, emits events via `onEvent`:
    ```ts
    type GenEvent =
      | { type: 'firstChunk' }
      | { type: 'chunk'; raw: string; partial: Partial<SongDraft> }
      | { type: 'streamDone'; raw: string }
      | { type: 'usage'; promptTokens: number; completionTokens: number; costUsd: number | null };
    ```
    Returns the final validated `SongDraft` (or throws a typed
    `OpenRouterError` mapped to `ErrorCode`).
  - **Schema-unsupported fallback (HTTP 400)**: on `unsupported_response_format`
    or analogous error code, retry once with
    `response_format: { type: 'json_object' }` + the schema appended as text in
    the user message ("Match this exact JSON shape: …").
  - **Mid-stream sanity check** (some providers accept the request but ignore
    `strict`): after the first ~200 characters of streamed content, if the
    accumulated string does NOT start with optional whitespace then `{`, abort
    the stream, raise `SCHEMA_NONCOMPLIANT`, and trigger the same fallback as
    above on a fresh non-streaming call.
  - **JSON-parse fallback**: if final concatenated content fails to parse,
    one retry on a fresh non-stream call with `"Return JSON only, no prose"`
    appended.
  - 30 s timeout to **first chunk**, 120 s overall (both via `AbortSignal`
    racing).
  - `listModels()` — `client.models.list()`, in-memory cache 1 h.
  - `testKey(apiKey, model?)` — minimal completion with `max_tokens: 1`.
  - Headers `HTTP-Referer: https://github.com/timoncool/ACE-Step-Studio`,
    `X-Title: ACE-Step Studio` set via SDK config.

- **`prompts.ts`** — exports `buildGenerate(input)` and `buildFormat(input)`,
  each returning `ChatMessage[]` (system + user). The system-prompt bodies
  live as separate markdown files under `app/services/llm/prompts/` so they
  can be edited without touching code. Both files are authored as part of
  this implementation — no external dependency on user-provided text:

  - **`system_generate.en.md`** — copied verbatim from
    `C:/Users/user/Downloads/ACE_STEP_XL_AGENT_SYSTEM_PROMPT_EN.md`
    (production-ready ACE-Step XL agent prompt the user prepared:
    `SongDraft` schema, ROLE/OUTPUT/PHILOSOPHY sections, caption rules,
    lyrics rules, BPM/key/timeSig/duration canons, language handling,
    anti-patterns blacklist, decision pipeline, 4 few-shot examples).

  - **`system_format.en.md`** — authored from the generate prompt plus the
    refinement delta below. Concretely, the file is structured as:

    1. **REFINE-MODE PREAMBLE** (new, replaces ROLE+OUTPUT FORMAT preamble
       of the generate file):
       > You are an expert prompt engineer for ACE-Step v1.5 XL operating
       > in **REFINE mode**. The user message contains an existing draft
       > as a JSON block: `{caption, lyrics, bpm?, keyScale?, timeSignature?, durationSec?, language, instrumental, primary}`.
       > Your job is to return a polished, valid `SongDraft` JSON with all
       > 8 required fields. Fix anti-patterns, tighten the caption, polish
       > lyrics structure, and fill any missing metadata using the canons
       > below. **Preserve the user's intent** — don't change genre, mood,
       > theme, or language unless they violate the strict rules below.
       > The `primary` field tells you which side is the focus
       > (`'caption'` or `'lyrics'`); the non-primary side is improved
       > only minimally — typos, anti-pattern fixes, missing structure
       > tags. If `instrumental === true`, lyrics MUST be exactly
       > `"[Instrumental]"`. If a metadata field already has a sensible
       > value, keep it; only fill what's missing.

    2. **PHILOSOPHY / CAPTION RULES / LYRICS RULES / TAGS / BPM / KEY /
       TIME SIG / DURATION / TITLE / LANGUAGE / ANTI-PATTERNS** — all
       sections from `system_generate.en.md` re-used verbatim. These
       rules apply identically to refine.

    3. **DECISION PIPELINE — REFINE VARIANT** (new, replaces the
       generate-mode pipeline):
       > 1. Parse the input JSON block. Identify what's already present.
       > 2. Walk the anti-patterns blacklist; flag and rewrite each match
       >    found in caption or lyrics.
       > 3. Cap-tighten: ensure 18-28 well-targeted tags across 7
       >    dimensions. Drop redundancies. Add missing dimensions where
       >    relevant. Remove forbidden BPM/key/duration that leaked into
       >    caption.
       > 4. Lyrics-tighten: ensure structure tags exist on their own
       >    lines, syllable density ~6-10/line, proper UPPERCASE /
       >    parentheses use, language prefixes for non-English sections.
       >    If `primary !== 'lyrics'`, do not rewrite lines beyond
       >    fixing structure / formatting.
       > 5. Fill missing metadata using the canons (genre → BPM,
       >    mood → key, default 4/4, default 120 s).
       > 6. Final check (same checklist as generate).

    4. **FEW-SHOT EXAMPLES — REFINE PAIRS** (new, 2 examples):
       - one Russian dnb input with anti-patterns (`"caption": "edm,
         174 bpm in A minor"`, no structure tags in lyrics) → refined
         output;
       - one English ballad input with prose caption → tag-tightened
         output.
       I write these myself based on the generate examples and the
       compass artifact's research notes.

    5. **FINAL REMINDER** — same as generate, return only the JSON.

    The whole file ends up ~600 lines, structurally parallel to the
    generate file. No user input required.

  `buildGenerate(input)` returns:
  ```ts
  [
    { role: 'system', content: systemGenerateEn },
    { role: 'user',   content: renderUserPrompt('generate', input) },
  ]
  ```
  where `renderUserPrompt('generate', input)` produces a few lines like:
  ```
  topic: <input.topic>
  primary: <input.primary>           // 'lyrics' | 'caption'
  language: <input.language>          // for lyrics; caption stays English
  instrumental: <input.instrumental>
  ```

  `buildFormat(input)` returns the same shape with `system_format.en.md`
  and a user message containing the existing draft as a JSON block plus
  the same `primary` / `language` hints.

  ### Language passing — same as today's local LM

  The `language` field on `SongDraftInput` / `FormatInput` is the **direct
  analog** of today's `vocalLanguage` that the local-LM path already passes
  to the backend (CreatePanel.tsx:975, 1048; `generateApi.createSample` /
  `formatInput`). All values today's UI accepts (`en`, `ru`, `zh`, `ja`,
  `ko`, `es`, `de`, `fr`, `pt`, `it`, plus the rest of ACE-Step's ~50
  supported languages) flow through OpenRouter the same way:

  ```ts
  // Generate Lyrics button — same value pulled from the same React state:
  orHook.runGenerate({
    topic: style,
    primary: 'lyrics',
    language: vocalLanguage || 'en',   // ← same expression as today, line 975
    instrumental: false,
  });
  ```

  The model honors `language` for `lyrics` generation. Whether `caption`
  also takes that language is decided by the **system prompt's
  language-handling rules** — the prompt the user pastes into
  `system_generate.en.md` / `system_format.en.md` owns this policy. The
  user's current EN prompt instructs caption to stay English (ACE-Step
  convention — the model was trained on English tags); editing that single
  rule in the markdown file flips the behavior without any code changes.

  In short: architecture passes the language exactly like today; prompt
  decides what to do with it. Multi-language generation is fully
  preserved.

- **`partialJson.ts`** — helper that takes the (possibly truncated) raw JSON
  string and returns `{ closed: Partial<SongDraft>, openStringField?: { name: keyof SongDraft, valueSoFar: string } }`.
  - `closed` contains top-level fields whose closing `"` (string) or
    `}` / `]` (object/array) has already arrived — these are committed.
  - `openStringField` exposes the **currently-streaming string field** with
    its value-so-far **fully JSON-unescaped** (e.g. `\n` → real newline,
    `\"` → `"`, `\\u00e9` → `é`, half-escapes withheld until complete) so
    the UI can paste it character-by-character into the lyrics textarea
    without the user seeing literal `\n` or broken Unicode escapes.
  - Uses the `partial-json` npm package (`~3 kB`, currently 0.1.7) for the
    base parser; the unescape logic is a small wrapper. If `partial-json`
    proves stale during implementation, swap to a hand-rolled
    balanced-brace state machine — interface stays.

- **`useOpenRouterGeneration.ts`** — React hook owning the state machine,
  `AbortController`, event subscription to the provider, and field-fill
  side effects. Returns:
  ```ts
  {
    state: GenStage;
    runGenerate(input: GenerateInput): void;   // wired to Wand2 buttons
    runFormat(input: FormatInput): void;        // wired to Sparkles buttons
    cancel(): void;
    dismissError(): void;
    activeOp: 'generate' | 'format' | null;     // for UI labelling
    activePrimary: 'lyrics' | 'caption' | null; // for spinner placement on the right button
  }
  ```
  Only one run is in flight at a time. Calling `runGenerate`/`runFormat`
  while non-idle is a no-op (the buttons are also disabled in that case).
  `activePrimary` lets each button render its loader only when ITS run is
  active (Wand2 on lyrics spins only for `runGenerate({primary:'lyrics'})`;
  the other three buttons are disabled).

- **`storage.ts`** — typed wrappers over localStorage:
  ```ts
  export const llmStorage = {
    getUseOpenRouter(): boolean | null,   // null = unset, fall back to server signal
    setUseOpenRouter(v: boolean): void,
    getOpenRouter(): OpenRouterConfig,
    setOpenRouter(cfg: Partial<OpenRouterConfig>): void,
    getRecentModels(): string[],          // last 5 OpenRouter model IDs
    pushRecentModel(id: string): void,
  };
  ```
  All keys prefixed `acestep.llm.*`.

### 2. CreatePanel changes

`app/components/CreatePanel.tsx`:

- **New toggle** `<UseOpenRouterToggle>` rendered just above the LM Model
  `<select>` (~line 2766). Initial value:
  - if localStorage has a saved value, use it,
  - else if server signals no local LM is loaded (existing sync — server-side
    `activeLmModel === ''`), default ON,
  - else default OFF.

- **When toggle is OFF** — render the existing LM Model select and
  LM Parameters Expert block exactly as today. No behavior change.

- **When toggle is ON** — hide the LM Model select and the LM Parameters Expert
  block, render `<LmProviderPanel>` in their place.

- **New `<LmProviderPanel>` sub-component** in
  `app/components/LmProviderPanel.tsx`:
  - **API key** — password input + "Test" button (calls
    `OpenRouterProvider.testKey`); green/red pill with the result. Field shows
    `••••••last4` when a key is already saved.
  - **Model picker** — searchable combobox sourced from
    `OpenRouterProvider.listModels()`. Each row: model name, context length,
    $/M tokens (prompt + completion). "Recently used" pinned to top
    (last 5, in localStorage).
  - All 9 knobs from the table above, each persisted via `llmStorage`.
  - Sliders use the existing `EditableSlider` component
    (`app/components/EditableSlider.tsx`). For knobs whose `min` value is
    legitimate (e.g. `frequencyPenalty`, `presencePenalty` at -2; `topP`,
    `repetitionPenalty` not at min by default), `autoLabel` is left
    `undefined` so the slider does not mislabel `min` as "Auto".
  - **Two collapsible System-prompt textareas** ("System prompt — Generate"
    and "System prompt — Format"), each rendered with the **full default
    text already visible** (loaded from `?raw` import of
    `system_generate.en.md` / `system_format.en.md`):
    ```tsx
    const valueGen = cfg.systemPromptGenerate || DEFAULT_GENERATE_PROMPT;
    <textarea
      value={valueGen}
      onChange={e => setCfg({ ...cfg, systemPromptGenerate: e.target.value })}
      rows={20}
      className="w-full bg-white dark:bg-black/40 border rounded px-2 py-1 text-xs font-mono"
    />
    <button onClick={() => setCfg({ ...cfg, systemPromptGenerate: '' })}
            className="text-[10px] text-zinc-500 hover:text-pink-500">
      Reset to default
    </button>
    ```
    `cfg.systemPromptGenerate === ''` means "use built-in default" (the
    textarea then displays `DEFAULT_GENERATE_PROMPT` via the
    `||` fallback). Any non-empty value is the user's override and is
    forwarded to `prompts.buildGenerate(input, cfg.systemPromptGenerate)`.
    Same wiring for `systemPromptFormat`.

- **All four existing buttons** (`handleAiGenerate('lyrics' | 'style')`,
  `handleFormat('lyrics' | 'style')`) are refactored to branch on the
  toggle:
  ```ts
  const handleAiGenerate = (target: 'style' | 'lyrics') => {
    if (useOpenRouter) {
      orHook.runGenerate({
        topic: style,
        primary: target === 'style' ? 'caption' : 'lyrics',
        language: vocalLanguage || 'en',
        instrumental: target === 'style' ? instrumental : false,
      });
      return;
    }
    /* existing createSample call, unchanged */
  };

  const handleFormat = (target: 'style' | 'lyrics') => {
    if (useOpenRouter) {
      orHook.runFormat({
        caption: style,
        lyrics,
        bpm: bpm > 0 ? bpm : undefined,
        durationSec: duration > 0 ? duration : undefined,
        keyScale: keyScale || undefined,
        timeSignature: timeSignature || undefined,
        language: vocalLanguage || 'en',  // deliberate: passed for both
                                          // 'lyrics' and 'style' targets,
                                          // unlike today's local path which
                                          // omits language for the lyrics
                                          // target (CreatePanel.tsx:1011-
                                          // 1033). Minor improvement.
        primary: target === 'style' ? 'caption' : 'lyrics',
      });
      return;
    }
    /* existing formatInput call, unchanged */
  };
  ```
- **Per-button loader** — the existing `isGeneratingLyrics` /
  `isFormattingLyrics` / `isGeneratingStyle` / `isFormattingStyle` booleans
  are replaced (in OpenRouter branch) by derived values from the hook:
  ```ts
  const isGeneratingLyricsOR = activeOp === 'generate' && activePrimary === 'lyrics';
  // analogous for the other three
  ```
  When toggle is OFF, the existing booleans drive the icons (no change). The
  button-disabled logic also gains `state.kind !== 'idle'` to prevent
  starting a second run.
- **Cancel** — while a run is in flight, the icon on the active button
  switches from `Wand2`/`Sparkles` to a stop icon and clicking it triggers
  `orHook.cancel()`. The other three buttons are disabled (so cancellation
  is unambiguous).
- Below the lyrics/style block, `<GenerationStatusPanel>` renders whenever
  `state.kind !== 'idle'`, regardless of which button started the run.

### 3. Field-mapping rules (`applyDraftToFields`)

The helper signature: `applyDraftToFields(draft, { op, primary, currentValues })`.
The combination of `op` and `primary` reproduces today's per-button behavior so
no UX shifts when toggling between local LM and OpenRouter:

| `op`     | `primary` | Field policy |
|----------|-----------|--------------|
| generate | lyrics    | **set** lyrics; aux `bpm/keyScale/timeSignature/durationSec` set only if currently empty/default; do NOT overwrite caption |
| generate | caption   | **set** caption (`style` field); aux as above; do NOT overwrite lyrics |
| format   | lyrics    | **set** lyrics; aux as above; do NOT overwrite caption |
| format   | caption   | **set** caption AND set lyrics (matches today's `formatInput` style-target which returns both); aux as above |

`title` and `tags` from the draft are accepted but only applied if a
corresponding UI field exists today. In CreatePanel they currently don't —
so they're stored on the hook's last-result object for potential future use,
not silently dropped (debug telemetry includes them).

"Empty/default" means: `bpm === 0`, `duration <= 0`, `!keyScale`,
`!timeSignature`. **Exact** predicates from today's existing code at
`CreatePanel.tsx:986-991` — including `<= 0` for duration (not `=== -1`),
because today's code accepts `0` as "unset" too. The same predicates apply
both during streaming live-fill and at the final `applyDraftToFields` pass.

### `tags` field vs `caption`-as-CSV

Today's `caption` (the audio prompt) IS already a comma-separated tag list by
convention. The OpenRouter `SongDraft` adds an explicit `tags: string[]`
field on top of `caption`. The prompt for both `generate` and `format` must
instruct the model to:
1. produce `caption` as the full ACE-Step prompt (genre + mood + vocals +
   tempo descriptors, comma-separated),
2. produce `tags` as a 3-6-item subset of style descriptors only.

These are NOT duplicates — `caption` is the audio-pipeline input,
`tags` is metadata for future UI use (categorization, search). Today
CreatePanel has no `tags` field; the value is stored on the hook's last-result
object and surfaces only in debug telemetry. This is a deliberate
forward-compat field, not dead weight.

Live field-fill during streaming uses the same predicates per chunk (see
"Generation UX → Live field fill via partial JSON"), so the policy is
consistent during and after streaming.

### 4. Server signal for default toggle state — and a server-side bug to fix

`GET /api/generate/model-status` already returns `activeLmModel` (frontend
already polls it at `CreatePanel.tsx:402`). When `process.env.INIT_LLM === 'false'`,
`activeLmModel` is initialised to `''` at `generate.ts:889` — perfect signal.

**Server bug to fix as part of this work** (`app/server/src/routes/generate.ts:902`):
on pipeline restart, `activeLmModel` is unconditionally reset to
`'acestep-5Hz-lm-0.6B'`. This silently flips the OpenRouter toggle default OFF
mid-session in NO-LM mode. The reset must respect `process.env.INIT_LLM`:

```ts
// generate.ts:902 — replace unconditional reset with:
activeLmModel = process.env.INIT_LLM === 'false' ? '' : 'acestep-5Hz-lm-0.6B';
activeLmBackend = process.env.INIT_LLM === 'false' ? '' : 'pt';
```

### 5. `run-no-lm.bat` update

Update **only the user-facing strings**, no logic changes:

- Banner: `ACE-Step Studio (NO LM mode)` → `ACE-Step Studio (External LLM mode — local LM disabled)`.
- Add an echo line after the banner:
  `Configure your OpenRouter API key in the app settings to enable AI lyric / prompt generation.`

The existing `set "INIT_LLM=false"` already does what we need; the frontend
reads it via the server signal above.

### 6. i18n

The project uses **TypeScript modules**, not JSON. Add keys to all 5 language
packs in `app/i18n/{en,ru,zh,ja,ko}.ts` (and update the typed key union /
`translations.ts` if there is one):

- `lmProvider.useOpenRouter.toggle`,
- `lmProvider.apiKey`, `lmProvider.testKey`, `lmProvider.testOk`,
  `lmProvider.testFailed`,
- `lmProvider.modelPicker.search`, `lmProvider.modelPicker.context`,
  `lmProvider.modelPicker.pricing`, `lmProvider.modelPicker.recentlyUsed`,
- One label per UI knob in the table above (`lmProvider.temperature`,
  `lmProvider.topP`, `lmProvider.topK`, `lmProvider.minP`,
  `lmProvider.frequencyPenalty`, `lmProvider.presencePenalty`,
  `lmProvider.repetitionPenalty`, `lmProvider.maxTokens`,
  `lmProvider.seed`, `lmProvider.systemPrompt`),
- `aiGenerate.button`, `aiGenerate.cancel`,
- `aiGenerate.status.connecting`, `aiGenerate.status.streaming`,
  `aiGenerate.status.parsing`, `aiGenerate.status.success`,
  `aiGenerate.status.cancelled`,
- `aiGenerate.usage.tokens`, `aiGenerate.usage.cost`,
  `aiGenerate.preview.toggle`, `aiGenerate.retry`, `aiGenerate.copyDetails`,
- `aiGenerate.error.KEY_MISSING`, `aiGenerate.error.KEY_INVALID`,
  `aiGenerate.error.RATE_LIMITED`, `aiGenerate.error.INSUFFICIENT_FUNDS`,
  `aiGenerate.error.MODEL_UNAVAILABLE`,
  `aiGenerate.error.SCHEMA_UNSUPPORTED`, `aiGenerate.error.INVALID_JSON`,
  `aiGenerate.error.TIMEOUT`, `aiGenerate.error.NETWORK`,
  `aiGenerate.error.UNKNOWN`.

Flat keys, matching the existing 750+ key style.

## Files touched

**New:**
- `app/services/llm/types.ts`
- `app/services/llm/openrouterClient.ts`  (thin fetch + SSE wrapper)
- `app/services/llm/openrouter.ts`         (provider with `generate`/`format`)
- `app/services/llm/prompts.ts`
- `app/services/llm/prompts/system_generate.en.md`  (verbatim copy of the
  user's `ACE_STEP_XL_AGENT_SYSTEM_PROMPT_EN.md`)
- `app/services/llm/prompts/system_format.en.md`    (authored during this
  work using the structure laid out above; derived from the generate
  prompt + compass-artifact research; no further user input needed)
- `app/services/llm/storage.ts`
- `app/services/llm/partialJson.ts`
- `app/services/llm/useOpenRouterGeneration.ts`  (React hook)
- `app/components/LmProviderPanel.tsx`
- `app/components/UseOpenRouterToggle.tsx`
- `app/components/GenerationStatusPanel.tsx`
- Tests for each above.

**Reference (not in repo, kept by user):**
- `C:/Users/user/Downloads/ACE_STEP_XL_AGENT_SYSTEM_PROMPT_EN.md` — source
  for `system_generate.en.md`.
- `C:/Users/user/Downloads/ACE_STEP_XL_AGENT_SYSTEM_PROMPT.md` — RU mirror,
  kept by user for reference.
- `C:/Users/user/Downloads/compass_artifact_wf-bd4eef76-2bc6-412c-8772-8190d810d76c_text_markdown.md`
  — ACE-Step XL deep-research; informs the prompt and any future tuning.

**Modified:**
- `app/components/CreatePanel.tsx` — add toggle, conditional render of
  local-LM controls vs OpenRouter panel, wire AI generation through the
  toggle, pass `openrouterModel` in audio-generation payload when present.
- `app/components/SongList.tsx` — extend the model-badge tooltip on line 680
  with `Text: openrouter (<model>)` when `song.openrouterModel` is set.
- Backend: extend the song-row schema (e.g., `generation_params.openrouterModel`
  or new `openrouter_model TEXT NULL` column) and the create-song API to
  accept and persist it. The audio-generation route at
  `app/server/src/routes/generate.ts` is the right entry point — minimal
  change, decided in the implementation plan.
- `app/i18n/{en,ru,zh,ja,ko}.ts` (5 files) and `app/i18n/translations.ts` if
  it owns a typed key union — new keys.
- `run-no-lm.bat` — banner / hint text update.
- `app/package.json` — add `partial-json` dependency; **remove** `@google/genai`
  (no longer used after Gemini deletion).
- `app/vite.config.ts` — **remove** the `process.env.API_KEY` and
  `process.env.GEMINI_API_KEY` defines (lines 39-40); they currently leak any
  configured Gemini key into the browser bundle.
- `app/server/src/routes/generate.ts` — fix the `activeLmModel` reset at line
  902 to respect `process.env.INIT_LLM` (see "Server signal" section).
- One of the existing settings/sync endpoints — expose
  `serverInitLlm: boolean` if not already inferable. (One-line change to
  `app/server/src/routes/settings.ts` defaults or the existing pipeline-state
  route, decided in the implementation plan.)

**Deleted:**
- `app/services/geminiService.ts` — dead code, no consumers; not replaced.
  The matching `vite.config.ts` `define` for `process.env.API_KEY` /
  `GEMINI_API_KEY` is also removed (above).

**Untouched (important):**
- All Python under `ACE-Step-1.5/`.
- Express auth.
- `run.bat` — keeps working.
- Local LM and its UI knobs when `activeLmModel !== ''`.

## Persisting OpenRouter model id on songs

`SongList.tsx:680` already renders a model badge with a hover tooltip:

```tsx
<span title={`DiT: ${song.ditModel || '?'} | LM: ${song.lmModel || '?'} (${song.lmBackend || '?'})`}>
  {getModelDisplayName(song.ditModel)}
</span>
```

We extend this tooltip with the OpenRouter info when a song's text was
generated via OpenRouter:

```tsx
title={[
  `DiT: ${song.ditModel || '?'}`,
  `LM: ${song.lmModel || '?'} (${song.lmBackend || '?'})`,
  song.openrouterModel ? `Text: openrouter (${song.openrouterModel})` : null,
].filter(Boolean).join(' | ')}
```

To make this work end to end:

1. **Frontend**: when `useOpenRouter` is ON and a text-generation run
   succeeds, the hook stores the model id used for that run in
   `lastOpenRouterModelId` (CreatePanel state). When `handleGenerate` fires
   the audio-generation payload (`startGeneration`, line 1349), it includes
   `openrouterModel: lastOpenRouterModelId || null`.
2. **Backend**: the existing audio-generation route accepts the new field
   and persists it on the song row. Concretely, the songs table already
   stores `generation_params` (or equivalent JSON column) — we add
   `openrouterModel` there. If no such column exists, we add one
   (`openrouter_model TEXT NULL`) — the implementation plan picks the
   minimal-impact location.
3. **API/types**: the `Song` type gets `openrouterModel?: string | null`.
4. **`SongList.tsx:680`**: tooltip extended as above.

If a song was made entirely without OpenRouter (toggle was OFF for that
session), `openrouterModel` is null → no extra line in the tooltip → today's
behaviour is unchanged.

## Out of scope (explicit YAGNI)

- Gemini provider (deleted, not replaced)
- Streaming responses
- Tool / function calling
- Reasoning / web-search / verbosity UI knobs
- Custom OpenAI-compatible base URLs (self-hosted vLLM, etc.)
- Replacing local LM inside the Python pipeline
- Multi-message chat / conversation memory
- Sync of OpenRouter settings across devices — localStorage by design

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Some OpenRouter models reject strict JSON-schema | Picker only enables strict mode; on `400 unsupported_response_format` from SDK we retry once with `response_format: { type: 'json_object' }` + a "match this schema" message |
| Model returns malformed JSON | Tolerant parse + 1 retry with "JSON only, no prose" |
| Key in localStorage | Acceptable for a local portable app; password-input UI with masked display; never logged |
| Tiny-context model can't fit lyrics | Picker shows `context_length`; user picks accordingly |
| Cost surprise from expensive models | Picker shows $/M tokens; default `max_tokens` capped at 2000 |
| Future CORS change at OpenRouter | SDK is one import; backend proxy can be added later without touching UI |

## Testing

- Unit tests for `prompts.ts` (golden snapshot of rendered prompts for a
  representative input).
- Unit tests for `openrouter.ts` with the `@openrouter/sdk` client mocked:
  - success path: chunks emit `firstChunk` → multiple `chunk` → `streamDone` → `usage`,
  - schema-unsupported fallback retry,
  - JSON parse retry,
  - 5xx retry,
  - first-chunk timeout (30 s),
  - overall timeout (120 s),
  - abort via `AbortController`,
  - missing key,
  - all-fields-present validation of parsed `SongDraft`,
  - error mapping for each `ErrorCode`.
- Unit tests for `partialJson.ts`: incomplete strings, mid-array, mid-string,
  escapes; only fully-closed top-level fields surface.
- Unit tests for `useOpenRouterGeneration.ts` with provider mocked: full
  state-machine transitions, cancel mid-stream leaves partial fields,
  parse-failure retry path, error states stay until dismissed.
- Unit test for `storage.ts`: roundtrip + namespace prefix + toggle defaults.
- Component test for `LmProviderPanel.tsx`: API-key entry, Test button, model
  picker filtering, all 9 knobs persist.
- Component test for `UseOpenRouterToggle.tsx`: respects localStorage, then
  server signal, then OFF default; switching ON hides local-LM controls.
- Component test for `GenerationStatusPanel.tsx`: renders correct UI for
  each state, Cancel triggers hook, "Copy details" copies the right payload,
  "Retry" re-runs with same input.
- Manual smoke test (documented):
  1. `run-no-lm.bat` → banner reads "External LLM mode" → app opens with
     toggle ON by default → paste key → pick a model → for each of the
     four buttons (Generate Lyrics, Format Lyrics, Generate Style, Format
     Style): click → status panel shows connecting → streaming with raw
     preview + elapsed timer + the relevant primary field streaming live
     into its textarea → parsing → success with token usage → fields
     populated per the field-mapping table → click Generate → audio
     renders.
  2. Cancel mid-stream on each of the four buttons → status goes
     cancelled → already-filled fields stay → user can edit and click
     Generate normally.
  3. While a run is in flight via one button, the other three buttons are
     disabled and the active one shows a stop icon; clicking it cancels.
  4. Force errors: invalid key → red error UI with code → "Open settings"
     CTA expands the panel; offline → NETWORK error; pick a model that
     rejects strict schema → schema fallback retry succeeds transparently.
  5. `run.bat` → toggle defaults OFF → all four buttons hit the local LM
     unchanged → flip ON → local LM dropdown disappears, OpenRouter panel
     appears, all four buttons hit OpenRouter → flip OFF → local LM
     dropdown reappears with previous selection intact, all four buttons
     hit local LM again.
