// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { describeGenerationArgs } from './generation-log.js';

describe('describeGenerationArgs', () => {
  it('shows the language, the length, the tempo and how many lines are sung (tags do not count)', () => {
    const line = describeGenerationArgs({
      vocal_language: 'fr', audio_duration: 225, bpm: 90, lyrics: '[Verse 1]\nUne ligne\n\nUne autre\n[Chorus]\n(echo)', task_type: 'text2music', inference_steps: 8, batch_size_input: 1,
    });
    expect(line).toBe('[Generate] vocal_language=fr, duration=225 s, bpm=90, lyrics=3 lines, task=text2music, steps=8');
  });

  it('says so when the length is left to the engine or the language is empty', () => {
    const line = describeGenerationArgs({ vocal_language: '', audio_duration: -1, bpm: 0, lyrics: '', task_type: 'text2music', batch_size_input: 4 });
    expect(line).toContain('vocal_language=(empty)');
    expect(line).toContain('duration=auto (engine decides)');
    expect(line).toContain('bpm=auto');
    expect(line).toContain('lyrics=0 lines');
    expect(line).toContain('batch=4');
  });

  it('does not fail on missing or odd values', () => {
    expect(() => describeGenerationArgs({})).not.toThrow();
    expect(describeGenerationArgs({ audio_duration: 'x', lyrics: 5 })).toContain('lyrics=0 lines');
  });
});
