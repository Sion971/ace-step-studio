import React, { useCallback, useEffect, useRef, useState } from 'react';
import { editorHasClips, getEditorSession, loadEditorSession } from './studioBridge';

export interface StudioProjectItem {
  id: string;
  name: string;
  size: number;
  updatedAt: string;
}

/** What the panel needs from the server (the token is already bound by the caller). */
export interface StudioProjectsApi {
  list: () => Promise<StudioProjectItem[]>;
  save: (file: Blob, name: string | undefined, id?: string) => Promise<StudioProjectItem>;
  load: (id: string) => Promise<ArrayBuffer>;
  remove: (id: string) => Promise<void>;
}

interface StudioProjectsPanelProps {
  tf: (key: string, fallback: string) => string;
  api: StudioProjectsApi;
  getFrame: () => HTMLIFrameElement | null;
  /** Told whenever a save, an opening or a deletion starts or ends. */
  onBusyChange?: (busy: boolean) => void;
  /** Told the name of the project that is open in the editor (null when none). */
  onCurrentChange?: (name: string | null) => void;
}

const sizeLabel = (bytes: number): string => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const dateLabel = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
};

/**
 * Projects of the Studio tab: the session of the editor (tracks, clips, volumes, pans, fades, markers) is stored by the
 * server, and can be reopened, replaced or deleted from here. The editor's own "save session" only downloads a file.
 */
export const StudioProjectsPanel: React.FC<StudioProjectsPanelProps> = ({ tf, api, getFrame, onBusyChange, onCurrentChange }) => {
  const [projects, setProjects] = useState<StudioProjectItem[]>([]);
  const [name, setName] = useState('');
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const list = await api.list();
      if (alive.current) setProjects(list);
    } catch (e) {
      console.error('[Studio] could not list the projects', e);
    }
  }, [api]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => { alive.current = false; };
  }, [refresh]);

  const run = async (job: () => Promise<string | void>) => {
    setMessage(null);
    setBusy(true);
    try {
      const done = await job();
      if (done) setMessage({ kind: 'ok', text: done });
    } catch (e) {
      console.error('[Studio] project action failed', e);
      setMessage({ kind: 'error', text: tf('studioProjectError', 'The action failed.') });
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  /** Saves the editor's session: as a new project, or over the project `id`. */
  const save = (id?: string) => run(async () => {
    const file = getEditorSession(getFrame());
    if (!file) { setMessage({ kind: 'error', text: tf('studioProjectEmpty', 'Nothing to save: add a track to the editor first.') }); return; }
    const typed = name.trim();
    const saved = await api.save(file, id ? undefined : typed || undefined, id);
    setCurrentId(saved.id);
    if (!id) setName('');
    await refresh();
    return tf('studioProjectSaved', 'Project saved:') + ' ' + saved.name;
  });

  const open = (p: StudioProjectItem) => run(async () => {
    if (editorHasClips(getFrame()) && !window.confirm(tf('studioProjectReplace', 'Opening a project replaces what is in the editor. Continue?'))) return;
    const data = await api.load(p.id);
    if (!loadEditorSession(getFrame(), data, p.name)) {
      setMessage({ kind: 'error', text: tf('studioProjectNotLoaded', 'The editor could not open this project.') });
      return;
    }
    setCurrentId(p.id);
    return tf('studioProjectOpened', 'Project opened:') + ' ' + p.name;
  });

  const remove = (p: StudioProjectItem) => run(async () => {
    if (!window.confirm(tf('studioProjectDeleteAsk', 'Delete this project for good?') + '\n' + p.name)) return;
    await api.remove(p.id);
    if (currentId === p.id) setCurrentId(null);
    await refresh();
  });

  const current = projects.find((p) => p.id === currentId) || null;
  const currentName = current ? current.name : null;
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  useEffect(() => { onCurrentChange?.(currentName); }, [currentName, onCurrentChange]);
  const field = 'w-full px-2 py-1.5 text-xs rounded-lg bg-zinc-100 dark:bg-black/30 border border-zinc-200 dark:border-white/10 text-zinc-900 dark:text-white focus:outline-none focus:border-pink-500';
  const small = 'px-1.5 py-0.5 text-[10px] rounded border border-zinc-300 dark:border-white/15 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-white/10 disabled:opacity-50';

  return (
    <div className="p-3" data-testid="studio-projects-panel">
      <p className="text-[11px] font-semibold text-zinc-700 dark:text-zinc-200">{tf('studioProjectsTitle', 'Projects')}</p>
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={tf('studioProjectName', 'Project name')}
        disabled={busy}
        className={`mt-2 ${field}`}
        data-testid="studio-project-name"
      />
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={() => save()}
          disabled={busy}
          data-testid="studio-project-save-new"
          className="flex-1 py-1.5 text-xs font-semibold rounded-lg bg-pink-500 hover:bg-pink-600 text-white disabled:opacity-60"
        >
          {tf('studioProjectSaveNew', 'Save as a new project')}
        </button>
        {current && (
          <button
            type="button"
            onClick={() => save(current.id)}
            disabled={busy}
            data-testid="studio-project-save-current"
            title={current.name}
            className="flex-1 py-1.5 text-xs font-semibold rounded-lg border border-pink-500 text-pink-600 dark:text-pink-300 hover:bg-pink-500/10 disabled:opacity-60 truncate"
          >
            {tf('studioProjectSaveCurrent', 'Update')} « {current.name} »
          </button>
        )}
      </div>
      {message && (
        <p className={`mt-2 text-[11px] ${message.kind === 'ok' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'}`} data-testid="studio-project-message">{message.text}</p>
      )}
      {projects.length === 0 ? (
        <p className="mt-2 text-[11px] text-zinc-500">{tf('studioProjectNone', 'No project yet.')}</p>
      ) : (
        <ul className="mt-2 max-h-40 overflow-y-auto space-y-1" data-testid="studio-project-list">
          {projects.map((p) => (
            <li key={p.id} className={`rounded-lg px-2 py-1.5 text-[11px] border ${p.id === currentId ? 'border-pink-500/60 bg-pink-500/5' : 'border-zinc-200 dark:border-white/10'}`} data-testid="studio-project-item">
              <div className="font-medium text-zinc-800 dark:text-zinc-100 truncate" title={p.name}>{p.name}</div>
              <div className="text-zinc-500 dark:text-zinc-400">{dateLabel(p.updatedAt)} · {sizeLabel(p.size)}</div>
              <div className="mt-1 flex gap-1">
                <button type="button" className={small} disabled={busy} onClick={() => open(p)} data-testid="studio-project-open">{tf('studioProjectOpen', 'Open')}</button>
                <button type="button" className={small} disabled={busy} onClick={() => save(p.id)} data-testid="studio-project-overwrite">{tf('studioProjectOverwrite', 'Replace')}</button>
                <button type="button" className={`${small} ml-auto`} disabled={busy} onClick={() => remove(p)} data-testid="studio-project-delete">{tf('studioProjectDelete', 'Delete')}</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
