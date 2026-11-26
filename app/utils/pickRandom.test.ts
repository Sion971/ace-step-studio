// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { pickRandom } from './pickRandom';
import { ALL_STYLES } from '../data/genres';

describe('pickRandom', () => {
  it('draws the number asked, all different, from the list', () => {
    const list = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    for (let k = 0; k < 50; k++) {
      const picked = pickRandom(list, 6);
      expect(picked).toHaveLength(6);
      expect(new Set(picked).size).toBe(6);
      picked.forEach(p => expect(list).toContain(p));
    }
    expect(pickRandom(['a', 'b'], 6)).toHaveLength(2);
  });

  it('gives the start and the end of the list the same chance', () => {
    const list = Array.from({ length: 105 }, (_, i) => i);
    const counts = new Array(105).fill(0);
    const trials = 20000;
    for (let k = 0; k < trials; k++) for (const x of pickRandom(list, 6)) counts[x]++;
    const expected = (trials * 6) / 105; // about 1143
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(Math.abs(avg(counts.slice(0, 10)) - expected) / expected).toBeLessThan(0.1);
    expect(Math.abs(avg(counts.slice(-10)) - expected) / expected).toBeLessThan(0.1);
    expect(Math.max(...counts) / expected).toBeLessThan(1.25);
  });

  it('the style list has its 900-odd styles', () => {
    expect(ALL_STYLES.length).toBeGreaterThan(900);
  });
});
