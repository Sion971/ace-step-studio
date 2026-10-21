/**
 * Local AI covers: SDXL Turbo, run by scripts/cover_worker.py (see the header of that file for the line protocol).
 *
 * The worker is started on the first request, serves the next ones from the same loaded model, and is stopped after a few
 * idle minutes so that it does not keep VRAM from the audio engine. Requests are served one at a time.
 *
 * There is no AI cover in processor mode (no GPU) or when the worker cannot start (no diffusers, no CUDA, download failed):
 * `status()` says so, `generate()` throws an AiCoverError, and callers keep the default gradient cover. A start failure is
 * remembered for a few minutes so that every song does not retry (and re-log) it.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';
import { config } from '../config/index.js';
import { isCpuMode, coversBlockedBySmallCard } from './hardware-mode.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Idle delay of the cover worker, in ms. `ACESTEP_COVER_IDLE_S` (seconds, at least 5) overrides the default of 3 minutes: the
 * worker keeps about 9 GB of RAM while it is loaded, so a PC short of RAM can free it sooner (the next cover then reloads it).
 */
export function coverIdleMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const seconds = Number(env.ACESTEP_COVER_IDLE_S);
  return Number.isFinite(seconds) && seconds >= 5 ? Math.round(seconds * 1000) : 180_000;
}

export type AiCoverUnavailable = 'disabled' | 'cpu-mode' | 'small-gpu' | 'unavailable' | 'failed';

export class AiCoverError extends Error {
  constructor(public readonly code: AiCoverUnavailable, message: string) {
    super(message);
    this.name = 'AiCoverError';
  }
}

export interface AiCoverStatus {
  available: boolean;
  reason?: AiCoverUnavailable;
  detail?: string;
}

export interface AiCoverRequest {
  prompt: string;
  seed: number;
  size?: number;
  steps?: number;
}

export interface AiCoverResult {
  buffer: Buffer;
  mimeType: 'image/jpeg' | 'image/png';
}

export interface WorkerCommand {
  command: string;
  args: string[];
}

export interface AiCoverOptions {
  /** How to start the worker, or null when it cannot be (no Python, no script). */
  command: () => WorkerCommand | null;
  isCpuMode: () => boolean;
  /** Small card (stream mode, under 6 GiB): the card is busy with the music model and too small for the image model. */
  isSmallGpu?: () => boolean;
  /** Stop the worker after this long without a request (frees VRAM). */
  idleMs?: number;
  /** Budget for a request that has to load the model (first use includes a ~7 GB download). */
  loadTimeoutMs?: number;
  /** Budget for a request once the model is loaded. */
  runTimeoutMs?: number;
  /** After a start failure, do not try again for this long. */
  retryAfterMs?: number;
}

interface Pending {
  resolve: (r: AiCoverResult) => void;
  reject: (e: Error) => void;
  timer?: NodeJS.Timeout;
}

export class AiCoverEngine {
  private worker: ChildProcessWithoutNullStreams | null = null;
  private ready = false;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private tail: Promise<unknown> = Promise.resolve();
  private idleTimer?: NodeJS.Timeout;
  private failure: { at: number; detail: string } | null = null;
  private readonly idleMs: number;
  private readonly loadTimeoutMs: number;
  private readonly runTimeoutMs: number;
  private readonly retryAfterMs: number;

  constructor(private readonly opts: AiCoverOptions) {
    this.idleMs = opts.idleMs ?? coverIdleMsFromEnv();
    this.loadTimeoutMs = opts.loadTimeoutMs ?? 45 * 60_000;
    this.runTimeoutMs = opts.runTimeoutMs ?? 180_000;
    this.retryAfterMs = opts.retryAfterMs ?? 5 * 60_000;
  }

  status(): AiCoverStatus {
    if (process.env.COVER_AI === 'off') return { available: false, reason: 'disabled' };
    if (this.opts.isCpuMode()) return { available: false, reason: 'cpu-mode' };
    if (this.opts.isSmallGpu?.()) return { available: false, reason: 'small-gpu' };
    if (!this.opts.command()) return { available: false, reason: 'unavailable', detail: 'Python or cover_worker.py not found' };
    if (this.failure && Date.now() - this.failure.at < this.retryAfterMs) {
      return { available: false, reason: 'unavailable', detail: this.failure.detail };
    }
    return { available: true };
  }

