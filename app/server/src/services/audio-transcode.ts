// services/audio-transcode.ts
//
// Converts an audio file to FLAC or MP3 with ffmpeg (already needed by the mastering, the loudness and the track mix). Used by the Studio's
// "Export to the library": the editor hands over its mix as a WAV (large), the song of the library is stored in the format that was asked for.

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config/index.js';

export type ExportFormat = 'wav' | 'flac' | 'mp3';

export const EXPORT_FORMATS: Record<ExportFormat, { ext: string; mime: string }> = {
  wav: { ext: '.wav', mime: 'audio/wav' },
  flac: { ext: '.flac', mime: 'audio/flac' },
  mp3: { ext: '.mp3', mime: 'audio/mpeg' },
};

/** The format asked for ("flac", "MP3"...), or null when none was asked or it is not one we make. */
export function parseExportFormat(value: unknown): ExportFormat | null {
  const v = String(value ?? '').trim().toLowerCase();
  return v === 'wav' || v === 'flac' || v === 'mp3' ? v : null;
}

const CODEC_ARGS: Record<'flac' | 'mp3', string[]> = {
  flac: ['-c:a', 'flac', '-compression_level', '8'],
  mp3: ['-c:a', 'libmp3lame', '-q:a', '0'], // variable bit rate, about 245 kbit/s
};

function run(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 20_000) stderr = stderr.slice(-10_000); });
    proc.on('error', (e) => reject(new Error(`ffmpeg could not be started: ${e.message}`)));
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed (code ${code}): ${stderr.slice(-600)}`))));
  });
}

// The Python of the engine (soundfile, which writes FLAC and MP3 through libsndfile) takes over when ffmpeg cannot be run: on Windows,
// Smart App Control may refuse ffmpeg's DLLs (TROUBLESHOOTING.md, section 46) and nothing can be done but wait or leave it.
export const PYTHON_ENCODE = [
  'import sys, soundfile as sf',
  'data, rate = sf.read(sys.argv[1], always_2d=True)',
  'fmt = sys.argv[3]',
  'try:',
  "    sf.write(sys.argv[2], data, rate, format=fmt, **({'bitrate_mode': 'VARIABLE', 'compression_level': 0.1} if fmt == 'MP3' else {}))",
  'except TypeError:',
  '    sf.write(sys.argv[2], data, rate, format=fmt)',
].join('\n');

function runPython(input: string, output: string, format: 'flac' | 'mp3'): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(config.pipeline.pythonPath, ['-c', PYTHON_ENCODE, input, output, format.toUpperCase()], { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 20_000) stderr = stderr.slice(-10_000); });
    proc.on('error', (e) => reject(new Error(`Python could not be started: ${e.message}`)));
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Python failed (code ${code}): ${stderr.slice(-600)}`))));
  });
}

export interface TranscodeDeps {
  ffmpeg: (args: string[]) => Promise<void>;
  python: (input: string, output: string, format: 'flac' | 'mp3') => Promise<void>;
}
const systemDeps: TranscodeDeps = { ffmpeg: run, python: runPython };

/** ffmpeg `atempo` filters for a speed factor: each one takes 0.5 to 2, so a bigger change is chained. */
export function atempoChain(ratio: number): string {
  if (!(ratio >= 0.25 && ratio <= 4)) throw new Error('The tempo ratio must be between 0.25 and 4');
  const parts: number[] = [];
  let r = ratio;
  while (r > 2) { parts.push(2); r /= 2; }
  while (r < 0.5) { parts.push(0.5); r /= 0.5; }
  parts.push(r);
  return parts.map((p) => `atempo=${p.toFixed(6)}`).join(',');
}

/**
 * The file played `ratio` times faster (2 = twice as fast, half as long) without changing its pitch, as a 16-bit WAV.
 * Used by the Studio to bring a song to the tempo of the project: ratio = project bpm / song bpm.
 */
export async function stretchAudio(data: Buffer, inputName: string, ratio: number): Promise<Buffer> {
  const filter = atempoChain(ratio);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'studio-stretch-'));
  try {
    const input = path.join(dir, `in${path.extname(inputName).replace(/[^.\w]/g, '') || '.wav'}`);
    const output = path.join(dir, 'out.wav');
    await writeFile(input, data);
    await run(['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-vn', '-filter:a', filter, '-c:a', 'pcm_s16le', output]);
    return await readFile(output);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * The file as `format`: unchanged when it already is one (a WAV asked as WAV), converted otherwise.
 * Throws with ffmpeg's last lines when the conversion fails.
 */
export async function transcodeAudio(data: Buffer, inputName: string, format: ExportFormat, deps: TranscodeDeps = systemDeps): Promise<{ data: Buffer; ext: string; mime: string }> {
  const target = EXPORT_FORMATS[format];
  if (path.extname(inputName).toLowerCase() === target.ext) return { data, ...target };
  const dir = await mkdtemp(path.join(os.tmpdir(), 'studio-export-'));
  try {
    const input = path.join(dir, `in${path.extname(inputName).replace(/[^.\w]/g, '') || '.wav'}`);
    const output = path.join(dir, `out${target.ext}`);
    await writeFile(input, data);
    const codec = format === 'wav' ? ['-c:a', 'pcm_s16le'] : CODEC_ARGS[format];
    try {
      await deps.ffmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-vn', ...codec, output]);
    } catch (ffmpegError) {
      if (format === 'wav') throw ffmpegError; // soundfile reads WAV only through this path for FLAC / MP3
      console.warn(`[audio] ffmpeg could not convert (${String(ffmpegError instanceof Error ? ffmpegError.message : ffmpegError).split('\n')[0]}); using the engine's Python (soundfile) instead.`);
      try {
        await deps.python(input, output, format);
      } catch (pythonError) {
        throw new Error(`${ffmpegError instanceof Error ? ffmpegError.message : ffmpegError} | ${pythonError instanceof Error ? pythonError.message : pythonError}`);
      }
    }
    return { data: await readFile(output), ...target };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
