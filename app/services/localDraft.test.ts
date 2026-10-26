// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { lmLanguage, sampleToDraft } from './localDraft';

describe('sampleToDraft', () => {
  it('builds the same draft shape the OpenRouter pre-flight gives', () => {
    expect(sampleToDraft({ caption: ' pop joyeux ', lyrics: '[Verse]\nla', bpm: 120, duration: 90, keyScale: 'C Major', timeSignature: '4' }))
      .toEqual({ title: '', caption: 'pop joyeux', lyrics: '[Verse]\nla', tags: [], bpm: 120, keyScale: 'C Major', timeSignature: '4', durationSec: 90, coverPrompt: '' });
  });
  it('turns missing or negative numbers into 0 (so the user-set values still win)', () => {
    const d = sampleToDraft({ caption: 'x', bpm: 0, duration: -1 })!;
    expect(d.bpm).toBe(0);
    expect(d.durationSec).toBe(0);
    expect(d.keyScale).toBe('');
  });
  it('is a failure when the LM gave neither style nor lyrics', () => {
    expect(sampleToDraft({ caption: '  ', lyrics: '' })).toBeNull();
    expect(sampleToDraft(null)).toBeNull();
    expect(sampleToDraft(undefined)).toBeNull();
  });
  it('keeps one of the two when only one came back', () => {
    expect(sampleToDraft({ lyrics: 'la la' })!.caption).toBe('');
    expect(sampleToDraft({ caption: 'rock' })!.lyrics).toBe('');
  });
});

describe('lmLanguage', () => {
  it('lets the LM choose when the language is Auto', () => {
    expect(lmLanguage('unknown')).toBeUndefined();
    expect(lmLanguage('')).toBeUndefined();
    expect(lmLanguage('fr')).toBe('fr');
  });
});
