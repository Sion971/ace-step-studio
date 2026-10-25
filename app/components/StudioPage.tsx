import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, Plus, Check, Music, Trash2 } from 'lucide-react';
import { Song } from '../types';
import { useI18n } from '../context/I18nContext';
import type { TranslationKey } from '../i18n/translations';
import { addTrackToEditor, editorFileName, exportEditorClip, formatDuration, getEditorRegion, listEditorClipNames, listEditorClips, syncEditorEntries, trimAudioToWav, waitForEditor } from './studioBridge';
import type { EditorClip, EditorEntry } from './studioBridge';
import { StudioInstrumentPanel } from './StudioInstrumentPanel';
import type { StudioInstrumentRequest } from './StudioInstrumentPanel';
import { TRACK_LABELS } from './TrackPicker';
import { getModelDisplayName } from '../utils/modelNames';
import type { StudioIncoming } from './openInStudio';

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
  /** Deletes songs (asks for confirmation itself). */
  onDeleteSongs?: (songs: Song[]) => void;
  /** Uploads an audio file and resolves with the URL the generation can use as a source. */
  uploadAudio?: (file: File) => Promise<string>;
  /** Audio sent from elsewhere ("Edit the audio", "Open all in the editor"): put on the timeline once the editor is ready. */
  incoming?: StudioIncoming | null;
  /** Called when the incoming audio has been handled, so the request is not replayed. */
  onIncomingDone?: () => void;
}

const STUDIO_PAGE = 100;
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

