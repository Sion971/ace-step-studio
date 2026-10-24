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

import { durationToSeconds } from './studioBridge';
import { pickLegoModels, shortTitle } from './StudioInstrumentPanel';

describe('durationToSeconds', () => {
  it('reads m:ss and returns 0 when unreadable', () => {
    expect(durationToSeconds('0:22')).toBe(22);
    expect(durationToSeconds('3:07')).toBe(187);
    expect(durationToSeconds('--:--')).toBe(0);
    expect(durationToSeconds(undefined)).toBe(0);
  });
});

describe('pickLegoModels', () => {
  it('keeps pure base models only, the active one first', () => {
    const out = pickLegoModels([
      { name: 'acestep-v15-turbo' }, { name: 'acestep-v15-xl-sft' },
      { name: 'acestep-v15-base' }, { name: 'acestep-v15-xl-base', is_active: true },
    ]);
    expect(out).toEqual(['acestep-v15-xl-base', 'acestep-v15-base']);
  });
});

import { encodeWavSlice } from './studioBridge';

describe('encodeWavSlice', () => {
  const buf = { numberOfChannels: 1, sampleRate: 10, length: 30, getChannelData: () => Float32Array.from({ length: 30 }, (_, i) => i / 30) };
  it('writes a WAV with only the requested part', () => {
    const wav = encodeWavSlice(buf, 1, 2); // frames 10..20
    const v = new DataView(wav);
    expect(String.fromCharCode(v.getUint8(0), v.getUint8(1), v.getUint8(2), v.getUint8(3))).toBe('RIFF');
    expect(v.getUint32(24, true)).toBe(10);          // sample rate
    expect(v.getUint32(40, true)).toBe(10 * 2);      // 10 frames, 16 bit
    expect(wav.byteLength).toBe(44 + 20);
    expect(v.getInt16(44, true)).toBe(Math.floor((10 / 30) * 0x7fff));
  });
  it('clamps a range that goes past the end', () => {
    expect(encodeWavSlice(buf, 2, 99).byteLength).toBe(44 + 10 * 2);
  });
});

describe('pickLegoModels not installed', () => {
  it('leaves out a Base model that is not on the disk', () => {
    expect(pickLegoModels([{ name: 'acestep-v15-xl-base', is_preloaded: false }, { name: 'acestep-v15-base', is_preloaded: true }])).toEqual(['acestep-v15-base']);
  });
});

describe('shortTitle', () => {
  it('keeps short names and cuts the beginning of long ones, where stems of a song do not differ', () => {
    expect(shortTitle('Short')).toBe('Short');
    const a = shortTitle("Poussière d'étoile (Par Thierry SELBONNE) (mix)-drums");
    const b = shortTitle("Poussière d'étoile (Par Thierry SELBONNE) (mix)-other");
    expect(a.endsWith('drums')).toBe(true);
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(32);
  });
});
