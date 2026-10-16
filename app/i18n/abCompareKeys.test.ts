// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { en } from './en';
import { fr } from './fr';
import { ja } from './ja';
import { ko } from './ko';
import { ru } from './ru';
import { zh } from './zh';

// t() returns the key itself when it is missing: a forgotten translation would show "abHint" on screen.
const languages: Record<string, Record<string, string>> = { en, fr, ja, ko, ru, zh };
const KEYS = ['abOriginal', 'abMastered', 'abPlay', 'abPause', 'abHint'];

describe('before / after listening keys', () => {
  for (const [name, table] of Object.entries(languages)) {
    it(`${name} has all of them, filled in, without a marker`, () => {
      for (const key of KEYS) {
        expect(typeof table[key], key).toBe('string');
        expect(table[key].trim().length, key).toBeGreaterThan(0);
        expect(table[key], key).not.toMatch(/\{\{/);
      }
    });
  }
});
