# Local-LLM Path Regression Review (d8aab5bf2..6c39f42c5)

Scope: regression risk for the local LLM path — Простой mode with the local 5Hz LM (`activeLmModel='acestep-5Hz-lm-0.6B'`), Custom mode, AI Generate/Format buttons, switch-model, `/api/generate/create-sample`.

Pre-condition for the audited path: `useOpenRouter=false` (or `true` but `activeLmModel !== ''`).

Commit range: 8 commits, ~2052 line additions across 27 files (Pollinations cover-gen feature + instant temp-song cards + queue drain barrier).

---

## Summary

| Severity | Count |
|---|---|
| BLOCKER | 0 |
| MUST | 2 |
| SHOULD | 2 |
| NIT | 3 |

The local-LM path is **functional**. No code path that requires OpenRouter is reachable when `activeLmModel !== ''`. The new `llmPreflightQueueRef` / `waitForJobsToDrain` infrastructure is correctly guarded by `!customMode && useOpenRouter && !activeLmModel` (CreatePanel.tsx:1536). The Pollinations cover-gen branch in `routes/generate.ts:535-551` is correctly guarded by `pol?.enabled && pol.model && pol.prompt`, so a Простой+local-LM submission (which sends no `pollinations` field) silently skips it. `id3-tagger.fetchCoverImage(songId, undefined)` correctly falls through to the legacy picsum path (id3-tagger.ts:118-130).

The two `MUST` findings are around the new pending-click counter: the decrement is missing from one error path and the App.tsx createSample failure branch doesn't release the slot, leaving a stuck N/10 badge after LLM-not-available errors.

---

## MUST-1 — `decrementPendingClicks` not called when local-LM `createSample` fails (App.tsx)

**Severity: MUST**

**Path:** Простой mode + local LM, LLM transiently unavailable (e.g., Gradio still loading the LM after a switch-model). User clicks Создать with bulkCount=N.

CreatePanel calls `incrementPendingClicks(N)` then fires N `onGenerate` calls. Each landing in `App.tsx::handleGenerate`. The simple-mode branch awaits `generateApi.createSample(...)`. If that throws (LLM not ready), the `catch` at App.tsx:1051-1058 removes the temp song and `return`s — but does NOT decrement the pending counter. The outer `catch (e)` at line 1147-1159 (which DOES decrement) is bypassed by the early `return`.

Result: the N/10 badge sticks at N (or partial N if some calls succeeded), even though no jobs are actually pending. For bulkCount=10 with the LM still loading, the user sees a stuck "10/10" until they refresh.

**Repro steps:**
1. Простой mode, useOpenRouter=false.
2. switch-model to a different DiT (or restart), causing LM to not be ready briefly.
3. Click Создать.
4. Observe: temp card appears then disappears; badge "1/10" stuck.

**Fix:**

```diff
--- a/app/App.tsx
+++ b/app/App.tsx
@@ -1051,6 +1051,9 @@ const handleGenerate = async (params: GenerationParams) => {
         } catch (err) {
           // create_sample failed — block generation, remove temp song
           console.error('[Simple] create_sample failed:', err);
           setSongs(prev => prev.filter(s => s.id !== tempId));
+          // Release the pending-click slot — the click handed off N slots
+          // synchronously, this one never made it to beginPollingJob, so the
+          // badge would otherwise stick at N/10.
+          decrementPendingClicks(1);
           showToast('LLM not available — model may be loading or Gradio restarting. Wait and try again.', 'error');
           setIsGenerating(false);
           return;
         }
```

---

## MUST-2 — Old user-saved `systemPromptGenerate` causes `INVALID_JSON` after coverPrompt was added to the strict schema

**Severity: MUST** (affects users with custom OR system prompts; only triggers on the OR path, but reachable via AI Generate/Format buttons even when local-LM mode is active)

**Path:** AI Generate/Format buttons (Custom mode, lyrics or style). User has a custom `systemPromptGenerate` saved in localStorage from before commit `1e833ab37` / `bfc0e7527` / earlier (the schema migration that added `coverPrompt`). The persisted prompt does NOT instruct the LLM to emit `coverPrompt`.

`openrouter.ts:23` adds `coverPrompt` to `SCHEMA.schema.required`. `openrouter.ts:304-315` runs `for (const field of REQUIRED_FIELDS) { if (!(field in draft)) ... throw INVALID_JSON }`. With a custom system prompt that pre-dates this change, the LLM legitimately omits coverPrompt → first attempt retries with "include all required fields" appended (line 309) → if the LLM still doesn't know what coverPrompt should be it omits again (or invents nonsense) → throw `INVALID_JSON`.

