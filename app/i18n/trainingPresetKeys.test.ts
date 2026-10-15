// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { en } from './en';
import { fr } from './fr';
import { ja } from './ja';
import { ko } from './ko';
import { ru } from './ru';
import { zh } from './zh';
import { TRAINING_PRESETS } from '../services/training-presets';

// The preset selector and the four options added to the training tab. t() returns the key itself when it is missing, so a forgotten
// translation would show a raw identifier ("trainingPresetVram8") instead of falling back to the French text in the code.
const KEYS = [
  'trainingPreset', 'trainingPresetStudio', 'trainingPresetVram8', 'trainingPresetVram12', 'trainingPresetVram16', 'trainingPresetVram24',
  'trainingPresetQuick', 'trainingPresetHighQuality', 'trainingPresetModified', 'trainingPresetDetected', 'trainingPresetHint',
  'cfgRatio', 'trainingSchedulerType', 'warmupSteps', 'attentionType',
] as const;

const languages: Record<string, Record<string, string>> = { en, fr, ja, ko, ru, zh };

describe('keys of the training presets', () => {
  for (const [name, table] of Object.entries(languages)) {
    it(`${name} has them all, none empty`, () => {
      for (const key of KEYS) {
        expect(typeof table[key], `${name}: ${key}`).toBe('string');
        expect(table[key].trim().length, `${name}: ${key}`).toBeGreaterThan(0);
      }
    });
  }

  it('only the detected-memory text carries a marker, and it is {{vram}} everywhere', () => {
    for (const [name, table] of Object.entries(languages)) {
      for (const key of KEYS) {
        const markers = table[key].match(/\{\{\w+\}\}/g) ?? [];
        expect(markers, `${name}: ${key}`).toEqual(key === 'trainingPresetDetected' ? ['{{vram}}'] : []);
      }
    }
  });

  it('are not left as an untranslated copy of the English text', () => {
    for (const name of ['fr', 'ja', 'ko', 'ru', 'zh']) {
      const copies = KEYS.filter((k) => languages[name][k] === en[k as keyof typeof en]);
      expect(copies, `${name} copies the English text`).toEqual([]);
    }
  });

  it('cover the label of every preset', () => {
    for (const preset of TRAINING_PRESETS) {
      for (const [name, table] of Object.entries(languages)) expect(table[preset.labelKey], `${name}: ${preset.labelKey}`).toBeTruthy();
    }
  });
});
