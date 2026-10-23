# Changelog

## 2026-10-22

### Documentation
- README: the requirements now say that cards from 2 GB work (stream mode), with a new section "Which graphics card?" (what the installer chooses from 2 GB to more than 8 GB, the normal / stream choice for 4 to 8 GB cards, measured times), the `--mode` flag, and the small-GPU troubleshooting rows brought up to date.

### Added
- Server terminal: one line per generation with what is really sent to the engine (`[Generate] vocal_language=fr, duration=225 s, bpm=90, lyrics=31 lines, task=text2music, steps=8`), to tell at a glance whether a wrong language or length comes from the request or from the engine.
- LoRA catalog: the rap LoRA for the XL models (RyanOnTheInside, `rap-acestep1.5-xl-v1`) is a candidate: `npx tsx src/scripts/verify-lora-catalog.ts --promote` pins it (commit, checksum, size) and moves it into the catalog.
- Duration on "auto" with lyrics: without the language model the engine used a fixed 120 s, and long lyrics did not fit (words were skipped). The server now estimates the length from the lyrics (sung lines, long lines, echoes in parentheses, intro / outro / solo sections, tempo when one is set), between 60 s and 300 s (the engine's limit if lower), rounded to 5 s. A line lasts a number of bars (1.25 + one per 8 words, between 1.75 and 3) and a bar lasts 240 / bpm seconds (100 bpm when none is set); calibrated on a 3:59 song of 30 lines at 90 bpm (estimate: 4:05). Log line `[Duration] auto: N s estimated from the lyrics`. Not used for an instrumental, for a cover or a repaint (the source sets the length), when "thinking" / "enhance" is on (the language model chooses), nor when a duration is set by hand. `STUDIO_AUTO_DURATION=off` keeps the engine's 120 s.
- NVIDIA card of 4 to 8 GB (Turing or newer): the installers (`install.sh`, `install.bat`) now ask whether to use the normal mode or the stream mode, with what each costs, measured on an RTX 5060 8 GB. The choice is kept in `hardware_profile.env` (`HW_MODE_PREF`) together with the stream settings for such a card (`ACESTEP_STREAM_COMPUTE=bfloat16`, `ACESTEP_STREAM_RESIDENT=auto`, `ACESTEP_STREAM_RESERVE_GB=1.5`, `ACESTEP_LM_CUDA_GRAPH=1`), which the launchers pass to the engine unless the environment or `ACE-Step-1.5/.env` already sets them. No more `.env` editing. It can be changed without reinstalling: `./run.sh --mode normal|flux`, `run.bat --mode normal|flux`. Cards of 3 GB or less still go to the stream mode by themselves, cards above 8 GB stay in the normal mode. New files: `hardware-mode.sh`; `write-hardware-profile.py` gets `--can-choose`, `--get-mode`, `--set-mode`.
- LoRA catalog window: search box (name, genre, tags), model size buttons (All / XL / 2B, set by default on the size of the loaded model) and genre list, with a count of the entries shown. A LoRA whose size is not known is never hidden by the size filter.
- LoRA catalog: three XL LoRA by RyanOnTheInside (techno, alternative, lo-fi), pinned to a commit and a checksum, tested by the maintainer.
- The engine now restarts by itself after a lost CUDA context ("Sticky error", illegal memory access, device-side assert...). A generation that fails with such an error gets a clear message, the engine is stopped and restarted by the pipeline manager, and the queue waits for it (5 minutes at most) before it starts the next generation. A plain error such as "out of memory" restarts the engine only when it happens twice in a row. Server log: `[Pipeline] CUDA context lost: restarting the engine`, `[queue] the engine restarts after a CUDA error: the next generation waits for it`, `[queue] the engine is back`.

### Fixed
- Create page: changing the model now also sets "Shift" (turbo: 3, base / SFT: 1), as it already did for Steps, Guidance and ADG; it stayed on 3 when switching to a base model. The user can still change it afterwards. On a turbo model the slider offers 1, 2 or 3 (the only values these models accept); on base / SFT it stays continuous from 1.0 to 5.0.
- Create page, advanced settings: the "Shift" slider was after the seed, far from Steps and Guidance; it is now right under them. Its help said "not effective for turbo" / "only affects the base model", which was wrong: the turbo models use it (3 with 8 steps, and they round any value to 1, 2 or 3), the base and SFT models use 1 with about 50 steps. Texts corrected in the six languages.
- Time signature: the song sheet showed "4" for one song and "4/4" for another (the engine answers both ways), and the "Time" menu of the Create page listed 2, 3, 4, 6. Both now show the full form (2/4, 3/4, 4/4, 6/8). Only the display changes: the engine still receives 2, 3, 4 or 6.
- LoRA panel after a change of tab: the Create page is rebuilt when you come back from Library, Training... and forgot that the LoRA was loaded (the engine still held it), so "Load" answered 422 "Adapter name already in use". The panel now reads the real state from the server when the page opens (loaded, path, scale, on/off), and takes "already in use" for "already loaded". The server also forgets the LoRA when the engine restarts.
- LoRA on an XL model in normal mode with a card of 8 GB or less: the engine moves the whole model to the card to load the adapter and ran out of memory ("CUDA out of memory" in `add_lora`, then an engine restart). The load is now refused before the engine is asked, with the way out (flux mode: `./run.sh --mode flux`), and an out-of-memory reply from the engine for any LoRA gets the same explanation.
- Start-up screen (`run.sh`, `run.bat`): a card of 4 to 8 GB that chose the stream mode was announced as a "small card"; it now says "stream mode chosen" and how to go back (`--mode normal`).
- Normal mode on an 8 GB card, lyric alignment (LRC) and lyric score: on a 3-minute track the card could run out of memory ("CUDA out of memory, tried to allocate 172 MiB" in `get_lyric_timestamp`; the synchronized lyrics were missing, the track itself was fine; one LRC out of six in a test log). The cross-attention of the alignment is now computed 4 heads at a time (`ACESTEP_ALIGN_HEAD_CHUNK`) and only the heads the alignment reads are kept, instead of the weights of all the heads of a layer at once, with several float32 copies while the softmax runs. Same values as before (new tests compare with the plain decoder). Stream mode is unchanged. The first version of this fix edited the model files of the repository, but the engine runs the copy of the model code that comes with the checkpoint (`models/modules/transformers_modules/<model>/`), so it had no effect (the same error came back in a test log); the attention function of that copy is now replaced at run time (`models/common/alignment_attention.py`).
- Stream mode, lyric alignment (LRC) and lyric score: on a PC with 32 GB of RAM the engine's memory grew by about 17 GB in 9 seconds during the LRC (0.5 GB per DiT block, measured on Windows) and the PC froze for several seconds. Each streamed block computed the cross-attention of all its heads on the card and sent them all to the processor, although only a few heads of a few blocks are read. The blocks now keep only those heads on the card side (`alignment_heads`, `StreamPool.select_alignment_heads`) and send nothing else, the self-attention weights included; the values are the same (new tests compare with the plain decoder). The LRC also gets faster (the transfer was about 4 s on a 4-minute track).
- LoRA recommended settings (panel and catalog): on a turbo model, "Guidance: 7" now reads "Guidance: 7 (ignored by turbo models)" (the engine forces the guidance of a turbo model to 1.0, so the author's figure only counts for a base or SFT model).
- Create page, advanced settings: the six CFG presets (Default, Clear vocals, Creative, Cover, Strict, ADG) are laid out in two rows of three, and the four menus of the sampling row (format, method, sampler, scheduler) have centred titles and values; the format menu reads "FLAC" / "MP3" (the long text stays in the tooltip) so that it fits like the others.
- Create page, advanced settings: the Guidance (CFG scheduling) block is now a collapsed panel like LoRA, placed right after Shift, and is hidden on turbo models where it has no effect; the "Audio format" menu sits on the same line as the three other sampling menus.
- Create page: the DCW quality correction block is now hidden on non-turbo models (it was greyed out and unusable there), and DCW is never sent enabled to a non-turbo model, even if an old saved setting had it on.
- Create page, advanced settings: removed the duplicates of the AUDIO block (read-only task type, repaint strength and the start/end fields of the region, which were even shown outside repaint mode); only the inpainting mode and the instruction remain. The four sampling menus now keep their selects on one line whatever the width of the panel, even when a title wraps.
- Repaint: the "Repaint mode" menu is gone from the advanced settings. The engine's three modes are only steps of the strength (0 = conservative, 1 = aggressive, in between = balanced), so the "Strength" slider of the AUDIO block now drives it alone; the help text under it states the direction clearly (0 % = stay close to the original, 100 % = regenerate freely).
- Create page, advanced settings: removed the last duplicate of the AUDIO block, the "Audio cover strength" number field of the Transform section (the "Audio cover strength" slider of the AUDIO block does the same).
- Audio block: three new modes, Lego (add a track), Extract (isolate a track) and Complete (add the missing tracks around one), for pure base models only (XL Base, Base). The track is chosen in the AUDIO block, which replaces the "Track name" and "Complete track classes" fields of the advanced settings. The server now builds the engine instruction from the chosen track (it used to send the generic text-to-music sentence, so the engine did not know which track to make), and refuses the request with a clear message when the model is a turbo/SFT one, when no source audio is loaded or when no track is chosen. The Create button is disabled with the same explanation.
- Flow-edit moved from the advanced settings (where it sat under DCW, and was offered even for plain text-to-music) into the AUDIO block, in Cover mode only once a source audio is loaded: the engine needs that source audio. It is never sent enabled outside Cover mode.
- Lego and Complete: option "Also make a mix with the original" (on by default, level of the new track 80 % by default). The engine only returns the new track; the server now also builds a mix with the source audio (ffmpeg, no clipping) and saves both songs, "(stem)" and "(mix)". For Lego the mix is only made when the region covers the whole audio. Warnings in the AUDIO block when the Lego region is shorter than 3 s (the engine's minimum) and when Style is empty; the server now falls back on the requested track name (e.g. "guitar") instead of "pop music" as caption.
- Server terminal: the `[Generate]` line now also shows the key, the guidance, the shift, the ADG and the seed that is really sent to the engine (`key=G major, guidance=7, shift=1, adg=on, seed=2900000000`, or `seed=random`), to compare a good generation with a bad one and to check that a fixed seed reaches the engine.
- Region fields (Repaint / Lego): the arrows of the start and end fields no longer climb past the end of the audio; typed or stepped values are kept between 0 and the length of the loaded audio (and the end never goes before the start).
- Server terminal: the `[Generate]` line shows the region of a Lego / Repaint (`region=0-end`), and a `[Mix] no mix made: ...` line says why no mix was built (option off, region that does not cover the whole source, ...).
- Mix with the original (Lego / Complete): the option and its level were dropped on the way to the server (App.tsx rebuilt the request without them), so no mix was ever made; they are now forwarded.
- Guidance: Lego, Extract and Complete on a base model start at 5 instead of 7 (measured on an XL Base: 5 gives the fewest artefacts, below 4.5 the track loses the thread). It works in both orders, mode first then model or model first then mode (changing the model used to put 7 back); a value changed by hand is never overwritten, and leaving the per-track modes puts 7 back only if 5 is still the value the Studio had set.
- New "Studio" tab (menu, `/studio`): the audio editor shown inside the app, with a search bar over your songs (title, style, tags). A click on a song puts it on a new track of the editor, so several songs can be stacked and mixed. The editor got a small entry point for it (`RequestAddTrackFile`: the file goes on the first empty track, or on a new one). First step towards adding generated instruments to a song from this tab.
- Studio tab fixes: typing in the search bar no longer blanks the screen (a song whose tags are a plain text crashed the filter); the green mark next to a song follows the editor (it goes away when the track is deleted); a selector chooses "All my songs", "My Workspace" or a named workspace; a new track in the editor takes the first free "Channel N" name instead of repeating one after a track was deleted.
- Studio tab, "Add an instrument": under the song list, pick a song that is in the editor, an instrument (keyboards, percussion, brass, guitar, bass, strings, synth…), a style, a Base model and the guidance (5 by default), then "Generate and add as a track". It runs Lego over the whole song with the settings measured best (50 steps, shift 1, ADG, FLAC, no mix, key / tempo / length taken from the song) and the new track alone comes back as a new track of the editor; the song list is refreshed too. Needs a Base or XL Base model.
- Studio tab, "Add an instrument" fixes: the Base model is now loaded before the generation (the engine used to keep the model that was active, a Turbo one, which clamped the steps to 8 and the guidance to 1 whatever the panel said); a "part of the song" range (from / to in seconds, or the "Selection" button that takes the range selected in the editor) generates only that part, and the new track is cut to it and placed at its start in the editor.
- Studio tab: the song list was cut at the 100 newest songs, so the older ones (made with earlier models) could only be reached by searching. It now shows how many songs match, a "Show more" button adds 100 at a time, and each row names the model the song was made with.
- Studio tab: a "Select" button over the song list lets you tick several songs (or "Select all shown") and delete them at once, with the usual confirmation.
- Removed from the advanced settings: the "Instruction" field (the server already picks the right instruction for each task, and a text left over from another mode could silently spoil a generation) and the "Convert to Codes" / "Transcribe" buttons (they only wrote to the browser console).
- Studio tab, "Add an instrument": the "Selection" button takes the selected range, or, when there is none, the span of the selected clip. Also puts back the editor's own `GetRegion` (a previous change had replaced it by a copy without the loop flag); the Studio uses a separate `GetStudioRange`.
- Studio tab, "Add an instrument": BPM, key and seed fields. The tempo and key of the chosen song fill them and can be corrected (a wrong tempo or key stored with the song, e.g. 50 bpm for a track that is really around 85, made Lego produce noise); empty = left to the engine. A typed seed makes a run repeatable; empty = random.

## 2026-10-21

### Documentation
- `TROUBLESHOOTING.md` section 61: small card with little RAM (freeze, "Sticky error", cover unload delay, Windows page file on a fast disk, Re-Size BAR).

### Fixed
- Windows/small cards: a music generation could start while the AI cover of the previous song was still being made. Both use the card, the engine ran out of memory ("CUDA error: out of memory", then "Sticky error": every later generation failed until restart). The queue now waits for the cover in progress (5 minutes at most) before it starts the next generation. The cover itself already waited for the music jobs.

### Added
- Covers: `ACESTEP_COVER_IDLE_S` (seconds, at least 5; in `ACE-Step-1.5/.env`) sets how long the AI cover worker stays loaded after the last cover. It keeps about 9 GB of RAM while loaded, so a PC short of RAM can free it sooner (the next cover reloads it in a few seconds). Default unchanged: 180 s.

### Fixed
- Alignment of the lyrics (LRC) and lyric score: the decoder returned the cross-attention of all 32 layers x 32 heads, and several copies of it were made, which filled about 31 GB of RAM on a track (the PC froze on Windows). It now returns only the layers and heads of the alignment configuration, joined in the configuration's order, and stops after the last layer needed. The scorer reads the same values (new tests compare with the full attention).
- Stream mode: after the synchronised lyrics (LRC) or the score, the engine kept about 6 GB of DiT blocks on the card, so the AI cover worker (SDXL Turbo) ran out of memory and crashed. The card is now given back once the lyric alignment and the score are done (`give_card_back_if_active`); the regular card mode is not affected.

### Changed
- Windows: the Desktop and Start menu shortcut now starts `run.bat --quit-on-close`, like the Linux launcher: closing the last browser page stops the server and the engine, and the console window closes with them (it stays open only after an error). Running `run.bat` by hand keeps the old behaviour (the Studio runs until the window is closed). Re-run `create-shortcut.bat` to update an existing shortcut.

## 2026-10-20

### Added
- Windows: `create-shortcut.bat` creates the "ACE-Step Studio" shortcut on the Desktop and in the Start menu, with the icon from `app/docs/Ace-Step UI.ico` (`--no-desktop`, `--no-menu`, `--remove`). `install.bat` runs it at the end.

### Fixed
- Windows: the "Delai de generation" line printed by `run.bat` at start-up was empty in small-card stream mode when no delay was configured; it now shows the engine's default (600 s), like `run.sh`.
- LoRA panel: the hint under the trigger word no longer says the style applies only with it. A LoRA acts on every generation whatever the prompt (the word is the author's recommendation to bring the style out more).
- Windows: the "already running" check of `run.bat` sat inside the argument loop, so it never ran when `run.bat` was started without arguments (a second launch started a second server). It now runs once the arguments are read, and asks PowerShell (.NET) for the listening TCP ports instead of reading `netstat`.
- LoRA panel, fresh install: after installing a LoRA from the catalog, "Load" sent the default path `./lora_output/final`, which does not exist yet (error 422 "LoRA path not found"), while the drop-down already showed the new LoRA. The panel now picks the first LoRA of the list whenever the chosen path is not in it, including when the list is refreshed after an install.
- Windows: the length of a song could not be read when Smart App Control had not yet accepted `ffprobe.exe` ("Failed to get audio duration"), although `ffmpeg.exe` already ran. The server now falls back to the engine's Python (soundfile) when ffprobe cannot be run, and `install.bat` / `run.bat` wait for `ffprobe.exe` (and `ffmpeg.exe`) like they wait for the other native files.

## 2026-10-19

### Version 2.0.0
- The project moves from 1.0.0 to 2.0.0: the way the app is used on a mid-range card has changed radically. An 8 GB card (RTX 5060 tested) now runs the XL model in stream mode with LoRA adapters and AI covers (SDXL Turbo), and the 5Hz LM runs on CUDA graphs without growing the card's memory. Measured on that card, an XL LoRA costs about 0.6 s on a 9.3 s DiT pass (under 1% of a 179 s generation); on Turbo it costs nothing (24 of 24 blocks stay on the card). `app/package.json` and `app/server/package.json` carry the new number.

### Added
- `create-shortcut.sh` (Linux): creates the "ACE-Step Studio" launcher in the applications menu and on the desktop, with the icon from `app/docs/Ace-Step UI.ico` (converted to PNG, which desktops read better). `install.sh` runs it at the end; it can be run again at any time (`--no-desktop`, `--no-menu`, `--remove`). The launcher starts `launch-ace-step.sh`, so closing the page stops the Studio.
- `run.sh` / `run.bat`: a second launch while a session is running is now refused before it touches anything. It checks the web port (3001 by default) and the engine port (8001); if one answers, it prints a message (with the address to open) and exits, instead of emptying the running session's Gradio cache and fighting it for the card and the ports. `--gradio-only` only checks 8001. The Windows check asks PowerShell for the listening TCP ports (IPv4 and IPv6), so it does not depend on the language of Windows.
- Small-card stream mode: LoRA adapters now work (on any card in this mode, the 2 GB one included). PEFT cannot wrap blocks that pass through two card slots, so the adapter is added where the weights arrive: right after a block is copied to the card, `weight += strength * alpha / r * (B @ A)` is worked out on the card in float32 and rounded once into the weight. The RAM copies are never touched, so switching the adapter off, changing its strength or removing it only rebuilds the card copies (no copy of the base weights is kept). PEFT LoRA adapters on the linear layers of the DiT blocks are supported (`r`, `lora_alpha`, `use_rslora`, `rank_pattern`, `alpha_pattern`); DoRA, transposed weights and LoKr are refused with a reason; weights outside the blocks are ignored and counted in the message. The factors travel over the bus with each block (a few percent more). The panel's "Load" is no longer greyed out in this mode and `POST /api/lora/load` no longer answers 409
- 5Hz LM (PyTorch backend, NVIDIA cards): the one-token decoding steps now run through CUDA graphs. A step was limited by Python launching hundreds of small kernels (about 28 ms per token, the same for the 0.6B and the 1.7B model); a graph replays them with one call. The key/value pairs of the prompt are copied into a fixed buffer, one graph is captured per window of 256+ positions as the generation grows, and the second step is run both ways and compared before the graph is trusted. If anything differs or fails, the usual decoding goes on. Measured on an RTX 5060 8 GB, 895 audio codes: 0.6B 25.8 s to 14.5 s, 1.7B 28.1 s to about 20.5 s. On by default with CUDA; `ACESTEP_LM_CUDA_GRAPH=0` turns it off, `=1` forces it elsewhere (ROCm). The sampled tokens may differ from the usual loop's on a close call (the rounding changes); the result is as valid, not identical
- 5Hz LM: it is warmed up with a few made-up passes when it is loaded, so the first generation after the start (phase 1 went from 10.7 s to 2.4 s with the 0.6B) is no longer slower than the next ones. `ACESTEP_LM_WARMUP=0` turns it off
- `ACESTEP_LM_PROFILE=1`: one line of time per token and per part of the step in the 5Hz LM loops (measurement only, leave it off otherwise)
- `ACESTEP_MEM_DEBUG=1`: after each garbage collection on a card, `[mem]` lines say how much memory the card holds, how much of it Python can see (weights or other tensors), and what holds the largest tensors. About a second per line: for measurements only
- `[lm_graph]` and `[gc]` log lines: what the graphs cost to capture, what the card held before, at the end and after each generation, and what a garbage collection freed

### Fixed
- AI cover: the cover appeared in the song list once made, but the detail panel (and the player) kept the song with the default gradient until the song was clicked again. When the list is reloaded after the cover is saved, the selected song and the playing song now take its cover
- 5Hz LM graphs: the card kept 130 to 190 MB more after every generation (257 MB after the first, 1089 MB after the sixth, up to about 1 GB). Python could not see it: cuBLAS keeps a 32 MB workspace for every CUDA stream it runs on and never gives it back, and each graph capture created a new stream for its warm-up steps. The captures now share one stream per card. The card's memory stays flat from one generation to the next (3730 MB with the 1.7B model, 1394 MB with the 0.6B, over three long generations), and "Offloaded LLM to CPU" takes 0.01 s instead of 0.36 s

### Changed
- End of a generation: `gc.collect()` (0.35 s each, four times per generation, and it freed 0 MB every time in the measurements) now only runs when the card still holds more than 256 MB. Measured on short and long tracks: post-processing 2.3 s to 0.9 s
- 5Hz LM: the graphs, their buffers and the static cache are released explicitly at the end of each generation
- AI covers (SDXL Turbo) in stream mode: they were refused whenever `HW_MODE=stream`, even on a 6 to 8 GB card (stream mode is also used there when the XL model does not fit), where the card has the room. They are now refused only under 6 GiB of card memory (the size PyTorch sees, from `hardware_profile.env`); an unknown size still counts as too small. `STUDIO_COVERS_ON_STREAM=on` or `off` forces the answer. If the card turns out too full when a cover is made, the song keeps its default gradient, as before

## 2026-10-18

### Added
- Small graphics cards (3 GB or less, e.g. a GTX 1050 with 2 GB) now speed up generation instead of sitting unused: new hardware mode `stream`. The engine stays on the processor; the card runs the DiT one block at a time (the weights stay in RAM in bfloat16, two float32 slots on the card, the next block is copied while the current one is computed) and decodes the audio in small float32 tiles. Measured on a GTX 1050 (2 GB): a DiT step 12.7 s -> 1.26 s, audio decoding 170 s -> about 10 s, output equal to the processor's (relative difference 2e-6), 0.8 GB of VRAM for 30 s of audio. The engine part is `acestep/core/generation/handler/small_gpu_stream.py`, switched on by `ACESTEP_SMALL_GPU_STREAM=1`, which the Studio sets when `HW_MODE=stream`
- `install.sh` and `write-hardware-profile.py` (Windows) choose `stream` when PyTorch sees 3 GB or less on an NVIDIA card (a CUDA PyTorch must be installed: pick the GPU option, not "CPU only"); `STUDIO_SMALL_GPU=off` keeps the old mode. The mode appears on the start-up screen; the generation time limit is 1800 s
- In this mode the int8 quantization is off and LoRA adapters are refused with a clear message; AI covers stay unavailable (the card is kept for the music model), with their own explanation
- Small-card mode, condition encoder: the 12 text/lyrics/timbre layers (and the 4 layers of the audio tokenizer/detokenizer) now also pass through the card one block at a time (a second, smaller pool; its slots are given back before the DiT and the audio decoding). When the song is not a cover, the engine's audio tokenize/detokenize step is skipped: its result was thrown away in that case (`torch.where(is_covers > 0, hints, src_latents)`), so the output is identical. Covers, precomputed hints and audio codes keep the full path. On the GTX 1050 the condition encoder took 17.8 s of the 73.6 s for 30 s of music
- Closing the Studio page now stops the Studio when it was started with `--quit-on-close` (which `launch-ace-step.sh` does, so the desktop shortcut without a terminal window can finally be stopped): every open page keeps one `GET /api/presence` stream; when the last is gone for 20 s the server and the engine shut down, but never while a generation, a training run, a model download or a LoRA install is running. Nothing changes for a normal start from a terminal.
- Small-card stream mode, option for cards of 6 to 8 GB whose DiT does not fit (e.g. an XL model on 8 GB): `ACESTEP_STREAM_COMPUTE=bfloat16` makes the card compute in bfloat16 instead of float32, and `ACESTEP_STREAM_RESIDENT=auto` (or a number of blocks) keeps the first blocks on the card so only the others cross the bus at each step (`ACESTEP_STREAM_RESERVE_GB`, default 2.5, is left for the activations). If the card still runs out of memory the resident blocks are halved and the block retried. Both are off by default: the 2 GB behaviour is unchanged. Still no LoRA in this mode. Checked on the processor only; to be measured on a real card.
- Small-card stream mode: one line of figures is logged after each generation (`[small_gpu_stream] DiT … block runs in … s | weights: … GB streamed … GB/s, pinned RAM: … | computing … waiting for weights … | activations … | resident blocks …`), and the startup line says whether the RAM copies are pinned; a warning is logged when pinning failed. It tells whether the time goes to the bus, to the computation or to the activation transfers. `ACESTEP_STREAM_STATS=0` turns it off.
- Small-card stream mode, diagnostic `ACESTEP_STREAM_CHECK=1`: during the first generation each block computed on the card is compared with the same block computed on the processor in float32, and the log says whether the streaming changes the numbers (`[small_gpu_stream] self-check DiT: … worst relative difference … -> OK` or `SUSPECT`, the same for the condition encoder, then the figures block by block). Use a short track: the processor is slow.
- Small-card stream mode, diagnostic `ACESTEP_STREAM_MEMORY=1`: one line on the card's memory at the main points of a generation (start, after the condition encoder, before and after the DiT blocks are placed, after the card is given back, after the audio decoding): free memory, what torch holds (in use / idle cache) and, through `nvidia-smi`, what this program holds against what other programs on the card hold. It is meant to find where the card's memory goes between the first generations (the number of resident blocks went 21 -> 20 -> 18 on an RTX 5060). Off by default; nothing changes without the variable.

### Fixed
- Video Studio: the warning "the background video could not be loaded — an image is used instead" appeared although the video was loaded and played fine in the preview. Releasing the previous background video (when it is replaced or the style changes) makes the browser fire an "empty source" error on that old element, which was taken for a failure of the new one. The old element is now silenced before it is released (`services/backgroundVideo.ts`); a video the browser really cannot read is still reported
- Small-card stream mode: the same seed gave another track than the regular card mode. The engine runs on the processor there, and the starting noise was drawn by the processor's generator (float32) instead of the card's (bfloat16). The noise is now drawn on the card in the regular mode's format, so a seed gives the same starting point in both modes and the two can be compared fairly (`ACESTEP_STREAM_NOISE=cpu` brings the old draw back). A track made in this mode before this change will not come out again from the same seed.
- Bulk generation ("10 jobs"): the songs came out in a different order from their numbers (for example (1), (2), (10), (9), (3), (4)). The ten requests were sent to the server all at once, so they overtook each other (the browser's limit of parallel connections, parallel requests on the server) and the engine received them in a varying order. They are now sent one after the other, each waiting only for the server to accept it (not for the end of the generation), so the engine receives (1), (2), (3)… in order. The bulk counter is reset when the batch starts instead of when it ends, so a second click during the sending does not repeat the batch.
- Small-card stream mode: after each audio decoding the VAE left about 0.3 GB of weights on the card for as long as the Studio ran. The decoder's convolutions use the (deprecated, hook based) `weight_norm`, which keeps the weight it computes for each forward as an ordinary attribute; `Module.to("cpu")` moves parameters and buffers but not those attributes. The memory log (`ACESTEP_STREAM_MEMORY=1`) showed it: `torch in use` went from 0.03 to 0.35 GB after the first decoding and stayed there, which cost two resident DiT blocks (20 -> 18 on an RTX 5060, about 0.4 s more of weight copying on a 30 s track). The leftovers are now moved back to the processor right after the decoding (the next forward recomputes them), so the card keeps its room. To be confirmed on the real card with the memory log: `torch in use` about 0.03 GB after the audio decoding and 20 resident blocks on every generation.

### Changed
- Waiting window at start-up: opening the Studio while the engine is still loading its models (an ordinary start, a minute or two on a small card) now shows the "Starting the engine" window, with the pulsing bar, until the engine is ready, then "Ready" for a moment; "Continue without waiting" still sets it aside. It is shown only when the page is opened on a starting engine, not on a restart while the page is open
- Small-card mode: the LoRA panel no longer shows the "INT8 quantization" switch nor "turn it off to load a LoRA" (the engine does not quantize there, whatever its start-up form said); `GET /api/lora/quantization-status` answers `false` with `small_gpu: true` without asking the engine, and `POST /api/lora/toggle-quantization` answers `409` (`small_gpu`)
- `launch-ace-step.sh` finds the Studio from its own location (following a symbolic link) instead of a path written for one user
- `npm run lora:verify`: when the candidate list is empty it says why (a previous `--promote` moved the verified ones into `catalog/lora-catalog.json`, which must be committed), and `--promote` reminds to commit both files
- LoRA catalog: six candidates are prepared in `app/server/catalog/lora-catalog.candidates.json` (Refine Redmond, acoustic guitar, ambient, raspy male vocals, rock/acoustic/electronic instrumentals, Chinese New Year), and `npm run lora:verify` (from `app/server`) installs them from the real Hugging Face with the Studio's own code, checks the checksums and, with `--promote`, moves those that passed into `lora-catalog.json` pinned to the commit and the checksum that were seen. Candidates are not offered in the app until promoted, because the shipped catalog only lists what is pinned
- LoRA in small-card mode (`HW_MODE=stream`): the DiT blocks pass through the card one by one, so no adapter can be applied. The LoRA panel now says so as soon as it opens and greys out "Load" (browsing and installing from the catalog still work), and `POST /api/lora/load` answers `409` with the code `small_gpu` before asking the engine; `GET /api/lora/status` carries `small_gpu`. New text `loraHubSmallGpu` in six languages
- AI covers draw from the lyrics: for a song with lyrics (not an instrumental), the cover prompt now carries the chorus (else the first verse) instead of the description of the sound. Instruments ("solo piano", guitar, chords) are dropped from the caption, which is what turned so many covers into pianos. Section tags, ad-libs, repeated lines and face-drawing words ("baby", "girl"…) are removed from the excerpt. The scenery clause now comes before the caption, so it stays inside the part of the prompt the image model reads. When the language model writes the song, its own cover prompt (made from the lyrics) is still the one used
- The "regenerate cover" window starts from the same prompt, with the song's lyrics
- Small-card stream mode: the activations now stay on the card from one block to the next instead of going back to the processor after every block (32 times per step), and the inputs shared by all the blocks of a step (masks, positions, conditioning) are sent once per step instead of once per block. On an RTX 5060 the statistics line showed that 12 s of the 20 s spent in the blocks for a 179 s track were these transfers. The result is bit for bit the same (the round trip only converted bfloat16 to float32 and back). The timings are read once at the end of the generation instead of after every block, and the `block runs in … s` figure is now the time from the first block to the last one. `ACESTEP_STREAM_ACTIVATIONS=cpu` brings the old round trip back.
- Small-card stream mode: the audio decoding (VAE) tile size now follows the card's free memory once the DiT has been given back (up to 256 latent frames instead of a fixed 96; a 2 GB card keeps 96, and `ACESTEP_STREAM_VAE_CHUNK` still fixes the size). Larger tiles waste less on the overlap between neighbouring tiles. A lack of memory used to send the whole track to the processor, which is very slow; it now retries with tiles half the size, down to 96, and only then falls back to the engine's own chain. The log says the tile size, the free memory before and the peak memory used. Neighbouring tiles are cut at other places, so the audio may differ from the old one by rounding only. Checked on the processor with a stand-in decoder; the speed gain is to be measured on a real card.
- Small-card stream mode: the engine's model contexts (VAE, text encoder, DiT) no longer clean the memory around every "load" and "offload". Since the engine runs on the processor there, they move nothing (the log shows a memory change of 0 MB), yet each one ran a garbage collection and a `malloc_trim` on a heap of about 20 GB, about 0.35 s each and ten times per generation. One clean-up is kept per generation, after the DiT. Other modes are unchanged. To be measured on a real card: about 3 s per generation expected.
- Small-card stream mode, bfloat16 compute: the DiT attention no longer uses masks. The regular path gave every layer a full N x N mask (all zeros for the full-attention layers and the cross-attention, a band of 257 tokens for the sliding layers), which forbids the fast kernels and computes the band as a whole table. The card copies of the blocks now use an attention function that needs no mask (`small_gpu_stream_attention.py`): `flash_attn` when it is installed (the window is passed to the kernel), else SDPA without a mask for the full layers and a banded attention made of torch operations for the sliding layers. The DiT's own mask-free branch is used on the processor side, so the masks are not built either. Measured by a probe on an RTX 5060 for a 179 s track: the attention of one block 8.4 ms -> 2.2 ms with `flash_attn` (relative error versus float32 2.2e-3 for every variant, the bfloat16 noise); about 1.6 s per generation expected at 179 s, almost nothing at 30 s where the copy of the weights dominates. Float32 compute (cards of 2 GB), a DiT without the mask-free branch or a missing attention registry keep the previous behaviour. `ACESTEP_STREAM_ATTENTION=off` brings the masks back. The end-to-end figure is still to be measured on the real card.
- Small-card stream mode: the condition encoder is no longer streamed through the card two or three times per generation with the same inputs. The engine calls `prepare_condition` once in `_execute_service_generate_diffusion`, again in `generate_audio`, and a third time for the "non-cover" condition when the cover strength is below 1 (the Studio sends 0.40 by default, even for text to music). Each pass cost about 0.6 s at 30 s. A pass whose arguments are exactly equal (same shapes, types and every value) to an earlier pass of the same generation now returns that pass's result (copies, so nothing is shared); any difference, even one value, computes normally. The saved results are dropped at the end of each generation. The log says `condition encoder: same inputs as an earlier pass of this generation, result reused.` `ACESTEP_STREAM_CONDITION_CACHE=off` brings back every pass. Checked on the processor only: with the real call pattern on a small model the encoder runs once instead of 3 times and the output is bit-identical; the gain on the card is to be measured.
- Small-card stream mode, `ACESTEP_STREAM_RESIDENT=auto`: the memory left free for the activations now follows what was measured. The first generation after the start uses `ACESTEP_STREAM_RESERVE_GB`; at the end of every generation the peak of the activations on the card is measured (`[small_gpu_stream] DiT: the activations peaked at … GB for … tokens.`), and the next generation leaves free that need plus a quarter and 0.3 GB (at least 0.5 GB; a track longer than any measured one scales the longest measure, linearly with the mask-free attention, with the square of the length otherwise, plus a quarter). A short track therefore keeps more blocks on the card than the fixed 1.5 GB allowed, a long one keeps what it needs. If the card still runs out of memory, the configured reserve comes back and the resident blocks are not halved for good any more. `ACESTEP_STREAM_RESERVE_AUTO=off` keeps the fixed reserve. Checked on the processor only; the gain on the card (more resident blocks, less waiting for weights) is to be measured.
- 5Hz LM (0.6B / 1.7B), PyTorch backend: the weights are now read straight in the dtype they run in (`torch_dtype`, `low_cpu_mem_usage=True`). Without it transformers (<4.58) built the model in float32 first, then converted it: about 12 GB of RAM for a moment with the 1.7B (8 GB in float32 + 4 GB converted copy), which on a 32 GB machine already holding the pinned DiT pushed the system into swap and froze it. Now 4 GB.
- Small-card stream mode: loading the DiT again (which the Studio does when another LM is chosen, since that initialises the whole service) now forgets the previous streamed DiT first (`small_gpu_stream.detach()`: both pools, their RAM copies and the condition cache). Before, the pools kept the previous pinned weights reachable, so two DiTs lived in RAM at once (shared memory 13.5 GB then 25 GB on a 31 GB machine), which sent the system into swap and froze it while the 1.7B was loading.
- 5Hz LM (PyTorch backend, `offload_to_cpu`): the processor copy of the weights is now kept while the model runs on the card and put back afterwards, instead of copying the whole model off the card (`model.to("cpu")`). With the 1.7B that was 2.2 s per LM phase (two phases per generation with the thinking mode) and a second 3.4 GB copy in RAM each time (the `AnonPages` swings of 3.6 GB seen in `/proc/meminfo`). The weights are not modified while the LM runs, so the result is identical; the fallback is the former `model.to("cpu")` when the saved copies are not all on the processor.
- Small-card stream mode: the audio decoding now writes one line, `[small_gpu_stream] audio decoding steps: card given back … | weights to the card … | input and cache … | decode … | weights back … | cleanup …`, with the time of each step (and, in brackets, what the DiT release spent collecting garbage and emptying the cache), so that the ≈2.5 s the decoding chain costs after the diffusion can be attributed. The garbage collector is no longer run after every normal decoding step (only after a failure or an out-of-memory retry); `torch.cuda.empty_cache()` still is. In `preprocess_batch`, when the "non-cover" prompt tokens are identical to the prompt tokens (text to music), the prompt embeddings are copied instead of being computed a second time on the processor (≈0.45 s saved per generation).
- Stream mode, reloading the DiT (choosing another LM re-initialises the service): torch's cache of pinned blocks is now handed back to the system before the new weights are read. The old DiT's 13.5 GB of pinned RAM stayed cached (`Shmem` in `/proc/meminfo`) while the new one was read in float32 (about 19 GB of `AnonPages` for the XL model), so a 31 GB machine went through 13 GB of swap and the reload took 52 s instead of 17 s.
- Stream mode, after the VAE decode: the VAE comes back to the processor with the very tensors it left with (no 0.34 s copy), and the DiT release only runs the garbage collector (0.35 s) when something is left on the card. The `audio decoding steps` line tells where the time goes.

## 2026-10-17

### Fixed
- AI cover only showed after a page reload (F5): the server draws it after the audio is done, when the interface had already stopped watching the song. The job status now says `coverPending` while the cover is being made, and the interface refreshes the list on its own when it is saved
### Changed
- AI covers: fewer deformed faces. The model (SDXL Turbo, 512 px) draws faces badly, and the prompt used to invite them: the instrumental hint "no people" added the word "people" to the picture, and the song caption's "female vocals" / "male lead vocal" made it draw a singer. The caption's vocal descriptors are now dropped and every prompt asks for "landscape, still life, abstract shapes" (unless your own brief names a person); the language model is told to describe places, objects, nature or abstract shapes, never a portrait or a crowd
- Covers use 4 steps instead of 3 (a little more detail, still a few seconds)
- The cover process no longer prints dozens of "modules that should be kept in float32" lines per image

## 2026-10-16

### Changed
- Covers are made locally: the Pollinations.ai online service is gone (panel, API key, model list, sidebar indicator, network calls). With the new "AI cover (local)" switch in the Create tab (off by default), the server draws the cover on the GPU once the audio is done, with SDXL Turbo (`scripts/cover_worker.py`, diffusers; about 7 GB downloaded into `models/` on first use, then kept loaded for a few minutes and released). It never runs while an audio generation is queued or running, so the two do not compete for VRAM
- Without a GPU (processor mode), or with the switch off, a song keeps its default gradient cover, as before; the switch says it is unavailable in processor mode. `COVER_AI=off` turns the feature off, `COVER_MODEL` changes the Hugging Face model
- The cover embedded in a freshly generated MP3 is now that same gradient, drawn by the server (PNG, no network), instead of a random photo fetched from picsum.photos
- Cover window (song menu): the prompt is sent to the local model (a seed per click, several tries kept, then "Save as cover"), or you upload an image; without a GPU, only the upload is offered

### Fixed
- AI covers did not start (`cannot import name 'get_cached_repo_tree' from 'huggingface_hub'`): diffusers 0.40 needs two names that huggingface_hub < 1.0 lacks; the cover process now supplies them and loads the SDXL pipeline class directly
- AI cover prompt: the long paragraph the language model writes as caption was cut in the middle of a word ("The arran, inspired by…"); it is now cut at its first clause, after what you typed, and the server cuts at a word

### Removed
- Pollinations.ai: `pollinations.ts`, the Pollinations panel and toggle, the model picker of the cover window, the 35 `pollinations.*` / `coverRegen.*` texts in six languages, the two Pollinations hosts of the content security policy

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
- Processor mode: the engine's "GPU NOT DETECTED" diagnostic block is no longer printed at startup (it is still shown when a GPU was expected)
- Library: the page title ("Your library") stays at the top with the tabs
- Library tabs (sticky): a little solid space under the line, so the rows passing under it are not cut right against it
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
