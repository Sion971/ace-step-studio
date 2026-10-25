// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ed = vi.hoisted(() => ({ ratio: 1.2 as number | null, added: [] as File[], project: 100 }));
vi.mock('./studioBridge', async (orig) => ({
  ...(await orig<typeof import('./studioBridge')>()),
  waitForEditor: vi.fn(async () => ({ fireEvent: () => {} })),
  getEditorApi: vi.fn(() => ({ multitrack: { GetBeat: () => ({ bpm: ed.project, sig: '4/4' }) }, fireEvent: () => {} })),
  applySongTempoToEditor: vi.fn(() => false),
  tempoRatioForSong: vi.fn(() => ed.ratio),
  addTrackToEditor: vi.fn((_f: unknown, file: File) => { ed.added.push(file); return true; }),
  editorSignature: vi.fn(() => ''),
  hasUnsavedWork: vi.fn(() => false),
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
beforeEach(() => { ed.ratio = 1.2; ed.added = []; ed.project = 100; try { localStorage.removeItem('studio.alignTempo'); } catch { /* ignore */ } });
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const song: Song = { id: 's1', title: 'Slow one', lyrics: '', style: '', coverUrl: '', duration: '0:10', createdAt: new Date('2026-10-20'), tags: [], audioUrl: '/audio/a.wav', bpm: 83 } as Song;

async function mount(onStretch?: (f: File, r: number) => Promise<Blob>) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob(['orig'], { type: 'audio/wav' }), json: async () => ({ models: [] }) })));
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root!.render(<I18nProvider><StudioPage songs={[song]} onStretch={onStretch} /></I18nProvider>); });
}
const q = (id: string) => host!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const addIt = async () => {
  const btn = Array.from(host!.querySelectorAll('button')).find((b) => b.textContent?.includes('Slow one')) as HTMLElement;
  await act(async () => { btn.click(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
};

describe('matching the tempo of the project', () => {
  it('stretches a song of another tempo and adds the stretched audio', async () => {
    const stretch = vi.fn(async (_f: File, _r: number) => new Blob(['stretched'], { type: 'audio/wav' }));
    await mount(stretch);
    await addIt();
    expect(stretch).toHaveBeenCalledTimes(1);
    expect(stretch.mock.calls[0][1]).toBeCloseTo(1.2);
    expect(ed.added).toHaveLength(1);
    expect(ed.added[0].name).toContain('100 BPM');
    expect(await ed.added[0].text()).toBe('stretched');
    expect(q('studio-align-notice')?.textContent).toContain('83 → 100');
  });

  it('adds the song as it is when nothing is to be done', async () => {
    ed.ratio = null;
    const stretch = vi.fn();
    await mount(stretch as never);
    await addIt();
    expect(stretch).not.toHaveBeenCalled();
    expect(await ed.added[0].text()).toBe('orig');
  });

  it('adds the song as it is when the box is unticked, and remembers that', async () => {
    const stretch = vi.fn(async () => new Blob(['stretched']));
    await mount(stretch);
    await act(async () => { (q('studio-align-tempo') as HTMLInputElement).click(); });
    expect(localStorage.getItem('studio.alignTempo')).toBe('0');
    await addIt();
    expect(stretch).not.toHaveBeenCalled();
    expect(await ed.added[0].text()).toBe('orig');
  });

  it('adds the song as it is, and says so, when the stretch fails', async () => {
    await mount(vi.fn(async () => { throw new Error('boom'); }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await addIt();
    expect(await ed.added[0].text()).toBe('orig');
    expect(q('studio-align-notice')?.textContent).toMatch(/as it is/);
  });

  it('shows no box when the page cannot stretch', async () => {
    await mount(undefined);
    expect(q('studio-align-tempo')).toBeNull();
  });
});
