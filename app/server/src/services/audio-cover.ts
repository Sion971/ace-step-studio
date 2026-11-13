// services/audio-cover.ts
//
// The picture embedded in an audio file (the cover of an MP3's ID3 tag, of an M4A or a FLAC), taken out with ffmpeg so that an
// imported song shows its own cover in the library, the player and the Video Studio.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// The portable ffmpeg of the Studio (Windows) when there is one, otherwise the one on the PATH.
const PORTABLE = path.resolve(here, '../../../../ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const ffmpegBin = () => (existsSync(PORTABLE) ? PORTABLE : 'ffmpeg');

/**
 * ffmpeg's arguments to write the embedded picture as a JPEG. `-map 0:v -map -0:V` keeps the video streams that are attached
 * pictures and drops real video (an imported MP4 clip gives no cover); without a picture ffmpeg stops with "no stream" and
 * nothing is written. Large pictures are brought down to 1500 px.
 */
export function embeddedCoverArgs(input: string, output: string): string[] {
  return ['-hide_banner', '-loglevel', 'error', '-i', input, '-map', '0:v', '-map', '-0:V', '-frames:v', '1',
    '-vf', "scale='min(1500,iw)':-2", '-c:v', 'mjpeg', '-q:v', '3', '-y', output];
}

function run(bin: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, { windowsHide: true, stdio: 'ignore' });
    proc.on('error', () => resolve(false));
    proc.on('close', (code) => resolve(code === 0));
  });
}

/** The embedded cover of an audio file as a JPEG, or null when it has none (or ffmpeg cannot be run). */
export async function extractEmbeddedCover(data: Buffer, ext: string): Promise<Buffer | null> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cover-'));
  try {
    const input = path.join(dir, `in${ext || '.mp3'}`);
    const output = path.join(dir, 'cover.jpg');
    await writeFile(input, data);
    if (!(await run(ffmpegBin(), embeddedCoverArgs(input, output))) || !existsSync(output)) return null;
    const jpeg = await readFile(output);
    return jpeg.length > 0 ? jpeg : null;
  } catch {
    return null;
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Storage key of an import's cover, next to its audio ("reference-tracks/u/123.mp3" gives "reference-tracks/u/123.cover.jpg"). */
export function coverKeyFor(storageKey: string, ext = '.jpg'): string {
  return storageKey.replace(/\.[^./]+$/, '') + `.cover${ext}`;
}
