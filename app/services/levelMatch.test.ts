// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { matchVolumes, parseLufsHeader } from './levelMatch';

describe('matchVolumes', () => {
  it('turns the processed file down when it is louder', () => {
    const m = matchVolumes(-20, -14)!;
    expect(m.before).toBe(1);
    expect(m.after).toBeCloseTo(0.501, 3); // -6 dB
    expect(m.diffDb).toBe(6);
  });

  it('turns the original down when it is the louder one', () => {
    const m = matchVolumes(-9, -14)!;
    expect(m.after).toBe(1);
    expect(m.before).toBeCloseTo(0.562, 3); // -5 dB
    expect(m.diffDb).toBe(5);
  });

  it('does nothing for a gap nobody hears, or without both levels', () => {
    expect(matchVolumes(-14, -14.2)).toBeNull();
    expect(matchVolumes(null, -14)).toBeNull();
    expect(matchVolumes(-14, undefined)).toBeNull();
    expect(matchVolumes(-Infinity, -14)).toBeNull();
    expect(matchVolumes(NaN, -14)).toBeNull();
  });

  it('never asks for a volume above 1', () => {
    for (const [a, b] of [[-30, -10], [-10, -30], [-14, -13]]) {
      const m = matchVolumes(a, b)!;
      expect(m.before).toBeLessThanOrEqual(1);
      expect(m.after).toBeLessThanOrEqual(1);
    }
  });
});

describe('parseLufsHeader', () => {
  it('reads a number, and nothing else', () => {
    expect(parseLufsHeader('-14.2')).toBe(-14.2);
    expect(parseLufsHeader(null)).toBeNull();
    expect(parseLufsHeader('-inf')).toBeNull();
    expect(parseLufsHeader('abc')).toBeNull();
  });
});
