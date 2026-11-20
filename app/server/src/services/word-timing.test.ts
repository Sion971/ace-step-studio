// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { wordStartsPerLine } from './word-timing.js';
import { karaokeTextFromWords, lrcToAss } from './simple-video.js';

/** Words heard at the given times. */
const heard = (pairs: Array<[number, string]>) => pairs.map(([start, word]) => ({ start, end: start + 0.3, word: ` ${word}` }));

describe('word-by-word karaoke timing', () => {
  const lines = [{ time: 10, text: 'Merci Seigneur pour chaque grâce' }, { time: 15, text: 'Pour chaque faveur' }];
  const ends = [15, 20];

  it('gives each word the time Whisper heard it, even when misheard', () => {
    const words = heard([[10.2, 'Merci'], [10.9, 'seigneur'], [12.4, 'pour'], [12.8, 'chaque'], [13.3, 'gras'], [15.1, 'Pour'], [15.6, 'chaque'], [16.4, 'faveur']]);
    const starts = wordStartsPerLine(lines, ends, words);
    expect(starts[0]).toEqual([10.2, 10.9, 12.4, 12.8, 13.3]);
    expect(starts[1]).toEqual([15.1, 15.6, 16.4]);
  });

  it('places unheard words between their neighbours, and keeps the line order', () => {
    const words = heard([[10.2, 'Merci'], [12.8, 'chaque'], [13.3, 'grâce']]);
    const [first] = wordStartsPerLine(lines, ends, words);
    expect(first![0]).toBe(10.2);
    expect(first![1]).toBeGreaterThan(10.2);
    expect(first![2]).toBeGreaterThan(first![1]);
    expect(first![2]).toBeLessThan(12.8);
    expect(first![3]).toBe(12.8);
  });

  it('ignores a word heard outside its line (a repeated chorus elsewhere), and leaves a line with nothing heard to the even split', () => {
    const words = heard([[40, 'Merci'], [40.5, 'Seigneur']]);
    expect(wordStartsPerLine(lines, ends, words)).toEqual([null, null]);
  });

  it('writes a silent wait before the first word, lights each word over about its length, then waits for the next', () => {
    const text = karaokeTextFromWords('Merci Seigneur pour', 10, [10.5, 11, 12], 15);
    // Merci: 0.5 s to the next word, lit over 0.45 s; Seigneur: 1 s, lit over 0.72 s, then 0.28 s unlit; pour: last.
    expect(text).toBe('{\\k50}{\\kf45}Merci {\\k5}{\\kf72}Seigneur {\\k28}{\\kf36}pour');
  });

  it('the subtitles use the heard words in karaoke, and the even split without them', () => {
    const lrc = '[00:10.00]Merci Seigneur pour chaque grâce\n[00:15.00]Pour chaque faveur';
    const words = heard([[10.2, 'Merci'], [10.9, 'seigneur'], [12.4, 'pour'], [12.8, 'chaque'], [13.3, 'grace']]);
    const timed = lrcToAss(lrc, { width: 1920, height: 1080, style: 'karaoke', nextLine: false, duration: 20, heardWords: words });
    expect(timed).toContain('{\\k20}{\\kf45}Merci {\\k25}{\\kf72}Seigneur {\\k78}{\\kf36}pour {\\kf50}chaque');
    const even = lrcToAss(lrc, { width: 1920, height: 1080, style: 'karaoke', nextLine: false, duration: 20 });
    expect(even).not.toContain('{\\k20}');
    // Line by line: no karaoke tags at all.
    expect(lrcToAss(lrc, { width: 1920, height: 1080, style: 'line', nextLine: false, duration: 20, heardWords: words })).not.toContain('\\kf');
  });
});
