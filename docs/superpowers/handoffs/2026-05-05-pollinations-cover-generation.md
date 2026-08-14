# Handoff: Pollinations.ai Cover Generation Integration

**Date:** 2026-05-05
**Status:** Not started — full design + plan, ready for implementation
**Predecessor session:** OpenRouter LLM Provider integration (master ~30 commits ahead, last commit `78189bac2`)

---

## What the user wants

Add an **optional** "Generate cover via Pollinations.ai" feature next to the
existing OpenRouter integration:

- Toggle in CreatePanel advanced settings (mirror the OpenRouter toggle pattern).
- When ON, after audio generation succeeds, call Pollinations to generate
  an album-cover image and save it as `song.cover_url`.
- Model picker: list comes from Pollinations' `/models` endpoint (live, no
  hardcoding — same lesson learned from OpenRouter).
- Prompt is composed in code: English, "music album cover" framing, plus
  song title + style/caption + user's original brief if any.
- **Fallback chain:** if disabled OR Pollinations call fails OR times out
  fast → keep the existing seeded-gradient `AlbumCover` (current behavior).
- Sidebar status row (like the OR row added in commit `78189bac2`) showing
  Pollinations toggle/model state.

---

## What's already in the repo (relevant files)

| File | Role |
|---|---|
| `app/components/AlbumCover.tsx` | Seeded-gradient SVG cover, used as the **last-resort visual fallback** in the React tree when `<img src={song.coverUrl}>` either has no URL or its `onError` fires |
| `app/components/SongList.tsx:601-606` | `(!song.coverUrl \|\| imageError) ? <AlbumCover/> : <img src={song.coverUrl}/>` — primary display logic |
| `app/components/Player.tsx:162-170, 350-353, 424-432, 651-654` | Same pattern in the player |
| `app/server/src/db/migrate.ts:24,61` | `cover_url TEXT` column on `songs` table — already exists, no migration needed |
| `app/server/src/routes/songs.ts:154,312` | `cover_url` round-tripped in API responses; UPDATE path exists |
| `app/server/src/services/id3-tagger.ts:64-78` | **CURRENT cover source #1** — `fetchCoverImage(songId)` fetches `https://picsum.photos/seed/{songId}/400/400` server-side, returns Buffer that gets embedded as the **ID3 tag image** of the generated MP3. This is the only place a real bitmap is fetched today. |
| `app/server/src/routes/generate.ts:536` | Calls `fetchCoverImage(songId)` after audio is rendered, embeds into MP3 tag. **Note: does NOT write the URL to `song.cover_url`** — column stays NULL, hence the React tree always falls through to `<AlbumCover/>` gradient. |
| `app/server/src/index.ts:209` | **Cover source #2** — for oEmbed / og:image / twitter:image meta tags. `song.cover_url \|\| 'https://picsum.photos/seed/{id}/1200/630'` — random Lorem Picsum is the share-link fallback. |
| `app/services/llm/openrouter.ts` | The reference integration to mirror — adaptive request building, supported_parameters lookup, AsyncIterable streaming, error mapping |
| `app/components/LmProviderPanel.tsx` | Reference UI panel — API key input, Test button, model picker (search + recent + FREE badge), Refresh button |
| `app/components/UseOpenRouterToggle.tsx` | Reference toggle (just `value` + `onChange`) |
| `app/components/Sidebar.tsx:139-168` | Status rows (LM, OR) — add a 3rd row "IMG" |
| `app/services/llm/storage.ts` | localStorage wrapper pattern — mirror for `pollinations` namespace |
| `app/components/CreatePanel.tsx:2940-3001` | The advanced-settings cluster where the OpenRouter toggle/panel lives — add Pollinations toggle/panel right under it |
| `app/components/CreatePanel.tsx:1442-1640 (handleGenerate)` | Audio-gen submission. Pollinations cover gen happens AFTER audio-gen success, in parallel/non-blocking |

### How covers actually work today (corrected)

```
audio gen → song row created with cover_url=NULL
         → generate.ts:536 fetches picsum.photos/seed/{id}/400/400
            → embeds into MP3 ID3 tag (so the file has a thumbnail when downloaded)
            → BUT does NOT write that URL to song.cover_url

frontend reads song.cover_url=NULL → React: !song.coverUrl → <AlbumCover seed={id}/>
                                              (SVG gradient — what user sees in list/player)

share link / OG meta reads song.cover_url=NULL → falls back to picsum.photos/seed/{id}/1200/630
```

