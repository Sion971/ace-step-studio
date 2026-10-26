// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { isNoise, similarity, structureLyrics, wordsToLines, type TimedLine } from './lyrics-structure.js';


/** The tests of the labels turn them on. */
const structureLyricsL = (lines: TimedLine[]) => structureLyrics(lines, true);

let t = 0;
/** Lines of 3 s, 0.5 s apart; `gap` seconds of silence before the first one. */
const stanza = (texts: string[], gap: number): TimedLine[] => texts.map((text, i) => {
  if (i === 0) t += gap;
  const start = t; t += 3; return { start, end: start + 3, text };
});
const song = (parts: Array<[string[], number]>): TimedLine[] => { t = 0; return parts.flatMap(([l, g]) => stanza(l, g)); };

describe('structureLyrics', () => {
  const v1 = ['Dieu est esprit', 'Il faut que ce qu\'il adore'];
  const ch = ['L\'adore en esprit', 'et en verite'];
  const v2 = ['Christ est venu', 'il reviendra pour tous'];

  it('labels the stanza that comes back as the chorus, and the others as verses', () => {
    const out = structureLyricsL(song([[v1, 0], [ch, 3], [v2, 3], [ch, 3]]));
    expect(out).toBe(['[Verse 1]', ...v1, '', '[Chorus]', ...ch, '', '[Verse 2]', ...v2, '', '[Chorus]', ...ch].join('\n'));
  });

  it('recognises a chorus sung a little differently', () => {
    const out = structureLyricsL(song([[v1, 0], [['Gloire a Dieu', 'toujours et pour toujours'], 3], [v2, 3], [['Gloire a Dieu', 'toujours et a jamais'], 3]]));
    expect(out.match(/\[Chorus\]/g)).toHaveLength(2);
  });

  it('keeps the words as they are, and keeps lines of one stanza together', () => {
    const out = structureLyricsL(song([[['a b c', 'd e f'], 0], [['g h i'], 3]]));
    expect(out).toContain('a b c\nd e f');
  });

  it('marks a long silence as an instrumental part, and a late start as an intro', () => {
    const out = structureLyricsL(song([[v1, 12], [ch, 3], [v2, 15], [ch, 3]]));
    expect(out.startsWith('[Intro]')).toBe(true);
    expect(out).toContain('[Instrumental]');
  });

  it('calls the unique stanza between choruses a bridge, and the one after the last chorus an outro', () => {
    const out = structureLyricsL(song([[v1, 0], [ch, 3], [v2, 3], [ch, 3], [['Pont de lumiere', 'sans fin'], 3], [ch, 3], [['Amen amen'], 3]]));
    expect(out).toContain('[Bridge]');
    expect(out).toContain('[Outro]');
  });

  it('gives plain phrases when there is a single stanza (nothing to tell apart)', () => {
    expect(structureLyricsL(song([[['un', 'deux', 'trois'], 0]]))).toBe('un\ndeux\ntrois');
  });

  it('drops the noise Whisper writes for music', () => {
    const out = structureLyricsL([{ start: 0, end: 2, text: ' ...' }, { start: 3, end: 5, text: '♪' }, { start: 6, end: 8, text: 'Dieu est esprit' }]);
    expect(out).toBe('Dieu est esprit');
    expect(structureLyricsL([{ start: 0, end: 2, text: '...' }])).toBe('');
  });

  it('survives lines without times', () => {
    expect(structureLyricsL([{ start: NaN, end: NaN, text: 'a' }, { start: NaN, end: NaN, text: 'b' }])).toContain('a');
  });
});

