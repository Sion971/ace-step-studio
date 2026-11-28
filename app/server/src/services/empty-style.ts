// What a generation uses when the Style box is left empty.
//
// 1. The language model writes the description (Thinking or Enhance on, its "caption" step on, a text2music task the
//    engine runs the LM for): nothing is sent, and the engine takes the LM's description. Sending "pop music" there
//    gave the LM a pop starting point it would build on.
// 2. Otherwise the user's favorite style (the star in "My styles"), filled in by routes/generate.ts.
// 3. Otherwise, as before: the track asked for in a track task, else "pop music".
import { trackCaptionFallback } from './track-tasks.js';

export const DEFAULT_CAPTION = 'pop music';

export interface EmptyStyleParams {
  style?: string;
  taskType?: string;
  trackName?: string;
  completeTrackClasses?: string[];
  thinking?: boolean;
  enhance?: boolean;
  useCotCaption?: boolean;
  flowEditMorph?: boolean;
}

/** The engine runs the LM on text2music only (not cover, repaint, extract, nor a flow-edit morph). */
export const lmWritesCaption = (p: EmptyStyleParams): boolean =>
  (!p.taskType || p.taskType === 'text2music')
  && !p.flowEditMorph
  && !!(p.thinking || p.enhance)
  && (p.useCotCaption ?? true);

/** The description sent to the engine. */
export const captionFor = (p: EmptyStyleParams): string =>
  p.style
  || trackCaptionFallback(p.taskType, p.trackName, p.completeTrackClasses)
  || (lmWritesCaption(p) ? '' : DEFAULT_CAPTION);

/** The Style box is empty and nothing else would describe the music: the favorite style should fill it. */
export const wantsFavoriteStyle = (p: EmptyStyleParams): boolean =>
  !(p.style ?? '').trim()
  && !trackCaptionFallback(p.taskType, p.trackName, p.completeTrackClasses)
  && !lmWritesCaption(p);
