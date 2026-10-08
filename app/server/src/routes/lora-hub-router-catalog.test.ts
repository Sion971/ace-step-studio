// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express, { type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LoraHub } from '../services/lora-hub.js';
import { GOOD_ADAPTER_CONFIG, fakeWeights, sha256, startFakeHub, type FakeHub } from '../services/lora-hub.fake.js';
import { exampleSidecar } from '../services/lora-sidecar.fixtures.js';
import { parseCatalog, type ParsedCatalog } from '../services/lora-catalog.js';
import { createLoraHubRouter, type LoraHubRouterDeps } from './lora-hub-router.js';

const WEIGHTS = fakeWeights(30_000, 9);
const SHA = sha256(WEIGHTS);
const COMMIT = 'c0ffee0123456789abcdef0123456789abcdef01';
const AUTH = { 'x-test-auth': 'ok' };
const auth: RequestHandler = (req, res, next) => (req.headers['x-test-auth'] === 'ok' ? next() : void res.status(401).json({ error: 'Unauthorized' }));

const entry = (over: Record<string, unknown> = {}) => ({
  id: 'lofi', repo: 'user/lofi', file: 'adapter_model.safetensors', revision: COMMIT, sha256: SHA, name: 'Lo-Fi', baseModel: 'AceStep v1.5 Turbo (2B)', triggerWord: 'ex-l0f1', ...over,
});

