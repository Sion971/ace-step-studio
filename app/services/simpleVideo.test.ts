import { describe, expect, it } from 'vitest';
import { fitTitle, shiftLrc, stillLayout } from './simpleVideo';

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

describe('fitTitle', () => {
  // A font where every character is `size / 2` wide.
  const measure = (text: string, size: number) => text.length * size / 2;

  it('keeps a short title whole at its size', () => {
    expect(fitTitle('Il est mon salut', 1000, 60, measure)).toEqual({ lines: ['Il est mon salut'], size: 60 });
  });

  it('first makes a slightly long title smaller', () => {
    const fit = fitTitle('Jésus, Tu es mon Roc (Psaumes 31)', 900, 60, measure);
    expect(fit.lines).toHaveLength(1);
    expect(fit.size).toBeLessThan(60);
    expect(measure(fit.lines[0], fit.size)).toBeLessThanOrEqual(900);
  });

  it('then puts a long title on two balanced lines, every word kept', () => {
    const title = 'Jésus, Tu es mon Roc (Psaumes 31) – version longue';
    const fit = fitTitle(title, 700, 60, measure);
    expect(fit.lines).toHaveLength(2);
    expect(fit.lines.join(' ')).toBe(title);
    for (const line of fit.lines) expect(measure(line, fit.size)).toBeLessThanOrEqual(700);
  });
});

describe('shiftLrc', () => {
  it('moves every time, keeps the text and the section tags, and stops at zero', () => {
    const lrc = '[00:00.50][Verse 1]\n[00:01.20]Il est mon salut\n[01:59.90]Fin';
    expect(shiftLrc(lrc, 0.5)).toBe('[00:01.00][Verse 1]\n[00:01.70]Il est mon salut\n[02:00.40]Fin');
    expect(shiftLrc(lrc, -1)).toBe('[00:00.00][Verse 1]\n[00:00.20]Il est mon salut\n[01:58.90]Fin');
    expect(shiftLrc(lrc, 0)).toBe(lrc);
  });
});
