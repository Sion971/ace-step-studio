// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { isNoise, similarity, structureLyrics, type TimedLine } from './lyrics-structure.js';

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
    const out = structureLyrics(song([[v1, 0], [ch, 3], [v2, 3], [ch, 3]]));
    expect(out).toBe(['[Verse 1]', ...v1, '', '[Chorus]', ...ch, '', '[Verse 2]', ...v2, '', '[Chorus]', ...ch].join('\n'));
  });

  it('recognises a chorus sung a little differently', () => {
    const out = structureLyrics(song([[v1, 0], [['Gloire a Dieu', 'toujours et pour toujours'], 3], [v2, 3], [['Gloire a Dieu', 'toujours et a jamais'], 3]]));
    expect(out.match(/\[Chorus\]/g)).toHaveLength(2);
  });

  it('keeps the words as they are, and keeps lines of one stanza together', () => {
    const out = structureLyrics(song([[['a b c', 'd e f'], 0], [['g h i'], 3]]));
    expect(out).toContain('a b c\nd e f');
  });

  it('marks a long silence as an instrumental part, and a late start as an intro', () => {
    const out = structureLyrics(song([[v1, 12], [ch, 3], [v2, 15], [ch, 3]]));
    expect(out.startsWith('[Intro]')).toBe(true);
    expect(out).toContain('[Instrumental]');
  });

  it('calls the unique stanza between choruses a bridge, and the one after the last chorus an outro', () => {
    const out = structureLyrics(song([[v1, 0], [ch, 3], [v2, 3], [ch, 3], [['Pont de lumiere', 'sans fin'], 3], [ch, 3], [['Amen amen'], 3]]));
    expect(out).toContain('[Bridge]');
    expect(out).toContain('[Outro]');
  });

  it('gives plain phrases when there is a single stanza (nothing to tell apart)', () => {
    expect(structureLyrics(song([[['un', 'deux', 'trois'], 0]]))).toBe('un\ndeux\ntrois');
  });

  it('drops the noise Whisper writes for music', () => {
    const out = structureLyrics([{ start: 0, end: 2, text: ' ...' }, { start: 3, end: 5, text: '♪' }, { start: 6, end: 8, text: 'Dieu est esprit' }]);
    expect(out).toBe('Dieu est esprit');
    expect(structureLyrics([{ start: 0, end: 2, text: '...' }])).toBe('');
  });

  it('survives lines without times', () => {
    expect(structureLyrics([{ start: NaN, end: NaN, text: 'a' }, { start: NaN, end: NaN, text: 'b' }])).toContain('a');
  });
});

describe('helpers', () => {
  it('knows noise', () => { expect(isNoise(' … ')).toBe(true); expect(isNoise('Amen')).toBe(false); });
  it('measures how much two stanzas share', () => {
    expect(similarity(['la la la'], ['la la la'])).toBe(1);
    expect(similarity(['abc def'], ['xyz uvw'])).toBe(0);
  });
});
