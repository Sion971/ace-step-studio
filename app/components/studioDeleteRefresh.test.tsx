// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./studioBridge', async (orig) => ({
  ...(await orig<typeof import('./studioBridge')>()),
  getEditorApi: vi.fn(() => null),
  pauseEditor: vi.fn(),
  hasUnsavedWork: vi.fn(() => false),
  editorSignature: vi.fn(() => 'sig'),
  waitForEditor: vi.fn(async () => null),
  listEditorClipNames: vi.fn(() => []),
  listEditorClips: vi.fn(() => []),
}));
import { StudioPage } from './StudioPage';
import { I18nProvider } from '../context/I18nContext';
import type { Song } from '../types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(window as any).happyDOM?.settings && ((window as any).happyDOM.settings.disableIframePageLoading = true);

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; vi.unstubAllGlobals(); });

const song = (id: string, title: string) => ({ id, title, lyrics: '', style: '', coverUrl: '', duration: '1:00', createdAt: new Date(), tags: [], audioUrl: `/audio/${id}.mp3` }) as unknown as Song;

describe('Studio song list after a delete', () => {
  it('drops deleted songs from a workspace list without a reload', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ models: [] }) })));
    const all = [song('a', 'Je suis la voix v1'), song('b', 'Je suis la voix v2'), song('c', 'Autre')];
    const load = vi.fn(async () => [all[0], all[1]]);
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
    const render = (songs: Song[]) => act(async () => {
      root!.render(<I18nProvider><StudioPage songs={songs} workspaces={[{ id: 'w1', name: 'Voix' }]} loadWorkspaceSongs={load} onDeleteSongs={() => undefined} /></I18nProvider>);
    });
    await render(all);
    const select = host.querySelector('select') as HTMLSelectElement;
    await act(async () => { select.value = 'w1'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(host.textContent).toContain('Je suis la voix v1');
    expect(host.textContent).toContain('Je suis la voix v2');
    await render([all[2]]);
    expect(host.textContent).not.toContain('Je suis la voix v1');
    expect(host.textContent).not.toContain('Je suis la voix v2');
    expect(load).toHaveBeenCalledTimes(1);
  });
});