describe('lora-hub router: catalog, installed, compatibility', () => {
  let fake: FakeHub;
  let loraDir: string;
  let hub: LoraHub;
  let server: Server;
  let base: string;
  let catalog: ParsedCatalog;

  async function serve(extra: Partial<LoraHubRouterDeps> = {}) {
    const app = express();
    app.use(express.json());
    app.use('/api/lora-hub', createLoraHubRouter({ auth, hub, catalog: () => catalog, ...extra }));
    await new Promise<void>((resolve) => (server = app.listen(0, '127.0.0.1', () => resolve())));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/lora-hub`;
  }
  const call = async (method: string, route: string, body?: unknown, headers: Record<string, string> = AUTH) => {
    const response = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const waitDone = async (id: string) => {
    for (let i = 0; i < 300; i++) {
      const { body } = await call('GET', `/installs/${id}`);
      if (body.job.state === 'done' || body.job.state === 'failed') return body.job;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('the install did not finish');
  };

  beforeEach(async () => {
    fake = await startFakeHub();
    loraDir = path.join(mkdtempSync(path.join(tmpdir(), 'lora-hub-router-catalog-')), 'lora_output');
    fake.repos.set('user/lofi', { sha: COMMIT, cardData: {}, files: { 'adapter_model.safetensors': WEIGHTS, 'adapter_config.json': GOOD_ADAPTER_CONFIG, 'adapter_model.metadata.json': JSON.stringify(exampleSidecar(SHA)) } });
    hub = new LoraHub({ loraDir, endpoint: fake.endpoint, stallMs: 400 });
    catalog = parseCatalog(JSON.stringify({ schema: 1, entries: [entry()] }));
    await serve();
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
    await fake.close();
    rmSync(path.dirname(loraDir), { recursive: true, force: true });
  });

  it('asks for authentication on every new route', async () => {
    for (const [method, route] of [['GET', '/catalog'], ['POST', '/catalog/lofi/install'], ['GET', '/installed']] as const) {
      expect((await call(method, route, method === 'POST' ? {} : undefined, {})).status, route).toBe(401);
    }
    expect(readdirSync(path.dirname(loraDir))).toEqual([]);
  });

  describe('GET /catalog', () => {
    it('lists the entries, none installed, and says whether each suits the loaded model', async () => {
      const { status, body } = await call('GET', '/catalog?activeModel=acestep-v15-turbo&vramGb=8');
      expect(status).toBe(200);
      expect(body.problems).toEqual([]);
      expect(body.entries).toHaveLength(1);
      expect(body.entries[0]).toMatchObject({ id: 'lofi', name: 'Lo-Fi', installed: null, compatibility: { verdict: 'compatible', required: { family: 'turbo', size: '2B' } } });
    });

    it('follows the model: a family mismatch warns, a size mismatch refuses', async () => {
      expect((await call('GET', '/catalog?activeModel=acestep-v15-base')).body.entries[0].compatibility.verdict).toBe('warning');
      const xl = (await call('GET', '/catalog?activeModel=acestep-v15-xl-turbo')).body.entries[0].compatibility;
      expect(xl.verdict).toBe('incompatible');
      expect(xl.reasons[0]).toMatchObject({ code: 'size_mismatch', severity: 'blocking' });
    });

    it('says "unknown" when the client does not say which model is loaded: the server\'s own default is not a loaded model', async () => {
      const without = (await call('GET', '/catalog')).body.entries[0].compatibility;
      expect(without.verdict).toBe('unknown');
      expect(without.active).toBeNull();
      expect(without.reasons.map((r: { code: string }) => r.code)).toEqual(['active_model_unknown']);
      expect(without.required).toMatchObject({ family: 'turbo', size: '2B' }); // what the LoRA needs is still said
      expect((await call('GET', '/catalog?activeModel=')).body.entries[0].compatibility.verdict).toBe('unknown');
    });

    it('refuses parameters that are not what they should be', async () => {
      for (const query of ['vramGb=abc', 'vramGb=-1', 'vramGb=0', 'vramGb=99999', `activeModel=${'x'.repeat(101)}`, 'activeModel=a&activeModel=b', 'activeModel=%00']) {
        const { status, body } = await call('GET', `/catalog?${query}`);
        expect(status, query).toBe(400);
        expect(body.code, query).toBe('invalid_request');
      }
    });

    it('reports the entries that were refused, next to the ones that were not', async () => {
      catalog = parseCatalog(JSON.stringify({ schema: 1, entries: [entry(), { id: 'BAD ID', repo: 'user/x', name: 'x' }] }));
      const { body } = await call('GET', '/catalog');
      expect(body.entries.map((e: { id: string }) => e.id)).toEqual(['lofi']);
      expect(body.problems).toHaveLength(1);
      expect(body.problems[0]).toMatch(/entries\[1\]/);
    });

    it('is empty, not broken, when there is no catalog', async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await serve({ catalog: undefined });
      expect((await call('GET', '/catalog')).body).toEqual({ entries: [], problems: [] });
    });
  });

  describe('POST /catalog/:id/install', () => {
    it('installs the entry, then the catalog and the installed list know it', async () => {
      const started = await call('POST', '/catalog/lofi/install', {});
      expect(started.status).toBe(202);
      expect(started.body.job).toMatchObject({ repo: 'user/lofi', name: 'lofi' });
      const job = await waitDone(started.body.job.id);
      expect(job).toMatchObject({ state: 'done', result: { name: 'lofi', path: './lora_output/lofi' } });

      const installed = (await call('GET', '/installed')).body.installed;
      expect(installed).toHaveLength(1);
      expect(installed[0]).toMatchObject({ name: 'lofi', repo: 'user/lofi', revision: COMMIT, sha256: SHA, triggerWord: 'ex-l0f1', recommended: { scale: 1, steps: 8, guidance: 7, shift: 3 } });
      expect((await call('GET', '/catalog')).body.entries[0].installed).toMatchObject({ name: 'lofi', path: './lora_output/lofi' });
      expect((await call('POST', '/catalog/lofi/install', {})).status).toBe(409); // not twice
    });

    it('installs at the commit the entry pins, not at whatever the repository points to now', async () => {
      await waitDone((await call('POST', '/catalog/lofi/install', {})).body.job.id);
      expect(fake.apiPaths[0]).toBe(`/api/models/user/lofi/revision/${COMMIT}?blobs=true`);
    });

    it('refuses, and installs nothing, when the repository no longer holds the weights that were checked', async () => {
      catalog = parseCatalog(JSON.stringify({ schema: 1, entries: [entry({ sha256: 'ef'.repeat(32) })] }));
      const { status, body } = await call('POST', '/catalog/lofi/install', {});
      expect(status).toBe(409);
      expect(body.code).toBe('catalog_checksum_mismatch');
      expect(fake.resolved.some((r) => r.endsWith('.safetensors'))).toBe(false);
    });

    it('takes the name it is asked for', async () => {
      const job = await waitDone((await call('POST', '/catalog/lofi/install', { name: 'my-lofi' })).body.job.id);
      expect(job.result.name).toBe('my-lofi');
      expect((await call('GET', '/catalog')).body.entries[0].installed.name).toBe('my-lofi');
    });

    it('knows only the entries of the catalog, and takes nothing else from the client', async () => {
      expect(await call('POST', '/catalog/nope/install', {})).toMatchObject({ status: 404, body: { code: 'not_found' } });
      expect(await call('POST', '/catalog/../../etc/install', {})).toMatchObject({ status: 404 });
      expect((await call('POST', '/catalog/lofi/install', { name: 5 })).status).toBe(400);
      // a client cannot widen what is installed: the repository, the file, the commit and the checksum come from the entry, never from the body
      const job = await waitDone((await call('POST', '/catalog/lofi/install', { repo: 'evil/other', file: 'x.safetensors', revision: 'abc1234', sha256: 'ab'.repeat(32), expectedSha256: 'ab'.repeat(32) })).body.job.id);
      expect(job).toMatchObject({ state: 'done', repo: 'user/lofi' });
    });
  });

  describe('POST /inspect', () => {
    it('adds the verdict for the loaded model, and an entry ready to paste into the catalog', async () => {
      const { status, body } = await call('POST', '/inspect', { source: 'user/lofi', activeModel: 'acestep-v15-turbo', vramGb: 8 });
      expect(status).toBe(200);
      expect(body.card).toMatchObject({ repo: 'user/lofi', needsChoice: false });
      expect(body.compatibility).toMatchObject({ verdict: 'compatible', required: { family: 'turbo', size: '2B' } });
      expect(body.catalogEntry).toMatchObject({ id: 'lofi', repo: 'user/lofi', revision: COMMIT, sha256: SHA, triggerWord: 'ex-l0f1', verified: null });
      expect(parseCatalog(JSON.stringify({ schema: 1, entries: [body.catalogEntry] })).problems).toEqual([]);
    });

    it('says "unknown" when no model is given', async () => {
      const { body } = await call('POST', '/inspect', { source: 'user/lofi' });
      expect(body.compatibility).toMatchObject({ verdict: 'unknown', active: null, required: { family: 'turbo', size: '2B' } });
      expect((await call('POST', '/inspect', { source: 'user/lofi', activeModel: 'acestep-v15-xl-turbo' })).body.compatibility.verdict).toBe('incompatible');
    });

    it('has no entry to suggest while the weights are still to be chosen', async () => {
      fake.repos.set('user/two', { files: { 'a.safetensors': WEIGHTS, 'b.safetensors': fakeWeights(9000, 2), 'adapter_config.json': GOOD_ADAPTER_CONFIG } });
      const { body } = await call('POST', '/inspect', { source: 'user/two' });
      expect(body.card.needsChoice).toBe(true);
      expect(body.catalogEntry).toBeNull();
    });

    it('refuses a model or a memory that is not what it should be', async () => {
      for (const extra of [{ vramGb: 'abc' }, { vramGb: -4 }, { activeModel: 42 }, { activeModel: ['a'] }, { activeModel: 'x'.repeat(200) }]) {
        const { status } = await call('POST', '/inspect', { source: 'user/lofi', ...extra });
        expect(status, JSON.stringify(extra)).toBe(400);
      }
    });
  });

  it('lists nothing as installed on a fresh disk', async () => {
    expect((await call('GET', '/installed')).body).toEqual({ installed: [] });
  });
});
