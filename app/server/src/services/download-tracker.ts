// services/download-tracker.ts
//
// What the Studio knows about the engine's first-launch downloads, and how it knows it.
//
// The engine's standard output is the only channel the server reads (stderr, where tqdm draws its bars, is inherited
// by the terminal). While models download, the engine prints marked JSON lines on it (see acestep/download_events.py):
// `start` and `end` for each download, and `bytes` for what Hugging Face's progress bars report. This module
//   1. separates those lines from ordinary output            -> StdoutRouter
//   2. works out what the engine needs from the disk          -> buildPlan
//   3. turns events + disk into one status for the interface  -> DownloadTracker.snapshot
//
// Measured limits that shape the status (huggingface_hub 0.36.2 + hf_xet, a 337 MB file):
//   - the partial file on disk stays at 0 bytes until the download ends, so the disk cannot show progress;
//   - the byte counts arrive in bursts (nothing for 17 s, then 64 MiB, then the rest at once).
// So the status is built per COMPONENT (pending / downloading / done / failed) with elapsed time, and the byte
// counts are passed on as they come. The remaining time is a labelled estimate, never a promise.

import { existsSync, readFileSync, statfsSync } from 'fs';
import path from 'path';

export const DOWNLOAD_MARKER = '[studio-download] ';
const MAX_HELD_CHARS = 4096;

// ------------------------------------------------------------------------------------------ events --
export type DownloadEvent =
  | { event: 'start'; component: string; repo?: string }
  | { event: 'bytes'; component: string; done: number; total: number; files?: number }
  | { event: 'end'; component: string; ok: boolean; seconds?: number; error?: string };

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Decode one marked line, or null if it is not a valid event. */
export function parseEventLine(line: string): DownloadEvent | null {
  if (!line.startsWith(DOWNLOAD_MARKER)) return null;
  let raw: any;
  try {
    raw = JSON.parse(line.slice(DOWNLOAD_MARKER.length));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || typeof raw.component !== 'string' || !raw.component) return null;
  const component: string = raw.component;
  switch (raw.event) {
    case 'start':
      return { event: 'start', component, repo: typeof raw.repo === 'string' ? raw.repo : undefined };
    case 'bytes':
      if (!isCount(raw.done) || !isCount(raw.total)) return null;
      return { event: 'bytes', component, done: raw.done, total: raw.total, files: isCount(raw.files) ? raw.files : undefined };
    case 'end':
      if (typeof raw.ok !== 'boolean') return null;
      return {
        event: 'end',
        component,
        ok: raw.ok,
        seconds: isCount(raw.seconds) ? raw.seconds : undefined,
        error: typeof raw.error === 'string' ? raw.error : undefined,
      };
    default:
      return null;
  }
}

// ----------------------------------------------------------------------------------- stdout routing --
/**
 * Splits the engine's standard output into ordinary text (to display and parse as before) and download events.
 * Chunks can cut a line anywhere: an incomplete line that could still turn out to be a marked line is held back until
 * the next chunk, every other byte is passed through immediately and unchanged.
 */
export class StdoutRouter {
  private held = '';

  push(chunk: string): { passthrough: string; events: DownloadEvent[] } {
    const data = this.held + chunk;
    this.held = '';
    const events: DownloadEvent[] = [];
    let passthrough = '';
    let start = 0;
    while (start < data.length) {
      const newline = data.indexOf('\n', start);
      if (newline === -1) {
        const tail = data.slice(start);
        const couldBeMarked = tail.startsWith(DOWNLOAD_MARKER) || DOWNLOAD_MARKER.startsWith(tail);
        if (couldBeMarked && tail.length <= MAX_HELD_CHARS) this.held = tail;
        else passthrough += tail;
        break;
      }
      const line = data.slice(start, newline + 1);
      const event = parseEventLine(line.replace(/\r?\n$/, ''));
      if (event) events.push(event);
      else passthrough += line;
      start = newline + 1;
    }
    return { passthrough, events };
  }

