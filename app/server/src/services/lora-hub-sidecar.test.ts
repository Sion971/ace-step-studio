// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LoraHub, type InstallJob } from './lora-hub.js';
import { GOOD_ADAPTER_CONFIG, fakeWeights, sha256, startFakeHub, type FakeHub, type FakeRepo } from './lora-hub.fake.js';
import { exampleSidecar } from './lora-sidecar.fixtures.js';

const WEIGHTS = fakeWeights(40_000, 11);
const WEIGHTS_SHA = sha256(WEIGHTS);
const json = (value: unknown) => JSON.stringify(value, null, 2);

const repoWith = (files: Record<string, Buffer | string>, over: Partial<FakeRepo> = {}): FakeRepo => ({
  files: { 'adapter_model.safetensors': WEIGHTS, 'adapter_config.json': GOOD_ADAPTER_CONFIG, ...files },
  ...over,
});

async function finished(hub: LoraHub, id: string): Promise<InstallJob> {
  for (let i = 0; i < 500; i++) {
    const job = hub.getJob(id) as InstallJob;
    if (job.state === 'done' || job.state === 'failed') return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the install did not finish');
}

describe('metadata file (<weights>.metadata.json)', () => {
  let fake: FakeHub;
  let loraDir: string;
  let hub: LoraHub;

  beforeEach(async () => {
    fake = await startFakeHub();
    loraDir = path.join(mkdtempSync(path.join(tmpdir(), 'lora-hub-sidecar-')), 'lora_output');
    hub = new LoraHub({ loraDir, endpoint: fake.endpoint, stallMs: 400 });
  });

  afterEach(async () => {
    await fake.close();
    rmSync(path.dirname(loraDir), { recursive: true, force: true });
  });

  it('puts what the author published on the card, next to what the Hub reports', async () => {
    fake.repos.set('user/lofi', repoWith({ 'adapter_model.metadata.json': json(exampleSidecar(WEIGHTS_SHA)) }));
    const card = await hub.inspect('user/lofi');
    expect(card.warnings).toEqual([]);
    expect(card.sidecar).toMatchObject({
      name: 'Example Lo-Fi',
      triggerWord: 'ex-l0f1',
      baseModelRequired: 'AceStep v1.5 Turbo (2B)',
      recommended: { scale: 1, steps: 8, guidance: 7, shift: 3, sampleRate: 48000 },
      testedScale: [0.3, 1],
      sha256: WEIGHTS_SHA,
    });
  });

  it('takes the required base model from the metadata file when the repository does not declare one', async () => {
    fake.repos.set('user/lofi', repoWith({ 'adapter_model.metadata.json': json(exampleSidecar(WEIGHTS_SHA)) }, { cardData: { library_name: 'peft' } }));
    expect((await hub.inspect('user/lofi')).baseModel).toEqual(['AceStep v1.5 Turbo (2B)']);
  });

  it('prefers what the repository itself declares for the base model and the license', async () => {
    fake.repos.set('user/declared', repoWith(
      { 'adapter_model.metadata.json': json(exampleSidecar(WEIGHTS_SHA, { distribution: { license: 'proprietary', source_url: null } })) },
      { cardData: { license: 'mit', base_model: 'ACE-Step/Ace-Step1.5' } },
    ));
    const card = await hub.inspect('user/declared');
    expect(card.license).toBe('mit');
    expect(card.baseModel).toEqual(['ACE-Step/Ace-Step1.5']);
  });

  it('finds the license in the order: repository, license: tag, metadata file; and says nothing when nobody declares one', async () => {
    fake.repos.set('user/tag', repoWith({}, { cardData: {}, tags: ['peft', 'license:apache-2.0'] }));
    expect((await hub.inspect('user/tag')).license).toBe('apache-2.0');
    fake.repos.set('user/side', repoWith({ 'adapter_model.metadata.json': json(exampleSidecar(WEIGHTS_SHA, { distribution: { license: 'cc-by-4.0', source_url: null } })) }, { cardData: {} }));
    expect((await hub.inspect('user/side')).license).toBe('cc-by-4.0');
    fake.repos.set('user/none', repoWith({ 'adapter_model.metadata.json': json(exampleSidecar(WEIGHTS_SHA)) }, { cardData: {} }));
    expect((await hub.inspect('user/none')).license).toBeNull(); // the real LoRA this was written from declares none anywhere
  });

  it('drops the noise tags the Hub adds, and shows only the end of a folder path written by the author', async () => {
    fake.repos.set('user/real', repoWith(
      { 'adapter_config.json': json({ peft_type: 'LORA', r: 64, lora_alpha: 128, base_model_name_or_path: '/root/checkpoints/acestep-v15-turbo' }) },
      { tags: ['peft', 'lora', 'region:us', 'acestep-2b'] },
    ));
    const card = await hub.inspect('user/real');
    expect(card.tags).toEqual(['peft', 'lora', 'acestep-2b']);
    expect(card.adapter?.baseModel).toBe('acestep-v15-turbo');
  });

  describe('is never a reason to refuse a LoRA', () => {
    const lofi = (files: Record<string, Buffer | string>) => {
      fake.repos.set('user/x', repoWith(files));
      return hub.inspect('user/x');
    };

    it('without one: no sidecar, and no warning about it', async () => {
      const card = await lofi({});
      expect(card.sidecar).toBeNull();
      expect(card.warnings).toEqual([]);
    });

    it('with one that is not JSON, or not an object', async () => {
      for (const content of ['{not json', '[1,2,3]', '"text"', '']) {
        const card = await lofi({ 'adapter_model.metadata.json': content });
        expect(card.sidecar, content).toBeNull();
        expect(card.warnings.join(' '), content).toMatch(/metadata file is not a JSON object/);
        expect(card.selected?.name).toBe('adapter_model.safetensors');
      }
    });

    it('with one that is listed but cannot be fetched', async () => {
      fake.repos.set('user/ghost', repoWith({}, {
        rawSiblings: [
          { rfilename: 'adapter_model.safetensors', size: WEIGHTS.length, lfs: { sha256: WEIGHTS_SHA, size: WEIGHTS.length } },
          { rfilename: 'adapter_config.json', size: GOOD_ADAPTER_CONFIG.length },
          { rfilename: 'adapter_model.metadata.json', size: 100 },
        ],
      }));
      const card = await hub.inspect('user/ghost');
      expect(card.sidecar).toBeNull();
      expect(card.warnings.join(' ')).toMatch(/could not be read/);
    });

    it('with one that is too large: it is not even fetched', async () => {
      fake.repos.set('user/huge', repoWith({}, {
        rawSiblings: [
          { rfilename: 'adapter_model.safetensors', size: WEIGHTS.length, lfs: { sha256: WEIGHTS_SHA, size: WEIGHTS.length } },
          { rfilename: 'adapter_config.json', size: GOOD_ADAPTER_CONFIG.length },
          { rfilename: 'adapter_model.metadata.json', size: 50 * 1024 * 1024 },
        ],
      }));
      const card = await hub.inspect('user/huge');
      expect(card.sidecar).toBeNull();
      expect(card.warnings.join(' ')).toMatch(/too large/);
      expect(fake.resolved.some((r) => r.endsWith('metadata.json'))).toBe(false);
    });

    it('and is not read at all while the caller still has to choose between weights', async () => {
      fake.repos.set('user/two', {
        files: { 'a.safetensors': WEIGHTS, 'b.safetensors': fakeWeights(9000, 2), 'adapter_config.json': GOOD_ADAPTER_CONFIG, 'a.metadata.json': json(exampleSidecar(WEIGHTS_SHA)) },
      });
      const card = await hub.inspect('user/two');
      expect(card.needsChoice).toBe(true);
      expect(card.sidecar).toBeNull();
      expect(fake.resolved.some((r) => r.endsWith('metadata.json'))).toBe(false);
    });
  });

  describe('is the author\'s word, checked against the Hub', () => {
    it('warns when its checksum is not the Hub\'s', async () => {
      fake.repos.set('user/stale', repoWith({ 'adapter_model.metadata.json': json(exampleSidecar('cd'.repeat(32))) }));
      const card = await hub.inspect('user/stale');
      expect(card.warnings.join(' ')).toMatch(/checksum differs/);
      expect(card.sidecar).not.toBeNull(); // shown, with the warning
    });

    it('warns when it describes another weights file', async () => {
      fake.repos.set('user/other', repoWith({ 'adapter_model.metadata.json': json(exampleSidecar(WEIGHTS_SHA, { files: { weights: 'something_else.safetensors', size_bytes: 1, sha256: WEIGHTS_SHA } })) }));
      expect((await hub.inspect('user/other')).warnings.join(' ')).toMatch(/another weights file/);
    });

    it('warns when it uses a newer format than the Studio knows', async () => {
      fake.repos.set('user/newer', repoWith({ 'adapter_model.metadata.json': json(exampleSidecar(WEIGHTS_SHA, { schema_version: 7 })) }));
      expect((await hub.inspect('user/newer')).warnings.join(' ')).toMatch(/newer format/);
    });

    it('does not trust its text: it is cleaned like everything else an author writes', async () => {
      fake.repos.set('user/hostile', repoWith({
        'adapter_model.metadata.json': json(exampleSidecar(WEIGHTS_SHA, {
          name: '<script>alert(1)</script>',
          inference: { primary_trigger_word: '<b>x</b>', recommended_steps: 99999, recommended_strength: 'loud' },
          distribution: { license: 'MIT', source_url: 'javascript:alert(1)' },
        })),
      }));
      const { sidecar } = await hub.inspect('user/hostile');
      expect(JSON.stringify(sidecar)).not.toMatch(/[<>]/);
      expect(sidecar?.sourceUrl).toBeNull();
      expect(sidecar?.recommended).toMatchObject({ steps: null, scale: null });
    });
  });

  describe('picks the right file', () => {
    it('the one named after the weights, among several', async () => {
      fake.repos.set('user/several', repoWith({
        'adapter_model.metadata.json': json(exampleSidecar(WEIGHTS_SHA, { name: 'Right one' })),
        'other.metadata.json': json(exampleSidecar(WEIGHTS_SHA, { name: 'Wrong one' })),
      }));
      expect((await hub.inspect('user/several')).sidecar?.name).toBe('Right one');
    });

    it('none, with a warning, when several exist and none matches', async () => {
      fake.repos.set('user/lost', repoWith({ 'x.metadata.json': json(exampleSidecar(WEIGHTS_SHA)), 'y.metadata.json': json(exampleSidecar(WEIGHTS_SHA)) }));
      const card = await hub.inspect('user/lost');
      expect(card.sidecar).toBeNull();
      expect(card.warnings.join(' ')).toMatch(/Several metadata files/);
    });

    it('the one in the folder of the weights', async () => {
      fake.repos.set('user/sub', {
        files: {
          'final/adapter_model.safetensors': WEIGHTS,
          'final/adapter_config.json': GOOD_ADAPTER_CONFIG,
          'final/adapter_model.metadata.json': json(exampleSidecar(WEIGHTS_SHA, { name: 'In final' })),
          'root.metadata.json': json(exampleSidecar(WEIGHTS_SHA, { name: 'At root' })),
        },
      });
      expect((await hub.inspect('user/sub')).sidecar?.name).toBe('In final');
    });
  });

  it('is kept next to the installed LoRA, so that the trigger word and the settings stay available', async () => {
    fake.repos.set('user/lofi', repoWith({ 'adapter_model.metadata.json': json(exampleSidecar(WEIGHTS_SHA)) }, { cardData: {} }));
    const job = await finished(hub, (await hub.startInstall('user/lofi')).id);
    expect(job.state).toBe('done');
    const provenance = JSON.parse(readFileSync(path.join(loraDir, 'lofi', 'lora_hub.json'), 'utf-8'));
    expect(provenance.sidecar).toMatchObject({ triggerWord: 'ex-l0f1', recommended: { scale: 1, steps: 8, guidance: 7, shift: 3 }, baseModelRequired: 'AceStep v1.5 Turbo (2B)' });
    expect(provenance.baseModel).toEqual(['AceStep v1.5 Turbo (2B)']);
    expect(provenance).toMatchObject({ schema: 1, repo: 'user/lofi', sha256: WEIGHTS_SHA });
  });

  it('is not a reason to fail an install either', async () => {
    fake.repos.set('user/broken', repoWith({ 'adapter_model.metadata.json': '{broken' }));
    const job = await finished(hub, (await hub.startInstall('user/broken')).id);
    expect(job.state).toBe('done');
    expect(JSON.parse(readFileSync(path.join(loraDir, 'broken', 'lora_hub.json'), 'utf-8')).sidecar).toBeNull();
  });
});
