// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const predict = vi.fn();
const hasUnfinishedGeneration = vi.fn(() => false);
vi.mock('../services/gradio-client.js', () => ({ getGradioClient: async () => ({ predict }) }));
vi.mock('../services/acestep.js', () => ({ prepareAudioFile: async () => ({ path: '/tmp/a.mp3' }), hasUnfinishedGeneration: () => hasUnfinishedGeneration() }));
vi.mock('../middleware/auth.js', () => ({ authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next() }));

const { default: router } = await import('./audio-analysis.js');

describe('POST /api/audio-analysis', () => {
  let server: Server;
  let url: string;
  beforeEach(async () => {
    predict.mockReset();
    hasUnfinishedGeneration.mockReturnValue(false);
    const app = express();
    app.use(express.json());
    app.use('/api/audio-analysis', router);
    await new Promise<void>((resolve) => (server = app.listen(0, '127.0.0.1', () => resolve())));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/audio-analysis`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
  });
  const post = (body: unknown) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('returns what the engine understood', async () => {
    predict.mockResolvedValueOnce({ data: ['c', 'ok', 'pop', 'la', 100, 60, 'C major', 'en', '4', true] });
    const r = await post({ audioUrl: '/audio/a.mp3' });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { analysis: { bpm: number } }).analysis.bpm).toBe(100);
  });
  it('asks for the audio', async () => {
    expect((await post({})).status).toBe(400);
  });
  it('refuses while a generation runs (same card)', async () => {
    hasUnfinishedGeneration.mockReturnValue(true);
    expect((await post({ audioUrl: '/a.mp3' })).status).toBe(409);
    expect(predict).not.toHaveBeenCalled();
  });
  it('reports an engine failure and frees the slot', async () => {
    predict.mockRejectedValueOnce(new Error('boom'));
    expect((await post({ audioUrl: '/a.mp3' })).status).toBe(500);
    predict.mockResolvedValueOnce({ data: ['c', 's', 'x', '', null, null, '', '', '', false] });
    expect((await post({ audioUrl: '/a.mp3' })).status).toBe(200);
  });
});
