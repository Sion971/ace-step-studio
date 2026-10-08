// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LoraHub, LoraHubError, parseRepoRef, sanitizeName, type InstallJob } from './lora-hub.js';
import { GOOD_ADAPTER_CONFIG, fakeWeights, sha256, startFakeHub, type FakeHub, type FakeRepo } from './lora-hub.fake.js';

const TOKEN = 'hf_test_token';
const WEIGHTS = fakeWeights(50_000, 7);

const goodRepo = (over: Partial<FakeRepo> = {}): FakeRepo => ({
  files: { 'adapter_model.safetensors': WEIGHTS, 'adapter_config.json': GOOD_ADAPTER_CONFIG, 'README.md': '# a LoRA' },
  ...over,
});

/** Waits until a job is finished (or fails the test after 5 s). */
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

// ---------------------------------------------------------------------------------------------------------------- parsing --
describe('parseRepoRef', () => {
  it('accepts owner/name and the usual page links of the Hub', () => {
    expect(parseRepoRef('ryanontheinside/deep_house-acestep1.5-v1')).toEqual({ repo: 'ryanontheinside/deep_house-acestep1.5-v1' });
    expect(parseRepoRef('  user/repo  ')).toEqual({ repo: 'user/repo' });
    expect(parseRepoRef('https://huggingface.co/user/repo')).toEqual({ repo: 'user/repo' });
    expect(parseRepoRef('https://huggingface.co/user/repo/tree/v2')).toEqual({ repo: 'user/repo', revision: 'v2' });
    expect(parseRepoRef('https://huggingface.co/user/repo/blob/abc123/adapter_config.json')).toEqual({ repo: 'user/repo', revision: 'abc123' });
    expect(parseRepoRef('https://huggingface.co/user/repo/resolve/main/x.safetensors?download=true')).toEqual({ repo: 'user/repo', revision: 'main' });
    expect(parseRepoRef('https://huggingface.co/user/repo/')).toEqual({ repo: 'user/repo' });
  });

  it('refuses anything that is not a model repository of the Hub', () => {
    for (const bad of [
      '', '   ', 'user', 'a/b/c', 'user/repo?x=1', 'user/repo#frag', 'user/..', '../etc/passwd', 'user/repo\\x', '/user/repo/',
      'https://evil.example/user/repo', 'https://huggingface.co.evil.example/user/repo', 'ftp://huggingface.co/user/repo',
      'https://huggingface.co/datasets/user/repo', 'https://huggingface.co/spaces/user/repo', 'https://huggingface.co/user',
      'https://huggingface.co/user/repo/raw/main/x', 'x'.repeat(400), 'user/re po', 'user/repo:tag', 'user@host/repo',
    ]) {
      expect(() => parseRepoRef(bad), bad.slice(0, 50)).toThrow(LoraHubError);
    }
    for (const notText of [undefined, null, 42, {}, ['user/repo']]) expect(() => parseRepoRef(notText)).toThrow(LoraHubError);
  });

  it('accepts links on the endpoint it was configured with, and only that one', () => {
    expect(parseRepoRef('http://127.0.0.1:8123/user/repo', 'http://127.0.0.1:8123')).toEqual({ repo: 'user/repo' });
    expect(() => parseRepoRef('http://127.0.0.1:9999/user/repo', 'http://127.0.0.1:8123')).toThrow(LoraHubError);
  });
});

describe('sanitizeName', () => {
  it('keeps a readable name and drops what a folder name cannot hold', () => {
    expect(sanitizeName('deep_house-acestep1.5-v1')).toBe('deep_house-acestep1.5-v1');
    expect(sanitizeName('My LoRA (v2)!')).toBe('My-LoRA-v2');
    expect(sanitizeName('été à Paris')).toBe('ete-a-Paris');
  });

  it('cannot escape lora_output', () => {
    expect(sanitizeName('../../etc/passwd')).toBe('etc-passwd');
    expect(sanitizeName('/abs/path')).toBe('abs-path');
    expect(sanitizeName('a/../b')).not.toContain('/');
    expect(sanitizeName('.hidden')).toBe('hidden');
    for (const name of ['..', '.', '...', '---', '___', '   ', '']) expect(() => sanitizeName(name), JSON.stringify(name)).toThrow(LoraHubError);
  });

  it('refuses the folders the LoRA list skips, and caps the length', () => {
    expect(() => sanitizeName('checkpoints')).toThrow(LoraHubError);
    expect(() => sanitizeName('Runs')).toThrow(LoraHubError);
    expect(sanitizeName('a'.repeat(200)).length).toBeLessThanOrEqual(64);
  });
});

