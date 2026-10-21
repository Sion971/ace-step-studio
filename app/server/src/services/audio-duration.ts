// services/audio-duration.ts
//
// The length of an audio file, in whole seconds. ffprobe answers first; if it cannot be run (on Windows, Smart App Control can refuse
// ffprobe.exe for a while after the install, while ffmpeg.exe already starts) the Python of the engine answers instead, through soundfile,
// which is the library that wrote the file in the first place. Never throws: 0 means "unknown".

import { execFileSync } from 'node:child_process';
import { config } from '../config/index.js';

export interface DurationProbes {
  /** The raw text ffprobe printed. Throws when ffprobe cannot be run. */
  ffprobe(filePath: string): string;
  /** The raw text the Python fallback printed. Throws when it cannot be run. */
  python(filePath: string): string;
}

const PYTHON_SNIPPET = 'import sys, soundfile as sf; print(sf.info(sys.argv[1]).duration)';

const systemProbes: DurationProbes = {
  ffprobe: (filePath) =>
    execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath], {
      encoding: 'utf-8',
      timeout: 30_000,
      windowsHide: true,
    }),
  python: (filePath) =>
    execFileSync(config.pipeline.pythonPath, ['-c', PYTHON_SNIPPET, filePath], { encoding: 'utf-8', timeout: 60_000, windowsHide: true }),
};

/** Seconds as printed by a probe, or null when the text is not a usable length. */
function parseSeconds(text: string): number | null {
  const seconds = parseFloat(text.trim());
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

let warnedFfprobe = false;

export function getAudioDuration(filePath: string, probes: DurationProbes = systemProbes): number {
  try {
    const seconds = parseSeconds(probes.ffprobe(filePath));
    if (seconds !== null) return Math.round(seconds);
  } catch (error) {
    if (!warnedFfprobe) {
      warnedFfprobe = true;
      const why = error instanceof Error ? error.message.split('\n')[0] : String(error);
      console.warn(`[audio] ffprobe could not be run (${why}); using the engine's Python to read the length of audio files instead.`);
    }
  }
  try {
    const seconds = parseSeconds(probes.python(filePath));
    if (seconds !== null) return Math.round(seconds);
  } catch {
    // Nothing could read the file: the length stays unknown.
  }
  return 0;
}
