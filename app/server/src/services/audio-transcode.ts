// services/audio-transcode.ts
//
// Converts an audio file to FLAC or MP3 with ffmpeg (already needed by the mastering, the loudness and the track mix). Used by the Studio's
// "Export to the library": the editor hands over its mix as a WAV (large), the song of the library is stored in the format that was asked for.

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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

/**
 * The file as `format`: unchanged when it already is one (a WAV asked as WAV), converted otherwise.
 * Throws with ffmpeg's last lines when the conversion fails.
 */
export async function transcodeAudio(data: Buffer, inputName: string, format: ExportFormat): Promise<{ data: Buffer; ext: string; mime: string }> {
  const target = EXPORT_FORMATS[format];
  if (path.extname(inputName).toLowerCase() === target.ext) return { data, ...target };
  const dir = await mkdtemp(path.join(os.tmpdir(), 'studio-export-'));
  try {
    const input = path.join(dir, `in${path.extname(inputName).replace(/[^.\w]/g, '') || '.wav'}`);
    const output = path.join(dir, `out${target.ext}`);
    await writeFile(input, data);
    const codec = format === 'wav' ? ['-c:a', 'pcm_s16le'] : CODEC_ARGS[format];
    await run(['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-vn', ...codec, output]);
    return { data: await readFile(output), ...target };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
