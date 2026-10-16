// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { MASTERING_PRESETS, NO_MASTERING, isMasteringOn, matchPreset } from './masteringPresets';

describe('mastering presets', () => {
  it('"off" changes nothing, every other preset does something', () => {
    expect(isMasteringOn(MASTERING_PRESETS[0].settings)).toBe(false);
    for (const p of MASTERING_PRESETS.slice(1)) expect(isMasteringOn(p.settings), p.id).toBe(true);
  });

  it('keeps every value inside the ranges the server accepts', () => {
    for (const p of MASTERING_PRESETS) {
      const { harmonics, warmth, tone, glue, width } = p.settings;
      for (const v of [harmonics, warmth, glue, width]) expect(v >= 0 && v <= 100, p.id).toBe(true);
      expect(tone >= -100 && tone <= 100, p.id).toBe(true);
    }
  });

  it('finds the preset a set of values belongs to, and null once a slider has moved', () => {
    for (const p of MASTERING_PRESETS) expect(matchPreset(p.settings)).toBe(p.id);
    expect(matchPreset({ ...MASTERING_PRESETS[2].settings, glue: 36 })).toBeNull();
    expect(matchPreset(NO_MASTERING)).toBe('off');
  });

  it('counts a value under 1 as nothing, like the server does', () => {
    expect(isMasteringOn({ ...NO_MASTERING, warmth: 0.5, tone: -0.4 })).toBe(false);
    expect(isMasteringOn({ ...NO_MASTERING, tone: -1 })).toBe(true);
  });
});
