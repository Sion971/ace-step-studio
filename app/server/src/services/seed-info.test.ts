import { describe, it, expect } from 'vitest';
import { parseSeeds, paramsWithSeed } from './seed-info.js';

describe('parseSeeds', () => {
  it('lit un ou plusieurs seeds', () => {
    expect(parseSeeds('42')).toEqual([42]);
    expect(parseSeeds('1, 2,3')).toEqual([1, 2, 3]);
  });
  it('ignore le vide et le non-texte', () => {
    expect(parseSeeds(undefined)).toEqual([]);
    expect(parseSeeds('')).toEqual([]);
    expect(parseSeeds('-1, abc')).toEqual([]);
  });
});

describe('paramsWithSeed', () => {
  it('remplace le seed par celui de la piste', () => {
    expect(paramsWithSeed({ seed: -1, a: 1 }, [10, 20], 1)).toEqual({ seed: 20, a: 1 });
  });
  it('laisse les paramètres intacts sans seed connu', () => {
    const p = { seed: -1 };
    expect(paramsWithSeed(p, [], 0)).toBe(p);
    expect(paramsWithSeed(p, undefined, 0)).toBe(p);
  });
});
