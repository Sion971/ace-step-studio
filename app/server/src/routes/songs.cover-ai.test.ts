// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { Server } from 'http';

vi.mock('../db/pool.js', () => ({ pool: { query: vi.fn() } }));
vi.mock('../middleware/auth.js', () => ({
  authMiddleware: (req: any, _res: any, next: any) => { req.user = { id: 'u1', username: 'tester' }; next(); },
  optionalAuthMiddleware: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../services/storage/factory.js', () => ({ getStorageProvider: vi.fn() }));
vi.mock('../services/ai-cover.js', () => {
  class AiCoverError extends Error {
    constructor(public code: string, message: string) { super(message); }
  }
  return { AiCoverError, aiCover: { status: vi.fn(), generate: vi.fn() } };
});

import { aiCover, AiCoverError } from '../services/ai-cover.js';
import songsRouter from './songs.js';

describe('local AI cover routes', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/songs', songsRouter);
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${(server.address() as any).port}/api/songs`;
  });
  afterAll(() => { server.close(); });
  beforeEach(() => { vi.mocked(aiCover.status).mockReset(); vi.mocked(aiCover.generate).mockReset(); });

  const post = (body: unknown) => fetch(`${base}/generate-cover`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('reports whether the local model can be used', async () => {
    vi.mocked(aiCover.status).mockReturnValue({ available: false, reason: 'cpu-mode' });
    const res = await fetch(`${base}/cover-ai-status`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: false, reason: 'cpu-mode' });
  });

  it('returns the generated image with its seed, without saving anything', async () => {
    vi.mocked(aiCover.generate).mockResolvedValue({ buffer: Buffer.from('JPEGBYTES'), mimeType: 'image/jpeg' });
    const res = await post({ prompt: 'a calm sea at dusk', seed: 42 });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('x-cover-seed')).toBe('42');
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('JPEGBYTES');
    expect(aiCover.generate).toHaveBeenCalledWith({ prompt: 'a calm sea at dusk', seed: 42 });
  });

  it('draws a seed when none is given', async () => {
    vi.mocked(aiCover.generate).mockResolvedValue({ buffer: Buffer.from('x'), mimeType: 'image/jpeg' });
    const res = await post({ prompt: 'anything' });
    expect(Number(res.headers.get('x-cover-seed'))).toBeGreaterThanOrEqual(0);
  });

  it('refuses an empty prompt', async () => {
    const res = await post({ prompt: '   ' });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('EMPTY_PROMPT');
    expect(aiCover.generate).not.toHaveBeenCalled();
  });

  it('answers 503 AI_UNAVAILABLE when the machine cannot make AI covers', async () => {
    vi.mocked(aiCover.generate).mockRejectedValue(new (AiCoverError as any)('cpu-mode', 'cpu-mode'));
    const res = await post({ prompt: 'x' });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'AI_UNAVAILABLE', reason: 'cpu-mode' });
  });

  it('answers 502 AI_FAILED when one generation fails', async () => {
    vi.mocked(aiCover.generate).mockRejectedValue(new (AiCoverError as any)('failed', 'the model returned a black image'));
    const res = await post({ prompt: 'x' });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: 'AI_FAILED' });
  });
});
