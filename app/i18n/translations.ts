import { en } from './en';
import { zh } from './zh';
import { ja } from './ja';
import { ko } from './ko';
import { fr } from './fr';
import { ru } from './ru';

export type Language = 'en' | 'zh' | 'ja' | 'ko' | 'fr' | 'ru';

export type TranslationKey = keyof typeof en;

export const translations = { en, zh, ja, ko, fr, ru };

// Langue par défaut du système
export const DEFAULT_LANGUAGE: Language = 'fr';
