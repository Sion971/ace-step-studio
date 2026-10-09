// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { en } from './en';
import { fr } from './fr';
import { ja } from './ja';
import { ko } from './ko';
import { ru } from './ru';
import { zh } from './zh';

// The text that says a language model could not be downloaded (components/CreatePanel.tsx).
const KEY = 'lmDownloadFailed';
const languages: Record<string, Record<string, string>> = { en, fr, ja, ko, ru, zh };
const markers = (s: string) => (s.match(/\{\{\w+\}\}/g) ?? []).sort().join(',');

describe('text of a failed download of a language model', () => {
  for (const [name, table] of Object.entries(languages)) {
    it(`${name} has it, not empty, with the model's name`, () => {
      expect(typeof table[KEY], name).toBe('string');
      expect(table[KEY].trim().length, name).toBeGreaterThan(0);
      expect(markers(table[KEY]), name).toBe('{{name}}');
    });
  }
  it('is translated, not left as a copy of the English text', () => {
    for (const name of ['fr', 'ja', 'ko', 'ru', 'zh']) expect(languages[name][KEY], name).not.toBe(en[KEY]);
  });
  it('French addresses the user as "vous"', () => {
    expect(/(?<!\p{L})(tu|ton|ta|tes|toi)(?!\p{L})/iu.test(fr[KEY])).toBe(false);
    expect(fr[KEY]).toContain('Vérifiez');
  });
});
