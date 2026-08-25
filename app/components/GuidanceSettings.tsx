import React from 'react';

interface GuidanceSettingsProps {
  cfgIntervalStart: number;
  onCfgIntervalStartChange: (value: number) => void;
  cfgIntervalEnd: number;
  onCfgIntervalEndChange: (value: number) => void;
  customTimesteps: string;
  onCustomTimestepsChange: (value: string) => void;
  scoreScale: number;
  onScoreScaleChange: (value: number) => void;
  lmBatchChunkSize: number;
  onLmBatchChunkSizeChange: (value: number) => void;
  /** Lu par les préréglages (le préréglage « ADG » l'active) et par le
   *  calcul du préréglage actif — la case elle-même vit dans
   *  CotDebugToggles, pas ici. */
  useAdg: boolean;
  onUseAdgChange: (value: boolean) => void;
  t: (key: string) => string;
  tf: (key: string, fallback: string) => string;
}

/**
 * Réglages de guidage CFG : préréglages rapides, intervalle CFG, timesteps
 * personnalisés, échelle de score, taille de lot LM.
 *
 * Les préréglages pilotent cinq états à la fois, dont `useAdg` qui n'est
 * pas propre à ce composant (sa case à cocher vit dans CotDebugToggles) —
 * d'où le besoin de la recevoir en prop plutôt que de la garder locale.
 *
 * Composant présentationnel : tous les états restent dans CreatePanel.
 */
export const GuidanceSettings: React.FC<GuidanceSettingsProps> = ({
  cfgIntervalStart,
  onCfgIntervalStartChange,
  cfgIntervalEnd,
  onCfgIntervalEndChange,
  customTimesteps,
  onCustomTimestepsChange,
  scoreScale,
  onScoreScaleChange,
  lmBatchChunkSize,
  onLmBatchChunkSizeChange,
  useAdg,
  onUseAdgChange,
  t,
  tf,
}) => {
  const presets = [
    { label: t('presetDefault'), cfg: [0, 1], ts: '', score: 0.5, adg: false, desc: t('presetDefaultDesc') },
    { label: t('presetCleanVocals'), cfg: [0, 0.5], ts: '', score: 0.5, adg: false, desc: t('presetCleanVocalsDesc') },
    { label: t('presetCreative'), cfg: [0.2, 0.8], ts: '', score: 0.5, adg: false, desc: t('presetCreativeDesc') },
    { label: t('presetCover'), cfg: [0, 0.95], ts: '', score: 0.5, adg: false, desc: t('presetCoverDesc') },
    { label: t('presetStrict'), cfg: [0, 0.75], ts: '', score: 0.7, adg: false, desc: t('presetStrictDesc') },
    { label: 'ADG', cfg: [0, 1], ts: '', score: 0.5, adg: true, desc: t('presetAdgDesc') },
  ];

  return (
    <>
      <div className="space-y-1">
        <h4 className="text-xs font-bold text-zinc-500 dark:text-zinc-400 uppercase tracking-wide">{t('guidance')}</h4>
        <p className="text-[11px] text-zinc-400 dark:text-zinc-500">{t('advancedCfgScheduling')}</p>
        {/* Presets */}
        <div className="flex flex-wrap gap-1.5 pt-1">
          {presets.map((p) => (
            <button
              key={p.label}
              title={p.desc}
              onClick={() => {
                onCfgIntervalStartChange(p.cfg[0]);
                onCfgIntervalEndChange(p.cfg[1]);
                onCustomTimestepsChange(p.ts);
                onScoreScaleChange(p.score);
                onUseAdgChange(p.adg);
              }}
              className={`px-2 py-1 rounded-md text-[10px] font-medium transition-all border ${
                cfgIntervalStart === p.cfg[0] && cfgIntervalEnd === p.cfg[1] && (useAdg === p.adg)
                  ? 'bg-pink-500/20 text-pink-400 border-pink-500/30'
                  : 'bg-white/5 text-zinc-400 border-white/10 hover:border-white/20 hover:text-zinc-200'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400" title={tf('hintCfgIntervalStart', 'Fraction of the diffusion process to start applying guidance.')}>{t('cfgIntervalStart')}</label>
          <input
            type="number"
            step="0.01"
            min="0"
            max="1"
            value={cfgIntervalStart}
            onChange={(e) => onCfgIntervalStartChange(Number(e.target.value))}
            className="w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-3 py-2 text-xs text-zinc-900 dark:text-white focus:outline-none"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400" title={tf('hintCfgIntervalEnd', 'Fraction of the diffusion process to stop applying guidance.')}>{t('cfgIntervalEnd')}</label>
          <input
            type="number"
            step="0.01"
            min="0"
            max="1"
            value={cfgIntervalEnd}
            onChange={(e) => onCfgIntervalEndChange(Number(e.target.value))}
            className="w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-3 py-2 text-xs text-zinc-900 dark:text-white focus:outline-none"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400" title={tf('hintCustomTimesteps', 'Override the default timestep schedule (advanced).')}>{t('customTimesteps')}</label>
        <input
          type="text"
          value={customTimesteps}
          onChange={(e) => onCustomTimestepsChange(e.target.value)}
          placeholder={t('timestepsPlaceholder')}
          className="w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-3 py-2 text-xs text-zinc-900 dark:text-white focus:outline-none"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400" title={tf('hintScoreScale', 'Scales score-based guidance (advanced).')}>{t('scoreScale')}</label>
          <input
            type="number"
            step="0.01"
            min="0.01"
            max="1"
            value={scoreScale}
            onChange={(e) => onScoreScaleChange(Number(e.target.value))}
            className="w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-3 py-2 text-xs text-zinc-900 dark:text-white focus:outline-none"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400" title={tf('hintLmBatchChunkSize', 'Bigger chunks can be faster but use more memory.')}>{t('lmBatchChunkSize')}</label>
          <input
            type="number"
            min="1"
            max="32"
            step="1"
            value={lmBatchChunkSize}
            onChange={(e) => onLmBatchChunkSizeChange(Number(e.target.value))}
            className="w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-3 py-2 text-xs text-zinc-900 dark:text-white focus:outline-none"
          />
        </div>
      </div>
    </>
  );
};