So the user is right: picsum DOES serve covers right now, but only inside the
MP3 file's ID3 tag and in social-share previews — never in the in-app UI,
which is always the SVG gradient.

---

## Pollinations.ai API — what to know

Free, no-account-required image generation API. Optional Bearer token from
the Pollinations dashboard buys priority.

**Image generation (single endpoint):**

```
GET https://image.pollinations.ai/prompt/{URL_ENCODED_PROMPT}?model={model}&width=1024&height=1024&seed=42&nologo=true&enhance=true
```

Response: a generated PNG/JPEG (binary). Status 200 = ready, the body IS
the image bytes. Caller saves them or uses the URL directly as `<img src>`.

**Verified live (2026-05-05) via curl from this repo machine:**
- A 97KB JPEG image returned for a music-cover prompt.
- The `width`/`height` query params are **NOT honored** by the current
  default model (`sana`) — it returned its native **768×768** regardless.
  Server-side post-processing or a different model is required if a
  specific size matters. For album covers 768×768 is fine (it's square),
  so leave the params as hints but don't trust them.
- First request can take 10–25 s (cold path); subsequent same-prompt
  requests come back faster (Pollinations side-cache). Set the client
  timeout to **30 s**, not 15 s.

**Models list:**

```
GET https://image.pollinations.ai/models
→ as of 2026-05-05: ["sana"]
```

Returns a JSON array of model id strings. **At time of handoff, only
`sana` is available** — the historical list of `flux`/`turbo`/`kontext`
seems to have been consolidated. Treat the list as fully dynamic; never
hardcode model names. The picker should show whatever the endpoint
returns, including a single-item case (UI must not crash on length 1).
There's no per-model `supported_parameters` like OpenRouter — the same
query params apply across models (and are partially ignored as noted).

**Auth (optional):**

```
Authorization: Bearer <token>
```

Without token: works, lower priority. With token: faster.

**Rate limits:** generous for free tier (single-digit req/s), no hard
quota documented. Treat as "best effort".

**Image dimensions:** common sizes 512, 768, 1024, 2048. For a square
cover use 1024×1024. The query string accepts arbitrary dimensions but
some models cap at 2048.

**`nologo=true`** strips the small Pollinations watermark (recommended
for cover use).

**`enhance=true`** asks Pollinations' own LLM to expand a short prompt
into a richer one before generating. Useful when our prompt is just a
song title + style hint.

**`seed`** lets us pin the result for retake-friendliness. We can derive
seed from `song.id` so retries on the same song produce the same cover.

Reference docs: <https://github.com/pollinations/pollinations> README,
<https://pollinations.ai/> landing.

---

## Design

### Two-layer flow

```
CreatePanel.handleGenerate
    └─ user clicks Создать
        └─ (existing) onGenerate({ ...payload }) → Python → audio
            └─ (existing) song row created with cover_url=null
        └─ (NEW) if usePollinations && lastSongId:
              fetchPollinationsCover(prompt, model, seed=songId)
              → save image bytes server-side (or POST URL)
              → PATCH /api/songs/{id} { coverUrl }
              → React state updates → <img src=coverUrl> replaces gradient
        └─ on any failure (timeout, 5xx, image decode error) → no PATCH,
           gradient stays. No user-facing error toast unless explicitly
           enabled in dev.
```

### Components to add

```
app/services/pollinations/
  ├── types.ts           # PollinationsConfig, ImageResult, ErrorCode
  ├── storage.ts         # llmStorage-style localStorage wrapper
  ├── pollinations.ts    # client: getModels, generateCover, testKey
  └── prompts.ts         # buildCoverPrompt(songMeta) → string

app/components/
  ├── UsePollinationsToggle.tsx        # mirror UseOpenRouterToggle
  └── PollinationsPanel.tsx            # mirror LmProviderPanel
                                         (apiKey optional, model picker, test, refresh,
                                          width/height, seed mode, nologo, enhance toggle)
```

### Storage shape

```ts
// localStorage namespace: acestep.pollinations.*
export interface PollinationsConfig {
  apiKey: string;                  // optional Bearer token; '' = anonymous tier
  model: string;                   // e.g. 'flux'
  width: number;                   // default 1024
  height: number;                  // default 1024
  nologo: boolean;                 // default true
  enhance: boolean;                // default true (Pollinations LLM expands the prompt)
}
```

Plus `acestep.pollinations.usePollinations: 'true' | 'false'`.

### Cover prompt builder

```ts
// app/services/pollinations/prompts.ts
export function buildCoverPrompt(input: {
  title: string;
  caption: string;        // ACE-Step style/caption
  topic: string;          // user's original brief if any
  language: string;       // 'ru', 'en', …
  instrumental: boolean;
}): string {
  const bits = [
    'square music album cover art',
    'high quality, professional, atmospheric',
    input.title ? `titled "${input.title}"` : '',
    input.caption ? `genre and mood: ${input.caption}` : '',
    input.topic ? `inspired by: ${input.topic}` : '',
    input.instrumental ? 'instrumental track aesthetic' : '',
    // No text on the cover — Pollinations text rendering is unreliable
    'no text, no typography, no watermark',
  ].filter(Boolean);
  return bits.join(', ');
}
```

Stays in English regardless of song language — image models train
predominantly on English captions. Title can be quoted as-is even if
non-English; the rest is English framing.

### Where to call Pollinations (frontend or backend?)

**Revised recommendation: backend, replacing `fetchCoverImage`.**

The existing flow already fetches a remote image SERVER-side
(`id3-tagger.ts:64`) right after audio render, and embeds it into the
MP3 ID3 tag. That's also where Pollinations should hook in — change
`fetchCoverImage` to:

1. Read user's Pollinations config (passed in the audio-gen payload from
   frontend, since localStorage isn't reachable server-side, OR via a
   user-settings table column).
