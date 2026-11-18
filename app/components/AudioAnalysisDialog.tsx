import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../context/I18nContext';
import { formatTimeSignature } from '../services/timeSignature';
import {
  analyzeAudio, applyAnalysis, availableFields, AnalysisError, isApproximate, saveCorrectedLyrics,
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

/** The fields whose text can be corrected here before it goes to the form: Whisper mishears words, the style is a guess. */
const EDITABLE = new Set<AnalysisFieldId>(['lyrics', 'caption']);

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
  // The texts as the user corrected them (lyrics, style); the analysis itself keeps what was heard.
  const [edited, setEdited] = useState<Partial<Record<'lyrics' | 'caption', string>>>({});
  // The analysis was kept with an imported audio: corrected lyrics are kept with it too (and time its video's lyrics).
  const [keptWithTrack, setKeptWithTrack] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setState('running');
    analyzeAudio(audioUrl, token, controller.signal)
      .then(({ analysis: a, saved }) => {
        setAnalysis(a);
        setEdited({});
        setKeptWithTrack(saved);
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
  const textOf = (id: 'lyrics' | 'caption') => edited[id] ?? (analysis ? analysis[id] : '');
  const editText = (id: 'lyrics' | 'caption', value: string) => {
    setEdited((prev) => ({ ...prev, [id]: value }));
    // Correcting a text means wanting it: its box is ticked.
    setChosen((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  };
  const apply = () => {
    if (analysis) {
      const lyrics = textOf('lyrics');
      applyAnalysis({ ...analysis, lyrics, caption: textOf('caption') }, chosen, setters);
      // Corrected lyrics of an imported audio also go to the import: its video then shows them, timed from the words heard.
      if (keptWithTrack && chosen.has('lyrics') && lyrics.trim() && lyrics !== analysis.lyrics) {
        saveCorrectedLyrics(audioUrl, lyrics, token)
          .then(({ saved }) => { if (saved) onSaved?.(); })
          .catch((e) => console.warn('[Analysis] corrected lyrics not kept with the import:', e));
      }
    }
    onClose();
  };

  // Rendered on the page itself: inside the creation panel, the other panels (search bar...) drew over it when the window was not full screen.
  return createPortal(
    <div className="fixed inset-0 z-[130] flex items-center justify-center" role="dialog" aria-modal="true" data-testid="audio-analysis">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-[92%] max-w-xl max-h-[85vh] flex flex-col rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-white/10 shadow-2xl overflow-hidden">
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
              {fields.map((id) => {
                const header = (
                  <span className="block text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                    {t(LABELS[id])}
                    {filled[id] && <span className="normal-case tracking-normal"> · {t('analysisAlreadyFilled')}</span>}
                    {isApproximate(id, analysis) && <span className="normal-case tracking-normal"> · {t('analysisApproximate')}</span>}
                    {(id === 'lyrics' || id === 'language') && analysis.lyricsSource === 'whisper' && <span className="normal-case tracking-normal"> · {t('analysisWhisper')}</span>}
                  </span>
                );
                const checkbox = <input type="checkbox" className="mt-1" checked={chosen.has(id)} onChange={() => toggle(id)} data-testid={`analysis-${id}`} />;
                if (EDITABLE.has(id)) {
                  // Lyrics and style can be corrected here, before they go to the form (Whisper mishears some words).
                  const key = id as 'lyrics' | 'caption';
                  const changed = edited[key] !== undefined && edited[key] !== analysis[key];
                  return (
                    <li key={id}>
                      <div className="flex items-start gap-3 p-2 rounded-lg">
                        {checkbox}
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center justify-between gap-2">
                            {header}
                            {changed && (
                              <button type="button" onClick={() => setEdited((prev) => ({ ...prev, [key]: undefined }))} data-testid={`analysis-${id}-reset`}
                                className="text-[11px] text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-white underline shrink-0">
                                {t('analysisResetText')}
                              </button>
                            )}
                          </span>
                          <textarea
                            value={textOf(key)}
                            onChange={(e) => editText(key, e.target.value)}
                            rows={id === 'lyrics' ? 8 : 2}
                            spellCheck
                            aria-label={t(LABELS[id])}
                            data-testid={`analysis-${id}-text`}
                            className="mt-1 w-full rounded-lg border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-black/30 px-2 py-1.5 text-sm text-zinc-800 dark:text-zinc-100 resize-y focus:outline-none focus:border-zinc-400 dark:focus:border-white/30"
                          />
                          {id === 'lyrics' && <span className="block text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5">{t('analysisEditHint')}</span>}
                        </span>
                      </div>
                    </li>
                  );
                }
                return (
                  <li key={id}>
                    <label className="flex items-start gap-3 p-2 rounded-lg hover:bg-zinc-50 dark:hover:bg-white/5 cursor-pointer">
                      {checkbox}
                      <span className="min-w-0 flex-1">
                        {header}
                        <span className="block break-words">{show(id, analysis)}</span>
                      </span>
                    </label>
                  </li>
                );
              })}
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
