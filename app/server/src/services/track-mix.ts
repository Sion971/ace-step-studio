/**
 * Mixage de la piste générée (Lego, Complete) avec l'audio source.
 *
 * Le moteur ne renvoie que la NOUVELLE piste (la guitare seule, par exemple). Pour l'entendre avec le morceau d'origine, le Studio
 * fabrique en plus un mix : source + nouvelle piste, avec un limiteur pour éviter l'écrêtage.
 */
import { spawn } from 'node:child_process';
import { isTrackTask } from './track-tasks.js';
import { oneLine, runFallbackTool } from './audio-fallback.js';

export interface MixParams {
  taskType?: string;
  mixWithSource?: boolean;
  repaintingStart?: number;
  repaintingEnd?: number;
}

/** Niveau de la nouvelle piste, en pourcentage (100 = même niveau que le moteur l'a produit). */
export const clampLevel = (percent: unknown): number => {
  const n = typeof percent === 'number' ? percent : parseFloat(String(percent ?? ''));
  return Number.isFinite(n) ? Math.min(150, Math.max(0, n)) : 80;
};

/** Lego avec une région partielle : le moteur recolle l'original autour de la région, un mix le doublerait. */
export const regionCoversWholeSource = (start: number | undefined, end: number | undefined, sourceDuration: number): boolean => {
  const s = start ?? 0;
  const e = end ?? -1;
  return s <= 0.05 && (e < 0 || sourceDuration <= 0 || e >= sourceDuration - 0.1);
};

export const shouldMix = (p: MixParams, sourceDuration: number): boolean => {
  if (!p.mixWithSource) return false;
  if (p.taskType !== 'lego' && p.taskType !== 'complete') return false;
  if (p.taskType === 'lego' && !regionCoversWholeSource(p.repaintingStart, p.repaintingEnd, sourceDuration)) return false;
  return isTrackTask(p.taskType);
};

/** Why no mix is made (for the terminal), or null when one will be made. */
export const mixSkipReason = (p: MixParams, sourceDuration: number): string | null => {
  if (!p.mixWithSource) return 'the "Mix with the original" option is off';
  if (p.taskType !== 'lego' && p.taskType !== 'complete') return `task ${p.taskType ?? '?'} has no mix`;
  if (p.taskType === 'lego' && !regionCoversWholeSource(p.repaintingStart, p.repaintingEnd, sourceDuration)) {
    return `the Lego region (${p.repaintingStart ?? 0}-${p.repaintingEnd ?? -1}) does not cover the whole source (${sourceDuration} s)`;
  }
  return null;
};

export const buildMixFilter = (levelPercent: number): string => {
  const gain = (clampLevel(levelPercent) / 100).toFixed(3);
  const prep = 'aresample=48000,aformat=channel_layouts=stereo';
  return `[0:a]${prep}[a];[1:a]${prep},volume=${gain}[b];[a][b]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95:level=disabled[out]`;
};

export const buildMixArgs = (sourcePath: string, stemPath: string, outPath: string, levelPercent: number): string[] => {
  const codec = outPath.toLowerCase().endsWith('.flac') ? ['-c:a', 'flac'] : ['-c:a', 'libmp3lame', '-q:a', '2'];
  return ['-y', '-i', sourcePath, '-i', stemPath, '-filter_complex', buildMixFilter(levelPercent), '-map', '[out]', ...codec, outPath];
};

/** Lance ffmpeg ; renvoie true si le mix a été écrit, false sinon (ffmpeg absent ou en échec : la piste seule reste disponible). */
const mixWithFfmpeg = (sourcePath: string, stemPath: string, outPath: string, levelPercent: number): Promise<boolean> =>
  new Promise((resolve) => {
    let stderr = '';
    try {
      const proc = spawn('ffmpeg', buildMixArgs(sourcePath, stemPath, outPath, levelPercent), { windowsHide: true });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('error', (err) => { console.warn(`[Mix] ffmpeg could not start: ${err.message}`); resolve(false); });
      proc.on('close', (code) => {
        if (code !== 0) console.warn(`[Mix] ffmpeg failed (code ${code}): ${stderr.slice(-400)}`);
        resolve(code === 0);
      });
    } catch (err) {
      console.warn(`[Mix] ffmpeg could not start: ${(err as Error).message}`);
      resolve(false);
    }
  });

export interface MixDeps {
  ffmpeg: typeof mixWithFfmpeg;
  /** The Python tool (no ffmpeg), used when ffmpeg did not write the mix (Windows Smart App Control can refuse its DLLs). */
  python: (sourcePath: string, stemPath: string, outPath: string, levelPercent: number) => Promise<void>;
}

const systemDeps: MixDeps = {
  ffmpeg: mixWithFfmpeg,
  python: async (sourcePath, stemPath, outPath, levelPercent) => {
    await runFallbackTool(['mix', '--source', sourcePath, '--stem', stemPath, '--out', outPath, '--level', String(clampLevel(levelPercent))]);
  },
};

export const mixStemWithSource = async (sourcePath: string, stemPath: string, outPath: string, levelPercent: number, deps: MixDeps = systemDeps): Promise<boolean> => {
  if (await deps.ffmpeg(sourcePath, stemPath, outPath, levelPercent)) return true;
  try {
    await deps.python(sourcePath, stemPath, outPath, levelPercent);
    console.warn('[Mix] ffmpeg did not write the mix: made with the engine\'s Python instead.');
    return true;
  } catch (err) {
    console.warn(`[Mix] the Python fallback could not write the mix either: ${oneLine(err)}`);
    return false;
  }
};
