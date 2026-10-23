import { describe, expect, it } from 'vitest';
import { clampRegionValue } from './AudioPlayerPanel';

describe('clampRegionValue', () => {
  it('never goes past the end of the audio (the spinner used to climb forever)', () => {
    expect(clampRegionValue(22.1, 0, 22)).toBe(22);
    expect(clampRegionValue(9999, 0, 21.96)).toBe(21.96);
  });
  it('never goes below the minimum', () => {
    expect(clampRegionValue(-3, 0, 22)).toBe(0);
    expect(clampRegionValue(5, 8, 22)).toBe(8);
  });
  it('rounds to a tenth of a second and leaves a value inside the audio alone', () => {
    expect(clampRegionValue(7.26, 0, 22)).toBe(7.3);
  });
  it('does not cap when the duration is not known yet', () => {
    expect(clampRegionValue(40, 0, 0)).toBe(40);
  });
  it('falls back to the minimum on a non-finite value', () => {
    expect(clampRegionValue(NaN, 2, 22)).toBe(2);
  });
});
