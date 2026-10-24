import React, { useEffect, useMemo, useState } from 'react';
import { Wand2 } from 'lucide-react';
import type { Song } from '../types';
import { TRACK_NAMES, TRACK_LABELS } from './TrackPicker';
import { isPureBaseModel } from '../utils/modelNames';
import { durationToSeconds } from './studioBridge';

export interface StudioInstrumentRequest {
  song: Song;
  trackName: string;
  style: string;
  model: string;
  guidance: number;
  /** Tempo and key given to the engine (as typed; absent = left to the engine). */
  bpm?: number;
  keyScale?: string;
  /** Fixed seed; absent = a random one. */
  seed?: number;
  /** Part of the song to work on, in seconds; absent = the whole song. */
  region?: { start: number; end: number };
  onProgress?: (progress: number | undefined, stage?: string) => void;
}

interface Props {
  /** Songs currently in the editor (the possible sources). */
  sources: Song[];
  tf: (key: string, fallback: string) => string;
  /** Runs Lego on the song and resolves with the audio URL(s) of the new track. */
  onGenerate: (req: StudioInstrumentRequest) => Promise<string[]>;
  /** Puts a generated track in the editor. */
  onResult: (song: Song, trackName: string, urls: string[], region?: { start: number; end: number }) => Promise<void>;
  /** The range selected in the editor, if any. */
  getEditorRegion?: () => { start: number; end: number } | null;
  /** The source to select when it changes (the clip selected in the editor). */
  preferredSourceId?: string;
}

/** Installed models that can run Lego (pure base models), the active one first. */
export function pickLegoModels(models: { name: string; is_active?: boolean; is_preloaded?: boolean }[]): string[] {
  const ok = models.filter((m) => isPureBaseModel(m.name) && m.is_preloaded !== false);
  return [...ok.filter((m) => m.is_active), ...ok.filter((m) => !m.is_active)].map((m) => m.name);
}

/** Stems of one song share a long beginning: keep the end of the name, where they differ. */
export function shortTitle(title: string, max = 32): string {
  return title.length <= max ? title : `…${title.slice(-(max - 1))}`;
}

