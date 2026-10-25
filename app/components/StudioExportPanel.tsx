import React, { useState } from 'react';
import { exportEditorMix } from './studioBridge';

interface StudioExportPanelProps {
  tf: (key: string, fallback: string) => string;
  /** Saves the mix as a song of the library. */
  onExport: (file: File, title: string, duration: number) => Promise<void>;
  /** The iframe of the editor. */
  getFrame: () => HTMLIFrameElement | null;
  /** The range selected in the editor (a dragged region, or the selected clip), or null. */
  getRegion: () => { start: number; end: number; from?: string } | null;
}

const defaultTitle = (): string => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `Studio mix ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/**
 * "Export to the library": mixes the timeline of the editor as it sounds (volumes, pans, mutes, solos) and saves it as a new
 * song, found afterwards in the song list like any other. The editor's own File > Export only downloads a file.
 */
export const StudioExportPanel: React.FC<StudioExportPanelProps> = ({ tf, onExport, getFrame, getRegion }) => {
  const [title, setTitle] = useState('');
  const [rangeOnly, setRangeOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const run = async () => {
    setMessage(null);
    const name = title.trim() || defaultTitle();
    let range: { start: number; end: number } | undefined;
    if (rangeOnly) {
      const r = getRegion();
      if (!r || r.end <= r.start) { setMessage({ kind: 'error', text: tf('studioExportNoRange', 'Select a range in the editor first.') }); return; }
      range = { start: r.start, end: r.end };
    }
    setBusy(true);
    try {
      const mix = await exportEditorMix(getFrame(), `${name}.wav`, range);
      if (!mix) { setMessage({ kind: 'error', text: tf('studioExportEmpty', 'Nothing to export: add a track to the editor first.') }); return; }
      await onExport(mix.file, name, mix.duration);
      setTitle('');
      setMessage({ kind: 'ok', text: tf('studioExportDone', 'Added to your library:') + ' ' + name });
    } catch (e) {
      console.error('[Studio] could not export the mix', e);
      setMessage({ kind: 'error', text: tf('studioExportError', 'The mix could not be exported.') });
    } finally {
      setBusy(false);
    }
  };

  const field = 'w-full px-2 py-1.5 text-xs rounded-lg bg-zinc-100 dark:bg-black/30 border border-zinc-200 dark:border-white/10 text-zinc-900 dark:text-white focus:outline-none focus:border-pink-500';
  return (
    <div className="p-3 border-t border-zinc-200 dark:border-white/5" data-testid="studio-export-panel">
      <p className="text-[11px] font-semibold text-zinc-700 dark:text-zinc-200">{tf('studioExportTitle', 'Export the mix to the library')}</p>
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={tf('studioExportName', 'Title (optional)')}
        disabled={busy}
        className={`mt-2 ${field}`}
        data-testid="studio-export-title"
      />
      <label className="mt-2 flex items-center gap-2 text-[11px] text-zinc-600 dark:text-zinc-300">
        <input type="checkbox" checked={rangeOnly} onChange={(e) => setRangeOnly(e.target.checked)} disabled={busy} />
        {tf('studioExportRange', 'Selected range only')}
      </label>
      <button
        type="button"
        onClick={run}
        disabled={busy}
        data-testid="studio-export-button"
        className="mt-2 w-full py-2 text-xs font-semibold rounded-lg bg-pink-500 hover:bg-pink-600 text-white disabled:opacity-60 disabled:cursor-wait"
      >
        {busy ? tf('studioExportBusy', 'Exporting...') : tf('studioExportButton', 'Export to the library')}
      </button>
      {message && (
        <p className={`mt-2 text-[11px] ${message.kind === 'ok' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'}`} data-testid="studio-export-message">{message.text}</p>
      )}
    </div>
  );
};
