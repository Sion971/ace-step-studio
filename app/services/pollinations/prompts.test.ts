import { describe, it, expect } from 'vitest';
import { buildCoverPrompt } from './prompts';

describe('buildCoverPrompt', () => {
  it('includes album cover framing', () => {
    const out = buildCoverPrompt({ title: 'X', caption: '', topic: '', language: 'en', instrumental: false });
    expect(out).toMatch(/square music album cover/i);
    expect(out).toMatch(/high quality/i);
    expect(out).toMatch(/no text/i);
  });

  it('deliberately omits the title — zimage/enhance routinely render it as on-image text', () => {
    const out = buildCoverPrompt({ title: 'Звёздная пыль', caption: '', topic: '', language: 'ru', instrumental: false });
    expect(out).not.toContain('Звёздная пыль');
    expect(out).not.toMatch(/titled/i);
  });

  it('includes caption when present', () => {
    const out = buildCoverPrompt({ title: 'Y', caption: 'synthwave, 80s, neon', topic: '', language: 'en', instrumental: false });
    expect(out).toContain('genre and mood: synthwave, 80s, neon');
  });

  it('includes topic when present', () => {
    const out = buildCoverPrompt({ title: 'Y', caption: '', topic: 'cyberpunk skyline', language: 'en', instrumental: false });
    expect(out).toContain('inspired by: cyberpunk skyline');
  });

  it('adds instrumental hint', () => {
    const out = buildCoverPrompt({ title: 'Y', caption: '', topic: '', language: 'en', instrumental: true });
    expect(out).toMatch(/purely instrumental/i);
  });

  it('omits empty fields cleanly (no double commas)', () => {
    const out = buildCoverPrompt({ title: '', caption: '', topic: '', language: 'en', instrumental: false });
    expect(out).not.toMatch(/, ,/);
    expect(out).not.toMatch(/^,/);
    expect(out).toMatch(/no text/i);
  });

  it('trims whitespace in caption/topic inputs', () => {
    const out = buildCoverPrompt({ title: '', caption: '  rock  ', topic: '  city skyline  ', language: 'en', instrumental: false });
    expect(out).toContain('genre and mood: rock');
    expect(out).toContain('inspired by: city skyline');
  });

  it('returns one comma-separated string', () => {
    const out = buildCoverPrompt({ title: 'A', caption: 'b', topic: 'c', language: 'en', instrumental: true });
    expect(out.split(',').length).toBeGreaterThanOrEqual(5);
    expect(out).not.toContain('\n');
  });
});
