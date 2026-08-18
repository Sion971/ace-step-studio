import React from 'react';

export const VOCAL_LANGUAGE_KEYS = [
  { value: 'unknown', key: 'autoInstrumental' as const },
  { value: 'ar', key: 'vocalArabic' as const },
  { value: 'az', key: 'vocalAzerbaijani' as const },
  { value: 'bg', key: 'vocalBulgarian' as const },
  { value: 'bn', key: 'vocalBengali' as const },
  { value: 'ca', key: 'vocalCatalan' as const },
  { value: 'cs', key: 'vocalCzech' as const },
  { value: 'da', key: 'vocalDanish' as const },
  { value: 'de', key: 'vocalGerman' as const },
  { value: 'el', key: 'vocalGreek' as const },
  { value: 'en', key: 'vocalEnglish' as const },
  { value: 'es', key: 'vocalSpanish' as const },
  { value: 'fa', key: 'vocalPersian' as const },
  { value: 'fi', key: 'vocalFinnish' as const },
  { value: 'fr', key: 'vocalFrench' as const },
  { value: 'he', key: 'vocalHebrew' as const },
  { value: 'hi', key: 'vocalHindi' as const },
  { value: 'hr', key: 'vocalCroatian' as const },
  { value: 'ht', key: 'vocalHaitianCreole' as const },
  { value: 'hu', key: 'vocalHungarian' as const },
  { value: 'id', key: 'vocalIndonesian' as const },
  { value: 'is', key: 'vocalIcelandic' as const },
  { value: 'it', key: 'vocalItalian' as const },
  { value: 'ja', key: 'vocalJapanese' as const },
  { value: 'ko', key: 'vocalKorean' as const },
  { value: 'la', key: 'vocalLatin' as const },
  { value: 'lt', key: 'vocalLithuanian' as const },
  { value: 'ms', key: 'vocalMalay' as const },
  { value: 'ne', key: 'vocalNepali' as const },
  { value: 'nl', key: 'vocalDutch' as const },
  { value: 'no', key: 'vocalNorwegian' as const },
  { value: 'pa', key: 'vocalPunjabi' as const },
  { value: 'pl', key: 'vocalPolish' as const },
  { value: 'pt', key: 'vocalPortuguese' as const },
  { value: 'ro', key: 'vocalRomanian' as const },
  { value: 'ru', key: 'vocalRussian' as const },
  { value: 'sa', key: 'vocalSanskrit' as const },
  { value: 'sk', key: 'vocalSlovak' as const },
  { value: 'sr', key: 'vocalSerbian' as const },
  { value: 'sv', key: 'vocalSwedish' as const },
  { value: 'sw', key: 'vocalSwahili' as const },
  { value: 'ta', key: 'vocalTamil' as const },
  { value: 'te', key: 'vocalTelugu' as const },
  { value: 'th', key: 'vocalThai' as const },
  { value: 'tl', key: 'vocalTagalog' as const },
  { value: 'tr', key: 'vocalTurkish' as const },
  { value: 'uk', key: 'vocalUkrainian' as const },
  { value: 'ur', key: 'vocalUrdu' as const },
  { value: 'vi', key: 'vocalVietnamese' as const },
  { value: 'yue', key: 'vocalCantonese' as const },
  { value: 'zh', key: 'vocalChineseMandarin' as const },
];

export type VocalGender = 'male' | 'female' | '';

interface VocalSettingsProps {
  /** Masque le bloc entier : sans chant, langue et genre n'ont pas de sens. */
  instrumental: boolean;
  vocalLanguage: string;
  vocalGender: VocalGender;
  onVocalLanguageChange: (value: string) => void;
  onVocalGenderChange: (value: VocalGender) => void;
  /** Fonction de traduction fournie par le parent (contexte I18n). */
  t: (key: string) => string;
}

/**
 * Langue du chant et genre de la voix.
 *
 * Composant purement presentationnel : les trois valeurs restent dans
 * `CreatePanel`, qui les lit a une quinzaine d'endroits lors de la
 * construction de la charge utile et des appels LLM. Les deplacer ici
 * obligerait a les remonter en permanence, pour un gain nul.
 *
 * Le bloc apparaissait autrefois en double, une fois par mode. La suppression
 * du mode Simple a supprime la duplication ; il ne restait qu'une occurrence
 * au moment de l'extraction.
 */
export const VocalSettings: React.FC<VocalSettingsProps> = ({
  instrumental,
  vocalLanguage,
  vocalGender,
  onVocalLanguageChange,
  onVocalGenderChange,
  t,
}) => {
  if (instrumental) return null;

  const selectClass =
    'w-full bg-white dark:bg-suno-card border border-zinc-200 dark:border-white/5 rounded-xl px-3 py-2 text-sm text-zinc-900 dark:text-white focus:outline-none focus:border-pink-500 dark:focus:border-pink-500 transition-colors cursor-pointer [&>option]:bg-white [&>option]:dark:bg-zinc-800 [&>option]:text-zinc-900 [&>option]:dark:text-white';
  const labelClass =
    'text-xs font-bold text-zinc-500 dark:text-zinc-400 uppercase tracking-wide px-1';

  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="space-y-1.5">
        <label className={labelClass}>{t('vocalLanguage')}</label>
        <select
          value={vocalLanguage}
          onChange={(e) => onVocalLanguageChange(e.target.value)}
          className={selectClass}
        >
          {VOCAL_LANGUAGE_KEYS.map(lang => (
            <option key={lang.value} value={lang.value}>{t(lang.key)}</option>
          ))}
        </select>
      </div>

      <div className="space-y-1.5">
        <label className={labelClass}>{t('vocalGender')}</label>
        <select
          value={vocalGender}
          onChange={(e) => onVocalGenderChange(e.target.value as VocalGender)}
          className={selectClass}
        >
          <option value="">Auto</option>
          <option value="male">{t('male')}</option>
          <option value="female">{t('female')}</option>
        </select>
      </div>
    </div>
  );
};
