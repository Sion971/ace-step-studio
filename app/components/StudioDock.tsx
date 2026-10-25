import React, { useEffect, useState } from 'react';

export type StudioDockTab = 'projects' | 'export' | 'instrument';

export interface StudioDockItem {
  id: StudioDockTab;
  label: string;
  /** Short text next to the label (the open project, for instance). */
  detail?: string | null;
  /** A job is running in this block: the tab shows it even when the block is folded. */
  busy?: boolean;
  content: React.ReactNode;
}

const STORAGE_KEY = 'studio.dock.tab';

function readStored(ids: StudioDockTab[]): StudioDockTab | null {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY) as StudioDockTab | null;
    return v && ids.includes(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * The blocks under the song list of the Studio tab (projects, export, instrument) as tabs: only the bar is always visible, and
 * the song list keeps the room. A click on a tab opens its block, a second click folds it again. Every block stays mounted
 * (only hidden), so what was typed and any job in progress survive switching tabs.
 */
export const StudioDock: React.FC<{ items: StudioDockItem[] }> = ({ items }) => {
  const ids = items.map((i) => i.id);
  const [open, setOpen] = useState<StudioDockTab | null>(() => readStored(ids));
  useEffect(() => {
    try {
      if (open) window.localStorage.setItem(STORAGE_KEY, open);
      else window.localStorage.removeItem(STORAGE_KEY);
    } catch { /* storage unavailable: the choice is just not kept */ }
  }, [open]);
  if (items.length === 0) return null;
  const shown = open && ids.includes(open) ? open : null;

  return (
    <div className="flex-shrink-0 border-t border-zinc-200 dark:border-white/5" data-testid="studio-dock">
      <div className="flex" role="tablist">
        {items.map((item) => {
          const active = item.id === shown;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setOpen(active ? null : item.id)}
              title={item.detail ? `${item.label} · ${item.detail}` : item.label}
              data-testid={`studio-dock-tab-${item.id}`}
              className={`relative min-w-0 flex-1 px-2 py-2 text-[11px] font-semibold truncate border-b-2 transition-colors ${active ? 'border-pink-500 text-pink-600 dark:text-pink-300 bg-pink-500/5' : 'border-transparent text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-white/5'}`}
            >
              {item.label}
              {item.detail ? <span className="ml-1 font-normal opacity-70">· {item.detail}</span> : null}
              {item.busy && <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-pink-500 animate-pulse" data-testid={`studio-dock-busy-${item.id}`} />}
            </button>
          );
        })}
      </div>
      {items.map((item) => (
        <div
          key={item.id}
          role="tabpanel"
          hidden={item.id !== shown}
          className={item.id === shown ? 'max-h-[45vh] overflow-y-auto border-t border-zinc-200 dark:border-white/5' : undefined}
          data-testid={`studio-dock-panel-${item.id}`}
        >
          {item.content}
        </div>
      ))}
    </div>
  );
};
