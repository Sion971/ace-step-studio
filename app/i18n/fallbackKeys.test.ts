// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { en } from './en';
import { fr } from './fr';
import { ja } from './ja';
import { ko } from './ko';
import { ru } from './ru';
import { zh } from './zh';

// Components ask for some labels with tf('key', 'fallback'): the helper shows the fallback when the key is missing from the language file.
// Those keys were defined in NO language file, so the fallback (written in French, often without accents) was shown to EVERYONE, English
// speakers included: "Rien à envoyer au moteur : active OpenRouter pour développer la description, ou remplis Style ou Paroles."
// Neither TypeScript (tf accepts any string, by design) nor usedKeys.test.ts (which reads t('...') only) could see it.
// Every key below is now in the six files; and the scan at the bottom fails if a component asks tf() for a key the English file lacks.
const KEYS = [
  'addAudio',
  'coverNoiseStrength',
  'dcwTurboOnlyNotice',
  'end',
  'errNothingToGenerate',
  'generationSeed',
  'hintCoverNoiseRef',
  'hintCoverNoiseStrength',
  'hintInstructionEmpty',
  'hintPreflightActive',
  'hintPreflightImpossible',
  'hintPreflightLyricsOnly',
  'hintPreflightNoOr',
  'hintPreflightSkipped',
  'hintRepaintStrength',
  'hintRetake',
  'micPermissionDenied',
  'micUnavailable',
  'modification',
  'recordAgain',
  'recordSong',
  'recordSongDescription',
  'recordSongTitle',
  'recordingDescriptionPlaceholder',
  'recordingInProgress',
  'recordingSaveFailed',
  'recordingTitlePlaceholder',
  'recordingUploadFailed',
  'remix',
  'rerollSeed',
  'saveRecording',
  'soon',
  'warnCoverNoSource',
  'warnInstructionStale',
  'warnPreflightFailed',
  'warnRetakeSeedRandom',
  'warnRetakeVariance',
  'warnSeedBulk',
  'warnSeedMinusOne'
] as const;

const languages: Record<string, Record<string, string>> = { en, fr, ja, ko, ru, zh };

describe('keys requested through tf(key, fallback)', () => {
  for (const [name, table] of Object.entries(languages)) {
    it(`${name} has them all, none empty`, () => {
      for (const key of KEYS) {
        expect(typeof table[key], `${name}: ${key}`).toBe('string');
        expect(table[key].trim().length, `${name}: ${key}`).toBeGreaterThan(0);
      }
    });
  }

  it('are not left as an untranslated copy of the English text', () => {
    for (const name of ['fr', 'ja', 'ko', 'ru', 'zh']) {
      const copies = KEYS.filter((k) => languages[name][k] === en[k as keyof typeof en]);
      expect(copies, `${name} copies the English text`).toEqual([]);
    }
  });

  it('French keeps its accents (the fallbacks in the code were written without them)', () => {
    // (these keys are the ones this patch added to fr.ts; the few that fr.ts already had are the author's own text and are left untouched)
    for (const key of ['micPermissionDenied', 'recordingSaveFailed', 'recordingUploadFailed', 'dcwTurboOnlyNotice', 'coverNoiseStrength']) {
      expect(fr[key as keyof typeof fr], key).toMatch(/[éèêàùô]/i);
    }
  });
});

describe('every tf() key used by a component exists in the English file', () => {
  const APP_DIR = path.resolve(__dirname, '..');
  const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'i18n', 'server', 'docs', 'audiomass-editor', 'data']);
  const sourceFiles = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return SKIPPED_DIRS.has(entry.name) ? [] : sourceFiles(full);
      return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
    });

  const used = new Map<string, Set<string>>();
  for (const file of sourceFiles(APP_DIR)) {
    for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue; // a comment that shows an example is not a call
      for (const match of line.matchAll(/(?<![A-Za-z0-9_$.])tf\(\s*'([A-Za-z0-9_.]+)'\s*,/g)) {
        const where = used.get(match[1]) ?? new Set<string>();
        where.add(path.relative(APP_DIR, file));
        used.set(match[1], where);
      }
    }
  }

  it('finds the calls it is meant to check', () => {
    expect(used.size).toBeGreaterThan(100); // guards the scan itself against silently matching nothing
    expect(used.has('errNothingToGenerate')).toBe(true);
  });

  it('none is missing', () => {
    const missing = [...used.entries()].filter(([key]) => !(key in en)).map(([key, files]) => `${key}  (${[...files].join(', ')})`);
    expect(missing, 'asked through tf() by a component, defined nowhere in en.ts: the fallback is shown to everyone').toEqual([]);
  });
});
