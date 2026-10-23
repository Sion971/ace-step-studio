import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, Plus, Check, Music } from 'lucide-react';
import { Song } from '../types';
import { useI18n } from '../context/I18nContext';
import type { TranslationKey } from '../i18n/translations';
import { addTrackToEditor, editorFileName, getEditorRegion, listEditorClipNames, syncEditorEntries, trimAudioToWav, waitForEditor } from './studioBridge';
import type { EditorEntry } from './studioBridge';
import { StudioInstrumentPanel } from './StudioInstrumentPanel';
import type { StudioInstrumentRequest } from './StudioInstrumentPanel';
import { TRACK_LABELS } from './TrackPicker';

export type { StudioInstrumentRequest };

interface StudioWorkspace {
  id: string;
  name: string;
}

interface StudioPageProps {
  songs: Song[];
  /** Named workspaces; the default one ("My Workspace") is virtual and handled here. */
  workspaces?: StudioWorkspace[];
  /** Ids of the songs that belong to a named workspace (the default workspace is what is left over). */
  songsInAnyWorkspace?: Set<string>;
  /** Loads the songs of one named workspace. */
  loadWorkspaceSongs?: (workspaceId: string) => Promise<Song[]>;
  /** Runs Lego on a song and resolves with the audio URL(s) of the new track. */
  onGenerateInstrument?: (req: StudioInstrumentRequest) => Promise<string[]>;
}

const SCOPE_ALL = '__all__';
const SCOPE_DEFAULT = '__default__';

const asText = (v: unknown): string => (Array.isArray(v) ? v.join(' ') : v == null ? '' : String(v));

/** Songs that can be opened in the editor: finished, with an audio file. Newest first. */
export function filterStudioSongs(songs: Song[], query: string): Song[] {
  const q = query.trim().toLowerCase();
  return songs
    .filter((s) => !s.isGenerating && !!s.audioUrl)
    .filter((s) => !q || `${asText(s.title)} ${asText(s.style)} ${asText(s.tags)}`.toLowerCase().includes(q))
    .sort((a, b) => (new Date(b.createdAt).getTime() || 0) - (new Date(a.createdAt).getTime() || 0));
}

