// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// Same replacements as generate-models.test.ts: what is under test is only what /limits answers.
vi.mock('../db/pool.js', () => ({ pool: {} }));
vi.mock('../db/sqlite.js', () => ({ generateUUID: () => 'id' }));
vi.mock('../config/index.js', () => ({ config: { acestep: { apiUrl: 'http://127.0.0.1:9' }, storage: {} } }));
vi.mock('../middleware/auth.js', () => ({ authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock('../services/gradio-client.js', () => ({ getGradioClient: vi.fn() }));
vi.mock('../services/acestep.js', () => ({
  generateMusicViaAPI: vi.fn(), getJobStatus: vi.fn(), getAudioStream: vi.fn(), discoverEndpoints: vi.fn(), checkSpaceHealth: vi.fn(), cleanupJob: vi.fn(),
  cancelJob: vi.fn(), cancelAllJobs: vi.fn(), getJobRawResponse: vi.fn(), downloadAudioToBuffer: vi.fn(), resolvePythonPath: vi.fn(() => 'python'),
}));
vi.mock('../services/storage/factory.js', () => ({ getStorageProvider: vi.fn() }));
vi.mock('../services/id3-tagger.js', () => ({ tagMp3Buffer: vi.fn(), fetchCoverImage: vi.fn(), updateMp3Cover: vi.fn() }));
vi.mock('../services/cover-jobs.js', () => ({ startCoverGen: vi.fn(), consumeCoverState: vi.fn(), getCoverState: vi.fn() }));

let limits: { withLm: number; withoutLm: number } | null = null;
vi.mock('../services/pipeline-manager.js', () => ({
  pipelineManager: { getLimits: () => limits, onRestart: () => {}, pauseHealthCheck: () => {}, resumeHealthCheck: () => {} },
}));

const { default: router } = await import('./generate.js');

describe('GET /api/generate/limits', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    const app = express();
    app.use('/api/generate', router);
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/generate`;
  });
  afterAll(() => { server.close(); });

  it('answers 503 until the engine has reported its limits', async () => {
    limits = null;
    expect((await fetch(`${base}/limits`)).status).toBe(503);
  });

  it("relays the engine's own limits", async () => {
    limits = { withLm: 480, withoutLm: 600 };
    const res = await fetch(`${base}/limits`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ max_duration_with_lm: 480, max_duration_without_lm: 600 });
  });
});
