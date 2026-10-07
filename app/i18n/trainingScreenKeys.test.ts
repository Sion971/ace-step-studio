// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { en } from './en';
import { fr } from './fr';
import { ja } from './ja';
import { ko } from './ko';
import { ru } from './ru';
import { zh } from './zh';

// The LoRA panel and the training screens receive `t` as a prop typed (key: string) => string, so TypeScript could not tell that 40 of
// their keys were missing: users of five languages saw raw identifiers ("optimizer", "gradientCheckpointing", "restartPipeline"), and the
// code's French fallback (t('key') || 'texte') never ran, because t() returns the key itself when it is missing. They are now in the six
// files. Four keys that the code glued behind a number ("3 fichiers envoyés") became templates with a {{count}} marker, so that each
// language places the number where its grammar needs it, without a plural form (Russian says "3 файла", not "3 файлов").
const KEYS = [
  'quantizationAutoUnloadedLora',
  'quantizationBlocksLora',
  'quantizationToggleHint',
  'quantizationToggleLabel',
  'useLora',
  'uploadingFiles',
  'loadingForPreprocess',
  'datasetFilesUploaded',
  'datasetSamplesLoaded',
  'datasetUploadAndCreate',
  'transcribeLyrics',
  'savePath',
  'outputDir',
  'exporting',
  'exportPath',
  'loraOutputDir',
  'failed',
  'useGradioUiToInit',
  'lmModel',
  'lmModelPath',
  'load',
  'baseModel',
  'modelVariant',
  'checkpointDir',
  'adapterType',
  'rankHint',
  'memorySettings',
  'optimizer',
  'precision',
  'gradientCheckpointing',
  'offloadEncoder',
  'freeVram',
  'freeVramHint',
  'resumeCheckpoint',
  'restartPipeline',
  'elapsed',
  'copyPath',
  'trainingLoss',
  'waitingForMetrics'
] as const;

// A technical term, written the same in every language.
const SAME_IN_ALL = ['gradientCheckpointing'];

const languages: Record<string, Record<string, string>> = { en, fr, ja, ko, ru, zh };
const markers = (s: string) => (s.match(/\{\{\w+\}\}/g) ?? []).sort().join(',');

describe('keys of the LoRA panel and the training screens', () => {
  for (const [name, table] of Object.entries(languages)) {
    it(`${name} has them all, none empty`, () => {
      for (const key of KEYS) {
        expect(typeof table[key], `${name}: ${key}`).toBe('string');
        expect(table[key].trim().length, `${name}: ${key}`).toBeGreaterThan(0);
      }
    });

    it(`${name} keeps the same {{markers}} as English`, () => {
      for (const key of KEYS) expect(markers(table[key]), `${name}: ${key}`).toBe(markers(en[key as keyof typeof en]));
    });
  }

  it('are not left as an untranslated copy of the English text', () => {
    for (const name of ['fr', 'ja', 'ko', 'ru', 'zh']) {
      const copies = KEYS.filter((k) => languages[name][k] === en[k as keyof typeof en] && !SAME_IN_ALL.includes(k));
      expect(copies, `${name} copies the English text`).toEqual([]);
    }
  });

  const TEMPLATES = ['datasetFilesUploaded', 'datasetSamplesLoaded', 'datasetUploadAndCreate'] as const;

  it('the count templates carry {{count}} in every language', () => {
    for (const key of TEMPLATES) {
      for (const [name, table] of Object.entries(languages)) expect(table[key], `${name}: ${key}`).toContain('{{count}}');
    }
  });

  it('no other key carries a marker, so none is left waiting for a value that nobody fills in', () => {
    for (const key of KEYS.filter((k) => !(TEMPLATES as readonly string[]).includes(k))) expect(markers(en[key as keyof typeof en]), key).toBe('');
  });
});
