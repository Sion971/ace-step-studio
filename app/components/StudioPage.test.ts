import { describe, expect, it } from 'vitest';
import { filterStudioSongs } from './StudioPage';
import { editorFileName, syncEditorEntries } from './studioBridge';
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

describe('filterStudioSongs robustness', () => {
  it('does not throw when tags is a string or missing, or style is missing', () => {
    const odd = [
      song({ id: 'a', title: 'A', tags: 'funk, rock' as unknown as string[] }),
      song({ id: 'b', title: 'B', tags: undefined, style: undefined as unknown as string }),
    ];
    expect(filterStudioSongs(odd, 'funk').map((s) => s.id)).toEqual(['a']);
    expect(filterStudioSongs(odd, 'b').map((s) => s.id)).toEqual(['b']);
  });
});

describe('syncEditorEntries', () => {
  const e = (id: string, name: string, addedAt: number, seen = false) => ({ id, name, addedAt, seen });
  it('confirms an entry once its clip is on the timeline', () => {
    expect(syncEditorEntries([e('1', 'A.flac', 0)], ['A.flac'], 1000)[0].seen).toBe(true);
  });
  it('removes a confirmed entry whose clip is gone', () => {
    expect(syncEditorEntries([e('1', 'A.flac', 0, true)], [], 1000)).toEqual([]);
  });
  it('keeps a fresh entry that has not shown up yet, drops it after the grace period', () => {
    expect(syncEditorEntries([e('1', 'A.flac', 0)], [], 1000)).toHaveLength(1);
    expect(syncEditorEntries([e('1', 'A.flac', 0)], [], 30000)).toHaveLength(0);
  });
  it('matches the same song added twice clip by clip', () => {
    const out = syncEditorEntries([e('1', 'A.flac', 0, true), e('2', 'A.flac', 5, true)], ['A.flac'], 1000);
    expect(out.map((x) => x.id)).toEqual(['1']);
  });
});
