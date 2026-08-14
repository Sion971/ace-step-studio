/**
 * Cover-generation job tracker — runs Pollinations cover gen in parallel
 * with ACE-Step audio gen. Audio pipeline is NEVER blocked by image gen.
 *
 * State machine per jobId:
 *   idle (not in map)
 *     → kickoff()      ⇒ pending  (Promise inserted)
 *   pending
 *     → resolve         ⇒ ready    (CoverReady — locally defined below)
 *     → reject/timeout  ⇒ failed   (CoverFailed — locally defined below)
 *
 * The map only holds active jobs; entries are deleted by the consumer
 * (status polling) once it has either persisted the cover or decided to
 * give up. Memory is bounded by the audio-gen queue size.
 */

import { generatePollinationsCover, songIdToSeed } from './pollinations.js';
import type { PollinationsCoverConfig } from './id3-tagger.js';

export interface CoverReady {
  state: 'ready';
  buffer: Buffer;
  mimeType: 'image/jpeg' | 'image/png';
  finishedAt: number;
}
export interface CoverFailed {
  state: 'failed';
  reason: string;
  finishedAt: number;
}
export type CoverResult = CoverReady | CoverFailed;

export interface CoverPending {
  state: 'pending';
  startedAt: number;
  promise: Promise<CoverResult>;
}
export type CoverEntry = CoverPending | CoverResult;

const jobs = new Map<string, CoverEntry>();

// Tombstone set: jobIds that were consumed mid-flight. The in-flight
// Promise inside startCoverGen() checks this before its final jobs.set()
// to prevent zombie resurrection (R3-1 / R3 agent07 M7 / R2 agent01 NIT).
// Without this, consumeCoverState's jobs.delete() is undone seconds later
// when Pollinations finally responds → ~300KB Buffer leak per cancel/fail
// that accumulates unbounded over weeks.
const cancelled = new Set<string>();
const TOMBSTONE_TTL_MS = 5 * 60_000; // forget after 5 min — long enough to outlive any in-flight Pollinations call

/** Reset for tests. */
export function _resetCoverJobs(): void {
  jobs.clear();
  cancelled.clear();
}

/** Inspect current state for a jobId without consuming it. */
export function getCoverState(jobId: string): CoverEntry | undefined {
  return jobs.get(jobId);
}

/**
 * Drop the entry once consumer has handled it. Also tombstones the jobId so
 * any still-running Promise inside startCoverGen won't resurrect the entry
 * via its terminal `jobs.set(jobId, …)`.
 */
export function consumeCoverState(jobId: string): CoverEntry | undefined {
  const e = jobs.get(jobId);
  jobs.delete(jobId);
  cancelled.add(jobId);
  // Auto-evict the tombstone after the Pollinations call could not possibly
  // still be running (60s timeout + slack).
  setTimeout(() => cancelled.delete(jobId), TOMBSTONE_TTL_MS).unref?.();
  return e;
}

/**
 * Start cover gen for a jobId. Idempotent — re-calling for the same jobId
 * returns the existing entry.
 *
 * Returns the entry (caller can `await entry.promise` if desired, or just
 * fire-and-forget and check getCoverState later).
 */
export function startCoverGen(
  jobId: string,
  pol: PollinationsCoverConfig,
): CoverEntry {
  const existing = jobs.get(jobId);
  if (existing) return existing;
  // If this jobId was tombstoned (cancelled/failed), do NOT start a new gen
  // — the only callers are the status-poll guards which would otherwise
  // re-fire on every poll for a cancelled job.
  if (cancelled.has(jobId)) {
    return { state: 'failed', reason: 'cancelled', finishedAt: Date.now() };
  }

  const startedAt = Date.now();

  const promise: Promise<CoverResult> = (async () => {
    try {
      // For seedMode='song' we derive a deterministic seed from the songId
      // so a re-take produces the same cover; for 'random' we leave seed
      // undefined and Pollinations rolls its own.
      const seed = pol.seedMode === 'song' ? songIdToSeed(jobId) : undefined;

      const r = await generatePollinationsCover({
        prompt: pol.prompt,
        model: pol.model,
        width: pol.width,
        height: pol.height,
        seed,
        enhance: pol.enhance,
        nologo: pol.nologo,
        safe: pol.safe,
        apiKey: pol.apiKey || undefined,
      });
      if (!r) {
        const result: CoverFailed = {
          state: 'failed',
          reason: 'pollinations returned undefined (timeout/error)',
          finishedAt: Date.now(),
        };
        // Don't resurrect a consumed entry (job was cancelled / failed).
        if (!cancelled.has(jobId)) jobs.set(jobId, result);
        return result;
      }
      const result: CoverReady = {
        state: 'ready',
        buffer: r.buffer,
        mimeType: r.mimeType,
        finishedAt: Date.now(),
      };
      if (!cancelled.has(jobId)) jobs.set(jobId, result);
      return result;
    } catch (e: any) {
      const result: CoverFailed = {
        state: 'failed',
        reason: String(e?.message || e),
        finishedAt: Date.now(),
      };
      if (!cancelled.has(jobId)) jobs.set(jobId, result);
      return result;
    }
  })();

  const pending: CoverPending = { state: 'pending', startedAt, promise };
  jobs.set(jobId, pending);
  return pending;
}

/**
 * Wait for the cover-gen entry to resolve, or return null after `timeoutMs`.
 * Useful when the audio pipeline hits the song-INSERT step and wants to
 * attach the cover synchronously if it's already nearly done — but never
 * waste user time on a cold-path Pollinations call.
 */
export async function awaitCoverWithTimeout(
  jobId: string,
  timeoutMs: number,
): Promise<CoverResult | null> {
  const e = jobs.get(jobId);
  if (!e) return null;
  if (e.state !== 'pending') return e;

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    const winner = await Promise.race([e.promise, timeout]);
    return winner ?? null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
