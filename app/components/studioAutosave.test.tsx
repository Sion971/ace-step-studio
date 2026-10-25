// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ed = vi.hoisted(() => ({ sig: '', loaded: [] as string[], loadOk: true }));
vi.mock('./studioBridge', async (orig) => ({
  ...(await orig<typeof import('./studioBridge')>()),
  waitForEditor: vi.fn(async () => ({ fireEvent: () => {} })),
  getEditorApi: vi.fn(() => ({ multitrack: {}, fireEvent: () => {} })),
  editorSignature: vi.fn(() => ed.sig),
  hasUnsavedWork: vi.fn(() => false),
  getEditorSession: vi.fn(() => new Blob(['session'])),
  loadEditorSession: vi.fn((_f: unknown, _d: ArrayBuffer, name?: string) => { ed.loaded.push(String(name)); if (ed.loadOk) ed.sig = 'restored'; return ed.loadOk; }),
  listEditorClipNames: vi.fn(() => []),
  listEditorClips: vi.fn(() => []),
}));
import { StudioPage, AUTOSAVE_MS } from './StudioPage';
import type { StudioProjectsApi } from './StudioProjectsPanel';
import { I18nProvider } from '../context/I18nContext';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(window as any).happyDOM?.settings && ((window as any).happyDOM.settings.disableIframePageLoading = true);

let root: Root | null = null;
let host: HTMLElement | null = null;
beforeEach(() => { vi.useFakeTimers(); ed.sig = ''; ed.loaded = []; ed.loadOk = true; });
afterEach(() => {
  act(() => root?.unmount());
  host?.remove(); root = null; host = null;
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

function makeApi(existing: { updatedAt: string; size: number } | null = null) {
  const draft = {
    get: vi.fn(async () => existing),
    save: vi.fn(async () => {}),
    load: vi.fn(async () => new ArrayBuffer(8)),
    remove: vi.fn(async () => {}),
  };
  const api: StudioProjectsApi = { list: async () => [], save: async () => ({ id: 'x', name: 'x', size: 1, updatedAt: '' }), load: async () => new ArrayBuffer(0), remove: async () => {}, draft };
  return { api, draft };
}

async function mount(api: StudioProjectsApi) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ models: [] }) })));
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root!.render(<I18nProvider><StudioPage songs={[]} projectsApi={api} /></I18nProvider>); });
  await act(async () => { await vi.advanceTimersByTimeAsync(10); });
}
const round = () => act(async () => { await vi.advanceTimersByTimeAsync(AUTOSAVE_MS); });
const q = (id: string) => host!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

describe('the automatic backup of the editor', () => {
  it('stores a change once it has stopped changing, and only once', async () => {
    const { api, draft } = makeApi();
    await mount(api);
    ed.sig = 'A';
    await round();               // first seen: maybe still being edited
    expect(draft.save).not.toHaveBeenCalled();
    await round();               // seen unchanged: stored
    expect(draft.save).toHaveBeenCalledTimes(1);
    await round(); await round();
    expect(draft.save).toHaveBeenCalledTimes(1);
    ed.sig = 'B';
    await round();
    expect(draft.save).toHaveBeenCalledTimes(1);
    await round();
    expect(draft.save).toHaveBeenCalledTimes(2);
  });

  it('stores nothing while a change is still going on', async () => {
    const { api, draft } = makeApi();
    await mount(api);
    for (const s of ['A', 'B', 'C', 'D']) { ed.sig = s; await round(); }
    expect(draft.save).not.toHaveBeenCalled();
  });

  it('does not touch the backup when the timeline is empty and nothing was backed up in this session', async () => {
    const { api, draft } = makeApi();
    await mount(api);
    await round(); await round();
    expect(draft.save).not.toHaveBeenCalled();
    expect(draft.remove).not.toHaveBeenCalled();
  });

  it('drops the backup when the timeline is emptied on purpose', async () => {
    const { api, draft } = makeApi();
    await mount(api);
    ed.sig = 'A'; await round(); await round();
    expect(draft.save).toHaveBeenCalledTimes(1);
    ed.sig = '';
    await round();
    expect(draft.remove).toHaveBeenCalledTimes(1);
  });

  it('keeps going after a failed backup', async () => {
    const { api, draft } = makeApi();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    draft.save.mockRejectedValueOnce(new Error('offline'));
    await mount(api);
    ed.sig = 'A'; await round(); await round();
    expect(draft.save).toHaveBeenCalledTimes(1);
    await round();
    expect(draft.save).toHaveBeenCalledTimes(2);
    expect(err).toHaveBeenCalled();
  });

  it('shows the time of the last backup in the projects block', async () => {
    const { api } = makeApi();
    await mount(api);
    ed.sig = 'A'; await round(); await round();
    expect(q('studio-autosaved')).not.toBeNull();
  });
});

describe('a backup left by a previous session', () => {
  const found = { updatedAt: '2026-10-25T12:00:00Z', size: 1000 };

  it('is offered when the editor is empty, and restored on request', async () => {
    const { api, draft } = makeApi(found);
    await mount(api);
    expect(q('studio-draft-banner')).not.toBeNull();
    await act(async () => { q('studio-draft-restore')!.click(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(draft.load).toHaveBeenCalled();
    expect(ed.loaded).toHaveLength(1);
    expect(q('studio-draft-banner')).toBeNull();
    expect(draft.remove).not.toHaveBeenCalled(); // it stays as the backup of what is now in the editor
  });

  it('is deleted when ignored', async () => {
    const { api, draft } = makeApi(found);
    await mount(api);
    await act(async () => { q('studio-draft-ignore')!.click(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(draft.remove).toHaveBeenCalledTimes(1);
    expect(q('studio-draft-banner')).toBeNull();
  });

  it('is not offered when the editor already holds work, nor when there is none', async () => {
    ed.sig = 'busy';
    const a = makeApi(found);
    await mount(a.api);
    expect(q('studio-draft-banner')).toBeNull();
    act(() => root?.unmount()); host?.remove();
    ed.sig = '';
    const b = makeApi(null);
    await mount(b.api);
    expect(q('studio-draft-banner')).toBeNull();
  });

  it('is not overwritten while it waits for an answer', async () => {
    const { api, draft } = makeApi(found);
    await mount(api);
    ed.sig = 'A'; await round(); await round(); await round();
    expect(draft.save).not.toHaveBeenCalled();
  });

  it('stays offered, with a message, when the editor refuses it', async () => {
    ed.loadOk = false;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { api } = makeApi(found);
    await mount(api);
    await act(async () => { q('studio-draft-restore')!.click(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(q('studio-draft-banner')).not.toBeNull();
    expect(host!.textContent).toContain('could not be restored');
    expect(err).toHaveBeenCalled();
  });
});
