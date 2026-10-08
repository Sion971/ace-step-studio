// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LoraHub } from './lora-hub.js';
import { GOOD_ADAPTER_CONFIG, fakeWeights, sha256, startFakeHub, type FakeHub } from './lora-hub.fake.js';
import { exampleSidecar } from './lora-sidecar.fixtures.js';
import { describeModel, requiredBase } from './lora-compat.js';
import { CATALOG_SCHEMA, MAX_ENTRIES, catalogEntryFromCard, loadCatalogFile, parseCatalog, type CatalogEntry } from './lora-catalog.js';

const SHA = 'cd'.repeat(32);
const COMMIT = '497b97b7e8548d916366ee534551413d32d0fbd0';
const entry = (over: Record<string, unknown> = {}) => ({ id: 'my-lora', repo: 'user/my-lora', name: 'My LoRA', ...over });
const catalog = (entries: unknown[], schema: unknown = CATALOG_SCHEMA) => JSON.stringify({ schema, entries });
const parse = (...entries: unknown[]) => parseCatalog(catalog(entries));

describe('parseCatalog', () => {
  it('reads a complete entry', () => {
    const { entries, problems } = parse(entry({
      file: 'my-lora.safetensors', revision: COMMIT, sha256: SHA, description: 'A style.', author: 'Someone', license: 'cc-by-4.0', baseModel: 'AceStep v1.5 Turbo (2B)',
      genre: 'lo-fi', tags: ['a', 'b'], triggerWord: 'trig', recommended: { scale: 1, steps: 8, guidance: 7, shift: 3 }, sizeBytes: 88130248,
      verified: { date: '2026-10-07', note: 'Checked.' },
    }));
    expect(problems).toEqual([]);
    expect(entries).toEqual([{
      id: 'my-lora', repo: 'user/my-lora', file: 'my-lora.safetensors', revision: COMMIT, sha256: SHA, name: 'My LoRA', description: 'A style.', author: 'Someone',
      license: 'cc-by-4.0', baseModel: 'AceStep v1.5 Turbo (2B)', genre: 'lo-fi', tags: ['a', 'b'], triggerWord: 'trig',
      recommended: { scale: 1, steps: 8, guidance: 7, shift: 3 }, sizeBytes: 88130248, verified: { date: '2026-10-07', note: 'Checked.' },
    }]);
  });

  it('needs very little, and everything else is null', () => {
    const { entries } = parse(entry());
    expect(entries[0]).toMatchObject({ file: null, revision: null, sha256: null, description: null, license: null, baseModel: null, triggerWord: null, verified: null, tags: [], sizeBytes: null });
    expect(entries[0].recommended).toEqual({ scale: null, steps: null, guidance: null, shift: null });
  });

  it('drops fields it does not know, instead of passing them on', () => {
    const { entries } = parse(entry({ downloadUrl: 'https://evil.example/x', script: '<script>', __proto__: { polluted: true } }));
    expect(Object.keys(entries[0]).sort()).toEqual(['author', 'baseModel', 'description', 'file', 'genre', 'id', 'license', 'name', 'recommended', 'repo', 'revision', 'sha256', 'sizeBytes', 'tags', 'triggerWord', 'verified']);
  });

  it('skips and reports an entry that is not valid, without letting the others down', () => {
    const cases: [string, unknown][] = [
      ['id must be', entry({ id: 'Has Space' })],
      ['id must be', entry({ id: '' })],
      ['id must be', entry({ id: '../x' })],
      ['id must be', entry({ id: 'x'.repeat(65) })],
      ['id must be', entry({ id: 5 })],
      ['repo must be', entry({ repo: 5 })],
      ['not a link', entry({ repo: 'https://huggingface.co/user/my-lora' })],
      ['not a valid', entry({ repo: 'user/my-lora/tree/main' })],
      ['not a valid', entry({ repo: 'nobody' })],
      ['not a valid', entry({ repo: '../../etc' })],
      ['file must be', entry({ file: '../../etc/passwd.safetensors' })],
      ['file must be', entry({ file: '/abs.safetensors' })],
      ['file must be', entry({ file: 'adapter_config.json' })],
      ['file must be', entry({ file: 'model.bin' })],
      ['file must be', entry({ file: 5 })],
      ['revision must be a commit', entry({ revision: 'main' })],
      ['revision must be a commit', entry({ revision: 'abc' })],
      ['revision must be a commit', entry({ revision: 'ABCDEF1234567' })],
      ['sha256 must be', entry({ sha256: 'nope' })],
      ['sha256 must be', entry({ sha256: 5 })],
      ['name is required', entry({ name: '' })],
      ['name is required', entry({ name: '   ' })],
      ['name is required', entry({ name: undefined })],
      ['verified must be', entry({ verified: { date: 'yesterday' } })],
      ['verified must be', entry({ verified: 'yes' })],
      ['it is not an object', 'a string'],
      ['it is not an object', null],
      ['it is not an object', [1, 2]],
    ];
    for (const [expected, bad] of cases) {
      const { entries, problems } = parse(entry({ id: 'good', repo: 'user/good' }), bad, entry({ id: 'also-good', repo: 'user/also-good' }));
      expect(entries.map((e) => e.id), JSON.stringify(bad)).toEqual(['good', 'also-good']);
      expect(problems, JSON.stringify(bad)).toHaveLength(1);
      expect(problems[0], JSON.stringify(bad)).toContain(expected);
      expect(problems[0]).toMatch(/^entries\[1\]/);
    }
  });

  it('puts bad numbers to null rather than refusing the entry: they are advice, not identity', () => {
    const { entries, problems } = parse(entry({ recommended: { scale: 99, steps: 1e9, guidance: -1, shift: 'x' }, sizeBytes: -5 }));
    expect(problems).toEqual([]);
    expect(entries[0].recommended).toEqual({ scale: null, steps: null, guidance: null, shift: null });
    expect(entries[0].sizeBytes).toBeNull();
  });

  it('cleans the text, which anyone may have written', () => {
    const { entries } = parse(entry({ name: '<b>Loud</b>\u0007', description: `<img src=x onerror=1>${'x'.repeat(900)}`, tags: ['ok', '<x>', 3], triggerWord: 'a\nb' }));
    expect(JSON.stringify(entries[0])).not.toMatch(/[<>\u0007]/);
    expect(entries[0].description!.length).toBeLessThanOrEqual(400);
    expect(entries[0].triggerWord).toBe('a b');
  });

  it('refuses a second entry with the same id, or for the same weights', () => {
    const dupId = parse(entry({ id: 'a', repo: 'user/one' }), entry({ id: 'a', repo: 'user/two' }));
    expect(dupId.entries.map((e) => e.repo)).toEqual(['user/one']);
    expect(dupId.problems[0]).toMatch(/id is already used/);
    const dupWeights = parse(entry({ id: 'a', repo: 'user/one', file: 'x.safetensors' }), entry({ id: 'b', repo: 'user/one', file: 'x.safetensors' }));
    expect(dupWeights.entries).toHaveLength(1);
    expect(dupWeights.problems[0]).toMatch(/same weights/);
    expect(parse(entry({ id: 'a', repo: 'user/one', file: 'x.safetensors' }), entry({ id: 'b', repo: 'user/one', file: 'y.safetensors' })).entries).toHaveLength(2);
  });

  it('is limited in size, and says so', () => {
    const many = Array.from({ length: MAX_ENTRIES + 5 }, (_, i) => entry({ id: `lora-${i}`, repo: `user/lora-${i}` }));
    const { entries, problems } = parseCatalog(catalog(many));
    expect(entries).toHaveLength(MAX_ENTRIES);
    expect(problems.join(' ')).toMatch(/limited to 500/);
  });

  it('refuses a file that is not a catalog, with one line saying why', () => {
    for (const [text, expected] of [['{not json', /not valid JSON/], ['', /not valid JSON/], ['[1]', /"schema"/], [catalog([], 2), /"schema"/], [JSON.stringify({ schema: 1 }), /"entries"/], [JSON.stringify({ schema: 1, entries: {} }), /"entries"/]] as const) {
      const parsed = parseCatalog(text);
      expect(parsed.entries, text).toEqual([]);
      expect(parsed.problems, text).toHaveLength(1);
      expect(parsed.problems[0], text).toMatch(expected);
    }
  });

  it('survives a catalog file that is missing', () => {
    expect(loadCatalogFile('/nonexistent/lora-catalog.json')).toEqual({ entries: [], problems: ['The catalog file could not be read.'] });
  });
});

