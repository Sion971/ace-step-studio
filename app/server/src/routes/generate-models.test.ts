// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// routes/generate.ts is large and reaches for the database, the storage and the engine as soon as it is imported. They are replaced: what is under test is the
// list of models that GET /api/generate/models builds from the table and from the disk.
vi.mock('../db/pool.js', () => ({ pool: {} }));
vi.mock('../db/sqlite.js', () => ({ generateUUID: () => 'id' }));
vi.mock('../config/index.js', () => ({ config: { acestep: { apiUrl: 'http://127.0.0.1:9' }, storage: {}, pollinations: {} } }));
vi.mock('../middleware/auth.js', () => ({ authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock('../services/gradio-client.js', () => ({ getGradioClient: vi.fn() }));
vi.mock('../services/acestep.js', () => ({
  generateMusicViaAPI: vi.fn(), getJobStatus: vi.fn(), getAudioStream: vi.fn(), discoverEndpoints: vi.fn(), checkSpaceHealth: vi.fn(), cleanupJob: vi.fn(),
  cancelJob: vi.fn(), cancelAllJobs: vi.fn(), getJobRawResponse: vi.fn(), downloadAudioToBuffer: vi.fn(), resolvePythonPath: vi.fn(() => 'python'),
}));
vi.mock('../services/storage/factory.js', () => ({ getStorageProvider: vi.fn() }));
vi.mock('../services/id3-tagger.js', () => ({ tagMp3Buffer: vi.fn(), fetchCoverImage: vi.fn(), updateMp3Cover: vi.fn() }));
vi.mock('../services/cover-jobs.js', () => ({ startCoverGen: vi.fn(), consumeCoverState: vi.fn(), getCoverState: vi.fn() }));

const { default: router } = await import('./generate.js');

interface Listed { name: string; is_active: boolean; is_preloaded: boolean; is_custom: boolean }

describe('GET /api/generate/models', () => {
  let server: Server;
  let base: string;
  let engineDir: string;
  const originalPath = process.env.ACESTEP_PATH;

  const install = (...folders: string[]) => {
    for (const folder of folders) {
      mkdirSync(path.join(engineDir, 'checkpoints', folder), { recursive: true });
      writeFileSync(path.join(engineDir, 'checkpoints', folder, 'model.safetensors'), 'x');
    }
  };
  const list = async () => ((await (await fetch(`${base}/models`)).json()) as { models: Listed[] }).models;
  const names = (models: Listed[]) => models.map((m) => m.name).sort();

  beforeAll(async () => {
    const app = express();
    app.use('/api/generate', router);
    await new Promise<void>((resolve) => (server = app.listen(0, '127.0.0.1', () => resolve())));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/generate`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
  });
  beforeEach(() => {
    engineDir = mkdtempSync(path.join(tmpdir(), 'studio-models-'));
    mkdirSync(path.join(engineDir, 'checkpoints'), { recursive: true });
    process.env.ACESTEP_PATH = engineDir;
  });
  afterEach(() => {
    rmSync(engineDir, { recursive: true, force: true });
    if (originalPath === undefined) delete process.env.ACESTEP_PATH; else process.env.ACESTEP_PATH = originalPath;
  });

  it('offers the three 2B models next to the XL ones (they used to be missing: the list was XL only)', async () => {
    expect(names(await list())).toEqual([
      'acestep-v15-base', 'acestep-v15-sft', 'acestep-v15-turbo',
      'acestep-v15-xl-merge-sft-turbo', 'acestep-v15-xl-sft', 'acestep-v15-xl-turbo', 'acestep-v15-xl-turbo-bf16',
    ]);
  });

  it('with nothing on the disk, none is downloaded and none is called custom: they are official models', async () => {
    for (const model of await list()) {
      expect(model.is_preloaded, model.name).toBe(false);
      expect(model.is_custom, model.name).toBe(false);
    }
  });

  it('a 2B on the disk is reported as downloaded, and listed once', async () => {
    install('acestep-v15-turbo');
    const models = await list();
    expect(models.filter((m) => m.name === 'acestep-v15-turbo')).toHaveLength(1);
    expect(models.find((m) => m.name === 'acestep-v15-turbo')).toMatchObject({ is_preloaded: true, is_custom: false });
    expect(models.find((m) => m.name === 'acestep-v15-base')!.is_preloaded).toBe(false);
  });

  it('downloaded models come first, before the ones to download', async () => {
    install('acestep-v15-turbo', 'acestep-v15-xl-turbo-bf16');
    const models = await list();
    expect(models.slice(0, 2).map((m) => m.name).sort()).toEqual(['acestep-v15-turbo', 'acestep-v15-xl-turbo-bf16']);
    expect(models.slice(2).every((m) => !m.is_preloaded)).toBe(true);
  });

  it('still finds what the user put on the disk, and calls it custom', async () => {
    install('my-finetune');
    const models = await list();
    expect(models.find((m) => m.name === 'my-finetune')).toMatchObject({ is_preloaded: true, is_custom: true });
    expect(models).toHaveLength(8);
  });

  it('does not take the language models, the VAE and the text encoder for DiT models', async () => {
    install('acestep-5Hz-lm-0.6B', 'vae', 'Qwen3-Embedding-0.6B');
    expect(names(await list())).toHaveLength(7);
  });
});

describe('GET /api/generate/download-model refuses what it does not know', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    const app = express();
    app.use('/api/generate', router);
    await new Promise<void>((resolve) => (server = app.listen(0, '127.0.0.1', () => resolve())));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/generate`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
  });

  it('no model, an unknown model, and a name that is a property of every object: 400, nothing is started', async () => {
    expect((await fetch(`${base}/download-model`)).status).toBe(400);
    for (const model of ['my-finetune', 'acestep-v15-nope', '../etc', 'constructor', '__proto__']) {
      const response = await fetch(`${base}/download-model?model=${encodeURIComponent(model)}`);
      expect(response.status, model).toBe(400);
      expect(((await response.json()) as { error: string }).error, model).toBe(`Unknown model: ${model}`);
    }
  });
});
