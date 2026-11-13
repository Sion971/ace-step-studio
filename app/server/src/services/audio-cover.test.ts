// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { coverKeyFor, embeddedCoverArgs, extractEmbeddedCover } from './audio-cover.js';

let hasFfmpeg = false;
try { execSync('ffmpeg -version', { stdio: 'ignore' }); hasFfmpeg = true; } catch { /* none here */ }

describe('embedded cover of an imported audio', () => {
  it('keeps attached pictures only, never a frame of a real video', () => {
    const a = embeddedCoverArgs('in.mp3', 'out.jpg');
    expect(a.join(' ')).toContain('-map 0:v -map -0:V -frames:v 1');
  });

  it('puts the cover next to the audio', () => {
    expect(coverKeyFor('reference-tracks/u1/1731500000000.mp3')).toBe('reference-tracks/u1/1731500000000.cover.jpg');
    expect(coverKeyFor('reference-tracks/u1/1731500000000.mp3', '.png')).toBe('reference-tracks/u1/1731500000000.cover.png');
  });

  it.skipIf(!hasFfmpeg)('takes the picture out of an MP3, and finds none in an MP3 without one', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cover-test-'));
    try {
      const q = (p: string) => `"${path.join(dir, p)}"`;
      execSync(`ffmpeg -hide_banner -loglevel error -f lavfi -i color=c=orange:s=600x600 -frames:v 1 -y ${q('art.png')}`);
      execSync(`ffmpeg -hide_banner -loglevel error -f lavfi -i "sine=f=440:d=2" -c:a libmp3lame -y ${q('plain.mp3')}`);
      execSync(`ffmpeg -hide_banner -loglevel error -i ${q('plain.mp3')} -i ${q('art.png')} -map 0:a -map 1:v -c:a copy -c:v png -disposition:v attached_pic -id3v2_version 3 -y ${q('tagged.mp3')}`);
      const cover = await extractEmbeddedCover(readFileSync(path.join(dir, 'tagged.mp3')), '.mp3');
      expect(cover).not.toBeNull();
      expect(cover!.subarray(0, 2).toString('hex')).toBe('ffd8'); // a JPEG
      expect(await extractEmbeddedCover(readFileSync(path.join(dir, 'plain.mp3')), '.mp3')).toBeNull();
      // A real video (an imported MP4 clip) gives no cover.
      execSync(`ffmpeg -hide_banner -loglevel error -f lavfi -i color=c=blue:s=320x240:d=1 -f lavfi -i "sine=d=1" -shortest -c:v libx264 -c:a aac -y ${q('clip.mp4')}`);
      expect(await extractEmbeddedCover(readFileSync(path.join(dir, 'clip.mp4')), '.mp4')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
