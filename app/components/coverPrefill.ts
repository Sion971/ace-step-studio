// What a cover takes from the song it starts from: its title too, as a cover keeps the name of the song it covers.
//
// The engine keeps the source's length and tempo for a cover, so only the words and the musical facts are carried over:
// the lyrics, the BPM, the key, the time signature and the language. The style is left to the user, since changing it is
// the point of a cover.

import type { Song } from '../types';
import { uploadToSong, type UploadTrackLike } from '../services/uploadSong';

export interface CoverMeta {
  /** The title of the song to make: the original's for a cover, "Title (reversed)" for Reverse. */
  title?: string;
  lyrics?: string;
  instrumental?: boolean;
  bpm?: number;
  keyScale?: string;
  timeSignature?: string;
  language?: string;
}

interface SongLike {
  title?: string | null;
  lyrics?: string | null;
  bpm?: number | null;
  keyScale?: string | null;
  timeSignature?: string | null;
  generationParams?: any;
}

// Tasks whose length is the source's: the engine ignores the duration asked for.
const SOURCE_LOCKED_TASKS = new Set(['cover', 'audio2audio', 'repaint', 'lego', 'extract']);

export const isDurationLockedBySource = (taskType: string, hasSource: boolean): boolean =>
  hasSource && SOURCE_LOCKED_TASKS.has(taskType);

const INSTRUMENTAL_MARK = /^\s*\[\s*(instrumental|inst)\s*\]\s*$/i;

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

export const coverMetaFromSong = (song: SongLike): CoverMeta => {
  const p = song.generationParams && typeof song.generationParams === 'object' ? song.generationParams : {};
  const meta: CoverMeta = {};

  const title = text(song.title);
  if (title) meta.title = title;

  const lyrics = text(song.lyrics) ?? text(p.lyrics);
  if (lyrics) {
    if (INSTRUMENTAL_MARK.test(lyrics)) meta.instrumental = true;
    else { meta.lyrics = lyrics; meta.instrumental = false; }
  } else if (p.instrumental === true) {
    meta.instrumental = true;
  }

  const bpm = Number(song.bpm ?? p.bpm);
  if (Number.isFinite(bpm) && bpm > 0) meta.bpm = Math.round(bpm);

  const keyScale = text(song.keyScale) ?? text(p.keyScale);
  if (keyScale) meta.keyScale = keyScale;

  // The panel lists beats per bar ('4'); an analysis may write '4/4'.
  const timeSignature = (text(song.timeSignature) ?? text(p.timeSignature))?.replace(/\/\d+$/, '');
  if (timeSignature) meta.timeSignature = timeSignature;

  const language = text(p.vocalLanguage);
  if (language && language !== 'unknown') meta.language = language;

  return meta;
};

// An imported audio as a cover source: the song the list shows for it (lyrics, BPM, key and time signature from its
// analysis), with the analysis' language, which that song does not carry.
export const coverSongFromImport = (track: UploadTrackLike): Song => {
  const song = uploadToSong(track);
  const language = track.analysis && track.analysis.available ? track.analysis.language : undefined;
  return language ? { ...song, generationParams: { vocalLanguage: language } } : song;
};
