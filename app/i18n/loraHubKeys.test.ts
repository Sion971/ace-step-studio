// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { en } from './en';
import { fr } from './fr';
import { ja } from './ja';
import { ko } from './ko';
import { ru } from './ru';
import { zh } from './zh';

// The texts of the LoRA catalog (components/LoraCatalogModal.tsx, services/loraHub.ts). The server sends codes and values, never sentences: every
// sentence the user reads is written here, in the user's language, with {{markers}} where a value goes (a number of GB, a model name, a date).
const KEYS = [
  'loraHubBrowse',
  'loraHubTitle',
  'loraHubClose',
  'loraHubLoading',
  'loraHubLoadFailed',
  'loraHubEmpty',
  'loraHubIgnored',
  'loraHubContextModel',
  'loraHubContextVram',
  'loraHubContextUnknown',
  'loraHubNeeds',
  'loraHubBy',
  'loraHubVerified',
  'loraHubUnverified',
  'loraHubLicense',
  'loraHubLicenseUnknown',
  'loraHubTrigger',
  'loraHubTriggerHint',
  'loraHubRecommended',
  'loraHubScale',
  'loraHubSteps',
  'loraHubGuidance',
  'loraHubShift',
  'loraHubInstall',
  'loraHubInstalled',
  'loraHubUse',
  'loraHubRetry',
  'loraHubCopy',
  'loraHubCopied',
  'loraHubDownloading',
  'loraHubVerifying',
  'loraHubInstalling',
  'loraHubProgress',
  'loraHubLinkTitle',
  'loraHubLinkHint',
  'loraHubLinkPlaceholder',
  'loraHubLinkCheck',
  'loraHubLinkChecking',
  'loraHubChooseFile',
  'loraHubAdapter',
  'loraHubNotes',
  'loraHubVerdictCompatible',
  'loraHubVerdictWarning',
  'loraHubVerdictIncompatible',
  'loraHubVerdictUnknown',
  'loraHubReasonSize',
  'loraHubReasonFamily',
  'loraHubReasonIncomplete',
  'loraHubReasonConflict',
  'loraHubReasonVram',
  'loraHubReasonRequirement',
  'loraHubReasonNoActive',
  'loraHubSrcMetadata',
  'loraHubSrcRepository',
  'loraHubSrcAdapter',
  'loraHubSrcTags',
  'loraHubErrSource',
  'loraHubErrNotFound',
  'loraHubErrForbidden',
  'loraHubErrRate',
  'loraHubErrFormat',
  'loraHubErrNotLora',
  'loraHubErrExists',
  'loraHubErrBusy',
  'loraHubErrTooBig',
  'loraHubErrChecksum',
  'loraHubErrChanged',
  'loraHubErrStalled',
  'loraHubErrNetwork',
  'loraHubErrGeneric'
] as const;

// Written the same in every language: an example of the format the Hub uses.
const SAME_IN_ALL = ['loraHubLinkPlaceholder'];
// French and English happen to write the same word.
const SAME_FR_EN = ['loraHubVerdictCompatible'];

const languages: Record<string, Record<string, string>> = { en, fr, ja, ko, ru, zh };
const markers = (s: string) => (s.match(/\{\{\w+\}\}/g) ?? []).sort().join(',');

describe('texts of the LoRA catalog', () => {
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
      const copies = KEYS.filter((k) => languages[name][k] === en[k as keyof typeof en] && !SAME_IN_ALL.includes(k) && !(name === 'fr' && SAME_FR_EN.includes(k)));
      expect(copies, `${name} copies the English text`).toEqual([]);
    }
  });

  it('French addresses the user as "vous", like the rest of fr.ts', () => {
    // \b does not know accented letters ("requêtes" would contain "tes"): the boundaries are written with Unicode letters
    const informal = KEYS.filter((k) => /(?<!\p{L})(tu|ton|ta|tes|toi)(?!\p{L})/iu.test(fr[k as keyof typeof fr]));
    expect(informal).toEqual([]);
  });

  it('does not mistake a word that merely contains "tes" for the informal address', () => {
    const informal = /(?<!\p{L})(tu|ton|ta|tes|toi)(?!\p{L})/iu;
    expect(informal.test('Hugging Face limite les requêtes.')).toBe(false);
    expect(informal.test('Mets ton prompt ici')).toBe(true);
    expect(informal.test('Saisis tes réglages')).toBe(true);
  });

  it('every marker that a text asks for is one that the code fills', () => {
    // the markers used by services/loraHub.ts and components/LoraCatalogModal.tsx
    const filled = new Set(['count', 'model', 'gb', 'author', 'date', 'license', 'value', 'done', 'total', 'rank', 'required', 'active', 'sources', 'needed']);
    for (const key of KEYS) for (const marker of (en[key as keyof typeof en].match(/\{\{(\w+)\}\}/g) ?? [])) expect(filled.has(marker.slice(2, -2)), `${key}: ${marker}`).toBe(true);
  });
});
