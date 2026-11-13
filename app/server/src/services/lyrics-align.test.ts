// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { alignLyrics, alignWords, normalizeWords, similarity, toLrc } from './lyrics-align.js';
import type { TimedWord } from './lyrics-structure.js';

/** Heard words for a line, one word every `step` seconds from `start`. */
function say(line: string, start: number, step = 0.4): TimedWord[] {
  return line.split(/\s+/).filter(Boolean).map((word, i) => ({ word: ` ${word}`, start: start + i * step, end: start + i * step + step * 0.9 }));
}

const LYRICS = `[Intro - Instrumental]

[Verse 1]
Quand la nuit pèse et que tout semble s'éteindre,
Au cœur de l'ombre, Sa lumière vient poindre.

[Chorus]
Je sais que Tu agis,
Et Tu agiras.

[Chorus]
Je sais que Tu agis,
Et Tu agiras.`;

describe('normalizeWords and similarity', () => {
  it('drops case, accents and punctuation, and splits elisions', () => {
    expect(normalizeWords("Quand la nuit pèse, s'éteindre !")).toEqual(['quand', 'la', 'nuit', 'pese', 's', 'eteindre']);
    expect(normalizeWords('« Ô Seigneur ! »')).toEqual(['o', 'seigneur']);
  });

  it('scores a misheard word close to the written one', () => {
    expect(similarity('agneau', 'agneau')).toBe(1);
    expect(similarity('lumiere', 'lumieres')).toBeGreaterThan(0.8);
    expect(similarity('nuit', 'seigneur')).toBeLessThan(0.4);
  });
});

describe('alignWords', () => {
  it('keeps the order and skips words missing on either side', () => {
    const lyric = ['je', 'sais', 'que', 'tu', 'agis'];
    const heard = ['euh', 'je', 'sais', 'tu', 'agis', 'ooh'];
    expect(alignWords(lyric, heard)).toEqual([1, 2, -1, 3, 4]);
  });
});

describe('alignLyrics', () => {
  it('starts the first sung line where it is heard, after an instrumental intro', () => {
    const words = [
      ...say("Quand la nuit pèse et que tout semble s'éteindre,", 19.8),
      ...say("Au cœur de l'ombre, Sa lumière vient poindre.", 26),
      ...say('Je sais que Tu agis,', 40),
      ...say('Et Tu agiras.', 43),
      ...say('Je sais que Tu agis,', 60),
      ...say('Et Tu agiras.', 63),
    ];
    const { lines, matchedWords, totalWords } = alignLyrics(LYRICS, words, 90);
    const at = (text: string, nth = 0) => lines.filter((l) => l.text === text)[nth].time;
    expect(at("Quand la nuit pèse et que tout semble s'éteindre,")).toBeCloseTo(19.8, 1);
    expect(at("Au cœur de l'ombre, Sa lumière vient poindre.")).toBeCloseTo(26, 1);
    // The repeated chorus gets the times of each pass, in order.
    expect(at('Je sais que Tu agis,', 0)).toBeCloseTo(40, 1);
    expect(at('Je sais que Tu agis,', 1)).toBeCloseTo(60, 1);
    expect(at('Et Tu agiras.', 1)).toBeCloseTo(63, 1);
    // A section tag takes the time of the line after it.
    expect(at('[Verse 1]')).toBeCloseTo(19.8, 1);
    expect(at('[Chorus]', 1)).toBeCloseTo(60, 1);
    expect(matchedWords).toBe(totalWords);
  });

  it('places the lines Whisper did not hear between their neighbours', () => {
    const words = [
      ...say("Quand la nuit pèse et que tout semble s'éteindre,", 20),
      // the second line was not heard
      ...say('Je sais que Tu agis,', 40),
      ...say('Et Tu agiras.', 43),
      ...say('Je sais que Tu agis,', 60),
      ...say('Et Tu agiras.', 63),
    ];
    const { lines } = alignLyrics(LYRICS, words, 90);
    const second = lines.find((l) => l.text.startsWith('Au cœur'))!;
    expect(second.heard).toBe(false);
    expect(second.time).toBeGreaterThan(20);
    expect(second.time).toBeLessThan(40);
  });

  it('copes with misheard words and an extra word heard', () => {
    const words = [
      ...say('Quand la nuit paisse et que tout semble séteindre', 20),
      { word: ' yeah', start: 24, end: 24.3 },
      ...say("Au cœur de l'ombre sa lumière vient poindre", 26),
    ];
    const { lines } = alignLyrics("Quand la nuit pèse et que tout semble s'éteindre,\nAu cœur de l'ombre, Sa lumière vient poindre.", words, 40);
    expect(lines[0].time).toBeCloseTo(20, 1);
    expect(lines[1].time).toBeCloseTo(26, 1);
  });

  it('never goes back in time, and writes a valid LRC', () => {
    const words = [...say('Et Tu agiras.', 5), ...say("Quand la nuit pèse et que tout semble s'éteindre,", 20), ...say('Je sais que Tu agis,', 40)];
    const { lines, lrc } = alignLyrics(LYRICS, words, 90);
    for (let i = 1; i < lines.length; i++) expect(lines[i].time).toBeGreaterThanOrEqual(lines[i - 1].time);
    for (const row of lrc.split('\n')) expect(row).toMatch(/^\[\d{2}:\d{2}\.\d{2}\]\S/);
  });

  it('formats minutes past the hour mark of an LRC line', () => {
    expect(toLrc([{ time: 125.456, text: 'x', isSection: false, heard: true }])).toBe('[02:05.46]x');
  });

  it('reports how many words were heard when Whisper heard nothing', () => {
    const { matchedWords, totalWords, lines } = alignLyrics(LYRICS, [], 90);
    expect(matchedWords).toBe(0);
    expect(totalWords).toBeGreaterThan(0);
    expect(lines.every((l) => l.time === 0)).toBe(true);
  });
});
