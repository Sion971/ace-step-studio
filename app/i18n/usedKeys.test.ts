// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { en } from './en';

// Fails when a component asks t('someKey') for a key the English file, which defines the type of every key, does not have.
// t() returns the key itself when it is missing, so users saw the raw identifier ("allSongs", "downloadingModel"...) instead of a
// label; and since a non-empty string is truthy, the `t('x') || 'fallback'` written in many places never used its fallback.
// TypeScript reports this too, but only once React is typed; this test guards it in the meantime, and after.

const APP_DIR = path.resolve(__dirname, '..');
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'i18n', 'server', 'docs', 'audiomass-editor', 'data']);

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return SKIPPED_DIRS.has(entry.name) ? [] : sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

// KNOWN GAP: empty. It used to list the 40 keys of the LoRA panel and the training screens, which do not read `t` from the translation
// context but receive it as a prop typed `(key: string) => string`, so TypeScript can never check their keys, typed React or not. All
// 40 are now translated (4 of them replaced by templates with a {{count}} marker). The ratchet stays: a NEW missing key fails the first
// test, and a key added to this list that is already in en.ts fails the second. Add a key here only while it is being translated.
const KNOWN_GAP: readonly string[] = [];

describe('translation keys used by the interface', () => {
  const used = new Map<string, string[]>();
  for (const file of sourceFiles(APP_DIR)) {
    const text = fs.readFileSync(file, 'utf-8');
    for (const match of text.matchAll(/(?<![A-Za-z0-9_$.])t\('([A-Za-z0-9_.]+)'\)/g)) {
      const where = used.get(match[1]) ?? [];
      where.push(path.relative(APP_DIR, file));
      used.set(match[1], where);
    }
  }

  it('finds the calls it is meant to check', () => {
    expect(used.size).toBeGreaterThan(200); // guards the scan itself against silently matching nothing
    expect(used.has('create')).toBe(true);
  });

  it('every key used with a literal exists in the English file, apart from the known gap', () => {
    const missing = [...used.entries()]
      .filter(([key]) => !(key in en) && !KNOWN_GAP.includes(key))
      .map(([key, files]) => `${key}  (${[...new Set(files)].join(', ')})`);
    expect(missing, 'keys used by a component but defined nowhere in en.ts').toEqual([]);
  });

  it('the known gap only lists keys that are still missing (remove a key from it once it is added)', () => {
    const repaired = KNOWN_GAP.filter((key) => key in en);
    expect(repaired, 'already in en.ts: remove them from KNOWN_GAP').toEqual([]);
    const unused = KNOWN_GAP.filter((key) => !used.has(key));
    expect(unused, 'no longer used by any component: remove them from KNOWN_GAP').toEqual([]);
  });
});
