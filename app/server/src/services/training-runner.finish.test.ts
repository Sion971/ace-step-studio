// @vitest-environment node
//
// The runner tells the route when a run ends, so the engine stopped for training can be restarted. A node script stands in for
// train.py (node runs any file given as the entry point, whatever its extension).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

describe('training runner onFinish', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'runner-finish-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = async (script: string) => {
    writeFileSync(path.join(dir, 'train.py'), script);
    const { trainingRunner } = await import('./training-runner.js');
    const finished = new Promise<void>((resolve) => trainingRunner.onFinish(resolve));
    trainingRunner.start({} as any, process.execPath, dir);
    await finished;
    return trainingRunner;
  };

  it('fires once when the run completes', async () => {
    const runner = await run('console.log("done");');
    expect(runner.getStatus().state).toBe('completed');
    expect(runner.isRunning()).toBe(false);
  });

  it('fires when the run fails', async () => {
    const runner = await run('console.error("boom"); process.exit(3);');
    expect(runner.getStatus().state).toBe('error');
  });

  it('does not call a listener twice, nor one registered for an earlier run', async () => {
    const { trainingRunner } = await import('./training-runner.js');
    let calls = 0;
    trainingRunner.onFinish(() => { calls++; });
    await run('console.log("one");');
    await run('console.log("two");');
    expect(calls).toBe(1);
  });
});
