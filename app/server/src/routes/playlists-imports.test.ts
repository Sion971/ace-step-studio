// @vitest-environment node
// Imported audio in playlists and workspaces (2026-11-18): the interface shows an import as "upload_<id>"; the server files it in
// playlist_tracks, never in playlist_songs (whose song_id must be a created song).
import { describe, it, expect, afterAll, beforeAll, beforeEach, vi } from 'vitest';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { importRowsAsSongs, importTrackId } from '../services/playlist-imports.js';

const calls: Array<{ sql: string; params: unknown[] }> = [];
let answer: (sql: string, params: unknown[]) => { rows: any[] } = () => ({ rows: [] });
vi.mock('../db/pool.js', () => ({
  pool: { query: vi.fn(async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return answer(sql, params); }) },
}));
vi.mock('../middleware/auth.js', () => {
  const user = (req: any, _res: any, next: any) => { req.user = { id: 'u1', username: 'sion' }; next(); };
  return { authMiddleware: user, optionalAuthMiddleware: user };
});
vi.mock('../services/storage/factory.js', () => ({ getStorageProvider: () => ({ getPublicUrl: (k: string) => `/audio/${k}`, getUrl: async (k: string) => `/audio/${k}` }) }));

let server: http.Server;
let base = '';
beforeAll(async () => {
  const { default: router } = await import('./playlists.js');
  const app = express();
  app.use(express.json());
  app.use('/api/playlists', router);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/playlists`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => { calls.length = 0; answer = () => ({ rows: [] }); });

describe('imports in playlists and workspaces', () => {
  it('recognises the interface id of an import', () => {
    expect(importTrackId('upload_abc')).toBe('abc');
    expect(importTrackId('song-1')).toBeNull();
    expect(importTrackId('upload_')).toBeNull();
  });

  it('files an import in playlist_tracks, after the songs already there', async () => {
    answer = (sql) => {
      if (sql.includes('FROM playlists WHERE id')) return { rows: [{ user_id: 'u1' }] };
      if (sql.includes('MAX(pos)')) return { rows: [{ max_pos: 4 }] };
      if (sql.includes('FROM reference_tracks WHERE id')) return { rows: [{ user_id: 'u1' }] };
      return { rows: [] };
    };
    const res = await fetch(`${base}/p1/songs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ songId: 'upload_t1' }) });
    expect(res.status).toBe(200);
    const insert = calls.find((c) => c.sql.includes('INSERT INTO'))!;
    expect(insert.sql).toContain('playlist_tracks');
    expect(insert.params).toEqual(['p1', 't1', 5]);
    expect(calls.some((c) => c.sql.includes('INSERT INTO playlist_songs'))).toBe(false);
    // One value per placeholder: the SQLite pool turns $n into "?" in order.
    const max = calls.find((c) => c.sql.includes('MAX(pos)'))!;
    expect((max.sql.match(/\$\d+/g) || []).length).toBe(max.params.length);
  });

  it("refuses someone else's import", async () => {
    answer = (sql) => sql.includes('FROM playlists WHERE id') ? { rows: [{ user_id: 'u1' }] }
      : sql.includes('FROM reference_tracks WHERE id') ? { rows: [{ user_id: 'other' }] } : { rows: [{ max_pos: 0 }] };
    const res = await fetch(`${base}/p1/songs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ songId: 'upload_t9' }) });
    expect(res.status).toBe(403);
    expect(calls.some((c) => c.sql.includes('INSERT'))).toBe(false);
  });

  it('a created song still goes to playlist_songs', async () => {
    answer = (sql) => sql.includes('FROM playlists WHERE id') ? { rows: [{ user_id: 'u1' }] } : { rows: [{ max_pos: 0 }] };
    await fetch(`${base}/p1/songs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ songId: 'song-1' }) });
    expect(calls.find((c) => c.sql.includes('INSERT INTO'))!.sql).toContain('playlist_songs');
  });

  it('removes an import from a playlist, and from every workspace before a move', async () => {
    answer = (sql) => sql.includes('FROM playlists WHERE id') ? { rows: [{ user_id: 'u1' }] } : { rows: [] };
    await fetch(`${base}/p1/songs/upload_t1`, { method: 'DELETE' });
    expect(calls.at(-1)).toMatchObject({ params: ['p1', 't1'] });
    expect(calls.at(-1)!.sql).toContain('DELETE FROM playlist_tracks');
    await fetch(`${base}/remove-song-from-workspaces/upload_t1`, { method: 'DELETE' });
    expect(calls.at(-1)!.sql).toContain('DELETE FROM playlist_tracks');
    expect(calls.at(-1)!.params).toEqual(['t1', 'u1']);
  });

  it('counts imports in the workspaces, under their interface ids', async () => {
    answer = (sql) => sql.includes('playlist_tracks') ? { rows: [{ track_id: 't1' }] } : { rows: [{ song_id: 'song-1' }] };
    const body = await (await fetch(`${base}/workspace-song-ids`)).json();
    expect(body.songIds).toEqual(['song-1', 'upload_t1']);
  });

  it("shows the owner's imports in the playlist, in order, with cover, lyrics and timed lyrics", async () => {
    answer = (sql) => {
      if (sql.includes('FROM playlists p') && sql.includes('JOIN users')) return { rows: [{ id: 'p1', user_id: 'u1', is_public: 1 }] };
      if (sql.includes('FROM playlist_songs ps')) return { rows: [{ id: 'song-1', title: 'Créé', audio_url: '/audio/s.mp3', is_public: 1, position: 1 }] };
      if (sql.includes('FROM playlist_tracks pt')) return { rows: [{
        id: 't1', filename: 'Merci Seigneur.mp3', storage_key: 'reference-tracks/u1/1.mp3', duration: 225, cover_key: 'reference-tracks/u1/1.cover.jpg',
        analysis: JSON.stringify({ lyrics: 'Merci Seigneur', caption: 'gospel', lrc: '[00:10.00]Merci Seigneur' }), user_id: 'u1', creator: 'sion', added_at: 'x', position: 0,
      }] };
      return { rows: [] };
    };
    const body = await (await fetch(`${base}/p1`)).json();
    expect(body.songs.map((s: any) => s.id)).toEqual(['upload_t1', 'song-1']);
    expect(body.songs[0]).toMatchObject({
      title: 'Merci Seigneur', lyrics: 'Merci Seigneur', style: 'gospel', lrc_content: '[00:10.00]Merci Seigneur',
      cover_url: '/audio/reference-tracks/u1/1.cover.jpg', audio_url: '/audio/reference-tracks/u1/1.mp3', is_import: true,
    });
  });

  it('an import without analysis or cover still has a title and its audio', () => {
    const [s] = importRowsAsSongs([{ id: 't2', filename: 'a.b.wav', storage_key: 'k.wav', duration: null, analysis: 'not json', cover_key: null, user_id: 'u1', creator: 'x', added_at: '', position: 1 }], { getPublicUrl: (k) => `/audio/${k}` });
    expect(s).toMatchObject({ id: 'upload_t2', title: 'a.b', lyrics: '', cover_url: null, audio_url: '/audio/k.wav', lrc_content: null });
  });
});