  /** Text still held back (call when the process exits so nothing is lost). */
  flush(): string {
    const rest = this.held;
    this.held = '';
    return rest;
  }
}

// ------------------------------------------------------------------------------------------------ plan --
export type ComponentKind = 'main' | 'dit' | 'lm' | 'other';

/** Sizes in bytes (decimal, as Hugging Face displays them). `approx` = estimated or announced, not measured. */
const EXPECTED_SIZES: Record<string, { bytes: number; approx: boolean }> = {
  main: { bytes: 1_540_000_000, approx: false }, // VAE + text encoder, measured
  'acestep-v15-turbo': { bytes: 4_790_000_000, approx: false }, // measured
  'acestep-5Hz-lm-1.7B': { bytes: 3_760_000_000, approx: false }, // measured
  'acestep-5Hz-lm-0.6B': { bytes: 1_200_000_000, approx: true }, // 0.6 G parameters on 2 bytes
  'acestep-v15-xl-turbo-bf16': { bytes: 9_300_000_000, approx: true }, // announced by download_model.sh
  'acestep-v15-xl-turbo': { bytes: 18_800_000_000, approx: true }, // announced by download_model.sh
  'acestep-v15-xl-sft': { bytes: 18_800_000_000, approx: true }, // announced by download_model.sh
};

/** The weight files the engine itself looks for (acestep/model_downloader.py::_contains_model_weights). */
const WEIGHT_FILES = [
  'model.safetensors',
  'model.safetensors.index.json',
  'pytorch_model.bin',
  'pytorch_model.bin.index.json',
  'diffusion_pytorch_model.safetensors',
  'diffusion_pytorch_model.safetensors.index.json',
  'diffusion_pytorch_model.bin',
  'diffusion_pytorch_model.bin.index.json',
];
const MAIN_FOLDERS = ['vae', 'Qwen3-Embedding-0.6B'];

export function hasWeights(dir: string): boolean {
  return WEIGHT_FILES.some((file) => existsSync(path.join(dir, file)));
}

/** `marcorez8/acestep-v15-xl-turbo-bf16` -> `acestep-v15-xl-turbo-bf16` (the folder the engine uses). */
export function modelFolderName(model: string): string {
  return model.split('/').pop() || model;
}

export interface PlanInput {
  defaultModel: string;
  initLlm: boolean;
  lmModel: string;
  checkpointsDir: string;
}

export interface PlannedComponent {
  id: string;
  kind: ComponentKind;
  expectedBytes?: number;
  approx?: boolean;
  present: boolean;
}

function planned(id: string, kind: ComponentKind, present: boolean): PlannedComponent {
  const size = EXPECTED_SIZES[id];
  return { id, kind, present, expectedBytes: size?.bytes, approx: size?.approx };
}

/** What the engine needs at startup, and which parts are already on the disk. */
export function buildPlan(input: PlanInput): PlannedComponent[] {
  const dir = input.checkpointsDir;
  const plan: PlannedComponent[] = [planned('main', 'main', MAIN_FOLDERS.every((f) => hasWeights(path.join(dir, f))))];
  const dit = modelFolderName(input.defaultModel);
  plan.push(planned(dit, 'dit', hasWeights(path.join(dir, dit))));
  if (input.initLlm) {
    const lm = modelFolderName(input.lmModel);
    plan.push(planned(lm, 'lm', hasWeights(path.join(dir, lm))));
  }
  return plan;
}

// --------------------------------------------------------------------------------------------- profile --
export interface HardwareProfileSummary {
  gpuName?: string;
  vramGiB?: number;
  tier?: number;
  mode?: 'gpu' | 'cpu';
  defaultModel?: string;
  initLlm?: boolean;
  computeCapability?: string;
  generationTimeoutSec?: number;
}

