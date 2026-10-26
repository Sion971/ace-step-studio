// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { analyzeAudio, parseAnalysis } from './audio-analysis.js';

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
