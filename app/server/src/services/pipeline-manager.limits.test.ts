// @vitest-environment node
//
// The longest song the engine accepts depends on the machine; the engine prints it at start-up and the server relays it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

describe('pipelineManager duration limits', () => {
  let root: string;
  let manager: any;
  const savedEnv = { ...process.env };

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'pm-lim-'));
    mkdirSync(path.join(root, 'ACE-Step-1.5'), { recursive: true });
    Object.assign(process.env, { ACESTEP_PATH: path.join(root, 'ACE-Step-1.5'), NO_AUTO_BROWSER: 'true' });
    vi.resetModules();
    ({ pipelineManager: manager } = await import('./pipeline-manager.js'));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...savedEnv };
    rmSync(root, { recursive: true, force: true });
  });

  it('knows nothing before the engine has printed its limits', () => {
    expect(manager.getLimits()).toBeNull();
  });

  it('reads the two limits of the engine banner (an 8 GB card)', () => {
    manager.ingestStdout('  GPU Memory: 7.93 GB\n  Configuration Tier: tier3\n  Max Duration (with LM): 480s (8 min)\n  Max Duration (without LM): 600s (10 min)\n  Max Batch Size (with LM): 2\n');
    expect(manager.getLimits()).toEqual({ withLm: 480, withoutLm: 600 });
  });

  it('reads the CPU banner, where the prefix of the next line is glued on', () => {
    manager.ingestStdout('  Max Duration (with LM): 240s (4 min)[Gradio]\n  Max Duration (without LM): 360s (6 min)\n');
    expect(manager.getLimits()).toEqual({ withLm: 240, withoutLm: 360 });
  });

  it('reads a limit cut in two chunks', () => {
    manager.ingestStdout('  Max Duration (with LM): 4');
    manager.ingestStdout('80s (8 min)\n  Max Duration (without');
    manager.ingestStdout(' LM): 600s (10 min)\n');
    expect(manager.getLimits()).toEqual({ withLm: 480, withoutLm: 600 });
  });

  it('keeps the limits when the engine restarts and is silent for a while', () => {
    manager.ingestStdout('  Max Duration (with LM): 480s\n  Max Duration (without LM): 600s\n');
    manager.ingestStdout('some other line\n');
    expect(manager.getLimits()).toEqual({ withLm: 480, withoutLm: 600 });
  });
});
