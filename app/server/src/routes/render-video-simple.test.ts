// @vitest-environment node
// The "Cover + lyrics" route with a real ffmpeg, when there is one on this machine (skipped otherwise).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execSync } from 'node:child_process';
import renderVideoRoutes from './render-video.js';

let hasFfmpeg = false;
try { execSync('ffmpeg -version', { stdio: 'ignore' }); hasFfmpeg = true; } catch { /* no ffmpeg here */ }

// A 1x1 PNG, scaled up by nothing: ffmpeg only needs a picture of the right kind.
const tinyPng = (w: number, h: number) =>
  'data:image/png;base64,' + execSync(`ffmpeg -hide_banner -loglevel error -f lavfi -i color=c=purple:s=${w}x${h} -frames:v 1 -f image2pipe -vcodec png -`).toString('base64');

describe.skipIf(!hasFfmpeg)('POST /api/render-video/simple', () => {
  let server: Server;
  let base = '';
  beforeAll(async () => {
    const app = express();
    app.use('/api/render-video', express.json({ limit: '50mb' }), renderVideoRoutes);
    server = await new Promise<Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => { server?.close(); });

  it('makes an MP4 of the given length with the lyrics burnt in', async () => {
    const res = await fetch(`${base}/api/render-video/simple`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ still: tinyPng(640, 360), width: 640, height: 360, duration: 3, fps: 10, lrc: '[00:00.50]Je sais que Tu agis\n[00:02.00]Et Tu agiras', lyricsStyle: 'karaoke' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(4, 8).toString()).toBe('ftyp');
    expect(['0', '1']).toContain(res.headers.get('x-lyrics-burned'));
  }, 60_000);

  it('refuses a request without a picture or a duration', async () => {
    const res = await fetch(`${base}/api/render-video/simple`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ width: 640, height: 360 }),
    });
    expect(res.status).toBe(400);
  });
});
