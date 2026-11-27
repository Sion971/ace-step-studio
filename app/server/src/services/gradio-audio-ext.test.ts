// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { gradioAudioExtension } from './gradio-audio-ext.js';

describe('gradioAudioExtension', () => {
  it('keeps the format the engine really wrote', () => {
    expect(gradioAudioExtension('/tmp/gradio/abc/key.mp3', 'mp3')).toBe('.mp3');
    expect(gradioAudioExtension('/tmp/gradio/abc/key.flac', 'mp3')).toBe('.flac');
  });

  it('names a WAV fallback .wav, not after the requested MP3', () => {
    expect(gradioAudioExtension('/tmp/gradio/abc/key.wav', 'mp3')).toBe('.wav');
    expect(gradioAudioExtension('C:/out/key_fallback_1a2b3c4d.WAV', 'mp3')).toBe('.wav');
  });

  it('falls back to the requested format for a name without a known extension', () => {
    expect(gradioAudioExtension('', 'mp3')).toBe('.mp3');
    expect(gradioAudioExtension('/tmp/gradio/blob', 'flac')).toBe('.flac');
    expect(gradioAudioExtension('/tmp/file.bin', 'mp3')).toBe('.mp3');
  });

  it('ignores a query string', () => {
    expect(gradioAudioExtension('/file=/tmp/key.wav?download=1', 'mp3')).toBe('.wav');
  });
});
