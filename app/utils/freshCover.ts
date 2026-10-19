import type { Song } from '../types';

/**
 * The song kept in a detail panel or in the player, with the cover of the reloaded list. The AI cover lands on the server
 * after the audio is done, when the list is reloaded; a copy of the song held elsewhere would keep the default gradient
 * until the user clicked the song again. Only the cover is taken over: nothing else the copy holds is touched.
 */
export function withFreshCover(held: Song | null, loaded: readonly Song[]): Song | null {
  if (!held || held.isGenerating) return held;
  const fresh = loaded.find((song) => song.id === held.id);
  return fresh && fresh.coverUrl !== held.coverUrl ? { ...held, coverUrl: fresh.coverUrl } : held;
}
