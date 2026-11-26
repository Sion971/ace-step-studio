// "My styles" in the header of the Style box: save the style written there (bookmark), and a window listing the styles
// saved, to search, put one back in the box, rename or delete it. The styles are kept on the server per user
// (savedStylesApi); the same text saved twice is one style, moved back to the top.
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bookmark, BookmarkCheck, Library, Loader2, Music2, Pencil, Search, Trash2 } from 'lucide-react';
import { savedStylesApi, type SavedStyle } from '../services/api';
import { useI18n } from '../context/I18nContext';

interface SavedStylesButtonsProps {
  style: string;
  token: string | null;
  onPick: (style: string) => void;
}

/** "2 days ago", in the language of the Studio. The server writes UTC times as "YYYY-MM-DD HH:MM:SS(.sss)". */
export function timeAgo(utc: string, language: string, now = Date.now()): string {
  const then = Date.parse(`${utc.replace(' ', 'T')}Z`);
  if (!Number.isFinite(then)) return '';
  const seconds = Math.round((then - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [unit, size] of steps) if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  return rtf.format(0, 'second');
}

export const SavedStylesButtons: React.FC<SavedStylesButtonsProps> = ({ style, token, onPick }) => {
  const { t, language } = useI18n();
  const [open, setOpen] = useState(false);
  const [styles, setStyles] = useState<SavedStyle[] | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [position, setPosition] = useState<{ top: number; right: number }>({ top: 0, right: 0 });
  const libraryButtonRef = useRef<HTMLButtonElement>(null);
  const windowRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      setError(null);
      setStyles(await savedStylesApi.list(token));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStyles([]);
    }
  }, [token]);

  const save = async () => {
    if (!token || !style.trim() || saving) return;
    setSaving(true);
    try {
      setError(null);
      await savedStylesApi.save(style, token);
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 2000);
      if (open) await load();
    } catch (e) {
      setError(`${t('saveStyleFailed')} ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  // The window opens under the button, outside the Style box (which clips what overflows it).
  useLayoutEffect(() => {
    if (!open || !libraryButtonRef.current) return;
    const r = libraryButtonRef.current.getBoundingClientRect();
    setPosition({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
  }, [open]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (windowRef.current?.contains(target) || libraryButtonRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const remove = async (id: string) => {
    if (!token) return;
    try {
      await savedStylesApi.remove(id, token);
      setStyles(prev => (prev ?? []).filter(s => s.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const commitRename = async () => {
    if (!token || !renaming) return;
    const name = renaming.name.trim();
    setRenaming(null);
    if (!name) return;
    try {
      const updated = await savedStylesApi.rename(renaming.id, name, token);
      setStyles(prev => (prev ?? []).map(s => (s.id === updated.id ? updated : s)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const q = query.trim().toLowerCase();
  const shown = (styles ?? []).filter(s => !q || s.name.toLowerCase().includes(q) || s.style.toLowerCase().includes(q));
  const iconButton = 'p-1.5 hover:bg-zinc-200 dark:hover:bg-white/10 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed';

  return (
    <>
      <button
        ref={libraryButtonRef}
        type="button"
        className={`${iconButton} ${open ? 'text-pink-500' : 'text-zinc-500 hover:text-black dark:hover:text-white'}`}
        title={t('myStyles')}
        aria-label={t('myStyles')}
        aria-expanded={open}
        disabled={!token}
        onClick={() => setOpen(o => !o)}
        data-saved-styles-open
      >
        <Library size={14} />
      </button>
      <button
        type="button"
        className={`${iconButton} ${justSaved ? 'text-green-500' : 'text-zinc-500 hover:text-black dark:hover:text-white'}`}
        title={justSaved ? t('styleSaved') : t('saveStyle')}
        aria-label={t('saveStyle')}
        disabled={!token || !style.trim() || saving}
        onClick={() => void save()}
        data-saved-styles-save
      >
        {saving ? <Loader2 size={14} className="animate-spin" /> : justSaved ? <BookmarkCheck size={14} /> : <Bookmark size={14} />}
      </button>

      {open && createPortal(
        <div
          ref={windowRef}
          role="dialog"
          aria-label={t('myStyles')}
          data-saved-styles-window
          style={{ position: 'fixed', top: position.top, right: position.right }}
          className="z-[130] w-[340px] max-w-[calc(100vw-16px)] rounded-xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-zinc-900 shadow-2xl p-3 space-y-2"
        >
          <div className="flex items-center gap-2 rounded-lg bg-zinc-100 dark:bg-white/5 px-2.5 py-1.5">
            <Search size={14} className="text-zinc-400 shrink-0" />
            <input
              autoFocus
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={t('searchStyles')}
              className="w-full bg-transparent text-sm text-zinc-900 dark:text-white placeholder-zinc-400 focus:outline-none"
            />
          </div>
          {error && <p className="text-[11px] text-rose-500">{error}</p>}
          <div className="max-h-[320px] overflow-y-auto -mx-1">
            {styles === null ? (
              <div className="flex justify-center py-6 text-zinc-400"><Loader2 size={16} className="animate-spin" /></div>
            ) : shown.length === 0 ? (
              <p className="text-center text-sm text-zinc-500 py-6">{styles.length === 0 ? t('noSavedStyles') : t('noStyleMatch')}</p>
            ) : shown.map(s => (
              <div key={s.id} className="group/style flex items-start gap-2 rounded-lg px-2 py-2 hover:bg-zinc-100 dark:hover:bg-white/5" data-saved-style>
                <Music2 size={14} className="mt-1 text-zinc-400 shrink-0" />
                <div className="min-w-0 flex-1">
                  {renaming?.id === s.id ? (
                    <input
                      autoFocus
                      value={renaming.name}
                      onChange={e => setRenaming({ id: s.id, name: e.target.value })}
                      onBlur={() => void commitRename()}
                      onKeyDown={e => { if (e.key === 'Enter') void commitRename(); if (e.key === 'Escape') setRenaming(null); }}
                      className="w-full rounded bg-zinc-100 dark:bg-white/10 px-1 text-sm font-semibold text-zinc-900 dark:text-white focus:outline-none"
                    />
                  ) : (
                    <button
                      type="button"
                      className="block w-full text-left"
                      title={t('useStyle')}
                      onClick={() => { onPick(s.style); setOpen(false); }}
                    >
                      <span className="block truncate text-sm font-semibold text-zinc-900 dark:text-white">{s.name}</span>
                      <span className="block text-xs text-zinc-500 dark:text-zinc-400 line-clamp-2">{s.style}</span>
                      <span className="block text-[10px] text-zinc-400 mt-0.5">{timeAgo(s.updated_at, language)}</span>
                    </button>
                  )}
                </div>
                <div className="flex flex-col gap-0.5 opacity-60 group-hover/style:opacity-100">
                  <button type="button" className={`${iconButton} text-zinc-500 hover:text-black dark:hover:text-white`} title={t('renameStyle')} onClick={() => setRenaming({ id: s.id, name: s.name })}>
                    <Pencil size={12} />
                  </button>
                  <button type="button" className={`${iconButton} text-zinc-500 hover:text-rose-500`} title={t('deleteStyle')} onClick={() => void remove(s.id)} data-saved-style-delete>
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
};
