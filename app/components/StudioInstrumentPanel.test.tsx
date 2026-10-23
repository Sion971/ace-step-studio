// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StudioInstrumentPanel } from './StudioInstrumentPanel';
import type { Song } from '../types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const tf = (_k: string, fb: string) => fb;
const song = { id: 's1', title: 'Funk', lyrics: '', style: '', coverUrl: '', duration: '0:22', createdAt: new Date(), tags: [], audioUrl: '/audio/a.flac' } as Song;

let root: Root | null = null;
let host: HTMLElement | null = null;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

async function mount(models: unknown[], props: Partial<React.ComponentProps<typeof StudioInstrumentPanel>> = {}) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ models }) }));
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const p = { sources: [song], tf, onGenerate: vi.fn(), onResult: vi.fn(), ...props };
  await act(async () => { root!.render(<StudioInstrumentPanel {...p} />); });
  await flush();
  return p;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null; host = null;
  vi.unstubAllGlobals();
});

describe('StudioInstrumentPanel', () => {
  it('asks for a Base model when none is installed', async () => {
    await mount([{ name: 'acestep-v15-turbo', is_active: true }]);
    expect(host!.textContent).toContain('needs a Base model');
  });

  it('asks for a song first when the editor is empty', async () => {
    await mount([{ name: 'acestep-v15-xl-base', is_active: true }], { sources: [] });
    expect(host!.textContent).toContain('Add a song to the editor first.');
  });

  it('runs Lego with the chosen instrument, guidance 5, and hands the result on', async () => {
    const onGenerate = vi.fn().mockResolvedValue(['/audio/stem.flac']);
    const onResult = vi.fn().mockResolvedValue(undefined);
    await mount([{ name: 'acestep-v15-xl-base', is_active: true }], { onGenerate, onResult });
    const button = Array.from(host!.querySelectorAll('button')).find((b) => b.textContent?.includes('Generate and add as a track'))!;
    await act(async () => { button.click(); });
    await flush();
    expect(onGenerate.mock.calls[0][0]).toMatchObject({ trackName: 'keyboard', guidance: 5, model: 'acestep-v15-xl-base' });
    expect(onResult).toHaveBeenCalledWith(song, 'keyboard', ['/audio/stem.flac'], undefined);
  });

  it('fills the tempo and key from the song and sends them, with the seed when one is typed', async () => {
    const onGenerate = vi.fn().mockResolvedValue(['/audio/stem.flac']);
    const withMeta = { ...song, bpm: 85, keyScale: 'G major' } as Song;
    await mount([{ name: 'acestep-v15-xl-base', is_active: true }], { sources: [withMeta], onGenerate });
    const inputs = Array.from(host!.querySelectorAll('input')) as HTMLInputElement[];
    expect(inputs.some((i) => i.value === '85')).toBe(true);
    expect(inputs.some((i) => i.value === 'G major')).toBe(true);
    const seedInput = inputs.find((i) => i.placeholder === 'random')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(seedInput, '2900000000'); seedInput.dispatchEvent(new Event('input', { bubbles: true })); });
    const button = Array.from(host!.querySelectorAll('button')).find((b) => b.textContent?.includes('Generate and add as a track'))!;
    await act(async () => { button.click(); });
    await flush();
    expect(onGenerate.mock.calls[0][0]).toMatchObject({ bpm: 85, keyScale: 'G major', seed: 2900000000 });
  });
});
