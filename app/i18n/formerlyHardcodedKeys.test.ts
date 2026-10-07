// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { en } from './en';
import { fr } from './fr';
import { ja } from './ja';
import { ko } from './ko';
import { ru } from './ru';
import { zh } from './zh';

// Texts that were written in French directly in the components (audio modes, loudness normalization, stem separation, MIDI, sidebar
// states, video errors, training errors) and so were shown as such in every language. Each is now a key, in the six files.
// Several carry a {{marker}} for a value (a status, an address, a duration): every language must keep the SAME markers, or a value
// silently disappears from the message.
const KEYS = [
  'audioModeCover',
  'audioModeInspiration',
  'audioModeMashup',
  'audioModeSample',
  'audioModeRepaint',
  'audioModeRepaintShort',
  'audioModeExtend',
  'audioModeCrop',
  'audioModeReverse',
  'audioModeSpeed',
  'audioModeCoverDesc',
  'audioModeInspirationDesc',
  'audioModeMashupDesc',
  'audioModeSampleDesc',
  'audioModeRepaintDesc',
  'audioModeExtendDesc',
  'audioModeCropDesc',
  'audioModeReverseDesc',
  'audioModeSpeedDesc',
  'networkError',
  'loudnessTitle',
  'loudnessPlatform',
  'loudnessCustom',
  'loudnessNormalize',
  'loudnessProcessing',
  'loudnessResult',
  'loudnessNormalized',
  'loudnessDownload',
  'loudnessFailed',
  'downloadNormalized',
  'midiConverting',
  'midiConversionError',
  'midiDownload',
  'midiFailed',
  'stemsCount',
  'stems4',
  'stems4Hint',
  'stems6',
  'stems6Hint',
  'stemsSeparate',
  'stemsSeparating',
  'stemsResult',
  'stemsOpenAll',
  'stemsPlayAll',
  'stemsUnmute',
  'stemsMute',
  'stemsToMidi',
  'stemsSeparationFailed',
  'stateBackendStopped',
  'stateModelUnloading',
  'stateServiceReady',
  'stateGradioStarting',
  'noLocalLm',
  'videoNoAudioUrl',
  'videoAudioHttpFailed',
  'videoAudioStalled',
  'videoAudioEmpty',
  'videoSessionFailed',
  'videoFramesFailed',
  'lossCurve',
  'trainStartFailed',
  'trainStopFailed',
  'trainRestartFailed'
] as const;

// Genuine terms, identical in every language, and words that are the same in French and in English.
const SAME_IN_ALL = ['audioModeCover', 'audioModeInspiration', 'audioModeMashup', 'audioModeSample'];
const SAME_AS_ENGLISH: Record<string, readonly string[]> = { fr: ['audioModeRepaintShort'] };

const languages: Record<string, Record<string, string>> = { en, fr, ja, ko, ru, zh };
const markers = (s: string) => (s.match(/\{\{\w+\}\}/g) ?? []).sort().join(',');

describe('texts that used to be written in French in the components', () => {
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
      const copies = KEYS.filter(
        (k) => languages[name][k] === en[k as keyof typeof en] && !SAME_IN_ALL.includes(k) && !(SAME_AS_ENGLISH[name] ?? []).includes(k),
      );
      expect(copies, `${name} copies the English text`).toEqual([]);
    }
  });

  it('French keeps its accents', () => {
    for (const key of ['audioModeRepaintDesc', 'loudnessCustom', 'stemsSeparate', 'stateBackendStopped', 'networkError']) {
      expect(fr[key as keyof typeof fr], key).toMatch(/[éèêàùô]/i);
    }
  });

  it('only uses markers that the callers fill in', () => {
    const known = new Set(['status', 'url', 'seconds', 'count', 'lufs']);
    for (const key of KEYS) {
      for (const marker of en[key as keyof typeof en].match(/\{\{(\w+)\}\}/g) ?? []) expect(known.has(marker.slice(2, -2)), `${key}: ${marker}`).toBe(true);
    }
  });
});
