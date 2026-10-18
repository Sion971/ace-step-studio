// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { hardwareMode, isCpuMode, isStreamMode } from './hardware-mode.js';

describe('hardware mode', () => {
  let dir: string;
  const saved = { ...process.env };
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'hw-mode-'));
    delete process.env.HW_MODE;
    process.env.HARDWARE_PROFILE_PATH = path.join(dir, 'hardware_profile.env');
  });
  afterEach(() => {
    process.env = { ...saved };
    rmSync(dir, { recursive: true, force: true });
  });

  const profile = (mode: string) => writeFileSync(path.join(dir, 'hardware_profile.env'), `HW_GPU_NAME="x"\nHW_MODE="${mode}"\n`);

  it('reads the mode from hardware_profile.env', () => {
    profile('stream');
    expect(hardwareMode()).toBe('stream');
    expect(isStreamMode()).toBe(true);
    expect(isCpuMode()).toBe(false);
    profile('cpu');
    expect(isCpuMode()).toBe(true);
    expect(isStreamMode()).toBe(false);
    profile('gpu');
    expect(hardwareMode()).toBe('gpu');
  });

  it('lets HW_MODE in the environment win over the file', () => {
    profile('gpu');
    process.env.HW_MODE = 'stream';
    expect(isStreamMode()).toBe(true);
    process.env.HW_MODE = 'bogus';
    expect(hardwareMode()).toBeUndefined();
  });

  it('has no mode without a profile', () => {
    expect(hardwareMode()).toBeUndefined();
    expect(isStreamMode()).toBe(false);
  });
});
