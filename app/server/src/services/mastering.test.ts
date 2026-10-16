// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NO_MASTERING, buildMasteringFilter, isMasteringActive, limiterCeiling, parseMasteringSettings, type MasteringSettings } from './mastering.js';

describe('parseMasteringSettings', () => {
  it('reads multipart strings and clamps them', () => {
    expect(parseMasteringSettings({ harmonics: '40', warmth: '250', tone: '-300', glue: '10.5', width: '-5' })).toEqual({
      harmonics: 40, warmth: 100, tone: -100, glue: 10.5, width: 0,
    });
  });
  it('treats missing or garbled fields as 0', () => {
    expect(parseMasteringSettings(undefined)).toEqual(NO_MASTERING);
    expect(parseMasteringSettings({ harmonics: 'abc', warmth: null, tone: {} })).toEqual(NO_MASTERING);
  });
});

describe('buildMasteringFilter', () => {
  it('does nothing when every setting is 0 (or below 1)', () => {
    expect(isMasteringActive(NO_MASTERING)).toBe(false);
    expect(buildMasteringFilter(NO_MASTERING)).toBe('');
    expect(buildMasteringFilter({ ...NO_MASTERING, warmth: 0.4, tone: -0.9 })).toBe('');
  });

  it('adds only the stages that are asked for, in a fixed order', () => {
    const only = (patch: Partial<MasteringSettings>) => buildMasteringFilter({ ...NO_MASTERING, ...patch });
    expect(only({ harmonics: 50 })).toBe('highpass=f=25,aexciter=amount=1.50:drive=8.5:blend=0:freq=7500:ceil=16000');
    expect(only({ glue: 100 })).toBe('highpass=f=25,acompressor=threshold=-22.00dB:ratio=3.00:attack=30:release=250:makeup=1');
    expect(only({ width: 50 })).toBe('highpass=f=25,extrastereo=m=1.20:c=0');
    expect(only({ tone: 100 })).toBe('highpass=f=25,treble=g=3.00:f=6000,bass=g=-1.50:f=120');
    expect(only({ tone: -100 })).toBe('highpass=f=25,treble=g=-3.00:f=6000,bass=g=1.50:f=120');

    const all = buildMasteringFilter({ harmonics: 30, warmth: 50, tone: 20, glue: 40, width: 10 });
    const order = ['highpass', 'treble', 'bass', 'asoftclip', 'aexciter', 'acompressor', 'extrastereo'].map((f) => all.indexOf(f));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('keeps the dry and wet weights adding up to 1, so warmth does not raise the level', () => {
    for (const warmth of [1, 25, 60, 100]) {
      const m = buildMasteringFilter({ ...NO_MASTERING, warmth }).match(/weights=([\d.]+) ([\d.]+):/)!;
      expect(parseFloat(m[1]) + parseFloat(m[2])).toBeCloseTo(1, 3);
    }
  });
});

describe('limiterCeiling', () => {
  it('turns dBTP into a linear ceiling', () => {
    expect(limiterCeiling(-1)).toBeCloseTo(0.891, 3);
    expect(limiterCeiling(-2)).toBeCloseTo(0.794, 3);
    expect(limiterCeiling(6)).toBe(1);
  });
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

describe.skipIf(!hasFfmpeg)('with the real ffmpeg', () => {
  const run = (filter: string, input: string, output: string) =>
    spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', input, '-af', filter, '-ar', '48000', output], { encoding: 'utf-8' });

  it('accepts every combination of the chain, keeps the duration, and really adds harmonics', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mastering-test-'));
    try {
      const input = path.join(dir, 'in.wav');
      const made = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=330:d=3,volume=7.2', '-ac', '2', '-ar', '48000', input]);
      expect(made.status).toBe(0);

      for (const settings of [
        { harmonics: 100, warmth: 100, tone: 100, glue: 100, width: 100 },
        { harmonics: 100, warmth: 0, tone: 0, glue: 0, width: 0 },
        { harmonics: 0, warmth: 60, tone: -50, glue: 0, width: 0 },
      ]) {
        const out = path.join(dir, 'out.wav');
        const res = run(buildMasteringFilter(settings), input, out);
        expect(res.stderr).toBe('');
        expect(res.status).toBe(0);
        expect(existsSync(out)).toBe(true);
        const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', out], { encoding: 'utf-8' });
        expect(parseFloat(probe.stdout)).toBeCloseTo(3, 1);
      }

      // Warmth on a loud sine: the third harmonic (990 Hz; a symmetric soft clip makes odd harmonics) must appear, which a clean pass-through never has (the band is cut with
      // steep filters so that the 330 Hz tone itself does not leak into the measure).
      const warm = path.join(dir, 'warm.wav');
      expect(run(buildMasteringFilter({ ...NO_MASTERING, warmth: 100 }), input, warm).status).toBe(0);
      const level = (file: string) => {
        const r = spawnSync('ffmpeg', ['-v', 'info', '-i', file, '-af', 'highpass=f=900,highpass=f=900,highpass=f=900,highpass=f=900,lowpass=f=1080,lowpass=f=1080,lowpass=f=1080,lowpass=f=1080,astats=metadata=0', '-f', 'null', '-'], { encoding: 'utf-8' });
        const m = r.stderr.match(/RMS level dB:\s*(-?[\d.]+|-inf)/);
        return m && m[1] !== '-inf' ? parseFloat(m[1]) : -200;
      };
      expect(level(warm)).toBeGreaterThan(level(input) + 20);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
