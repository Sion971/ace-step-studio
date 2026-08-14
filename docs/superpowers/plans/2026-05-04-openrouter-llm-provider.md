# OpenRouter LLM Provider Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add OpenRouter as alternative LM backend with toggle, streaming UX, status panel, all 4 text-gen buttons routed.

**Architecture:** Independent toggle (mutually exclusive with local 5Hz LM) in `CreatePanel.tsx`. OpenRouter reached directly from browser via thin fetch+SSE client. localStorage for key/config. State machine with React reducer. Streaming with partial-JSON live-fill. No backend proxy; minimal server changes (one bug fix + one column for `openrouter_model`).

**Tech Stack:** TypeScript, React 19, Vite 6, native fetch + ReadableStream + AbortSignal, Vitest (new), partial-json (new), Express + better-sqlite3 (server).

**Spec:** `docs/superpowers/specs/2026-05-04-openrouter-llm-provider-design.md`

**Working dir:** `D:\Projects\TEMP\ACE-Step-Studio\`

---

## Phase 0 — Setup & cleanup

### Task 0.1: Bootstrap Vitest

**Files:**
- Modify: `app/package.json`
- Create: `app/vitest.config.ts`

- [ ] **Step 1:** From `app/`, install Vitest + happy-dom:
  ```bash
  cd D:/Projects/TEMP/ACE-Step-Studio/app && npm i -D vitest @vitest/ui happy-dom
  ```
- [ ] **Step 2:** Add scripts to `app/package.json`:
  ```json
  "test": "vitest run",
  "test:watch": "vitest"
  ```
- [ ] **Step 3:** Create `app/vitest.config.ts`:
  ```ts
  import { defineConfig } from 'vitest/config';
  export default defineConfig({
    test: { environment: 'happy-dom', globals: true, include: ['**/*.test.ts', '**/*.test.tsx'] },
  });
  ```
- [ ] **Step 4:** Verify: `npm test` → exits 0 ("no test files found").
- [ ] **Step 5:** Commit: `chore: add vitest test infrastructure`.

### Task 0.2: Install partial-json

- [ ] **Step 1:** `cd app && npm i partial-json`
- [ ] **Step 2:** Commit: `chore: add partial-json dependency`.

### Task 0.3: Remove Gemini key leak from vite.config.ts

**Files:**
- Modify: `app/vite.config.ts:39-40`

- [ ] **Step 1:** Delete lines 39-40 (`'process.env.API_KEY'` and `'process.env.GEMINI_API_KEY'` defines).
- [ ] **Step 2:** `npm run build` — must succeed.
- [ ] **Step 3:** Commit: `fix(security): remove Gemini API key from browser bundle defines`.

### Task 0.4: Delete dead Gemini service + dep

**Files:**
- Delete: `app/services/geminiService.ts`
- Modify: `app/package.json` (remove `@google/genai`)

- [ ] **Step 1:** `rm app/services/geminiService.ts`
- [ ] **Step 2:** Remove `"@google/genai": "^1.38.0"` from `app/package.json` dependencies.
- [ ] **Step 3:** `cd app && npm install` to update lockfile.
- [ ] **Step 4:** `npm run build` — must succeed.
- [ ] **Step 5:** Commit: `chore: remove dead geminiService and @google/genai dep`.

### Task 0.5: Update run-no-lm.bat banner

**Files:**
- Modify: `run-no-lm.bat:6` and surrounding banner block

- [ ] **Step 1:** Replace the banner text:
  - Old: `echo   ACE-Step Studio (NO LM mode)`
  - New: `echo   ACE-Step Studio (External LLM mode — local LM disabled)`
- [ ] **Step 2:** Add a hint echo line after the closing `========` banner row:
  ```bat
  echo   Configure OpenRouter API key in app settings to enable AI lyric / prompt generation.
  ```
- [ ] **Step 3:** Run `run-no-lm.bat` once, verify banner reads correctly, close.
- [ ] **Step 4:** Commit: `chore: rename no-LM mode to External LLM mode in batch banner`.

---

## Phase 1 — Backend fixes

### Task 1.1: Fix activeLmModel reset bug on pipeline restart

**Files:**
- Modify: `app/server/src/routes/generate.ts:902` (verify exact line)

- [ ] **Step 1:** Locate the unconditional reset (`activeLmModel = 'acestep-5Hz-lm-0.6B'; activeLmBackend = 'pt';`).
- [ ] **Step 2:** Replace with:
  ```ts
  activeLmModel = process.env.INIT_LLM === 'false' ? '' : 'acestep-5Hz-lm-0.6B';
  activeLmBackend = process.env.INIT_LLM === 'false' ? '' : 'pt';
  ```
- [ ] **Step 3:** Manual verify: start `run-no-lm.bat`, hit `GET /api/generate/model-status` (with auth) — `activeLmModel` should be `""`. Restart pipeline via the UI/API, hit again — still `""`.
- [ ] **Step 4:** Commit: `fix(server): preserve no-LM mode on pipeline restart`.

### Task 1.2: Persist openrouterModel on song

**Files:**
- Locate: song-row insert (likely `app/server/src/routes/generate.ts` or `app/server/src/services/generationQueue.ts`)
- Create: new SQL migration in `app/server/src/db/migrations/`
- Modify: song row mapper / API response shape
- Modify: `app/types.ts` (frontend Song type)

- [ ] **Step 1:** Find migration pattern. Likely:
  ```bash
  ls app/server/src/db/migrations/
  cat app/server/src/db/migrate.ts
  ```
- [ ] **Step 2:** Create new migration `app/server/src/db/migrations/NNNN_add_openrouter_model.sql` (NNNN = next sequence):
  ```sql
  ALTER TABLE songs ADD COLUMN openrouter_model TEXT;
  ```
- [ ] **Step 3:** Run migration: `cd app/server && npm run db:migrate`. Verify column exists:
  ```bash
  sqlite3 app/server/data/*.db "PRAGMA table_info(songs);" | grep openrouter
  ```
- [ ] **Step 4:** Find the audio-generation request handler that creates a song row (search for `INSERT INTO songs`). Add `openrouter_model` to the insert, reading from `req.body.openrouterModel || null`.
- [ ] **Step 5:** Find the song-row → JSON mapper. Add `openrouterModel: row.openrouter_model || null` to the response shape.
- [ ] **Step 6:** Add `openrouterModel?: string | null;` to the `Song` type in `app/types.ts`.
- [ ] **Step 7:** Manual verify: trigger a song-create with `{openrouterModel: "anthropic/claude-sonnet-4.5"}` via curl/Postman → row stores it; `GET /api/songs` returns it.
- [ ] **Step 8:** Commit: `feat(server): persist openrouter model id on songs`.

---

## Phase 2 — Pure logic services (TDD with Vitest)

All work under new dir `app/services/llm/`.

### Task 2.1: Type definitions

**Files:**
- Create: `app/services/llm/types.ts`

- [ ] **Step 1:** Create the file with the full type set (see spec § "Frontend LLM provider layer → types.ts" + § "Generation UX → State machine"). Includes: `SongDraftInput`, `FormatInput`, `SongDraft`, `OpenRouterConfig`, `ErrorCode`, `OpenRouterError` class, `GenStage` discriminated union, `GenEvent` interface.
- [ ] **Step 2:** `npm run build` (or `npx tsc --noEmit`) → no errors.
- [ ] **Step 3:** Commit: `feat(llm): add OpenRouter type definitions`.

### Task 2.2: Storage layer (TDD)

**Files:**
- Create: `app/services/llm/storage.test.ts`
- Create: `app/services/llm/storage.ts`

- [ ] **Step 1:** Write failing test in `storage.test.ts`. Cover: unset toggle returns null; setUseOpenRouter persists; getOpenRouter returns defaults; partial config merge; recent-models capped at 5; namespace prefix `acestep.llm.*`.
- [ ] **Step 2:** Run `npm test -- storage` → FAIL (module missing).
- [ ] **Step 3:** Implement `storage.ts` with `llmStorage` object exposing: `getUseOpenRouter`, `setUseOpenRouter`, `getOpenRouter`, `setOpenRouter`, `getRecentModels`, `pushRecentModel`, plus `DEFAULT_OR_CONFIG` constant. All keys prefixed `acestep.llm.`.
- [ ] **Step 4:** Run `npm test -- storage` → PASS.
- [ ] **Step 5:** Commit: `feat(llm): add storage layer with localStorage persistence`.

### Task 2.3: partialJson helper (TDD)

**Files:**
- Create: `app/services/llm/partialJson.test.ts`
- Create: `app/services/llm/partialJson.ts`

- [ ] **Step 1:** Write failing tests covering:
  - empty input → `{ closed: {} }`
  - closed string field → present in `closed`, next field becomes `openStringField`
  - `\n`, `\"`, `\u00e9` unescape correctly in `openStringField.valueSoFar`
  - half-escape at buffer end is withheld
  - closed array (`tags`) → `closed.tags`
  - closed integer (`bpm`) → `closed.bpm`
  - incomplete number (`{"bpm": 17`) → `closed.bpm` undefined
- [ ] **Step 2:** Run `npm test -- partialJson` → FAIL.
- [ ] **Step 3:** Implement using `partial-json` package + custom `openStringField` walker + `unescapeJsonStringPartial` helper. The walker scans for the last unclosed `"<key>": "...` and JSON-unescapes the partial content, holding any trailing half-escape (lone `\` or short `\uXXXX`).
- [ ] **Step 4:** Run `npm test -- partialJson` → PASS.
- [ ] **Step 5:** Commit: `feat(llm): add partial-JSON streaming helper with unescape`.

### Task 2.4: Copy generate prompt

**Files:**
- Create: `app/services/llm/prompts/system_generate.en.md`

- [ ] **Step 1:** Create dir, copy verbatim from user file:
  ```bash
  mkdir -p app/services/llm/prompts
  cp "/c/Users/user/Downloads/ACE_STEP_XL_AGENT_SYSTEM_PROMPT_EN.md" \
     "app/services/llm/prompts/system_generate.en.md"
  ```
- [ ] **Step 2:** Verify file is non-empty and contains the `# ROLE` and `# OUTPUT FORMAT — INVIOLABLE` sections.
- [ ] **Step 3:** Commit: `feat(llm): add system_generate prompt for ACE-Step XL agent`.

### Task 2.5: Author system_format prompt

**Files:**
- Create: `app/services/llm/prompts/system_format.en.md`

- [ ] **Step 1:** Copy `system_generate.en.md` to `system_format.en.md` as starting point.
- [ ] **Step 2:** Replace the `# ROLE` section with the REFINE-mode preamble (see spec § "prompts.ts → system_format.en.md → 1. REFINE-MODE PREAMBLE").
- [ ] **Step 3:** Replace the `# DECISION PIPELINE` section with the REFINE variant (see spec § "3. DECISION PIPELINE — REFINE VARIANT", 8 steps).
- [ ] **Step 4:** Replace the `# FEW-SHOT EXAMPLES` section with 2 refine pairs (see spec § "4. FEW-SHOT EXAMPLES — REFINE PAIRS"): RU dnb with anti-patterns input, EN ballad with prose caption input. Each shows input JSON block and expected refined output.
- [ ] **Step 5:** Keep all other sections (PHILOSOPHY, CAPTION RULES, LYRICS RULES, TAGS, BPM, KEY, TIMESIGNATURE, DURATION, TITLE, LANGUAGE HANDLING, ANTI-PATTERNS, FINAL REMINDER) verbatim from generate.
- [ ] **Step 6:** Commit: `feat(llm): add system_format prompt for refinement mode`.

### Task 2.6: prompts.ts builder (TDD)

**Files:**
- Create: `app/services/llm/prompts.test.ts`
- Create: `app/services/llm/prompts.ts`
- Modify: `app/vite-env.d.ts` (add `*.md?raw` declaration)

- [ ] **Step 1:** Add to `app/vite-env.d.ts`:
  ```ts
  declare module '*.md?raw' { const content: string; export default content; }
  ```
- [ ] **Step 2:** Write failing test for `buildGenerate` and `buildFormat`. Verify: returns 2 messages (system + user); user message contains topic/primary/language/instrumental; honors override system prompt; format embeds existing draft as JSON.
- [ ] **Step 3:** `npm test -- prompts` → FAIL.
- [ ] **Step 4:** Implement `prompts.ts`:
  ```ts
  import systemGenerateEn from './prompts/system_generate.en.md?raw';
  import systemFormatEn from './prompts/system_format.en.md?raw';

  export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string; }

  export function buildGenerate(input, systemOverride?) { ... }
  export function buildFormat(input, systemOverride?) { ... }
  ```
- [ ] **Step 5:** `npm test -- prompts` → PASS.
- [ ] **Step 6:** Commit: `feat(llm): add prompts builder with markdown imports`.

### Task 2.7: openrouterClient (TDD)

**Files:**
- Create: `app/services/llm/openrouterClient.test.ts`
- Create: `app/services/llm/openrouterClient.ts`

- [ ] **Step 1:** Write failing tests for `OpenRouterClient`:
  - 401 → throws `OpenRouterError` with code `KEY_INVALID`
  - 429 → `RATE_LIMITED`
  - 402 → `INSUFFICIENT_FUNDS`
  - 503 / 404 → `MODEL_UNAVAILABLE`
  - 400 → `SCHEMA_UNSUPPORTED`
  - `listModels` caches for 1h (calling twice within window does only 1 fetch)
  - `headers()` throws `KEY_MISSING` when apiKey is empty
- [ ] **Step 2:** `npm test -- openrouterClient` → FAIL.
- [ ] **Step 3:** Implement `openrouterClient.ts`:
  - `BASE = 'https://openrouter.ai/api/v1'`
  - Headers: `Authorization`, `HTTP-Referer: https://github.com/timoncool/ACE-Step-Studio`, `X-Title: ACE-Step Studio`, `Content-Type: application/json`
  - Methods: `listModels()`, `testKey(apiKey, model?)`, `chatCompletion(req, signal)`, `streamSse(res)` async generator
  - `mapStatus(code)` for `ErrorCode` mapping
- [ ] **Step 4:** `npm test -- openrouterClient` → PASS.
- [ ] **Step 5:** Commit: `feat(llm): add OpenRouter HTTP client with SSE streaming`.

### Task 2.8: openrouter provider (TDD)

**Files:**
- Create: `app/services/llm/openrouter.test.ts`
- Create: `app/services/llm/openrouter.ts`

- [ ] **Step 1:** Write failing tests:
  - happy path: `generate()` streams 2 chunks + final usage chunk → returns parsed `SongDraft` with all 8 fields; events fired in order: `firstChunk`, `chunk` × N, `streamDone`, `usage`
  - mid-stream sanity check: chunks contain prose (no `{`) → triggers schema fallback retry, second attempt with `json_object` succeeds
  - JSON parse failure end-of-stream → triggers parse retry; second attempt succeeds
  - both retries exhausted → throws `OpenRouterError('INVALID_JSON')`
  - missing required field in parsed JSON → throws `OpenRouterError('INVALID_JSON', 'missing field: X')`
  - abort via `AbortController` propagates and throws
- [ ] **Step 2:** `npm test -- openrouter` → FAIL.
- [ ] **Step 3:** Implement `openrouter.ts`:
  - `OpenRouterProvider` class with `generate(input, opts)` and `format(input, opts)` methods
  - Shared private `runStreamed(messages, opts, attempt = 0)`
  - SCHEMA constant with `name: 'SongDraft', strict: true, schema: { ... required: 8 fields, validators }`
  - On `attempt = 0`: use `response_format: json_schema`. On `attempt = 1`: use `json_object`.
  - SCHEMA_UNSUPPORTED catch → recursive call with attempt=1 + schema-as-text appended user message
  - SCHEMA_NONCOMPLIANT detection at byte 200: if accumulated raw doesn't start with `{`, abort + retry
  - JSON-parse failure end-of-stream: retry attempt=1 with "JSON only" appended message
  - Required-field validation on parsed result
  - Reads config from `llmStorage.getOpenRouter()`
- [ ] **Step 4:** `npm test -- openrouter` → PASS.
- [ ] **Step 5:** Commit: `feat(llm): add OpenRouter provider with generate/format and fallbacks`.

---

## Phase 3 — React layer

### Task 3.1: useOpenRouterGeneration hook

**Files:**
- Create: `app/services/llm/useOpenRouterGeneration.ts`

- [ ] **Step 1:** Implement React hook owning the state machine:
  - `useReducer<State, Action>` for `GenStage` transitions
  - `AbortController` ref
  - `OpenRouterProvider` instance ref (created once)
  - Returns: `{ state, activeOp, activePrimary, lastDraft, runGenerate(input), runFormat(input), cancel(), dismissError() }`
  - Accepts `{ onPartial?, onFinal? }` callbacks for live field-fill
  - Guards against starting a second run when not idle/success/cancelled/error
  - On abort: dispatches `{ type: 'cancelled' }` instead of `error`
- [ ] **Step 2:** Visual smoke check: import in `CreatePanel.tsx` temporarily, log `state.kind` to console, ensure no React errors.
- [ ] **Step 3:** Commit: `feat(llm): add useOpenRouterGeneration hook`.

### Task 3.2: UseOpenRouterToggle component

**Files:**
- Create: `app/components/UseOpenRouterToggle.tsx`

- [ ] **Step 1:** Build a small toggle following the existing `thinking` toggle pattern at `CreatePanel.tsx:2848`. Props: `value: boolean`, `onChange: (v: boolean) => void`. Uses i18n key `lmProvider.useOpenRouter` with fallback "Use OpenRouter".
- [ ] **Step 2:** Commit: `feat(ui): add OpenRouter toggle component`.

### Task 3.3: LmProviderPanel component

**Files:**
- Create: `app/components/LmProviderPanel.tsx`

- [ ] **Step 1:** Build the panel:
  - State: local `cfg` synced with `llmStorage` on every change (useEffect)
  - API key field with show/hide eye icon + Test button (calls `OpenRouterClient.testKey`); status pill (idle/testing/ok/fail)
  - Model picker: searchable input. On focus or non-empty query, drops a list of:
    - "Recently used" pinned (from `llmStorage.getRecentModels()`)
    - filtered models from `OpenRouterClient.listModels()`, each row showing name, ctx length, $/M in/out
    - clicking a model sets `cfg.model` and pushes to recent
  - 7 sliders via `EditableSlider`: Temperature, Top P, Top K, Min P, Frequency penalty, Presence penalty, Repetition penalty (with proper min/max from spec table; `autoLabel={undefined}` for negative-range knobs)
  - 2 number inputs: Max tokens, Seed (empty = random → null)
  - Collapsible System prompt textarea (chevron toggle, default collapsed)
- [ ] **Step 2:** Manual smoke: render in CreatePanel temporarily, paste a fake key, click Test, observe red pill (auth fail expected).
- [ ] **Step 3:** Commit: `feat(ui): add OpenRouter settings panel`.

### Task 3.4: GenerationStatusPanel component

**Files:**
- Create: `app/components/GenerationStatusPanel.tsx`

- [ ] **Step 1:** Build status panel that switches on `state.kind`:
  - **idle**: returns null
  - **connecting**: spinner + "Connecting to OpenRouter…" + Cancel button
  - **streaming**: spinner + "Generating…" + elapsed timer (re-renders every 100 ms via `setInterval`) + bytes counter + indeterminate progress bar + collapsible `<details>` raw preview pre block + Cancel
  - **parsing**: spinner + "Validating response…"
  - **success**: green check + "Done · Tokens: X in / Y out · $Z.ZZZZ" — auto-dismiss after 5 s via setTimeout
  - **cancelled**: × icon + "Cancelled" — auto-dismiss after 1.5 s
  - **error**: red × + i18n-mapped error message + Retry button + Copy details (clipboard) + manual dismiss ×
- [ ] **Step 2:** Smoke: render with mock states, verify each variant looks correct.
- [ ] **Step 3:** Commit: `feat(ui): add generation status panel`.

---

## Phase 4 — Wire CreatePanel + SongList

### Task 4.1: CreatePanel toggle + state wiring

**Files:**
- Modify: `app/components/CreatePanel.tsx`

- [ ] **Step 1:** Imports near top:
  ```ts
  import { UseOpenRouterToggle } from './UseOpenRouterToggle';
  import { LmProviderPanel } from './LmProviderPanel';
  import { GenerationStatusPanel } from './GenerationStatusPanel';
  import { useOpenRouterGeneration } from '../services/llm/useOpenRouterGeneration';
  import { llmStorage } from '../services/llm/storage';
  ```
- [ ] **Step 2:** Add state near other useState hooks (~line 200):
  ```ts
  const [useOpenRouter, setUseOpenRouter] = useState<boolean>(() => {
    const stored = llmStorage.getUseOpenRouter();
    return stored ?? false;
  });
  const [lastOpenRouterModelId, setLastOpenRouterModelId] = useState<string | null>(null);
  ```
- [ ] **Step 3:** Add effects:
  ```ts
  useEffect(() => {
    if (llmStorage.getUseOpenRouter() === null && !activeLmModel) {
      setUseOpenRouter(true); // default ON when no local LM is active
    }
  }, [activeLmModel]);

  useEffect(() => { llmStorage.setUseOpenRouter(useOpenRouter); }, [useOpenRouter]);
  ```
- [ ] **Step 4:** Initialize hook with field-fill callbacks (rules from spec § "Field-mapping rules" + § "Live field fill"):
  ```ts
  const orHook = useOpenRouterGeneration({
    onPartial: (partial, openField) => {
      if (partial.title) setTitle(partial.title);
      // ... rest of mapping per spec table (op × primary)
    },
    onFinal: (draft) => {
      setLastOpenRouterModelId(llmStorage.getOpenRouter().model);
      // any final-only field application (e.g., last-word lyrics commit)
    },
  });
  ```
- [ ] **Step 5:** Smoke: render the page, no console errors, toggle initial value correct.
- [ ] **Step 6:** Commit: `feat(ui): add OpenRouter toggle state to CreatePanel`.

### Task 4.2: handleAiGenerate / handleFormat branches

**Files:**
- Modify: `app/components/CreatePanel.tsx:967-998` and `:1001-1077`

- [ ] **Step 1:** At top of `handleAiGenerate`:
  ```ts
  if (useOpenRouter) {
    orHook.runGenerate({
      topic: style,
      primary: target === 'style' ? 'caption' : 'lyrics',
      language: vocalLanguage || 'en',
      instrumental: target === 'style' ? instrumental : false,
      durationSec: duration > 0 ? duration : undefined,
    });
    return;
  }
  ```
- [ ] **Step 2:** At top of `handleFormat`:
  ```ts
  if (useOpenRouter) {
    orHook.runFormat({
      caption: style, lyrics,
      bpm: bpm > 0 ? bpm : undefined,
      durationSec: duration > 0 ? duration : undefined,
      keyScale: keyScale || undefined,
      timeSignature: timeSignature || undefined,
      language: vocalLanguage || 'en',
      primary: target === 'style' ? 'caption' : 'lyrics',
    });
    return;
  }
  ```
- [ ] **Step 3:** Commit: `feat(ui): route text-gen buttons to OpenRouter when toggle is on`.

### Task 4.3: Per-button loaders + cancel-on-active

**Files:**
- Modify: `app/components/CreatePanel.tsx:1977-2110` (button blocks)

- [ ] **Step 1:** Add derived booleans near the buttons:
  ```ts
  const isGenLyricsActive = isGeneratingLyrics || (orHook.activeOp === 'generate' && orHook.activePrimary === 'lyrics');
  const isFmtLyricsActive = isFormattingLyrics || (orHook.activeOp === 'format' && orHook.activePrimary === 'lyrics');
  const isGenStyleActive  = isGeneratingStyle  || (orHook.activeOp === 'generate' && orHook.activePrimary === 'caption');
  const isFmtStyleActive  = isFormattingStyle  || (orHook.activeOp === 'format' && orHook.activePrimary === 'caption');
  const orRunning = orHook.activeOp !== null;
  ```
- [ ] **Step 2:** Replace the 4 buttons' className/disabled/onClick to use these derived values:
  - className `text-pink-500` when its derived active
  - disabled when its derived active OR (orRunning AND not its turn)
  - onClick: if `useOpenRouter && (its derived active)` → `orHook.cancel()`, else existing handler
  - icon: when derived active AND useOpenRouter, render a stop icon (e.g., `<Square size={14} />` from lucide-react) instead of Wand2/Sparkles
- [ ] **Step 3:** Smoke: visually confirm the 4 buttons toggle states and the active one shows stop icon during a run.
- [ ] **Step 4:** Commit: `feat(ui): per-button loaders and cancel for OpenRouter runs`.

### Task 4.4: Toggle + LmProviderPanel + LM Parameters visibility

**Files:**
- Modify: `app/components/CreatePanel.tsx` around `:2766` (LM Model select) and the LM Parameters Expert block

- [ ] **Step 1:** Insert toggle and conditional panel right before the existing LM Model `<select>`:
  ```tsx
  <UseOpenRouterToggle value={useOpenRouter} onChange={setUseOpenRouter} />

  {!useOpenRouter && (
    <div className="space-y-1.5">
      <label className="text-xs ...">{t('lmModelLabel')}</label>
      <select value={lmModel} onChange={...}>...</select>
    </div>
  )}

  {useOpenRouter && <LmProviderPanel />}
  ```
- [ ] **Step 2:** Find the "LM Parameters" Expert block (search for `lmTemperature` JSX usage near `showLmParams`). Wrap it:
  ```tsx
  {activeLmModel !== '' && (
    /* existing LM Parameters Expert block */
  )}
  ```
- [ ] **Step 3:** Smoke: in `run.bat` mode, toggle ON → local select hidden, panel shown, LM Params still visible (because activeLmModel is set). In `run-no-lm.bat` mode, toggle ON → local select hidden, LM Params hidden.
- [ ] **Step 4:** Commit: `feat(ui): conditionally render local-LM controls vs OpenRouter panel`.

### Task 4.5: GenerationStatusPanel mount + payload extension

**Files:**
- Modify: `app/components/CreatePanel.tsx`

- [ ] **Step 1:** Place `<GenerationStatusPanel>` below the buttons row (or near the bottom of the lyrics/style block — wherever fits visually):
  ```tsx
  <GenerationStatusPanel
    state={orHook.state}
    onCancel={orHook.cancel}
    onRetry={() => { /* re-trigger last op — store last input on a ref and replay */ }}
    onDismiss={orHook.dismissError}
  />
  ```
  Implement Retry: keep a ref `lastRunInput.current = { op, input }` updated in `runGenerate`/`runFormat` wrappers; Retry calls the same.
- [ ] **Step 2:** In the audio-generation payload (around line 1349, where `startGeneration` is called), add:
  ```ts
  openrouterModel: lastOpenRouterModelId,
  thinking: !activeLmModel ? false : thinking,
  ```
- [ ] **Step 3:** Add a small disabled chip near the Thinking switch when `!activeLmModel`:
  ```tsx
  {!activeLmModel && <span className="text-[10px] text-zinc-500" title="Requires local LM — run with run.bat">no LM</span>}
  ```
- [ ] **Step 4:** Smoke: toggle ON, click Generate Lyrics → status panel goes idle→connecting→streaming→success or error.
- [ ] **Step 5:** Commit: `feat(ui): mount status panel and extend audio payload with openrouterModel`.

### Task 4.6: SongList tooltip extension

**Files:**
- Modify: `app/components/SongList.tsx:680`

- [ ] **Step 1:** Replace the `title` attribute on the model badge `<span>`:
  ```tsx
  title={[
    `DiT: ${song.ditModel || '?'}`,
    `LM: ${song.lmModel || '?'} (${song.lmBackend || '?'})`,
    song.openrouterModel ? `Text: openrouter (${song.openrouterModel})` : null,
  ].filter(Boolean).join(' | ')}
  ```
- [ ] **Step 2:** Smoke: hover over a song badge that has `openrouterModel` set → tooltip includes `Text: openrouter (anthropic/claude-...)`.
- [ ] **Step 3:** Commit: `feat(ui): show OpenRouter model in song badge tooltip`.

---

## Phase 5 — i18n

### Task 5.1: Add i18n keys to all 5 language files

**Files:**
- Modify: `app/i18n/en.ts`, `app/i18n/ru.ts`, `app/i18n/zh.ts`, `app/i18n/ja.ts`, `app/i18n/ko.ts` (and `app/i18n/translations.ts` if it has a typed key union)

- [ ] **Step 1:** Locate the existing key union or translation object structure. Look at `app/i18n/translations.ts` and one language file to learn the pattern.
- [ ] **Step 2:** Add the keys from spec § "i18n":
  - `lmProvider.useOpenRouter`
  - `lmProvider.apiKey`, `lmProvider.testKey`, `lmProvider.testOk`, `lmProvider.testFailed`
  - `lmProvider.modelPicker.search`, `lmProvider.modelPicker.context`, `lmProvider.modelPicker.pricing`, `lmProvider.modelPicker.recentlyUsed`
  - `lmProvider.temperature`, `lmProvider.topP`, `lmProvider.topK`, `lmProvider.minP`, `lmProvider.frequencyPenalty`, `lmProvider.presencePenalty`, `lmProvider.repetitionPenalty`, `lmProvider.maxTokens`, `lmProvider.seed`, `lmProvider.systemPrompt`
  - `aiGenerate.button`, `aiGenerate.cancel`, `aiGenerate.retry`, `aiGenerate.copyDetails`
  - `aiGenerate.status.connecting`, `aiGenerate.status.streaming`, `aiGenerate.status.parsing`, `aiGenerate.status.success`, `aiGenerate.status.cancelled`
  - `aiGenerate.usage.tokens`, `aiGenerate.usage.cost`, `aiGenerate.preview.toggle`
  - `aiGenerate.error.KEY_MISSING`, `KEY_INVALID`, `RATE_LIMITED`, `INSUFFICIENT_FUNDS`, `MODEL_UNAVAILABLE`, `SCHEMA_UNSUPPORTED`, `SCHEMA_NONCOMPLIANT`, `INVALID_JSON`, `TIMEOUT`, `NETWORK`, `UNKNOWN`
- [ ] **Step 3:** Translate each key into all 5 languages. EN first, then RU translation reasonable, then ZH/JA/KO can be machine-translated and lightly cleaned.
- [ ] **Step 4:** `npm run build` → no TS errors (the key union must accept all new keys).
- [ ] **Step 5:** Commit: `feat(i18n): add OpenRouter provider keys for 5 languages`.

---

## Phase 6 — Smoke testing

### Task 6.1: Manual smoke per spec

Run each scenario from spec § "Manual smoke test":

- [ ] **Step 1:** Scenario 1 — `run-no-lm.bat`:
  - Banner reads "External LLM mode"
  - App opens with toggle ON by default (assuming localStorage clean)
  - Paste OpenRouter API key, pick a model
  - Click each of the 4 buttons (Generate Lyrics, Format Lyrics, Generate Style, Format Style)
  - Status panel shows: connecting → streaming with raw preview + elapsed timer + the relevant primary field streaming live → parsing → success with token usage
  - Fields populated per the field-mapping table
  - Click main Generate → audio renders (Thinking is forced off, chip is shown)
- [ ] **Step 2:** Scenario 2 — Cancel mid-stream on each of the 4 buttons → status goes cancelled → already-filled fields stay → user can edit and click Generate normally.
- [ ] **Step 3:** Scenario 3 — Concurrent buttons: while a run is in flight via one button, the other three buttons are disabled and the active one shows a stop icon; clicking it cancels.
- [ ] **Step 4:** Scenario 4 — Force errors:
  - Invalid key → red error UI with `KEY_INVALID` → "Open settings" or panel scroll
  - Offline (disable network) → `NETWORK` error
  - Pick a small/local model that rejects strict schema → `SCHEMA_UNSUPPORTED` or `SCHEMA_NONCOMPLIANT` → schema-fallback retry succeeds transparently
- [ ] **Step 5:** Scenario 5 — `run.bat`:
  - Toggle defaults OFF → all four buttons hit the local LM unchanged
  - Flip ON → local LM dropdown disappears, OpenRouter panel appears, all four buttons hit OpenRouter; LM Params Expert block stays visible (because activeLmModel is set)
  - Flip OFF → local LM dropdown reappears with previous selection intact, all four buttons hit local LM again
- [ ] **Step 6:** Hover a song generated via OpenRouter in `SongList` → tooltip includes `Text: openrouter (<model>)`.

### Task 6.2: Build verification & final commit

- [ ] **Step 1:** Run all tests: `cd app && npm test` → all PASS.
- [ ] **Step 2:** Build production: `cd app && npm run build` → succeeds, no warnings about missing modules.
- [ ] **Step 3:** Build server: `cd app/server && npm run build` → succeeds.
- [ ] **Step 4:** Run `git log --oneline | head -30` — confirm tidy commit history.

---

## Notes for the implementer

- **Don't restructure CreatePanel.tsx** — it's 3600+ lines, make surgical edits only.
- **All test commands run from `app/`** (`npm test`).
- **Server tests are not bootstrapped** — Phase 1 changes are verified manually.
- **Frontend dev:** `npm run dev` from `app/`. Server dev: `npm run dev` from `app/server/`.
- **EditableSlider for negative ranges:** pass `autoLabel={undefined}` so `min` is not labeled "Auto" (the component does that by default).
- **lucide-react** is the icon set already in use — pick from there (`Loader2`, `Check`, `X`, `Eye`, `EyeOff`, `Copy`, `RefreshCw`, `Square`, `ChevronDown`, `ChevronRight`).
- **localStorage namespace:** all new keys MUST start with `acestep.llm.` to avoid clashing with existing keys (`ace-songDescription`, `ace-lyrics`, etc.).
- **CORS:** OpenRouter explicitly supports browser CORS — no proxy needed.
- **Cost tracking:** OpenRouter responses sometimes contain `usage.cost`. When absent, leave `costUsd` null; UI hides the cost line in that case.
- **Mid-stream sanity check window:** 200..250 chars. Smaller = false positives on slow first chunk; larger = wasted bandwidth before fallback.
- **Spec is the source of truth.** If a code snippet here conflicts with current file state, reconcile with the spec, not the snippet.

---

## File map

**New files:**
- `app/services/llm/types.ts`
- `app/services/llm/storage.ts` + `.test.ts`
- `app/services/llm/partialJson.ts` + `.test.ts`
- `app/services/llm/prompts.ts` + `.test.ts`
- `app/services/llm/prompts/system_generate.en.md`
- `app/services/llm/prompts/system_format.en.md`
- `app/services/llm/openrouterClient.ts` + `.test.ts`
- `app/services/llm/openrouter.ts` + `.test.ts`
- `app/services/llm/useOpenRouterGeneration.ts`
- `app/components/UseOpenRouterToggle.tsx`
- `app/components/LmProviderPanel.tsx`
- `app/components/GenerationStatusPanel.tsx`
- `app/vitest.config.ts`
- `app/server/src/db/migrations/NNNN_add_openrouter_model.sql`

**Modified files:**
- `app/package.json` (deps: + vitest, + happy-dom, + partial-json, − @google/genai)
- `app/vite.config.ts` (remove API_KEY/GEMINI_API_KEY defines)
- `app/vite-env.d.ts` (add `*.md?raw`)
- `app/types.ts` (add `Song.openrouterModel`)
- `app/components/CreatePanel.tsx` (toggle, panels, button branches, payload)
- `app/components/SongList.tsx` (tooltip line 680)
- `app/i18n/{en,ru,zh,ja,ko}.ts` (+ keys)
- `app/i18n/translations.ts` (key union if present)
- `app/server/src/routes/generate.ts` (line 902 fix + persist openrouter_model on song)
- `run-no-lm.bat` (banner)

**Deleted files:**
- `app/services/geminiService.ts`

---

## Phase order rationale

0 → 1 → 2 → 3 → 4 → 5 → 6 — each phase builds on the previous and is independently testable.
- Phase 0 cleans technical debt before adding new code.
- Phase 1 fixes a server bug that the frontend depends on for default toggle.
- Phase 2 builds pure logic with full TDD; can run in isolation.
- Phase 3 builds React components; can be smoke-tested standalone.
- Phase 4 wires everything into the existing app.
- Phase 5 i18n is mechanical, last to avoid churn.
- Phase 6 verifies end-to-end.
