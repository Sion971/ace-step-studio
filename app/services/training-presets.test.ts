// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { DEFAULT_PRESET_VALUES, TRAINING_PRESETS, presetForVram, findPreset } from './training-presets';

describe('presetForVram', () => {
  it('picks the preset of the card, with the memory torch reports', () => {
    expect(presetForVram(7.6)).toBe('vram_8gb');
    expect(presetForVram(9.9)).toBe('vram_8gb');
    expect(presetForVram(11.6)).toBe('vram_12gb');
    expect(presetForVram(15.6)).toBe('vram_16gb');
    expect(presetForVram(21.9)).toBe('vram_16gb');
    expect(presetForVram(23.5)).toBe('vram_24gb_plus');
    expect(presetForVram(80)).toBe('vram_24gb_plus');
  });

  it('chooses nothing on a CPU or without a usable figure', () => {
    expect(presetForVram(7.6, 'cpu')).toBeNull();
    expect(presetForVram(undefined)).toBeNull();
    expect(presetForVram(0)).toBeNull();
    expect(presetForVram(Number.NaN)).toBeNull();
  });
});

describe('the presets', () => {
  it('have ACE-Step\'s figures for the 8 GB card', () => {
    expect(findPreset('vram_8gb')!.values).toMatchObject({
      rank: 16, alpha: 32, gradientAccumulation: 8, optimizerType: 'adamw8bit', offloadEncoder: true, gradientCheckpointing: true, cfgRatio: 0.15,
    });
  });

  it('never turn off what keeps an 8 GB card alive when they are the "free" ones', () => {
    for (const id of ['quick_test', 'high_quality']) {
      const v = findPreset(id)!.values;
      expect(v).not.toHaveProperty('optimizerType');
      expect(v).not.toHaveProperty('offloadEncoder');
      expect(v).not.toHaveProperty('gradientCheckpointing');
    }
  });

  it('only use fields that exist, with the right types', () => {
    for (const p of TRAINING_PRESETS) {
      for (const [k, v] of Object.entries(p.values)) {
        expect(DEFAULT_PRESET_VALUES, `${p.id}: ${k}`).toHaveProperty(k);
        expect(typeof v, `${p.id}: ${k}`).toBe(typeof (DEFAULT_PRESET_VALUES as unknown as Record<string, unknown>)[k]);
      }
    }
  });

  it('use the same optimizers, schedulers and ratios the trainer accepts', () => {
    const optimizers = ['adamw', 'adamw8bit', 'adafactor', 'prodigy'];
    for (const p of TRAINING_PRESETS) {
      if (p.values.optimizerType) expect(optimizers).toContain(p.values.optimizerType);
      if (p.values.cfgRatio != null) expect(p.values.cfgRatio).toBeGreaterThanOrEqual(0);
    }
  });
});