describe('catalogEntryFromCard', () => {
  let fake: FakeHub;
  let dir: string;
  beforeEach(async () => {
    fake = await startFakeHub();
    dir = mkdtempSync(path.join(tmpdir(), 'lora-catalog-'));
  });
  afterEach(async () => {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const WEIGHTS = fakeWeights(30_000, 4);

  it('writes an entry that the catalog then accepts as it is, pinned to what was seen', async () => {
    fake.repos.set('Some-Author/Lo-Fi_Example', {
      files: { 'adapter_model.safetensors': WEIGHTS, 'adapter_config.json': GOOD_ADAPTER_CONFIG, 'adapter_model.metadata.json': JSON.stringify(exampleSidecar(sha256(WEIGHTS), { distribution: { license: 'cc-by-4.0', source_url: null } })) },
      cardData: {},
    });
    const card = await new LoraHub({ loraDir: dir, endpoint: fake.endpoint }).inspect('Some-Author/Lo-Fi_Example');
    const proposed = catalogEntryFromCard(card) as CatalogEntry;
    expect(proposed).toMatchObject({
      id: 'lo-fi_example', repo: 'Some-Author/Lo-Fi_Example', file: 'adapter_model.safetensors', revision: card.revision, sha256: sha256(WEIGHTS), name: 'Example Lo-Fi',
      author: 'Example Author', license: 'cc-by-4.0', baseModel: 'AceStep v1.5 Turbo (2B)', genre: 'lo-fi', triggerWord: 'ex-l0f1', sizeBytes: WEIGHTS.length, verified: null,
      recommended: { scale: 1, steps: 8, guidance: 7, shift: 3 },
    });
    const round = parseCatalog(JSON.stringify({ schema: 1, entries: [proposed] }));
    expect(round.problems).toEqual([]);
    expect(round.entries).toEqual([proposed]);
  });

  it('has something to say even about a LoRA that comes with nothing', async () => {
    fake.repos.set('user/bare', { files: { 'adapter_model.safetensors': WEIGHTS, 'adapter_config.json': GOOD_ADAPTER_CONFIG }, cardData: {} });
    const proposed = catalogEntryFromCard(await new LoraHub({ loraDir: dir, endpoint: fake.endpoint }).inspect('user/bare')) as CatalogEntry;
    expect(proposed).toMatchObject({ id: 'bare', name: 'bare', author: 'user', license: null, triggerWord: null, baseModel: 'ACE-Step/Ace-Step1.5' });
    expect(parseCatalog(JSON.stringify({ schema: 1, entries: [proposed] })).entries).toEqual([proposed]);
  });

  it('writes nothing while the weights are still to be chosen', async () => {
    fake.repos.set('user/two', { files: { 'a.safetensors': WEIGHTS, 'b.safetensors': fakeWeights(9000, 2), 'adapter_config.json': GOOD_ADAPTER_CONFIG } });
    expect(catalogEntryFromCard(await new LoraHub({ loraDir: dir, endpoint: fake.endpoint }).inspect('user/two'))).toBeNull();
  });
});

describe('the catalog that ships with the Studio', () => {
  const shipped = loadCatalogFile(path.resolve(__dirname, '../../catalog/lora-catalog.json'));

  it('is valid, and not empty', () => {
    expect(shipped.problems).toEqual([]);
    expect(shipped.entries.length).toBeGreaterThan(0);
  });

  it('pins everything it promises: the commit and the checksum of the weights', () => {
    for (const e of shipped.entries) {
      expect(e.revision, `${e.id}: revision`).not.toBeNull();
      expect(e.sha256, `${e.id}: sha256`).not.toBeNull();
      expect(e.file, `${e.id}: file`).not.toBeNull();
    }
  });

  it('says which base model each LoRA needs, in words that the compatibility check can read', () => {
    for (const e of shipped.entries) {
      const required = requiredBase({ baseModel: e.baseModel ? [e.baseModel] : [], tags: [], adapter: null, sidecar: null });
      expect(required, `${e.id}: baseModel "${e.baseModel}"`).not.toBeNull();
      expect(required?.family, `${e.id}: family`).not.toBeNull();
      expect(required?.size, `${e.id}: size`).not.toBeNull();
      expect(describeModel(e.baseModel).size).toBe(required?.size);
    }
  });

  it('has no entry that claims to have been checked without saying when', () => {
    for (const e of shipped.entries) if (e.verified) expect(e.verified.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
