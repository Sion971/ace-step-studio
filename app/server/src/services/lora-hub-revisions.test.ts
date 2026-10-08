// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LoraHub, LoraHubError, type InstallJob } from './lora-hub.js';
import { GOOD_ADAPTER_CONFIG, fakeWeights, sha256, startFakeHub, type FakeHub } from './lora-hub.fake.js';

// A catalog entry pins a commit, and the point of pinning is to still reach THAT version when the author has since changed the repository. That is
// only true if the revision is asked of the Hub the way the Hub understands it: at /api/models/<repo>/revision/<revision>. A "?revision=" query on
// the base address is not part of the API and gets the main branch, which would make the pin useless exactly when it is needed. The fake hub
// behaves like the real one on this point (it keeps a history, answers 404 to a revision it does not have, and does not read "?revision=").

const OLD_COMMIT = '1'.repeat(40);
const NEW_COMMIT = '2'.repeat(40);
const OLD_WEIGHTS = fakeWeights(30_000, 31);
const NEW_WEIGHTS = fakeWeights(30_000, 32);
const files = (weights: Buffer) => ({ 'adapter_model.safetensors': weights, 'adapter_config.json': GOOD_ADAPTER_CONFIG });

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

describe('a pinned revision, once the repository has moved on', () => {
  let fake: FakeHub;
  let loraDir: string;
  let hub: LoraHub;

  beforeEach(async () => {
    fake = await startFakeHub();
    loraDir = path.join(mkdtempSync(path.join(tmpdir(), 'lora-hub-revisions-')), 'lora_output');
    hub = new LoraHub({ loraDir, endpoint: fake.endpoint, stallMs: 400 });
    // the author has published a new version since the entry was checked
    fake.repos.set('user/lofi', { sha: NEW_COMMIT, files: files(NEW_WEIGHTS), history: { [OLD_COMMIT]: { files: files(OLD_WEIGHTS) } }, refs: { v1: OLD_COMMIT } });
  });
  afterEach(async () => {
    await fake.close();
    rmSync(path.dirname(loraDir), { recursive: true, force: true });
  });

  it('installs the version that was checked, not the current one', async () => {
    const job = await finished(hub, (await hub.startInstall('user/lofi', { revision: OLD_COMMIT, expectedSha256: sha256(OLD_WEIGHTS) })).id);
    expect(job.state).toBe('done');
    expect(readFileSync(path.join(loraDir, 'lofi', 'adapter_model.safetensors')).equals(OLD_WEIGHTS)).toBe(true);
    const provenance = JSON.parse(readFileSync(path.join(loraDir, 'lofi', 'lora_hub.json'), 'utf-8'));
    expect(provenance).toMatchObject({ revision: OLD_COMMIT, sha256: sha256(OLD_WEIGHTS) });
    expect(fake.resolved.every((r) => r.startsWith(OLD_COMMIT))).toBe(true);
  });

  it('asks for it at /revision/<commit>, never as a query on the base address', async () => {
    await hub.inspect('user/lofi', { revision: OLD_COMMIT });
    expect(fake.apiPaths).toEqual([`/api/models/user/lofi/revision/${OLD_COMMIT}?blobs=true`]);
  });

  it('guards the fake hub itself: like the real Hub, it does not read a "?revision=" query on the base address', async () => {
    // what the old form did, replayed by hand against the fake: the base address with ?revision= answers for the main branch
    const response = await fetch(`${fake.endpoint}/api/models/user/lofi?blobs=true&revision=${OLD_COMMIT}`);
    const body = (await response.json()) as { sha: string };
    expect(body.sha).toBe(NEW_COMMIT);
  });

  it('refuses the current version when the entry pins the old one, rather than installing it', async () => {
    await expect(hub.startInstall('user/lofi', { expectedSha256: sha256(OLD_WEIGHTS) })).rejects.toMatchObject({ code: 'catalog_checksum_mismatch' });
  });

  it('follows a branch or a tag to the commit it points at, and records that commit', async () => {
    const job = await finished(hub, (await hub.startInstall('user/lofi', { revision: 'v1' })).id);
    expect(job.state).toBe('done');
    expect(readFileSync(path.join(loraDir, 'lofi', 'adapter_model.safetensors')).equals(OLD_WEIGHTS)).toBe(true);
    expect(JSON.parse(readFileSync(path.join(loraDir, 'lofi', 'lora_hub.json'), 'utf-8')).revision).toBe(OLD_COMMIT);
  });

  it('installs the current version when no revision is given', async () => {
    const job = await finished(hub, (await hub.startInstall('user/lofi')).id);
    expect(readFileSync(path.join(loraDir, 'lofi', 'adapter_model.safetensors')).equals(NEW_WEIGHTS)).toBe(true);
    expect(JSON.parse(readFileSync(path.join(loraDir, 'lofi', 'lora_hub.json'), 'utf-8')).revision).toBe(NEW_COMMIT);
    expect(job.state).toBe('done');
  });

  it('says "not found" for a revision that does not exist, and never falls back on the current one', async () => {
    expect(await codeOf(hub.inspect('user/lofi', { revision: '0'.repeat(40) }))).toBe('not_found');
    expect(await codeOf(hub.inspect('user/lofi', { revision: 'no-such-branch' }))).toBe('not_found');
    expect(await codeOf(hub.startInstall('user/lofi', { revision: '0'.repeat(40) }))).toBe('not_found');
    await expect(hub.inspect('user/lofi', { revision: 'no-such-branch' })).rejects.toThrow(/revision "no-such-branch" was not found/);
    expect(await codeOf(hub.inspect('user/nobody', { revision: OLD_COMMIT }))).toBe('not_found'); // a missing repository is still a 404
  });

  it('reads the weights, the config and the checksum of the pinned version, not of the current one', async () => {
    const card = await hub.inspect('user/lofi', { revision: OLD_COMMIT });
    expect(card.revision).toBe(OLD_COMMIT);
    expect(card.selected?.sha256).toBe(sha256(OLD_WEIGHTS));
    expect((await hub.inspect('user/lofi')).selected?.sha256).toBe(sha256(NEW_WEIGHTS));
  });
});
