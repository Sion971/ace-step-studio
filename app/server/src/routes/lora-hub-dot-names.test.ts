// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LoraHub } from '../services/lora-hub.js';
import { GOOD_ADAPTER_CONFIG, fakeWeights, sha256, startFakeHub, type FakeHub } from '../services/lora-hub.fake.js';
import { parseCatalog } from '../services/lora-catalog.js';
import { createLoraHubRouter } from './lora-hub-router.js';

// The engine takes the NAME OF THE FOLDER for the name of the adapter, and PEFT refuses a "." in it: 'module name can't contain ".", got: lo_fi-acestep1.5-v1'.
// Hugging Face repositories are full of them ("…-acestep1.5-v1"), and so was the id of the first catalog entry. Whatever the source, a folder with a dot must never be
// created: it installs fine, appears in the list, and then cannot be loaded.

const WEIGHTS = fakeWeights(20_000, 41);
const auth = ((_req, _res, next) => next()) as express.RequestHandler;

describe('a name with a dot, from a repository or from a catalog id', () => {
  let fake: FakeHub;
  let loraDir: string;
  let hub: LoraHub;
  let server: Server;
  let base: string;

  const folders = () => readdirSync(loraDir).filter((e) => !e.startsWith('.'));
  const done = async (jobId: string) => {
    for (let i = 0; i < 300; i++) {
      const job = hub.getJob(jobId)!;
      if (job.state === 'done' || job.state === 'failed') return job;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('the install did not finish');
  };

  beforeEach(async () => {
    fake = await startFakeHub();
    loraDir = path.join(mkdtempSync(path.join(tmpdir(), 'lora-hub-dots-')), 'lora_output');
    hub = new LoraHub({ loraDir, endpoint: fake.endpoint, stallMs: 400 });
    fake.repos.set('ryanontheinside/lo_fi-acestep1.5-v1', { sha: 'a'.repeat(40), cardData: {}, files: { 'lo_fi-v1.safetensors': WEIGHTS, 'adapter_config.json': GOOD_ADAPTER_CONFIG } });
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server?.closeAllConnections?.();
      server ? server.close(() => resolve()) : resolve();
    });
    await fake.close();
    rmSync(path.dirname(loraDir), { recursive: true, force: true });
  });

  it('from a link: the folder has no dot, the weights are renamed, and the card proposes that name', async () => {
    const card = await hub.inspect('ryanontheinside/lo_fi-acestep1.5-v1');
    expect(card.suggestedName).toBe('lo_fi-acestep1_5-v1');
    const job = await done((await hub.startInstall('ryanontheinside/lo_fi-acestep1.5-v1')).id);
    expect(job).toMatchObject({ state: 'done', name: 'lo_fi-acestep1_5-v1', result: { name: 'lo_fi-acestep1_5-v1', path: './lora_output/lo_fi-acestep1_5-v1' } });
    expect(folders()).toEqual(['lo_fi-acestep1_5-v1']);
    expect(existsSync(path.join(loraDir, 'lo_fi-acestep1_5-v1', 'adapter_model.safetensors'))).toBe(true);
    expect((await hub.inspect('ryanontheinside/lo_fi-acestep1.5-v1')).alreadyInstalled).toBe('lo_fi-acestep1_5-v1');
  });

  it('with a name typed by the user: a dot is turned into "_" there too', async () => {
    const job = await done((await hub.startInstall('ryanontheinside/lo_fi-acestep1.5-v1', { name: 'my.lora.v1.5' })).id);
    expect(job.name).toBe('my_lora_v1_5');
    expect(folders()).toEqual(['my_lora_v1_5']);
  });

  it('from the catalog: an id with a dot gives a folder without one, and the interface is told that path', async () => {
    const catalog = parseCatalog(JSON.stringify({ schema: 1, entries: [{ id: 'lo_fi-acestep1.5-v1', repo: 'ryanontheinside/lo_fi-acestep1.5-v1', file: 'lo_fi-v1.safetensors', revision: 'a'.repeat(40), sha256: sha256(WEIGHTS), name: 'Lo-Fi', baseModel: 'AceStep v1.5 Turbo (2B)' }] }));
    expect(catalog.problems).toEqual([]); // the id itself is allowed to have a dot: it is not the name of the folder
    const app = express();
    app.use(express.json());
    app.use('/api/lora-hub', createLoraHubRouter({ auth, hub, catalog: () => catalog }));
    await new Promise<void>((resolve) => (server = app.listen(0, '127.0.0.1', () => resolve())));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/lora-hub`;

    const started = await (await fetch(`${base}/catalog/lo_fi-acestep1.5-v1/install`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
    expect(started.job.name).toBe('lo_fi-acestep1_5-v1');
    const job = await done(started.job.id);
    expect(job.result).toEqual({ name: 'lo_fi-acestep1_5-v1', path: './lora_output/lo_fi-acestep1_5-v1' });
    expect(folders()).toEqual(['lo_fi-acestep1_5-v1']);

    const listed = (await (await fetch(`${base}/catalog`)).json()).entries[0];
    expect(listed.installed).toMatchObject({ name: 'lo_fi-acestep1_5-v1', path: './lora_output/lo_fi-acestep1_5-v1' }); // still "Installed" in the catalog: it is matched by repository and file
    const provenance = JSON.parse(readFileSync(path.join(loraDir, 'lo_fi-acestep1_5-v1', 'lora_hub.json'), 'utf-8'));
    expect(provenance).not.toHaveProperty('name'); // the folder can be renamed by hand without breaking anything
  });
});
