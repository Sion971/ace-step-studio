// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LoraHub, LoraHubError, type InstallJob } from './lora-hub.js';
import { GOOD_ADAPTER_CONFIG, fakeWeights, sha256, startFakeHub, type FakeHub, type FakeRepo } from './lora-hub.fake.js';
import { exampleSidecar } from './lora-sidecar.fixtures.js';

const WEIGHTS = fakeWeights(40_000, 21);
const SHA = sha256(WEIGHTS);
const repoWith = (over: Partial<FakeRepo> = {}): FakeRepo => ({ files: { 'adapter_model.safetensors': WEIGHTS, 'adapter_config.json': GOOD_ADAPTER_CONFIG }, ...over });

async function finished(hub: LoraHub, id: string): Promise<InstallJob> {
  for (let i = 0; i < 500; i++) {
    const job = hub.getJob(id) as InstallJob;
    if (job.state === 'done' || job.state === 'failed') return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the install did not finish');
}
async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof LoraHubError) return error.code;
    throw error;
  }
  return 'no error';
}

describe('LoraHub: what a catalog entry pins', () => {
  let fake: FakeHub;
  let loraDir: string;
  let hub: LoraHub;

  beforeEach(async () => {
    fake = await startFakeHub();
    loraDir = path.join(mkdtempSync(path.join(tmpdir(), 'lora-hub-pins-')), 'lora_output');
    hub = new LoraHub({ loraDir, endpoint: fake.endpoint, stallMs: 400 });
  });
  afterEach(async () => {
    await fake.close();
    rmSync(path.dirname(loraDir), { recursive: true, force: true });
  });

  describe('the revision', () => {
    it('is asked of the Hub, and the files are read at the commit the Hub answers with', async () => {
      fake.repos.set('user/good', repoWith({ sha: 'a'.repeat(40) }));
      await hub.inspect('user/good', { revision: '497b97b7e8548d916366ee534551413d32d0fbd0' });
      expect(fake.apiQueries[0]).toBe('?blobs=true&revision=497b97b7e8548d916366ee534551413d32d0fbd0');
      expect(fake.resolved.every((r) => r.startsWith('a'.repeat(40)))).toBe(true);
    });

    it('wins over the revision of a link', async () => {
      fake.repos.set('user/good', repoWith());
      await hub.inspect(`${fake.endpoint}/user/good/tree/main`, { revision: 'abc1234' });
      expect(fake.apiQueries[0]).toBe('?blobs=true&revision=abc1234');
    });

    it('is refused when it is not a revision', async () => {
      fake.repos.set('user/good', repoWith());
      for (const revision of ['', '../x', 'a b', '-x', 'x'.repeat(200), 'a/b']) {
        expect(await codeOf(hub.inspect('user/good', { revision })), JSON.stringify(revision)).toBe('invalid_revision');
      }
      expect(fake.apiQueries).toEqual([]); // refused before anything was asked of the Hub
    });
  });

  describe('the checksum', () => {
    it('lets an install through when it is the one that was pinned', async () => {
      fake.repos.set('user/good', repoWith());
      const job = await finished(hub, (await hub.startInstall('user/good', { expectedSha256: SHA })).id);
      expect(job.state).toBe('done');
    });

    it('accepts it written the way a Hub writes it', async () => {
      fake.repos.set('user/good', repoWith());
      const job = await finished(hub, (await hub.startInstall('user/good', { expectedSha256: `sha256:${SHA.toUpperCase()}` })).id);
      expect(job.state).toBe('done');
    });

    it('refuses BEFORE downloading when the Hub already reports another one: the repository changed since it was checked', async () => {
      fake.repos.set('user/changed', repoWith());
      await expect(hub.startInstall('user/changed', { expectedSha256: 'ef'.repeat(32) })).rejects.toMatchObject({ code: 'catalog_checksum_mismatch', status: 409 });
      expect(fake.resolved.some((r) => r.endsWith('.safetensors'))).toBe(false);
      expect(() => readdirSync(loraDir)).toThrow(); // the folder was not even created
    });

    it('checks after the download when the Hub publishes no checksum, and installs nothing if it is not the pinned one', async () => {
      fake.repos.set('user/nosum', repoWith({ noLfs: true }));
      const job = await finished(hub, (await hub.startInstall('user/nosum', { expectedSha256: 'ef'.repeat(32) })).id);
      expect(job).toMatchObject({ state: 'failed', error: { code: 'catalog_checksum_mismatch' } });
      expect(readdirSync(loraDir)).toEqual([]);
    });

    it('is satisfied by the right content even when the Hub publishes no checksum', async () => {
      fake.repos.set('user/nosum', repoWith({ noLfs: true }));
      expect((await finished(hub, (await hub.startInstall('user/nosum', { expectedSha256: SHA })).id)).state).toBe('done');
    });

    it('is refused when it is not a sha256', async () => {
      fake.repos.set('user/good', repoWith());
      for (const bad of ['nope', '', 'ab'.repeat(31), 'zz'.repeat(32)]) {
        expect(await codeOf(hub.startInstall('user/good', { expectedSha256: bad })), JSON.stringify(bad)).toBe('invalid_checksum');
      }
    });

    it('does not change an install that pins nothing', async () => {
      fake.repos.set('user/good', repoWith());
      expect((await finished(hub, (await hub.startInstall('user/good')).id)).state).toBe('done');
    });
  });

  describe('listInstalled', () => {
    const install = async (repo: string, over: Partial<FakeRepo> = {}) => {
      fake.repos.set(repo, repoWith(over));
      const job = await finished(hub, (await hub.startInstall(repo)).id);
      expect(job.state).toBe('done');
    };

    it('is empty when nothing was installed, and when the folder does not exist', () => {
      expect(hub.listInstalled()).toEqual([]);
      expect(new LoraHub({ loraDir: '/nonexistent/lora_output', endpoint: fake.endpoint }).listInstalled()).toEqual([]);
    });

    it('lists what was installed, with what was recorded then', async () => {
      await install('user/lofi', { files: { 'adapter_model.safetensors': WEIGHTS, 'adapter_config.json': GOOD_ADAPTER_CONFIG, 'adapter_model.metadata.json': JSON.stringify(exampleSidecar(SHA)) }, sha: 'b'.repeat(40), cardData: {} }); // declares nothing: the base model comes from the metadata file
      await install('user/another');
      const list = hub.listInstalled();
      expect(list.map((i) => i.name)).toEqual(['another', 'lofi']);
      expect(list[1]).toMatchObject({
        name: 'lofi', path: './lora_output/lofi', repo: 'user/lofi', revision: 'b'.repeat(40), file: 'adapter_model.safetensors', sha256: SHA, triggerWord: 'ex-l0f1',
        baseModel: ['AceStep v1.5 Turbo (2B)'], recommended: { scale: 1, steps: 8, guidance: 7, shift: 3 },
      });
      expect(list[1].installedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(list[0]).toMatchObject({ triggerWord: null, recommended: { scale: null, steps: null, guidance: null, shift: null } });
    });

    it('does not list a LoRA that was trained, a temporary folder, a reserved folder or a loose file', async () => {
      await install('user/good');
      mkdirSync(path.join(loraDir, 'my-trained-lora'));
      writeFileSync(path.join(loraDir, 'my-trained-lora', 'adapter_config.json'), '{}');
      mkdirSync(path.join(loraDir, '.hub-tmp-abc'));
      writeFileSync(path.join(loraDir, '.hub-tmp-abc', 'lora_hub.json'), '{"repo":"user/x"}');
      for (const reserved of ['checkpoints', 'runs']) {
        mkdirSync(path.join(loraDir, reserved));
        writeFileSync(path.join(loraDir, reserved, 'lora_hub.json'), '{"repo":"user/x"}');
      }
      writeFileSync(path.join(loraDir, 'notes.txt'), 'x');
      expect(hub.listInstalled().map((i) => i.name)).toEqual(['good']);
    });

    it('reads the provenance file as untrusted: it is on the user\'s disk, where anything can have written it', async () => {
      const write = (name: string, content: string) => {
        mkdirSync(path.join(loraDir, name), { recursive: true });
        writeFileSync(path.join(loraDir, name, 'lora_hub.json'), content);
      };
      write('broken', '{not json');
      write('array', '[1,2]');
      write('text', '"text"');
      write('hostile', JSON.stringify({
        repo: '../../etc/passwd', revision: '<script>', file: 'x'.repeat(999), sha256: 'nope', license: '<b>MIT</b>', baseModel: ['x'.repeat(500), 5, null],
        sidecar: { triggerWord: '<img src=x>', recommended: { scale: 99, steps: -1, guidance: 'high', shift: 3 } }, installedAt: 12345,
      }));
      const list = hub.listInstalled();
      expect(list.map((i) => i.name)).toEqual(['hostile']); // the three that are not JSON objects are skipped
      expect(JSON.stringify(list[0])).not.toMatch(/[<>]/);
      expect(list[0]).toMatchObject({ repo: null, sha256: null, installedAt: null, recommended: { scale: null, steps: null, guidance: null, shift: 3 } });
      expect(list[0].file!.length).toBeLessThanOrEqual(200);
      expect(list[0].baseModel.every((b) => b.length <= 120)).toBe(true);
    });
  });
});
