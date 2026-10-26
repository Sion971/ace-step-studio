// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeAudio, parseAnalysis, withWhisperLyrics } from './audio-analysis.js';
import { parseWhisperJson } from './whisper.js';

const answer = ['<|audio_code_1|>', 'ok', 'dreamy synth pop', '[Verse]\nla', 96, 187.4, 'A minor', 'fr', '4', true];

describe('parseAnalysis', () => {
  it('reads the engine\'s ten values', () => {
    expect(parseAnalysis(answer)).toEqual({
      available: true, status: 'ok', caption: 'dreamy synth pop', lyrics: '[Verse]\nla', bpm: 96, duration: 187.4,
      keyScale: 'A minor', language: 'fr', timeSignature: '4',
    });
  });
  it('treats N/A, empty and missing values as nothing', () => {
    const a = parseAnalysis(['c', 'st', '', '', null, null, 'N/A', 'N/A', '', false]);
    expect(a).toMatchObject({ available: false, bpm: null, duration: null, keyScale: '', language: '', timeSignature: '', status: 'st' });
  });
  it('does not fail on a strange answer', () => {
    expect(parseAnalysis(undefined).available).toBe(false);
    expect(parseAnalysis('x').available).toBe(false);
  });
  it('turns a text BPM into a whole number', () => {
    expect(parseAnalysis(['c', 's', '', '', '120.4', null, '', '', '', false]).bpm).toBe(120);
  });
});

describe('analyzeAudio', () => {
  it('sends the prepared file to the analyze event, with the debug flag off', async () => {
    const predict = vi.fn(async () => ({ data: answer }));
    const prepareFile = vi.fn(async () => ({ path: '/tmp/a.mp3' }));
    const a = await analyzeAudio('/audio/a.mp3', { prepareFile, predict });
    expect(prepareFile).toHaveBeenCalledWith('/audio/a.mp3');
    expect(predict).toHaveBeenCalledWith('/analyze_src_audio', [{ path: '/tmp/a.mp3' }, false]);
    expect(a.bpm).toBe(96);
  });
  it('fails clearly when the file is missing', async () => {
    await expect(analyzeAudio('/x.mp3', { prepareFile: async () => null, predict: vi.fn() })).rejects.toThrow('not found');
  });
});

describe('parseWhisperJson', () => {
  beforeEach(() => { vi.stubEnv('WHISPER_SECTIONS', '1'); });
  afterEach(() => { vi.unstubAllEnvs(); });
  it('makes one line per phrase and keeps the language', () => {
    expect(parseWhisperJson(JSON.stringify({ text: ' a b', language: 'fr', segments: [{ text: ' Dieu est Esprit ' }, { text: '' }, { text: 'Gloire' }] })))
      .toEqual({ text: 'Dieu est Esprit\nGloire', language: 'fr' });
  });
  it('groups the phrases into sections from the pauses and the repetitions, keeping Whisper\'s words', () => {
    const seg = (start: number, text: string) => ({ start, end: start + 3, text });
    const raw = JSON.stringify({ language: 'fr', segments: [seg(0, ' Dieu est esprit'), seg(3, ' il faut'), seg(9, ' Gloire a Dieu'), seg(12, ' toujours'), seg(18, ' Christ est venu'), seg(21, ' pour tous'), seg(27, ' Gloire a Dieu'), seg(30, ' toujours')] });
    expect(parseWhisperJson(raw)?.text).toBe('[Verse 1]\nDieu est esprit\nil faut\n\n[Chorus]\nGloire a Dieu\ntoujours\n\n[Verse 2]\nChrist est venu\npour tous\n\n[Chorus]\nGloire a Dieu\ntoujours');
  });
  it('uses the times of the words when there are some (the segments touch each other and hide the pauses)', () => {
    const raw = JSON.stringify({ language: 'fr', segments: [
      { start: 0, end: 20, text: ' Dieu est esprit il faut', words: [{ word: ' Dieu', start: 0, end: 0.4 }, { word: ' est', start: 0.5, end: 0.7 }, { word: ' esprit', start: 0.8, end: 1.2 }, { word: ' il', start: 6, end: 6.2 }, { word: ' faut', start: 6.3, end: 6.6 }] },
    ] });
    expect(parseWhisperJson(raw)?.text).toBe('[Verse 1]\nDieu est esprit\n\n[Verse 2]\nil faut');
  });
  it('falls back on the whole text, and gives up on garbage', () => {
    expect(parseWhisperJson('{"text":" salut ","language":"fr"}')).toEqual({ text: 'salut', language: 'fr' });
    expect(parseWhisperJson('not json')).toBeNull();
  });
});

describe('parseWhisperJson without the section tags (default)', () => {
  it('leaves the words and the blank lines between stanzas, no tags', () => {
    const w = (word: string, start: number, end: number) => ({ word: ` ${word}`, start, end });
    const raw = JSON.stringify({ language: 'fr', segments: [{ start: 0, end: 20, text: 'x', words: [w('Dieu', 0, 0.4), w('est', 0.5, 0.7), w('esprit', 0.8, 1.2), w('il', 6, 6.2), w('faut', 6.3, 6.6)] }] });
    expect(parseWhisperJson(raw)?.text).toBe('Dieu est esprit\n\nil faut');
  });
});

describe('withWhisperLyrics', () => {
  const model = parseAnalysis(answer);
  const audio = async () => ({ buffer: Buffer.from('x'), name: 'a.mp3' });

  it('replaces the model\'s lyrics and language with Whisper\'s', async () => {
    const a = await withWhisperLyrics(model, { readAudio: audio, transcribe: async () => ({ text: 'Dieu est Esprit', language: 'fr' }) });
    expect(a).toMatchObject({ lyrics: 'Dieu est Esprit', language: 'fr', lyricsSource: 'whisper', bpm: 96, caption: 'dreamy synth pop' });
  });
  it('an empty transcription means no words: no invented lyrics', async () => {
    const a = await withWhisperLyrics(model, { readAudio: audio, transcribe: async () => ({ text: '', language: 'en' }) });
    expect(a.lyrics).toBe('');
    expect(a.lyricsSource).toBe('whisper');
  });
  it('keeps the model\'s estimate, marked as such, when Whisper is missing, fails or the file cannot be read', async () => {
    for (const deps of [
      { readAudio: audio, transcribe: async () => null },
      { readAudio: async () => null, transcribe: async () => ({ text: 'x', language: 'fr' }) },
      { readAudio: audio, transcribe: async () => { throw new Error('boom'); } },
    ]) {
      const a = await withWhisperLyrics(model, deps);
      expect(a).toMatchObject({ lyrics: '[Verse]\nla', language: 'fr', lyricsSource: 'model' });
    }
  });
});
