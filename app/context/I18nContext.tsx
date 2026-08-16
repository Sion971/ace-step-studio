import React, { createContext, useContext, useState, ReactNode } from 'react';
import { translations, Language, TranslationKey } from '../i18n/translations';

interface I18nContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: (key: TranslationKey) => string;
}

const I18nContext = createContext<I18nContextType | undefined>(undefined);

export const I18nProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [language, setLanguage] = useState<Language>(() => {
    const stored = localStorage.getItem('language') as Language;
    if (stored === 'zh' || stored === 'en' || stored === 'ja' || stored === 'fr' || stored === 'ko' || stored === 'ru') return stored;
    if (typeof navigator !== 'undefined' && navigator.language?.startsWith('fr')) return 'fr';
    return 'en';
  });

  const handleSetLanguage = (lang: Language) => {
    setLanguage(lang);
    localStorage.setItem('language', lang);
  };

  const t = (key: TranslationKey): string => {
    // Repli en cascade : langue courante → anglais → clé brute. Sans le maillon
    // anglais, une clé absente d'une traduction remontait telle quelle ; comme
    // une chaîne non vide est truthy, les `|| fallback` des composants ne se
    // déclenchaient jamais et l'identifiant technique s'affichait à l'écran.
    return translations[language][key] || translations.en[key] || key;
  };

  return (
    <I18nContext.Provider value={{ language, setLanguage: handleSetLanguage, t }}>
      {children}
    </I18nContext.Provider>
  );
};

export const useI18n = () => {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error('useI18n must be used within I18nProvider');
  }
  return context;
};
