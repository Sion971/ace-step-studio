import { describe, it, expect } from 'vitest';
import { buildGenerate, buildFormat, DEFAULT_GENERATE_PROMPT, DEFAULT_FORMAT_PROMPT } from './prompts';
import type { SongDraftInput, FormatInput } from './types';

describe('DEFAULT_GENERATE_PROMPT', () => {
  it('is a non-empty string from the bundled markdown', () => {
    expect(typeof DEFAULT_GENERATE_PROMPT).toBe('string');
    expect(DEFAULT_GENERATE_PROMPT.length).toBeGreaterThan(1000);
  });

  it('contains ACE-Step XL agent role and OUTPUT FORMAT section', () => {
    expect(DEFAULT_GENERATE_PROMPT).toMatch(/ROLE/);
    expect(DEFAULT_GENERATE_PROMPT).toMatch(/OUTPUT FORMAT/);
  });
});

describe('DEFAULT_FORMAT_PROMPT', () => {
  it('is a non-empty string from the bundled format markdown', () => {
    expect(typeof DEFAULT_FORMAT_PROMPT).toBe('string');
    expect(DEFAULT_FORMAT_PROMPT.length).toBeGreaterThan(1000);
  });

  it('contains REFINE-mode language', () => {
    expect(DEFAULT_FORMAT_PROMPT).toMatch(/REFINE mode/);
  });
});

describe('buildGenerate', () => {
  const input: SongDraftInput = {
    topic: 'dnb about november',
    primary: 'lyrics',
    language: 'ru',
    instrumental: false,
  };

  it('returns 2 messages: system + user', () => {
    const msgs = buildGenerate(input);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('system');
    expect(msgs[1].role).toBe('user');
  });

  it('uses DEFAULT_GENERATE_PROMPT as system when no override', () => {
    const msgs = buildGenerate(input);
    expect(msgs[0].content).toBe(DEFAULT_GENERATE_PROMPT);
  });

  it('uses systemOverride when provided', () => {
    const msgs = buildGenerate(input, 'CUSTOM SYS');
    expect(msgs[0].content).toBe('CUSTOM SYS');
  });

  it('falls back to default when systemOverride is empty string', () => {
    const msgs = buildGenerate(input, '');
    expect(msgs[0].content).toBe(DEFAULT_GENERATE_PROMPT);
  });

  it('falls back to default when systemOverride is whitespace-only', () => {
    const msgs = buildGenerate(input, '   \n  ');
    expect(msgs[0].content).toBe(DEFAULT_GENERATE_PROMPT);
  });

  it('user message contains topic, primary, language, instrumental', () => {
    const msgs = buildGenerate(input);
    expect(msgs[1].content).toContain('topic: dnb about november');
    expect(msgs[1].content).toContain('primary: lyrics');
    expect(msgs[1].content).toContain('language: ru');
    expect(msgs[1].content).toContain('instrumental: false');
  });

  it('user message includes durationSec hint when provided', () => {
    const msgs = buildGenerate({ ...input, durationSec: 120 });
    expect(msgs[1].content).toContain('durationSec hint: 120');
  });

  it('user message omits durationSec hint when not provided', () => {
    const msgs = buildGenerate(input);
    expect(msgs[1].content).not.toContain('durationSec hint');
  });
});

describe('buildFormat', () => {
  const input: FormatInput = {
    caption: 'rock, drums',
    lyrics: '[Verse]\nhi',
    bpm: 120,
    durationSec: 90,
    keyScale: 'C major',
    timeSignature: '4/4',
    language: 'en',
    instrumental: false,
    primary: 'caption',
  };

  it('returns 2 messages: system + user', () => {
    const msgs = buildFormat(input);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('system');
    expect(msgs[1].role).toBe('user');
  });

  it('uses DEFAULT_FORMAT_PROMPT as system when no override', () => {
    const msgs = buildFormat(input);
    expect(msgs[0].content).toBe(DEFAULT_FORMAT_PROMPT);
  });

  it('uses systemOverride when provided non-empty', () => {
    const msgs = buildFormat(input, 'CUSTOM REFINE');
    expect(msgs[0].content).toBe('CUSTOM REFINE');
  });

  it('falls back to default when override is empty', () => {
    const msgs = buildFormat(input, '');
    expect(msgs[0].content).toBe(DEFAULT_FORMAT_PROMPT);
  });

  it('user message embeds the existing draft as pretty JSON', () => {
    const msgs = buildFormat(input);
    expect(msgs[1].content).toContain('"caption": "rock, drums"');
    expect(msgs[1].content).toContain('"primary": "caption"');
    expect(msgs[1].content).toContain('"language": "en"');
    expect(msgs[1].content).toContain('"bpm": 120');
  });

  it('user message JSON includes only provided fields (omits undefined)', () => {
    const minimal: FormatInput = {
      caption: 'rock', lyrics: '', language: 'en', instrumental: false, primary: 'lyrics',
    };
    const msgs = buildFormat(minimal);
    expect(msgs[1].content).not.toContain('"bpm"');
    expect(msgs[1].content).not.toContain('"keyScale"');
  });
});
