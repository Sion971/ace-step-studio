// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TrainTab } from './TrainTab';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// While a LoRA trains the engine is stopped. Once the run is over the tab shows the restart button only if the engine is
// really stopped (it used to depend on a flag lost at each page reload), and a note while the server restarts it by itself.
describe('training tab and the engine', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const idleStatus = { state: 'idle', message: '', pid: null, epoch: 0, totalEpochs: 0, loss: null, bestLoss: null, lastEpochSec: null,
    etaSec: null, lastCheckpoint: null, trainableParams: null, elapsedSec: null, metrics: [], log: '', lastError: null, outputPath: null };

  const show = async (engine: string) => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => ({
      ok: true,
      json: async () => (String(url).includes('/api/training/status') ? idleStatus : String(url).includes('/api/pipeline/status') ? { state: engine, download: {} } : {}),
    })));
    await act(async () => {
      root.render(<TrainTab token="tok" t={(k: string) => k} markStep={() => {}} />);
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(1700); });
  };

  it('offers to restart the engine when it is stopped', async () => {
    await show('stopped');
    expect(container.textContent).toContain('restartPipeline');
  });

  it('shows no button when the engine is ready', async () => {
    await show('ready');
    expect(container.textContent).not.toContain('restartPipeline');
    expect(container.textContent).not.toContain('engineRestarting');
  });

  it('says the engine is coming back while the server restarts it', async () => {
    await show('starting');
    expect(container.textContent).toContain('engineRestarting');
    expect(container.textContent).not.toContain('restartPipeline');
  });
});