export const StudioInstrumentPanel: React.FC<Props> = ({ sources, tf, onGenerate, onResult, getEditorRegion, preferredSourceId }) => {
  const [models, setModels] = useState<string[] | null>(null);
  const [model, setModel] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [trackName, setTrackName] = useState<string>('keyboard');
  const [style, setStyle] = useState('');
  const [guidance, setGuidance] = useState(5);
  const [bpm, setBpm] = useState('');
  const [keyScale, setKeyScale] = useState('');
  const [seed, setSeed] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | undefined>(undefined);
  const [phase, setPhase] = useState<string | undefined>(undefined);
  const [regionStart, setRegionStart] = useState('');
  const [regionEnd, setRegionEnd] = useState('');
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

  // Follow the clip selected in the editor.
  useEffect(() => {
    if (preferredSourceId) setSourceId(preferredSourceId);
  }, [preferredSourceId]);

  const source = useMemo(() => sources.find((s) => s.id === sourceId) ?? sources[sources.length - 1], [sources, sourceId]);

  // The tempo and key of the chosen song fill the fields; they can be corrected (a wrong value there spoils Lego).
  const sourceKey = source?.id;
  useEffect(() => {
    setBpm(source?.bpm ? String(source.bpm) : '');
    setKeyScale(source?.keyScale || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey]);

  const sourceSeconds = source ? durationToSeconds(source.duration) : 0;
  const regionOf = (): { start: number; end: number } | undefined => {
    const a = Math.max(0, Number(regionStart.replace(',', '.')) || 0);
    const b = Number(regionEnd.replace(',', '.')) || 0;
    if (b <= a) return undefined;
    if (a <= 0.05 && sourceSeconds > 0 && b >= sourceSeconds - 0.1) return undefined;
    return { start: a, end: sourceSeconds > 0 ? Math.min(b, sourceSeconds) : b };
  };
  const region = regionOf();

  const useEditorSelection = () => {
    const r = getEditorRegion?.();
    if (!r) { setError(tf('studioInstrumentNoSelection', 'Nothing is selected in the editor: drag over the waveform, or click a clip.')); return; }
    setError(null);
    setRegionStart(r.start.toFixed(1));
    setRegionEnd(r.end.toFixed(1));
  };

  const run = async () => {
    if (!source || !model || busy) return;
    setError(null);
    setBusy(true);
    setProgress(undefined);
    setPhase(undefined);
    try {
      const urls = await onGenerate({ song: source, trackName, style: style.trim(), model, guidance, region, bpm: Number(bpm) > 0 ? Number(bpm) : undefined, keyScale: keyScale.trim() || undefined, seed: seed.trim() !== '' && Number.isFinite(Number(seed)) ? Math.max(0, Math.floor(Number(seed))) : undefined, onProgress: (p, stage) => { setProgress(p); setPhase(stage); } });
      if (urls.length === 0) throw new Error('no audio');
      await onResult(source, trackName, urls, region);
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
        <p className="mt-2 text-[11px] text-zinc-500 dark:text-zinc-400">{tf('studioInstrumentNoSource', 'Add a song or load an audio file in the editor first.')}</p>
      ) : (
        <>
          <label className={label}>{tf('studioInstrumentSource', 'Song')}</label>
          <select className={field} value={source?.id ?? ''} onChange={(e) => setSourceId(e.target.value)} disabled={busy}>
            {sources.map((s) => <option key={s.id} value={s.id} title={s.title}>{shortTitle(s.title)}</option>)}
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
          <label className={label}>{tf('studioInstrumentRegion', 'Part of the song (seconds, empty = whole song)')}</label>
          <div className="flex gap-1.5 items-center">
            <input type="text" inputMode="decimal" className={field} value={regionStart} onChange={(e) => setRegionStart(e.target.value)} placeholder={tf('studioInstrumentFrom', 'from')} disabled={busy} />
            <input type="text" inputMode="decimal" className={field} value={regionEnd} onChange={(e) => setRegionEnd(e.target.value)} placeholder={tf('studioInstrumentTo', 'to')} disabled={busy} />
            <button type="button" onClick={useEditorSelection} disabled={busy} title={tf('studioInstrumentUseSelection', 'Use the selected range, or the selected clip')} className="flex-shrink-0 px-2 py-1.5 text-[11px] rounded-lg border border-zinc-200 dark:border-white/10 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-white/5 disabled:opacity-60">
              {tf('studioInstrumentUseSelectionShort', 'Selection')}
            </button>
          </div>
          {region && (
            <p className="mt-1 text-[10px] leading-snug text-zinc-500 dark:text-zinc-400">
              {tf('studioInstrumentRegionNote', 'Only this part is generated; the new track is placed at its start.')}
            </p>
          )}
          <div className="flex gap-1.5">
            <div className="w-14">
              <label className={label}>{tf('studioInstrumentBpm', 'BPM')}</label>
              <input type="text" inputMode="numeric" className={field} value={bpm} onChange={(e) => setBpm(e.target.value)} placeholder="auto" disabled={busy} />
            </div>
            <div className="flex-1 min-w-0">
              <label className={label}>{tf('studioInstrumentKey', 'Key')}</label>
              <input type="text" className={field} value={keyScale} onChange={(e) => setKeyScale(e.target.value)} placeholder="G major" disabled={busy} />
            </div>
            <div className="w-24">
              <label className={label}>{tf('studioInstrumentSeed', 'Seed')}</label>
              <input type="text" inputMode="numeric" className={field} value={seed} onChange={(e) => setSeed(e.target.value)} placeholder={tf('studioInstrumentSeedRandom', 'random')} disabled={busy} />
            </div>
          </div>
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
              ? (phase === 'upload'
                ? tf('studioInstrumentUploading', 'Sending the clip…')
                : phase === 'model'
                ? tf('studioInstrumentLoadingModel', 'Loading the Base model…')
                : `${tf('studioInstrumentRunning', 'Generating…')}${progress != null ? ` ${Math.round(progress * 100)} %` : ''}`)
              : tf('studioInstrumentGenerate', 'Generate and add as a track')}
          </button>
          {error && <p className="mt-2 text-[11px] text-red-500">{error}</p>}
        </>
      )}
    </div>
  );
};