The default prompt files (`system_generate.en.md`, `system_format.en.md`) WERE updated to mention coverPrompt — but `prompts.ts:13-16` `resolveSystem` returns the user override when non-empty, bypassing the new default entirely.

For local-LM users this only matters when they ALSO have OR enabled (useOpenRouter=true) for the AI Generate buttons — they can hit this even though their main Создать flow goes local. Not a Простой+local-LM crash, but breaks the AI Generate/Format buttons.

**Fix options (pick one):**

Option A — relax: don't fail if coverPrompt is missing, default to empty (matches the "empty string is a valid value" comment in types.ts:46-49):

```diff
--- a/app/services/llm/openrouter.ts
+++ b/app/services/llm/openrouter.ts
@@ -301,6 +301,8 @@ private async run(
     }

     for (const field of REQUIRED_FIELDS) {
+      // coverPrompt was added late — old user-customized system prompts may not produce it.
+      // Pollinations falls back to a keyword-built prompt when this is empty (CreatePanel:1591,1654).
+      if (field === 'coverPrompt' && !(field in draft)) { (draft as any).coverPrompt = ''; continue; }
       if (!(field in draft)) {
         if (attempt === 0) {
```

Option B — keep schema strict, drop coverPrompt from REQUIRED_FIELDS (still keep in JSON schema for json_schema-capable models, just not in our post-parse check):

```diff
--- a/app/services/llm/openrouter.ts
+++ b/app/services/llm/openrouter.ts
@@ -35,7 +35,9 @@ const SCHEMA = {
   },
 } as const;

-const REQUIRED_FIELDS = SCHEMA.schema.required;
+// coverPrompt is in the JSON schema (so capable models DO produce it), but we
+// don't fail post-parse if a permissive model omits it — empty string is a
+// valid value (Pollinations falls back to a keyword-built prompt).
+const REQUIRED_FIELDS = SCHEMA.schema.required.filter(f => f !== 'coverPrompt');
```

Recommended: **Option A** (still surfaces a missing field to capable models via the strict schema, but tolerates the user-prompt-override case).

---

## SHOULD-1 — `coverPrompt` missing from `partialJson.ts::SONG_FIELDS`

**Severity: SHOULD**

