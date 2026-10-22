// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { estimateDurationFromLyrics } from './lyrics-duration.js';

const line = (n: number) => Array.from({ length: n }, (_, i) => `Ligne chantée numéro ${i + 1}`).join('\n');

describe('estimateDurationFromLyrics', () => {
  it('has no estimate without words to sing', () => {
    for (const text of [undefined, null, '', '   \n ', '[Intro]\n[Outro]', '(ooh)\n(ooh)', '...\n---']) {
      expect(estimateDurationFromLyrics(text as string | undefined), String(text)).toBeNull();
    }
  });

  it('grows with the length of the lyrics', () => {
    const short = estimateDurationFromLyrics(`[Verse]\n${line(8)}`)!;
    const long = estimateDurationFromLyrics(`[Verse]\n${line(30)}`)!;
    expect(long).toBeGreaterThan(short);
  });

  it('is never under 60 s, and rounded to 5 s', () => {
    const d = estimateDurationFromLyrics('Une seule ligne')!;
    expect(d).toBe(60);
    expect(estimateDurationFromLyrics(`[Verse]\n${line(13)}`)! % 5).toBe(0);
  });

  it('is never over the limit given', () => {
    expect(estimateDurationFromLyrics(line(200), { maxSeconds: 240 })).toBe(240);
    expect(estimateDurationFromLyrics(line(200))).toBe(240);
  });

  it('gives a long song for a song of about thirty lines with echoes (three to four minutes)', () => {
    const song = ['[Intro]', '(Ooh)', '(Ooh)', '[Verse 1]', line(6), '(Oh-oh)', '[Chorus]', line(4), '(Echo un)', '(Echo deux)', '[Verse 2]', line(6),
      '[Chorus]', line(4), '[Bridge]', line(4), '[Chorus]', line(4), '[Outro]', '(Ooh)'].join('\n');
    const d = estimateDurationFromLyrics(song, { bpm: 90 })!;
    expect(d).toBeGreaterThanOrEqual(150);
    expect(d).toBeLessThanOrEqual(240);
  });

  it('gives more time to a slower tempo and less to a faster one', () => {
    const text = `[Verse]\n${line(16)}`;
    expect(estimateDurationFromLyrics(text, { bpm: 70 })!).toBeGreaterThan(estimateDurationFromLyrics(text, { bpm: 140 })!);
  });

  it('counts a section without words (intro, solo) as time, and an echo in parentheses for less than a sung line', () => {
    const base = estimateDurationFromLyrics(line(20))!;
    expect(estimateDurationFromLyrics(`[Intro]\n${line(20)}\n[Solo]`)!).toBeGreaterThan(base);
    expect(estimateDurationFromLyrics(`${line(20)}\n${Array(10).fill('(echo)').join('\n')}`)!)
      .toBeLessThan(estimateDurationFromLyrics(`${line(20)}\n${line(10)}`)!);
  });

  it('copes with Windows line ends and with a single line break style', () => {
    expect(estimateDurationFromLyrics(`[Verse]\r\n${line(12).replace(/\n/g, '\r\n')}`)).toBe(estimateDurationFromLyrics(`[Verse]\n${line(12)}`));
  });
});
