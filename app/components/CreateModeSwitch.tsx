import React from 'react';

export type CreateView = 'simple' | 'custom';

export const CREATE_VIEW_KEY = 'ace-createView';

/** Remembered view; 'custom' (the full panel) when nothing valid is stored. */
export function readCreateView(): CreateView {
  try {
    return localStorage.getItem(CREATE_VIEW_KEY) === 'simple' ? 'simple' : 'custom';
  } catch {
    return 'custom';
  }
}

export function saveCreateView(view: CreateView): void {
  try { localStorage.setItem(CREATE_VIEW_KEY, view); } catch { /* storage unavailable: the choice just isn't remembered */ }
}

/** What the Simple view hides but still sends: it is shown, never silent. */
export interface HiddenInUse {
  style: boolean;
  lyrics: boolean;
  audio: boolean;
}

interface Props {
  view: CreateView;
  onChange: (view: CreateView) => void;
  hidden: HiddenInUse;
  instrumental: boolean;
  onInstrumentalChange: (value: boolean) => void;
  t: (key: any) => string;
  tf: (key: string, fallback: string) => string;
}

/**
 * Simple / Custom switch of the Create panel. It is a VIEW only: both views
 * edit the same state and build the same payload (the two old modes built
 * diverging payloads, which caused several bugs). Simple just hides fields.
 */
export const CreateModeSwitch: React.FC<Props> = ({ view, onChange, hidden, instrumental, onInstrumentalChange, t, tf }) => {
  const used = [
    hidden.style && tf('createHiddenStyle', 'style'),
    hidden.lyrics && tf('createHiddenLyrics', 'paroles'),
    hidden.audio && tf('createHiddenAudio', 'audio'),
  ].filter(Boolean) as string[];
  const btn = (v: CreateView, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={view === v}
      data-testid={`create-view-${v}`}
      onClick={() => onChange(v)}
      className={`flex-1 px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors ${view === v ? 'bg-pink-500 text-white' : 'text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-white/10'}`}
    >
      {label}
    </button>
  );
  return (
    <div className="space-y-2">
      <div role="tablist" className="flex gap-1 p-1 rounded-xl bg-zinc-100 dark:bg-white/5">
        {btn('simple', t('simple'))}
        {btn('custom', t('custom'))}
      </div>
      {view === 'simple' && (
        <div className="space-y-1.5">
          <label className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400 cursor-pointer">
            <input type="checkbox" data-testid="create-simple-instrumental" checked={instrumental} onChange={(e) => onInstrumentalChange(e.target.checked)} />
            {t('instrumental')}
          </label>
          {used.length > 0 && (
            <p data-testid="create-simple-hidden" className="text-[10px] text-amber-600 dark:text-amber-400">
              {tf('createHiddenInUse', 'Masqué mais utilisé à la génération :')} {used.join(', ')}. {tf('createHiddenSeeIn', 'Passe en Personnalisé pour le voir ou le vider.')}
            </p>
          )}
        </div>
      )}
    </div>
  );
};
