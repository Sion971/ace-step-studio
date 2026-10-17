import { describe, it, expect } from 'vitest';
import { buildCoverPrompt } from './prompts';

const base = { title: 'X', caption: '', topic: '', language: 'en', instrumental: false };

describe('buildCoverPrompt', () => {
  it('always gives the model a mood, even with nothing else', () => {
    expect(buildCoverPrompt(base)).toBe('atmospheric, cinematic lighting, highly detailed');
  });

  it('leaves the title out — it would be drawn as lettering', () => {
    const out = buildCoverPrompt({ ...base, title: 'Звёздная пыль', caption: 'synthwave' });
    expect(out).not.toContain('Звёздная пыль');
  });

  it('puts what the user typed first, then the caption', () => {
    const out = buildCoverPrompt({ ...base, caption: 'synthwave, 80s, neon', topic: 'cyberpunk skyline' });
    expect(out.startsWith('cyberpunk skyline, synthwave, 80s, neon, ')).toBe(true);
  });

  it('does not repeat the caption when it is the brief itself', () => {
    const out = buildCoverPrompt({ ...base, caption: 'rock', topic: 'rock' });
    expect(out.match(/rock/g)).toHaveLength(1);
  });

  it('cuts the long paragraph written by the language model at a clause, not in the middle of a word', () => {
    const caption =
      'The track begins with an introspective solo piano playing arpeggiated chords, setting a melancholic mood for the clear male lead vocal sung in French. The arrangement builds into an anthemic chorus.';
    const out = buildCoverPrompt({ ...base, caption, topic: 'r&b, easy to sing, joy' });
    expect(out).toBe('r&b, easy to sing, joy, The track begins with an introspective solo piano playing arpeggiated chords, atmospheric, cinematic lighting, highly detailed');
    expect(out).not.toContain('setting');
  });

  it('cuts at a space when there is no clause to cut at', () => {
    const out = buildCoverPrompt({ ...base, caption: 'word '.repeat(60) });
    expect(out.startsWith('word word')).toBe(true);
    expect(out).not.toMatch(/wor,|wo,|w,/);
  });

  it('writes no negative clause: the model runs without guidance and would draw the words', () => {
    const out = buildCoverPrompt({ ...base, caption: 'rock', instrumental: true });
    expect(out).not.toMatch(/\bno text\b|\bno logo\b|watermark|typography/i);
  });

  it('adds a hint for instrumentals', () => {
    expect(buildCoverPrompt({ ...base, instrumental: true })).toContain('no people');
  });

  it('turns a multi-line caption (the vocal gender is appended on a new line) into one line', () => {
    const out = buildCoverPrompt({ ...base, caption: 'pop, dance\nFemale vocals' });
    expect(out).toContain('pop, dance, Female vocals');
    expect(out).not.toContain('\n');
  });

  it('trims and bounds what the user typed, so the style hint added by the server is not pushed out', () => {
    const out = buildCoverPrompt({ ...base, caption: '  rock  ', topic: 'x'.repeat(500) });
    expect(out).toContain(', rock, ');
    expect(out.length).toBeLessThan(330);
  });

  it('has no double commas', () => {
    expect(buildCoverPrompt({ ...base, caption: ' ' })).not.toMatch(/,\s*,/);
  });
});
