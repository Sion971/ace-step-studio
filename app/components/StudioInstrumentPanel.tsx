import React, { useEffect, useMemo, useState } from 'react';
import { Wand2 } from 'lucide-react';
import type { Song } from '../types';
import { TRACK_NAMES, TRACK_LABELS } from './TrackPicker';
import { isPureBaseModel } from '../utils/modelNames';

export interface StudioInstrumentRequest {
  song: Song;
  trackName: string;
  style: string;
  model: string;
  guidance: number;
  onProgress?: (progress: number | undefined, stage?: string) => void;
}

interface Props {
  /** Songs currently in the editor (the possible sources). */
  sources: Song[];
  tf: (key: string, fallback: string) => string;
  /** Runs Lego on the song and resolves with the audio URL(s) of the new track. */
  onGenerate: (req: StudioInstrumentRequest) => Promise<string[]>;
  /** Puts a generated track in the editor. */
  onResult: (song: Song, trackName: string, urls: string[]) => Promise<void>;
}

/** Installed models that can run Lego (pure base models), the active one first. */
export function pickLegoModels(models: { name: string; is_active?: boolean }[]): string[] {
  const ok = models.filter((m) => isPureBaseModel(m.name));
  return [...ok.filter((m) => m.is_active), ...ok.filter((m) => !m.is_active)].map((m) => m.name);
}

export const StudioInstrumentPanel: React.FC<Props> = ({ sources, tf, onGenerate, onResult }) => {
  const [models, setModels] = useState<string[] | null>(null);
  const [model, setModel] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [trackName, setTrackName] = useState<string>('keyboard');
  const [style, setStyle] = useState('');
  const [guidance, setGuidance] = useState(5);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/generate/models')
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        const list = pickLegoModels(d.models || []);
        setModels(list);
        setModel((m) => m || list[0] || '');
      })
      .catch(() => { if (!cancelled) setModels([]); });
    return () => { cancelled = true; };
  }, []);

  const source = useMemo(() => sources.find((s) => s.id === sourceId) ?? sources[sources.length - 1], [sources, sourceId]);

  const run = async () => {
    if (!source || !model || busy) return;
    setError(null);
    setBusy(true);
    setProgress(undefined);
    try {
      const urls = await onGenerate({ song: source, trackName, style: style.trim(), model, guidance, onProgress: (p) => setProgress(p) });
      if (urls.length === 0) throw new Error('no audio');
      await onResult(source, trackName, urls);
    } catch (e) {
      console.error('[Studio] instrument generation failed', e);
      setError(tf('studioInstrumentError', 'The instrument could not be generated.'));
    } finally {
      setBusy(false);
    }
  };

  const field = 'w-full px-2 py-1.5 text-xs rounded-lg bg-zinc-100 dark:bg-black/30 border border-zinc-200 dark:border-white/10 text-zinc-900 dark:text-white focus:outline-none focus:border-pink-500';
  const label = 'block mt-2 mb-0.5 text-[10px] font-medium text-zinc-500 dark:text-zinc-400';

  return (
    <div className="p-3 border-t border-zinc-200 dark:border-white/5 overflow-y-auto max-h-[45%]" data-testid="studio-instrument-panel">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold text-zinc-900 dark:text-white">
        <Wand2 size={13} className="text-pink-500" />
        {tf('studioAddInstrument', 'Add an instrument')}
      </h3>
      {models !== null && models.length === 0 ? (
        <p className="mt-2 text-[11px] text-zinc-500 dark:text-zinc-400">{tf('studioInstrumentNoModel', 'This needs a Base model (Base or XL Base). Install one from the model menu.')}</p>
      ) : sources.length === 0 ? (
        <p className="mt-2 text-[11px] text-zinc-500 dark:text-zinc-400">{tf('studioInstrumentNoSource', 'Add a song to the editor first.')}</p>
      ) : (
        <>
          <label className={label}>{tf('studioInstrumentSource', 'Song')}</label>
          <select className={field} value={source?.id ?? ''} onChange={(e) => setSourceId(e.target.value)} disabled={busy}>
            {sources.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
          </select>
          <label className={label}>{tf('studioInstrument', 'Instrument')}</label>
          <select className={field} value={trackName} onChange={(e) => setTrackName(e.target.value)} disabled={busy}>
            {TRACK_NAMES.map((n) => <option key={n} value={n}>{tf(TRACK_LABELS[n][0], TRACK_LABELS[n][1])}</option>)}
          </select>
          <label className={label}>{tf('studioInstrumentStyle', 'Style of the instrument')}</label>
          <input
            type="text"
            className={field}
            value={style}
            onChange={(e) => setStyle(e.target.value)}
            placeholder={tf('studioInstrumentStylePlaceholder', 'e.g. funky electric piano, short stabs')}
            disabled={busy}
          />
          <div className="flex gap-2">
            <div className="flex-1 min-w-0">
              <label className={label}>{tf('studioInstrumentModel', 'Model')}</label>
              <select className={field} value={model} onChange={(e) => setModel(e.target.value)} disabled={busy}>
                {(models || []).map((m) => <option key={m} value={m}>{m.replace(/^acestep-v15-/, '')}</option>)}
              </select>
            </div>
            <div className="w-16">
              <label className={label}>{tf('studioInstrumentGuidance', 'Guidance')}</label>
              <input
                type="number" min={1} max={15} step={0.5}
                className={field}
                value={guidance}
                onChange={(e) => setGuidance(Math.min(15, Math.max(1, Number(e.target.value) || 5)))}
                disabled={busy}
              />
            </div>
          </div>
          <button
            type="button"
            onClick={run}
            disabled={busy || !model}
            className="mt-3 w-full py-2 text-xs font-semibold rounded-lg bg-pink-500 hover:bg-pink-600 text-white disabled:opacity-60 disabled:cursor-wait"
          >
            {busy
              ? `${tf('studioInstrumentRunning', 'Generating…')}${progress != null ? ` ${Math.round(progress * 100)} %` : ''}`
              : tf('studioInstrumentGenerate', 'Generate and add as a track')}
          </button>
          {error && <p className="mt-2 text-[11px] text-red-500">{error}</p>}
        </>
      )}
    </div>
  );
};
