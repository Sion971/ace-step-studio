// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { getAudioDuration, type DurationProbes } from './audio-duration.js';

const refuses = (): never => {
  throw new Error('Command failed: ffprobe');
};

function probes(over: Partial<DurationProbes>): DurationProbes {
  return { ffprobe: refuses, python: refuses, ...over };
}

describe('getAudioDuration', () => {
  it('uses ffprobe when it answers, rounded to whole seconds', () => {
    expect(getAudioDuration('a.mp3', probes({ ffprobe: () => '173.6\n' }))).toBe(174);
  });

  it('does not call Python when ffprobe answered', () => {
    let pythonCalls = 0;
    getAudioDuration('a.mp3', probes({ ffprobe: () => '10', python: () => { pythonCalls++; return '99'; } }));
    expect(pythonCalls).toBe(0);
  });

  it('falls back to Python when ffprobe cannot be run (blocked by Windows)', () => {
    expect(getAudioDuration('a.mp3', probes({ python: () => '200.04\n' }))).toBe(200);
  });

  it('falls back to Python when ffprobe prints something that is not a length', () => {
    expect(getAudioDuration('a.mp3', probes({ ffprobe: () => 'N/A\n', python: () => '30.2' }))).toBe(30);
  });

  it('answers 0 when nothing can read the file', () => {
    expect(getAudioDuration('a.mp3', probes({}))).toBe(0);
  });

  it('answers 0 when both print garbage, and never a negative or NaN length', () => {
    expect(getAudioDuration('a.mp3', probes({ ffprobe: () => '-3', python: () => 'nan' }))).toBe(0);
  });
});
