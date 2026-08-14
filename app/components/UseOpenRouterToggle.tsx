import React from 'react';
import { useI18n } from '../context/I18nContext';

interface Props {
  value: boolean;
  onChange: (v: boolean) => void;
}

export const UseOpenRouterToggle: React.FC<Props> = ({ value, onChange }) => {
  const { t } = useI18n();
  return (
    <div className="flex items-center justify-between py-2">
      <span
        className="text-xs font-medium text-zinc-600 dark:text-zinc-400"
        title={t('lmProvider.useOpenRouterHint') || 'Use OpenRouter (cloud LLM via your API key) instead of the local 5Hz model'}
      >
        {t('lmProvider.useOpenRouter') || 'Use OpenRouter'}
      </span>
      <button
        type="button"
        onClick={() => onChange(!value)}
        className={`w-10 h-5 rounded-full flex items-center transition-colors duration-200 px-0.5 border border-zinc-200 dark:border-white/5 cursor-pointer ${value ? 'bg-pink-600' : 'bg-zinc-300 dark:bg-black/40'}`}
        aria-pressed={value}
        aria-label={t('lmProvider.useOpenRouter') || 'Use OpenRouter'}
      >
        <div className={`w-4 h-4 rounded-full bg-white transform transition-transform duration-200 shadow-sm ${value ? 'translate-x-5' : 'translate-x-0'}`} />
      </button>
    </div>
  );
};