export const StudioPage: React.FC<StudioPageProps> = ({ songs, workspaces = [], songsInAnyWorkspace, loadWorkspaceSongs, onGenerateInstrument }) => {
  const { t } = useI18n();
  const tf = useCallback((key: string, fallback: string): string => {
    const value = t(key as TranslationKey);
    return !value || value === key ? fallback : value;
  }, [t]);

  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<string>(SCOPE_ALL);
  const [workspaceSongs, setWorkspaceSongs] = useState<Song[] | null>(null);
  const [entries, setEntries] = useState<(EditorEntry & { songId: string })[]>([]);
  const [loaded, setLoaded] = useState<Song[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (scope === SCOPE_ALL || scope === SCOPE_DEFAULT || !loadWorkspaceSongs) {
      setWorkspaceSongs(null);
      return;
    }
    let cancelled = false;
    setWorkspaceSongs(null);
    loadWorkspaceSongs(scope)
      .then((res) => { if (!cancelled) setWorkspaceSongs(res); })
      .catch((e) => { console.error('[Studio] could not load the workspace songs', e); if (!cancelled) setWorkspaceSongs([]); });
    return () => { cancelled = true; };
  }, [scope, loadWorkspaceSongs]);

  const scoped = useMemo(() => {
    if (scope === SCOPE_ALL) return songs;
    if (scope === SCOPE_DEFAULT) return songs.filter((s) => !songsInAnyWorkspace?.has(s.id));
    return workspaceSongs ?? [];
  }, [scope, songs, songsInAnyWorkspace, workspaceSongs]);

  const list = useMemo(() => filterStudioSongs(scoped, query).slice(0, 100), [scoped, query]);

  // Keep the green marks in step with what is really on the editor's timeline.
  useEffect(() => {
    const timer = setInterval(() => {
      const names = listEditorClipNames(frameRef.current);
      if (!names) return;
      setEntries((prev) => {
        if (prev.length === 0) return prev;
        const next = syncEditorEntries(prev, names, Date.now()) as (EditorEntry & { songId: string })[];
        const same = next.length === prev.length && next.every((e, i) => e === prev[i]);
        return same ? prev : next;
      });
    }, 800);
    return () => clearInterval(timer);
  }, []);

  const sources = useMemo(
    () => loaded.filter((l) => entries.some((e) => e.songId === l.id)),
    [loaded, entries],
  );

  // A generated track goes on the timeline like any file; its mark is not tied to a song of the list.
  const addGenerated = useCallback(async (song: Song, trackName: string, urls: string[], region?: { start: number; end: number }) => {
    const name = tf(TRACK_LABELS[trackName as keyof typeof TRACK_LABELS]?.[0] ?? '', trackName);
    const api = await waitForEditor(frameRef.current);
    for (const url of urls) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      let blob = await res.blob();
      let fileName = editorFileName(`${song.title} - ${name}`, url);
      if (region) {
        // The engine hands back the whole length: keep only the part that was asked for, and place it where it belongs.
        blob = await trimAudioToWav(blob, region.start, region.end);
        fileName = editorFileName(`${song.title} - ${name} (${Math.round(region.start)}-${Math.round(region.end)} s)`, '.wav');
      }
      const file = new File([blob], fileName, { type: blob.type });
      if (!api || !addTrackToEditor(frameRef.current, file, region?.start ?? 0)) throw new Error('editor not ready');
      await new Promise((r) => setTimeout(r, 600));
    }
  }, [tf]);

  const addSong = useCallback(async (song: Song) => {
    if (!song.audioUrl || busyId) return;
    setError(null);
    setBusyId(song.id);
    try {
      const res = await fetch(song.audioUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const file = new File([blob], editorFileName(song.title, song.audioUrl), { type: blob.type });
      const api = await waitForEditor(frameRef.current);
      if (!api || !addTrackToEditor(frameRef.current, file)) throw new Error('editor not ready');
      setEntries((prev) => [...prev, { id: `${song.id}:${Date.now()}`, songId: song.id, name: file.name, addedAt: Date.now(), seen: false }]);
      setLoaded((prev) => (prev.some((x) => x.id === song.id) ? prev : [...prev, song]));
    } catch (e) {
      console.error('[Studio] could not add the song to the editor', e);
      setError(tf('studioLoadError', 'Could not load this song into the editor.'));
    } finally {
      setBusyId(null);
    }
  }, [busyId, tf]);

  return (
    <div className="flex flex-col md:flex-row h-full min-h-0 w-full bg-white dark:bg-suno-panel">
      <aside className="md:w-80 md:flex-shrink-0 max-h-72 md:max-h-none flex flex-col border-b md:border-b-0 md:border-r border-zinc-200 dark:border-white/5 min-h-0">
        <div className="p-3 border-b border-zinc-200 dark:border-white/5">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={tf('studioSearchPlaceholder', 'Search your songs…')}
              className="w-full pl-8 pr-3 py-2 text-sm rounded-lg bg-zinc-100 dark:bg-black/30 border border-zinc-200 dark:border-white/10 text-zinc-900 dark:text-white placeholder-zinc-400 focus:outline-none focus:border-pink-500"
            />
          </div>
          {(workspaces.length > 0 || loadWorkspaceSongs) && (
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              className="mt-2 w-full px-2 py-1.5 text-xs rounded-lg bg-zinc-100 dark:bg-black/30 border border-zinc-200 dark:border-white/10 text-zinc-900 dark:text-white focus:outline-none focus:border-pink-500"
            >
              <option value={SCOPE_ALL}>{tf('studioAllSongs', 'All my songs')}</option>
              <option value={SCOPE_DEFAULT}>{tf('myWorkspace', 'My Workspace')}</option>
              {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          )}
          <p className="mt-2 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
            {tf('studioHint', 'Pick a song to open it in the editor, then pick others to stack them as tracks.')}
          </p>
          {error && <p className="mt-2 text-[11px] text-red-500">{error}</p>}
        </div>

        <ul className="flex-1 overflow-y-auto min-h-0 divide-y divide-zinc-100 dark:divide-white/5">
          {list.length === 0 && (
            <li className="p-4 text-sm text-zinc-500 text-center">{tf('studioEmpty', 'No song found')}</li>
          )}
          {list.map((song) => {
            const added = entries.some((e) => e.songId === song.id);
            const busy = busyId === song.id;
            return (
              <li key={song.id}>
                <button
                  type="button"
                  onClick={() => addSong(song)}
                  disabled={!!busyId}
                  title={tf('studioAddTrack', 'Add to the editor as a new track')}
                  className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-zinc-50 dark:hover:bg-white/5 disabled:opacity-60 disabled:cursor-wait"
                >
                  {song.coverUrl ? (
                    <img src={song.coverUrl} alt="" className="w-10 h-10 rounded object-cover flex-shrink-0 bg-zinc-200 dark:bg-white/10" />
                  ) : (
                    <span className="w-10 h-10 rounded flex items-center justify-center flex-shrink-0 bg-zinc-200 dark:bg-white/10 text-zinc-400"><Music size={16} /></span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-zinc-900 dark:text-white truncate">{song.title}</span>
                    <span className="block text-[11px] text-zinc-500 dark:text-zinc-400 truncate">{song.style}</span>
                  </span>
                  <span className="text-[10px] text-zinc-400 tabular-nums flex-shrink-0">{song.duration}</span>
                  {busy ? (
                    <span className="w-4 h-4 border-2 border-pink-500 border-t-transparent rounded-full animate-spin flex-shrink-0" />
                  ) : added ? (
                    <Check size={16} className="text-emerald-500 flex-shrink-0" aria-label={tf('studioInEditor', 'In the editor')} />
                  ) : (
                    <Plus size={16} className="text-zinc-400 flex-shrink-0" />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
        {onGenerateInstrument && (
          <StudioInstrumentPanel sources={sources} tf={tf} onGenerate={onGenerateInstrument} onResult={addGenerated} getEditorRegion={() => getEditorRegion(frameRef.current)} />
        )}
      </aside>

      <section className="flex-1 min-w-0 min-h-[420px] md:min-h-0">
        <iframe
          ref={frameRef}
          src="/editor/?multitrack=1"
          title="Studio editor"
          className="w-full h-full border-0 bg-black"
        />
      </section>
    </div>
  );
};
