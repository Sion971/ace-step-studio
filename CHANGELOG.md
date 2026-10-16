# Changelog

## 2026-10-15

### Added
- Library: the tabs (all songs, liked, workspaces, playlists, uploads) stay at the top while the list scrolls
- Song list (Create tab): the workspace breadcrumb, the search box and the filters stay at the top while a long list scrolls
- Before / after listening shows the loudness measured for each file (LUFS), so a small gap between them is visible
- Before / after listening: an option (on by default) plays both files at the same volume by turning the louder one down, with the levels measured by the server (`X-Original-LUFS` / `X-Result-LUFS` headers); the files themselves are not changed
- Loudness / mastering window: listen to the original and the processed file with one play button and an Original / Processed switch; switching while it plays keeps the position, so the difference is heard at the exact same moment (plus a shared position bar)
- Mastering in the loudness window (optional, off by default): warmth (soft saturation that adds harmonics on the peaks), harmonics (air), tone, glue compression and stereo width, with five presets (Light, Warm, Bright, Punchy); it runs before the loudness measure so the target is reached on the mastered sound, and a limiter holds the true-peak ceiling
- Trained LoRAs join the LoRA menu on export, with their trigger word, base model, adapter type, rank, epochs and dataset (`lora_output/training_info.json` at launch, `lora_hub.json` on export); an empty export path now picks a name from the dataset and adapter (`<dataset>-lora` / `-lokr`) without reusing an existing one
- LoKr folders (`lokr_weights.safetensors`) are listed in the LoRA menu (`services/lora-available.ts`)
- Dataset tab: the save path follows the dataset name, and the "Preprocess to tensors" path follows the file just saved, loaded, imported or scanned

### Fixed
- Song list header (sticky): it now sticks to the very top edge; with the padding of the scrolling area songs were still visible above it
- Advanced settings "Duration" slider stops at the same limit as the quick one (it was fixed at 10 minutes, so it showed a longer song than the engine accepts); `ffprobe` gets 30 s instead of 10 s on first run
- Duration slider: the longest song now comes from the engine (up to 10 minutes on a card with enough memory) instead of a fixed 240 s: the interface asked `/api/generate/limits`, a route the server never had
- LoKr training: the rank and alpha from the screen were ignored (they became `--rank` / `--alpha`, which only LoRA reads); they now go out as `--lokr-linear-dim` / `--lokr-linear-alpha`
- "Startup timeout ... pipeline still loading" no longer prints minutes after the fact when the engine was ready, stopped for a training or had exited

## 2026-10-14

