// @vitest-environment node
//
// Deliberate restart of the engine (CUDA context lost): the process is killed, the usual crash handling restarts it, and
// the queue can wait until it is back. Nothing is spawned here.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

describe('pipelineManager.restartEngine / whenReady', () => {
  let root: string;
  let manager: any;
  const savedEnv = { ...process.env };
  const execSync = vi.fn();

  const load = async () => {
    vi.resetModules();
    vi.doMock('child_process', async (original: any) => ({ ...(await original()), execSync }));
    ({ pipelineManager: manager } = await import('./pipeline-manager.js'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  };

  const fakeProcess = () => ({ pid: 4242, kill: vi.fn() });

  beforeEach(() => {
    vi.useFakeTimers();
    execSync.mockReset();
    root = mkdtempSync(path.join(tmpdir(), 'pm-restart-'));
    mkdirSync(path.join(root, 'ACE-Step-1.5', 'checkpoints'), { recursive: true });
    Object.assign(process.env, { ACESTEP_PATH: path.join(root, 'ACE-Step-1.5'), NO_AUTO_BROWSER: 'true' });
  });

  afterEach(() => {
    manager?.stopHealthCheck();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.doUnmock('child_process');
    process.env = { ...savedEnv };
    rmSync(root, { recursive: true, force: true });
  });

  it('kills the engine and leaves the restart to its exit handler', async () => {
    await load();
    const proc = fakeProcess();
    manager.process = proc;
    manager.state = 'ready';
    expect(manager.restartEngine('CUDA context lost')).toBe(true);
    expect(manager.getStatus().state).toBe('error');
    expect(manager.getStatus().lastError).toBe('CUDA context lost');
    expect(manager.process).toBeNull();
    if (process.platform === 'win32') expect(execSync).toHaveBeenCalledWith(expect.stringContaining('taskkill /pid 4242'), expect.anything());
    else expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('does nothing when the engine is not run by this server', async () => {
    await load();
    manager.state = 'stopped';
    expect(manager.restartEngine('CUDA context lost')).toBe(false);
    expect(manager.getStatus().state).toBe('stopped');
  });

  it('does not restart twice, nor during a shutdown or a training stop', async () => {
    await load();
    manager.process = fakeProcess();
    manager.state = 'restarting';
    expect(manager.restartEngine('x')).toBe(false);
    manager.state = 'ready';
    manager.isShuttingDown = true;
    expect(manager.restartEngine('x')).toBe(false);
    manager.isShuttingDown = false;
    manager.isStoppedForTraining = true;
    expect(manager.restartEngine('x')).toBe(false);
  });

  it('whenReady resolves true when the engine comes back', async () => {
    await load();
    manager.state = 'restarting';
    const waiting = manager.whenReady(60_000, 1000);
    await vi.advanceTimersByTimeAsync(5000);
    manager.state = 'ready';
    await vi.advanceTimersByTimeAsync(1000);
    await expect(waiting).resolves.toBe(true);
  });

  it('whenReady gives up after the delay', async () => {
    await load();
    manager.state = 'error';
    const waiting = manager.whenReady(5000, 1000);
    await vi.advanceTimersByTimeAsync(6000);
    await expect(waiting).resolves.toBe(false);
  });

  it('whenReady answers at once when the engine is ready', async () => {
    await load();
    manager.state = 'ready';
    await expect(manager.whenReady(5000)).resolves.toBe(true);
  });
});
