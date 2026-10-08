// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { en } from './en';
import { fr } from './fr';
import { ja } from './ja';
import { ko } from './ko';
import { ru } from './ru';
import { zh } from './zh';

// The texts that say a model could not be downloaded or loaded (components/ModelMenu.tsx).
const KEYS = ['modelSwitchFailed', 'modelDownloadFailed'] as const;
// What the code fills in: the model's name, and what the server answered.
const FILLED = new Set(['name', 'reason']);

const languages: Record<string, Record<string, string>> = { en, fr, ja, ko, ru, zh };
const markers = (s: string) => (s.match(/\{\{\w+\}\}/g) ?? []).sort().join(',');

describe('texts that say a model could not be downloaded or loaded', () => {
  for (const [name, table] of Object.entries(languages)) {
    it(`${name} has them all, none empty, with the same {{markers}} as English`, () => {
      for (const key of KEYS) {
        expect(typeof table[key], `${name}: ${key}`).toBe('string');
        expect(table[key].trim().length, `${name}: ${key}`).toBeGreaterThan(0);
        expect(markers(table[key]), `${name}: ${key}`).toBe(markers(en[key]));
      }
    });
  }

  it('are not left as an untranslated copy of the English text', () => {
    for (const name of ['fr', 'ja', 'ko', 'ru', 'zh']) expect(KEYS.filter((k) => languages[name][k] === en[k]), name).toEqual([]);
  });

  it('French addresses the user as "vous"', () => {
    expect(KEYS.filter((k) => /(?<!\p{L})(tu|ton|ta|tes|toi)(?!\p{L})/iu.test(fr[k]))).toEqual([]);
    expect(fr.modelDownloadFailed).toContain('Vérifiez');
  });

  it('every marker that a text asks for is one that the code fills, and the refusal carries the reason', () => {
    for (const key of KEYS) for (const marker of en[key].match(/\{\{(\w+)\}\}/g) ?? []) expect(FILLED.has(marker.slice(2, -2)), `${key}: ${marker}`).toBe(true);
    for (const table of Object.values(languages)) expect(table.modelSwitchFailed).toContain('{{reason}}');
  });
});
