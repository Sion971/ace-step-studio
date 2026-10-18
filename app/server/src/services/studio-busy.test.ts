// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = {
  generation: false,
  queued: 0,
  training: 'idle',
  components: [] as Array<{ state: string }>,
  install: false,
};

vi.mock('./acestep.js', () => ({ hasUnfinishedGeneration: () => state.generation }));
vi.mock('./generationQueue.js', () => ({ generationQueue: { pendingCount: () => state.queued } }));
vi.mock('./training-runner.js', () => ({ trainingRunner: { getStatus: () => ({ state: state.training }) } }));
vi.mock('./pipeline-manager.js', () => ({ pipelineManager: { getStatus: () => ({ download: { components: state.components } }) } }));
vi.mock('../routes/lora-hub.js', () => ({ loraInstallRunning: () => state.install }));

import { studioIsBusy } from './studio-busy.js';

beforeEach(() => {
  Object.assign(state, { generation: false, queued: 0, training: 'idle', components: [], install: false });
});

describe('studioIsBusy', () => {
  it('is idle when nothing runs', () => {
    expect(studioIsBusy()).toBe(false);
  });

  it('is busy during a generation, whether running or waiting in the queue', () => {
    state.generation = true;
    expect(studioIsBusy()).toBe(true);
    state.generation = false;
    state.queued = 2;
    expect(studioIsBusy()).toBe(true);
  });

  it('is busy while a LoRA trains, not once it is over', () => {
    for (const s of ['starting', 'running']) {
      state.training = s;
      expect(studioIsBusy()).toBe(true);
    }
    for (const s of ['idle', 'completed', 'error', 'stopped']) {
      state.training = s;
      expect(studioIsBusy()).toBe(false);
    }
  });

  it('is busy while a model is being downloaded, but not for a file that is merely missing', () => {
    state.components = [{ state: 'pending' }, { state: 'done' }];
    expect(studioIsBusy()).toBe(false);
    state.components = [{ state: 'pending' }, { state: 'downloading' }];
    expect(studioIsBusy()).toBe(true);
  });

  it('is busy while a LoRA is being installed from the Hub', () => {
    state.install = true;
    expect(studioIsBusy()).toBe(true);
  });
});
