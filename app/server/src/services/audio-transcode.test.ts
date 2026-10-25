// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { parseExportFormat, transcodeAudio } from './audio-transcode.js';

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
