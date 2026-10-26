import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../context/I18nContext';
import { formatTimeSignature } from '../services/timeSignature';
import {
  analyzeAudio, applyAnalysis, availableFields, AnalysisError, isApproximate,
  type AnalysisFieldId, type AnalysisSetters, type AudioAnalysis,
} from '../services/audioAnalysis';

interface Props {
  audioUrl: string;
  title: string;
  token: string;
  /** Fields that already hold something: they start unchecked so that nothing is overwritten by accident. */
  filled: Partial<Record<AnalysisFieldId, boolean>>;
  setters: AnalysisSetters;
  /** The analysis was kept with the imported audio: refresh the lists that show it. */
  onSaved?: () => void;
  autoOpen: boolean;
  onAutoOpenChange: (value: boolean) => void;
  onClose: () => void;
}

const LABELS = {
  caption: 'analysisStyle', lyrics: 'analysisLyrics', bpm: 'analysisBpm', keyScale: 'analysisKey',
  timeSignature: 'analysisSignature', duration: 'analysisDuration', language: 'analysisLanguage',
} as const;

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

function show(id: AnalysisFieldId, a: AudioAnalysis): string {
  switch (id) {
    case 'caption': return a.caption;
    case 'lyrics': return a.lyrics;
    case 'bpm': return String(a.bpm);
    case 'keyScale': return a.keyScale;
    case 'timeSignature': return formatTimeSignature(a.timeSignature);
    case 'duration': return mmss(a.duration || 0);
    case 'language': return a.language;
  }
}

export const AudioAnalysisDialog: React.FC<Props> = ({ audioUrl, title, token, filled, setters, autoOpen, onAutoOpenChange, onSaved, onClose }) => {
  const { t } = useI18n();
  const [state, setState] = useState<'running' | 'done' | 'busy' | 'failed'>('running');
  const [analysis, setAnalysis] = useState<AudioAnalysis | null>(null);
  const [chosen, setChosen] = useState<Set<AnalysisFieldId>>(new Set());

  useEffect(() => {
    const controller = new AbortController();
    setState('running');
    analyzeAudio(audioUrl, token, controller.signal)
      .then(({ analysis: a, saved }) => {
        setAnalysis(a);
        setChosen(new Set(availableFields(a).filter((id) => !filled[id] && !isApproximate(id, a))));
        setState('done');
        if (saved) onSaved?.();
      })
      .catch((e) => {
        if (controller.signal.aborted) return;
        setState(e instanceof AnalysisError && e.code === 'busy' ? 'busy' : 'failed');
      });
    return () => controller.abort();
    // The analysis belongs to the audio: `filled` only sets the starting checkboxes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioUrl, token]);

  const fields = analysis ? availableFields(analysis) : [];
  const toggle = (id: AnalysisFieldId) => setChosen((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const apply = () => {
    if (analysis) applyAnalysis(analysis, chosen, setters);
    onClose();
  };

  // Rendered on the page itself: inside the creation panel, the other panels (search bar...) drew over it when the window was not full screen.
  return createPortal(
    <div className="fixed inset-0 z-[130] flex items-center justify-center" role="dialog" aria-modal="true" data-testid="audio-analysis">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-[92%] max-w-lg max-h-[85vh] flex flex-col rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-white/10 shadow-2xl overflow-hidden">
        <div className="p-5 pb-3">
          <h3 className="text-xl font-semibold text-zinc-900 dark:text-white">{t('analysisTitle')}</h3>
          <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1 truncate">{title}</p>
        </div>

        <div className="px-5 pb-4 overflow-y-auto text-sm text-zinc-700 dark:text-zinc-200">
          {state === 'running' && (
            <div className="flex items-center gap-3 py-6" data-testid="audio-analysis-running">
              <div className="w-5 h-5 rounded-full border-2 border-zinc-300 border-t-zinc-700 dark:border-white/20 dark:border-t-white animate-spin" />
              <div>
                <div>{t('analysisRunning')}</div>
                <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">{t('analysisRunningHint')}</div>
              </div>
            </div>
          )}
          {state === 'busy' && <p className="py-4">{t('analysisBusy')}</p>}
          {state === 'failed' && <p className="py-4">{t('analysisFailed')}</p>}
          {state === 'done' && analysis && fields.length === 0 && (
            <div className="py-4">
              <p>{t('analysisNoModel')}</p>
              {analysis.status && <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-2">{analysis.status}</p>}
            </div>
          )}
          {state === 'done' && analysis && analysis.lyrics && analysis.lyricsSource === 'model' && (
            <p className="mb-3 text-xs text-amber-600 dark:text-amber-400" data-testid="analysis-no-whisper">{t('analysisNoWhisper')}</p>
          )}
          {state === 'done' && fields.length > 0 && (
            <ul className="space-y-2">
              {fields.map((id) => (
                <li key={id}>
                  <label className="flex items-start gap-3 p-2 rounded-lg hover:bg-zinc-50 dark:hover:bg-white/5 cursor-pointer">
                    <input type="checkbox" className="mt-1" checked={chosen.has(id)} onChange={() => toggle(id)} data-testid={`analysis-${id}`} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                        {t(LABELS[id])}
                        {filled[id] && <span className="normal-case tracking-normal"> · {t('analysisAlreadyFilled')}</span>}
                        {isApproximate(id, analysis) && <span className="normal-case tracking-normal"> · {t('analysisApproximate')}</span>}
                        {(id === 'lyrics' || id === 'language') && analysis.lyricsSource === 'whisper' && <span className="normal-case tracking-normal"> · {t('analysisWhisper')}</span>}
                      </span>
                      <span className={`block ${id === 'lyrics' ? 'whitespace-pre-wrap max-h-40 overflow-y-auto' : 'break-words'}`}>{show(id, analysis)}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="px-5 py-3 border-t border-zinc-100 dark:border-white/5 flex items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400 cursor-pointer">
            <input type="checkbox" checked={autoOpen} onChange={(e) => onAutoOpenChange(e.target.checked)} data-testid="analysis-auto" />
            {t('analysisAuto')}
          </label>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="px-3 py-1.5 rounded-lg text-sm hover:bg-zinc-100 dark:hover:bg-white/10 text-zinc-600 dark:text-zinc-300">
              {t('analysisClose')}
            </button>
            {state === 'done' && fields.length > 0 && (
              <button type="button" onClick={apply} disabled={chosen.size === 0} data-testid="analysis-apply"
                className="px-3 py-1.5 rounded-lg text-sm font-medium bg-zinc-900 text-white dark:bg-white dark:text-zinc-900 disabled:opacity-40">
                {t('analysisApply')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
};