export const StudioPage: React.FC<StudioPageProps> = ({ songs, workspaces = [], songsInAnyWorkspace, loadWorkspaceSongs, onGenerateInstrument, onDeleteSongs, uploadAudio, incoming, onIncomingDone }) => {
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
  const [editorClips, setEditorClips] = useState<EditorClip[]>([]);
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());

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

  const matches = useMemo(() => filterStudioSongs(scoped, query), [scoped, query]);
  // The list is newest first: a cap with no way past it hid the older songs (made with earlier models).
  const [shown, setShown] = useState(STUDIO_PAGE);
  useEffect(() => { setShown(STUDIO_PAGE); }, [scope, query]);
  const list = useMemo(() => matches.slice(0, shown), [matches, shown]);

  // Songs that are gone (deleted) leave the selection.
  useEffect(() => {
    setPicked((prev) => {
      if (prev.size === 0) return prev;
      const ids = new Set(songs.map((x) => x.id));
      const next = new Set(Array.from(prev).filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [songs]);

  const togglePicked = (id: string) =>
    setPicked((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const stopSelecting = () => { setSelecting(false); setPicked(new Set()); };
  const deletePicked = () => {
    const chosen = songs.filter((x) => picked.has(x.id));
    if (chosen.length > 0) onDeleteSongs?.(chosen);
  };

  // Keep the green marks in step with what is really on the editor's timeline.
  useEffect(() => {
    const timer = setInterval(() => {
      const clips = listEditorClips(frameRef.current);
      if (clips) setEditorClips((prev) => (JSON.stringify(prev) === JSON.stringify(clips) ? prev : clips));
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

  // The songs added from the list, plus any other clip on the timeline (a file loaded with File > Load from computer, a stem...).
  const sources = useMemo(() => {
    const fromList = loaded.filter((l) => entries.some((e) => e.songId === l.id));
    const known = new Set(entries.map((e) => e.name));
    const others = editorClips
      .filter((c) => !known.has(c.name))
      .map((c): Song => ({
        id: `clip:${c.id}`, title: c.name.replace(/\.[a-z0-9]{2,5}$/i, ''), lyrics: '', style: '', coverUrl: '',
        duration: formatDuration(c.duration), createdAt: new Date(), tags: [], audioUrl: '',
        ...({ clipId: c.id } as object),
      }));
    return [...fromList, ...others];
  }, [loaded, entries, editorClips]);

  // The clip selected in the editor is the one the panel works on (the yellow border), whatever was picked before.
  const preferredSourceId = useMemo(() => {
    const sel = editorClips.find((c) => c.selected);
    if (!sel) return undefined;
    const entry = entries.find((e) => e.name === sel.name);
    return entry ? entry.songId : `clip:${sel.id}`;
  }, [editorClips, entries]);

  // A clip that is not a song of the library is sent to the server first, as the source of the generation.
  const generateInstrument = useCallback(async (req: StudioInstrumentRequest): Promise<string[]> => {
    if (!onGenerateInstrument) return [];
    const clipId = (req.song as Song & { clipId?: string }).clipId;
    if (!clipId) return onGenerateInstrument(req);
    if (!uploadAudio) throw new Error('upload not available');
    const file = exportEditorClip(frameRef.current, clipId, `${req.song.title}.wav`);
    if (!file) throw new Error('clip not found in the editor');
    req.onProgress?.(undefined, 'upload');
    const url = await uploadAudio(file);
    return onGenerateInstrument({ ...req, song: { ...req.song, audioUrl: url } });
  }, [onGenerateInstrument, uploadAudio]);

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

  // Audio sent from another page: one track each, in order (the editor takes one file at a time). The request is replayed
  // neither on a re-render (handled id) nor cut short by one (callbacks go through refs); only leaving the tab stops it.
  const handledIncoming = useRef<number | null>(null);
  const incomingDoneRef = useRef(onIncomingDone);
  incomingDoneRef.current = onIncomingDone;
  const tfRef = useRef(tf);
  tfRef.current = tf;
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!incoming || handledIncoming.current === incoming.id) return;
    handledIncoming.current = incoming.id;
    (async () => {
      setError(null);
      try {
        const api = await waitForEditor(frameRef.current);
        if (!api) throw new Error('editor not ready');
        for (const item of incoming.items) {
          if (!alive.current) return;
          const res = await fetch(item.url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const blob = await res.blob();
          const file = new File([blob], editorFileName(item.name, item.url), { type: blob.type });
          if (!addTrackToEditor(frameRef.current, file)) throw new Error('editor not ready');
          if (item.song) {
            const song = item.song;
            setEntries((prev) => [...prev, { id: `${song.id}:${Date.now()}`, songId: song.id, name: file.name, addedAt: Date.now(), seen: false }]);
            setLoaded((prev) => (prev.some((x) => x.id === song.id) ? prev : [...prev, song]));
          }
          await new Promise((r) => setTimeout(r, 600));
        }
      } catch (e) {
        console.error('[Studio] could not open the audio in the editor', e);
        if (alive.current) setError(tfRef.current('studioLoadError', 'Could not load this song into the editor.'));
      } finally {
        incomingDoneRef.current?.();
      }
    })();
  }, [incoming]);

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
          <div className="mt-1 flex items-center justify-between gap-2">
            <p className="text-[10px] text-zinc-400 tabular-nums">{matches.length} {tf('studioSongCount', 'songs')}</p>
            {onDeleteSongs && (
              <button type="button" onClick={() => (selecting ? stopSelecting() : setSelecting(true))} className="text-[11px] text-pink-500 hover:underline">
                {selecting ? tf('studioSelectDone', 'Done') : tf('studioSelect', 'Select')}
              </button>
            )}
          </div>
          {selecting && (
            <div className="mt-1.5 flex items-center gap-2">
              <button type="button" onClick={() => setPicked(new Set(list.map((x) => x.id)))} className="text-[11px] text-zinc-600 dark:text-zinc-300 hover:underline">
                {tf('studioSelectAll', 'Select all shown')}
              </button>
              <button
                type="button"
                onClick={deletePicked}
                disabled={picked.size === 0}
                className="ml-auto flex items-center gap-1 px-2 py-1 text-[11px] rounded-lg bg-red-500 text-white hover:bg-red-600 disabled:opacity-40"
              >
                <Trash2 size={12} /> {tf('studioDeleteSelected', 'Delete')} ({picked.size})
              </button>
            </div>
          )}
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
                  onClick={() => (selecting ? togglePicked(song.id) : addSong(song))}
                  disabled={!selecting && !!busyId}
                  title={tf('studioAddTrack', 'Add to the editor as a new track')}
                  className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-zinc-50 dark:hover:bg-white/5 disabled:opacity-60 disabled:cursor-wait"
                >
                  {selecting && (
                    <input type="checkbox" readOnly checked={picked.has(song.id)} className="flex-shrink-0 accent-pink-500 pointer-events-none" aria-label={song.title} />
                  )}
                  {song.coverUrl ? (
                    <img src={song.coverUrl} alt="" className="w-10 h-10 rounded object-cover flex-shrink-0 bg-zinc-200 dark:bg-white/10" />
                  ) : (
                    <span className="w-10 h-10 rounded flex items-center justify-center flex-shrink-0 bg-zinc-200 dark:bg-white/10 text-zinc-400"><Music size={16} /></span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-zinc-900 dark:text-white truncate">{song.title}</span>
                    <span className="block text-[11px] text-zinc-500 dark:text-zinc-400 truncate">{song.ditModel ? `${getModelDisplayName(song.ditModel)} · ` : ''}{song.style}</span>
                  </span>
                  <span className="text-[10px] text-zinc-400 tabular-nums flex-shrink-0">{song.duration}</span>
                  {selecting ? null : busy ? (
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
          {matches.length > list.length && (
            <li className="p-2">
              <button
                type="button"
                onClick={() => setShown((n) => n + STUDIO_PAGE)}
                className="w-full py-2 text-xs rounded-lg border border-zinc-200 dark:border-white/10 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-white/5"
              >
                {tf('studioShowMore', 'Show more')} ({matches.length - list.length})
              </button>
            </li>
          )}
        </ul>
        {onGenerateInstrument && (
          <StudioInstrumentPanel sources={sources} tf={tf} onGenerate={generateInstrument} onResult={addGenerated} getEditorRegion={() => getEditorRegion(frameRef.current)} preferredSourceId={preferredSourceId} />
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
