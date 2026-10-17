// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { en } from './en';
import { fr } from './fr';
import { ja } from './ja';
import { ko } from './ko';
import { ru } from './ru';
import { zh } from './zh';

// t() returns the key itself when it is missing: a forgotten translation would show "aiCover.useToggle" on screen.
const languages: Record<string, Record<string, string>> = { en, fr, ja, ko, ru, zh };
const KEYS = [
  'aiCover.sectionTitle', 'aiCover.useToggle', 'aiCover.useToggleHint', 'aiCover.unavailableCpu', 'aiCover.unavailable',
  'coverRegen.errUnavailable', 'coverRegen.errFailed', 'coverRegen.localHint',
];
const GONE_WITH_POLLINATIONS = [
  'pollinations.sectionTitle', 'pollinations.useToggle', 'pollinations.apiKey', 'pollinations.modelPicker.search',
  'coverRegen.model', 'coverRegen.modelsPick', 'coverRegen.noKeyHint', 'coverRegen.errPaymentRequired', 'coverRegen.errPickModel',
];

describe('AI cover keys', () => {
  for (const [name, table] of Object.entries(languages)) {
    it(`${name} has all of them, filled in, without a marker`, () => {
      for (const key of KEYS) {
        expect(table[key], `${name}.${key}`).toBeTruthy();
        expect(table[key]).not.toContain('{{');
      }
    });
    it(`${name} no longer carries the Pollinations texts`, () => {
      for (const key of GONE_WITH_POLLINATIONS) expect(table[key], `${name}.${key}`).toBeUndefined();
      expect(Object.keys(table).filter((k) => k.startsWith('pollinations.'))).toEqual([]);
    });
  }
  it('translates the texts (not the English copied over)', () => {
    for (const name of ['fr', 'ja', 'ko', 'ru', 'zh']) {
      for (const key of KEYS) expect(languages[name][key], `${name}.${key}`).not.toBe(en[key as keyof typeof en]);
    }
  });
});
