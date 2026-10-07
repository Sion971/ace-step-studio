/* ============================================================================
 * LoudnessNormalizationModal.tsx — normalisation LUFS par plateforme
 *
 * Appelle /api/loudnorm/normalize (ffmpeg, deux passes — voir
 * routes/loudnorm.ts) pour ajuster la loudness integree du morceau a la
 * cible d'une plateforme donnee, sans ecraser la dynamique (linear=true
 * cote serveur, pas un limiteur).
 * ==========================================================================*/

import React, { useState, useRef } from 'react';
import { X, Gauge, Loader2, Play, Pause, Download } from 'lucide-react';
import { useI18n } from '../context/I18nContext';
import { fillTemplate } from '../utils/fillTemplate';

interface LoudnessNormalizationModalProps {
  audioUrl: string;
  songTitle?: string;
  onClose: () => void;
}

interface PlatformPreset {
  label: string;
  targetI: number;
  targetTP: number;
}

// Cibles confirmees via plusieurs sources independantes recentes (2026).
const PRESETS: PlatformPreset[] = [
  { label: 'Spotify', targetI: -14, targetTP: -1.0 },
  { label: 'Apple Music', targetI: -16, targetTP: -1.0 },
  { label: 'YouTube', targetI: -14, targetTP: -1.0 },
  { label: 'Tidal', targetI: -14, targetTP: -1.0 },
  { label: 'Amazon Music', targetI: -14, targetTP: -2.0 },
  { label: 'Deezer', targetI: -15, targetTP: -1.0 },
];

