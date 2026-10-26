// services/audio-fallback.ts
//
// Audio work without ffmpeg. On Windows, Smart App Control may refuse ffmpeg's DLLs for a long time (TROUBLESHOOTING.md, section 46); the
// services that use ffmpeg (track mix, tempo stretch, loudness normalisation and mastering) then call `audio-tools/audio_fallback.py`, run with
// the engine's Python (numpy, scipy and soundfile are part of the engine's requirements).

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
/** app/server/audio-tools/audio_fallback.py, from src/services and from dist/services alike. */
export const FALLBACK_SCRIPT = path.resolve(here, '../../audio-tools/audio_fallback.py');

/** Runs one command of the script; resolves with what it printed, rejects with its last error lines. */
export function runFallbackTool(args: string[], python: string = config.pipeline.pythonPath): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(python, [FALLBACK_SCRIPT, ...args], { windowsHide: true });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { err += d.toString(); if (err.length > 20_000) err = err.slice(-10_000); });
    proc.on('error', (e) => reject(new Error(`Python could not be started: ${e.message}`)));
    proc.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`audio_fallback failed (code ${code}): ${err.slice(-600)}`))));
  });
}

export const oneLine = (e: unknown): string => String(e instanceof Error ? e.message : e).split('\n')[0];
