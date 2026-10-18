// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const BLOCK =
  '2026-10-15 10:00:00 | WARNING | acestep.gpu_config:_log_gpu_diagnostic_info:646 - GPU NOT DETECTED - DIAGNOSTIC INFORMATION\n';

describe('pipelineManager engine log in processor mode', () => {
  let root: string;
  let manager: any;
  let written: string[];
  const savedEnv = { ...process.env };

  const start = async (mode: 'cpu' | 'gpu' | 'stream') => {
    root = mkdtempSync(path.join(tmpdir(), 'pm-cpu-'));
    mkdirSync(path.join(root, 'ACE-Step-1.5', 'checkpoints'), { recursive: true });
    writeFileSync(path.join(root, 'hardware_profile.env'), `HW_GPU_NAME="x"\nHW_MODE="${mode}"\nHW_ACE_TIER="1"\n`);
    Object.assign(process.env, { ACESTEP_PATH: path.join(root, 'ACE-Step-1.5'), NO_AUTO_BROWSER: 'true' });
    delete process.env.HW_MODE;
    delete process.env.HARDWARE_PROFILE_PATH;
    vi.resetModules();
    ({ pipelineManager: manager } = await import('./pipeline-manager.js'));
    written = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((c: any) => (written.push(String(c)), true));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  };

  afterEach(async () => {
    await manager.shutdown();
    vi.restoreAllMocks();
    process.env = { ...savedEnv };
    rmSync(root, { recursive: true, force: true });
  });

  it('hides the GPU NOT DETECTED block when the install chose the processor', async () => {
    await start('cpu');
    manager.ingestStdout(BLOCK + 'No GPU detected, running on CPU\n');
    const out = written.join('');
    expect(out).not.toContain('GPU NOT DETECTED');
    expect(out).toContain('[Gradio] No GPU detected, running on CPU');
  });

  it('keeps the block when a GPU was expected', async () => {
    await start('gpu');
    manager.ingestStdout(BLOCK);
    expect(written.join('')).toContain('GPU NOT DETECTED');
  });
});