  generate(req: AiCoverRequest): Promise<AiCoverResult> {
    const run = this.tail.then(() => this.runOne(req));
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** Stops the worker now (server shutdown, tests). */
  shutdown(): void {
    clearTimeout(this.idleTimer);
    const worker = this.worker;
    this.worker = null;
    this.ready = false;
    worker?.kill();
  }

  private async runOne(req: AiCoverRequest): Promise<AiCoverResult> {
    const st = this.status();
    if (!st.available) throw new AiCoverError(st.reason ?? 'unavailable', st.detail ?? String(st.reason));
    clearTimeout(this.idleTimer);
    const worker = this.ensureWorker();
    const id = this.nextId++;
    try {
      return await new Promise<AiCoverResult>((resolve, reject) => {
        const entry: Pending = { resolve, reject };
        this.arm(id, entry, this.ready ? this.runTimeoutMs : this.loadTimeoutMs);
        this.pending.set(id, entry);
        worker.stdin.write(JSON.stringify({ id, prompt: req.prompt, seed: req.seed, size: req.size ?? 512, steps: req.steps ?? 4 }) + '\n');
      });
    } catch (e: any) {
      if (!(e instanceof AiCoverError)) throw new AiCoverError('failed', String(e?.message || e));
      throw e;
    } finally {
      this.idleTimer = setTimeout(() => this.shutdown(), this.idleMs);
      this.idleTimer.unref?.();
    }
  }

  private arm(id: number, entry: Pending, ms: number): void {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      this.pending.delete(id);
      entry.reject(new AiCoverError('failed', `no answer from the cover worker after ${Math.round(ms / 1000)} s`));
      this.shutdown();
    }, ms);
    entry.timer.unref?.();
  }

  private ensureWorker(): ChildProcessWithoutNullStreams {
    if (this.worker) return this.worker;
    const cmd = this.opts.command();
    if (!cmd) throw new AiCoverError('unavailable', 'cover worker not found');
    console.log('[cover-ai] starting the local cover worker');
    const child = spawn(cmd.command, cmd.args, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    this.worker = child;
    this.ready = false;

    createInterface({ input: child.stdout }).on('line', (line) => this.onLine(line));
    createInterface({ input: child.stderr }).on('line', (line) => {
      if (line.trim()) console.log(`[cover-ai] ${line}`);
    });
    child.stdin.on('error', () => undefined);
    child.on('error', (err) => this.onExit(child, `could not start: ${err.message}`));
    child.on('exit', (code, signal) => this.onExit(child, `worker exited (${signal ?? code})`));
    return child;
  }

  private onLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.event === 'ready') {
      this.ready = true;
      this.failure = null;
      for (const [id, entry] of this.pending) this.arm(id, entry, this.runTimeoutMs);
      return;
    }
    if (msg.id === undefined || msg.id === null) return;
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(msg.id);
    if (msg.ok && typeof msg.data === 'string') {
      entry.resolve({ buffer: Buffer.from(msg.data, 'base64'), mimeType: msg.mime === 'image/png' ? 'image/png' : 'image/jpeg' });
      return;
    }
    const detail = String(msg.error || 'generation failed');
    // An error before the model was ready is a start failure (no CUDA, missing package, download): remember it.
    if (!this.ready) this.failure = { at: Date.now(), detail };
    entry.reject(new AiCoverError(this.ready ? 'failed' : 'unavailable', detail));
  }

  private onExit(child: ChildProcessWithoutNullStreams, detail: string): void {
    if (this.worker !== child) return;
    if (!this.ready && !this.failure) this.failure = { at: Date.now(), detail };
    this.worker = null;
    this.ready = false;
    clearTimeout(this.idleTimer);
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new AiCoverError('failed', detail));
      this.pending.delete(id);
    }
  }
}

function defaultCommand(): WorkerCommand | null {
  const script = path.join(__dirname, '../../scripts/cover_worker.py');
  const python = config.pipeline.pythonPath;
  if (!existsSync(python) || !existsSync(script)) return null;
  return { command: python, args: [script] };
}

export const aiCover = new AiCoverEngine({ command: defaultCommand, isCpuMode, isSmallGpu: coversBlockedBySmallCard });
