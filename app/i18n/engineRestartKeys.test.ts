// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { en } from './en';
import { fr } from './fr';
import { ja } from './ja';
import { ko } from './ko';
import { ru } from './ru';
import { zh } from './zh';

// t() returns the key itself when it is missing: a forgotten translation would show "engineRestarting" on screen.
const languages: Record<string, Record<string, string>> = { en, fr, ja, ko, ru, zh };

describe('engineRestarting key', () => {
  for (const [name, table] of Object.entries(languages)) {
    it(`${name} has it, not empty, no marker`, () => {
      expect(typeof table.engineRestarting).toBe('string');
      expect(table.engineRestarting.trim().length).toBeGreaterThan(0);
      expect(table.engineRestarting).not.toMatch(/\{\{/);
    });
  }

  it('is translated, not a copy of the English text', () => {
    for (const name of ['fr', 'ja', 'ko', 'ru', 'zh']) expect(languages[name].engineRestarting, name).not.toBe(en.engineRestarting);
  });
});
