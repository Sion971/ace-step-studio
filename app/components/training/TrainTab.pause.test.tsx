// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TrainTab } from './TrainTab';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Pause after the current epoch: the button asks the server, and once the run is paused the checkpoint it stopped on goes
// into "Resume from" and the start button becomes "Resume training".
describe('training tab pause', () => {
  let container: HTMLDivElement;
  let root: Root;
  let status: Record<string, unknown>;
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    status = { state: 'running', message: '', pid: 1, epoch: 3, totalEpochs: 20, loss: 0.5, bestLoss: 0.5, lastEpochSec: 10,
      etaSec: 170, lastCheckpoint: null, trainableParams: null, elapsedSec: 30, metrics: [], log: '', lastError: null,
      outputPath: null, pauseRequested: false };
    fetchMock = vi.fn().mockImplementation(async (url: string) => ({
      ok: true,
      json: async () => (String(url).includes('/api/training/status') ? status
        : String(url).includes('/api/pipeline/status') ? { state: 'stopped', download: {} } : { paused: true }),
    }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const tick = () => act(async () => { await vi.advanceTimersByTimeAsync(1600); });

  it('asks for a pause, then offers to resume from the checkpoint it stopped on', async () => {
    await act(async () => { root.render(<TrainTab token="tok" t={(k: string) => k} markStep={() => {}} />); });
    await tick();
    const pause = container.querySelector('[data-testid="train-pause"]') as HTMLButtonElement;
    expect(pause.textContent).toContain('pauseTraining');

    status = { ...status, pauseRequested: true };
    await act(async () => { pause.click(); });
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).includes('/api/training/pause') && init?.method === 'POST')).toBe(true);
    await tick();
    expect((container.querySelector('[data-testid="train-pause"]') as HTMLButtonElement).disabled).toBe(true);
    expect(container.textContent).toContain('pauseTrainingPending');

    status = { ...status, state: 'paused', pauseRequested: false, epoch: 4, lastCheckpoint: 'lora_output/checkpoints/epoch_4_loss_0.5000' };
    await tick();
    expect(container.querySelector('[data-testid="train-pause"]')).toBeNull();
    const inputs = Array.from(container.querySelectorAll('input')) as HTMLInputElement[];
    expect(inputs.some(i => i.value === 'lora_output/checkpoints/epoch_4_loss_0.5000')).toBe(true);
    expect(container.textContent).toContain('resumeTraining');
  });
});
