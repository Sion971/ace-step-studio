// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { en } from './en';
import { fr } from './fr';
import { ja } from './ja';
import { ko } from './ko';
import { ru } from './ru';
import { zh } from './zh';

// Keys that components used (t('...')) while the English file, which defines the type of every key, did not have them: the type
// checker flagged them once React was typed, and users of five languages saw the raw identifier instead of a label (t() returns the
// key itself when it is missing). Every key added to fix that is listed here, so that none can silently disappear from a language.
// The list grows as the type cleanup proceeds.
const ADDED_BY_THE_TYPE_CLEANUP = [
  'renameWorkspace',
  'addToWorkspace',
  'allSongs',
  'basedOnAceStepUi',
  'createNewWorkspace',
  'createWorkspaceModalTitle',
  'failedToRenameWorkspace',
  'loadParametersJson',
  'modelCustom',
  'modelDownloaded',
  'modelInMemory',
  'modelLoadingBadge',
  'modelNotDownloaded',
  'modelUnloadingBadge',
  'uploads',
  'workspaceCreated',
  'workspaceNameLabel',
  'dragToReframe',
  'reframeBanner',
  'videoBgFailed',
  'downloadingModelNamed',
  'loadingModelNamed',
] as const;

// Their text contains the name of the model: a translation that dropped the marker would show a blank where it belongs.
const WITH_NAME_MARKER = ['downloadingModelNamed', 'loadingModelNamed'] as const;

const languages: Record<string, Record<string, string>> = { en, fr, ja, ko, ru, zh };

describe('keys added by the type cleanup', () => {
  for (const [name, table] of Object.entries(languages)) {
    it(`${name} has them all, none empty`, () => {
      for (const key of ADDED_BY_THE_TYPE_CLEANUP) {
        expect(typeof table[key], `${name}: ${key}`).toBe('string');
        expect(table[key].trim().length, `${name}: ${key}`).toBeGreaterThan(0);
      }
    });
  }

  it('keep the {{name}} marker in every language', () => {
    for (const [name, table] of Object.entries(languages)) {
      for (const key of WITH_NAME_MARKER) expect(table[key], `${name}: ${key}`).toContain('{{name}}');
    }
  });

  it('are not left as an untranslated copy of the English text', () => {
    for (const name of ['fr', 'ja', 'ko', 'ru', 'zh']) {
      const copies = ADDED_BY_THE_TYPE_CLEANUP.filter((k) => languages[name][k] === en[k as keyof typeof en]);
      expect(copies, `${name} copies the English text`).toEqual([]);
    }
  });
});
