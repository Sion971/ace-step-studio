import { describe, expect, it } from 'vitest';
import { filterStudioSongs } from './StudioPage';
import { editorFileName } from './studioBridge';
import type { Song } from '../types';

const song = (over: Partial<Song>): Song => ({
  id: 'x', title: 'T', lyrics: '', style: '', coverUrl: '', duration: '0:22', createdAt: new Date('2026-10-20'), tags: [], audioUrl: '/audio/a.flac', ...over,
});

describe('filterStudioSongs', () => {
  const songs = [
    song({ id: '1', title: "Poussière d'étoile", style: 'funk guitar', createdAt: new Date('2026-10-21') }),
    song({ id: '2', title: 'Autre', style: 'ambient', tags: ['piano'], createdAt: new Date('2026-10-22') }),
    song({ id: '3', title: 'En cours', isGenerating: true }),
    song({ id: '4', title: 'Sans audio', audioUrl: undefined }),
  ];
  it('keeps only finished songs with audio, newest first', () => {
    expect(filterStudioSongs(songs, '').map((s) => s.id)).toEqual(['2', '1']);
  });
  it('searches the title, the style and the tags, ignoring case', () => {
    expect(filterStudioSongs(songs, 'FUNK').map((s) => s.id)).toEqual(['1']);
    expect(filterStudioSongs(songs, 'piano').map((s) => s.id)).toEqual(['2']);
    expect(filterStudioSongs(songs, 'poussière').map((s) => s.id)).toEqual(['1']);
    expect(filterStudioSongs(songs, 'zzz')).toEqual([]);
  });
});

describe('editorFileName', () => {
  it('removes characters a file name cannot have and keeps the audio extension', () => {
    expect(editorFileName('A/B: C?', '/audio/x.flac')).toBe('A_B_ C_.flac');
    expect(editorFileName('Song', '/audio/x.mp3?v=2')).toBe('Song.mp3');
  });
  it('falls back to mp3 and to a name when there is none', () => {
    expect(editorFileName('', '/audio/blob')).toBe('Audio.mp3');
  });
});
