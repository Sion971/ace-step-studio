// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LoraHub } from '../services/lora-hub.js';
import { GOOD_ADAPTER_CONFIG, fakeWeights, startFakeHub, type FakeHub } from '../services/lora-hub.fake.js';
import { createLoraHubRouter } from './lora-hub-router.js';

const WEIGHTS = fakeWeights(30_000, 5);
const AUTH = { 'x-test-auth': 'ok' };

/** Stands in for authMiddleware: lets a request through only with the right header. */
const auth: RequestHandler = (req, res, next) => {
  if (req.headers['x-test-auth'] === 'ok') return next();
  res.status(401).json({ error: 'Unauthorized' });
};

describe('lora-hub router', () => {
  let fake: FakeHub;
  let loraDir: string;
  let server: Server;
  let base: string;

  async function serve(hub: Pick<LoraHub, 'inspect' | 'startInstall' | 'getJob'>) {
    const app = express();
    app.use(express.json());
    app.use('/api/lora-hub', createLoraHubRouter({ auth, hub: hub as LoraHub }));
    await new Promise<void>((resolve) => (server = app.listen(0, '127.0.0.1', () => resolve())));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/lora-hub`;
  }

  const call = async (method: string, route: string, body?: unknown, headers: Record<string, string> = AUTH) => {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  beforeEach(async () => {
    fake = await startFakeHub();
    loraDir = path.join(mkdtempSync(path.join(tmpdir(), 'lora-hub-router-')), 'lora_output');
    fake.repos.set('user/good', { files: { 'adapter_model.safetensors': WEIGHTS, 'adapter_config.json': GOOD_ADAPTER_CONFIG } });
    await serve(new LoraHub({ loraDir, endpoint: fake.endpoint, stallMs: 400 }));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
    await fake.close();
    rmSync(path.dirname(loraDir), { recursive: true, force: true });
  });

  it('asks for authentication on every route', async () => {
    expect((await call('POST', '/inspect', { source: 'user/good' }, {})).status).toBe(401);
    expect((await call('POST', '/install', { source: 'user/good' }, {})).status).toBe(401);
    expect((await call('GET', '/installs/abc', undefined, {})).status).toBe(401);
    expect((await call('POST', '/inspect', { source: 'user/good' }, { 'x-test-auth': 'wrong' })).status).toBe(401);
    expect(readdirSync(path.dirname(loraDir))).toEqual([]); // and nothing was installed or even created
  });

  it('inspects a repository', async () => {
    const { status, body } = await call('POST', '/inspect', { source: 'user/good' });
    expect(status).toBe(200);
    expect(body.card).toMatchObject({ repo: 'user/good', needsChoice: false, adapter: { rank: 64 } });
  });

  it('refuses a body that is not what it expects', async () => {
    for (const bad of [{}, { source: 42 }, { source: ['user/good'] }, { source: null }]) {
      const { status, body } = await call('POST', '/inspect', bad);
      expect(status, JSON.stringify(bad)).toBe(400);
      expect(body.code).toBe('invalid_source');
    }
    expect((await call('POST', '/install', { source: 'user/good', file: 7 })).status).toBe(400);
    expect((await call('POST', '/install', { source: 'user/good', name: { a: 1 } })).status).toBe(400);
    expect((await call('POST', '/inspect', { source: 'https://evil.example/user/good' })).status).toBe(400);
  });

  it('turns the service errors into the right statuses, with a code', async () => {
    expect(await call('POST', '/inspect', { source: 'user/missing' })).toMatchObject({ status: 404, body: { code: 'not_found' } });
    fake.repos.set('user/pickle', { files: { 'adapter_model.bin': WEIGHTS, 'adapter_config.json': GOOD_ADAPTER_CONFIG } });
    expect(await call('POST', '/inspect', { source: 'user/pickle' })).toMatchObject({ status: 422, body: { code: 'unsupported_format' } });
    fake.forceApiStatus = 429;
    expect(await call('POST', '/inspect', { source: 'user/good' })).toMatchObject({ status: 429, body: { code: 'rate_limited' } });
  });

  it('answers "choose a file" with the list to choose from', async () => {
    fake.repos.set('user/many', { files: { 'a.safetensors': WEIGHTS, 'b.safetensors': fakeWeights(9000, 3), 'adapter_config.json': GOOD_ADAPTER_CONFIG } });
    const { status, body } = await call('POST', '/install', { source: 'user/many' });
    expect(status).toBe(409);
    expect(body).toMatchObject({ code: 'choose_file', files: ['a.safetensors', 'b.safetensors'] });
    expect((await call('POST', '/install', { source: 'user/many', file: '../x.safetensors' })).body.code).toBe('unknown_file');
  });

  it('starts an install, answers at once, and lets the client poll it to the end', async () => {
    const started = await call('POST', '/install', { source: 'user/good', name: 'my-lora' });
    expect(started.status).toBe(202);
    expect(started.body.job).toMatchObject({ repo: 'user/good', name: 'my-lora' });
    expect(started.body.job.id).toMatch(/^[0-9a-f]+$/);

    let job = started.body.job;
    for (let i = 0; i < 300 && job.state !== 'done' && job.state !== 'failed'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      job = (await call('GET', `/installs/${started.body.job.id}`)).body.job;
    }
    expect(job).toMatchObject({ state: 'done', result: { name: 'my-lora', path: './lora_output/my-lora' }, bytesDone: WEIGHTS.length });
    expect(readdirSync(path.join(loraDir, 'my-lora')).sort()).toEqual(['adapter_config.json', 'adapter_model.safetensors', 'lora_hub.json']);

    expect((await call('POST', '/install', { source: 'user/good', name: 'my-lora' })).status).toBe(409); // already there
  });

  it('knows nothing of an unknown install', async () => {
    expect(await call('GET', '/installs/does-not-exist')).toMatchObject({ status: 404, body: { code: 'not_found' } });
  });

  it('never leaks the message of an unexpected exception', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await serve({
      inspect: async () => {
        throw new Error('ENOENT: /home/someone/secret/path and a token hf_SECRET');
      },
      startInstall: async () => {
        throw new TypeError('cannot read properties of undefined');
      },
      getJob: () => null,
    } as unknown as LoraHub);
    for (const [route, body] of [['/inspect', { source: 'user/good' }], ['/install', { source: 'user/good' }]] as const) {
      const response = await call('POST', route, body);
      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Internal error.' });
    }
    expect(quiet).toHaveBeenCalled(); // it is logged for the developer, not sent to the client
    quiet.mockRestore();
  });
});
