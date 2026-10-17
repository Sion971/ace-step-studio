// @vitest-environment node
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock the worker before the module under test imports it.
vi.mock('./ai-cover.js', () => ({
  aiCover: { generate: vi.fn(), status: vi.fn() },
}));

import { aiCover } from './ai-cover.js';
import {
  startCoverGen,
  getCoverState,
  consumeCoverState,
  awaitCoverWithTimeout,
  _resetCoverJobs,
} from './cover-jobs.js';
import { songIdToSeed } from './cover-seed.js';

const mockGenerate = vi.mocked(aiCover.generate);

const baseCfg = {
  seedMode: 'song' as const,
  prompt: 'synthwave, 80s, female vocals',
};

const fakeJpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const ok = { buffer: fakeJpegBytes, mimeType: 'image/jpeg' as const };

describe('cover-jobs state machine', () => {
  beforeEach(() => {
    _resetCoverJobs();
    mockGenerate.mockReset();
    vi.mocked(aiCover.status).mockReset().mockReturnValue({ available: true });
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    _resetCoverJobs();
    vi.restoreAllMocks();
  });

  it('returns undefined for an unknown jobId', () => {
    expect(getCoverState('nope')).toBeUndefined();
  });

  it('transitions idle → pending → ready on success', async () => {
    mockGenerate.mockResolvedValue(ok);

    const entry = startCoverGen('job-1', baseCfg);
    expect(entry.state).toBe('pending');
    expect(getCoverState('job-1')?.state).toBe('pending');

    if (entry.state === 'pending') await entry.promise;

    const after = getCoverState('job-1');
    expect(after?.state).toBe('ready');
    if (after?.state === 'ready') {
      expect(after.buffer).toEqual(fakeJpegBytes);
      expect(after.mimeType).toBe('image/jpeg');
    }
  });

  it('transitions to failed when the worker refuses (no GPU, no model…)', async () => {
    mockGenerate.mockRejectedValue(new Error('no CUDA GPU available for local covers'));

    const entry = startCoverGen('job-fail', baseCfg);
    if (entry.state === 'pending') await entry.promise;

    const after = getCoverState('job-fail');
    expect(after?.state).toBe('failed');
    if (after?.state === 'failed') expect(after.reason).toContain('no CUDA');
  });

  it('is idempotent — same jobId twice returns same entry', () => {
    mockGenerate.mockResolvedValue(ok);
    const e1 = startCoverGen('idem', baseCfg);
    const e2 = startCoverGen('idem', baseCfg);
    expect(e1).toBe(e2);
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });

  it('consume drops the entry from the map', async () => {
    mockGenerate.mockResolvedValue(ok);
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
    mockGenerate.mockResolvedValue(ok);
    const e = startCoverGen('done-fast', baseCfg);
    if (e.state === 'pending') await e.promise;

    const r = await awaitCoverWithTimeout('done-fast', 1000);
    expect(r?.state).toBe('ready');
  });

  it('awaitCoverWithTimeout returns null when timeout fires before completion', async () => {
    let resolveFn!: (v: any) => void;
    mockGenerate.mockImplementation(() => new Promise((r) => { resolveFn = r; }));

    startCoverGen('slow', baseCfg);
    const r = await awaitCoverWithTimeout('slow', 50);
    expect(r).toBeNull();

    resolveFn(ok);
  });

  it('puts the style hint first, then the interface prompt', async () => {
    mockGenerate.mockResolvedValue(ok);
    const e = startCoverGen('cfg-test', baseCfg);
    if (e.state === 'pending') await e.promise;

    const call = mockGenerate.mock.calls[0]?.[0];
    expect(call?.prompt.startsWith('album cover art, ')).toBe(true);
    expect(call?.prompt.endsWith(', synthwave, 80s, female vocals')).toBe(true);
  });

  it('cuts a very long prompt at a word, so that the style hint is never the part that is lost', async () => {
    mockGenerate.mockResolvedValue(ok);
    const e = startCoverGen('long', { ...baseCfg, prompt: 'abcdefghi '.repeat(200) });
    if (e.state === 'pending') await e.promise;

    const prompt = mockGenerate.mock.calls[0]?.[0].prompt ?? '';
    expect(prompt.length).toBeLessThan(400);
    expect(prompt.endsWith('abcdefghi')).toBe(true);
  });

  it('still works without an interface prompt', async () => {
    mockGenerate.mockResolvedValue(ok);
    const e = startCoverGen('no-prompt', { ...baseCfg, prompt: '  ' });
    if (e.state === 'pending') await e.promise;

    expect(mockGenerate.mock.calls[0]?.[0].prompt.startsWith('album cover art, ')).toBe(true);
  });

  it('two different jobIds with the same prompt get different style hints', async () => {
    mockGenerate.mockResolvedValue(ok);
    for (const id of ['job_1791000000000_abc1234', 'job_1791000001237_zzz9876']) {
      const e = startCoverGen(id, baseCfg);
      if (e.state === 'pending') await e.promise;
    }
    expect(mockGenerate.mock.calls[0]?.[0].prompt).not.toEqual(mockGenerate.mock.calls[1]?.[0].prompt);
  });

  it('derives the seed from the jobId when seedMode is song', async () => {
    mockGenerate.mockResolvedValue(ok);
    const e = startCoverGen('song-seed', baseCfg);
    if (e.state === 'pending') await e.promise;

    expect(mockGenerate.mock.calls[0]?.[0].seed).toBe(songIdToSeed('song-seed'));
  });

  it('draws a new seed when seedMode is random', async () => {
    mockGenerate.mockResolvedValue(ok);
    const e = startCoverGen('random-seed', { ...baseCfg, seedMode: 'random' });
    if (e.state === 'pending') await e.promise;

    const seed = mockGenerate.mock.calls[0]?.[0].seed;
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThanOrEqual(0);
  });

  it('consumeCoverState tombstones the jobId so a still-running gen does not resurrect the entry', async () => {
    let resolveFn!: (v: any) => void;
    mockGenerate.mockImplementation(() => new Promise((r) => { resolveFn = r; }));

    const e = startCoverGen('zombie', baseCfg);
    expect(e.state).toBe('pending');

    consumeCoverState('zombie');
    expect(getCoverState('zombie')).toBeUndefined();

    resolveFn(ok);
    if (e.state === 'pending') await e.promise;

    expect(getCoverState('zombie')).toBeUndefined();
  });

  it('startCoverGen on a tombstoned jobId returns failed without starting the model', async () => {
    consumeCoverState('tombstoned');
    mockGenerate.mockReset();

    const e = startCoverGen('tombstoned', baseCfg);
    expect(e.state).toBe('failed');
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('skips the model while the GPU is busy with audio', async () => {
    const gate = vi.fn().mockResolvedValue(false);
    const e = startCoverGen('busy', baseCfg, gate);
    if (e.state === 'pending') await e.promise;

    expect(gate).toHaveBeenCalledTimes(1);
    expect(mockGenerate).not.toHaveBeenCalled();
    const after = getCoverState('busy');
    expect(after?.state).toBe('failed');
    if (after?.state === 'failed') expect(after.reason).toMatch(/busy/i);
  });

  it('runs the model once the gate lets it through', async () => {
    mockGenerate.mockResolvedValue(ok);
    const e = startCoverGen('free', baseCfg, async () => true);
    if (e.state === 'pending') await e.promise;
    expect(getCoverState('free')?.state).toBe('ready');
  });

  it('does not wait for the GPU, nor start the model, when AI covers are unavailable (processor mode)', async () => {
    vi.mocked(aiCover.status).mockReturnValue({ available: false, reason: 'cpu-mode' });
    const gate = vi.fn().mockResolvedValue(true);
    const e = startCoverGen('cpu', baseCfg, gate);
    if (e.state === 'pending') await e.promise;

    expect(gate).not.toHaveBeenCalled();
    expect(mockGenerate).not.toHaveBeenCalled();
    const after = getCoverState('cpu');
    expect(after?.state).toBe('failed');
    if (after?.state === 'failed') expect(after.reason).toContain('cpu-mode');
  });
});
