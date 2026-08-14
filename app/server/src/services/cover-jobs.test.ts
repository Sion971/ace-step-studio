// @vitest-environment node
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock the network call before the module under test imports it.
vi.mock('./pollinations.js', () => ({
  generatePollinationsCover: vi.fn(),
  songIdToSeed: (id: string) => id.charCodeAt(0) % 1000,
}));

import { generatePollinationsCover } from './pollinations.js';
import {
  startCoverGen,
  getCoverState,
  consumeCoverState,
  awaitCoverWithTimeout,
  _resetCoverJobs,
} from './cover-jobs.js';

const mockGenerate = vi.mocked(generatePollinationsCover);

const baseCfg = {
  enabled: true,
  apiKey: 'sk_test',
  model: 'zimage',
  width: 1024,
  height: 1024,
  seedMode: 'song' as const,
  enhance: true,
  nologo: true,
  safe: true,
  prompt: 'square album cover',
};

const fakeJpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

describe('cover-jobs state machine', () => {
  beforeEach(() => {
    _resetCoverJobs();
    mockGenerate.mockReset();
  });

  afterEach(() => {
    _resetCoverJobs();
  });

  it('returns undefined for an unknown jobId', () => {
    expect(getCoverState('nope')).toBeUndefined();
  });

  it('transitions idle → pending → ready on success', async () => {
    mockGenerate.mockResolvedValue({ buffer: fakeJpegBytes, mimeType: 'image/jpeg' });

    const entry = startCoverGen('job-1', baseCfg);
    expect(entry.state).toBe('pending');
    expect(getCoverState('job-1')?.state).toBe('pending');

    // Wait for the inner promise
    if (entry.state === 'pending') await entry.promise;

    const after = getCoverState('job-1');
    expect(after?.state).toBe('ready');
    if (after?.state === 'ready') {
      expect(after.buffer).toEqual(fakeJpegBytes);
      expect(after.mimeType).toBe('image/jpeg');
    }
  });

  it('transitions to failed on undefined response', async () => {
    mockGenerate.mockResolvedValue(undefined);

    const entry = startCoverGen('job-fail', baseCfg);
    if (entry.state === 'pending') await entry.promise;

    const after = getCoverState('job-fail');
    expect(after?.state).toBe('failed');
    if (after?.state === 'failed') {
      expect(after.reason).toMatch(/timeout|undefined/i);
    }
  });

  it('transitions to failed on thrown error', async () => {
    mockGenerate.mockRejectedValue(new Error('network down'));

    const entry = startCoverGen('job-err', baseCfg);
    if (entry.state === 'pending') await entry.promise;

    const after = getCoverState('job-err');
    expect(after?.state).toBe('failed');
    if (after?.state === 'failed') expect(after.reason).toContain('network down');
  });

  it('is idempotent — same jobId twice returns same entry', () => {
    mockGenerate.mockResolvedValue({ buffer: fakeJpegBytes, mimeType: 'image/jpeg' });
    const e1 = startCoverGen('idem', baseCfg);
    const e2 = startCoverGen('idem', baseCfg);
    expect(e1).toBe(e2);
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });

  it('consume drops the entry from the map', async () => {
    mockGenerate.mockResolvedValue({ buffer: fakeJpegBytes, mimeType: 'image/jpeg' });
    const entry = startCoverGen('consume-test', baseCfg);
    if (entry.state === 'pending') await entry.promise;

    const consumed = consumeCoverState('consume-test');
    expect(consumed?.state).toBe('ready');
    expect(getCoverState('consume-test')).toBeUndefined();
  });

  it('awaitCoverWithTimeout returns null when not in map', async () => {
    expect(await awaitCoverWithTimeout('missing', 100)).toBeNull();
  });

  it('awaitCoverWithTimeout returns the entry if already resolved', async () => {
    mockGenerate.mockResolvedValue({ buffer: fakeJpegBytes, mimeType: 'image/jpeg' });
    const e = startCoverGen('done-fast', baseCfg);
    if (e.state === 'pending') await e.promise;

    const r = await awaitCoverWithTimeout('done-fast', 1000);
    expect(r?.state).toBe('ready');
  });

  it('awaitCoverWithTimeout returns null when timeout fires before completion', async () => {
    let resolveFn!: (v: any) => void;
    mockGenerate.mockImplementation(
      () => new Promise(r => { resolveFn = r; })
    );

    startCoverGen('slow', baseCfg);
    const r = await awaitCoverWithTimeout('slow', 50);
    expect(r).toBeNull();

    // Cleanup: resolve the dangling promise so vitest doesn't hang
    resolveFn({ buffer: fakeJpegBytes, mimeType: 'image/jpeg' });
  });

  it('passes pollinations config through to the gen call (with style modifier appended)', async () => {
    mockGenerate.mockResolvedValue({ buffer: fakeJpegBytes, mimeType: 'image/jpeg' });
    const e = startCoverGen('cfg-test', { ...baseCfg, model: 'flux', width: 768, height: 768 });
    if (e.state === 'pending') await e.promise;

    expect(mockGenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'flux',
        width: 768,
        height: 768,
        apiKey: 'sk_test',
      })
    );
    // Original prompt is preserved as a prefix; per-job style modifier
    // appended for visual diversity (see STYLE_MODIFIERS in cover-jobs.ts).
    const call = mockGenerate.mock.calls[0]?.[0];
    expect(call?.prompt.startsWith('square album cover, ')).toBe(true);
    expect(call?.prompt.length).toBeGreaterThan('square album cover, '.length);
  });

  it('two different jobIds with the same prompt get different style modifiers', async () => {
    mockGenerate.mockResolvedValue({ buffer: fakeJpegBytes, mimeType: 'image/jpeg' });
    const a = startCoverGen('aaa', baseCfg);
    if (a.state === 'pending') await a.promise;
    const b = startCoverGen('bbb', baseCfg);
    if (b.state === 'pending') await b.promise;

    const callA = mockGenerate.mock.calls[0]?.[0];
    const callB = mockGenerate.mock.calls[1]?.[0];
    // Different jobIds → different songIdToSeed → different modifier index.
    // (Mock songIdToSeed in the test uses charCodeAt(0) % 1000, so 'a'=97, 'b'=98 → different mod 16.)
    expect(callA?.prompt).not.toEqual(callB?.prompt);
  });

  it('omits seed when seedMode is random', async () => {
    mockGenerate.mockResolvedValue({ buffer: fakeJpegBytes, mimeType: 'image/jpeg' });
    const e = startCoverGen('random-seed', { ...baseCfg, seedMode: 'random' });
    if (e.state === 'pending') await e.promise;

    const call = mockGenerate.mock.calls[0]?.[0];
    expect(call?.seed).toBeUndefined();
  });

  it('consumeCoverState tombstones the jobId so a still-running gen does not resurrect the entry', async () => {
    let resolveFn!: (v: any) => void;
    mockGenerate.mockImplementation(() => new Promise((r) => { resolveFn = r; }));

    const e = startCoverGen('zombie', baseCfg);
    expect(e.state).toBe('pending');
    expect(getCoverState('zombie')?.state).toBe('pending');

    // User cancels mid-flight
    consumeCoverState('zombie');
    expect(getCoverState('zombie')).toBeUndefined();

    // Now the in-flight Pollinations call returns
    resolveFn({ buffer: fakeJpegBytes, mimeType: 'image/jpeg' });
    if (e.state === 'pending') await e.promise;

    // Entry should NOT be resurrected
    expect(getCoverState('zombie')).toBeUndefined();
  });

  it('startCoverGen on a tombstoned jobId returns failed without firing the network call', async () => {
    consumeCoverState('tombstoned'); // tombstone w/o ever starting
    mockGenerate.mockReset();

    const e = startCoverGen('tombstoned', baseCfg);
    expect(e.state).toBe('failed');
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('derives seed from jobId when seedMode is song', async () => {
    mockGenerate.mockResolvedValue({ buffer: fakeJpegBytes, mimeType: 'image/jpeg' });
    const e = startCoverGen('song-seed', baseCfg);
    if (e.state === 'pending') await e.promise;

    const call = mockGenerate.mock.calls[0]?.[0];
    // Mock songIdToSeed returns charCodeAt(0) % 1000 = 's'.charCodeAt(0) % 1000 = 115
    expect(call?.seed).toBe(115);
  });
});
