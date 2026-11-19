// services/workspace-file.ts
//
// Songs made while a workspace is open go into that workspace (2026-11-18: they landed in "My workspace", the default view,
// because nothing filed them). The interface sends the workspace with the generation; when the job's songs are saved, they are
// put in it here, after its other songs. Only a workspace of the user who generated, never a playlist of someone else.
import { pool } from '../db/pool.js';

export async function fileSongsInWorkspace(userId: string, workspaceId: string | undefined | null, songIds: string[]): Promise<boolean> {
  if (!workspaceId || typeof workspaceId !== 'string' || !songIds.length) return false;
  const found = await pool.query("SELECT user_id FROM playlists WHERE id = $1 AND kind = 'workspace'", [workspaceId]);
  if (!found.rows.length || found.rows[0].user_id !== userId) return false;
  // Two placeholders for the same id: the SQLite pool turns each $n into a "?" in order.
  const max = await pool.query(
    `SELECT MAX(pos) as max_pos FROM (
       SELECT MAX(position) as pos FROM playlist_songs WHERE playlist_id = $1
       UNION ALL SELECT MAX(position) FROM playlist_tracks WHERE playlist_id = $2
     )`,
    [workspaceId, workspaceId],
  );
  let position = Number(max.rows[0]?.max_pos) || 0;
  for (const songId of songIds) {
    position += 1;
    await pool.query(
      `INSERT INTO playlist_songs (playlist_id, song_id, position)
       VALUES ($1, $2, $3)
       ON CONFLICT (playlist_id, song_id) DO NOTHING`,
      [workspaceId, songId, position],
    );
  }
  return true;
}
