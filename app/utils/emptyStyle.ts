/**
 * What the Style box shows in grey when it is empty: what the generation will really use. Same rule as the server's
 * services/empty-style.ts (routes/generate.ts fills in the favorite):
 * - 'lm': the language model writes the description (Thinking or Enhance on with a model loaded, its caption step on,
 *   a text2music task: the engine skips the LM for cover, repaint and extract);
 * - 'track': a track task, described by the track asked for;
 * - 'favorite': the favorite style (the star in "My styles");
 * - 'default': "pop music".
 */
export type EmptyStyleUse = 'lm' | 'track' | 'favorite' | 'default';

export interface EmptyStyleInput {
  taskType: string;
  lmLoaded: boolean;
  thinking: boolean;
  enhance: boolean;
  useCotCaption: boolean;
  hasFavorite: boolean;
}

const TRACK_TASKS = new Set(['lego', 'extract', 'complete']);

export function emptyStyleUse(p: EmptyStyleInput): EmptyStyleUse {
  if (TRACK_TASKS.has(p.taskType)) return 'track';
  const text2music = !p.taskType || p.taskType === 'text2music';
  if (text2music && p.lmLoaded && (p.thinking || p.enhance) && p.useCotCaption) return 'lm';
  return p.hasFavorite ? 'favorite' : 'default';
}
