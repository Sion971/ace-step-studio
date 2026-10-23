/**
 * Guidance a model starts from. The base models do best around 7, but the per-track tasks (Lego, Extract, Complete) sound cleaner
 * lower: measured on an XL Base with a 22 s source, 5 gives the fewest artefacts, 4.5 and below lose the thread.
 */
export const TRACK_TASK_GUIDANCE = 5;
export const BASE_GUIDANCE = 7;
export const TURBO_GUIDANCE = 0;

export const defaultGuidance = (turbo: boolean, trackTaskOnBaseModel: boolean): number =>
  turbo ? TURBO_GUIDANCE : trackTaskOnBaseModel ? TRACK_TASK_GUIDANCE : BASE_GUIDANCE;

export const isTrackAudioMode = (mode: string): boolean => mode === 'lego' || mode === 'extract' || mode === 'complete';
