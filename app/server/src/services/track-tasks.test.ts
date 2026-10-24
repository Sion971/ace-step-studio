// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { buildTrackInstruction, isPureBaseModel, isTrackTask, validateTrackTask } from './track-tasks.js';

describe('track tasks', () => {
  it('builds the engine instruction from the chosen track', () => {
    expect(buildTrackInstruction('lego', 'guitar')).toBe('Generate the GUITAR track based on the audio context:');
    expect(buildTrackInstruction('extract', 'backing_vocals')).toBe('Extract the BACKING_VOCALS track from the audio:');
    expect(buildTrackInstruction('complete', undefined, ['drums', 'bass', 'guitar'])).toBe('Complete the input track with DRUMS | BASS | GUITAR:');
  });
  it('falls back to the engine defaults without a track', () => {
    expect(buildTrackInstruction('lego')).toBe('Generate the track based on the audio context:');
    expect(buildTrackInstruction('extract', '  ')).toBe('Extract the track from the audio:');
    expect(buildTrackInstruction('complete', undefined, [])).toBe('Complete the input track:');
  });
  it('returns nothing for the other tasks', () => {
    expect(buildTrackInstruction('cover', 'guitar')).toBe('');
    expect(isTrackTask('repaint')).toBe(false);
    expect(isTrackTask('lego')).toBe(true);
  });
  it('accepts only pure base models', () => {
    expect(isPureBaseModel('acestep-v15-base')).toBe(true);
    expect(isPureBaseModel('acestep-v15-xl-base')).toBe(true);
    expect(isPureBaseModel('acestep-v15-xl-base-bf16')).toBe(true);
    expect(isPureBaseModel('acestep-v15-xl-turbo-bf16')).toBe(false);
    expect(isPureBaseModel('acestep-v15-xl-sft')).toBe(false);
    expect(isPureBaseModel('acestep-v15-xl-merge-sft-turbo')).toBe(false);
    expect(isPureBaseModel(undefined)).toBe(false);
  });
  it('validates a request before it reaches the engine', () => {
    const ok = { taskType: 'lego', ditModel: 'acestep-v15-xl-base', sourceAudioUrl: '/a.mp3', trackName: 'guitar' };
    expect(validateTrackTask(ok)).toBeNull();
    expect(validateTrackTask({ ...ok, taskType: 'cover', ditModel: 'x-turbo' })).toBeNull();
    expect(validateTrackTask({ ...ok, ditModel: 'acestep-v15-xl-turbo' })).toMatch(/pure base model/);
    expect(validateTrackTask({ ...ok, sourceAudioUrl: undefined })).toMatch(/source audio/);
    expect(validateTrackTask({ ...ok, trackName: '' })).toMatch(/track name/);
    expect(validateTrackTask({ ...ok, taskType: 'complete', completeTrackClasses: [] })).toMatch(/at least one track/);
    expect(validateTrackTask({ ...ok, taskType: 'complete', completeTrackClasses: ['drums'] })).toBeNull();
  });
});
