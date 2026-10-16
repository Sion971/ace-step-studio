// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { en } from './en';
import { fr } from './fr';
import { ja } from './ja';
import { ko } from './ko';
import { ru } from './ru';
import { zh } from './zh';

// t() returns the key itself when it is missing: a forgotten translation would show "masteringWarmth" on screen.
const languages: Record<string, Record<string, string>> = { en, fr, ja, ko, ru, zh };
const KEYS = [
  'masteringSection', 'masteringPresetOff', 'masteringPresetLight', 'masteringPresetWarm', 'masteringPresetBright', 'masteringPresetPunch',
  'masteringCustom', 'masteringHarmonics', 'masteringWarmth', 'masteringTone', 'masteringGlue', 'masteringWidth', 'masteringHint', 'loudnessDownloadMastered',
];

describe('mastering keys', () => {
  for (const [name, table] of Object.entries(languages)) {
    it(`${name} has all of them, filled in, without a marker`, () => {
      for (const key of KEYS) {
        expect(typeof table[key], key).toBe('string');
        expect(table[key].trim().length, key).toBeGreaterThan(0);
        expect(table[key], key).not.toMatch(/\{\{/);
      }
    });
  }

  it('are translated, not copies of the English text', () => {
    for (const name of ['fr', 'ja', 'ko', 'ru', 'zh']) {
      for (const key of KEYS) expect(languages[name][key], `${name}.${key}`).not.toBe(en[key as keyof typeof en]);
    }
  });
});
