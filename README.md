<p align="center">
  <img src="https://img.shields.io/badge/🎵-ACE--Step_Studio-ec4899?style=for-the-badge&labelColor=1a1a1a" alt="ACE-Step Studio" height="60">
</p>

<h1 align="center">ACE-Step Studio</h1>

<p align="center">
  <strong>A fork of ACE-Step Studio, built around a local AI music generation workflow</strong><br>
  <em>Powered by <a href="https://github.com/ace-step/ACE-Step-1.5">ACE-Step 1.5</a> — The Open Source AI Music Generation Model</em>
</p>

<p align="center">
  <a href="https://github.com/Sion971/ace-step-studio/stargazers"><img src="https://img.shields.io/github/stars/Sion971/ace-step-studio?style=flat-square" alt="Stars"></a>
  <a href="https://github.com/Sion971/ace-step-studio?tab=MIT-1-ov-file"><img src="https://img.shields.io/badge/license-MIT-yellow?style=flat-square" alt="License"></a>
  <a href="https://github.com/Sion971/ace-step-studio/commits/master"><img src="https://img.shields.io/github/last-commit/Sion971/ace-step-studio?style=flat-square" alt="Last Commit"></a>
</p>

---

## About this fork

This is a fork of [timoncool/ACE-Step-Studio](https://github.com/timoncool/ACE-Step-Studio), itself built on [AmbsdOP's ACE-Step UI](https://github.com/fspecii/ace-step-ui). It's been substantially reworked and extended — developed primarily on Linux Mint with an NVIDIA RTX GPU, with genuine Windows support built out in parallel rather than tacked on afterward.

Both platforms share the same underlying approach: a single [`uv`](https://github.com/astral-sh/uv)-managed Python environment instead of the older embedded-Python-plus-manual-pip setup most Windows installers still rely on. Same fast, reliable dependency resolution, same GPU-aware `flash-attn` handling, same isolated environment for MIDI conversion — one installer per platform, one consistent approach underneath. macOS isn't currently tested or supported.

**What's different from upstream:**

- **Playlists vs. Workspaces** — a real separation between curated playlists and working sessions, with exclusive workspace membership (a song lives in one workspace at a time) and a virtual "default" view computed by exclusion.
- **MIDI conversion, server-side** — [basic-pitch](https://github.com/spotify/basic-pitch) running in an isolated Python 3.11 environment (its TensorFlow dependency doesn't ship wheels for newer Python), converting stems to MIDI in seconds rather than tens of minutes in-browser.
- **AudioMass, updated and wired in** — upgraded to the multitrack build, with direct-load support: open a single stem or all four Demucs stems together as separate tracks, straight from the browser, no manual export/import round-trip.
- **LoRA training from the UI** — the full scan → label → preprocess → train pipeline, drivable from React without dropping into Gradio directly.
- **One installer per platform, both `uv`-based and GPU-aware** — detects your actual compute capability and compiler version, not just a menu choice, and knows when `flash-attn` will and won't build correctly for your hardware (Blackwell/RTX 50-series needs CUDA 12.8+ to compile it at all on Linux, or a matching prebuilt wheel on Windows — both installers check this before attempting work that's doomed to fail).

---

## 🎬 Screenshots

<p align="center">
  <img src="app/docs/screenshots/01-create.png" alt="Create page" width="800">
</p>

<p align="center">
  <em>Generation panel, workspace view, and the bottom player — all in one screen.</em>
</p>

<table>
  <tr>
    <td width="50%"><img src="app/docs/screenshots/02-workspaces.png" alt="Workspaces"></td>
    <td width="50%"><img src="app/docs/screenshots/03-stems.png" alt="Stem extraction"></td>
  </tr>
  <tr>
    <td align="center"><em>Workspaces, organized visually</em></td>
    <td align="center"><em>Stem extraction — WAV, MIDI, or straight to the editor</em></td>
  </tr>
</table>

<p align="center">
  <img src="app/docs/screenshots/04-multitrack-editor.png" alt="Multitrack editor" width="800">
</p>

<p align="center">
  <em>All four Demucs stems, opened together as separate tracks in the AudioMass editor.</em>
</p>

---

## ✨ Features

### 🎵 AI Music Generation
| Feature | Description |
|---------|-------------|
| **Full Song Generation** | Create complete songs with vocals and lyrics up to 4+ minutes |
| **Instrumental Mode** | Generate instrumental tracks without vocals |
| **Custom Mode** | Fine-tune BPM, key, time signature, and duration |
| **Style Tags** | Define genre, mood, tempo, and instrumentation |
| **Batch Generation** | Generate multiple variations at once |
| **AI Enhance** | Enrich genre tags into detailed captions with proper BPM/key/time |
| **Thinking Mode** | Let AI reason about structure and generate audio codes |

### 🎨 Advanced Parameters
| Feature | Description |
|---------|-------------|
| **Reference Audio** | Use any audio file as a style reference |
| **Audio Cover** | Transform existing audio with new styles |
| **Repainting** | Regenerate specific sections of a track |
| **Seed Control** | Reproduce exact generations for consistency |
| **Inference Steps** | Control quality vs speed tradeoff |

### 🎤 Lyrics & Prompts
| Feature | Description |
|---------|-------------|
| **Lyrics Editor** | Write and format lyrics with structure tags |
| **Format Assistant** | AI-powered caption and lyrics formatting |
| **Prompt Templates** | Quick-start with genre presets |
| **Reuse Prompts** | Clone settings from any previous generation |

### 📁 Library Organization
| Feature | Description |
|---------|-------------|
| **Playlists** | Curated collections, a song can belong to several |
| **Workspaces** | Active working sessions — a song belongs to exactly one at a time |
| **Default View** | Everything not currently assigned to a workspace |
| **Bottom Player** | Full-featured player with waveform and progress |
| **Real-time Progress** | Live generation progress with queue position |
| **LAN Access** | Use from any device on your local network |

### 🛠️ Built-in Tools
| Feature | Description |
|---------|-------------|
| **Multitrack Audio Editor** | Trim, fade, and mix with AudioMass — open single stems or all four together as separate tracks |
| **Stem Extraction** | Separate vocals, drums, bass, and other with Demucs, in-browser |
| **MIDI Conversion** | Turn any stem into MIDI server-side, in seconds |
| **LoRA Training** | Full training pipeline, driven from the UI |
| **Video Generator** | Create music videos with Pexels backgrounds |
| **Gradient Covers** | Procedural album art, no internet needed |

---

## 💻 Tech Stack

| Layer | Technologies |
|-------|-------------|
| **Frontend** | React 18, TypeScript, TailwindCSS, Vite |
| **Backend** | Express.js, SQLite, better-sqlite3 |
| **AI Engine** | [ACE-Step 1.5](https://github.com/ace-step/ACE-Step-1.5) (Gradio API) |
| **Audio Tools** | AudioMass (multitrack), Demucs, basic-pitch, FFmpeg |
| **Python tooling** | [`uv`](https://github.com/astral-sh/uv) — faster, more reliable dependency resolution than plain `pip`, same tool on both Linux and Windows |

---

## 📋 Requirements

| Requirement | Specification |
|-------------|---------------|
| **OS** | Linux (developed on Linux Mint / Ubuntu 24.04) or Windows 10/11 |
| **Node.js** | 22 LTS |
| **Python** | Managed automatically by `uv` — 3.12 on Linux, 3.11 on Windows for the main environment; a separate isolated 3.11 environment on both platforms for MIDI conversion |
| **NVIDIA GPU** | 4GB+ VRAM (works without LLM), 12GB+ recommended (with LLM) |
| **CUDA compiler (`nvcc`)** | Linux only, 12.8+ if you want `flash-attn` on Blackwell (RTX 50-series) — older cards work with older `nvcc` too, the installer checks and falls back to SDPA if not. Windows uses a prebuilt `flash-attn` wheel instead, no local compiler needed |
| **FFmpeg, libsndfile** | Installed automatically by the installer if missing |
| **uv** | Python package manager — installed automatically by both installers if missing |

---

## ⚡ Quick Start

### Linux

```bash
# 1. Clone this repo and ACE-Step-1.5 side by side (see full install below)
git clone https://github.com/Sion971/ace-step-studio.git
cd ace-step-studio

# 2. Run the installer — handles GPU detection, PyTorch, dependencies,
#    database migration, and the isolated MIDI conversion environment
./install.sh

# 3. Start everything (frontend + backend + AI engine) in one terminal
./run.sh
```

### Windows

```powershell
# 1. Clone this repo and ACE-Step-1.5 side by side (see full install below)
git clone https://github.com/Sion971/ace-step-studio.git
cd ace-step-studio

# 2. Run the installer — same idea as Linux, uv-managed Python throughout
install.bat

# 3. Start everything (frontend + backend + AI engine) in one terminal
run.bat
```

That's it — the UI opens automatically at `http://localhost:3001`.

---

## 📦 Installation

### 1. Get ACE-Step 1.5 (the AI engine)

```bash
git clone https://github.com/ace-step/ACE-Step-1.5.git
```

Place it alongside this repo — the launcher expects `../ACE-Step-1.5` relative to this project by default (configurable).

### 2. Clone this repo and run the installer

<details>
<summary><strong>Linux</strong></summary>

```bash
git clone https://github.com/Sion971/ace-step-studio.git
cd ace-step-studio
./install.sh
```

The installer walks through thirteen steps, all self-checking and safe to re-run:

1. System dependencies (FFmpeg, libsndfile) via apt, only if missing
2. Working directory structure
3. GPU / CUDA selection (Pascal through Blackwell, or CPU-only) and Python virtual environment (via `uv`)
4. Build tools
5. PyTorch, matched to your selected CUDA version
5b. NVIDIA NPP (a `torchcodec` runtime dependency that PyTorch doesn't pull in on its own)
6. ACE-Step dependencies, including a real compute-capability check before attempting `flash-attn` — skips it cleanly (falling back to SDPA) rather than burning hours on a build that can't succeed on your hardware
7. `pytorch_wavelets` patch — works around a `pkg_resources` removal in modern `setuptools` that otherwise silently disables the optional DCW sampler correction
8. `torchcodec` load verification
9. Node.js check
10. npm install (frontend and server)
11. Frontend build
12. Database migration (playlist/workspace schema) — idempotent, safe on every reinstall
13. Isolated `basic-pitch` environment for MIDI conversion (Python 3.11 via deadsnakes PPA)

</details>

<details>
<summary><strong>Windows</strong></summary>

```powershell
git clone https://github.com/Sion971/ace-step-studio.git
cd ace-step-studio
install.bat
```

The installer walks through ten steps, all self-checking and safe to re-run:

1. `uv` install (if missing) and GPU / CUDA selection (Pascal through Blackwell, or CPU-only)
2. Python 3.11 virtual environment (via `uv`)
3. PyTorch, matched to your selected CUDA version
4. ACE-Step dependencies, including `flash-attn` — a prebuilt wheel on Blackwell (RTX 50-series), verified specifically for Python 3.11 + PyTorch 2.7 + CUDA 12.8, no local compiler needed
5. `pytorch_wavelets` patch — same `pkg_resources` fix as Linux, same reasoning
6. Node.js
7. npm install (frontend and server)
8. Frontend build (FFmpeg is downloaded automatically around this point too, if missing)
9. Database migration (playlist/workspace schema) — idempotent, safe on every reinstall
10. Isolated `basic-pitch` environment for MIDI conversion, its own `uv`-managed venv to avoid a `tensorboard`/`tensorflow` version conflict with ACE-Step's own pin

If `torchaudio` fails to load with `Could not find module ... (or one of its dependencies)`, install the [Microsoft Visual C++ Redistributable](https://aka.ms/vs/17/release/vc_redist.x64.exe) — a very common missing piece for compiled Python extensions on a fresh Windows install, unrelated to this project specifically.

</details>

Models download automatically on first run (~5GB).

### 3. Start the app

<details>
<summary><strong>Linux</strong></summary>

```bash
./run.sh
```

**Options:**

| Flag | Effect |
|------|--------|
| `--no-lm` | Skip the local 5Hz LM (0.6B) — frees ~1GB VRAM, good for LoRA training |
| `--gradio-only` | ACE-Step's own Gradio UI only (port 8001), no Express/React frontend — needed for dataset labeling |
| `--no-browser` | Don't auto-open a browser tab |
| `--port <n>` | Web server port (default 3001) |

</details>

<details>
<summary><strong>Windows</strong></summary>

```powershell
run.bat
```

Same flags as Linux (`--no-lm`, `--gradio-only`, `--no-browser`, `--port <n>`).

</details>

---

## 🎼 Generation Modes

### Simple Mode
Just describe your song in natural language — genre, mood, instruments — and let ACE-Step handle the rest.

### Custom Mode
Fine-grained control over BPM, key, time signature, duration, and structure tags in your lyrics.

### AI Enhance & Thinking Mode
AI Enhance enriches short genre tags into detailed captions with proper metadata. Thinking Mode lets the model reason about song structure before generating audio codes — better results, more VRAM.

### Batch Size & Bulk Generation
Generate several variations of the same prompt in one pass to compare results quickly.

---

## 🔧 Built-in Tools

**Audio Editor (AudioMass, multitrack)** — trim, fade, apply effects. Open a single stem directly from your library, or send all four Demucs stems over together as separate tracks in one editor session.

**Stem Extraction (Demucs)** — runs in-browser via ONNX, separates vocals/drums/bass/other. Each stem can be downloaded, converted to MIDI, or sent straight to the editor.

**MIDI Conversion (basic-pitch)** — runs server-side in its own isolated environment, converts any stem to MIDI in seconds.

**LoRA Training** — scan your dataset, label, preprocess, and train, all from the UI.

**Video Generator** — turn a track into a music video with Pexels stock backgrounds.

---

## 🐛 Troubleshooting

| Issue | Solution |
|-------|----------|
| **ACE-Step not reachable** | Ensure Gradio server is running with `--enable-api` (handled automatically by the launcher) |
| **CUDA out of memory** | Set batch size to **1**, reduce duration, or disable Thinking Mode |
| **4GB GPU — Out of memory** | Batch size **1**, Thinking Mode **off**. LLM features need 12GB+ |
| **`flash-attn` build fails or errors at runtime (Linux)** | Check your `nvcc` version supports your GPU's compute capability — see `install.sh` step 6, or fall back to `--no-lm` if you just need generation working now |
| **`torchaudio` fails to load with "Could not find module ... (or one of its dependencies)" (Windows)** | Install the [Microsoft Visual C++ Redistributable](https://aka.ms/vs/17/release/vc_redist.x64.exe) |
| **DCW disabled with a `pytorch_wavelets` warning** | Both installers patch this automatically (step 7 on Linux, step 5 on Windows) — if it's still happening, run `patch-pytorch-wavelets.py` manually against the relevant environment |
| **Songs show 0:00 duration** | Linux: `sudo apt install ffmpeg`. Windows: delete the `ffmpeg\` folder and re-run the installer |
| **LAN access not working** | Check firewall allows the port you're running on (default 3001) |

More detail in `TROUBLESHOOTING.md`.

---

## 🙏 Credits

- **[ACE-Step](https://github.com/ace-step/ACE-Step-1.5)** — the underlying open source AI music generation model
- **[timoncool/ACE-Step-Studio](https://github.com/timoncool/ACE-Step-Studio)** — the project this fork is built on
- **[AmbsdOP/ace-step-ui](https://github.com/fspecii/ace-step-ui)** — the original UI this was in turn based on
- **[@bdsqlsz](https://space.bilibili.com/29863478)** — Chinese localization, carried over from upstream
- **[AudioMass](https://github.com/pkalogiros/AudioMass)** — web audio editor
- **[Demucs](https://github.com/facebookresearch/demucs)** — audio source separation
- **[basic-pitch](https://github.com/spotify/basic-pitch)** — audio-to-MIDI conversion
- **[Pexels](https://www.pexels.com)** — stock video backgrounds

Built with [Claude](https://claude.ai) (Anthropic) as a development pair — most of this fork's Linux port, features, and this very README were worked through together, session by session.

---

## 🤝 Contributing

This started as a personal project to get ACE-Step Studio running well on Linux, and it's grown from there. It's not actively looking for contributors, but issues, questions, and pull requests are welcome if something's broken or you've got an improvement in mind.

---

## 📄 License

MIT License — see [LICENSE](LICENSE). Original copyright retained; this fork's changes are released under the same terms.

---

<p align="center">
  <em>Built on the shoulders of ACE-Step, AudioMass, Demucs, and everyone who worked on this UI before it got here.</em>
</p>