// ---------------------------------------------------------------------------------------------------------------- the hub --
describe('LoraHub', () => {
  let fake: FakeHub;
  let loraDir: string;
  let hub: LoraHub;

  const makeHub = (over: Record<string, unknown> = {}) =>
    new LoraHub({ loraDir, endpoint: fake.endpoint, token: TOKEN, stallMs: 400, ...over });

  beforeEach(async () => {
    fake = await startFakeHub(TOKEN);
    loraDir = path.join(mkdtempSync(path.join(tmpdir(), 'lora-hub-')), 'lora_output');
    hub = makeHub();
  });

  afterEach(async () => {
    await fake.close();
    rmSync(path.dirname(loraDir), { recursive: true, force: true });
  });

  // ------------------------------------------------------------------------------------------------------------ inspect --
  describe('inspect', () => {
    it('describes a LoRA: what it is, its weights, its adapter, its license', async () => {
      fake.repos.set('user/good', goodRepo({ cardData: { license: 'cc-by-4.0', base_model: ['ACE-Step/acestep-v15-turbo'] }, tags: ['peft', 'lora'] }));
      const card = await hub.inspect('user/good');
      expect(card).toMatchObject({
        repo: 'user/good',
        revision: 'c0ffee0123456789abcdef0123456789abcdef01',
        license: 'cc-by-4.0',
        baseModel: ['ACE-Step/acestep-v15-turbo'],
        tags: ['peft', 'lora'],
        gated: false,
        needsChoice: false,
        suggestedName: 'good',
        alreadyInstalled: null,
        warnings: [],
        adapter: { peftType: 'LORA', rank: 64, alpha: 128, baseModel: 'ACE-Step/Ace-Step1.5', targetModules: ['q_proj', 'k_proj', 'v_proj', 'o_proj'] },
      });
      expect(card.selected).toEqual({ name: 'adapter_model.safetensors', size: WEIGHTS.length, sha256: sha256(WEIGHTS) });
      expect(card.weights).toHaveLength(1);
    });

    it('asks for blobs, at the revision of the link, and reads the files at the COMMIT the API reported', async () => {
      const commit = 'abcdef0123456789abcdef0123456789abcdef01';
      fake.repos.set('user/good', goodRepo({ sha: commit, refs: { dev: commit } }));
      await hub.inspect(`${fake.endpoint}/user/good/tree/dev`);
      expect(fake.apiPaths[0]).toBe('/api/models/user/good/revision/dev?blobs=true');
      expect(fake.resolved).toContain('abcdef0123456789abcdef0123456789abcdef01:adapter_config.json');
      expect(fake.resolved.every((r) => r.startsWith('abcdef0'))).toBe(true);
    });

    it('asks the base address when no revision is given', async () => {
      fake.repos.set('user/good', goodRepo());
      await hub.inspect('user/good');
      expect(fake.apiPaths).toEqual(['/api/models/user/good?blobs=true']);
    });

    it('takes the only .safetensors, whatever its name (it is renamed at install)', async () => {
      fake.repos.set('user/named', goodRepo({ files: { 'deep_house-v1.safetensors': WEIGHTS, 'adapter_config.json': GOOD_ADAPTER_CONFIG } }));
      const card = await hub.inspect('user/named');
      expect(card.selected?.name).toBe('deep_house-v1.safetensors');
      expect(card.needsChoice).toBe(false);
    });

    it('never guesses between several candidates', async () => {
      fake.repos.set('user/many', goodRepo({ files: { 'a.safetensors': WEIGHTS, 'merge.safetensors': fakeWeights(9000, 3), 'adapter_config.json': GOOD_ADAPTER_CONFIG } }));
      const card = await hub.inspect('user/many');
      expect(card.needsChoice).toBe(true);
      expect(card.selected).toBeNull();
      expect(card.adapter).toBeNull();
      expect(card.weights.map((w) => w.name).sort()).toEqual(['a.safetensors', 'merge.safetensors']);
      const chosen = await hub.inspect('user/many', { file: 'merge.safetensors' });
      expect(chosen.selected?.name).toBe('merge.safetensors');
      expect(chosen.adapter?.rank).toBe(64);
    });

    it('takes adapter_model.safetensors when it is the standard name among several', async () => {
      fake.repos.set('user/std', goodRepo({ files: { 'adapter_model.safetensors': WEIGHTS, 'vocal_instrument_merge_adapter_model.safetensors': fakeWeights(9000, 3), 'adapter_config.json': GOOD_ADAPTER_CONFIG } }));
      expect((await hub.inspect('user/std')).selected?.name).toBe('adapter_model.safetensors');
    });

    it('refuses a file that is not one of the listed weights, so a typed name is never a path', async () => {
      fake.repos.set('user/good', goodRepo());
      for (const file of ['../../../etc/passwd', 'README.md', 'adapter_config.json', '/abs.safetensors', 'nope.safetensors', '']) {
        expect(await codeOf(hub.inspect('user/good', { file })), file).toBe('unknown_file');
      }
    });

    it('uses the adapter_config.json that sits next to the chosen weights', async () => {
      fake.repos.set('user/sub', goodRepo({ files: { 'final/adapter_model.safetensors': WEIGHTS, 'final/adapter_config.json': JSON.stringify({ peft_type: 'LORA', r: 16, lora_alpha: 32 }), 'adapter_config.json': GOOD_ADAPTER_CONFIG } }));
      const card = await hub.inspect('user/sub');
      expect(card.selected?.name).toBe('final/adapter_model.safetensors');
      expect(card.adapter?.rank).toBe(16);
      expect(fake.resolved).toContain('c0ffee0123456789abcdef0123456789abcdef01:final/adapter_config.json');
    });

    it('refuses formats that can run code, and says why', async () => {
      fake.repos.set('user/pickle', goodRepo({ files: { 'adapter_model.bin': WEIGHTS, 'adapter_config.json': GOOD_ADAPTER_CONFIG } }));
      expect(await codeOf(hub.inspect('user/pickle'))).toBe('unsupported_format');
      await expect(hub.inspect('user/pickle')).rejects.toThrow(/can run code/);
      fake.repos.set('user/none', goodRepo({ files: { 'README.md': 'x', 'adapter_config.json': GOOD_ADAPTER_CONFIG } }));
      expect(await codeOf(hub.inspect('user/none'))).toBe('no_weights');
    });

    it('refuses a repository that is not a loadable PEFT LoRA', async () => {
      fake.repos.set('user/noconfig', goodRepo({ files: { 'adapter_model.safetensors': WEIGHTS } }));
      expect(await codeOf(hub.inspect('user/noconfig'))).toBe('no_adapter_config');
      fake.repos.set('user/lokr', goodRepo({ files: { 'adapter_model.safetensors': WEIGHTS, 'adapter_config.json': JSON.stringify({ peft_type: 'LOKR' }) } }));
      expect(await codeOf(hub.inspect('user/lokr'))).toBe('unsupported_adapter');
      fake.repos.set('user/badjson', goodRepo({ files: { 'adapter_model.safetensors': WEIGHTS, 'adapter_config.json': '{not json' } }));
      expect(await codeOf(hub.inspect('user/badjson'))).toBe('invalid_adapter_config');
      fake.repos.set('user/array', goodRepo({ files: { 'adapter_model.safetensors': WEIGHTS, 'adapter_config.json': '[1,2]' } }));
      expect(await codeOf(hub.inspect('user/array'))).toBe('invalid_adapter_config');
    });

    it('warns, rather than refuses, when the config does not say what kind of adapter it is', async () => {
      fake.repos.set('user/vague', goodRepo({ files: { 'adapter_model.safetensors': WEIGHTS, 'adapter_config.json': '{"r": 8}' } }));
      const card = await hub.inspect('user/vague');
      expect(card.adapter).toMatchObject({ peftType: null, rank: 8 });
      expect(card.warnings.join(' ')).toMatch(/no peft_type/);
    });

    it('says so when no checksum is published', async () => {
      fake.repos.set('user/nosum', goodRepo({ noLfs: true }));
      const card = await hub.inspect('user/nosum');
      expect(card.selected?.sha256).toBeNull();
      expect(card.warnings.join(' ')).toMatch(/No checksum is published/);
    });

    it('treats the author-written card as untrusted text', async () => {
      fake.repos.set('user/hostile', goodRepo({
        cardData: { license: '<script>alert(1)</script>\u0007MIT', base_model: ['x'.repeat(500), 42, null, 'b', 'c', 'd', 'e', 'f', 'g'] },
        tags: ['ok', 7, { a: 1 }, 'y'.repeat(300)],
      }));
      const card = await hub.inspect('user/hostile');
      expect(card.license).not.toMatch(/[<>\u0007]/);
      expect(card.license).toContain('MIT');
      expect(card.baseModel.length).toBeLessThanOrEqual(5);
      expect(card.baseModel.every((b) => b.length <= 120)).toBe(true);
      expect(card.tags[0]).toBe('ok');
      expect(card.tags.every((t) => typeof t === 'string' && t.length <= 60)).toBe(true);
    });

    it('ignores listed files whose names could be a path trick', async () => {
      fake.repos.set('user/trick', goodRepo({
        rawSiblings: [
          { rfilename: '../../evil.safetensors', size: 10 },
          { rfilename: '/abs.safetensors', size: 10 },
          { rfilename: 'a\\b.safetensors', size: 10 },
          { rfilename: 'adapter_model.safetensors', size: WEIGHTS.length, lfs: { sha256: `sha256:${sha256(WEIGHTS).toUpperCase()}`, size: WEIGHTS.length } },
          { rfilename: 'adapter_config.json', size: GOOD_ADAPTER_CONFIG.length },
          { nonsense: true },
          null,
        ],
      }));
      const card = await hub.inspect('user/trick');
      expect(card.weights.map((w) => w.name)).toEqual(['adapter_model.safetensors']);
      expect(card.selected?.sha256).toBe(sha256(WEIGHTS)); // "sha256:" prefix and upper case are normalized
    });

    it('reports an already installed LoRA of the same name', async () => {
      fake.repos.set('user/good', goodRepo());
      const first = await hub.startInstall('user/good');
      expect((await finished(hub, first.id)).state).toBe('done');
      expect((await hub.inspect('user/good')).alreadyInstalled).toBe('good');
    });

    it('refuses a weights file above the size limit', async () => {
      fake.repos.set('user/big', goodRepo());
      expect(await codeOf(makeHub({ maxWeightsBytes: 1000 }).inspect('user/big'))).toBe('too_large');
    });

    it('turns what the Hub answers into clear errors', async () => {
      expect(await codeOf(hub.inspect('user/missing'))).toBe('not_found');
      fake.repos.set('user/private', goodRepo({ requireToken: true }));
      expect(await codeOf(makeHub({ token: undefined }).inspect('user/private'))).toBe('forbidden');
      await expect(makeHub({ token: undefined }).inspect('user/private')).rejects.toThrow(/HF_TOKEN/);
      expect((await hub.inspect('user/private')).repo).toBe('user/private'); // with the token it works
      fake.forceApiStatus = 429;
      expect(await codeOf(hub.inspect('user/private'))).toBe('rate_limited');
      fake.forceApiStatus = 503;
      expect(await codeOf(hub.inspect('user/private'))).toBe('hub_error');
    });

    it('turns a Hub that answers nonsense, or that is unreachable, into clear errors', async () => {
      fake.repos.set('user/odd', goodRepo({ rawBody: '<html>maintenance</html>' }));
      expect(await codeOf(hub.inspect('user/odd'))).toBe('unexpected_response');
      fake.repos.set('user/odd2', goodRepo({ rawBody: '{"id":"x"}' }));
      expect(await codeOf(hub.inspect('user/odd2'))).toBe('unexpected_response');
      const nowhere = new LoraHub({ loraDir, endpoint: 'http://127.0.0.1:1' });
      expect(await codeOf(nowhere.inspect('user/good'))).toBe('network');
    });
  });

  // ----------------------------------------------------------------------------------------------------------- install --
  describe('install', () => {
    it('installs under the names GET /api/lora/available lists, with its provenance', async () => {
      fake.repos.set('user/deep-house', goodRepo({ files: { 'deep_house-v1.safetensors': WEIGHTS, 'adapter_config.json': GOOD_ADAPTER_CONFIG } }));
      const started = await hub.startInstall('user/deep-house');
      expect(started).toMatchObject({ repo: 'user/deep-house', name: 'deep-house', state: 'downloading', bytesTotal: WEIGHTS.length });
      const job = await finished(hub, started.id);
      expect(job).toMatchObject({ state: 'done', result: { name: 'deep-house', path: './lora_output/deep-house' }, bytesDone: WEIGHTS.length });

      const dir = path.join(loraDir, 'deep-house');
      expect(readdirSync(dir).sort()).toEqual(['adapter_config.json', 'adapter_model.safetensors', 'lora_hub.json']);
      expect(readFileSync(path.join(dir, 'adapter_model.safetensors')).equals(WEIGHTS)).toBe(true);
      expect(readFileSync(path.join(dir, 'adapter_config.json'), 'utf-8')).toBe(GOOD_ADAPTER_CONFIG);
      const provenance = JSON.parse(readFileSync(path.join(dir, 'lora_hub.json'), 'utf-8'));
      expect(provenance).toMatchObject({
        schema: 1, source: 'huggingface', repo: 'user/deep-house', revision: 'c0ffee0123456789abcdef0123456789abcdef01',
        file: 'deep_house-v1.safetensors', sha256: sha256(WEIGHTS), size: WEIGHTS.length, checksumPublished: true, license: 'cc-by-4.0',
      });
      expect(provenance.adapter.rank).toBe(64);
      expect(readdirSync(loraDir).filter((e) => e.startsWith('.hub-tmp'))).toEqual([]);
    });

    it('shows a progress that only goes forward and ends at the full size', async () => {
      fake.repos.set('user/good', goodRepo());
      const seen: number[] = [];
      const started = await hub.startInstall('user/good');
      for (let i = 0; i < 300; i++) {
        const job = hub.getJob(started.id) as InstallJob;
        seen.push(job.bytesDone);
        if (job.state === 'done') break;
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      expect(seen.every((n, i) => i === 0 || n >= seen[i - 1])).toBe(true);
      expect(seen[seen.length - 1]).toBe(WEIGHTS.length);
    });

    it('installs without a published checksum, and records that it could not be checked', async () => {
      fake.repos.set('user/nosum', goodRepo({ noLfs: true }));
      const job = await finished(hub, (await hub.startInstall('user/nosum')).id);
      expect(job.state).toBe('done');
      expect(JSON.parse(readFileSync(path.join(loraDir, 'nosum', 'lora_hub.json'), 'utf-8')).checksumPublished).toBe(false);
    });

    it('installs nothing when the content does not match the published checksum', async () => {
      fake.repos.set('user/corrupt', goodRepo({ weightsBehavior: 'wrong-bytes' }));
      const job = await finished(hub, (await hub.startInstall('user/corrupt')).id);
      expect(job).toMatchObject({ state: 'failed', error: { code: 'checksum_mismatch' } });
      expect(readdirSync(loraDir)).toEqual([]); // no final folder, no temporary folder
    });

    it('installs nothing when more arrives than was announced', async () => {
      fake.repos.set('user/more', goodRepo({ weightsBehavior: 'oversize' }));
      const job = await finished(hub, (await hub.startInstall('user/more')).id);
      expect(job).toMatchObject({ state: 'failed', error: { code: 'size_mismatch' } });
      expect(readdirSync(loraDir)).toEqual([]);
    });

    it('installs nothing when the connection drops half way', async () => {
      fake.repos.set('user/cut', goodRepo({ weightsBehavior: 'truncated' }));
      const job = await finished(hub, (await hub.startInstall('user/cut')).id);
      expect(job.state).toBe('failed');
      expect(readdirSync(loraDir)).toEqual([]);
    });

    it('gives up on a download that stalls, instead of waiting forever', async () => {
      fake.repos.set('user/stall', goodRepo({ weightsBehavior: 'stall' }));
      const stalling = makeHub({ stallMs: 150 });
      const startedAt = Date.now();
      const job = await finished(stalling, (await stalling.startInstall('user/stall')).id);
      expect(job).toMatchObject({ state: 'failed', error: { code: 'download_stalled' } });
      expect(Date.now() - startedAt).toBeLessThan(3000);
      expect(readdirSync(loraDir)).toEqual([]);
    });

    it('refuses to overwrite a LoRA that is already there, before downloading anything', async () => {
      fake.repos.set('user/good', goodRepo());
      expect((await finished(hub, (await hub.startInstall('user/good')).id)).state).toBe('done');
      const before = fake.resolved.length;
      expect(await codeOf(hub.startInstall('user/good'))).toBe('already_installed');
      expect(fake.resolved.length).toBe(before + 1); // only the small adapter_config.json that inspecting reads
      expect(readdirSync(loraDir).filter((e) => e.startsWith('.hub-tmp'))).toEqual([]);
      const renamed = await finished(hub, (await hub.startInstall('user/good', { name: 'good-2' })).id);
      expect(renamed.result?.name).toBe('good-2');
    });

    it('cannot be made to write outside lora_output', async () => {
      fake.repos.set('user/good', goodRepo());
      const job = await finished(hub, (await hub.startInstall('user/good', { name: '../../escaped' })).id);
      expect(job.result?.name).toBe('escaped');
      expect(existsSync(path.join(path.dirname(loraDir), 'escaped'))).toBe(false);
      expect(existsSync(path.join(loraDir, 'escaped', 'adapter_model.safetensors'))).toBe(true);
      expect(await codeOf(hub.startInstall('user/good', { name: 'checkpoints' }))).toBe('reserved_name');
      expect(await codeOf(hub.startInstall('user/good', { name: '..' }))).toBe('invalid_name');
    });

    it('asks which file to install when there are several', async () => {
      fake.repos.set('user/many', goodRepo({ files: { 'a.safetensors': WEIGHTS, 'b.safetensors': fakeWeights(9000, 3), 'adapter_config.json': GOOD_ADAPTER_CONFIG } }));
      await expect(hub.startInstall('user/many')).rejects.toMatchObject({ code: 'choose_file', status: 409, details: { files: ['a.safetensors', 'b.safetensors'] } });
      const job = await finished(hub, (await hub.startInstall('user/many', { file: 'b.safetensors' })).id);
      expect(job.state).toBe('done');
      expect(readFileSync(path.join(loraDir, 'many', 'adapter_model.safetensors')).equals(fakeWeights(9000, 3))).toBe(true);
    });

    it('sends the token to the Hub, never to the CDN it redirects to', async () => {
      fake.repos.set('user/private', goodRepo({ requireToken: true }));
      const job = await finished(hub, (await hub.startInstall('user/private')).id);
      expect(job.state).toBe('done');
      expect(fake.hubHeaders.some((h) => h.authorization === `Bearer ${TOKEN}`)).toBe(true);
      expect(fake.cdnHeaders.length).toBeGreaterThan(0);
      expect(fake.cdnHeaders.every((h) => h.authorization === undefined)).toBe(true);
    });

    it('runs at most two installs at once, and does not start the same name twice', async () => {
      let release!: () => void;
      fake.gate = new Promise<void>((resolve) => (release = resolve));
      for (const n of ['one', 'two', 'three']) fake.repos.set(`user/${n}`, goodRepo());
      const a = await hub.startInstall('user/one');
      const b = await hub.startInstall('user/two');
      expect(await codeOf(hub.startInstall('user/three'))).toBe('busy');
      release();
      await finished(hub, a.id);
      await finished(hub, b.id);
      expect((await finished(hub, (await hub.startInstall('user/three')).id)).state).toBe('done');
    });

    it('does not start the same name twice at once', async () => {
      let release!: () => void;
      fake.gate = new Promise<void>((resolve) => (release = resolve));
      fake.repos.set('user/one', goodRepo());
      const a = await hub.startInstall('user/one');
      expect(await codeOf(hub.startInstall('user/one'))).toBe('already_installing');
      release();
      await finished(hub, a.id);
    });

    it('forgets finished jobs after a while, and knows nothing of an unknown one', async () => {
      let clock = 1_000_000;
      const timed = makeHub({ now: () => clock });
      fake.repos.set('user/good', goodRepo());
      const job = await finished(timed, (await timed.startInstall('user/good')).id);
      expect(timed.getJob(job.id)).not.toBeNull();
      clock += 11 * 60_000;
      expect(timed.getJob(job.id)).toBeNull();
      expect(timed.getJob('nope')).toBeNull();
    });

    it('turns an unexpected failure into a failed job, with a message and no stack', async () => {
      fake.repos.set('user/good', goodRepo());
      // lora_output cannot be created under a path that is a plain file
      const aFile = path.join(path.dirname(loraDir), 'a-file');
      writeFileSync(aFile, 'x');
      const broken = makeHub({ loraDir: path.join(aFile, 'lora_output') });
      const job = await finished(broken, (await broken.startInstall('user/good')).id);
      expect(job.state).toBe('failed');
      expect(job.error?.code).toBe('install_failed');
      expect(job.error?.message).toMatch(/^Install failed: /);
      expect(job.error?.message).not.toMatch(/\n\s+at /);
    });
  });
});
