import React from 'react';

interface SamplingSettingsProps {
  audioFormat: string;
  inferMethod: string;
  samplerMode: string;
  schedulerType: string;
  onAudioFormatChange: (value: 'mp3' | 'flac') => void;
  onInferMethodChange: (value: string) => void;
  onSamplerModeChange: (value: string) => void;
  onSchedulerTypeChange: (value: string) => void;

  /** DCW — correction de qualité dans le domaine ondelettes (CVPR 2026). */
  dcwEnabled: boolean;
  dcwMode: string;
  dcwScaler: number;
  dcwHighScaler: number;
  dcwWavelet: string;
  onDcwEnabledChange: (value: boolean) => void;
  onDcwModeChange: (value: string) => void;
  onDcwScalerChange: (value: number) => void;
  onDcwHighScalerChange: (value: number) => void;
  onDcwWaveletChange: (value: string) => void;

  /** Les modèles turbo restreignent sampler et scheduler — dérivé de
   *  `isTurboModel(selectedModel)` côté parent. */
  turboActive: boolean;

  t: (key: string) => string;
  /** Repli quand la clé i18n manque — `t()` renvoie la clé elle-même. */
  tf: (key: string, fallback: string) => string;
}

/**
 * Échantillonnage et qualité : format de sortie, méthode d'inférence,
 * sampler, scheduler, et les cinq réglages DCW.
 *
 * Les sélecteurs se contraignent mutuellement — `sde` impose `euler`, certains
 * samplers imposent un scheduler `linear` — et ces règles sont conservées ici
 * telles quelles, sans modification lors de l'extraction.
 *
 * Composant présentationnel : les neuf états restent dans CreatePanel, qui les
 * lit à la construction de la charge utile. Voir TROUBLESHOOTING #11 pour le
 * DCW et son effet sur le son après changement de modèle.
 */