export const LoudnessNormalizationModal: React.FC<LoudnessNormalizationModalProps> = ({
  audioUrl,
  songTitle,
  onClose,
}) => {
  const { t } = useI18n();
  const [selectedPreset, setSelectedPreset] = useState<PlatformPreset>(PRESETS[0]);
  const [customI, setCustomI] = useState(-14);
  const [useCustom, setUseCustom] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [playingWhich, setPlayingWhich] = useState<'before' | 'after' | null>(null);

  const beforeRef = useRef<HTMLAudioElement>(null);
  const afterRef = useRef<HTMLAudioElement>(null);

  const handleNormalize = async () => {
    setIsProcessing(true);
    setError(null);
    setResultUrl(null);

    const targetI = useCustom ? customI : selectedPreset.targetI;
    const targetTP = useCustom ? -1.0 : selectedPreset.targetTP;

    try {
      const audioBlob = await fetch(audioUrl).then((r) => r.blob());
      const formData = new FormData();
      formData.append('audio', audioBlob, 'input.audio');
      formData.append('targetI', String(targetI));
      formData.append('targetTP', String(targetTP));
      formData.append('targetLRA', '11');

      const response = await fetch('/api/loudnorm/normalize', { method: 'POST', body: formData });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || fillTemplate(t('loudnessFailed'), { status: response.status }));
      }

      const blob = await response.blob();
      setResultUrl(URL.createObjectURL(blob));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('networkError'));
    } finally {
      setIsProcessing(false);
    }
  };

  const toggleCompare = (which: 'before' | 'after') => {
    beforeRef.current?.pause();
    afterRef.current?.pause();
    if (playingWhich === which) {
      setPlayingWhich(null);
      return;
    }
    const ref = which === 'before' ? beforeRef.current : afterRef.current;
    void ref?.play();
    setPlayingWhich(which);
  };

  const handleDownload = () => {
    if (!resultUrl) return;
    const link = document.createElement('a');
    link.href = resultUrl;
    link.download = `${songTitle || 'song'}-normalized.wav`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl border border-zinc-200 dark:border-white/10 w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-100 dark:border-white/5">
          <div className="flex items-center gap-2">
            <Gauge size={18} className="text-pink-500" />
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-white">
              {t('loudnessTitle')}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-zinc-400 hover:text-zinc-700 dark:hover:text-white rounded-lg hover:bg-zinc-100 dark:hover:bg-white/5 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {!resultUrl && (
            <>
              <div className="space-y-2">
                <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                  {t('loudnessPlatform')}
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {PRESETS.map((preset) => (
                    <button
                      key={preset.label}
                      onClick={() => { setSelectedPreset(preset); setUseCustom(false); }}
                      disabled={isProcessing}
                      className={`px-3 py-2 rounded-lg text-xs font-medium transition-colors disabled:opacity-50 ${
                        !useCustom && selectedPreset.label === preset.label
                          ? 'bg-pink-500 text-white'
                          : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700'
                      }`}
                    >
                      {preset.label}
                      <span className="block text-[10px] font-normal opacity-80">
                        {preset.targetI} LUFS
                      </span>
                    </button>
                  ))}
                </div>

                <label className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400 pt-1 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={useCustom}
                    onChange={(e) => setUseCustom(e.target.checked)}
                    className="accent-pink-600"
                  />
                  {t('loudnessCustom')}
                </label>
                {useCustom && (
                  <div className="flex items-center gap-2">
                    <input
                      type="range"
                      min={-23}
                      max={-8}
                      step={0.5}
                      value={customI}
                      onChange={(e) => setCustomI(parseFloat(e.target.value))}
                      className="flex-1 accent-pink-500"
                    />
                    <span className="text-xs text-zinc-600 dark:text-zinc-400 tabular-nums w-16 text-right">
                      {customI} LUFS
                    </span>
                  </div>
                )}
              </div>

              <button
                onClick={handleNormalize}
                disabled={isProcessing}
                className="w-full py-2.5 rounded-lg text-sm font-semibold bg-gradient-to-r from-pink-500 to-purple-600 text-white shadow-lg shadow-pink-500/20 hover:from-pink-600 hover:to-purple-700 transition-all disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {isProcessing ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    {t('loudnessProcessing')}
                  </>
                ) : (
                  t('loudnessNormalize')
                )}
              </button>
            </>
          )}

          {error && (
            <div className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 px-3 py-2 rounded-lg">
              {error}
            </div>
          )}

          {resultUrl && (
            <div className="space-y-3">
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                {fillTemplate(t('loudnessResult'), { lufs: useCustom ? customI : selectedPreset.targetI })}
              </p>

              <div className="space-y-2">
                <button
                  onClick={() => toggleCompare('before')}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg bg-zinc-50 dark:bg-black/20 border border-zinc-100 dark:border-white/5 hover:bg-zinc-100 dark:hover:bg-black/30 transition-colors"
                >
                  <span className="w-8 h-8 flex-shrink-0 rounded-full bg-zinc-400 text-white flex items-center justify-center">
                    {playingWhich === 'before' ? <Pause size={14} /> : <Play size={14} className="ml-0.5" />}
                  </span>
                  <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">Original</span>
                </button>
                <button
                  onClick={() => toggleCompare('after')}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg bg-zinc-50 dark:bg-black/20 border border-zinc-100 dark:border-white/5 hover:bg-zinc-100 dark:hover:bg-black/30 transition-colors"
                >
                  <span className="w-8 h-8 flex-shrink-0 rounded-full bg-pink-500 text-white flex items-center justify-center">
                    {playingWhich === 'after' ? <Pause size={14} /> : <Play size={14} className="ml-0.5" />}
                  </span>
                  <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">{t('loudnessNormalized')}</span>
                </button>
              </div>

              <audio ref={beforeRef} src={audioUrl} onEnded={() => setPlayingWhich(null)} className="hidden" />
              <audio ref={afterRef} src={resultUrl} onEnded={() => setPlayingWhich(null)} className="hidden" />

              <button
                onClick={handleDownload}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-semibold bg-gradient-to-r from-pink-500 to-purple-600 text-white shadow-lg shadow-pink-500/20 hover:from-pink-600 hover:to-purple-700 transition-all"
              >
                <Download size={16} />
                {t('loudnessDownload')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
