import { describe, it, expect } from 'vitest';
import { withFreshCover } from './freshCover';
import type { Song } from '../types';

const song = (over: Partial<Song>): Song => ({ id: 's1', title: 't', coverUrl: 'gradient', ...over }) as Song;

describe('withFreshCover', () => {
  it('takes the new cover of the reloaded song and keeps the rest of the held copy', () => {
    const held = song({ title: 'held title', coverUrl: 'gradient' });
    const out = withFreshCover(held, [song({ title: 'other', coverUrl: '/audio/u/covers/s1.jpg' })]);
    expect(out).toMatchObject({ title: 'held title', coverUrl: '/audio/u/covers/s1.jpg' });
  });
  it('returns the very same object when the cover did not change, so React does not re-render', () => {
    const held = song({});
    expect(withFreshCover(held, [song({})])).toBe(held);
  });
  it('leaves nothing, a generating song, and a song missing from the list alone', () => {
    expect(withFreshCover(null, [song({})])).toBeNull();
    const generating = song({ isGenerating: true });
    expect(withFreshCover(generating, [song({ coverUrl: 'new' })])).toBe(generating);
    const held = song({ id: 'gone' });
    expect(withFreshCover(held, [song({ coverUrl: 'new' })])).toBe(held);
  });
});