describe('long runs of phrases', () => {
  const lines = (n: number, gaps: number[]): TimedLine[] => {
    let at = 0;
    return Array.from({ length: n }, (_, i) => { const start = at; at += 3 + (gaps[i] ?? 0.2); return { start, end: start + 3, text: `mot${String.fromCharCode(97 + i)}${String.fromCharCode(97 + i)} unique${String.fromCharCode(97 + i)}${String.fromCharCode(97 + i)}` }; });
  };
  it('cuts a stanza of more than 6 phrases at its longest pause', () => {
    // 10 phrases with only short pauses (< 2 s), the longest after the 5th
    const out = structureLyricsL(lines(10, [0.2, 0.2, 0.2, 0.2, 1.5, 0.2, 0.2, 0.2, 0.2]));
    const w = (k: number) => `mot${String.fromCharCode(97 + k)}${String.fromCharCode(97 + k)} unique${String.fromCharCode(97 + k)}${String.fromCharCode(97 + k)}`;
    expect(out).toContain(`[Verse 1]\n${[0, 1, 2, 3, 4].map(w).join('\n')}\n\n[Verse 2]\n${w(5)}`);
  });
  it('leaves a run alone when there is no pause to cut at', () => {
    const out = structureLyricsL(lines(8, []).map((l, i) => ({ ...l, start: i * 3, end: i * 3 + 3 })));
    expect(out).not.toContain('[');
  });
});

describe('helpers', () => {
  it('knows noise', () => { expect(isNoise(' … ')).toBe(true); expect(isNoise('Amen')).toBe(false); });
  it('measures how much two stanzas share', () => {
    expect(similarity(['la la la'], ['la la la'])).toBe(1);
    expect(similarity(['abc def'], ['xyz uvw'])).toBe(0);
  });
});

describe('wordsToLines', () => {
  const w = (word: string, start: number, end: number) => ({ word: ` ${word}`, start, end });
  it('cuts at a pause between words', () => {
    const lines = wordsToLines([w('Dieu', 0, 0.4), w('est', 0.5, 0.7), w('esprit', 0.8, 1.4), w('il', 3.0, 3.2), w('faut', 3.3, 3.6)]);
    expect(lines.map((l) => l.text)).toEqual(['Dieu est esprit', 'il faut']);
    expect(lines[1].start).toBe(3.0);
  });
  it('cuts after a comma or a full stop even without a pause', () => {
    expect(wordsToLines([w('Dieu', 0, 0.4), w('esprit,', 0.45, 0.9), w('il', 0.95, 1.1), w('faut', 1.15, 1.4)]).map((l) => l.text)).toEqual(['Dieu esprit,', 'il faut']);
  });
  it('does not let a very long run of words become one phrase', () => {
    const many = Array.from({ length: 30 }, (_, i) => w(`m${i}`, i * 0.3, i * 0.3 + 0.25));
    expect(wordsToLines(many).length).toBeGreaterThanOrEqual(3);
  });
  it('lets the pauses between the rebuilt phrases make the stanzas, although the segments touch', () => {
    // two stanzas of two phrases, a 4 s pause between them, the second one repeating the first
    const words = [
      w('Gloire', 0, 0.5), w('a', 0.6, 0.7), w('Dieu', 0.8, 1.2), w('toujours', 2.0, 2.6), w('encore', 2.7, 3.2),
      w('Christ', 8.0, 8.4), w('est', 8.5, 8.7), w('venu', 8.8, 9.2), w('pour', 10.0, 10.3), w('tous', 10.4, 10.8),
      w('Gloire', 16.0, 16.5), w('a', 16.6, 16.7), w('Dieu', 16.8, 17.2), w('toujours', 18.0, 18.6), w('encore', 18.7, 19.2),
    ];
    const out = structureLyricsL(wordsToLines(words));
    expect(out).toContain('[Chorus]');
    expect(out).toContain('[Verse 1]');
  });
});

describe('without labels (the default)', () => {
  it('only separates the stanzas with a blank line', () => {
    t = 0;
    const lines = [...stanza(['Dieu est esprit', 'il faut'], 0), ...stanza(['Gloire a Dieu', 'toujours'], 3), ...stanza(['Christ est venu', 'pour tous'], 3)];
    expect(structureLyrics(lines)).toBe('Dieu est esprit\nil faut\n\nGloire a Dieu\ntoujours\n\nChrist est venu\npour tous');
  });
  it('adds no [Intro] / [Instrumental] tag either', () => {
    t = 0;
    const out = structureLyrics([...stanza(['un', 'deux'], 12), ...stanza(['trois', 'quatre'], 15)]);
    expect(out).not.toContain('[');
  });
});
