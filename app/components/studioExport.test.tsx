// @vitest-environment happy-dom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';
import { exportEditorMix } from './studioBridge';
import { StudioExportPanel } from './StudioExportPanel';

const tf = (_k: string, f: string) => f;
const pcm = (seconds: number) => {
  const sampleRate = 8000;
  const n = Math.round(seconds * sampleRate);
  const ch = new Float32Array(n).fill(0.1);
  return { length: n, sampleRate, numberOfChannels: 1, getChannelData: () => ch };
};
function frameWith(MixdownAsync?: (sel: [number, number] | null, done: (b: unknown) => void) => void): HTMLIFrameElement {
  return { contentWindow: { PKAudioEditor: { multitrack: MixdownAsync ? { MixdownAsync } : {} } } } as unknown as HTMLIFrameElement;
}

describe('exportEditorMix', () => {
  it('renders the whole timeline to a WAV file', async () => {
    const mix = vi.fn((sel, done) => done(pcm(2)));
    const r = await exportEditorMix(frameWith(mix), 'a.wav');
    expect(mix.mock.calls[0][0]).toBeNull();
    expect(r?.file.name).toBe('a.wav');
    expect(r?.file.type).toBe('audio/wav');
    expect(r?.duration).toBeCloseTo(2);
  });
  it('renders only the range when given one', async () => {
    const mix = vi.fn((sel, done) => done(pcm(1)));
    await exportEditorMix(frameWith(mix), 'a.wav', { start: 1, end: 2 });
    expect(mix.mock.calls[0][0]).toEqual([1, 2]);
  });
  it('gives null when there is nothing to mix or no editor', async () => {
    expect(await exportEditorMix(frameWith((s, d) => d(null)), 'a.wav')).toBeNull();
    expect(await exportEditorMix(frameWith(), 'a.wav')).toBeNull();
    expect(await exportEditorMix(null, 'a.wav')).toBeNull();
  });
});

describe('StudioExportPanel', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;
  afterEach(async () => { if (root) await act(async () => root!.unmount()); host?.remove(); root = null; host = null; });
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

  const q = (id: string) => host!.querySelector(`[data-testid="${id}"]`) as HTMLElement;
  const msg = () => q('studio-export-message')?.textContent ?? '';
  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  const type = async (el: HTMLInputElement, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); }); await settle(); };

  const setup = async (over: Partial<React.ComponentProps<typeof StudioExportPanel>> = {}) => {
    const onExport = vi.fn().mockResolvedValue(undefined);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<StudioExportPanel tf={tf} onExport={onExport} getFrame={() => frameWith((s, d) => d(pcm(3)))} getRegion={() => null} {...over} />);
    });
    return onExport;
  };

  it('saves the mix under the typed title and says so', async () => {
    const onExport = await setup();
    await type(q('studio-export-title') as HTMLInputElement, 'Mon mix');
    await click(q('studio-export-button'));
    expect(onExport).toHaveBeenCalledTimes(1);
    const [file, title, duration] = onExport.mock.calls[0];
    expect(file.name).toBe('Mon mix.wav');
    expect(title).toBe('Mon mix');
    expect(duration).toBeCloseTo(3);
    expect(msg()).toContain('Mon mix');
  });
  it('uses a dated title when none is typed', async () => {
    const onExport = await setup();
    await click(q('studio-export-button'));
    expect(onExport.mock.calls[0][1]).toMatch(/^Studio mix \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
  it('asks for a range when "selected range only" is ticked without one', async () => {
    const onExport = await setup();
    await click(host!.querySelector('input[type="checkbox"]')!);
    await click(q('studio-export-button'));
    expect(msg()).toContain('range');
    expect(onExport).not.toHaveBeenCalled();
  });
  it('exports the selected range', async () => {
    const mix = vi.fn((s, d) => d(pcm(1)));
    const onExport = await setup({ getFrame: () => frameWith(mix), getRegion: () => ({ start: 4, end: 5 }) });
    await click(host!.querySelector('input[type="checkbox"]')!);
    await click(q('studio-export-button'));
    expect(onExport).toHaveBeenCalled();
    expect(mix.mock.calls[0][0]).toEqual([4, 5]);
  });
  it('reports an empty editor', async () => {
    const onExport = await setup({ getFrame: () => frameWith((s, d) => d(null)) });
    await click(q('studio-export-button'));
    expect(msg()).toContain('Nothing to export');
    expect(onExport).not.toHaveBeenCalled();
  });
  it('reports a failed upload', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await setup({ onExport: vi.fn().mockRejectedValue(new Error('x')) });
    await click(q('studio-export-button'));
    expect(msg()).toContain('could not');
    spy.mockRestore();
  });
});
