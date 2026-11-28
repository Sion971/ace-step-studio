// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { captionFor, lmWritesCaption, wantsFavoriteStyle } from './empty-style.js';

describe('empty Style box', () => {
  it('lets the language model write the description when it is asked to (nothing sent, no "pop music")', () => {
    expect(captionFor({ style: '', thinking: true })).toBe('');
    expect(captionFor({ style: '', enhance: true, taskType: 'text2music' })).toBe('');
    expect(wantsFavoriteStyle({ style: '', thinking: true })).toBe(false);
  });

  it('does not count on the LM where the engine skips it, or when its caption step is off', () => {
    for (const p of [
      { thinking: true, taskType: 'cover' },
      { thinking: true, taskType: 'repaint' },
      { thinking: true, flowEditMorph: true },
      { thinking: true, useCotCaption: false },
    ]) {
      expect(lmWritesCaption(p)).toBe(false);
      expect(captionFor({ style: '', ...p })).toBe('pop music');
      expect(wantsFavoriteStyle({ style: '', ...p })).toBe(true);
    }
  });

  it('wants the favorite style only when nothing else describes the music', () => {
    expect(wantsFavoriteStyle({ style: '' })).toBe(true);
    expect(wantsFavoriteStyle({ style: '   ' })).toBe(true);
    expect(wantsFavoriteStyle({ style: 'zouk' })).toBe(false);
    expect(wantsFavoriteStyle({ style: '', taskType: 'lego', trackName: 'drums' })).toBe(false);
  });

  it('keeps a typed style and the track of a track task', () => {
    expect(captionFor({ style: 'zouk', thinking: true })).toBe('zouk');
    expect(captionFor({ style: '', taskType: 'lego', trackName: 'backing_vocals' })).toBe('backing vocals');
    expect(captionFor({})).toBe('pop music');
  });
});
