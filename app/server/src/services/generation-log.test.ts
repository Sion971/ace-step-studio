// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { describeGenerationArgs } from './generation-log.js';

describe('describeGenerationArgs', () => {
  it('shows the language, the length, the tempo and how many lines are sung (tags do not count)', () => {
    const line = describeGenerationArgs({
      vocal_language: 'fr', audio_duration: 225, bpm: 90, lyrics: '[Verse 1]\nUne ligne\n\nUne autre\n[Chorus]\n(echo)', task_type: 'text2music', inference_steps: 8, batch_size_input: 1,
    });
    expect(line).toBe('[Generate] vocal_language=fr, duration=225 s, bpm=90, lyrics=3 lines, task=text2music, steps=8, key=auto');
  });

  it('shows key, guidance, shift, ADG and the seed that is really sent', () => {
    const line = describeGenerationArgs({
      task_type: 'lego', inference_steps: 50, key_scale: 'G major', guidance_scale: 7, shift: 1, use_adg: true, random_seed_checkbox: false, seed: '2900000000',
    });
    expect(line).toContain('key=G major, guidance=7, shift=1, adg=on, seed=2900000000');
    expect(describeGenerationArgs({ random_seed_checkbox: true, seed: '-1' })).toContain('seed=random');
  });

  it('shows the region of a Lego or Repaint (end = whole audio when -1)', () => {
    expect(describeGenerationArgs({ task_type: 'lego', repainting_start: 0, repainting_end: -1 })).toContain('region=0-end');
    expect(describeGenerationArgs({ task_type: 'repaint', repainting_start: 2.5, repainting_end: 10 })).toContain('region=2.5-10');
    expect(describeGenerationArgs({ task_type: 'text2music', repainting_start: 0, repainting_end: -1 })).not.toContain('region=');
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