`partialJson.ts:4-6` lists 8 fields; `coverPrompt` was not added. The closed-field detection and `findOpenStringField` skip it, so the partial-stream view never surfaces an in-progress `coverPrompt` to the UI. Functionally OK (the UI doesn't render coverPrompt anyway), but inconsistent with `SongDraft` and the schema's required list. Will silently break if any future code reads `partial.coverPrompt`.

**Fix:**

```diff
--- a/app/services/llm/partialJson.ts
+++ b/app/services/llm/partialJson.ts
@@ -1,11 +1,11 @@
 import { parse, Allow } from 'partial-json';
 import type { SongDraft } from './types';

 const SONG_FIELDS: (keyof SongDraft)[] = [
-  'title', 'caption', 'lyrics', 'tags', 'bpm', 'keyScale', 'timeSignature', 'durationSec',
+  'title', 'caption', 'lyrics', 'tags', 'bpm', 'keyScale', 'timeSignature', 'durationSec', 'coverPrompt',
 ];

 const STRING_FIELDS: (keyof SongDraft)[] = [
-  'title', 'caption', 'lyrics', 'keyScale', 'timeSignature',
+  'title', 'caption', 'lyrics', 'keyScale', 'timeSignature', 'coverPrompt',
 ];
```

---

## SHOULD-2 — System-prompt "Final check" lists 8 fields, schema requires 9

**Severity: SHOULD** (LLM contract clarity — could cause confusing model behavior)

`system_generate.en.md:362-371` "Final check" enumerates checks but never asks the model to verify `coverPrompt`. The `Output format` section above (line 25 "all 9 required fields") was updated, but the Decision Pipeline final check still says "All 8 fields present?" — the model might self-validate against 8 fields and silently drop coverPrompt.

**Fix:**

```diff
--- a/app/services/llm/prompts/system_generate.en.md
+++ b/app/services/llm/prompts/system_generate.en.md
@@ -362,7 +362,7 @@
 **8. Final check.** Run through this checklist:
    - JSON valid?
-   - All 8 fields present?
+   - All 9 fields present (including `coverPrompt`)?
    - Caption has no BPM/key/duration?
    - Lyrics has structure tags in brackets on their own lines?
    - If instrumental, lyrics is exactly `[Instrumental]`?
```

Few-shot examples 1-4 (lines 386-453) also omit `coverPrompt` from the JSON outputs. Recommend adding it to each example so the model unambiguously learns the new field.

---

## NIT-1 — `App.tsx` simple-mode createSample call doesn't pass `lmTemperature`

**Severity: NIT**

`App.tsx:1029-1033` calls `generateApi.createSample({ query, instrumental, vocalLanguage }, token)` without forwarding `lmTemperature`. The CreatePanel's `handleAiGenerate` fork DOES forward it (CreatePanel.tsx:1132-1139). Inconsistent — the Простой Создать path always uses the backend default 0.85, regardless of user's lmTemperature slider.

Not a regression (this was the same before), but worth flagging — the new instant-card stage messages emphasize the LLM step now, and users will notice their temperature slider is being ignored.

---

## NIT-2 — Hardcoded `lmModel: 'acestep-5Hz-lm-0.6B'` in CreatePanel simple-mode payload

**Severity: NIT**

`CreatePanel.tsx:1755`: simple-mode payload hardcodes the LM model name. If user has switched to a hypothetical alternate LM via switch-model, this hardcoded value overrides it in the request body. Backend ignores it for /create_sample_from_query (which uses whatever's loaded in Gradio), but it ends up persisted in `songs.lm_model` on insert (routes/generate.ts:650), giving a misleading record.

Not a regression — same before. Suggest using `activeLmModel || 'acestep-5Hz-lm-0.6B'` and threading the active model through to CreatePanel.

---

## NIT-3 — Type assertion churn: `(params as any)._tempId`, `(params as any).pollinations`, `(params as any).openrouterModel`

**Severity: NIT**

App.tsx:993, 1134, 1136 use `as any` casts. The `GenerationParams` type doesn't declare `_tempId`, `pollinations`, `openrouterModel`. Adding these to the type would catch future drift.

---

## Findings Map

| # | Severity | File:line | Symptom |
|---|---|---|---|
| 1 | MUST | App.tsx:1051-1058 | Pending counter stuck after createSample failure (Простой+local LM) |
| 2 | MUST | openrouter.ts:304-315, prompts.ts:13-16 | Old custom system prompts cause INVALID_JSON for AI Generate/Format buttons |
| 3 | SHOULD | partialJson.ts:4-10 | coverPrompt missing from SONG_FIELDS / STRING_FIELDS |
| 4 | SHOULD | system_generate.en.md:362-371,386-453 | "Final check" + few-shot examples don't reflect coverPrompt addition |
| 5 | NIT | App.tsx:1029 | lmTemperature not forwarded to createSample |
| 6 | NIT | CreatePanel.tsx:1755 | lmModel hardcoded in simple-mode payload |
| 7 | NIT | App.tsx:993,1134,1136 | `(params as any)` casts for new fields |

## Verified-OK paths (no regression)

- `CreatePanel.tsx:1536` pre-flight queue guard correctly excludes local LM.
- `CreatePanel.tsx:1577` `effectiveCustomMode` correctly false when local LM is active.
- `CreatePanel.tsx:1601-1762` for-loop fires N concurrent `onGenerate`; each App.tsx call decrements counter once via `decrementPendingClicks(1)` at line 1145 (success) or 1152 (outer fail). Bulk balance maintained EXCEPT the createSample-failure inner-catch (MUST-1).
- `routes/generate.ts:535-551` cover-gen branch correctly guarded; undefined `params.pollinations` skips it.
- `id3-tagger.ts:91-131` `fetchCoverImage(songId, undefined)` correctly falls through to legacy picsum path.
- `routes/generate.ts:1447-1491` `/create-sample` route untouched in this range; legacy contract preserved.
- `routes/generate.ts:1038-1139` `/switch-model` route untouched; LM switching still works.
- AI Generate/Format buttons (CreatePanel.tsx:2312/2322/2436/2446) still bound to `orHook`; not broken by the new `llmPreflightQueueRef` (which uses a fresh `OpenRouterProvider` per click, not the shared hook).
- `App.tsx:993-1004` `_tempId` promotion path: when `params._tempId` is set, the placeholder is promoted; when undefined, the legacy `tempSong` creation block (1006-1021) runs. Both branches functional.
