// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  DOWNLOAD_MARKER,
  DownloadTracker,
  StdoutRouter,
  buildPlan,
  hasWeights,
  modelFolderName,
  parseEventLine,
  readHardwareProfile,
} from './download-tracker.js';

const line = (payload: object) => `${DOWNLOAD_MARKER}${JSON.stringify(payload)}`;

// ----------------------------------------------------------------------------------------- parsing --
describe('parseEventLine', () => {
  it('decodes the three event kinds', () => {
    expect(parseEventLine(line({ event: 'start', component: 'main', repo: 'r' }))).toEqual({ event: 'start', component: 'main', repo: 'r' });
    expect(parseEventLine(line({ event: 'bytes', component: 'main', done: 5, total: 10, files: 2 }))).toEqual({
      event: 'bytes', component: 'main', done: 5, total: 10, files: 2,
    });
    expect(parseEventLine(line({ event: 'end', component: 'main', ok: false, seconds: 3.5, error: 'disk full' }))).toEqual({
      event: 'end', component: 'main', ok: false, seconds: 3.5, error: 'disk full',
    });
  });

  it('rejects anything malformed', () => {
    expect(parseEventLine('Loading model: 45%')).toBeNull();
    expect(parseEventLine(`${DOWNLOAD_MARKER}not json`)).toBeNull();
    expect(parseEventLine(line({ event: 'start' }))).toBeNull();
    expect(parseEventLine(line({ event: 'start', component: '' }))).toBeNull();
    expect(parseEventLine(line({ event: 'bytes', component: 'm', done: 'x', total: 1 }))).toBeNull();
    expect(parseEventLine(line({ event: 'bytes', component: 'm', done: -1, total: 1 }))).toBeNull();
    expect(parseEventLine(line({ event: 'end', component: 'm' }))).toBeNull();
    expect(parseEventLine(line({ event: 'explode', component: 'm' }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------- routing --
describe('StdoutRouter', () => {
  it('passes ordinary text through unchanged', () => {
    const router = new StdoutRouter();
    expect(router.push('GPU Memory: 7.6 GB\nRunning on local URL: http://x\n')).toEqual({
      passthrough: 'GPU Memory: 7.6 GB\nRunning on local URL: http://x\n',
      events: [],
    });
  });

  it('removes a marked line and keeps its neighbours byte for byte', () => {
    const router = new StdoutRouter();
    const result = router.push(`before\n${line({ event: 'start', component: 'main' })}\nafter\n`);
    expect(result.passthrough).toBe('before\nafter\n');
    expect(result.events).toEqual([{ event: 'start', component: 'main', repo: undefined }]);
  });

  it('copes with a marked line cut at every possible position', () => {
    const marked = `${line({ event: 'end', component: 'main', ok: true, seconds: 12 })}\n`;
    const text = `a\n${marked}b\n`;
    for (let cut = 1; cut < text.length; cut++) {
      const router = new StdoutRouter();
      const first = router.push(text.slice(0, cut));
      const second = router.push(text.slice(cut));
      expect(first.passthrough + second.passthrough + router.flush(), `cut at ${cut}`).toBe('a\nb\n');
      expect([...first.events, ...second.events], `cut at ${cut}`).toHaveLength(1);
    }
  });

  it('does not delay an incomplete line that cannot be a marked one', () => {
    const router = new StdoutRouter();
    expect(router.push('Loading model: 4')).toEqual({ passthrough: 'Loading model: 4', events: [] });
    expect(router.push('5%\n').passthrough).toBe('5%\n');
  });

  it('holds back only what could still become a marker, then releases it', () => {
    const router = new StdoutRouter();
    expect(router.push('[').passthrough).toBe('');
    expect(router.push('INFO] hello\n').passthrough).toBe('[INFO] hello\n');
  });

  it('handles Windows line endings', () => {
    const router = new StdoutRouter();
    const result = router.push(`x\r\n${line({ event: 'start', component: 'main' })}\r\ny\r\n`);
    expect(result.passthrough).toBe('x\r\ny\r\n');
    expect(result.events).toHaveLength(1);
  });

  it('passes an invalid marked line through instead of swallowing it', () => {
    const router = new StdoutRouter();
    const bad = `${DOWNLOAD_MARKER}{oops\n`;
    expect(router.push(bad)).toEqual({ passthrough: bad, events: [] });
  });

  it('flush returns what was still held', () => {
    const router = new StdoutRouter();
    router.push('[studio-down');
    expect(router.flush()).toBe('[studio-down');
    expect(router.flush()).toBe('');
  });

  it('never holds an unbounded tail', () => {
    const router = new StdoutRouter();
    const huge = DOWNLOAD_MARKER + 'x'.repeat(10_000);
    expect(router.push(huge).passthrough).toBe(huge);
  });
});

// ------------------------------------------------------------------------------------------- plan --
describe('buildPlan and the disk', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'dl-plan-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const put = (folder: string, file = 'model.safetensors') => {
    mkdirSync(path.join(dir, folder), { recursive: true });
    writeFileSync(path.join(dir, folder, file), 'x');
  };
  const input = (over = {}) => ({ defaultModel: 'acestep-v15-turbo', initLlm: true, lmModel: 'acestep-5Hz-lm-0.6B', checkpointsDir: dir, ...over });

  it('lists the main bundle, the DiT and the language model when nothing is on disk', () => {
    const plan = buildPlan(input());
    expect(plan.map((p) => [p.id, p.kind, p.present])).toEqual([
      ['main', 'main', false], ['acestep-v15-turbo', 'dit', false], ['acestep-5Hz-lm-0.6B', 'lm', false],
    ]);
  });

  it('leaves the language model out when it is disabled', () => {
    expect(buildPlan(input({ initLlm: false })).map((p) => p.id)).toEqual(['main', 'acestep-v15-turbo']);
  });

  it('marks what is already on disk, and the main bundle needs BOTH its folders', () => {
    put('vae');
    expect(buildPlan(input())[0].present).toBe(false);
    put('Qwen3-Embedding-0.6B');
    put('acestep-v15-turbo');
    const plan = buildPlan(input());
    expect(plan.map((p) => p.present)).toEqual([true, true, false]);
  });

  it('ignores the prefix of a model name, as the engine does', () => {
    expect(modelFolderName('marcorez8/acestep-v15-xl-turbo-bf16')).toBe('acestep-v15-xl-turbo-bf16');
    put('acestep-v15-xl-turbo-bf16');
    const dit = buildPlan(input({ defaultModel: 'marcorez8/acestep-v15-xl-turbo-bf16' }))[1];
    expect(dit.id).toBe('acestep-v15-xl-turbo-bf16');
    expect(dit.present).toBe(true);
  });

  it('recognises every weight file the engine recognises', () => {
    for (const file of ['model.safetensors.index.json', 'pytorch_model.bin', 'diffusion_pytorch_model.safetensors']) {
      const folder = `f-${file}`;
      expect(hasWeights(path.join(dir, folder))).toBe(false);
      put(folder, file);
      expect(hasWeights(path.join(dir, folder))).toBe(true);
    }
    expect(hasWeights(path.join(dir, 'missing'))).toBe(false);
  });

  it('carries sizes: measured ones exact, estimated ones flagged', () => {
    const plan = buildPlan(input());
    expect(plan[1]).toMatchObject({ expectedBytes: 4_790_000_000, approx: false });
    expect(plan[2]).toMatchObject({ expectedBytes: 1_200_000_000, approx: true });
    expect(buildPlan(input({ defaultModel: 'my-custom-model' }))[1].expectedBytes).toBeUndefined();
  });
});

// ----------------------------------------------------------------------------------------- profile --
describe('readHardwareProfile', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'dl-prof-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads what install.sh writes, preferring PyTorch\'s memory measurement', () => {
    const file = path.join(dir, 'hardware_profile.env');
    writeFileSync(file, [
      '# Profil materiel', 'HW_GPU_NAME="NVIDIA GeForce GTX 1050"', 'HW_MODE="gpu"', 'HW_VRAM_MIB="2048"', 'HW_VRAM_TORCH_MIB="1996"',
      'HW_ACE_TIER="1"', 'HW_DEFAULT_MODEL="acestep-v15-turbo"', 'HW_INIT_LLM="false"', 'HW_COMPUTE_CAP="6.1"', 'HW_GENERATION_TIMEOUT=""',
    ].join('\n'));
    expect(readHardwareProfile(file)).toEqual({
      gpuName: 'NVIDIA GeForce GTX 1050', vramGiB: 1.95, tier: 1, mode: 'gpu', defaultModel: 'acestep-v15-turbo',
      initLlm: false, computeCapability: '6.1', generationTimeoutSec: undefined,
    });
  });

  it('reads the CPU mode and its time limit', () => {
    const file = path.join(dir, 'hardware_profile.env');
    writeFileSync(file, 'HW_MODE="cpu"\nHW_VRAM_MIB="0"\nHW_GENERATION_TIMEOUT="3600"\nHW_INIT_LLM="true"\n');
    expect(readHardwareProfile(file)).toMatchObject({ mode: 'cpu', vramGiB: undefined, generationTimeoutSec: 3600, initLlm: true });
  });

  it('returns undefined for a missing file and never executes anything', () => {
    expect(readHardwareProfile(path.join(dir, 'nope.env'))).toBeUndefined();
    const file = path.join(dir, 'weird.env');
    writeFileSync(file, 'HW_GPU_NAME="$(touch /tmp/should-not-exist-dl-test)"\nnot a pair\n');
    expect(readHardwareProfile(file)?.gpuName).toBe('$(touch /tmp/should-not-exist-dl-test)');
  });
});

// ---------------------------------------------------------------------------------------- snapshot --
describe('DownloadTracker.snapshot', () => {
  let dir: string;
  let clock: number;
  let free: number | undefined;
  let tracker: DownloadTracker;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'dl-snap-'));
    clock = 1_000_000;
    free = 500e9;
    tracker = new DownloadTracker({ now: () => clock, freeBytes: () => free });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const put = (folder: string) => {
    mkdirSync(path.join(dir, folder), { recursive: true });
    writeFileSync(path.join(dir, folder, 'model.safetensors'), 'x');
  };
  const input = (over: Record<string, unknown> = {}) => ({
    pipelineState: 'starting', defaultModel: 'acestep-v15-turbo', initLlm: false, lmModel: 'acestep-5Hz-lm-0.6B', checkpointsDir: dir, ...over,
  });
  const states = (s: ReturnType<DownloadTracker['snapshot']>) => Object.fromEntries(s.components.map((c) => [c.id, c.state]));

  it('announces a download as soon as something is missing, before any event', () => {
    const s = tracker.snapshot(input());
    expect(s.phase).toBe('downloading');
    expect(states(s)).toEqual({ main: 'pending', 'acestep-v15-turbo': 'pending' });
    expect(s.disk.neededBytes).toBe(1_540_000_000 + 4_790_000_000);
  });

  it('is only loading when everything is on disk, and ready once the engine says so', () => {
    put('vae'); put('Qwen3-Embedding-0.6B'); put('acestep-v15-turbo');
    expect(tracker.snapshot(input()).phase).toBe('loading');
    expect(tracker.snapshot(input({ pipelineState: 'ready' })).phase).toBe('ready');
    expect(tracker.snapshot(input({ pipelineState: 'ready' })).etaMs).toBeUndefined();
  });

  it('follows start, bytes and end events', () => {
    tracker.ingest({ event: 'start', component: 'main' });
    clock += 5_000;
    tracker.ingest({ event: 'bytes', component: 'main', done: 0, total: 1_540_000_000 });
    let s = tracker.snapshot(input());
    expect(states(s).main).toBe('downloading');
    expect(s.components[0]).toMatchObject({ elapsedMs: 5000, bytesDone: 0, bytesTotal: 1_540_000_000 });
    clock += 20_000;
    tracker.ingest({ event: 'end', component: 'main', ok: true, seconds: 25 });
    s = tracker.snapshot(input());
    expect(states(s).main).toBe('done');
    expect(s.components[0].seconds).toBe(25);
  });

  it('lets the disk win over the events: weights present means complete', () => {
    tracker.ingest({ event: 'start', component: 'acestep-v15-turbo' });
    put('acestep-v15-turbo');
    expect(states(tracker.snapshot(input()))['acestep-v15-turbo']).toBe('done');
  });

  it('turns a failed download into an error phase carrying the reason', () => {
    tracker.ingest({ event: 'start', component: 'acestep-v15-turbo' });
    tracker.ingest({ event: 'end', component: 'acestep-v15-turbo', ok: false, error: 'No space left on device' });
    const s = tracker.snapshot(input());
    expect(states(s)['acestep-v15-turbo']).toBe('failed');
    expect(s.phase).toBe('error');
    expect(s.error).toBe('No space left on device');
  });

  it('reports an engine error even without a failed download', () => {
    const s = tracker.snapshot(input({ pipelineState: 'error', lastError: 'CUDA out of memory' }));
    expect(s.phase).toBe('error');
    expect(s.error).toBe('CUDA out of memory');
  });

  it('lists a download the plan did not foresee', () => {
    tracker.ingest({ event: 'start', component: 'acestep-5Hz-lm-1.7B' });
    const extra = tracker.snapshot(input()).components.find((c) => c.id === 'acestep-5Hz-lm-1.7B');
    expect(extra).toMatchObject({ kind: 'other', state: 'downloading', expectedBytes: 3_760_000_000 });
  });

  it('forgets the previous session on reset', () => {
    tracker.ingest({ event: 'start', component: 'main' });
    clock += 9_000;
    tracker.reset();
    const s = tracker.snapshot(input());
    expect(states(s).main).toBe('pending');
    expect(s.elapsedMs).toBe(0);
  });

  describe('remaining-time estimate', () => {
    it('is absent until a download has finished and can be measured', () => {
      tracker.ingest({ event: 'start', component: 'main' });
      expect(tracker.snapshot(input()).etaMs).toBeUndefined();
    });

    it('uses the speed measured on finished downloads', () => {
      // main bundle: 1.54 GB in 121 s -> 12.7 MB/s ; then the DiT has been downloading for 100 s with no bytes seen yet
      tracker.ingest({ event: 'start', component: 'main' });
      tracker.ingest({ event: 'end', component: 'main', ok: true, seconds: 121 });
      tracker.ingest({ event: 'start', component: 'acestep-v15-turbo' });
      clock += 100_000;
      const eta = tracker.snapshot(input()).etaMs!;
      const speed = 1_540_000_000 / 121;
      const expected = ((4_790_000_000 - speed * 100) / speed) * 1000;
      expect(Math.abs(eta - expected) / expected).toBeLessThan(0.02);
    });

    it('counts a download that has not started at its full size', () => {
      tracker.ingest({ event: 'start', component: 'main' });
      tracker.ingest({ event: 'end', component: 'main', ok: true, seconds: 100 });
      const eta = tracker.snapshot(input()).etaMs!;
      const speed = 1_540_000_000 / 100;
      expect(Math.abs(eta - (4_790_000_000 / speed) * 1000)).toBeLessThan(1000);
    });

    it('is absent when a remaining download has no known size', () => {
      tracker.ingest({ event: 'start', component: 'main' });
      tracker.ingest({ event: 'end', component: 'main', ok: true, seconds: 100 });
      expect(tracker.snapshot(input({ defaultModel: 'my-custom-model' })).etaMs).toBeUndefined();
    });

    it('ignores downloads too short to give a speed', () => {
      tracker.ingest({ event: 'start', component: 'main' });
      tracker.ingest({ event: 'end', component: 'main', ok: true, seconds: 1 });
      expect(tracker.snapshot(input()).etaMs).toBeUndefined();
    });

    it('never claims to have finished the current download', () => {
      tracker.ingest({ event: 'start', component: 'main' });
      tracker.ingest({ event: 'end', component: 'main', ok: true, seconds: 100 });
      tracker.ingest({ event: 'start', component: 'acestep-v15-turbo' });
      clock += 10_000_000; // far longer than the estimate: the progress is capped, the estimate stays positive
      expect(tracker.snapshot(input()).etaMs!).toBeGreaterThan(0);
    });
  });

  describe('free disk space', () => {
    it('warns when the missing models would not fit', () => {
      free = 5e9;
      const s = tracker.snapshot(input());
      expect(s.disk).toEqual({ freeBytes: 5e9, neededBytes: 6_330_000_000, low: true });
    });

    it('keeps a safety margin', () => {
      free = 6_330_000_000 * 1.05; // enough in theory, not with a 10 % margin
      expect(tracker.snapshot(input()).disk.low).toBe(true);
      free = 6_330_000_000 * 1.2;
      expect(tracker.snapshot(input()).disk.low).toBe(false);
    });

    it('does not warn when the free space cannot be read, or when nothing is missing', () => {
      free = undefined;
      expect(tracker.snapshot(input()).disk.low).toBe(false);
      put('vae'); put('Qwen3-Embedding-0.6B'); put('acestep-v15-turbo');
      free = 1;
      expect(tracker.snapshot(input()).disk.low).toBe(false);
    });
  });
});