/** Reads the `KEY="value"` lines install.sh writes in hardware_profile.env. Never executes anything. */
export function readHardwareProfile(file: string): HardwareProfileSummary | undefined {
  if (!existsSync(file)) return undefined;
  let text: string;
  try {
    text = readFileSync(file, 'utf-8');
  } catch {
    return undefined;
  }
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)="?([^"]*)"?\s*$/.exec(line);
    if (match) values[match[1]] = match[2];
  }
  const number = (key: string): number | undefined => {
    const n = Number(values[key]);
    return values[key] !== undefined && values[key] !== '' && Number.isFinite(n) ? n : undefined;
  };
  const mib = number('HW_VRAM_TORCH_MIB') ?? number('HW_VRAM_MIB');
  return {
    gpuName: values.HW_GPU_NAME || undefined,
    vramGiB: mib && mib > 0 ? Math.round((mib / 1024) * 100) / 100 : undefined,
    tier: number('HW_ACE_TIER'),
    mode: values.HW_MODE === 'cpu' ? 'cpu' : values.HW_MODE === 'gpu' ? 'gpu' : undefined,
    defaultModel: values.HW_DEFAULT_MODEL || undefined,
    initLlm: values.HW_INIT_LLM === undefined ? undefined : values.HW_INIT_LLM === 'true',
    computeCapability: values.HW_COMPUTE_CAP || undefined,
    generationTimeoutSec: number('HW_GENERATION_TIMEOUT'),
  };
}

// ------------------------------------------------------------------------------------------- snapshot --
export type ComponentState = 'pending' | 'downloading' | 'done' | 'failed';
export type Phase = 'downloading' | 'loading' | 'ready' | 'error';

export interface ComponentStatus {
  id: string;
  kind: ComponentKind;
  state: ComponentState;
  expectedBytes?: number;
  approx?: boolean;
  /** Bytes reported by Hugging Face's progress bars: exact but irregular (see the header of this file). */
  bytesDone?: number;
  bytesTotal?: number;
  elapsedMs?: number;
  seconds?: number;
  error?: string;
}

export interface DownloadSnapshot {
  phase: Phase;
  components: ComponentStatus[];
  elapsedMs: number;
  /** Labelled estimate (always approximate); absent when it cannot be computed honestly. */
  etaMs?: number;
  disk: { freeBytes?: number; neededBytes: number; low: boolean };
  profile?: HardwareProfileSummary;
  error?: string;
}

export interface SnapshotInput extends PlanInput {
  pipelineState: string;
  lastError?: string | null;
  profilePath?: string;
}

export interface TrackerDeps {
  now: () => number;
  freeBytes: (dir: string) => number | undefined;
}

function defaultFreeBytes(dir: string): number | undefined {
  let probe = dir;
  for (let i = 0; i < 8 && !existsSync(probe); i++) probe = path.dirname(probe);
  try {
    const stats = statfsSync(probe);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return undefined;
  }
}

const defaultDeps: TrackerDeps = { now: () => Date.now(), freeBytes: defaultFreeBytes };

interface Tracked {
  state: 'downloading' | 'done' | 'failed';
  startedAt: number;
  seconds?: number;
  bytesDone?: number;
  bytesTotal?: number;
  error?: string;
}

const DISK_SAFETY_FACTOR = 1.1;
const MIN_SECONDS_FOR_SPEED = 3;

export class DownloadTracker {
  private tracked = new Map<string, Tracked>();
  private sessionStart: number;

  constructor(private deps: TrackerDeps = defaultDeps) {
    this.sessionStart = deps.now();
  }

  /** New engine start: forget the previous session. */
  reset(): void {
    this.tracked.clear();
    this.sessionStart = this.deps.now();
  }

  ingest(event: DownloadEvent): void {
    const now = this.deps.now();
    const current = this.tracked.get(event.component);
    if (event.event === 'start') {
      this.tracked.set(event.component, { state: 'downloading', startedAt: now });
    } else if (event.event === 'bytes') {
      const entry = current ?? { state: 'downloading' as const, startedAt: now };
      entry.bytesDone = event.done;
      entry.bytesTotal = event.total;
      this.tracked.set(event.component, entry);
    } else {
      const entry = current ?? { state: 'downloading' as const, startedAt: now };
      entry.state = event.ok ? 'done' : 'failed';
      entry.seconds = event.seconds;
      entry.error = event.ok ? undefined : event.error || 'download failed';
      this.tracked.set(event.component, entry);
    }
  }

