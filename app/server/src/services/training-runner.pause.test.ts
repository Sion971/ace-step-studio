// @vitest-environment node
//
// Pause after the current epoch. A node script stands in for train.py: it waits for the file named by
// ACESTEP_TRAINING_PAUSE_FILE, then prints what the Python loops print when they pause, and exits 0.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const fakeTrainer = (lastEpoch: string) => `
const fs = require('fs');
const f = process.env.ACESTEP_TRAINING_PAUSE_FILE;
console.log('[OK] Epoch 3/20 in 1.0s, Loss: 0.6000');
const t = setInterval(() => {
  if (!fs.existsSync(f)) return;
  clearInterval(t);
  console.log('[OK] Epoch 4/20 in 1.0s, Loss: 0.5000');
  console.log('[OK] Checkpoint saved at epoch 4: ${lastEpoch}');
  console.log('[PAUSED] Training paused after epoch 4/20. Resume from: ${lastEpoch}');
  process.exit(0);
}, 20);
`;

describe('training runner pause', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'runner-pause-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('asks train.py to pause, then reports the paused state and its checkpoint', async () => {
    const ckpt = 'lora_output/checkpoints/epoch_4_loss_0.5000';
    writeFileSync(path.join(dir, 'train.py'), fakeTrainer(ckpt));
    const { trainingRunner } = await import('./training-runner.js');
    const finished = new Promise<void>((resolve) => trainingRunner.onFinish(resolve));
    trainingRunner.start({} as any, process.execPath, dir);
    expect(trainingRunner.getStatus().pauseRequested).toBe(false);

    expect(trainingRunner.pause()).toBe(true);
    expect(trainingRunner.getStatus().pauseRequested).toBe(true);
    const pauseFile = (trainingRunner as any).pauseFile as string;
    expect(existsSync(pauseFile)).toBe(true);

    await finished;
    const s = trainingRunner.getStatus();
    expect(s.state).toBe('paused');
    expect(s.lastCheckpoint).toBe(ckpt);
    expect(s.epoch).toBe(4);
    expect(s.pauseRequested).toBe(false);
    expect(trainingRunner.isRunning()).toBe(false);
    expect(existsSync(pauseFile)).toBe(false);
    expect(trainingRunner.pause()).toBe(false);
  });

  it('a run that ends without pausing is completed, even when a pause came too late', async () => {
    writeFileSync(path.join(dir, 'train.py'), "console.log('[OK] Checkpoint saved at epoch 2: out\\\\checkpoints\\\\epoch_2_loss_0.7');");
    const { trainingRunner } = await import('./training-runner.js');
    const finished = new Promise<void>((resolve) => trainingRunner.onFinish(resolve));
    trainingRunner.start({} as any, process.execPath, dir);
    trainingRunner.pause();
    await finished;
    const s = trainingRunner.getStatus();
    expect(s.state).toBe('completed');
    // Windows paths and LoKr runs: the checkpoint is read from the "Checkpoint saved" line.
    expect(s.lastCheckpoint).toBe('out\\checkpoints\\epoch_2_loss_0.7');
  });
});
