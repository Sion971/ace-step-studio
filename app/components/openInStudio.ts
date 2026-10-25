import type { Song } from '../types';

/** One audio to put on the editor's timeline: a song of the library (tracked as such), or any audio file reachable by URL (a stem). */
export interface StudioIncomingItem {
  url: string;
  name: string;
  song?: Song;
}

export interface StudioIncoming {
  /** Changes at every request, so asking twice for the same song loads it twice. */
  id: number;
  items: StudioIncomingItem[];
}

export const STUDIO_OPEN_EVENT = 'ace-studio-open';

/**
 * "Edit the audio" / "Open all in the editor": the integrated Studio tab is the editor, so the request goes there (the
 * application listens for this event, switches to the tab and hands the items to it) instead of opening a separate page.
 */
export function openInStudio(items: StudioIncomingItem[]): void {
  if (items.length === 0) return;
  window.dispatchEvent(new CustomEvent<{ items: StudioIncomingItem[] }>(STUDIO_OPEN_EVENT, { detail: { items } }));
}

/** The item for a song of the library, or null when it has no audio yet. */
export function songItem(song: Song): StudioIncomingItem | null {
  return song.audioUrl ? { url: song.audioUrl, name: song.title, song } : null;
}
