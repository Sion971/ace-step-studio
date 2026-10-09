// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { applyLmSettings, lmOnDiskFrom, type LmApplyProgress } from './lmSwitch';

// The selector of the language model offered 0.6B, 1.7B and 4B, but nothing downloaded one: the engine only does it at its own start, for the default LM. A model that was
// not on the disk could not be chosen from the interface. These tests keep the order: download what is missing, then load, and say every failure.
const sse = (...events: object[]) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
const stream = (...chunks: string[]) => new Response(new ReadableStream({ start(controller) { chunks.forEach((c) => controller.enqueue(new TextEncoder().encode(c))); controller.close(); } }), { status: 200 });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function harness(handlers: { download?: () => Response | Promise<Response>; switch?: () => Response | Promise<Response> }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const progress: LmApplyProgress[] = [];
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith('/api/generate/download-model')) return (handlers.download ?? (() => stream(sse({ status: 'done' }))))();
    if (url.startsWith('/api/generate/switch-model')) return (handlers.switch ?? (() => json({ success: true })))();
    throw new Error(`unexpected ${url}`);
  }) as unknown as typeof fetch;
  const run = (lmOnDisk: readonly string[] | null, lmModel = 'acestep-5Hz-lm-1.7B') =>
    applyLmSettings({ token: 'tok', selectedModel: 'acestep-v15-base', lmModel, lmBackend: 'vllm', lmOnDisk, onProgress: (p) => progress.push(p), fetchFn });
  return { calls, progress, run, urls: () => calls.map((c) => c.url) };
}

describe('applyLmSettings', () => {
  it('loads a language model that is on the disk without downloading anything', async () => {
    const h = harness({});
    expect(await h.run(['acestep-5Hz-lm-0.6B', 'acestep-5Hz-lm-1.7B'])).toEqual({ ok: true });
    expect(h.urls()).toEqual(['/api/generate/switch-model']);
    expect(JSON.parse(h.calls[0].init!.body as string)).toEqual({ model: 'acestep-v15-base', lmModel: 'acestep-5Hz-lm-1.7B', lmBackend: 'vllm' });
    expect((h.calls[0].init!.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('downloads a missing one FIRST, with the token, then loads it', async () => {
    const h = harness({ download: () => stream(sse({ status: 'downloading' }), sse({ status: 'progress', message: ' 42%|####' }), sse({ status: 'done' })) });
    expect(await h.run(['acestep-5Hz-lm-0.6B'])).toEqual({ ok: true });
    expect(h.urls()).toEqual(['/api/generate/download-model?model=acestep-5Hz-lm-1.7B', '/api/generate/switch-model']);
    expect((h.calls[0].init!.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(h.progress).toContainEqual({ kind: 'downloading' });
    expect(h.progress).toContainEqual({ kind: 'downloading', percent: 42 });
    expect(h.progress[h.progress.length - 1]).toEqual({ kind: 'applying' });
  });

  it('downloads nothing when the server has not said what is on the disk: nothing is guessed', async () => {
    const h = harness({});
    expect(await h.run(null)).toEqual({ ok: true });
    expect(h.urls()).toEqual(['/api/generate/switch-model']);
  });

  it('reads an event cut in two by the network', async () => {
    const whole = sse({ status: 'progress', message: '77%' }) + sse({ status: 'done' });
    const h = harness({ download: () => stream(whole.slice(0, 20), whole.slice(20)) });
    expect(await h.run([])).toEqual({ ok: true });
    expect(h.progress).toContainEqual({ kind: 'downloading', percent: 77 });
  });

  it('says so when the download fails, and does not try to load a model that is not there', async () => {
    const h = harness({ download: () => stream(sse({ status: 'error', message: 'Download failed (exit 1)' })) });
    expect(await h.run([])).toEqual({ ok: false, stage: 'download' });
    expect(h.urls()).toEqual(['/api/generate/download-model?model=acestep-5Hz-lm-1.7B']);
  });

  it('does not take a stream that stops before "done" for a success', async () => {
    const h = harness({ download: () => stream(sse({ status: 'progress', message: '10%' })) });
    expect(await h.run([])).toEqual({ ok: false, stage: 'download' });
    expect(h.urls()).not.toContain('/api/generate/switch-model');
  });

  it('treats a refused download (HTTP error) and an unreachable server as download failures', async () => {
    expect(await harness({ download: () => json({ error: 'Unknown model' }, 400) }).run([])).toEqual({ ok: false, stage: 'download' });
    expect(await harness({ download: () => { throw new Error('Failed to fetch'); } }).run([])).toEqual({ ok: false, stage: 'download' });
  });

  it('gives the reason of the engine when the switch is refused, the HTTP status when there is none, and the error when the server is unreachable', async () => {
    expect(await harness({ switch: () => json({ error: 'Model switch failed: boom' }, 500) }).run(['acestep-5Hz-lm-1.7B'])).toEqual({ ok: false, stage: 'switch', reason: 'Model switch failed: boom' });
    expect(await harness({ switch: () => new Response('<html>bad gateway</html>', { status: 502 }) }).run(['acestep-5Hz-lm-1.7B'])).toEqual({ ok: false, stage: 'switch', reason: 'HTTP 502' });
    expect(await harness({ switch: () => { throw new Error('Failed to fetch'); } }).run(['acestep-5Hz-lm-1.7B'])).toEqual({ ok: false, stage: 'switch', reason: 'Failed to fetch' });
  });
});

describe('lmOnDiskFrom', () => {
  it('keeps only the language models that are on the disk', () => {
    expect(lmOnDiskFrom([{ name: 'a', is_preloaded: true }, { name: 'b', is_preloaded: false }, { name: 'c' }, null, 'x', { name: 7, is_preloaded: true }])).toEqual(['a']);
    expect(lmOnDiskFrom([])).toEqual([]);
  });
  it('is null when the server does not say (an older server): nothing is then guessed', () => {
    for (const payload of [undefined, null, 'x', {}, 3]) expect(lmOnDiskFrom(payload), String(payload)).toBeNull();
  });
});
