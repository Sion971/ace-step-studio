// services/playlistSongs.ts
//
// Turns the rows of GET /api/playlists/:id into the app's Song.
//
// The server returns songs straight from the database (snake_case: cover_url, audio_url, like_count, created_at...), while
// the whole interface works with the camelCase Song of types.ts. This conversion used to live inside PlaylistDetail.tsx, typed
// against the database's own `Song` of services/api.ts (a different type with the same name), so TypeScript could not see when
// the result had the wrong shape. That is how a song without `createdAt` once reached the app and crashed it when going from a
// playlist to the Create view ("createdAt is undefined", see App.tsx). It is now a typed pure function, with tests.

import type { Song } from '../types';
import { getAudioUrl, getCoverUrl } from './api';

/**
 * A song of a playlist: the app's Song, plus what only a playlist knows. `addedAt` is the date it was added;
 * `durationSeconds` is the length in seconds, kept for the playlist's own total because the app's `duration` is a formatted string.
 */
export type PlaylistSong = Song & { addedAt?: string; durationSeconds?: number };

/**
 * The app's `duration`: a "m:ss" string, built from seconds exactly as App.tsx and SongProfile.tsx build it. The database returns
 * seconds; this conversion used to be skipped here, so a song opened from a playlist showed "187" instead of "3:07" in the side
 * panel and the player.
 */
export function formatSongDuration(seconds: unknown): string {
  const n = typeof seconds === 'number' ? seconds : Number(seconds);
  return Number.isFinite(n) && n > 0 ? `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, '0')}` : '0:00';
}

export function mapPlaylistSong(s: any): PlaylistSong {
  return {
    id: s.id,
    title: s.title,
    lyrics: s.lyrics,
    style: s.style,
    coverUrl: s.cover_url || s.coverUrl || getCoverUrl(s.id),
    audioUrl: getAudioUrl(s.audio_url || s.audioUrl, s.id),
    duration: formatSongDuration(s.duration),
    durationSeconds: Number.isFinite(Number(s.duration)) && Number(s.duration) > 0 ? Number(s.duration) : undefined,
    bpm: s.bpm,
    tags: s.tags || [],
    isPublic: Boolean(s.is_public),
    likeCount: s.like_count || 0,
    viewCount: s.view_count || 0,
    creator: s.creator,
    createdAt: new Date(s.created_at),
    addedAt: s.added_at,
  };
}
