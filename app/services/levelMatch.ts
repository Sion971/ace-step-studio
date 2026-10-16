// Listening volumes for the before / after comparison. A processed file is usually louder than the original, and a louder file always
// sounds "better": to compare fairly, the louder one is turned down (HTMLMediaElement.volume only goes down, which is all that is needed).
// Nothing is written to the files themselves.

export interface MatchedVolumes {
  before: number;
  after: number;
  /** How far the louder one is turned down, in dB (always positive). */
  diffDb: number;
}

/** Below this gap (dB) nobody hears a difference in level: no correction, no option shown. */
export const MIN_AUDIBLE_DIFF_DB = 0.3;

export function matchVolumes(originalLufs: number | null | undefined, resultLufs: number | null | undefined): MatchedVolumes | null {
  if (typeof originalLufs !== 'number' || typeof resultLufs !== 'number') return null;
  if (!Number.isFinite(originalLufs) || !Number.isFinite(resultLufs)) return null;
  const diff = resultLufs - originalLufs;
  if (Math.abs(diff) < MIN_AUDIBLE_DIFF_DB) return null;
  const down = Math.pow(10, -Math.abs(diff) / 20);
  return diff > 0 ? { before: 1, after: down, diffDb: Math.abs(diff) } : { before: down, after: 1, diffDb: Math.abs(diff) };
}

/** A loudness header value ("-14.2") as a number, or null when it is missing or not finite. */
export function parseLufsHeader(value: string | null | undefined): number | null {
  if (value == null) return null;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}
