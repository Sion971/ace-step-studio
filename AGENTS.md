# ACE-Step Studio — Agent Guidelines

## Project Overview

ACE-Step Studio is a portable, self-contained AI music generation application. It bundles Python (with CUDA/PyTorch), Node.js, and the ACE-Step 1.5 ML pipeline into a single-terminal launcher. No installation required — extract and run.

**GitHub:** https://github.com/timoncool/ACE-Step-Studio
**Upstream:** Forked from fspecii/ace-step-ui, heavily modified.

## Architecture

```
ACE-Step-Studio/
├── run.bat                    # Single-terminal launcher (prod)
├── run-dev.bat                # 3-terminal dev mode with Vite HMR
├── install.bat                # First-time setup
├── run-no-lm.bat              # Launch without LM (more VRAM)
├── python/                    # Portable Python 3.12 + CUDA 12.8
├── node/                      # Portable Node.js
├── ffmpeg/                    # Portable FFmpeg
├── models/                    # HuggingFace model cache
├── ACE-Step-1.5/              # ML pipeline (Gradio + FastAPI on port 8001)
│   ├── acestep/               # Python package
│   │   ├── acestep_v15_pipeline.py  # Main entry point
│   │   ├── llm_inference.py         # 5Hz LM (vLLM/nanovllm)
│   │   ├── api/http/                # FastAPI routes (/v1/init, /v1/models, /health)
│   │   └── ui/gradio/api/           # Gradio API routes
│   └── checkpoints/           # DiT + LM model weights
└── app/                       # Web application
    ├── index.html             # Entry point (uses CDN for Tailwind + esm.sh)
    ├── App.tsx                # Root component, generation logic
    ├── components/            # React components
    │   ├── CreatePanel.tsx    # Generation UI (Simple + Custom modes)
    │   ├── SongList.tsx       # Song list with model badges + generation time
    │   ├── RightSidebar.tsx   # Song details panel
    │   ├── Sidebar.tsx        # Left sidebar (GPU stats, navigation)
    │   └── ...
    ├── services/api.ts        # API client + Song data transformation
    ├── context/I18nContext.tsx # i18n provider
    ├── i18n/                  # Translations (en, ru, zh, ja, ko)
    ├── types.ts               # TypeScript interfaces
    ├── dist/                  # Vite production build (served by Express)
    └── server/                # Express backend (port 3001)
        ├── src/index.ts       # Server entry + static serving + pipeline manager
        ├── src/config/        # Config (ports, paths, pipeline settings)
        ├── src/routes/        # API routes (songs, generate, pipeline, etc.)
        ├── src/services/
        │   ├── pipeline-manager.ts  # Spawns/monitors/restarts Python process
        │   ├── acestep.ts           # Gradio client, job queue, generation logic
        │   ├── gradio-client.ts     # Gradio connection management
        │   └── storage/             # Local file storage
        └── src/db/            # SQLite migrations + connection pool
```

## Three-Process Architecture (Single Terminal)

Express is the supervisor. One `run.bat` → one terminal window:

1. **Express** (port 3001) — API server + serves Vite build as static files
2. **Python/Gradio** (port 8001) — ML pipeline, spawned as child process by Express
3. **Vite** — NOT running in prod. Only in dev mode (`run-dev.bat`)

Pipeline Manager (`pipeline-manager.ts`):
- Spawns Python with `child_process.spawn()`, pipes stdout/stderr with `[Gradio]` prefix
- Parses stdout for readiness: `"Running on local URL"` → state becomes `ready`
- Health check: polls `GET /gradio_api/info` every 10s, 3 consecutive failures → restart
- Auto-restart with exponential backoff (500ms → 15s, max 10 attempts)
- Graceful shutdown: `taskkill /pid PID /T /F` on Windows
- Opens browser automatically when pipeline is ready (first start only)
- Auto-finds free port if 3001 is busy (tries up to +10)

## Model Switching

Models switch **in-process** via Gradio's `POST /v1/init` API. NO process restart.

