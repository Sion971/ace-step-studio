// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { en } from './en';
import { fr } from './fr';
import { ja } from './ja';
import { ko } from './ko';
import { ru } from './ru';
import { zh } from './zh';

// The text carries {{db}}: a translation that dropped the marker would hide the gap, and t() returns the key itself when it is missing.
const languages: Record<string, Record<string, string>> = { en, fr, ja, ko, ru, zh };

describe('abMatch key', () => {
  for (const [name, table] of Object.entries(languages)) {
    it(`${name} has it, with the {{db}} marker`, () => {
      expect(typeof table.abMatch).toBe('string');
      expect(table.abMatch).toContain('{{db}}');
    });
  }
  it('is translated, not a copy of the English text', () => {
    for (const name of ['fr', 'ja', 'ko', 'ru', 'zh']) expect(languages[name].abMatch, name).not.toBe(en.abMatch);
  });
});
