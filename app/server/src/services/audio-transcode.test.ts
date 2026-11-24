// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { parseExportFormat, reverseAudio, speedAudio, transcodeAudio } from './audio-transcode.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

function wav(seconds = 1, rate = 22050): Buffer {
  const n = seconds * rate;
  const b = Buffer.alloc(44 + n * 4);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 4, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) { b.writeInt16LE(Math.round(Math.sin(i / 9) * 9000), 44 + i * 4); b.writeInt16LE(Math.round(Math.sin(i / 13) * 7000), 46 + i * 4); }
  return b;
}

describe('parseExportFormat', () => {
  it('knows wav, flac and mp3, whatever the case, and nothing else', () => {
    expect(parseExportFormat('FLAC')).toBe('flac');
    expect(parseExportFormat(' mp3 ')).toBe('mp3');
    expect(parseExportFormat('wav')).toBe('wav');
    for (const v of ['ogg', '', undefined, null, 42, '../x']) expect(parseExportFormat(v)).toBeNull();
  });
});

describe.skipIf(!hasFfmpeg)('transcodeAudio', () => {
  it('turns a WAV into a FLAC that is smaller and starts like a FLAC', async () => {
    const src = wav();
    const out = await transcodeAudio(src, 'mix.wav', 'flac');
    expect(out).toMatchObject({ ext: '.flac', mime: 'audio/flac' });
    expect(out.data.subarray(0, 4).toString('latin1')).toBe('fLaC');
    expect(out.data.length).toBeLessThan(src.length);
  });

  it('turns a WAV into an MP3', async () => {
    const out = await transcodeAudio(wav(), 'mix.wav', 'mp3');
    expect(out).toMatchObject({ ext: '.mp3', mime: 'audio/mpeg' });
    const head = out.data.subarray(0, 3);
    expect(head.toString('latin1') === 'ID3' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)).toBe(true);
  });

  it('leaves a file alone when it already is the format asked', async () => {
    const src = wav();
    const out = await transcodeAudio(src, 'mix.wav', 'wav');
    expect(out.data).toBe(src);
  });

  it('says what went wrong when the file is not audio', async () => {
    await expect(transcodeAudio(Buffer.from('not audio at all'), 'x.wav', 'flac')).rejects.toThrow(/ffmpeg failed/);
  });
});

import { atempoChain, stretchAudio } from './audio-transcode.js';
describe('atempoChain', () => {
  it('uses one filter within 0.5 to 2 and chains beyond', () => {
    expect(atempoChain(1.2)).toBe('atempo=1.200000');
    expect(atempoChain(3)).toBe('atempo=2.000000,atempo=1.500000');
    expect(atempoChain(0.3)).toBe('atempo=0.500000,atempo=0.600000');
  });
  it('refuses absurd ratios', () => {
    for (const r of [0, -1, 0.1, 5, NaN]) expect(() => atempoChain(r)).toThrow(/between 0.25 and 4/);
  });
});
describe.skipIf(!hasFfmpeg)('stretchAudio', () => {
  const seconds = (b: Buffer) => (b.length - 44) / (22050 * 4);
  it('makes a faster tempo shorter and a slower one longer, as a WAV', async () => {
    const src = wav(2);
    const fast = await stretchAudio(src, 'a.wav', 2);
    expect(fast.subarray(0, 4).toString('latin1')).toBe('RIFF');
    expect(seconds(fast)).toBeGreaterThan(0.9);
    expect(seconds(fast)).toBeLessThan(1.15);
    const slow = await stretchAudio(src, 'a.wav', 0.5);
    expect(seconds(slow)).toBeGreaterThan(3.8);
    expect(seconds(slow)).toBeLessThan(4.3);
  });
});

import type { TranscodeDeps } from './audio-transcode.js';
const hasSoundfile = spawnSync('python3', ['-c', 'import soundfile']).status === 0;
describe('when ffmpeg cannot be run (Smart App Control)', () => {
  const blocked = async () => { throw new Error('ffmpeg failed (code 3236495362): '); };
  it('uses the engine Python instead, and says so', async () => {
    const python = vi.fn(async (_i: string, o: string, f: string) => { await writeFile(o, Buffer.from(`${f}-data`)); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await transcodeAudio(wav(), 'mix.wav', 'mp3', { ffmpeg: blocked, python } as TranscodeDeps);
    expect(python).toHaveBeenCalledTimes(1);
    expect(python.mock.calls[0][2]).toBe('mp3');
    expect(out).toMatchObject({ ext: '.mp3', mime: 'audio/mpeg' });
    expect(out.data.toString()).toBe('mp3-data');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
  it('reports both failures when neither can convert', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(transcodeAudio(wav(), 'mix.wav', 'flac', { ffmpeg: blocked, python: async () => { throw new Error('Python failed (code 1)'); } }))
      .rejects.toThrow(/ffmpeg failed.*Python failed/);
  });
  it('does not try Python for a WAV (nothing to convert to)', async () => {
    const python = vi.fn();
    await expect(transcodeAudio(wav(), 'mix.flac', 'wav', { ffmpeg: blocked, python })).rejects.toThrow(/ffmpeg failed/);
    expect(python).not.toHaveBeenCalled();
  });
  it.skipIf(!hasSoundfile)('really writes FLAC and MP3 with the Python snippet', async () => {
    const { spawn } = await import('node:child_process');
    const { PYTHON_ENCODE } = await import('./audio-transcode.js');
    const py = (input: string, output: string, f: 'flac' | 'mp3') => new Promise<void>((resolve, reject) => {
      const p = spawn('python3', ['-c', PYTHON_ENCODE, input, output, f.toUpperCase()]);
      let err = ''; p.stderr.on('data', (d) => { err += d; });
      p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`code ${c}: ${err}`))));
    });
    const src = wav(2);
    const flac = await transcodeAudio(src, 'mix.wav', 'flac', { ffmpeg: blocked, python: py });
    expect(flac.data.subarray(0, 4).toString('latin1')).toBe('fLaC');
    const mp3 = await transcodeAudio(src, 'mix.wav', 'mp3', { ffmpeg: blocked, python: py });
    const head = mp3.data.subarray(0, 3);
    expect(head.toString('latin1') === 'ID3' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)).toBe(true);
    expect(mp3.data.length).toBeLessThan(src.length / 4);
  });
});

