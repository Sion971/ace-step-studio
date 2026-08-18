import React from 'react';

/** Tâches sur lesquelles le moteur accepte le flow-edit. */
export const FLOW_EDIT_TASK_TYPES = ['text2music', 'cover', 'cover-nofsq'];

interface FlowEditSettingsProps {
  /** Le panneau ne s'affiche que pour certaines tâches — voir FLOW_EDIT_TASK_TYPES. */
  taskType: string;
  morph: boolean;
  sourceCaption: string;
  sourceLyrics: string;
  nMin: number;
  nMax: number;
  nAvg: number;
  onMorphChange: (value: boolean) => void;
  onSourceCaptionChange: (value: string) => void;
  onSourceLyricsChange: (value: string) => void;
  onNMinChange: (value: number) => void;
  onNMaxChange: (value: number) => void;
  onNAvgChange: (value: number) => void;
  /** Repli quand la clé i18n manque — `t()` renvoie la clé elle-même. */
  tf: (key: string, fallback: string) => string;
}

/**
 * Flow-edit (#1156) — superposition d'édition textuelle faisant migrer la
 * source vers le prompt et les paroles cibles.
 *
 * Composant présentationnel : les six états restent dans CreatePanel, qui les
 * lit à la construction de la charge utile.
 */
export const FlowEditSettings: React.FC<FlowEditSettingsProps> = ({
  taskType,
  morph,
  sourceCaption,
  sourceLyrics,
  nMin,
  nMax,
  nAvg,
  onMorphChange,
  onSourceCaptionChange,
  onSourceLyricsChange,
  onNMinChange,
  onNMaxChange,
  onNAvgChange,
  tf,
}) => {
  return (
    <>
        {/* Flow-edit (#1156) — text-edit overlay morphing src toward target prompt/lyrics.
            Works only on text2music + cover + cover-nofsq tasks. */}
        {(['text2music', 'cover', 'cover-nofsq'].includes(taskType)) && (
          <div className="rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50/50 dark:bg-black/10 p-3 space-y-2">
            <label className="text-xs font-semibold text-zinc-700 dark:text-zinc-300 flex items-center gap-2">
              <input
                type="checkbox"
                checked={morph}
                onChange={(e) => onMorphChange(e.target.checked)}
                className="w-3.5 h-3.5 rounded accent-pink-500"
              />
              {tf('flowEditLabel', 'Flow-edit (morph from source)')}
            </label>
            {morph && (
              <>
                <div className="space-y-1">
                  <label className="text-[11px] text-zinc-600 dark:text-zinc-400">
                    {tf('flowEditSourceCaptionLabel', 'Source caption (original prompt)')}
                  </label>
                  <textarea
                    value={sourceCaption}
                    onChange={(e) => onSourceCaptionChange(e.target.value)}
                    rows={2}
                    placeholder={tf('flowEditSourceCaptionPlaceholder', 'Description of the source song to morph FROM')}
                    className="w-full bg-white dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-2 py-1 text-xs text-zinc-900 dark:text-white focus:outline-none focus:border-pink-500 resize-none"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] text-zinc-600 dark:text-zinc-400">
                    {tf('flowEditSourceLyricsLabel', 'Source lyrics (original)')}
                  </label>
                  <textarea
                    value={sourceLyrics}
                    onChange={(e) => onSourceLyricsChange(e.target.value)}
                    rows={2}
                    placeholder={tf('flowEditSourceLyricsPlaceholder', '[Verse] original lyrics...')}
                    className="w-full bg-white dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-2 py-1 text-xs text-zinc-900 dark:text-white focus:outline-none focus:border-pink-500 resize-none"
                  />
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div className="space-y-1">
                    <label className="text-[11px] text-zinc-600 dark:text-zinc-400 flex justify-between">
                      <span>{tf('flowEditNMinLabel', 'n_min')}</span>
                      <span className="text-zinc-500">{nMin.toFixed(2)}</span>
                    </label>
                    <input
                      type="range" min={0} max={1} step={0.05}
                      value={nMin}
                      onChange={(e) => onNMinChange(Number(e.target.value))}
                      className="w-full accent-pink-500"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] text-zinc-600 dark:text-zinc-400 flex justify-between">
                      <span>{tf('flowEditNMaxLabel', 'n_max')}</span>
                      <span className="text-zinc-500">{nMax.toFixed(2)}</span>
                    </label>
                    <input
                      type="range" min={0} max={1} step={0.05}
                      value={nMax}
                      onChange={(e) => onNMaxChange(Number(e.target.value))}
                      className="w-full accent-pink-500"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] text-zinc-600 dark:text-zinc-400 flex justify-between">
                      <span>{tf('flowEditNAvgLabel', 'n_avg')}</span>
                      <span className="text-zinc-500">{nAvg}</span>
                    </label>
                    <input
                      type="number" min={1} max={5} step={1}
                      value={nAvg}
                      onChange={(e) => onNAvgChange(Math.max(1, Math.min(5, parseInt(e.target.value, 10) || 1)))}
                      className="w-full bg-white dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-2 py-1 text-xs text-zinc-900 dark:text-white focus:outline-none focus:border-pink-500"
                    />
                  </div>
                </div>
              </>
            )}
          </div>
        )}
    </>
  );
};