export const SamplingSettings: React.FC<SamplingSettingsProps> = ({
  audioFormat,
  inferMethod,
  samplerMode,
  schedulerType,
  onAudioFormatChange,
  onInferMethodChange,
  onSamplerModeChange,
  onSchedulerTypeChange,
  dcwEnabled,
  dcwMode,
  dcwScaler,
  dcwHighScaler,
  dcwWavelet,
  onDcwEnabledChange,
  onDcwModeChange,
  onDcwScalerChange,
  onDcwHighScalerChange,
  onDcwWaveletChange,
  turboActive,
  t,
  tf,
}) => {
  return (
    <>
        {/* Audio Format, Inference Method, Sampler, Scheduler */}
        <div className="grid grid-cols-4 gap-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{t('audioFormat')}</label>
            <select
              value={audioFormat}
              onChange={(e) => onAudioFormatChange(e.target.value as 'mp3' | 'flac')}
              className="w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-xl px-2 py-1.5 text-xs text-zinc-900 dark:text-white focus:outline-none focus:border-pink-500 dark:focus:border-pink-500 transition-colors cursor-pointer [&>option]:bg-white [&>option]:dark:bg-zinc-800 [&>option]:text-zinc-900 [&>option]:dark:text-white"
            >
              <option value="mp3">{t('mp3Smaller')}</option>
              <option value="flac">{t('flacLossless')}</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{t('inferMethod')}</label>
            <select
              value={inferMethod}
              onChange={(e) => {
                const val = e.target.value as 'ode' | 'sde';
                onInferMethodChange(val);
                // SDE only works with Euler
                if (val === 'sde' && samplerMode !== 'euler') onSamplerModeChange('euler');
              }}
              className="w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-xl px-2 py-1.5 text-xs text-zinc-900 dark:text-white focus:outline-none focus:border-pink-500 dark:focus:border-pink-500 transition-colors cursor-pointer [&>option]:bg-white [&>option]:dark:bg-zinc-800 [&>option]:text-zinc-900 [&>option]:dark:text-white"
            >
              <option value="ode">{t('odeDeterministic')}</option>
              <option value="sde">{t('sdeStochastic')}</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{tf('samplerMode', 'Sampler')}</label>
            <select
              value={samplerMode}
              onChange={(e) => {
                const val = e.target.value;
                onSamplerModeChange(val);
                // Non-euler samplers require ODE
                if (val !== 'euler' && inferMethod === 'sde') onInferMethodChange('ode');
                // Multistep samplers (deis/ipndm) need uniform steps → force linear scheduler
                if ((val === 'deis' || val === 'ipndm') && schedulerType !== 'linear') onSchedulerTypeChange('linear');
              }}
              className="w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-xl px-2 py-1.5 text-xs text-zinc-900 dark:text-white focus:outline-none focus:border-pink-500 dark:focus:border-pink-500 transition-colors cursor-pointer [&>option]:bg-white [&>option]:dark:bg-zinc-800 [&>option]:text-zinc-900 [&>option]:dark:text-white"
            >
              {(inferMethod === 'sde' || turboActive) ? (
                <option value="euler">Euler</option>
              ) : (
                <>
                  <option value="euler">Euler (1st)</option>
                  <option value="heun">Heun (2nd)</option>
                  <option value="midpoint">Midpoint (2nd)</option>
                  <option value="a2s">A²S (2nd, fast)</option>
                  <option value="pingpong">PingPong (2nd)</option>
                  <option value="bogacki">Bogacki (3rd)</option>
                  <option value="rk4">RK4 (4th)</option>
                  <option value="dopri5">DOPRI5 (5th)</option>
                  <option value="deis">DEIS (multi)</option>
                  <option value="ipndm">iPNDM (multi)</option>
                </>
              )}
            </select>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{tf('schedulerType', 'Scheduler')}</label>
            <select
              value={schedulerType}
              onChange={(e) => {
                const val = e.target.value;
                onSchedulerTypeChange(val);
                // Non-linear schedulers incompatible with multistep samplers
                if (val !== 'linear' && (samplerMode === 'deis' || samplerMode === 'ipndm')) onSamplerModeChange('euler');
              }}
              className="w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-xl px-2 py-1.5 text-xs text-zinc-900 dark:text-white focus:outline-none focus:border-pink-500 dark:focus:border-pink-500 transition-colors cursor-pointer [&>option]:bg-white [&>option]:dark:bg-zinc-800 [&>option]:text-zinc-900 [&>option]:dark:text-white"
            >
              {(samplerMode === 'deis' || samplerMode === 'ipndm' || turboActive) ? (
                <option value="linear">Linear</option>
              ) : (
                <>
                  <option value="linear">Linear</option>
                  <option value="karras">Karras</option>
                  <option value="cosine">Cosine</option>
                  <option value="beta">Beta</option>
                  <option value="sway">Sway (F5-TTS)</option>
                  <option value="logit_normal">Logit-Normal (SD3)</option>
                  <option value="laplace">Laplace (SOTA)</option>
                </>
              )}
            </select>
          </div>
        </div>

        {/* DCW (Differential Correction in Wavelet domain) — CVPR 2026 quality boost */}
        <div className="rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50/50 dark:bg-black/10 p-3 space-y-2">
          <label className="text-xs font-semibold text-zinc-700 dark:text-zinc-300 flex items-center gap-2">
            <input
              type="checkbox"
              checked={dcwEnabled}
              onChange={(e) => onDcwEnabledChange(e.target.checked)}
              className="w-3.5 h-3.5 rounded accent-pink-500"
            />
            {tf('dcwEnabledLabel', 'DCW Quality Correction')}
          </label>
          {dcwEnabled && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <label className="text-[11px] text-zinc-600 dark:text-zinc-400">{tf('dcwModeLabel', 'Mode')}</label>
                  <select
                    value={dcwMode}
                    onChange={(e) => onDcwModeChange(e.target.value as 'low' | 'high' | 'double' | 'pix')}
                    className="w-full bg-white dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-2 py-1 text-xs text-zinc-900 dark:text-white focus:outline-none focus:border-pink-500 cursor-pointer [&>option]:bg-white [&>option]:dark:bg-zinc-800"
                  >
                    <option value="low">Low band</option>
                    <option value="high">High band</option>
                    <option value="double">Double (recommended)</option>
                    <option value="pix">Pixel</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] text-zinc-600 dark:text-zinc-400">{tf('dcwWaveletLabel', 'Wavelet')}</label>
                  <select
                    value={dcwWavelet}
                    onChange={(e) => onDcwWaveletChange(e.target.value)}
                    className="w-full bg-white dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-2 py-1 text-xs text-zinc-900 dark:text-white focus:outline-none focus:border-pink-500 cursor-pointer [&>option]:bg-white [&>option]:dark:bg-zinc-800"
                  >
                    <option value="haar">Haar (default)</option>
                    <option value="db2">db2</option>
                    <option value="db4">db4</option>
                    <option value="sym4">sym4</option>
                    <option value="sym8">sym8</option>
                    <option value="coif2">coif2</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <label className="text-[11px] text-zinc-600 dark:text-zinc-400 flex justify-between">
                    <span>{tf('dcwScalerLabel', 'Low scaler')}</span>
                    <span className="text-zinc-500">{dcwScaler.toFixed(3)}</span>
                  </label>
                  <input
                    type="range" min={0} max={0.1} step={0.005}
                    value={dcwScaler}
                    onChange={(e) => onDcwScalerChange(Number(e.target.value))}
                    className="w-full accent-pink-500"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] text-zinc-600 dark:text-zinc-400 flex justify-between">
                    <span>{tf('dcwHighScalerLabel', 'High scaler')}</span>
                    <span className="text-zinc-500">{dcwHighScaler.toFixed(3)}</span>
                  </label>
                  <input
                    type="range" min={0} max={0.1} step={0.005}
                    value={dcwHighScaler}
                    onChange={(e) => onDcwHighScalerChange(Number(e.target.value))}
                    disabled={dcwMode !== 'double'}
                    className="w-full accent-pink-500 disabled:opacity-40"
                  />
                </div>
              </div>
            </>
          )}
        </div>
    </>
  );
};
