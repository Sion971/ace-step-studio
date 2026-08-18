import React from 'react';

interface OutputSettingsProps {
  /** Le bloc MP3 ne s'affiche que pour ce format ; les fondus sont toujours là. */
  audioFormat: string;
  bitrate: string;
  sampleRate: number;
  fadeIn: number;
  fadeOut: number;
  onBitrateChange: (value: string) => void;
  onSampleRateChange: (value: number) => void;
  onFadeInChange: (value: number) => void;
  onFadeOutChange: (value: number) => void;
  /** Repli quand la clé i18n manque — `t()` renvoie la clé elle-même. */
  tf: (key: string, fallback: string) => string;
}

/**
 * Réglages de sortie : qualité MP3 et fondus d'entrée/sortie.
 *
 * Composant présentationnel : les quatre états restent dans CreatePanel, qui
 * les lit à la construction de la charge utile. `audioFormat` n'est lu que
 * pour la condition d'affichage.
 */
export const OutputSettings: React.FC<OutputSettingsProps> = ({
  audioFormat,
  bitrate,
  sampleRate,
  fadeIn,
  fadeOut,
  onBitrateChange,
  onSampleRateChange,
  onFadeInChange,
  onFadeOutChange,
  tf,
}) => {
  return (
    <>
        {/* MP3 Quality (only when mp3 format selected) */}
        {audioFormat === 'mp3' && (
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{tf('mp3BitrateLabel', 'MP3 Bitrate')}</label>
              <select
                value={bitrate}
                onChange={(e) => onBitrateChange(e.target.value)}
                className="w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-xl px-2 py-1.5 text-xs text-zinc-900 dark:text-white focus:outline-none focus:border-pink-500 transition-colors cursor-pointer [&>option]:bg-white [&>option]:dark:bg-zinc-800"
              >
                <option value="64k">64 kbps</option>
                <option value="128k">128 kbps</option>
                <option value="192k">192 kbps</option>
                <option value="256k">256 kbps</option>
                <option value="320k">320 kbps</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{tf('mp3SampleRateLabel', 'Sample Rate')}</label>
              <select
                value={sampleRate}
                onChange={(e) => onSampleRateChange(Number(e.target.value))}
                className="w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-xl px-2 py-1.5 text-xs text-zinc-900 dark:text-white focus:outline-none focus:border-pink-500 transition-colors cursor-pointer [&>option]:bg-white [&>option]:dark:bg-zinc-800"
              >
                <option value="44100">44.1 kHz</option>
                <option value="48000">48 kHz</option>
              </select>
            </div>
          </div>
        )}

        {/* Fade In/Out */}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{tf('fadeInLabel', 'Fade In (s)')}</label>
            <input
              type="number" step="0.1" min="0" max="10"
              value={fadeIn}
              onChange={(e) => onFadeInChange(Number(e.target.value))}
              className="w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-xl px-2 py-1.5 text-xs text-zinc-900 dark:text-white focus:outline-none focus:border-pink-500 transition-colors"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{tf('fadeOutLabel', 'Fade Out (s)')}</label>
            <input
              type="number" step="0.1" min="0" max="10"
              value={fadeOut}
              onChange={(e) => onFadeOutChange(Number(e.target.value))}
              className="w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-xl px-2 py-1.5 text-xs text-zinc-900 dark:text-white focus:outline-none focus:border-pink-500 transition-colors"
            />
          </div>
        </div>
    </>
  );
};
