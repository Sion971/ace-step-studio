// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { I18nProvider } from '../context/I18nContext';
import { SetupScreen, READY_HOLD_MS, DISMISS_STORAGE_KEY } from './SetupScreen';
import type { ComponentDto, PipelineStatusDto } from '../services/setup-view';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const comp = (over: Partial<ComponentDto>): ComponentDto => ({ id: 'main', kind: 'main', state: 'pending', ...over });
const downloadingStatus = (over: Record<string, unknown> = {}): PipelineStatusDto => ({
  state: 'starting',
  message: 'GPU detected, configuring...',
  download: {
    phase: 'downloading',
    elapsedMs: 100_000,
    components: [
      comp({ id: 'main', kind: 'main', state: 'done', expectedBytes: 1_540_000_000, seconds: 121 }),
      comp({ id: 'acestep-v15-turbo', kind: 'dit', state: 'downloading', expectedBytes: 4_790_000_000, bytesDone: 0, bytesTotal: 4_790_000_000, elapsedMs: 100_000 }),
    ],
    disk: { freeBytes: 400e9, neededBytes: 4_790_000_000, low: false },
    profile: { gpuName: 'NVIDIA GeForce GTX 1050', vramGiB: 1.95, mode: 'gpu', tier: 1 },
    ...over,
  },
});

describe('SetupScreen', () => {
  let container: HTMLDivElement;
  let root: Root;
  let current: PipelineStatusDto | 'fail';
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('language', 'en');
    current = downloadingStatus();
    fetchMock = vi.fn(async () => {
      if (current === 'fail') throw new Error('connection refused');
      return { ok: true, json: async () => current } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const mount = async () => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <SetupScreen />
        </I18nProvider>,
      );
    });
  };
  const advance = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };
  const screen = () => container.querySelector('[data-testid="setup-screen"]');
  const text = () => container.textContent ?? '';
  const rowText = (state: string) => Array.from(container.querySelectorAll(`[data-state="${state}"]`)).map((n) => n.textContent ?? '');

  it('stays hidden, and stops asking, when the models are already on disk', async () => {
    current = downloadingStatus({ phase: 'loading', components: [comp({ state: 'done' })] });
    await mount();
    expect(screen()).toBeNull();
    await advance(20_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stays hidden, and stops asking, for an engine the Studio does not run', async () => {
    current = { ...downloadingStatus(), state: 'stopped' };
    await mount();
    expect(screen()).toBeNull();
    await advance(20_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shows the hardware, the models and their state while downloading', async () => {
    await mount();
    expect(screen()).not.toBeNull();
    expect(text()).toContain('Downloading the AI models');
    expect(text()).toContain('NVIDIA GeForce GTX 1050');
    expect(text()).toContain('1.95 GiB');
    expect(rowText('done')[0]).toContain('Base files');
    expect(rowText('downloading')[0]).toContain('acestep-v15-turbo');
    expect(rowText('downloading')[0]).toContain('0 KB / 4.79 GB');
    expect(text()).toContain('1:40'); // elapsed
  });

  it('is honest about what it cannot know: jumping counters, and no remaining time yet', async () => {
    await mount();
    expect(text()).toContain('The counters move in jumps');
    expect(text()).toContain('Available after the first download');
    expect(text()).not.toContain('≈ 0:');
  });

  it('labels the remaining time as an estimate when the server can compute it', async () => {
    current = downloadingStatus({ etaMs: 277_000 });
    await mount();
    expect(text()).toContain('≈ 4:37');
  });

  it('warns when the missing models would not fit on the disk', async () => {
    current = downloadingStatus({ disk: { freeBytes: 5e9, neededBytes: 6_330_000_000, low: true } });
    await mount();
    const warning = container.querySelector('[data-testid="setup-disk-warning"]');
    expect(warning).not.toBeNull();
    expect(warning!.textContent).toContain('5.00 GB');
    expect(warning!.textContent).toContain('≈ 6.33 GB');
  });

  it('follows the download as the server reports it', async () => {
    await mount();
    expect(rowText('downloading')).toHaveLength(1);
    current = downloadingStatus({
      components: [
        comp({ id: 'main', kind: 'main', state: 'done', seconds: 121 }),
        comp({ id: 'acestep-v15-turbo', kind: 'dit', state: 'done', expectedBytes: 4_790_000_000, seconds: 380 }),
      ],
    });
    await advance(2_000);
    expect(rowText('downloading')).toHaveLength(0);
    expect(rowText('done')).toHaveLength(2);
  });

  it('stays up while the engine loads the models, until it is ready', async () => {
    await mount();
    current = { state: 'loading_model', download: downloadingStatus({ phase: 'loading', components: [comp({ state: 'done' })] }).download };
    await advance(2_000);
    expect(screen()).not.toBeNull();
    expect(text()).toContain('Starting the engine');
  });

  it('says it is ready, then hands over to the Studio and stops asking', async () => {
    await mount();
    current = { state: 'ready', download: downloadingStatus({ phase: 'ready', components: [comp({ state: 'done' })] }).download };
    await advance(2_000);
    expect(text()).toContain('Ready');
    expect(screen()).not.toBeNull();
    await advance(READY_HOLD_MS + 100);
    expect(screen()).toBeNull();
    const calls = fetchMock.mock.calls.length;
    await advance(20_000);
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it('lets the user continue without waiting, and remembers it for the session', async () => {
    await mount();
    const button = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Continue without waiting'))!;
    expect(button).toBeDefined();
    await act(async () => button.click());
    expect(screen()).toBeNull();
    expect(sessionStorage.getItem(DISMISS_STORAGE_KEY)).toBe('1');
    // a reload in the same tab does not bring it back, and does not even ask the server
    await act(async () => root.unmount());
    fetchMock.mockClear();
    root = createRoot(container);
    await mount();
    expect(screen()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows the reason when a download failed', async () => {
    current = {
      state: 'error',
      download: downloadingStatus({
        phase: 'error',
        error: 'No space left on device',
        components: [comp({ id: 'acestep-v15-turbo', kind: 'dit', state: 'failed', error: 'No space left on device' })],
      }).download,
    };
    await mount();
    expect(text()).toContain('Something went wrong');
    expect(container.querySelector('[data-testid="setup-error"]')!.textContent).toContain('No space left on device');
    expect(rowText('failed')[0]).toContain('Failed');
  });

  it('speaks French when the Studio does', async () => {
    localStorage.setItem('language', 'fr');
    await mount();
    expect(text()).toContain("Téléchargement des modèles d'IA");
    expect(text()).toContain('1,95 Gio');
    expect(text()).toContain('4,79 Go');
    expect(text()).toContain('Continuer sans attendre');
  });

  it('retries quietly when the server cannot be reached, then shows the screen', async () => {
    current = 'fail';
    await mount();
    expect(screen()).toBeNull();
    current = downloadingStatus();
    await advance(4_100);
    expect(screen()).not.toBeNull();
  });
});