2. If toggle ON: build prompt from song meta (title/style/topic), GET
   `https://image.pollinations.ai/prompt/{prompt}?model={model}&width=1024&height=1024&seed={songId}&nologo=true`,
   timeout 15s. If response 200 → use those bytes for ID3 + write the
   URL (or local path) to `song.cover_url`. If response fails → fall
   through to picsum.photos as today.
3. If toggle OFF: keep current picsum.photos behavior. Don't change
   `cover_url` (stays NULL, gradient still shows in UI).

**Why backend, not frontend** (correcting earlier reasoning):
- Cover is needed for ID3 tag (server only has access to the rendered
  MP3 file).
- Single trip beats two (server fetches Pollinations once, uses bytes
  for ID3 + writes URL to DB — same network, both purposes served).
- Browser-side cover gen would mean ANOTHER round trip to upload bytes
  back to server for ID3 tagging. Wasteful.
- The frontend toggle/panel still drives configuration; it's persisted
  in localStorage AND sent in the audio-gen payload (like
  `openrouterModel` already is, see CreatePanel.tsx:1482).

**CSP:** N/A — this is server-to-server. `https://image.pollinations.ai`
needs to be reachable from Node, not from the browser. No `connect-src`
change needed.

**Cover storage:** two options:
1. **Direct Pollinations URL** in `cover_url` — simplest, but the
   browser then loads the image from pollinations.ai on every render.
   Pollinations may rate-limit. **Need CSP `img-src`** to include
   `https://image.pollinations.ai` (img-src is already permissive
   `https:` in `index.ts:60`, so likely no change). For OG/Twitter
   meta the URL works directly.
2. **Persist locally** — server saves the fetched bytes to
   `app/server/public/audio/covers/{songId}.jpg`, sets `cover_url` to
   `/audio/covers/{songId}.jpg`. Robust against Pollinations downtime,
   no third-party CSP concern, no rate limit on re-views.

**Recommendation: option 2 (local persistence).** The bytes are already
in memory in `fetchCoverImage` (it returns a `Buffer`), so writing it
to disk + setting a relative URL is one extra `fs.writeFile`. This also
matches how audio files are served (`/audio/...`).

### Toggle + status placement

