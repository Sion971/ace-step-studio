// @vitest-environment happy-dom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';
import { editorHasClips, getEditorSession, loadEditorSession } from './studioBridge';
import { StudioProjectsPanel, StudioProjectItem, StudioProjectsApi } from './StudioProjectsPanel';

const tf = (_k: string, f: string) => f;
const frameWith = (multitrack: Record<string, unknown>) => ({ contentWindow: { PKAudioEditor: { multitrack, fireEvent: vi.fn() } } }) as unknown as HTMLIFrameElement;

describe('editor session bridge', () => {
  it('reads the session as a file, and gives null when there is none or no editor', () => {
    const blob = new Blob(['x']);
    expect(getEditorSession(frameWith({ GetSessionBlob: () => blob }))).toBe(blob);
    expect(getEditorSession(frameWith({ GetSessionBlob: () => null }))).toBeNull();
    expect(getEditorSession(frameWith({}))).toBeNull();
    expect(getEditorSession(null)).toBeNull();
  });
  it('loads a session and reports whether the editor accepted it', () => {
    const load = vi.fn(() => true);
    const data = new ArrayBuffer(4);
    expect(loadEditorSession(frameWith({ LoadSessionBuffer: load }), data, 'A')).toBe(true);
    expect(load).toHaveBeenCalledWith(data, 'A');
    expect(loadEditorSession(frameWith({ LoadSessionBuffer: () => false }), data)).toBe(false);
    expect(loadEditorSession(frameWith({}), data)).toBe(false);
  });
  it('knows whether the timeline holds clips', () => {
    expect(editorHasClips(frameWith({ ListClips: () => [{ id: 'a' }] }))).toBe(true);
    expect(editorHasClips(frameWith({ ListClips: () => [] }))).toBe(false);
    expect(editorHasClips(null)).toBe(false);
  });
});

describe('StudioProjectsPanel', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  if (typeof window.confirm !== 'function') (window as any).confirm = () => true; // happy-dom has none
  afterEach(async () => { if (root) await act(async () => root!.unmount()); host?.remove(); root = null; host = null; vi.restoreAllMocks(); });

  const item = (id: string, name: string): StudioProjectItem => ({ id, name, size: 5 * 1024 * 1024, updatedAt: '2026-10-25T12:00:00Z' });
  const q = (id: string) => host!.querySelector(`[data-testid="${id}"]`) as HTMLElement;
  const all = (id: string) => Array.from(host!.querySelectorAll(`[data-testid="${id}"]`)) as HTMLElement[];
  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); }); await settle(); };
  const type = async (el: HTMLInputElement, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  async function setup(projects: StudioProjectItem[], multitrack: Record<string, unknown>) {
    const store = [...projects];
    const api: StudioProjectsApi = {
      list: vi.fn(async () => [...store]),
      save: vi.fn(async (_f, name, id) => {
        if (id) return store.find((p) => p.id === id)!;
        const p = item('new' + store.length, name || 'Projet');
        store.unshift(p);
        return p;
      }),
      load: vi.fn(async () => new ArrayBuffer(8)),
      remove: vi.fn(async (id) => { store.splice(store.findIndex((p) => p.id === id), 1); }),
    };
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const frame = frameWith(multitrack);
    await act(async () => { root!.render(<StudioProjectsPanel tf={tf} api={api} getFrame={() => frame} />); });
    await settle();
    return api;
  }

  it('lists the projects, or says there is none', async () => {
    await setup([], {});
    expect(host!.textContent).toContain('No project yet.');
    await act(async () => root!.unmount());
    host!.remove();
    await setup([item('a', 'Chanson A'), item('b', 'Chanson B')], {});
    expect(all('studio-project-item').map((e) => e.textContent)).toEqual([expect.stringContaining('Chanson A'), expect.stringContaining('Chanson B')]);
    expect(host!.textContent).toContain('5.0 MB');
  });

  it('saves the editor session as a new project under the typed name, then offers to update it', async () => {
    const blob = new Blob(['session']);
    const api = await setup([], { GetSessionBlob: () => blob });
    await type(q('studio-project-name') as HTMLInputElement, 'Mon projet');
    await click(q('studio-project-save-new'));
    expect(api.save).toHaveBeenCalledWith(blob, 'Mon projet', undefined);
    expect(q('studio-project-message').textContent).toContain('Mon projet');
    expect(all('studio-project-item')).toHaveLength(1);
    await click(q('studio-project-save-current'));
    expect(api.save).toHaveBeenLastCalledWith(blob, undefined, 'new0');
  });

  it('does not save an empty editor', async () => {
    const api = await setup([], { GetSessionBlob: () => null });
    await click(q('studio-project-save-new'));
    expect(api.save).not.toHaveBeenCalled();
    expect(q('studio-project-message').textContent).toContain('Nothing to save');
  });

  it('replaces a project with the current session', async () => {
    const blob = new Blob(['s']);
    const api = await setup([item('a', 'A')], { GetSessionBlob: () => blob });
    await click(q('studio-project-overwrite'));
    expect(api.save).toHaveBeenCalledWith(blob, undefined, 'a');
  });

  it('opens a project in the editor, asking first when the editor holds clips', async () => {
    const load = vi.fn(() => true);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const api = await setup([item('a', 'A')], { ListClips: () => [{ id: 'c' }], LoadSessionBuffer: load });
    await click(q('studio-project-open'));
    expect(confirm).toHaveBeenCalled();
    expect(api.load).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    await click(q('studio-project-open'));
    expect(api.load).toHaveBeenCalledWith('a');
    expect(load).toHaveBeenCalled();
    expect(q('studio-project-message').textContent).toContain('Project opened');
  });

  it('opens straight away on an empty editor, and reports a project the editor refuses', async () => {
    const confirm = vi.spyOn(window, 'confirm');
    await setup([item('a', 'A')], { ListClips: () => [], LoadSessionBuffer: () => false });
    await click(q('studio-project-open'));
    expect(confirm).not.toHaveBeenCalled();
    expect(q('studio-project-message').textContent).toContain('could not open');
  });

  it('deletes a project only after confirmation', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const api = await setup([item('a', 'A')], {});
    await click(q('studio-project-delete'));
    expect(api.remove).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    await click(q('studio-project-delete'));
    expect(api.remove).toHaveBeenCalledWith('a');
    expect(all('studio-project-item')).toHaveLength(0);
  });
});
