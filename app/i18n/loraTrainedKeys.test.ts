// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { en } from './en';
import { fr } from './fr';
import { ja } from './ja';
import { ko } from './ko';
import { ru } from './ru';
import { zh } from './zh';

// t() returns the key itself when it is missing: a forgotten translation would show "loraHubTrainedHere" on screen.
const KEYS = ['loraHubTrainedHere', 'loraHubEpochs', 'loraHubDataset', 'exportPathAuto'] as const;
const languages: Record<string, Record<string, string>> = { en, fr, ja, ko, ru, zh };
const markers = (s: string) => (s.match(/\{\{\w+\}\}/g) ?? []).sort().join(',');

describe('keys of the trained LoRA details and the automatic export name', () => {
  for (const [name, table] of Object.entries(languages)) {
    it(`${name} has them all, none empty, with the markers of the English text`, () => {
      for (const key of KEYS) {
        expect(typeof table[key], `${name}: ${key}`).toBe('string');
        expect(table[key].trim().length, `${name}: ${key}`).toBeGreaterThan(0);
        expect(markers(table[key]), `${name}: ${key}`).toBe(markers(en[key]));
      }
    });
  }

  it('are translated, not copies of the English text', () => {
    for (const name of ['fr', 'ja', 'ko', 'ru', 'zh']) {
      for (const key of KEYS) expect(languages[name][key], `${name}: ${key}`).not.toBe(en[key]);
    }
  });
});
