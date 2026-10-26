// services/track-analysis.ts
//
// The analysis of an imported audio (see audio-analysis.ts) is kept with the reference track, so that the song details can show it.
import { pool } from '../db/pool.js';
import { getStorageProvider } from './storage/factory.js';
import type { AudioAnalysis } from './audio-analysis.js';

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
