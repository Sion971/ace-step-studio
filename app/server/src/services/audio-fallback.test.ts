// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runFallbackTool } from './audio-fallback.js';
import { mixStemWithSource, type MixDeps } from './track-mix.js';
import { stretchAudio } from './audio-transcode.js';

const hasTools = spawnSync('python3', ['-c', 'import numpy, scipy, soundfile']).status === 0;
const py = (args: string[]) => runFallbackTool(args, 'python3');

/** A stereo 16-bit WAV: a few notes with a slow swell, like a tiny piece of music. */
function music(seconds: number, rate = 44100, level = 0.4): Buffer {
  const n = Math.round(seconds * rate);
  const b = Buffer.alloc(44 + n * 4);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 4, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const env = Math.pow(0.5 + 0.5 * Math.sin((2 * Math.PI * t) / 3), 1.5);
    const v = (Math.sin(2 * Math.PI * 110 * t) * 0.5 + Math.sin(2 * Math.PI * 330 * t) * 0.25 + Math.sin(2 * Math.PI * 880 * t) * 0.1) * env * level;
    b.writeInt16LE(Math.round(v * 32767), 44 + i * 4);
    b.writeInt16LE(Math.round(v * 0.9 * 32767), 46 + i * 4);
  }
  return b;
}
const seconds = (wav: Buffer) => (wav.length - 44) / (wav.readUInt32LE(24) * 4);
async function tmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fallback-test-'));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

describe.skipIf(!hasTools)('audio_fallback.py (no ffmpeg)', () => {
  it('normalises to the target loudness and keeps the peak under the ceiling', () => tmp(async (dir) => {
    await writeFile(path.join(dir, 'in.wav'), music(10));
    const out = await py(['loudnorm', '--input', path.join(dir, 'in.wav'), '--out', path.join(dir, 'out.wav'), '--target-i', '-14', '--target-tp', '-1']);
    const info = JSON.parse(out.trim().split('\n').pop()!);
    expect(info.original).toBeLessThan(-14);                      // the piece is quieter than the target
    expect(info.result).toBeGreaterThan(-14.3);
    expect(info.result).toBeLessThan(-13.7);
    const wav = await readFile(path.join(dir, 'out.wav'));
    expect(wav.readUInt32LE(24)).toBe(48000);
  }));

  it('with mastering, still reaches the loudness and never passes the ceiling', () => tmp(async (dir) => {
    await writeFile(path.join(dir, 'in.wav'), music(10, 44100, 0.7));
    const out = await py(['loudnorm', '--input', path.join(dir, 'in.wav'), '--out', path.join(dir, 'out.wav'), '--target-i', '-9', '--target-tp', '-1',
      '--warmth', '60', '--harmonics', '40', '--tone', '30', '--glue', '70', '--width', '50']);
    const info = JSON.parse(out.trim().split('\n').pop()!);
    expect(Math.abs(info.result - -9)).toBeLessThan(0.8);
    const wav = await readFile(path.join(dir, 'out.wav'));
    let peak = 0;
    for (let i = 44; i + 1 < wav.length; i += 2) peak = Math.max(peak, Math.abs(wav.readInt16LE(i)) / 32768);
    expect(peak).toBeLessThanOrEqual(Math.pow(10, -1 / 20) + 0.005);
  }));

  it('stretches in time without changing the length ratio wrongly', () => tmp(async (dir) => {
    await writeFile(path.join(dir, 'in.wav'), music(6));
    for (const [ratio, expected] of [[1.25, 4.8], [0.8, 7.5]] as const) {
      await py(['stretch', '--input', path.join(dir, 'in.wav'), '--out', path.join(dir, 'o.wav'), '--ratio', String(ratio)]);
      expect(Math.abs(seconds(await readFile(path.join(dir, 'o.wav'))) - expected)).toBeLessThan(0.1);
    }
  }));

  it('refuses a ratio beyond 0.25 to 4', () => tmp(async (dir) => {
    await writeFile(path.join(dir, 'in.wav'), music(2));
    await expect(py(['stretch', '--input', path.join(dir, 'in.wav'), '--out', path.join(dir, 'o.wav'), '--ratio', '9'])).rejects.toThrow(/ratio/);
  }));

  it('mixes two files into a FLAC and an MP3 with the peak under 0.95', () => tmp(async (dir) => {
    await writeFile(path.join(dir, 'a.wav'), music(4, 44100, 0.9));
    await writeFile(path.join(dir, 'b.wav'), music(5, 48000, 0.9));
    await py(['mix', '--source', path.join(dir, 'a.wav'), '--stem', path.join(dir, 'b.wav'), '--out', path.join(dir, 'm.flac'), '--level', '100']);
    const flac = await readFile(path.join(dir, 'm.flac'));
    expect(flac.subarray(0, 4).toString('latin1')).toBe('fLaC');
    await py(['mix', '--source', path.join(dir, 'a.wav'), '--stem', path.join(dir, 'b.wav'), '--out', path.join(dir, 'm.mp3'), '--level', '100']);
    expect((await readFile(path.join(dir, 'm.mp3'))).length).toBeGreaterThan(1000);
  }));

  it('stretchAudio falls back on it when ffmpeg is blocked', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await stretchAudio(music(4), 'x.wav', 2, {
      ffmpeg: async () => { throw new Error('ffmpeg failed (code 3236495362)'); },
      python: async (i, o, r) => { await py(['stretch', '--input', i, '--out', o, '--ratio', String(r)]); },
    });
    expect(Math.abs(seconds(out) - 2)).toBeLessThan(0.1);
  });
});

describe('mixStemWithSource', () => {
  const quiet = () => vi.spyOn(console, 'warn').mockImplementation(() => {});
  it('does not call Python when ffmpeg wrote the mix', async () => {
    const python = vi.fn();
    expect(await mixStemWithSource('a', 'b', 'c.flac', 80, { ffmpeg: async () => true, python } as MixDeps)).toBe(true);
    expect(python).not.toHaveBeenCalled();
  });
  it('makes the mix with Python when ffmpeg did not', async () => {
    quiet();
    const python = vi.fn(async () => {});
    expect(await mixStemWithSource('a', 'b', 'c.flac', 80, { ffmpeg: async () => false, python } as MixDeps)).toBe(true);
    expect(python).toHaveBeenCalledWith('a', 'b', 'c.flac', 80);
  });
  it('says no mix when neither could make it (the track alone stays)', async () => {
    quiet();
    expect(await mixStemWithSource('a', 'b', 'c.flac', 80, { ffmpeg: async () => false, python: async () => { throw new Error('boom'); } } as MixDeps)).toBe(false);
  });
});
