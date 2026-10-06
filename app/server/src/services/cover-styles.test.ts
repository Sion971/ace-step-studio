// @vitest-environment node
//
// The cover style feature, with the REAL songIdToSeed (cover-jobs.test.ts mocks it, which is how the seed-0 defect
// went unnoticed: every real job id, `job_<timestamp>_<random>`, used to give seed 0 and style 0).
import { describe, it, expect } from 'vitest';
import { songIdToSeed } from './pollinations.js';
import { STYLE_MODIFIERS, styleModifierFor } from './cover-jobs.js';

/** Small deterministic PRNG, so the distribution test never flakes. */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Job ids shaped like acestep.ts mints them: job_<Date.now()>_<7 base-36 characters>. */
function realisticJobIds(count: number): string[] {
  const rand = lcg(12345);
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const random = Math.floor(rand() * 36 ** 7).toString(36).padStart(7, '0');
    ids.push(`job_${1791000000000 + i * 1237}_${random}`);
  }
  return ids;
}

describe('songIdToSeed', () => {
  it('keeps the historical value for UUIDs', () => {
    expect(songIdToSeed('3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b')).toBe(1059818526);
    expect(songIdToSeed('a1b2c3d4-0000-0000-0000-000000000000')).toBe(565363668);
  });

  it('no longer returns 0 for the job ids the Studio really produces', () => {
    const real = ['job_1791248484518_m1w27sk', 'job_1791248597203_fnyi7k0', 'job_1791300000000_abcdefg'];
    const seeds = real.map(songIdToSeed);
    for (const seed of seeds) expect(seed).toBeGreaterThan(0);
    expect(new Set(seeds).size).toBe(real.length);
  });

  it('is deterministic', () => {
    expect(songIdToSeed('job_1791248484518_m1w27sk')).toBe(songIdToSeed('job_1791248484518_m1w27sk'));
  });

  it('distinguishes ids that differ by a single character', () => {
    expect(songIdToSeed('job_1791300000000_abcdefg')).not.toBe(songIdToSeed('job_1791300000000_abcdefh'));
  });

  it('stays inside 31 bits (Pollinations accepts int32)', () => {
    for (const id of realisticJobIds(2000)) {
      const seed = songIdToSeed(id);
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThanOrEqual(0x7fffffff);
    }
  });
});

describe('STYLE_MODIFIERS', () => {
  it('has sixteen distinct, non-empty, reasonably short entries', () => {
    expect(STYLE_MODIFIERS).toHaveLength(16);
    expect(new Set(STYLE_MODIFIERS).size).toBe(16);
    for (const style of STYLE_MODIFIERS) {
      expect(style.trim()).toBe(style);
      expect(style.length).toBeGreaterThan(10);
      expect(style.length).toBeLessThanOrEqual(80);
    }
  });
});

describe('styleModifierFor', () => {
  it('gives the same style to the same job', () => {
    expect(styleModifierFor('job_1791248484518_m1w27sk')).toBe(styleModifierFor('job_1791248484518_m1w27sk'));
  });

  it('spreads realistic job ids over all sixteen styles, roughly evenly', () => {
    const counts = new Map<string, number>();
    const total = 16000;
    for (const id of realisticJobIds(total)) {
      const style = styleModifierFor(id);
      counts.set(style, (counts.get(style) ?? 0) + 1);
    }
    expect(counts.size).toBe(16);
    const expected = total / 16;
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(expected * 0.85);
      expect(count).toBeLessThan(expected * 1.15);
    }
  });

  it('varies between consecutive jobs (a retake looks different)', () => {
    const ids = realisticJobIds(200);
    let changes = 0;
    for (let i = 1; i < ids.length; i++) if (styleModifierFor(ids[i]) !== styleModifierFor(ids[i - 1])) changes++;
    expect(changes).toBeGreaterThan(150);
  });
});
