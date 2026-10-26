// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { bpmFromText, effectiveLanguage, lmLanguage, realLanguage, sampleToDraft } from './localDraft';

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

describe('bpmFromText', () => {
  it('reads a single tempo', () => {
    expect(bpmFromText('gospel, 120 BPM, choir')).toBe(120);
    expect(bpmFromText('rock 140bpm')).toBe(140);
    expect(bpmFromText('BPM: 100')).toBe(100);
  });
  it('takes the middle of a range, with any dash', () => {
    expect(bpmFromText('Soul gospel R&B, 90–95 BPM, soulful choir')).toBe(93);
    expect(bpmFromText('90-100 bpm')).toBe(95);
    expect(bpmFromText('90 à 100 BPM')).toBe(95);
  });
  it('ignores what is not a tempo', () => {
    expect(bpmFromText('')).toBe(0);
    expect(bpmFromText('a slow song')).toBe(0);
    expect(bpmFromText('1000 BPM')).toBe(0);
    expect(bpmFromText('10 bpm')).toBe(0);
    expect(bpmFromText('in 1990 we sang')).toBe(0);
  });
  it('keeps the low end when the range is reversed or its top is absurd', () => {
    expect(bpmFromText('100-90 BPM')).toBe(100);
    expect(bpmFromText('100-900 BPM')).toBe(100);
  });
});

describe('a tempo in the description beats the LM', () => {
  it('overrides the LM bpm', () => {
    expect(sampleToDraft({ caption: 'x', bpm: 197 }, 'Soul gospel, 90–95 BPM')!.bpm).toBe(93);
  });
  it('keeps the LM bpm when the description has none', () => {
    expect(sampleToDraft({ caption: 'x', bpm: 91 }, 'Soul gospel')!.bpm).toBe(91);
  });
});

describe('the language the LM chose', () => {
  it('is carried by the draft when it is a real language', () => {
    expect(sampleToDraft({ caption: 'x', vocalLanguage: 'fr' })!.language).toBe('fr');
    expect(sampleToDraft({ caption: 'x', vocalLanguage: 'unknown' })!.language).toBeUndefined();
    expect(sampleToDraft({ caption: 'x', vocalLanguage: '' })!.language).toBeUndefined();
  });
  it('realLanguage ignores empty and unknown', () => {
    expect(realLanguage('unknown')).toBe('');
    expect(realLanguage(undefined)).toBe('');
    expect(realLanguage(' ja ')).toBe('ja');
  });
  it('fills in an Auto language, never overrides the user', () => {
    expect(effectiveLanguage('unknown', 'fr')).toBe('fr');
    expect(effectiveLanguage('', 'fr')).toBe('fr');
    expect(effectiveLanguage('en', 'fr')).toBe('en');
    expect(effectiveLanguage('unknown', undefined)).toBe('unknown');
    expect(effectiveLanguage('unknown', 'unknown')).toBe('unknown');
  });
});
