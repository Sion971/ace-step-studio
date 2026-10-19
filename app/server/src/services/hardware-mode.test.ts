// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { hardwareMode, isCpuMode, isStreamMode, coversBlockedBySmallCard } from './hardware-mode.js';

describe('hardware mode', () => {
  let dir: string;
  const saved = { ...process.env };
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'hw-mode-'));
    delete process.env.HW_MODE;
    delete process.env.HW_VRAM_TORCH_MIB;
    delete process.env.HW_VRAM_MIB;
    delete process.env.STUDIO_COVERS_ON_STREAM;
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

  describe('AI covers in stream mode', () => {
    const withCard = (mode: string, torchMib?: number) =>
      writeFileSync(path.join(dir, 'hardware_profile.env'), `HW_MODE="${mode}"\n${torchMib ? `HW_VRAM_TORCH_MIB="${torchMib}"\n` : ''}`);

    it('are never blocked outside stream mode', () => {
      withCard('gpu', 2048);
      expect(coversBlockedBySmallCard()).toBe(false);
    });
    it('are blocked on a 2 GB card in stream mode', () => {
      withCard('stream', 1900);
      expect(coversBlockedBySmallCard()).toBe(true);
    });
    it('work on an 8 GB card in stream mode', () => {
      withCard('stream', 7800);
      expect(coversBlockedBySmallCard()).toBe(false);
    });
    it('are blocked just under 6 GiB and allowed at 6 GiB', () => {
      withCard('stream', 6000);
      expect(coversBlockedBySmallCard()).toBe(true);
      withCard('stream', 6144);
      expect(coversBlockedBySmallCard()).toBe(false);
    });
    it('are blocked when the card size is unknown', () => {
      withCard('stream');
      expect(coversBlockedBySmallCard()).toBe(true);
    });
    it('follow the card size given in the environment before the file', () => {
      withCard('stream', 1900);
      process.env.HW_VRAM_TORCH_MIB = '7800';
      expect(coversBlockedBySmallCard()).toBe(false);
    });
    it('can be forced with STUDIO_COVERS_ON_STREAM', () => {
      withCard('stream', 1900);
      process.env.STUDIO_COVERS_ON_STREAM = 'on';
      expect(coversBlockedBySmallCard()).toBe(false);
      withCard('stream', 7800);
      process.env.STUDIO_COVERS_ON_STREAM = 'off';
      expect(coversBlockedBySmallCard()).toBe(true);
    });
  });
});
