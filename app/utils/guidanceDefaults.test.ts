import { describe, expect, it } from 'vitest';
import { defaultGuidance, isTrackAudioMode } from './guidanceDefaults';

describe('defaultGuidance', () => {
  it('turbo never uses guidance', () => expect(defaultGuidance(true, false)).toBe(0));
  it('base models start at 7, and at 5 for a per-track task', () => {
    expect(defaultGuidance(false, false)).toBe(7);
    expect(defaultGuidance(false, true)).toBe(5);
  });
  it('knows the per-track modes', () => {
    expect(isTrackAudioMode('lego')).toBe(true);
    expect(isTrackAudioMode('extract')).toBe(true);
    expect(isTrackAudioMode('complete')).toBe(true);
    expect(isTrackAudioMode('cover')).toBe(false);
  });
});
