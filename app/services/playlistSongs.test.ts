// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { formatSongDuration, mapPlaylistSong } from './playlistSongs';

const row = {
  id: 'song-1',
  title: 'Night Drive',
  lyrics: '[verse] ...',
  style: 'synthwave',
  cover_url: '/audio/covers/song-1.png',
  audio_url: '/audio/song-1.mp3',
  duration: 187,
  bpm: 110,
  tags: ['retro', 'night'],
  is_public: 1,
  like_count: 4,
  view_count: 21,
  creator: 'sion',
  created_at: '2026-10-05T18:32:01.000Z',
  added_at: '2026-10-06 09:15:00',
};

describe('mapPlaylistSong', () => {
  it('gives the app\'s Song what the interface relies on', () => {
    const song = mapPlaylistSong(row);
    expect(song.createdAt).toBeInstanceOf(Date);
    expect(Number.isNaN(song.createdAt.getTime())).toBe(false);
    expect(song.createdAt.toISOString()).toBe('2026-10-05T18:32:01.000Z');
    expect(typeof song.coverUrl).toBe('string');
    expect(song.coverUrl.length).toBeGreaterThan(0);
    expect(Array.isArray(song.tags)).toBe(true);
  });

  it('maps every database field to its camelCase name', () => {
    expect(mapPlaylistSong(row)).toMatchObject({
      id: 'song-1',
      title: 'Night Drive',
      style: 'synthwave',
      coverUrl: '/audio/covers/song-1.png',
      audioUrl: '/audio/song-1.mp3',
      duration: '3:07',
      durationSeconds: 187,
      bpm: 110,
      tags: ['retro', 'night'],
      isPublic: true,
      likeCount: 4,
      viewCount: 21,
      creator: 'sion',
      addedAt: '2026-10-06 09:15:00',
    });
  });

  it('turns SQLite\'s 0 and 1 into a real boolean', () => {
    expect(mapPlaylistSong({ ...row, is_public: 1 }).isPublic).toBe(true);
    expect(mapPlaylistSong({ ...row, is_public: 0 }).isPublic).toBe(false);
    expect(mapPlaylistSong({ ...row, is_public: undefined }).isPublic).toBe(false);
  });

  it('does not leak the database\'s snake_case names', () => {
    const song = mapPlaylistSong(row) as unknown as Record<string, unknown>;
    for (const key of ['cover_url', 'audio_url', 'like_count', 'view_count', 'created_at', 'added_at', 'is_public']) {
      expect(song, key).not.toHaveProperty(key);
    }
  });

  it('falls back to a generated cover when the song has none', () => {
    const song = mapPlaylistSong({ ...row, cover_url: undefined });
    expect(song.coverUrl.startsWith('data:image/svg+xml')).toBe(true);
    expect(mapPlaylistSong({ ...row, cover_url: undefined }).coverUrl).toBe(song.coverUrl); // stable for a given song
  });

  it('accepts a song already in camelCase', () => {
    const song = mapPlaylistSong({ ...row, cover_url: undefined, audio_url: undefined, coverUrl: '/c.png', audioUrl: '/audio/x.mp3' });
    expect(song.coverUrl).toBe('/c.png');
    expect(song.audioUrl).toBe('/audio/x.mp3');
  });

  it('has no audio URL when the song has no audio', () => {
    expect(mapPlaylistSong({ ...row, audio_url: null }).audioUrl).toBeUndefined();
  });

  it('defaults the lists and counters of a sparse row', () => {
    const song = mapPlaylistSong({ id: 'x', title: 't', created_at: '2026-01-01T00:00:00.000Z' });
    expect(song.tags).toEqual([]);
    expect(song.likeCount).toBe(0);
    expect(song.viewCount).toBe(0);
    expect(song.isPublic).toBe(false);
  });
});

describe('formatSongDuration', () => {
  it('formats seconds as the app does, "m:ss"', () => {
    expect(formatSongDuration(187)).toBe('3:07');
    expect(formatSongDuration(59.9)).toBe('0:59');
    expect(formatSongDuration(60)).toBe('1:00');
    expect(formatSongDuration(3600)).toBe('60:00');
    expect(formatSongDuration(5)).toBe('0:05');
  });

  it('gives "0:00" when there is no usable length', () => {
    for (const value of [0, -4, undefined, null, Number.NaN, 'abc', '']) expect(formatSongDuration(value), String(value)).toBe('0:00');
  });

  it('accepts a length that arrives as a numeric string', () => {
    expect(formatSongDuration('187')).toBe('3:07');
  });

  it('matches the formula App.tsx uses, on a range of values', () => {
    const appFormula = (d: number) => (d && d > 0 ? `${Math.floor(d / 60)}:${String(Math.floor(d % 60)).padStart(2, '0')}` : '0:00');
    for (const d of [0, 1, 9, 10, 59, 60, 61, 119.5, 187, 600, 3599, 3600, 5999.9]) expect(formatSongDuration(d), String(d)).toBe(appFormula(d));
  });
});

describe('mapPlaylistSong and the length of a song', () => {
  it('keeps the app\'s formatted string in `duration`, and the seconds apart for the playlist\'s total', () => {
    const song = mapPlaylistSong({ ...row, duration: 125 });
    expect(song.duration).toBe('2:05');
    expect(song.durationSeconds).toBe(125);
  });

  it('has no seconds when the length is unknown, and "0:00" to show', () => {
    for (const duration of [undefined, null, 0, 'abc']) {
      const song = mapPlaylistSong({ ...row, duration });
      expect(song.duration, String(duration)).toBe('0:00');
      expect(song.durationSeconds, String(duration)).toBeUndefined();
    }
  });
});
