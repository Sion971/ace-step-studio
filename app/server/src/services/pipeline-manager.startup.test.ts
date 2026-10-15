// @vitest-environment node
//
// The "Startup timeout ... pipeline still loading" warning belongs to an engine that is still starting. It used to fire five
// minutes after the launch whatever had happened since (engine ready, then stopped for a LoRA training).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

describe('pipelineManager start-up delay', () => {
  let root: string;
  let manager: any;
  let warn: ReturnType<typeof vi.spyOn>;
  const savedEnv = { ...process.env };

  const fakeEngine = () => {
    const proc: any = new EventEmitter();
    proc.pid = 4242;
    proc.stdout = new EventEmitter();
    proc.kill = vi.fn();
    return proc;
  };

  const load = async (proc: any) => {
    vi.resetModules();
    vi.doMock('child_process', async (orig) => ({ ...(await orig<typeof import('child_process')>()), spawn: vi.fn(() => proc), execSync: vi.fn() }));
    ({ pipelineManager: manager } = await import('./pipeline-manager.js'));
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  };

  beforeEach(() => {
    vi.useFakeTimers();
    root = mkdtempSync(path.join(tmpdir(), 'pm-st-'));
    mkdirSync(path.join(root, 'ACE-Step-1.5'), { recursive: true });
    Object.assign(process.env, { ACESTEP_PATH: path.join(root, 'ACE-Step-1.5'), PYTHON_PATH: process.execPath, NO_AUTO_BROWSER: 'true' });
  });
  afterEach(() => {
    manager?.stopHealthCheck();
    vi.useRealTimers();
    vi.doUnmock('child_process');
    vi.restoreAllMocks();
    process.env = { ...savedEnv };
    rmSync(root, { recursive: true, force: true });
  });

  it('still warns when the engine really is too slow to start', async () => {
    await load(fakeEngine());
    const started = manager.start();
    await vi.advanceTimersByTimeAsync(300_001);
    await started;
    expect(warn.mock.calls.some(c => String(c[0]).includes('Startup timeout'))).toBe(true);
  });

  it('says nothing once the engine was stopped for a training before the delay ran out', async () => {
    const proc = fakeEngine();
    await load(proc);
    const started = manager.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await manager.stopForTraining();
    proc.emit('exit', 1, null);
    await started;
    await vi.advanceTimersByTimeAsync(400_000);
    expect(warn.mock.calls.some(c => String(c[0]).includes('Startup timeout'))).toBe(false);
  });

  it('says nothing when the engine exits by itself', async () => {
    const proc = fakeEngine();
    await load(proc);
    manager.scheduleRestart = vi.fn();
    const started = manager.start();
    await vi.advanceTimersByTimeAsync(1_000);
    proc.emit('exit', 1, null);
    await started;
    await vi.advanceTimersByTimeAsync(400_000);
    expect(warn.mock.calls.some(c => String(c[0]).includes('Startup timeout'))).toBe(false);
  });
});
