// services/playlist-imports.ts
//
// Imported audio in playlists and workspaces. The interface shows an import as a song with the id "upload_<track id>"
// (app/services/uploadSong.ts); here those ids are recognised, and the imports of a playlist are given the shape of its songs.

/** The reference track id behind an interface id "upload_<id>", or null for a created song. */
export function importTrackId(songId: string): string | null {
  return songId.startsWith('upload_') && songId.length > 'upload_'.length ? songId.slice('upload_'.length) : null;
}

interface ImportRow {
  id: string;
  filename: string;
  storage_key: string;
  duration: number | null;
  analysis: string | null;
  cover_key: string | null;
  user_id: string;
  created_at?: string;
  creator: string;
  added_at: string;
  position: number;
}

/** Imports of a playlist with the fields of its songs: title without extension, lyrics and style from the analysis, cover, LRC. */
export function importRowsAsSongs(rows: ImportRow[], storage: { getPublicUrl(key: string): string }) {
  return rows.map((row) => {
    let analysis: { lyrics?: string; caption?: string; lrc?: string } = {};
    try { analysis = row.analysis ? JSON.parse(row.analysis) : {}; } catch { analysis = {}; }
    return {
      id: `upload_${row.id}`,
      title: row.filename.replace(/\.[^/.]+$/, ''),
      lyrics: analysis.lyrics || '',
      style: analysis.caption || '',
      lrc_content: analysis.lrc || null,
      cover_url: row.cover_key ? storage.getPublicUrl(row.cover_key) : null,
      audio_url: storage.getPublicUrl(row.storage_key),
      duration: row.duration,
      user_id: row.user_id,
      created_at: row.created_at,
      is_public: false,
      creator: row.creator,
      added_at: row.added_at,
      position: row.position,
      is_import: true,
    };
  });
}