- Express `/api/generate/switch-model` → calls `POST http://localhost:8001/v1/init`
- Python handles: LM unload (`exit()` for vLLM to free CUDA graphs) → `gc.collect()` + `empty_cache()` → DiT reload (if changed) → LM reload
- `lm_backend` parameter passed through entire chain: Express → `/v1/init` → `llm_handler.initialize(backend=...)`
- `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True` set in run.bat to reduce VRAM fragmentation
- Frontend polls `/api/generate/model-status` for state transitions: `unloading → loading → ready`
- LM model/backend dropdowns sync from server on every health poll (with `lmEditingRef` guard to not overwrite while user is editing)

**NEVER spawn a new Gradio process to switch models.** Always use `/v1/init`.

## Gradio Args (Express → Python)

Generation params are passed as **named parameters** via `@gradio/client` `predict()`:

```js
client.predict('/generation_wrapper', { captions: '...', lyrics: '...', auto_lrc: false, ... })
```

- Python `generation_wrapper()` has explicit named params (NOT `*args`)
- `gr.State` components (`is_format_caption`, batch indices) are hidden by Gradio client — do NOT include them in the Express object
- Parameter names must match Python function signature exactly
- When adding a new param: add to Python `generation_wrapper()` signature, Gradio wiring `inputs[]`, Express `buildGradioArgs()`, and `GenerationParams` interface

**Default LM:** `acestep-5Hz-lm-0.6B` with `pt` backend (set everywhere: `gpu_config.py`, `llm_inference.py`, `api_routes.py`, `pipeline-manager.ts`, `generate.ts`).

## Database

SQLite via `better-sqlite3`. DB file: `app/server/data/acestep.db` (or `app/data/acestep.db`).

Key tables: `songs`, `users`, `playlists`, `playlist_songs`, `liked_songs`, `followers`, `generation_jobs`.

Songs table notable columns:
- `dit_model`, `lm_model`, `lm_backend` — which models generated the track
- `generation_time` — seconds from job start to completion (INTEGER)
- `generation_params` — full params JSON

When adding new song fields: update ALL places:
1. `migrate.ts` — ALTER TABLE
2. ALL SELECT queries in `songs.ts` (there are 6+) and `index.ts` (search)
3. `acestep.ts` — `job.result` object
4. `generate.ts` — INSERT statements (there are 2: success + fallback). Use `activeLoadedModel`/`activeLmModel` for model fields, NOT `params.*`
5. `api.ts` — `Song` interface + `transformSongs` + `getSong` + `getFullSong` + `updateSong` mappers
6. `App.tsx` — ALL THREE song mapping functions: initial `mapSong`, `refreshSongsList` mapper, and `loadSongs` merge. Each must have `s.snake_case || s.camelCase` fallback
7. `types.ts` — `Song` interface

**This is the #1 source of bugs.** Data gets lost because:
- `mapSong` creates new objects with explicit fields (no spread from API response)
- `transformSongs` maps snake→camel but `mapSong` may only read camelCase
- Liked songs can overwrite my songs in Map merge (liked go first, my songs overwrite)
- Always use `s.snake_case || s.camelCase` pattern in mappers

## i18n

5 languages: `en`, `ru`, `zh`, `ja`, `ko`. Files in `app/i18n/`.

- All user-visible strings MUST use `t('key')` from `useI18n()`
- Every component using `t()` MUST have `const { t } = useI18n()` and `import { useI18n } from '../context/I18nContext'`
- Universal terms (Facebook, GPU, VRAM) stay hardcoded — no point translating
- Server-side stage names (`starting`, `generating`) are i18n keys, translated on frontend

## Frontend Build

- `npx vite build` → outputs to `app/dist/`
- Express serves `dist/` as static files in production
- CDN dependencies: Tailwind CSS (`cdn.tailwindcss.com`), React/Lucide via esm.sh importmap
- **Lucide icons from CDN may not bundle properly.** Use inline SVG for icons not in the import list
- Helmet CSP allows: `'self'`, `'unsafe-inline'`, `'unsafe-eval'`, `cdn.tailwindcss.com`, `esm.sh`
- After ANY frontend change, run `vite build` to update `dist/`

