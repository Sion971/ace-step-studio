import { describe, expect, it } from 'vitest';
import { emptyStyleUse } from './emptyStyle';

const base = { taskType: 'text2music', lmLoaded: true, thinking: false, enhance: false, useCotCaption: true, hasFavorite: false };

describe('emptyStyleUse', () => {
  it('says the LM writes the description only when it really will', () => {
    expect(emptyStyleUse({ ...base, thinking: true })).toBe('lm');
    expect(emptyStyleUse({ ...base, enhance: true })).toBe('lm');
    expect(emptyStyleUse({ ...base, thinking: true, lmLoaded: false })).toBe('default');
    expect(emptyStyleUse({ ...base, thinking: true, useCotCaption: false })).toBe('default');
    expect(emptyStyleUse({ ...base, thinking: true, taskType: 'cover' })).toBe('default');
  });

  it('falls back to the favorite, then to "pop music"', () => {
    expect(emptyStyleUse({ ...base, hasFavorite: true })).toBe('favorite');
    expect(emptyStyleUse({ ...base, taskType: 'repaint', hasFavorite: true })).toBe('favorite');
    expect(emptyStyleUse(base)).toBe('default');
  });

  it('leaves track tasks to their track', () => {
    expect(emptyStyleUse({ ...base, taskType: 'lego', hasFavorite: true })).toBe('track');
  });
});
