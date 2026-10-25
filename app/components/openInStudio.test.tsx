// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Song } from '../types';
import { STUDIO_OPEN_EVENT, openInStudio, songItem } from './openInStudio';

const bridge = vi.hoisted(() => ({ added: [] as Array<{ name: string; start: number }>, ready: true }));
vi.mock('./studioBridge', async (orig) => ({
  ...(await orig<typeof import('./studioBridge')>()),
  waitForEditor: vi.fn(async () => (bridge.ready ? { fireEvent: () => {} } : null)),
  addTrackToEditor: vi.fn((_f: unknown, file: File, start = 0) => { bridge.added.push({ name: file.name, start }); return true; }),
  listEditorClipNames: vi.fn(() => []),
  listEditorClips: vi.fn(() => []),
}));
import { StudioPage } from './StudioPage';
import { I18nProvider } from '../context/I18nContext';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(window as any).happyDOM?.settings && ((window as any).happyDOM.settings.disableIframePageLoading = true); // the editor page is not served in tests
const song = { id: 's1', title: 'Funk', lyrics: '', style: '', coverUrl: '', duration: '0:22', createdAt: new Date(), tags: [], audioUrl: '/audio/a.flac' } as Song;

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove(); root = null; host = null;
  bridge.added.length = 0; bridge.ready = true;
  vi.unstubAllGlobals(); vi.useRealTimers();
});

describe('opening audio in the Studio instead of a separate page', () => {
  it('sends the request as an event the application listens for', () => {
    const got = vi.fn();
    window.addEventListener(STUDIO_OPEN_EVENT, got);
    openInStudio([]);
    expect(got).not.toHaveBeenCalled(); // nothing to open, nothing sent
    openInStudio([{ url: '/a.wav', name: 'A' }]);
    window.removeEventListener(STUDIO_OPEN_EVENT, got);
    expect((got.mock.calls[0][0] as CustomEvent).detail.items).toEqual([{ url: '/a.wav', name: 'A' }]);
  });

  it('turns a song into an item, and a song without audio into nothing', () => {
    expect(songItem(song)).toEqual({ url: '/audio/a.flac', name: 'Funk', song });
    expect(songItem({ ...song, audioUrl: '' })).toBeNull();
  });

  it('no longer opens the separate /editor page from the song menus or the stems window', () => {
    for (const f of ['SongDropdownMenu.tsx', 'RightSidebar.tsx', 'SongProfile.tsx', 'StemSeparationModal.tsx']) {
      expect(readFileSync(path.join(__dirname, f), 'utf8'), f).not.toMatch(/window\.open\(`\/editor/);
    }
  });

  async function mount(props: Partial<React.ComponentProps<typeof StudioPage>>) {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob(['x'], { type: 'audio/wav' }), json: async () => ({ models: [] }) })));
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
    await act(async () => { root!.render(<I18nProvider><StudioPage songs={[]} {...props} /></I18nProvider>); });
  }
  const settle = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

  it('puts each incoming audio on its own track, in order, then says it is done (once)', async () => {
    const done = vi.fn();
    const incoming = { id: 1, items: [{ url: '/s/drums.wav', name: 'Mix - Drums' }, { url: '/s/bass.wav', name: 'Mix - Bass' }, { url: '/audio/a.flac', name: 'Funk', song }] };
    await mount({ incoming, onIncomingDone: done });
    await settle(2200);
    expect(bridge.added.map((a) => a.name)).toEqual(['Mix - Drums.wav', 'Mix - Bass.wav', 'Funk.flac']);
    expect(done).toHaveBeenCalledTimes(1);
    // the same request, seen again after a re-render with a new callback, is not replayed
    await act(async () => { root!.render(<I18nProvider><StudioPage songs={[]} incoming={incoming} onIncomingDone={vi.fn()} /></I18nProvider>); });
    await settle(100);
    expect(bridge.added).toHaveLength(3);
  });

  it('reports the failure and still clears the request when the editor never gets ready', async () => {
    bridge.ready = false;
    const done = vi.fn();
    await mount({ incoming: { id: 2, items: [{ url: '/a.wav', name: 'A' }] }, onIncomingDone: done });
    await settle(50);
    expect(bridge.added).toHaveLength(0);
    expect(done).toHaveBeenCalledTimes(1);
    expect(host!.textContent).toContain('Could not load this song into the editor.');
  });
});
