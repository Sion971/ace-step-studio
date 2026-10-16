// Mastering presets for the loudness window. The five numbers are the ones the server reads (server/src/services/mastering.ts):
// harmonics, warmth, glue and width go from 0 to 100, tone from -100 (dark) to +100 (bright).
import type { TranslationKey } from '../i18n/translations';

export interface MasteringSettings {
  harmonics: number;
  warmth: number;
  tone: number;
  glue: number;
  width: number;
}

export type MasteringPresetId = 'off' | 'light' | 'warm' | 'bright' | 'punch';

export interface MasteringPreset {
  id: MasteringPresetId;
  labelKey: TranslationKey;
  settings: MasteringSettings;
}

export const NO_MASTERING: MasteringSettings = { harmonics: 0, warmth: 0, tone: 0, glue: 0, width: 0 };

export const MASTERING_PRESETS: MasteringPreset[] = [
  { id: 'off', labelKey: 'masteringPresetOff', settings: NO_MASTERING },
  { id: 'light', labelKey: 'masteringPresetLight', settings: { harmonics: 25, warmth: 20, tone: 0, glue: 25, width: 10 } },
  { id: 'warm', labelKey: 'masteringPresetWarm', settings: { harmonics: 15, warmth: 55, tone: -30, glue: 35, width: 10 } },
  { id: 'bright', labelKey: 'masteringPresetBright', settings: { harmonics: 55, warmth: 15, tone: 40, glue: 25, width: 25 } },
  { id: 'punch', labelKey: 'masteringPresetPunch', settings: { harmonics: 35, warmth: 35, tone: 10, glue: 65, width: 15 } },
];

/** The preset these settings are exactly, or null when the user has moved a slider ("custom"). */
export function matchPreset(settings: MasteringSettings): MasteringPresetId | null {
  const found = MASTERING_PRESETS.find((p) => (Object.keys(p.settings) as (keyof MasteringSettings)[]).every((k) => p.settings[k] === settings[k]));
  return found ? found.id : null;
}

export function isMasteringOn(settings: MasteringSettings): boolean {
  return settings.harmonics >= 1 || settings.warmth >= 1 || Math.abs(settings.tone) >= 1 || settings.glue >= 1 || settings.width >= 1;
}
