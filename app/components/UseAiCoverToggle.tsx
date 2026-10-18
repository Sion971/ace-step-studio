import React, { useEffect, useState } from 'react';
import { useI18n } from '../context/I18nContext';
import { songsApi } from '../services/api';

interface Props {
  value: boolean;
  onChange: (v: boolean) => void;
  token: string | null;
}

type Availability = { available: boolean; reason?: string } | null;

/**
 * "AI cover (local)": the server draws the cover with SDXL Turbo on the GPU once the audio is done. The server says whether
 * it can (no GPU in processor mode, or the image model cannot start); when it cannot, the switch is off and says why, and
 * the song keeps its default gradient.
 */
export const UseAiCoverToggle: React.FC<Props> = ({ value, onChange, token }) => {
  const { t } = useI18n();
  const [status, setStatus] = useState<Availability>(null);

  useEffect(() => {
    if (!token) return;
    let alive = true;
    songsApi.coverAiStatus(token)
      .then((s) => { if (alive) setStatus(s); })
      .catch(() => { if (alive) setStatus(null); });
    return () => { alive = false; };
  }, [token]);

  const blocked = status !== null && !status.available;
  const on = value && !blocked;
  const note = blocked
    ? (status?.reason === 'cpu-mode' ? t('aiCover.unavailableCpu')
      : status?.reason === 'small-gpu' ? t('aiCover.unavailableSmallGpu')
      : t('aiCover.unavailable'))
    : t('aiCover.useToggleHint');

  return (
    <div className="py-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{t('aiCover.useToggle')}</span>
        <button
          type="button"
          onClick={() => !blocked && onChange(!value)}
          disabled={blocked}
          className={`w-10 h-5 rounded-full flex items-center transition-colors duration-200 px-0.5 border border-zinc-200 dark:border-white/5 ${blocked ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'} ${on ? 'bg-pink-600' : 'bg-zinc-300 dark:bg-black/40'}`}
          aria-pressed={on}
          aria-label={t('aiCover.useToggle')}
          data-ai-cover-toggle
        >
          <div className={`w-4 h-4 rounded-full bg-white transform transition-transform duration-200 shadow-sm ${on ? 'translate-x-5' : 'translate-x-0'}`} />
        </button>
      </div>
      <p className="mt-1 text-[11px] leading-snug text-zinc-500 dark:text-zinc-500" data-ai-cover-note>{note}</p>
    </div>
  );
};
