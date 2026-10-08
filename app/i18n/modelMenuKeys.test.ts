// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { en } from './en';
import { fr } from './fr';
import { ja } from './ja';
import { ko } from './ko';
import { ru } from './ru';
import { zh } from './zh';

// The texts of the model menu that fold the models too big for the card behind a link (components/ModelMenu.tsx).
const KEYS = ['modelShowMoreVram', 'modelHideMoreVram', 'modelNeedsVram'] as const;
// What the code fills in: the number of folded models, the memory a model asks for, the memory the card has.
const FILLED = new Set(['count', 'need', 'have']);

const languages: Record<string, Record<string, string>> = { en, fr, ja, ko, ru, zh };
const markers = (s: string) => (s.match(/\{\{\w+\}\}/g) ?? []).sort().join(',');

describe('texts of the model menu', () => {
  for (const [name, table] of Object.entries(languages)) {
    it(`${name} has them all, none empty`, () => {
      for (const key of KEYS) {
        expect(typeof table[key], `${name}: ${key}`).toBe('string');
        expect(table[key].trim().length, `${name}: ${key}`).toBeGreaterThan(0);
      }
    });

    it(`${name} keeps the same {{markers}} as English`, () => {
      for (const key of KEYS) expect(markers(table[key]), `${name}: ${key}`).toBe(markers(en[key]));
    });
  }

  it('are not left as an untranslated copy of the English text', () => {
    for (const name of ['fr', 'ja', 'ko', 'ru', 'zh']) {
      expect(KEYS.filter((k) => languages[name][k] === en[k]), `${name} copies the English text`).toEqual([]);
    }
  });

  it('French addresses the user as "vous"', () => {
    const informal = KEYS.filter((k) => /(?<!\p{L})(tu|ton|ta|tes|toi)(?!\p{L})/iu.test(fr[k]));
    expect(informal).toEqual([]);
    expect(fr.modelNeedsVram).toContain('vous');
  });

  it('every marker that a text asks for is one that the code fills', () => {
    for (const key of KEYS) for (const marker of en[key].match(/\{\{(\w+)\}\}/g) ?? []) expect(FILLED.has(marker.slice(2, -2)), `${key}: ${marker}`).toBe(true);
  });

  it('the number of folded models is in the link that shows them, and both memories in the note', () => {
    expect(en.modelShowMoreVram).toContain('{{count}}');
    expect(en.modelNeedsVram).toContain('{{need}}');
    expect(en.modelNeedsVram).toContain('{{have}}');
  });
});