  snapshot(input: SnapshotInput): DownloadSnapshot {
    const now = this.deps.now();
    const plan = buildPlan(input);
    const known = new Set(plan.map((p) => p.id));
    const components: ComponentStatus[] = plan.map((p) => this.statusOf(p, this.tracked.get(p.id), now));
    // Something downloaded that the plan did not foresee (e.g. a language model chosen later): show it too.
    for (const [id, entry] of this.tracked) {
      if (!known.has(id)) {
        components.push(this.statusOf({ ...planned(id, 'other', false) }, entry, now));
      }
    }

    const pending = components.filter((c) => c.state === 'pending' || c.state === 'downloading');
    const failed = components.find((c) => c.state === 'failed');
    let phase: Phase;
    if (input.pipelineState === 'ready') phase = 'ready';
    else if (input.pipelineState === 'error' || failed) phase = 'error';
    else if (pending.length > 0) phase = 'downloading';
    else phase = 'loading';

    const neededBytes = pending.reduce((sum, c) => sum + (c.expectedBytes ?? 0), 0);
    const freeBytes = this.deps.freeBytes(input.checkpointsDir);
    const snapshot: DownloadSnapshot = {
      phase,
      components,
      elapsedMs: Math.max(0, now - this.sessionStart),
      disk: {
        freeBytes,
        neededBytes,
        low: freeBytes !== undefined && neededBytes > 0 && freeBytes < neededBytes * DISK_SAFETY_FACTOR,
      },
      profile: input.profilePath ? readHardwareProfile(input.profilePath) : undefined,
    };
    if (phase === 'downloading') snapshot.etaMs = this.estimateRemainingMs(components, now);
    if (phase === 'error') snapshot.error = failed?.error || input.lastError || undefined;
    return snapshot;
  }

  private statusOf(plan: PlannedComponent, entry: Tracked | undefined, now: number): ComponentStatus {
    const base: ComponentStatus = {
      id: plan.id,
      kind: plan.kind,
      state: 'pending',
      expectedBytes: plan.expectedBytes,
      approx: plan.approx,
    };
    if (entry) {
      base.bytesDone = entry.bytesDone;
      base.bytesTotal = entry.bytesTotal;
      base.seconds = entry.seconds;
    }
    if (plan.present) return { ...base, state: 'done' }; // the disk is the truth: weights exist, hence complete
    if (!entry) return base;
    if (entry.state === 'downloading') return { ...base, state: 'downloading', elapsedMs: Math.max(0, now - entry.startedAt) };
    if (entry.state === 'failed') return { ...base, state: 'failed', error: entry.error };
    return { ...base, state: 'done' };
  }

  /**
   * Remaining time, from the speed measured on the components that already finished in this session.
   * Returns undefined when it cannot be computed honestly: no finished download to measure, or a missing size.
   */
  private estimateRemainingMs(components: ComponentStatus[], now: number): number | undefined {
    let bytes = 0;
    let seconds = 0;
    for (const c of components) {
      const size = c.bytesTotal || c.expectedBytes;
      if (c.state === 'done' && c.seconds !== undefined && c.seconds >= MIN_SECONDS_FOR_SPEED && size) {
        bytes += size;
        seconds += c.seconds;
      }
    }
    if (bytes <= 0 || seconds <= 0) return undefined;
    const speed = bytes / seconds; // bytes per second
    let remaining = 0;
    for (const c of components) {
      if (c.state !== 'pending' && c.state !== 'downloading') continue;
      const size = c.expectedBytes ?? c.bytesTotal;
      if (!size) return undefined;
      if (c.state === 'downloading') {
        const elapsedSeconds = (c.elapsedMs ?? 0) / 1000;
        const done = Math.min(Math.max(c.bytesDone ?? 0, speed * elapsedSeconds), size * 0.99);
        remaining += size - done;
      } else {
        remaining += size;
      }
    }
    return remaining > 0 ? Math.round((remaining / speed) * 1000) : undefined;
  }
}
