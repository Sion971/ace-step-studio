// @vitest-environment happy-dom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';
import { StudioDock, StudioDockItem } from './StudioDock';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('StudioDock', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;
  beforeEach(() => { try { window.localStorage.clear(); } catch { /* none */ } });
  afterEach(async () => { if (root) await act(async () => root!.unmount()); host?.remove(); root = null; host = null; });

  const Counter: React.FC = () => { const [n, setN] = React.useState(0); return <button data-testid="counter" onClick={() => setN(n + 1)}>{n}</button>; };
  const items = (over: Partial<Record<string, Partial<StudioDockItem>>> = {}): StudioDockItem[] => [
    { id: 'projects', label: 'Projets', content: <Counter />, ...over.projects },
    { id: 'export', label: 'Export', content: <p>export block</p>, ...over.export },
    { id: 'instrument', label: 'Instrument', content: <p>instrument block</p>, ...over.instrument },
  ];
  const render = async (list: StudioDockItem[]) => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<StudioDock items={list} />); });
  };
  const q = (id: string) => host!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  const click = (id: string) => act(async () => { q(id)!.click(); });
  const hiddenOf = (tab: string) => (q(`studio-dock-panel-${tab}`) as HTMLElement).hidden;

  it('starts folded: three tabs, no block open', async () => {
    await render(items());
    expect(['projects', 'export', 'instrument'].every(hiddenOf)).toBe(true);
    expect(host!.querySelectorAll('[role="tab"]')).toHaveLength(3);
  });

  it('opens one block at a time and folds it with a second click', async () => {
    await render(items());
    await click('studio-dock-tab-export');
    expect(hiddenOf('export')).toBe(false);
    expect(hiddenOf('projects')).toBe(true);
    await click('studio-dock-tab-instrument');
    expect(hiddenOf('export')).toBe(true);
    expect(hiddenOf('instrument')).toBe(false);
    await click('studio-dock-tab-instrument');
    expect(['projects', 'export', 'instrument'].every(hiddenOf)).toBe(true);
  });

  it('keeps every block mounted, so what was done in a folded block is not lost', async () => {
    await render(items());
    await click('studio-dock-tab-projects');
    await click('counter');
    await click('counter');
    expect(q('counter')!.textContent).toBe('2');
    await click('studio-dock-tab-export');
    await click('studio-dock-tab-projects');
    expect(q('counter')!.textContent).toBe('2');
  });

  it('shows a detail next to the label and a dot on a tab whose job is running', async () => {
    await render(items({ projects: { detail: 'test2' }, instrument: { busy: true } }));
    expect(q('studio-dock-tab-projects')!.textContent).toContain('test2');
    expect(q('studio-dock-busy-instrument')).not.toBeNull();
    expect(q('studio-dock-busy-export')).toBeNull();
  });

  it('remembers the open tab, and ignores a remembered tab that no longer exists', async () => {
    await render(items());
    await click('studio-dock-tab-export');
    await act(async () => root!.unmount());
    host!.remove();
    await render(items());
    expect(hiddenOf('export')).toBe(false);
    await act(async () => root!.unmount());
    host!.remove();
    window.localStorage.setItem('studio.dock.tab', 'instrument');
    await render(items().slice(0, 2));
    expect(['projects', 'export'].every(hiddenOf)).toBe(true);
  });

  it('draws nothing without blocks', async () => {
    await render([]);
    expect(q('studio-dock')).toBeNull();
  });
});
