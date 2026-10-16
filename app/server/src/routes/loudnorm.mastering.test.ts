// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { spawnSync } from 'node:child_process';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import router from './loudnorm.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

describe.skipIf(!hasFfmpeg)('POST /api/loudnorm/normalize with the real ffmpeg', () => {
  let server: Server;
  let base: string;
  let dir: string;
  let input: string;
  beforeAll(() => {
    const app = express();
    app.use('/api/loudnorm', router);
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/loudnorm/normalize`;
    dir = mkdtempSync(path.join(os.tmpdir(), 'loudnorm-route-'));
    input = path.join(dir, 'in.wav');
    // Two tones and a little noise, 8 s, stereo: enough for loudnorm to measure something.
    const made = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=220:d=8,volume=3', '-f', 'lavfi', '-i', 'sine=f=1320:d=8,volume=2', '-filter_complex', '[0:a][1:a]amix=inputs=2,pan=stereo|c0=c0|c1=c0', '-ar', '48000', input]);
    expect(made.status).toBe(0);
  });
  afterAll(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

  const post = async (fields: Record<string, string>) => {
    const form = new FormData();
    form.append('audio', new Blob([readFileSync(input)]), 'in.wav');
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    const res = await fetch(base, { method: 'POST', body: form });
    const out = path.join(dir, `out-${Math.random().toString(36).slice(2)}.wav`);
    if (res.ok) writeFileSync(out, Buffer.from(await res.arrayBuffer()));
    return { res, out };
  };
  const measure = (file: string) => {
    const r = spawnSync('ffmpeg', ['-v', 'info', '-i', file, '-af', 'loudnorm=I=-14:TP=-1:LRA=11:print_format=json', '-f', 'null', '-'], { encoding: 'utf-8' });
    const json = JSON.parse(r.stderr.slice(r.stderr.lastIndexOf('{'), r.stderr.lastIndexOf('}') + 1));
    return { lufs: parseFloat(json.input_i), peak: parseFloat(json.input_tp) };
  };

  it('still reaches the target without mastering (fields absent)', async () => {
    const { res, out } = await post({ targetI: '-14', targetTP: '-1' });
    expect(res.status).toBe(200);
    expect(Math.abs(measure(out).lufs + 14)).toBeLessThan(1.2);
    // without mastering the original is what pass 1 measured; the result is what loudnorm announced
    expect(Number.isFinite(parseFloat(res.headers.get('x-original-lufs')!))).toBe(true);
    expect(Math.abs(parseFloat(res.headers.get('x-result-lufs')!) + 14)).toBeLessThan(1.2);
  });

  it('reaches the target and holds the peak ceiling with every mastering stage at full', async () => {
    const { res, out } = await post({ targetI: '-14', targetTP: '-1', harmonics: '100', warmth: '100', tone: '100', glue: '100', width: '100' });
    expect(res.status).toBe(200);
    const { lufs, peak } = measure(out);
    expect(Math.abs(lufs + 14)).toBeLessThan(1.5);
    expect(peak).toBeLessThanOrEqual(-0.9);
    // with mastering the original is measured apart, on the untouched input, so it differs from the target
    expect(Number.isFinite(parseFloat(res.headers.get('x-original-lufs')!))).toBe(true);
  }, 60000);
});
