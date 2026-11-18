// services/track-analysis.ts
//
// The analysis of an imported audio (see audio-analysis.ts) is kept with the reference track, so that the song details can show it.
import { pool } from '../db/pool.js';
import { getStorageProvider } from './storage/factory.js';
import type { AudioAnalysis } from './audio-analysis.js';
import { alignLyrics } from './lyrics-align.js';

/** The stored analysis (JSON text) comes back as an object, or null. */
export const withAnalysis = <T extends { analysis?: unknown }>(row: T): T => {
  let analysis: unknown = null;
  if (typeof row.analysis === 'string' && row.analysis) {
    try { analysis = JSON.parse(row.analysis); } catch { analysis = null; }
  }
  return { ...row, analysis };
};

const pathOf = (url: string): string => {
  try { return new URL(url, 'http://local').pathname; } catch { return url; }
};

/** The id of the user's reference track that this audio URL points to, or null (a created song, a link...). */
export async function findTrackIdByUrl(userId: string, audioUrl: string): Promise<string | null> {
  const storage = getStorageProvider();
  const wanted = pathOf(audioUrl);
  const result = await pool.query('SELECT id, storage_key FROM reference_tracks WHERE user_id = $1', [userId]);
  for (const row of result.rows as Array<{ id: string; storage_key: string }>) {
    if (pathOf(storage.getPublicUrl(row.storage_key)) === wanted) return row.id;
  }
  return null;
}

export async function saveTrackAnalysis(trackId: string, analysis: AudioAnalysis): Promise<void> {
  await pool.query('UPDATE reference_tracks SET analysis = $1 WHERE id = $2', [JSON.stringify(analysis), trackId]);
}

/** Share of the corrected lyrics' words that must be found among the heard words for the LRC to be timed from them. */
const MIN_MATCHED_SHARE = 0.25;

export interface CorrectedLyrics {
  analysis: AudioAnalysis;
  /** The LRC was timed again from the corrected lyrics (false: too few words found, the previous LRC is kept). */
  retimed: boolean;
  matchedWords: number;
  totalWords: number;
}

/**
 * The analysis with the lyrics corrected by hand in the analysis window: the corrected text, and an LRC timed from it with the words
 * Whisper heard (so a video of the import shows the corrected lyrics, at the right times). Without heard words, or when too few of
 * the corrected words are found among them, the text is kept and the previous LRC stays.
 */
export function withCorrectedLyrics(analysis: AudioAnalysis, lyrics: string, words: Array<{ start: number; end: number; word: string }>): CorrectedLyrics {
  const updated: AudioAnalysis = { ...analysis, lyrics, lyricsEdited: true };
  if (!words.length || !lyrics.trim()) return { analysis: updated, retimed: false, matchedWords: 0, totalWords: 0 };
  const result = alignLyrics(lyrics, words, analysis.duration || undefined);
  const retimed = result.totalWords > 0 && result.matchedWords / result.totalWords >= MIN_MATCHED_SHARE;
  if (retimed) updated.lrc = result.lrc;
  return { analysis: updated, retimed, matchedWords: result.matchedWords, totalWords: result.totalWords };
}

/** The stored analysis of a reference track, or null. */
export async function loadTrackAnalysis(trackId: string): Promise<AudioAnalysis | null> {
  const result = await pool.query('SELECT analysis FROM reference_tracks WHERE id = $1', [trackId]);
  if (!result.rows.length) return null;
  return (withAnalysis(result.rows[0] as { analysis?: unknown }).analysis as AudioAnalysis | null) ?? null;
}