In `CreatePanel.tsx` advanced settings cluster, right under the existing
OpenRouter toggle/panel. New file `UsePollinationsToggle` mirrors
`UseOpenRouterToggle`. `PollinationsPanel` mirrors `LmProviderPanel` but
simpler — no per-model `supported_parameters`, no streaming, no system
prompt textarea.

In `Sidebar.tsx`, add a 3rd row right after the OR row:

```tsx
{/* Pollinations status */}
<div className="flex items-center justify-between text-zinc-600">
  <span className="flex items-center gap-1">
    <span className={`w-1.5 h-1.5 rounded-full ${polReady ? 'bg-green-500' : (polEnabled ? 'bg-yellow-500' : 'bg-zinc-700')}`}></span>
    <span className="text-[9px] text-zinc-600">IMG</span>
  </span>
  <span className="text-[9px] truncate max-w-[120px] text-zinc-500">
    {polReady ? polCfg!.model : (polEnabled ? 'no model' : 'off')}
  </span>
</div>
```

### Fallback rules (explicit)

The system MUST gracefully fall back to the seeded gradient cover when:
- toggle is OFF (default state for new users)
- toggle ON but `cfg.model === ''`
- Pollinations fetch returns non-200 in <2s
- Pollinations fetch hangs >30s (configurable timeout)
- Image decode fails (`<img onError>` already triggers `imageError` →
  `<AlbumCover/>` renders — pre-existing logic)
- User has no internet

In all cases, NO ERROR TOAST is shown unless user has dev-mode enabled
(future). The cover gradient is a perfectly fine default.

---

## Implementation plan

Use the same brainstorm → spec → plan → subagent-driven dev workflow as
the OpenRouter feature.

### Phase A — frontend storage + UI
1. Create `app/services/pollinations/types.ts`, `storage.ts`,
   `pollinations.ts` (client for `/models` listing + Test ping),
   `prompts.ts` (`buildCoverPrompt`).
2. Vitest: storage roundtrip; prompts.ts golden snapshot.
3. `UsePollinationsToggle.tsx` (mirror `UseOpenRouterToggle`).
4. `PollinationsPanel.tsx` — apiKey (optional), model picker via live
   `/models`, refresh button, width/height number inputs, nologo +
   enhance toggles, Test button.
5. Mount in `CreatePanel.tsx` advanced settings under the OR cluster.
6. `Sidebar.tsx` — add IMG status row.

### Phase B — wire payload
1. Pass Pollinations config in the audio-gen payload (same shape as
   `openrouterModel: lastOpenRouterModelId` at CreatePanel.tsx:1482).
   New fields: `pollinationsEnabled: boolean`, `pollinationsModel: string`,
   `pollinationsApiKey: string`, `pollinationsWidth: number`,
   `pollinationsHeight: number`, `pollinationsNologo: boolean`,
   `pollinationsEnhance: boolean`.

### Phase C — backend
1. Add `app/server/src/services/pollinations.ts` — server-side fetch:
   `generateCover({ prompt, model, width, height, seed, nologo, enhance, apiKey, timeoutMs })`
   returns `Buffer` or `undefined` on failure (matches `fetchCoverImage`
   contract).
2. Modify `app/server/src/services/id3-tagger.ts:fetchCoverImage` to
   accept extended params: `(songId, songMeta, pollConfig?)`. If
   `pollConfig?.enabled` and required fields present, route through
   `generateCover` first; on success, return its Buffer + record-side
   effect of writing the bytes to
   `app/server/public/audio/covers/{songId}.jpg` and returning the
   relative URL `/audio/covers/{songId}.jpg`. On any failure, fall
   through to existing picsum.photos behavior. Returns
   `{ buffer, mimeType, savedRelUrl?: string }`.
3. Modify `app/server/src/routes/generate.ts:536` (the
   `fetchCoverImage` call site) to:
   - pass the extended args (read from request body),
   - if `savedRelUrl` is returned, run `UPDATE songs SET cover_url=?
     WHERE id=?` so frontend sees the new cover.
4. Make sure the covers directory exists at startup
   (`fs.mkdirSync(...{recursive:true})` in server bootstrap).

### Phase D — fallback chain & error handling
- Pollinations 5xx / timeout / network → `fetchCoverImage` falls back
  to picsum.photos (existing path), logs warning, doesn't fail the
  audio-gen.
