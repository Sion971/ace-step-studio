// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TrainTab } from './TrainTab';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// The tab picks a preset by itself from the memory the server reports, unless the user already touched a field.
describe('training tab presets', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const serve = (profile: object | undefined) =>
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ download: profile ? { profile } : {} }) }));

  const render = async () => {
    await act(async () => {
      root.render(<TrainTab token={null} t={(k: string) => k} markStep={() => {}} />);
    });
    await act(async () => { await Promise.resolve(); });
  };
  const select = () => container.querySelector('option[value="default"]')!.parentElement as HTMLSelectElement;
  const rangeLabels = () => [...container.querySelectorAll('label')].map((l) => l.textContent ?? '');

  it('selects the 8 GB preset for a 7.6 GiB card and says what it detected', async () => {
    serve({ vramGiB: 7.6, mode: 'gpu' });
    await render();
    expect(select().value).toBe('vram_8gb');
    expect(container.textContent).toContain('trainingPresetDetected');
    expect(container.querySelector('option[value="vram_8gb"]')?.textContent).toBe('trainingPresetVram8');
  });

  it('selects the 24 GB preset for a big card', async () => {
    serve({ vramGiB: 23.5, mode: 'gpu' });
    await render();
    expect(select().value).toBe('vram_24gb_plus');
  });

  it('keeps the Studio defaults on a CPU or without a profile', async () => {
    serve({ vramGiB: 0, mode: 'cpu' });
    await render();
    expect(select().value).toBe('default');
    vi.unstubAllGlobals();
    serve(undefined);
    await render();
    expect(select().value).toBe('default');
  });

  // Small-card mode ticked to start with on cards under 12 GB (torch reports a 12 GB card as about 11.7 GiB).
  const smallCard = () => {
    const label = [...container.querySelectorAll('label')].find((l) => (l.textContent ?? '').includes('streamBlocks'));
    return (label?.querySelector('input[type="checkbox"]') as HTMLInputElement).checked;
  };

  it('ticks the small-card mode on an 8 GB card, not on a 12 GB one nor on a CPU', async () => {
    serve({ vramGiB: 7.6, mode: 'gpu' });
    await render();
    expect(smallCard()).toBe(true);
    act(() => root.unmount());
    root = createRoot(container);
    vi.unstubAllGlobals();
    serve({ vramGiB: 11.7, mode: 'gpu' });
    await render();
    expect(smallCard()).toBe(false);
    act(() => root.unmount());
    root = createRoot(container);
    vi.unstubAllGlobals();
    serve({ vramGiB: 0, mode: 'cpu' });
    await render();
    expect(smallCard()).toBe(false);
  });

  it('shows the new options', async () => {
    serve(undefined);
    await render();
    const text = rangeLabels().join('|');
    for (const key of ['cfgRatio', 'trainingSchedulerType', 'warmupSteps', 'attentionType']) expect(text, key).toContain(key);
  });
});