### Added
- LoRA training starts from VRAM presets (8, 12, 16, 24 GB, quick test, high quality — ACE-Step's own values) plus four more `train.py` options
- After a training the server restarts the engine itself (it is stopped to free the VRAM); the Train tab shows a note while it comes back
- Export copies the adapter files on disk, so it no longer needs the engine
- Clear messages when the engine is down ("Connection errored out" is gone) and when a dataset file does not exist
- `run.bat` rebuilds the interface when the repository version changes

### Fixed
- Dataset audio picker lost files picked in a row (a live `FileList` was read after the input was reset)
- Health check: a busy engine (language-model decoding blocks its event loop for tens of seconds, minutes on a CPU) is no longer killed as a "zombie"; tolerated silence is 120 s, or `ACESTEP_GENERATION_TIMEOUT`
- LoRA preprocessing goes through the running engine instead of a second `python.exe` (Smart App Control refused it with `spawn UNKNOWN`; a second model also did not fit in 8 GB), and `silence_latent` is moved to the masks' device
- Model menu: "downloaded" only when the folder holds weights
- Windows: `download_model.bat` removed

## 2026-10-13

### Added
- Windows picks the default model from the VRAM (`hardware_profile.env`), as Linux does
- `run.bat` waits for Smart App Control refusals to end (`sac_pending.txt`)

### Fixed
- LoRA preprocessing passes `--config` / `--offload` / `--quantization` and shows its error

## 2026-10-12

### Added
- Windows: Demucs environment (stem separation) and MIDI / Demucs wiring
- MP3 export through `soundfile` (libsndfile): `ffmpeg.exe` is no longer required

### Fixed
- `install.bat`: Smart App Control identified as the cause of intermittent refusals; PyTorch / torchaudio import and the MP3 check are retried

## 2026-10-09 to 2026-10-11

### Changed
- Windows has a single installer, `install.bat`, like `install.sh`; `install-blackwell-native.bat` removed
- FFmpeg installed as the shared build (DLLs) for MP3 export, with a real encoding check; DLL copy made reliable and verified
- `install.bat` checks the Python interpreter before any download and `Python.h` correctly

### Fixed
- `pytorch_wavelets` patched without importing it (setuptools >= 82)

## 2026-10-07 to 2026-10-08

### Added
- LoRA Hub: install a LoRA from a Hugging Face link, read the author's `<weights>.metadata.json`, a catalogue with compatibility checks and pinned versions, shown in the LoRA panel (70 texts in six languages); an installed LoRA can be loaded and a refused load no longer looks successful
- A language model missing from disk can be downloaded then loaded from the interface; a model downloaded after the engine started can be loaded; download or switch failures are visible
- 2B models are back in the menu, with a VRAM filter and a "Show more" link

### Fixed
- Hard-coded French texts and missing translation keys (hundreds of keys, six languages) with a test that forbids their return; server messages are in English
- React types installed: the interface type check is real (all remaining errors fixed)
- The "Your name" field no longer triggers browser autofill

## 2026-10-04 to 2026-10-06

### Added
- Server-side stem separation (Demucs, 6 stems, isolated venv), synchronised playback and waveform, editor opening
- MIDI piano roll with synthesizer playback from the stems; loudness (LUFS) normalisation per platform
- First-launch screen, with the browser opened as soon as the server listens; engine download events and tracking exposed by `/api/pipeline/status`
- Generated fallback covers (16 styles); CPU mode: adapted generation timeout and accurate banner
- On-demand downloader for the 2B DiT and 1.7B LM

### Changed
- Hardware profile tier follows PyTorch's measurement, as ACE-Step does
- Frontend: React 19.3, Vite 8, plugin-react 6, Vitest 5, lucide-react 1.x; server: multer 2.4, body-parser 1.20.8
- `run.sh` rebuilds the interface when it changed

### Fixed
- Pascal cards: quantised `w8a8_dynamic` weights moved to the GPU
- Installer reads the CUDA version from recent drivers' `nvidia-smi` header

## 2026-08-28 to 2026-09-19

### Added
- Full Windows support (uv installer), AMD (ROCm) / Intel (XPU) detection with official redirection, direct microphone recording in the create panel
- LoRA with quantisation: INT8 switch from the interface (`ACESTEP_QUANTIZATION`), safe model / quantisation switching, dropdown, automatic renaming
- Tailwind built in (no CDN, works offline); fallback covers generated locally; playlist / workspace creation dialog
- Experimental native Blackwell installer and torch 2.11.0 (standard stays on 2.10.0); `HF_XET_HIGH_PERFORMANCE` in the scripts

### Fixed
- DCW: no more distorted sound on non-turbo (base / sft) models
- `playlists.kind` is finally reliable; pure CPU path with pinned versions

## 2026-08-27

### Added
- Public GitHub repository — first release of this fork under `Sion971/ace-step-studio`
- `nvcc` version check in `install.sh` before attempting a `flash-attn` build — checks compute capability and compiler version together, skips cleanly to SDPA when incompatible instead of a doomed multi-hour build

### Fixed
- `flash-attn` on Blackwell (RTX 50-series, compute capability 12.0) — three compounding causes, found one at a time across three full rebuilds: wrong env var (`TORCH_CUDA_ARCH_LIST` is never read by `flash-attn`'s own `setup.py`; the correct variable is `FLASH_ATTN_CUDA_ARCHS`), wrong value format (expects an integer `"120"`, not the decimal `"12.0"` `nvidia-smi` reports), and finally the real blocker — system `nvcc` at CUDA 12.0 predates `compute_120` support entirely. Confirmed via `cuobjdump --list-elf` inspection of the compiled `.so`, not import success alone — the module imports fine even when compiled for the wrong architecture, failing only at the first real kernel call with `CUDA error: no kernel image is available for execution on the device`.

### Changed
- Attribution across `SettingsModal.tsx`, `NewsPage.tsx`, `README.md`, `LICENSE` — full lineage (AmbsdOP → timoncool → this fork) made explicit; links pointing to upstream repos corrected to this fork's own
- `README.md` rewritten to describe this fork's actual Linux-only feature set instead of the generic multi-platform docs it shipped with
- `app/audiomass-editor/src` and `app/server/audio-editor` (~16MB each, byte-identical) collapsed from a manually-maintained duplicate to a symlink

## 2026-08-26

### Added
- AudioMass updated to its multitrack build; custom `?audioUrl=`/`?audioUrls=` patch re-applied to `app.js` to load stems directly from Demucs Web — a single stem via `LoadURL`, or all four together via `RequestLoadPickedFiles` (`LoadURL` alone never creates a new track when none exists yet, a silent no-op rather than an error)
- `POST /api/audio-editor/stage` — stems only ever exist as in-memory buffers client-side; this stages an encoded WAV server-side so the editor, which opens as a separate page, can fetch it by a real URL rather than an unusable `blob:` reference
- `install.sh`: GPU/CUDA selection extended with a real compute-capability check via `nvidia-smi`, gating a conditional `flash-attn` install (previously absent from the script entirely, for every GPU generation)
- `install.sh`: database migration and the isolated `basic-pitch` venv setup folded in as numbered steps, replacing two separate manual scripts
- Vite 6.4.2 → 6.4.3

### Fixed
- `run-migration-kind.mjs` idempotency — previously checked for an existing backup file before checking whether the migration itself was already done, so any automated re-run against an already-migrated database failed outright. Combined with `install.sh`'s `set -e`, this silently aborted the rest of the install without reaching later steps.

## 2026-08-25

### Added
- MIDI conversion via `basic-pitch`, isolated Python 3.11 venv (deadsnakes PPA — `basic-pitch`'s TensorFlow pin ships no Python 3.12 wheel), `/api/midi/convert` route

### Changed
- Workspace membership is now strictly exclusive — adding a song to a workspace removes it from any other first, via `DELETE /api/playlists/remove-song-from-workspaces/:songId`

## 2026-08-24

### Added
- `kind` column on `playlists` (SQLite, `better-sqlite3`) — real separation between `playlist` and `workspace` rows, previously conflated in one table with no distinguishing field
- Virtual "Mon espace de travail" default view, computed by exclusion — no database row of its own

### Fixed
- `PlaylistDetail`'s `createdAt` snake_case mismatch, crashing the Create tab on navigation from a playlist
- Library search crash on non-array `tags`
- Deleted playlist cards remaining clickable, leading to a 404 on open

## 2026-08-18

### Changed
- Video generation rearchitected around server-side frame-by-frame assembly — the client-side `MediaRecorder` approach was the root cause of a long-standing flicker
- `CreatePanel` split further into focused sub-panels

### Fixed
- "Zoom jump" reported on karaoke-lyrics video exports — confirmed via `ffprobe` (5400 frames, consistent 1080×1920 throughout) to be VLC's own resume-playback prompt, not an export defect

## 2026-08-14

### Added
- Linux port — `install.sh` and `run.sh` unified into a single GPU-aware setup
- First LoRA trained end-to-end via a CLI-driven pipeline ("Side-Step" strategy)
- `CreatePanel` cartography: first extraction pass (`LoraPanel`)


## 2026-05-05

### Added
- **OpenRouter LLM provider** — bring-your-own-key alternative to the local LM. Pick any model (Claude, GPT-4o, DeepSeek, Llama 3.x, 200+ supported, **including many free ones — DeepSeek R1 free, Llama 3.3 free, Gemini 2.0 free etc.**), get instant lyrics + caption + BPM/key/duration metadata + a visual `coverPrompt` from a one-line description. Persists model choice across sessions, streams output with a real-time preview. Local LM keeps working in parallel — toggle anytime, both modes coexist.
- **Pollinations.ai auto cover generation** — server-side, parallel with audio render, fire-and-forget. Never blocks the audio pipeline; cover_url is filled via background UPDATE 5–30 s after audio completes. The visual prompt is the LLM-generated `coverPrompt` (or a keyword fallback) — sent to Pollinations as-is, no extra style modifiers. **Anonymous tier is fully free** (no account needed, just slower); optional tokens (`pk_…` / `sk_…` from auth.pollinations.ai) lift to Seed tier (1 req/5 s, no watermark, full model catalogue).
- **Manual cover regeneration modal** — `ImagePlus` button on every owned song row in SongList and in the RightSidebar Main Actions. Lets the user pick any Pollinations image model, write a custom prompt, *Try again* until satisfied, **or upload a custom image from disk** (JPEG/PNG/WEBP, max 10 MB). The picked image replaces both `songs.cover_url` AND the embedded ID3 cover frame inside the MP3, so any external player sees the new picture in downloads.
- **Auto-pipeline ID3 re-embed** — when Pollinations finishes the auto cover, `attachCover` now also reads the source MP3, replaces the embedded ID3 image frame with the new picture, and writes it back. Previously the downloaded MP3 kept the seeded picsum thumbnail forever even though the in-app cover was correct.
- **LLM `coverPrompt` field** in SongDraft schema — the OpenRouter system prompt now also asks for a 1–2 sentence visual album-cover description per song, fed straight into Pollinations as the cover prompt.
- **Detailed pre-flight stages** — the OpenRouter pre-flight call now reports `stageOpenRouterConnecting → stageOpenRouterStreaming → stageOpenRouterFinalizing` driven by stream events, so a stuck card tells you whether the issue is on connect, in mid-stream or in JSON parsing.
- **Cancel + 90 s timeout for OpenRouter pre-flight** — the cancel button on the placeholder card now actually aborts the in-flight OR HTTP request (was previously inert). Cancel-all and Reset-all also abort every pending pre-flight aborter so OR responses can't 'win the race' and spawn audio jobs after the user cancelled. A hard 90-second timeout kills hung requests automatically.
- **Queue refactor** — instant N/10 click counter, instant placeholder card at click time (no more 20-second wait staring at an empty list while LLM pre-flight runs), FIFO drain barrier so bulk clicks chain through pre-flight + audio sequentially.
- **i18n** — 52 new keys × 5 languages (en/ru/zh/ja/ko) for stage labels (incl. 3 OR sub-stages), Pollinations panel, OpenRouter panel, cover-regen modal.

### Fixed
- **`resetGeneration` queue deadlock** — the global Reset-all button cleared `activeJobsRef` but never called `drainQueueWaiters()` or reset `pendingClickCount`, so any pre-flight click parked on `waitForJobsToDrain` would hang forever and the badge stayed stuck.
- **Simple-mode + local LM + Pollinations toggle ON** — Simple-mode `onGenerate` payload didn't include the `pollinations` field, so backend `startCoverGen` was never called → covers silently never generated. Now threaded through both Simple and Custom branches.
- **Auto-pipeline race vs manual cover save** — gate the auto-pipeline `attachCover` UPDATE on `cover_url IS NULL` so a user's manual save during in-flight Pollinations gen is never silently overwritten.
- **Orphan cover file on extension change** — manual `.webp` upload over an existing `/audio/.../{songId}.jpg` left the old file on disk forever. The endpoint now deletes the previous local cover when the extension differs.
- **Cover-jobs Map resurrection** — added a tombstone Set so an in-flight Pollinations Promise resolving after `consumeCoverState` no longer re-inserts the entry (~300 KB Buffer leak per cancel/fail averted).
- **`handleGenerate` auth-bail leak** — if `isAuthenticated/token` flipped false between CreatePanel click and the App.tsx handler, the placeholder card and `pendingClickCount` slot were leaked. Now both are cleaned up before showing the username modal.
- **`clampInt('')` UX** in PollinationsPanel — width/height inputs no longer snap to 256 the moment the user clears the field to retype a different number.

### Changed
- **CSP `connectSrc`** allows `gen.pollinations.ai`, `image.pollinations.ai`, `openrouter.ai`. Browser-direct fetches to OpenRouter and Pollinations work without a server proxy.
- **CSP `imgSrc`** now allows `blob:` so the cover-regen modal preview can render `URL.createObjectURL(blob)` images.
- **Storage abstraction** gained an optional `read(key)` method (Local implements; remote providers like S3 may omit so callers fall back to skipping retag instead of paying a download).
- **Removed the 16 deterministic art-style modifiers** from `cover-jobs.ts` — the LLM-generated `coverPrompt` is already a tailored visual description, appending another fixed style label was clobbering it. The prompt now goes to Pollinations as-is.

## 2026-05-04

### Added
- **DCW (Differential Correction in Wavelet domain)** — CVPR 2026 paper, training-free quality boost on every sampler step. Default ON. New panel in Custom mode: Mode (low/high/double/pix) + Wavelet (haar/db4/sym4/sym8/...) + 2 strength sliders
- **Retake** — variation seed with Variance slider (variance-preserving blend with independent noise draw)
- **Flow-edit** (#1156) — text-edit overlay morphing src toward target prompt/lyrics on text2music + cover + cover-nofsq tasks. Full UI panel in Custom mode: source caption + source lyrics + n_min/n_max range + n_avg stability
- **Repaint "Most Natural" mode** — 4th option in Repaint task (next to Conservative/Balanced/Aggressive). Maps to maximum source preservation (injection_ratio=1.0, crossfade=25 frames + 0.05s). Useful for iterative repaint refinement with minimum drift from source across multiple passes
- **ScragVAE** — alternative community VAE swap via `ACESTEP_VAE_CHECKPOINT` env var
- **MLX DCW** — DCW correction for Apple Silicon path (haar native, other bases via fallback)
- **`use_legacy_cfg_prompt`** A/B toggle for old vs training-aligned LM CFG prompt format

### Fixed
- **`infer_steps` on turbo / xl-turbo** — was silently clamped to 8 steps, now respects UI value (1–20)
- **LM CFG uncond prompt** aligned with training dropout format (#1127, #1128) — better lyrics quality, missing `\n\n` after `</think>` restored
- **MLX DiT static buffers** materialized before worker use on Apple Silicon (#1166)
- **`GenerationParams` None handling** — no longer crashes on `None` numeric fields (#1027)
- **Handler kwargs** no longer silently swallowed on base/turbo/xl-turbo paths
- **Express → Gradio**: `/create_sample` (Gradio) → `/v1/create_sample_from_query` (our HTTP) — Magic Wand now generates real lyrics from description (was always returning `[Instrumental]`)
- **Express → Gradio**: `/format_caption` + `/format_lyrics` (removed) → `/format_input` (single FastAPI endpoint)
- **Express → Gradio**: `/load_random_simple_description` (removed) → `/create_random_sample` (FastAPI)
- **`/auto_label_all` and `/init_service_wrapper`** — restored as named Gradio endpoints (was lost to `/lambda_N` after lambda wrapping)
- **`api_routes._get_project_root`** — fixed walking 5 levels up instead of 3 (was returning `acestep/ui` instead of project root, breaking random sample examples)
- **`unhandledRejection` global handler** in Express — `@gradio/client` no longer crashes Node when stream closes after error

### Changed
- **Synced with upstream ACE-Step v0.1.7** + post-release fixes (May 1, 2026) — 72 upstream commits merged across 148 files
- **`scheduler_type`** propagated end-to-end through wiring → batch_management → progress → GenerationParams → inference → handler → service_generate → model (was disconnected after merge, now fully wired)
- **`pytorch-wavelets >= 1.3.0`** + **`pywavelets >= 1.9.0`** — added to `install.bat` and Pinokio launcher (required for DCW)

## 2026-04-23

### Added
- **Pinokio launcher** — one-click cross-platform install via [Pinokio](https://pinokio.co). Install on Windows / Linux (x64 & aarch64) / macOS (Apple Silicon & Intel) / AMD / CPU without touching `install.bat`. Launcher repo: [timoncool/ACE-Step-Studio-pinokio](https://github.com/timoncool/ACE-Step-Studio-pinokio)
- **MLX native acceleration** on Apple Silicon — uses Apple Metal Performance Shaders directly for LM inference

## 2026-04-17

### Fixed
- **Model submodule downloader** — `download_submodel` reported success when the target directory was empty; now validates that files actually downloaded

## 2026-04-14

### Added
- **`run-no-lm.bat`** — start without LM for more VRAM (cover/repaint/text2music work, no thinking/enhance/auto-lyrics)
- **Sidebar shows "LM off"** when no LM loaded instead of hiding the line
- **Bottom player play button** works without clicking a song first — falls back to selected song
- **Lyrics textarea collapses** when instrumental mode is on

### Changed
- **Gradio args refactored to named parameters** — no more positional array counting, impossible to shift params
- **Default LM model** changed to 0.6B with PT backend everywhere (gpu_config, llm_inference, api_routes, Express)
- **Quick Settings** (Duration, BPM, Key, Time Signature, Variations) now visible in both Simple and Custom modes
- **Auto-title** picks first line from Chorus/Hook instead of first line of lyrics; max 2 phrases, cut at sentence boundary
- **Song DB records** now store actual server model state, not frontend params

### Fixed
- **LRC not showing after reload** — liked songs overwrote my songs in Map, losing lrcContent; mapSong now falls back to snake_case `lrc_content`
- **LRC missing in song details / video studio** — `getSong` and `getFullSong` didn't map `lrc_content` → `lrcContent`
- **LM backend dropdown** always showed PT — health endpoint read wrong attribute (`llm_handler.backend` → `llm_handler.llm_backend`)
- **LM backend not passed to /v1/init** — PT/vLLM selection was ignored, always loaded vLLM
- **vLLM not freed on unload** — `unload()` called `reset()` instead of `exit()`, CUDA graphs and KV cache stayed in VRAM
- **RAM leak on model switch** — old model/vae/text_encoder not deleted before loading new ones; pinned memory not unpinned
- **keyScale select** passed React event object instead of string value (broke DiT metas)
- **timeSignature select** — same bug
- **LM model/backend desync** — dropdowns now sync from server on every health poll (with editing guard)
- **Switch-model log** no longer says "Unloading DiT" when only LM changes
- **Instruction per task type** — cover and repaint now use correct instruction strings
- **gc.collect + empty_cache** after LM unload before loading new model
- **Video render: background image missing** — render re-fetched via proxy instead of using bgImageRef directly
- **Video render: CCTV date/REC overlay missing** — only drawn in preview, now in render too with matching font/size
- **Video render: Chrome "page not responding"** — yield every 30 frames prevents dialog
- **Video render: PayloadTooLargeError** — body-parser limit increased from 10mb to 50mb
- **Cyrillic filenames** in uploaded audio — multer latin1→UTF-8 decode
- **Stale generating songs** blocked real songs with lrcContent in refreshSongsList merge

## 2026-04-13

### Added
- **Tools page** in sidebar (between Search and Training) with two utilities:
  - **BF16 Converter** — convert safetensors from FP32/FP16 to BFloat16 (~50% size reduction)
  - **Model Merger** — merge two ACE-Step models with adjustable alpha blending
- `reinstall.bat` — clean reinstall preserving models, data, and output
- Sampler mode selection (Euler / Heun) in generation settings
- Changelog tab on News page (reads from CHANGELOG.md)

### Changed
- Training page redesigned from single-column to responsive 2-column grid layout
- `update.bat` now properly updates all Python dependencies (not just ace-step)

### Fixed
- TypeScript samplerMode type narrowing error
- `reinstall.bat` warns user to close app instead of killing all node processes
- `update.bat` checks node exists before running npm steps

## 2026-04-12

### Added
- **Video Studio** with full WYSIWYG editor:
  - Resolution selector + lyrics overlay with styling
  - WYSIWYG drag for ALL elements (visualizer, lyrics, text layers)
  - Selection frame (pink dashed border) on hover/drag
  - Full playback controls — timeline seekbar + volume slider
  - Visualizer scale slider + scroll-to-resize
  - 3 lyrics styles — Lines, Scroll (marquee), Karaoke (progressive fill)
  - Lyrics color settings — text color, bg color/opacity, highlight color
  - Lyrics timing offset slider (-3s to +3s) for sync
  - Default aspect ratio 1:1 (square), default lyrics style Karaoke
  - Local FFmpeg — no CDN dependency for video rendering
  - Server-side FFmpeg encoding with GPU acceleration (NVENC)
  - Chunked video encoding — frames sent in batches of 50
- **LRC toggle** (ON/OFF) under vocal language section (Simple + Custom modes)
- **Audio blocks** split into independent Reference + Cover slots
- Waveform visualization on Reference and Cover audio players
- Drag region selection on waveform for Repaint mode
- Hints under Cover/Repaint sliders explaining what they do
- Cover strength % and task type display in Sources section
- Repaint strength + region display in Sources section
- Separate AI buttons for lyrics — Generate (Wand2) + Enhance (Sparkles)
- Clear VRAM error message shown as red toast (8s duration)
- XL Merge SFT+Turbo community model (by jeankassio) with metadata and download
- Guidance range unlocked 0-20 for all models
- Triton, Python headers, Flash Attention added to `install.bat`
- Multilingual news page with links support
- Training page with Coming Soon placeholder

### Changed
- Default audio cover strength from 100% to 50%

### Fixed
- Persist BPM/Key/Duration/TimeSignature across generations
- Don't overwrite manual BPM/Key/Duration from AI suggestions
- Null safety for BPM/Key/Duration loaded from settings
- Sync LM settings only on first connect + after model switch
- Job status set to failed on queue processing error
- nano-vllm engine cleanup — atexit.unregister for proper GC
- LLM unload — free KV cache CUDA memory properly
- Skip DiT reload when only LM model changes
- VRAM management: unload LM before loading new DiT
- Flash Attention made optional with wheel dependency
- Model hot-swap: correct LLM init args, health check
- Force int8 quantization for FP32 XL models
- Cover/repaint mode — audio file handling for Gradio
- Isolate simple/custom mode params, fix TypeScript errors
- Audio cover strength slider step from 5% to 1%
- Detect incomplete model downloads and re-download automatically
- Merge model detection and download flow
- Lyrics overlay sync — used audio time instead of Date.now()
- Karaoke progress capped at 5s per line, hidden after fully sung
- Video export lyrics sync + smooth audio analysis
- npm audit — 0 vulnerabilities
- `install.bat` — hatchling, nano-vllm, deps ordering, FFmpeg, server deps, vite build

## 2026-04-11

### Added
- **ACE-Step 1.5 XL Studio** — portable AI music generation app (initial release)
- **Web UI**: Create, Library, Search, Training (placeholder), News pages
- **Simple and Custom** generation modes
- **Single terminal mode** — Express manages Python pipeline + serves frontend
- **Model hot-swap** via /v1/init Gradio API route
- **Video Studio** — resolution selector + lyrics overlay (early version)
- Audio upload in Simple mode with inline Cover/Repaint controls
- LM model selector (4B/1B) with auto-download
- vLLM backend selector with persistence
- Generation queue with concurrent job tracking
- Real-time generation progress via Gradio submit events
- Persist generation settings in database
- Multi-language support (EN, RU, ZH, JA, KO) — all strings i18n'd
- System monitoring widget (GPU/VRAM/RAM/CPU temp)
- Backend connection state indicator (backend off vs Gradio starting)
- Portable installation (embedded Python 3.12 + Node.js 22)
- Song library with playlists, likes, and search
- Right sidebar with song details — BPM/Key/Duration/Model display
- Reuse restores ALL generation params including seed/BPM/key
- Generation time (stopwatch icon) next to model badge
- Dark/light theme toggle
- User authentication system
- Resizable panels for create/songlist/details layout
- Embed ID3 tags in generated MP3 files
- Auto LRC generation and store timestamped lyrics
- Download LRC button in song details
- Generate lyrics from style when lyrics field is empty
- Undo buttons for lyrics and style fields
- Vocal/instrumental toggle switch
- Default model: `acestep-v15-xl-turbo-bf16`
- Auto-find free port if 3001 is busy (tries up to +10)
- `install.bat` — one-click setup with GPU selection (Pascal to Blackwell)
- `update.bat` — pull and rebuild
- `download_model.bat` — model downloader via huggingface-cli
- `run.bat` / `run-dev.bat` — production and development launchers

### Fixed
- Stabilize switch-model — retry port kill, wait until free
- Simple mode param isolation from Custom mode
- Inference steps clamped to model max
- Crash when sample.caption is not a string
- Resolve PYTHON_PATH to absolute path
- Prevent polling from overriding model selection during switch
- Block Simple mode generation when LLM is unavailable
- Prevent settings reset on generation
- Non-blocking connection banner instead of fullscreen spinner
