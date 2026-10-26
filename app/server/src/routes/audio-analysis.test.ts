// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const predict = vi.fn();
const hasUnfinishedGeneration = vi.fn(() => false);
vi.mock('../services/gradio-client.js', () => ({ getGradioClient: async () => ({ predict }) }));
const transcribe = vi.fn(async () => null as { text: string; language: string } | null);
vi.mock('../services/whisper.js', () => ({ transcribeWithWhisperDetailed: (...a: unknown[]) => (transcribe as any)(...a) }));
vi.mock('fs', async (orig) => ({ ...(await orig() as object), promises: { ...((await orig() as any).promises), readFile: async () => Buffer.from('x') } }));
vi.mock('../services/acestep.js', () => ({ resolveAudioPath: (u: string) => u, prepareAudioFile: async () => ({ path: '/tmp/a.mp3' }), hasUnfinishedGeneration: () => hasUnfinishedGeneration() }));
const findTrackIdByUrl = vi.fn(async () => null as string | null);
const saveTrackAnalysis = vi.fn(async () => undefined);
vi.mock('../services/track-analysis.js', () => ({ findTrackIdByUrl: (...a: unknown[]) => (findTrackIdByUrl as any)(...a), saveTrackAnalysis: (...a: unknown[]) => (saveTrackAnalysis as any)(...a) }));
vi.mock('../middleware/auth.js', () => ({ authMiddleware: (req: { user?: unknown }, _res: unknown, next: () => void) => { req.user = { id: 'u1' }; next(); } }));

const { default: router } = await import('./audio-analysis.js');

describe('POST /api/audio-analysis', () => {
  let server: Server;
  let url: string;
  beforeEach(async () => {
    predict.mockReset();
    findTrackIdByUrl.mockReset().mockResolvedValue(null);
    saveTrackAnalysis.mockReset();
    transcribe.mockReset().mockResolvedValue(null);
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
  it('keeps the analysis with the imported audio it belongs to', async () => {
    findTrackIdByUrl.mockResolvedValue('t1');
    predict.mockResolvedValueOnce({ data: ['c', 'ok', 'pop', 'la', 100, 60, 'C major', 'en', '4', true] });
    const body = (await (await post({ audioUrl: '/audio/a.mp3' })).json()) as { saved: boolean };
    expect(body.saved).toBe(true);
    expect(findTrackIdByUrl).toHaveBeenCalledWith('u1', '/audio/a.mp3');
    expect(saveTrackAnalysis).toHaveBeenCalledWith('t1', expect.objectContaining({ bpm: 100 }));
  });
  it('still answers when saving fails, and saves nothing for a song that is not an import', async () => {
    findTrackIdByUrl.mockRejectedValueOnce(new Error('db'));
    predict.mockResolvedValue({ data: ['c', 'ok', 'pop', 'la', 100, 60, 'C major', 'en', '4', true] });
    expect(((await (await post({ audioUrl: '/a.mp3' })).json()) as { saved: boolean }).saved).toBe(false);
    expect(((await (await post({ audioUrl: '/b.mp3' })).json()) as { saved: boolean }).saved).toBe(false);
    expect(saveTrackAnalysis).not.toHaveBeenCalled();
  });
  it('puts Whisper\'s lyrics in place of the model\'s when it is installed', async () => {
    transcribe.mockResolvedValue({ text: 'Dieu est Esprit', language: 'fr' });
    predict.mockResolvedValueOnce({ data: ['c', 'ok', 'pop', 'invented english', 100, 60, 'C major', 'en', '4', true] });
    const body = (await (await post({ audioUrl: '/audio/a.mp3' })).json()) as { analysis: { lyrics: string; language: string; lyricsSource: string } };
    expect(body.analysis).toMatchObject({ lyrics: 'Dieu est Esprit', language: 'fr', lyricsSource: 'whisper' });
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
