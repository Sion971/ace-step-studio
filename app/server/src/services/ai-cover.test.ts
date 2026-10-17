// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { AiCoverEngine, AiCoverError } from './ai-cover.js';

/** A stand-in for cover_worker.py: same line protocol, behaviour chosen by the first word of the prompt. */
const FAKE_WORKER = `
const rl = require('readline').createInterface({ input: process.stdin });
let loaded = false;
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
rl.on('line', (line) => {
  const req = JSON.parse(line);
  if (req.prompt.startsWith('nocuda')) { send({ id: req.id, ok: false, error: 'no CUDA GPU available for local covers' }); return; }
  if (!loaded) { send({ event: 'loading' }); loaded = true; send({ event: 'ready' }); }
  if (req.prompt.startsWith('black')) { send({ id: req.id, ok: false, error: 'the model returned a black image' }); return; }
  if (req.prompt.startsWith('die')) process.exit(3);
  send({ id: req.id, ok: true, mime: 'image/jpeg', data: Buffer.from('JPEG:' + req.prompt + ':' + req.seed + ':' + process.pid).toString('base64') });
});
`;

describe('AiCoverEngine', () => {
  let dir: string;
  let engine: AiCoverEngine;

  const make = (over: Partial<ConstructorParameters<typeof AiCoverEngine>[0]> = {}) => {
    dir = mkdtempSync(path.join(tmpdir(), 'aicover-'));
    const script = path.join(dir, 'worker.cjs');
    writeFileSync(script, FAKE_WORKER);
    engine = new AiCoverEngine({
      command: () => ({ command: process.execPath, args: [script] }),
      isCpuMode: () => false,
      idleMs: 60_000,
      ...over,
    });
    return engine;
  };

  afterEach(() => {
    engine?.shutdown();
    if (dir) rmSync(dir, { recursive: true, force: true });
    delete process.env.COVER_AI;
  });

  it('generates an image and keeps one worker for the following requests', async () => {
    make();
    const a = await engine.generate({ prompt: 'one', seed: 7 });
    const b = await engine.generate({ prompt: 'two', seed: 8 });
    expect(a.mimeType).toBe('image/jpeg');
    const [textA, textB] = [a.buffer.toString(), b.buffer.toString()];
    expect(textA).toMatch(/^JPEG:one:7:\d+$/);
    expect(textB).toMatch(/^JPEG:two:8:\d+$/);
    expect(textA.split(':')[3]).toBe(textB.split(':')[3]);
  });

  it('serves concurrent requests one after the other', async () => {
    make();
    const results = await Promise.all([1, 2, 3].map((n) => engine.generate({ prompt: `p${n}`, seed: n })));
    expect(results.map((r) => r.buffer.toString().split(':')[1])).toEqual(['p1', 'p2', 'p3']);
  });

  it('is unavailable in processor mode, without starting anything', async () => {
    make({ isCpuMode: () => true });
    expect(engine.status()).toEqual({ available: false, reason: 'cpu-mode' });
    await expect(engine.generate({ prompt: 'x', seed: 1 })).rejects.toMatchObject({ code: 'cpu-mode' });
  });

  it('can be switched off with COVER_AI=off', () => {
    make();
    process.env.COVER_AI = 'off';
    expect(engine.status()).toEqual({ available: false, reason: 'disabled' });
  });

  it('is unavailable when the worker cannot be found', () => {
    make({ command: () => null });
    expect(engine.status().available).toBe(false);
    expect(engine.status().reason).toBe('unavailable');
  });

  it('remembers a start failure instead of retrying on every song', async () => {
    make();
    await expect(engine.generate({ prompt: 'nocuda', seed: 1 })).rejects.toBeInstanceOf(AiCoverError);
    const st = engine.status();
    expect(st.available).toBe(false);
    expect(st.detail).toContain('no CUDA');
    await expect(engine.generate({ prompt: 'again', seed: 2 })).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('retries after the waiting time', async () => {
    make({ retryAfterMs: 1 });
    await expect(engine.generate({ prompt: 'nocuda', seed: 1 })).rejects.toBeInstanceOf(AiCoverError);
    await new Promise((r) => setTimeout(r, 10));
    const r = await engine.generate({ prompt: 'fine', seed: 3 });
    expect(r.buffer.toString()).toContain('JPEG:fine');
  });

  it('does not remember a single bad image once the model is loaded', async () => {
    make();
    await engine.generate({ prompt: 'warm', seed: 1 });
    await expect(engine.generate({ prompt: 'black', seed: 2 })).rejects.toMatchObject({ code: 'failed' });
    expect(engine.status().available).toBe(true);
    const r = await engine.generate({ prompt: 'ok', seed: 3 });
    expect(r.buffer.toString()).toContain('JPEG:ok');
  });

  it('reports a worker that dies and starts a new one for the next request', async () => {
    make();
    await engine.generate({ prompt: 'warm', seed: 1 });
    await expect(engine.generate({ prompt: 'die', seed: 2 })).rejects.toMatchObject({ code: 'failed' });
    const r = await engine.generate({ prompt: 'back', seed: 3 });
    expect(r.buffer.toString()).toContain('JPEG:back');
  });
});
