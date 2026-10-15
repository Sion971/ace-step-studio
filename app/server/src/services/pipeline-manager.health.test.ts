// @vitest-environment node
//
// Health check of the real pipeline manager, without spawning anything: how long a silent engine is tolerated before it
// is declared a zombie (the language model's decoding blocks the engine's event loop for tens of seconds, or minutes on a CPU).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

describe('pipelineManager health check', () => {
  let root: string;
  let manager: any;
  const savedEnv = { ...process.env };

  const load = async () => {
    vi.resetModules();
    ({ pipelineManager: manager } = await import('./pipeline-manager.js'));
    manager.state = 'ready';
    manager.handleUnhealthy = vi.fn();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  };

  beforeEach(() => {
    vi.useFakeTimers();
    root = mkdtempSync(path.join(tmpdir(), 'pm-hc-'));
    mkdirSync(path.join(root, 'ACE-Step-1.5', 'checkpoints'), { recursive: true });
    Object.assign(process.env, { ACESTEP_PATH: path.join(root, 'ACE-Step-1.5'), NO_AUTO_BROWSER: 'true' });
    delete process.env.PIPELINE_HEALTH_TOLERANCE_SEC;
    delete process.env.ACESTEP_GENERATION_TIMEOUT;
  });

  afterEach(() => {
    manager?.stopHealthCheck();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    process.env = { ...savedEnv };
    rmSync(root, { recursive: true, force: true });
  });

  const silentEngine = () => vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));

  it('tolerates 120 s of silence by default (was 30 s) and then declares a zombie', async () => {
    await load();
    silentEngine();
    expect(manager.healthFailureLimit()).toBe(12);
    manager.startHealthCheck();
    await vi.advanceTimersByTimeAsync(110_000);
    expect(manager.handleUnhealthy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(manager.handleUnhealthy).toHaveBeenCalledTimes(1);
  });

  it('follows ACESTEP_GENERATION_TIMEOUT on a CPU (3600 s)', async () => {
    process.env.ACESTEP_GENERATION_TIMEOUT = '3600';
    await load();
    expect(manager.healthFailureLimit()).toBe(360);
  });

  it('lets PIPELINE_HEALTH_TOLERANCE_SEC decide, and never goes under 3 probes', async () => {
    process.env.PIPELINE_HEALTH_TOLERANCE_SEC = '5';
    await load();
    expect(manager.healthFailureLimit()).toBe(3);
  });

  it('forgets earlier failures as soon as the engine answers again', async () => {
    await load();
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      calls++;
      if (calls <= 11) throw new Error('timeout');
      return { ok: true, status: 200 };
    }));
    manager.startHealthCheck();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(manager.handleUnhealthy).not.toHaveBeenCalled();
  });
});
