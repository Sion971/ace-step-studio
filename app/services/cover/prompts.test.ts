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

  it('puts the caption first, then the brief', () => {
    const out = buildCoverPrompt({ ...base, caption: 'synthwave, 80s, neon', topic: 'cyberpunk skyline' });
    expect(out.startsWith('synthwave, 80s, neon, inspired by cyberpunk skyline, ')).toBe(true);
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

  it('trims and cuts what the user typed, so the style hint added by the server is not pushed out', () => {
    const out = buildCoverPrompt({ ...base, caption: '  rock  ', topic: 'x'.repeat(500) });
    expect(out.startsWith('rock, inspired by x')).toBe(true);
    expect(out.length).toBeLessThan(330);
  });

  it('has no double commas', () => {
    expect(buildCoverPrompt({ ...base, caption: ' ' })).not.toMatch(/,\s*,/);
  });
});
