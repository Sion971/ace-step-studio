import { Router, Request, Response } from 'express';
import { execSync, spawn } from 'child_process';
import { writeFile, mkdir, readFile, rm, chmod } from 'fs/promises';
import { existsSync, createWriteStream, createReadStream, statSync } from 'fs';
import path from 'path';
import os from 'os';
import { pipeline } from 'stream/promises';
import { fileURLToPath } from 'url';
import { buildMasteringFilter, parseMasteringSettings } from '../services/mastering.js';
import { buildSimpleVideoArgs, loudnessFilter, loudnessMeasureArgs, lrcToAss, parseLoudnorm, type LoudnessMeasure, type SimpleLyricsStyle } from '../services/simple-video.js';

const router = Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TMP_BASE = path.join(__dirname, '../../tmp');

// Where the portable layout (and now also auto-download) keeps ffmpeg.
const FFMPEG_DIR = path.resolve(__dirname, '../../../../ffmpeg');
const FFMPEG_BIN = path.join(FFMPEG_DIR, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

// Concurrency guard: many parallel render requests should not all start
// downloading ffmpeg at the same time. First call kicks off the download,
// the rest await the same Promise.
let ffmpegDownloadInflight: Promise<string> | null = null;

async function downloadFfmpeg(): Promise<string> {
  if (ffmpegDownloadInflight) return ffmpegDownloadInflight;
  ffmpegDownloadInflight = (async () => {
    await mkdir(FFMPEG_DIR, { recursive: true });
    const platform = process.platform;
    const arch = process.arch;

    if (platform === 'win32') {
      // Reuses the same gyan.dev release-essentials build the install.bat
      // and Pinokio launcher download.
      const url = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';
      const tmpZip = path.join(os.tmpdir(), `ace-ffmpeg-${Date.now()}.zip`);
      const tmpExtract = path.join(os.tmpdir(), `ace-ffmpeg-extract-${Date.now()}`);
      // try/finally so a partial failure (zip incomplete, no exe inside)
      // doesn't leak ~80 MB of garbage into the user's TEMP forever.
      try {
        console.log('[ffmpeg] downloading', url);
        const res = await fetch(url);
        if (!res.ok || !res.body) throw new Error(`ffmpeg download failed: HTTP ${res.status}`);
        // Stream to disk so we don't load 80+ MB into RAM.
        await pipeline(res.body as any, createWriteStream(tmpZip));
        await mkdir(tmpExtract, { recursive: true });
        // PowerShell's Expand-Archive is shipped with every Windows install.
        execSync(`powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -Path '${tmpZip}' -DestinationPath '${tmpExtract}' -Force"`, { stdio: 'inherit' });
        const found = execSync(`powershell -NoProfile -Command "(Get-ChildItem -Path '${tmpExtract}' -Filter 'ffmpeg.exe' -Recurse | Select-Object -First 1).FullName"`, { encoding: 'utf-8' }).trim();
        if (!found) throw new Error('ffmpeg.exe not found inside the downloaded archive');
        const probeFound = execSync(`powershell -NoProfile -Command "(Get-ChildItem -Path '${tmpExtract}' -Filter 'ffprobe.exe' -Recurse | Select-Object -First 1).FullName"`, { encoding: 'utf-8' }).trim();
        const exeData = await readFile(found);
        await writeFile(FFMPEG_BIN, exeData);
        if (probeFound) {
          const probeData = await readFile(probeFound);
          await writeFile(path.join(FFMPEG_DIR, 'ffprobe.exe'), probeData);
        }
        console.log('[ffmpeg] installed →', FFMPEG_BIN);
        return FFMPEG_BIN;
      } finally {
        // Best-effort cleanup — runs on success AND on every error path.
        await rm(tmpZip, { force: true }).catch(() => {});
        await rm(tmpExtract, { recursive: true, force: true }).catch(() => {});
      }
    }

    if (platform === 'linux' && arch === 'x64') {
      // Static john-vansickle build — single tar.xz with the binaries.
      const url = 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz';
      const tmpTar = path.join(os.tmpdir(), `ace-ffmpeg-${Date.now()}.tar.xz`);
      const tmpExtract = path.join(os.tmpdir(), `ace-ffmpeg-extract-${Date.now()}`);
      try {
        console.log('[ffmpeg] downloading', url);
        const res = await fetch(url);
        if (!res.ok || !res.body) throw new Error(`ffmpeg download failed: HTTP ${res.status}`);
        await pipeline(res.body as any, createWriteStream(tmpTar));
        await mkdir(tmpExtract, { recursive: true });
        execSync(`tar -xf "${tmpTar}" -C "${tmpExtract}"`, { stdio: 'inherit' });
        const found = execSync(`find "${tmpExtract}" -name ffmpeg -type f | head -1`, { encoding: 'utf-8' }).trim();
        if (!found) throw new Error('ffmpeg not found inside the downloaded archive');
        const probeFound = execSync(`find "${tmpExtract}" -name ffprobe -type f | head -1`, { encoding: 'utf-8' }).trim();
        const data = await readFile(found);
        await writeFile(FFMPEG_BIN, data);
        await chmod(FFMPEG_BIN, 0o755);
        if (probeFound) {
          const probeData = await readFile(probeFound);
          const probeDest = path.join(FFMPEG_DIR, 'ffprobe');
          await writeFile(probeDest, probeData);
          await chmod(probeDest, 0o755);
        }
        console.log('[ffmpeg] installed →', FFMPEG_BIN);
        return FFMPEG_BIN;
      } finally {
        await rm(tmpTar, { force: true }).catch(() => {});
        await rm(tmpExtract, { recursive: true, force: true }).catch(() => {});
      }
    }

    // macOS, Linux ARM, etc — easier to ask the user to install via brew /
    // apt / package manager than to host an arch-specific build matrix.
    throw new Error(`No prebuilt ffmpeg auto-download for ${platform}/${arch}. Install ffmpeg via your package manager (brew install ffmpeg / apt install ffmpeg).`);
  })().catch(e => {
    // Reset the in-flight Promise so the next render attempt retries the
    // download instead of inheriting this rejection forever.
    ffmpegDownloadInflight = null;
    throw e;
  });
  return ffmpegDownloadInflight;
}

async function findFfmpeg(): Promise<string> {
  // Explicit override — any external orchestrator (Pinokio start.js, custom
  // wrapper, dev workflow) can pin a specific ffmpeg by setting FFMPEG_PATH.
  // Highest priority so it wins over both portable layout and PATH.
  const envPath = process.env.FFMPEG_PATH;
  if (envPath && existsSync(envPath)) return envPath;

  // Portable layout — populated by install.bat (run.bat path), the Pinokio
  // launcher's install.js/update.js, AND by downloadFfmpeg() below on first
  // render if neither got there first.
  if (existsSync(FFMPEG_BIN)) return FFMPEG_BIN;

  // System PATH — for users who installed ffmpeg via brew/apt/scoop.
  try {
    execSync(`${process.platform === 'win32' ? 'where' : 'which'} ffmpeg`, { stdio: 'ignore' });
    return 'ffmpeg';
  } catch {
    // Last resort: download it ourselves so the Video Studio just works
    // without forcing the user back to the installer.
    return downloadFfmpeg();
  }
}

function hasNvenc(ffmpegPath: string): boolean {
  try {
    const result = execSync(`"${ffmpegPath}" -encoders 2>&1`, { encoding: 'utf-8', timeout: 5000 });
    return result.includes('h264_nvenc');
  } catch {
    return false;
  }
}

/** Whether this ffmpeg can burn ASS subtitles (built with libass). */
const assSupport = new Map<string, boolean>();
function hasAssFilter(ffmpegPath: string): boolean {
  if (!assSupport.has(ffmpegPath)) {
    try {
      const out = execSync(`"${ffmpegPath}" -hide_banner -filters 2>&1`, { encoding: 'utf-8', timeout: 5000 });
      assSupport.set(ffmpegPath, /\sass\s/.test(out));
    } catch {
      assSupport.set(ffmpegPath, false);
    }
  }
  return assSupport.get(ffmpegPath)!;
}

function spawnFfmpeg(ffmpegPath: string, args: string[], cwd?: string, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('cancelled')); return; }
    const proc = spawn(ffmpegPath, args, { stdio: 'pipe', cwd });
    signal?.addEventListener('abort', () => proc.kill('SIGKILL'), { once: true });
    let stderr = '';
    proc.stderr?.on('data', d => {
      stderr += d.toString();
      if (stderr.length > 8192) stderr = stderr.slice(-4096);
    });
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`));
    });
    proc.on('error', reject);
  });
}

/** Loudness of a song file (ffmpeg's loudnorm measuring pass), or null when it cannot be measured. */
function measureLoudness(ffmpegPath: string, audioPath: string, mastering: string): Promise<LoudnessMeasure | null> {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, loudnessMeasureArgs(audioPath, mastering), { stdio: 'pipe' });
    let stderr = '';
    proc.stderr?.on('data', d => {
      stderr += d.toString();
      if (stderr.length > 65536) stderr = stderr.slice(-8192);
    });
    proc.on('close', () => resolve(parseLoudnorm(stderr)));
    proc.on('error', () => resolve(null));
  });
}

/** The song's file on disk for an audio URL of this Studio ("/audio/..."), or null. */
function localAudioFile(audioUrl: unknown): string | null {
  if (typeof audioUrl !== 'string' || !audioUrl.startsWith('/audio/')) return null;
  const root = path.resolve(__dirname, '../../public');
  const file = path.resolve(root, '.' + decodeURIComponent(audioUrl.split('?')[0]));
  return file.startsWith(root + path.sep) && existsSync(file) ? file : null;
}

// "Cover + lyrics": one still picture from the browser, looped by ffmpeg under the song with the lyrics burnt in as
// subtitles. No frame is drawn in the browser, so a whole song takes seconds instead of minutes.
router.post('/simple', async (req: Request, res: Response) => {
  const { still, audioUrl, lrc, width, height, duration, fps = 25, lyricsStyle = 'line', nextLine = true, zoom = false, waveform = false, highlight, normalize = true, mastering } = req.body || {};
  const w = Number(width);
  const h = Number(height);
  const seconds = Number(duration);
  const rate = Math.min(60, Math.max(10, Math.round(Number(fps) || 25)));
  const match = typeof still === 'string' ? /^data:image\/(png|jpeg);base64,(.+)$/.exec(still) : null;
  if (!match || !(w >= 320 && w <= 3840 && h >= 320 && h <= 3840) || !(seconds > 0 && seconds <= 3600)) {
    res.status(400).json({ error: 'A still picture (PNG or JPEG data URL), a size and a duration are needed.' });
    return;
  }
  const dir = path.join(TMP_BASE, `simple_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  const cleanup = () => { rm(dir, { recursive: true, force: true }).catch(() => {}); };
  // The window closed or "Cancel" was pressed: ffmpeg is stopped instead of finishing a video nobody will get.
  const cancel = new AbortController();
  res.on('close', () => { if (!res.writableFinished) cancel.abort(); });
  try {
    await mkdir(dir, { recursive: true });
    const stillFile = `still.${match[1] === 'png' ? 'png' : 'jpg'}`;
    await writeFile(path.join(dir, stillFile), Buffer.from(match[2], 'base64'));
    const ffmpegPath = await findFfmpeg();
    const audioFile = localAudioFile(audioUrl);
    if (!audioFile) console.warn(`[Render] simple: no audio file for audioUrl="${audioUrl}" — silent video.`);
    let assFile: string | null = null;
    let lyricsBurned = false;
    if (typeof lrc === 'string' && lrc.trim()) {
      if (hasAssFilter(ffmpegPath)) {
        const style: SimpleLyricsStyle = lyricsStyle === 'karaoke' ? 'karaoke' : 'line';
        await writeFile(path.join(dir, 'lyrics.ass'), lrcToAss(lrc, { width: w, height: h, style, nextLine: Boolean(nextLine), duration: seconds, highlight, waveform: Boolean(waveform) }), 'utf8');
        assFile = 'lyrics.ass';
        lyricsBurned = true;
      } else {
        console.warn('[Render] simple: this ffmpeg has no libass ("ass" filter): the video is made without the lyrics.');
      }
    }
    const started = Date.now();
    // The sound brought to -14 LUFS (what YouTube and the others play at): measured first, then one gain for the song.
    let audioFilter: string | null = null;
    let loudnessNote = '';
    // With the Mastering window's settings, the song is mastered first, then measured and brought to -14 LUFS.
    const masteringChain = mastering && typeof mastering === 'object' ? buildMasteringFilter(parseMasteringSettings(mastering)) : '';
    if (audioFile && (normalize || masteringChain)) {
      const measure = await measureLoudness(ffmpegPath, audioFile, masteringChain);
      audioFilter = loudnessFilter(measure, masteringChain);
      loudnessNote = `${masteringChain ? ', mastered' : ''}${measure ? `, loudness ${Number(measure.input_i).toFixed(1)} -> -14 LUFS` : ', loudness -14 LUFS (single pass)'}`;
    }
    const outputPath = path.join(dir, 'output.mp4');
    const args = (encoder: 'nvenc' | 'x264') => buildSimpleVideoArgs({
      stillPath: stillFile, audioPath: audioFile, assFile, outputPath, width: w, height: h, fps: rate,
      duration: seconds, zoom: Boolean(zoom), waveform: Boolean(waveform), encoder, audioFilter,
    });
    let encoder: 'nvenc' | 'x264' = hasNvenc(ffmpegPath) ? 'nvenc' : 'x264';
    try {
      await spawnFfmpeg(ffmpegPath, args(encoder), dir, cancel.signal);
    } catch (e: any) {
      if (encoder !== 'nvenc' || cancel.signal.aborted) throw e;
      console.warn('[Render] simple: NVENC failed, falling back to libx264:', e.message);
      encoder = 'x264';
      await spawnFfmpeg(ffmpegPath, args(encoder), dir, cancel.signal);
    }
    const { size } = statSync(outputPath);
    console.log(`[Render] simple: ${w}x${h}, ${seconds.toFixed(0)} s of song in ${((Date.now() - started) / 1000).toFixed(1)} s (${encoder}${zoom ? ', zoom' : ''}${waveform ? ', waveform' : ''}${lyricsBurned ? `, lyrics ${lyricsStyle}` : ', no lyrics'}${loudnessNote}), ${(size / 1024 / 1024).toFixed(1)} MB`);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', String(size));
    res.setHeader('X-Lyrics-Burned', lyricsBurned ? '1' : '0');
    res.setHeader('Content-Disposition', 'attachment; filename="video.mp4"');
    res.on('close', cleanup);
    const stream = createReadStream(outputPath);
    stream.on('error', err => {
      console.error('[Render] simple: stream error:', err);
      res.destroy();
    });
    stream.pipe(res);
  } catch (error: any) {
    if (cancel.signal.aborted) console.log('[Render] simple: cancelled.');
    else console.error('[Render] simple: failed:', error.message);
    cleanup();
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

export default router;
