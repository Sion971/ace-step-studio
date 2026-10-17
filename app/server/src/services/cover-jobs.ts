/**
 * Cover-generation job tracker — runs the local AI cover (SDXL Turbo, see ai-cover.ts) in the background once the audio
 * is done. Audio pipeline is NEVER blocked by image gen.
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

import { aiCover } from './ai-cover.js';
import { songIdToSeed } from './cover-seed.js';

/** What the interface asks for when "AI cover" is on: the prompt it built, and whether a retake reuses the same seed. */
export interface CoverGenConfig {
  prompt: string;
  seedMode: 'song' | 'random';
}

/** CLIP reads about 77 tokens: a longer prompt is cut anyway, so keep it short and put the style first. */
const MAX_PROMPT_CHARS = 240;

/** At most `max` characters, never cutting a word in half. */
function clipAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const cut = head.lastIndexOf(' ');
  return (cut > 0 ? head.slice(0, cut) : head).replace(/[\s,.;:]+$/, '');
}

/**
 * Asked before the model is used: false means the GPU is busy with an audio generation, and the cover is skipped (the
 * default gradient stays) rather than competing with the audio engine for VRAM.
 */
export type CoverGate = () => Promise<boolean>;

/**
 * Sixteen art-style hints appended to every cover prompt, so that songs sharing a caption do not all get the same
 * look. The frontend prompt (buildCoverPrompt) is stable per song; this is the per-job variety dial. Purely visual
 * descriptions: no artist or brand names, no text.
 */
export const STYLE_MODIFIERS: readonly string[] = [
  'oil painting, thick impasto brushstrokes, rich color',
  'soft watercolor wash, bleeding pigments, textured paper',
  'risograph print, two-color overprint, grainy halftone',
  'vaporwave aesthetic, neon gradients, retro grid horizon',
  'minimalist flat vector illustration, bold shapes, limited palette',
  'linocut woodblock print, high-contrast ink, carved texture',
  'cinematic photograph, shallow depth of field, dramatic lighting',
  'analog film photo, heavy grain, faded colors, light leaks',
  'paper collage, layered cut-out shapes, mixed textures',
  'art deco geometry, gold linework, symmetrical composition',
  'gouache illustration, flat pastel colors, hand-painted look',
  'surreal dreamscape, impossible architecture, soft glow',
  'low-poly 3D render, faceted shapes, clean studio lighting',
  '1970s psychedelic art, swirling organic patterns, saturated colors',
  'charcoal and chalk drawing, smudged shadows, textured paper',
  'stained glass, luminous jewel colors, bold black leading',
];

/**
 * Style hint for a job. ALWAYS keyed off the job id, independent of seedMode: a new job (a retake) varies in
 * style, the same job reproduces its own.
 */
export function styleModifierFor(jobId: string): string {
  return STYLE_MODIFIERS[songIdToSeed(jobId) % STYLE_MODIFIERS.length];
}

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
// when the cover finally comes back → ~300KB Buffer leak per cancel/fail
// that accumulates unbounded over weeks.
const cancelled = new Set<string>();
const TOMBSTONE_TTL_MS = 5 * 60_000; // forget after 5 min — long enough to outlive any in-flight cover call

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
  // Auto-evict the tombstone after the cover call could not possibly
  // still be running.
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
  cfg: CoverGenConfig,
  gate?: CoverGate,
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

  const finish = (result: CoverResult): CoverResult => {
    // Don't resurrect a consumed entry (job was cancelled / failed).
    if (!cancelled.has(jobId)) jobs.set(jobId, result);
    return result;
  };

  // The entry is registered BEFORE the job starts: a job that settles without waiting (AI covers unavailable) must be able
  // to replace it with its result, instead of being overwritten by 'pending' afterwards.
  const pending: CoverPending = { state: 'pending', startedAt, promise: undefined as unknown as Promise<CoverResult> };
  jobs.set(jobId, pending);

  pending.promise = (async () => {
    try {
      // 'song': a deterministic seed from the job id, so a retake gives the same cover; 'random': a new one each time.
      const seed = cfg.seedMode === 'song' ? songIdToSeed(jobId) : Math.floor(Math.random() * 0x7fffffff);

      // Per-job style hint put BEFORE the interface prompt (the text model reads the start first). The user never sees
      // the enriched prompt: log it, so that "the cover does not match my prompt" can be diagnosed.
      const style = styleModifierFor(jobId);
      const body = clipAtWord(cfg.prompt.trim(), MAX_PROMPT_CHARS);
      const prompt = body ? `album cover art, ${style}, ${body}` : `album cover art, ${style}`;
      console.log(`[cover] ${jobId} style="${style}" prompt="${prompt}"`);

      // No point waiting for a free GPU when there is none (processor mode) or the model cannot start.
      const availability = aiCover.status();
      if (!availability.available) {
        return finish({ state: 'failed', reason: `AI cover unavailable (${availability.reason})`, finishedAt: Date.now() });
      }
      if (gate && !(await gate())) {
        return finish({ state: 'failed', reason: 'GPU busy with an audio generation', finishedAt: Date.now() });
      }
      const r = await aiCover.generate({ prompt, seed });
      return finish({ state: 'ready', buffer: r.buffer, mimeType: r.mimeType, finishedAt: Date.now() });
    } catch (e: any) {
      return finish({ state: 'failed', reason: String(e?.message || e), finishedAt: Date.now() });
    }
  })();

  return pending;
}

/**
 * Wait for the cover-gen entry to resolve, or return null after `timeoutMs`.
 * Useful when the audio pipeline hits the song-INSERT step and wants to
 * attach the cover synchronously if it's already nearly done — but never
 * waste user time on a cold-path cover call.
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