- Pollinations toggle OFF → branch never executes.
- The React tree's existing `(!song.coverUrl || imageError) ?
  <AlbumCover/> : <img/>` logic already handles the "no cover saved"
  case via gradient — no UI changes needed for fallback.

### Phase D — i18n
1. New keys: `pollinations.useToggle`, `pollinations.modelPicker.*`,
   `pollinations.width`, `pollinations.height`, `pollinations.nologo`,
   `pollinations.enhance`, `pollinations.cover.generating`,
   `pollinations.cover.failed`, etc.
2. Add to all 5 language files.

### Phase E — manual smoke
- Toggle OFF: gradient covers, no Pollinations request fired.
- Toggle ON with valid model: clicking Создать → audio renders → cover
  appears within ~10s replacing gradient.
- Toggle ON, model removed mid-flight: graceful fallback (no broken UI).
- Pollinations timeout: gradient stays, no error toast.

---

## Important context for the next session

1. **Use the official Pollinations approach.** There's no Pollinations npm
   SDK; the API is just `fetch('https://image.pollinations.ai/prompt/...')`
   so a small typed client is fine. Don't write a streaming parser —
   it's a single-shot request returning a binary image.

2. **Mirror the OpenRouter feature's structure.** That feature's design
   spec is at
   `docs/superpowers/specs/2026-05-04-openrouter-llm-provider-design.md`
   and plan at
   `docs/superpowers/plans/2026-05-04-openrouter-llm-provider.md`.
   Follow the same shape for the Pollinations spec/plan.

3. **Don't break the seeded gradient.** Existing free-tier covers MUST
   keep working when Pollinations is disabled. The `<AlbumCover seed=...>`
   render path on `(!song.coverUrl || imageError)` already handles this
   correctly — just don't accidentally always-set `cover_url`.

4. **Browser-first integration.** Per the user's preference (and
   established pattern in OpenRouter): the API key (if any) and the
   request live in the browser. Backend only persists the result URL.

5. **Toggle defaults to ON for fresh users on no-LM mode? Probably no.**
   Cover generation is a "nice extra" not core. Default OFF; user opts
   in. Different from the OpenRouter toggle which defaults ON because
   without it the AI buttons literally don't work. Pollinations is
   purely additive.

6. **Watch for compaction.** This handoff lives at
   `docs/superpowers/handoffs/2026-05-05-pollinations-cover-generation.md`.
   The next session should `cat` it first thing.

7. **Lessons from the OpenRouter feature:**
   - Use OFFICIAL clients/SDKs when they exist (don't hand-roll). For
     Pollinations there's no SDK so a thin fetch wrapper is fine, but
     keep it adaptive (read `/models` live, don't hardcode model ids).
   - CSP `connect-src` blocks browser fetches — remember to whitelist
     the new domain in `app/server/src/index.ts` helmet config.
   - Vite native node bundle uses `node/node.exe` and `node/npm.cmd` —
     for any new native dep, rebuild via `node/npm.cmd rebuild --build-from-source`
     to match the bundled Node ABI.

8. **Reuse the existing test infrastructure.** Vitest is bootstrapped
   (`app/vitest.config.ts`). Pure-logic services should follow strict
   TDD per `superpowers:test-driven-development`. UI components are
   smoke-tested in browser (no RTL).

9. **No commits without user approval.** Per user memory: don't auto-commit
   feature work — get explicit "go" before each milestone.

10. **The user is impatient and direct.** Don't pad responses. Show
    actual code and test results. Apologize briefly, fix fast.

---

## Suggested first step for the next session

Run `/brainstorming` skill on the user's original request (quoted at top
of this handoff). Pin down:
- Toggle position (under OR cluster vs separate "Image generation"
  section).
- Whether to persist cover bytes locally or just store the Pollinations
  URL as-is.
- Width/height defaults (square 1024 recommended).
- Whether `enhance=true` should be the default (probably yes — improves
  short prompts; cost: ~1s extra latency).

Then write a spec at
`docs/superpowers/specs/YYYY-MM-DD-pollinations-cover-design.md` and a
plan at `docs/superpowers/plans/YYYY-MM-DD-pollinations-cover.md` —
mirror the structure of the OpenRouter ones.