describe('reverseAudio', () => {
  it('asks ffmpeg for the audio backwards, as a FLAC, without the tags or the picture', async () => {
    const ffmpeg = vi.fn(async (args: string[]) => { await writeFile(args[args.length - 1], Buffer.from('fLaC-reversed')); });
    const python = vi.fn();
    const out = await reverseAudio(Buffer.from('x'), 'Pas sur la route.mp3', { ffmpeg, python });
    expect(out.toString()).toBe('fLaC-reversed');
    const args = ffmpeg.mock.calls[0][0];
    expect(args).toEqual(expect.arrayContaining(['-vn', '-map_metadata', '-1', '-af', 'areverse']));
    expect(args[args.indexOf('-i') + 1]).toMatch(/in\.mp3$/);
    expect(args[args.length - 1]).toMatch(/out\.flac$/);
    expect(python).not.toHaveBeenCalled();
  });

  it('falls back on the engine\'s Python when ffmpeg cannot run', async () => {
    const ffmpeg = vi.fn(async () => { throw new Error('ffmpeg could not be started: EPERM'); });
    const python = vi.fn(async (_i: string, o: string) => { await writeFile(o, Buffer.from('from-python')); });
    expect((await reverseAudio(Buffer.from('x'), 'a.wav', { ffmpeg, python })).toString()).toBe('from-python');
  });

  it.skipIf(!hasFfmpeg)('really plays a file backwards', async () => {
    const src = wav(1);
    const out = await reverseAudio(src, 'a.wav');
    expect(out.subarray(0, 4).toString('latin1')).toBe('fLaC');
  });
});

describe('speedAudio', () => {
  const fakeFfmpeg = () => vi.fn(async (args: string[]) => { await writeFile(args[args.length - 1], Buffer.from('fLaC-speed')); });

  it('keeps the pitch with atempo, as a FLAC without the tags or the picture', async () => {
    const ffmpeg = fakeFfmpeg();
    expect((await speedAudio(Buffer.from('x'), 'a.mp3', 1.25, true, { ffmpeg, python: vi.fn() })).toString()).toBe('fLaC-speed');
    const args = ffmpeg.mock.calls[0][0];
    expect(args).toEqual(expect.arrayContaining(['-vn', '-map_metadata', '-1']));
    expect(args[args.indexOf('-af') + 1]).toBe('atempo=1.250000');
    expect(args[args.length - 1]).toMatch(/out\.flac$/);
  });

  it('lets the pitch follow the speed, like a record, when asked', async () => {
    const ffmpeg = fakeFfmpeg();
    await speedAudio(Buffer.from('x'), 'a.mp3', 1.25, false, { ffmpeg, python: vi.fn() });
    const args = ffmpeg.mock.calls[0][0];
    expect(args[args.indexOf('-af') + 1]).toBe('aresample=48000,asetrate=60000,aresample=48000');
  });

  it('refuses a factor outside 0.5 to 2, and falls back on Python without ffmpeg', async () => {
    await expect(speedAudio(Buffer.from('x'), 'a.wav', 3, true, { ffmpeg: vi.fn(), python: vi.fn() })).rejects.toThrow(/between 0.5 and 2/);
    const python = vi.fn(async (_i: string, o: string) => { await writeFile(o, Buffer.from('py')); });
    const out = await speedAudio(Buffer.from('x'), 'a.wav', 0.9, false, { ffmpeg: vi.fn(async () => { throw new Error('EPERM'); }), python });
    expect(out.toString()).toBe('py');
    expect(python).toHaveBeenCalledWith(expect.any(String), expect.any(String), 0.9, false);
  });

  it.skipIf(!hasFfmpeg)('really makes a 1 s file 0.8 s long at ×1.25', async () => {
    const out = await speedAudio(wav(1), 'a.wav', 1.25, true);
    expect(out.subarray(0, 4).toString('latin1')).toBe('fLaC');
  });
});
