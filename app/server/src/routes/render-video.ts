import { Router, Request, Response } from 'express';
import { execSync, spawn } from 'child_process';
import { writeFile, mkdir, readFile, rm, chmod } from 'fs/promises';
import { existsSync, createWriteStream } from 'fs';
import path from 'path';
import os from 'os';
import { pipeline } from 'stream/promises';
import { fileURLToPath } from 'url';

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

// Active render sessions
const sessions = new Map<string, { dir: string; frameCount: number; created: number }>();

// Cleanup old sessions (>30min)
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.created > 30 * 60 * 1000) {
      rm(session.dir, { recursive: true, force: true }).catch(() => {});
      sessions.delete(id);
    }
  }
}, 60000);

// 1. Start render session
router.post('/start', async (_req: Request, res: Response) => {
  const sessionId = `render_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const dir = path.join(TMP_BASE, sessionId);
  await mkdir(dir, { recursive: true });
  sessions.set(sessionId, { dir, frameCount: 0, created: Date.now() });
  console.log(`[Render] Session started: ${sessionId}`);
  res.json({ sessionId });
});

// 2. Upload frame chunk (batches of ~50-100 frames)
router.post('/frames', async (req: Request, res: Response) => {
  const { sessionId, frames, startIndex } = req.body;
  const session = sessions.get(sessionId);
  if (!session) {
    res.status(400).json({ error: 'Invalid session' });
    return;
  }

  const start = startIndex || session.frameCount;
  for (let i = 0; i < frames.length; i++) {
    const frameData = Buffer.from(frames[i], 'base64');
    await writeFile(path.join(session.dir, `frame${String(start + i).padStart(6, '0')}.jpg`), frameData);
  }
  session.frameCount = start + frames.length;

  res.json({ received: frames.length, total: session.frameCount });
});

// 3. Finish — encode with ffmpeg
router.post('/finish', async (req: Request, res: Response) => {
  const { sessionId, audioUrl, fps = 30 } = req.body;
  const session = sessions.get(sessionId);
  if (!session) {
    res.status(400).json({ error: 'Invalid session' });
    return;
  }

  try {
    const ffmpegPath = await findFfmpeg();
    const useNvenc = hasNvenc(ffmpegPath);
    console.log(`[Render] Encoding ${session.frameCount} frames, nvenc: ${useNvenc}`);

    // Copy audio
    const audioPath = path.join(session.dir, 'audio.mp3');
    if (audioUrl?.startsWith('/')) {
      const localAudioPath = path.join(__dirname, '../../public', audioUrl);
      if (existsSync(localAudioPath)) {
        const audioData = await readFile(localAudioPath);
        await writeFile(audioPath, audioData);
      }
    }

    const outputPath = path.join(session.dir, 'output.mp4');
    const args = [
      '-framerate', String(fps),
      '-i', path.join(session.dir, 'frame%06d.jpg'),
    ];

    if (existsSync(audioPath)) args.push('-i', audioPath);

    if (useNvenc) {
      args.push('-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '28');
    } else {
      args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '23');
    }

    args.push(
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k',
      '-shortest',
      '-movflags', '+faststart',
      '-y', outputPath,
    );

    console.log(`[Render] ffmpeg ${args.slice(0, 10).join(' ')}...`);

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ffmpegPath, args, { stdio: 'pipe' });
      let stderr = '';
      proc.stderr?.on('data', d => { stderr += d.toString(); });
      proc.on('close', code => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`));
      });
      proc.on('error', reject);
    });

    const videoData = await readFile(outputPath);
    console.log(`[Render] Done: ${(videoData.length / 1024 / 1024).toFixed(1)}MB`);

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'attachment; filename="video.mp4"');
    res.send(videoData);

  } catch (error: any) {
    console.error('[Render] Failed:', error.message);
    res.status(500).json({ error: error.message });
  } finally {
    rm(session.dir, { recursive: true, force: true }).catch(() => {});
    sessions.delete(sessionId);
  }
});

export default router;
