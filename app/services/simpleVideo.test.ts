import { describe, expect, it } from 'vitest';
import { stillLayout } from './simpleVideo';

describe('stillLayout', () => {
  for (const [name, w, h] of [['16:9', 1920, 1080], ['9:16', 1080, 1920], ['1:1', 1080, 1080]] as const) {
    it(`keeps the cover and the title above the lyrics in ${name}`, () => {
      const L = stillLayout(w, h);
      // The cover fits in the frame.
      expect(L.coverY - L.coverSize / 2).toBeGreaterThan(0);
      expect(L.coverX + L.coverSize / 2).toBeLessThanOrEqual(w);
      // Title under the cover, artist under the title, both above the lyrics (lower fifth of the frame).
      expect(L.titleY - L.titleSize).toBeGreaterThan(L.coverY + L.coverSize / 2);
      expect(L.artistY).toBeGreaterThan(L.titleY);
      expect(L.artistY).toBeLessThan(h * 0.76);
    });
  }
});
