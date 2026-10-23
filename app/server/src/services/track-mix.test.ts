// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { buildMixArgs, buildMixFilter, clampLevel, regionCoversWholeSource, shouldMix } from './track-mix.js';
import { trackCaptionFallback } from './track-tasks.js';

describe('track mix', () => {
  it('applies the level as a linear gain on the new track only', () => {
    expect(buildMixFilter(80)).toContain('volume=0.800');
    expect(buildMixFilter(80)).toContain('amix=inputs=2:duration=longest:normalize=0');
    expect(buildMixFilter(80)).toContain('alimiter');
  });
  it('clamps the level and falls back to 80', () => {
    expect(clampLevel(500)).toBe(150);
    expect(clampLevel(-3)).toBe(0);
    expect(clampLevel(undefined)).toBe(80);
    expect(clampLevel('abc')).toBe(80);
  });
  it('picks the codec from the output extension', () => {
    expect(buildMixArgs('a.mp3', 'b.mp3', 'c.mp3', 80)).toContain('libmp3lame');
    expect(buildMixArgs('a.flac', 'b.flac', 'c.flac', 80)).toContain('flac');
  });
  it('mixes Lego only when the region covers the whole source', () => {
    expect(regionCoversWholeSource(0, -1, 22)).toBe(true);
    expect(regionCoversWholeSource(0, 22, 22)).toBe(true);
    expect(regionCoversWholeSource(19.6, 22, 22)).toBe(false);
    expect(regionCoversWholeSource(0, 10, 22)).toBe(false);
    expect(shouldMix({ taskType: 'lego', mixWithSource: true, repaintingStart: 0, repaintingEnd: -1 }, 22)).toBe(true);
    expect(shouldMix({ taskType: 'lego', mixWithSource: true, repaintingStart: 5, repaintingEnd: -1 }, 22)).toBe(false);
  });
  it('mixes Complete whatever the region, and never Extract or when off', () => {
    expect(shouldMix({ taskType: 'complete', mixWithSource: true, repaintingStart: 5 }, 22)).toBe(true);
    expect(shouldMix({ taskType: 'extract', mixWithSource: true }, 22)).toBe(false);
    expect(shouldMix({ taskType: 'lego', mixWithSource: false }, 22)).toBe(false);
    expect(shouldMix({ taskType: 'cover', mixWithSource: true }, 22)).toBe(false);
  });
  it('describes the requested track when Style is empty', () => {
    expect(trackCaptionFallback('lego', 'backing_vocals')).toBe('backing vocals');
    expect(trackCaptionFallback('complete', undefined, ['drums', 'bass'])).toBe('drums, bass');
    expect(trackCaptionFallback('cover', 'guitar')).toBe('');
  });
});
