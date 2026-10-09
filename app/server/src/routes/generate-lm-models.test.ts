// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Same replacements as generate-models.test.ts, plus the download process: what is under test is the list of language models that /models builds from the disk, and what the
// download route does around a download that succeeds (it must not treat a language model like a DiT model).
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

const spawned: { args: string[] }[] = [];
vi.mock('child_process', () => {
  const spawn = vi.fn((_command: string, args: string[]) => {
    spawned.push({ args });
    const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    setTimeout(() => proc.emit('close', 0), 5); // a download that succeeds, and leaves nothing on the disk
    return proc;
  });
  return { spawn, execSync: vi.fn(() => ''), default: { spawn, execSync: vi.fn(() => '') } };
});

const { default: router } = await import('./generate.js');

interface ListedLm { name: string; is_preloaded: boolean }

describe('language models in /api/generate/models and /download-model', () => {
  let server: Server;
  let base: string;
  let engineDir: string;
  const originalPath = process.env.ACESTEP_PATH;
  const checkpoints = () => path.join(engineDir, 'checkpoints');

  const folder = (name: string, files: Record<string, string>) => {
    mkdirSync(path.join(checkpoints(), name), { recursive: true });
    for (const [file, content] of Object.entries(files)) writeFileSync(path.join(checkpoints(), name, file), content);
  };
  const lmList = async () => ((await (await fetch(`${base}/models`)).json()) as { lm_models: ListedLm[] }).lm_models;
  const download = async (model: string) => (await fetch(`${base}/download-model?model=${encodeURIComponent(model)}`)).text();

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
    spawned.length = 0;
    engineDir = mkdtempSync(path.join(tmpdir(), 'studio-lm-'));
    mkdirSync(checkpoints(), { recursive: true });
    process.env.ACESTEP_PATH = engineDir;
  });
  afterEach(() => {
    rmSync(engineDir, { recursive: true, force: true });
    if (originalPath === undefined) delete process.env.ACESTEP_PATH; else process.env.ACESTEP_PATH = originalPath;
  });

  it('lists the three language models of the selector, none on the disk when the disk is empty', async () => {
    expect(await lmList()).toEqual([
      { name: 'acestep-5Hz-lm-0.6B', is_preloaded: false },
      { name: 'acestep-5Hz-lm-1.7B', is_preloaded: false },
      { name: 'acestep-5Hz-lm-4B', is_preloaded: false },
    ]);
  });

  it('a model is on the disk when its folder has a config and weights (one file or several)', async () => {
    folder('acestep-5Hz-lm-0.6B', { 'config.json': '{}', 'model.safetensors': 'x' });
    folder('acestep-5Hz-lm-4B', { 'config.json': '{}', 'model-00001-of-00002.safetensors': 'x', 'model-00002-of-00002.safetensors': 'x' });
    const lm = await lmList();
    expect(lm.filter((m) => m.is_preloaded).map((m) => m.name)).toEqual(['acestep-5Hz-lm-0.6B', 'acestep-5Hz-lm-4B']);
  });

  it('a folder left half-downloaded is not on the disk: no config, or no weights', async () => {
    folder('acestep-5Hz-lm-1.7B', { 'model.safetensors': 'x' });
    folder('acestep-5Hz-lm-4B', { 'config.json': '{}' });
    expect((await lmList()).filter((m) => m.is_preloaded)).toEqual([]);
  });

  it('lists a language model the user put on the disk, once', async () => {
    folder('acestep-5Hz-lm-custom', { 'config.json': '{}', 'model.safetensors': 'x' });
    folder('acestep-5Hz-lm-0.6B', { 'config.json': '{}', 'model.safetensors': 'x' });
    const lm = await lmList();
    expect(lm.map((m) => m.name)).toEqual(['acestep-5Hz-lm-0.6B', 'acestep-5Hz-lm-1.7B', 'acestep-5Hz-lm-4B', 'acestep-5Hz-lm-custom']);
    expect(lm.find((m) => m.name === 'acestep-5Hz-lm-custom')!.is_preloaded).toBe(true);
  });

  it('downloads the 1.7B as a folder of the main repository, and says done', async () => {
    const text = await download('acestep-5Hz-lm-1.7B');
    expect(text).toContain('"status":"done"');
    expect(spawned[0].args).toEqual(expect.arrayContaining(['ACE-Step/Ace-Step1.5', '--include', 'acestep-5Hz-lm-1.7B/*', '--local-dir', checkpoints()]));
  });

  it('does not post-process a language model: no config borrowed from the XL SFT, nothing renamed', async () => {
    folder('acestep-v15-xl-sft', { 'config.json': '{"borrowed":true}', 'silence_latent.pt': 'x', 'configuration_acestep_v15.py': 'x' });
    folder('acestep-5Hz-lm-4B', { 'weights.safetensors': 'x' }); // as a download would leave it: weights, no config, a name that is not model.safetensors
    const text = await download('acestep-5Hz-lm-4B');
    expect(text).toContain('"status":"done"');
    expect(text).not.toContain('Copied');
    expect(text).not.toContain('Renamed');
    expect(existsSync(path.join(checkpoints(), 'acestep-5Hz-lm-4B', 'config.json'))).toBe(false);
    expect(existsSync(path.join(checkpoints(), 'acestep-5Hz-lm-4B', 'weights.safetensors'))).toBe(true);
  });

  it('still post-processes a DiT model, as before (the control of the test above)', async () => {
    folder('acestep-v15-xl-sft', { 'config.json': '{"borrowed":true}' });
    folder('acestep-v15-base', { 'weights.safetensors': 'x' });
    const text = await download('acestep-v15-base');
    expect(text).toContain('Renamed weights.safetensors');
    expect(text).toContain('Copied config.json from xl-sft');
  });

  it('still refuses a language model it does not know', async () => {
    const response = await fetch(`${base}/download-model?model=acestep-5Hz-lm-9B`);
    expect(response.status).toBe(400);
    expect(spawned).toHaveLength(0);
  });
});