## Key Rules

1. **Never spawn new Gradio processes** — use `/v1/init` API for model switching
2. **Always rebuild dist/** after frontend changes — prod serves static files
3. **Check ALL mappers** when adding song fields — App.tsx has manual mapping that drops unknown fields
4. **Every `t()` needs `useI18n()`** — missing import crashes the entire app
5. **Test in browser** — check console for errors after changes
6. **Default model:** `marcorez8/acestep-v15-xl-turbo-bf16` (7.5GB, BF16 precision)
7. **Default LM:** `acestep-5Hz-lm-0.6B` (smallest, fastest)
8. **Portable app** — no internet dependency at runtime (CDN is a known tech debt)

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MANAGE_PIPELINE` | `false` | Set `true` for Express to spawn Python |
| `INIT_LLM` | `true` | Set `false` to skip LM loading (run-no-lm.bat) |
| `LM_MODEL` | `acestep-5Hz-lm-0.6B` | LM model name |
| `LM_BACKEND` | `pt` | LM backend: `pt` or `vllm` |
| `PYTHON_PATH` | `./python/python.exe` | Path to Python executable |
| `ACESTEP_PATH` | `./ACE-Step-1.5` | Path to ML pipeline directory |
| `DEFAULT_MODEL` | `marcorez8/acestep-v15-xl-turbo-bf16` | DiT model to load on startup |
| `PORT` | `3001` | Express server port |
| `ACESTEP_PORT` | `8001` | Gradio pipeline port |
| `PYTORCH_CUDA_ALLOC_CONF` | `expandable_segments:True` | VRAM fragmentation mitigation |

## Development

```bash
# Dev mode (3 terminals, Vite HMR on port 3000)
run-dev.bat

# Production mode (1 terminal, static files on port 3001)
run.bat

# Rebuild frontend after changes
cd app && npx vite build
```

## Video Studio

Video generator lives in `app/components/VideoGeneratorModal.tsx` (~3000 lines).

**Rendering pipeline** (both preview and export):
1. Background (image/video with cover-fit + zoom)
2. Preset visualizer (NCS Circle, Spectrum, etc.) — position/scale from config
3. Text layers (title, artist) — draggable on canvas
4. Lyrics overlay (LRC-synced) — 3 styles: lines, scroll, karaoke
5. Post-processing effects (shake, glitch, VHS, etc.)

**Export flow:**
1. Browser renders frames on canvas (same code as preview)
2. Frames sent to server in chunks of 50 (base64 JPEG)
3. Server: `/api/render-video/start` → `/frames` → `/finish`
4. Server runs local `ffmpeg.exe` (NVENC if available)
5. Returns MP4 binary

**LRC (timestamped lyrics):**
- Generated by ACE-Step via DiT cross-attention alignment (`auto_lrc=true`)
- Stored in `songs.lrc_content` (TEXT column)
- Parsed by `app/services/lrc-parser.ts`
- Gradio output position: `data[36]` as `{value: "...", visible: true}`
- Section markers (`[Verse]`, `[Chorus]`, etc.) = any `[text in brackets]`

**Lucide icons:** removed from CDN importmap, bundled from node_modules by Vite.

## Known Tech Debt

- [ ] CDN dependencies (Tailwind CSS, esm.sh for React/GenAI) should be bundled locally
- [ ] App.tsx has 3 manual song mappers — every new field must be added to all 3
- [ ] Video export: JPEG chunks over HTTP could use OffscreenCanvas Worker for no-block rendering
- [ ] LRC timestamps from ACE-Step can be inaccurate (cross-attention alignment is approximate)
- [ ] TrainingPanel has hardcoded English strings
- [ ] Progress bar for generation (predict() is blocking in Gradio)
- [ ] Stop generation button not implemented
- [ ] WYSIWYG: no resize handles (only scroll-to-resize)
- [ ] Video Studio FX tab labels not fully i18n'd
- [ ] torchao INT8 quantization crashes after 7-8 GPU↔CPU offload cycles (AffineQuantizedTensor memory corruption)
- [ ] macOS / Linux support (currently Windows only)
