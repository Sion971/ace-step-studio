/**
 * Whether the user wants a local AI cover for the songs they generate. Off by default: the first use downloads a ~7 GB
 * model, and without it a song simply keeps its default gradient. One browser preference, read at generation time.
 */
const KEY = 'acestep.aiCover.enabled';

export const aiCoverStorage = {
  get(): boolean {
    try {
      return localStorage.getItem(KEY) === 'true';
    } catch {
      return false;
    }
  },
  set(value: boolean): void {
    try {
      localStorage.setItem(KEY, String(value));
    } catch {
      /* private window or blocked storage: the choice lasts until the page is closed */
    }
  },
};
