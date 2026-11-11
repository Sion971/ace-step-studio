import { describe, expect, it } from 'vitest';
import { withoutModelSettings } from './modelSettings';

const saved = { shift: 1, dcwEnabled: false, samplerMode: 'heun', schedulerType: 'cosine', dcwScaler: 0.05, bpm: 100 };

describe('withoutModelSettings', () => {
  it('never restores the shift or the DCW switch: the model sets them', () => {
    const kept = withoutModelSettings(saved, 'acestep-v15-xl-turbo-bf16');
    expect(kept).not.toHaveProperty('shift');
    expect(kept).not.toHaveProperty('dcwEnabled');
  });

  it('drops the sampler and the scheduler on a Turbo only', () => {
    expect(withoutModelSettings(saved, 'acestep-v15-xl-turbo-bf16')).not.toHaveProperty('samplerMode');
    const merge = withoutModelSettings(saved, 'acestep-v15-xl-merge-base-turbo30');
    expect(merge.samplerMode).toBe('heun');
    expect(merge.schedulerType).toBe('cosine');
  });

  it('keeps everything else and leaves the saved object untouched', () => {
    const kept = withoutModelSettings(saved, 'acestep-v15-xl-turbo-bf16');
    expect(kept.dcwScaler).toBe(0.05);
    expect(kept.bpm).toBe(100);
    expect(saved.shift).toBe(1);
  });
});
