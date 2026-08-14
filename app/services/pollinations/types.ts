// Domain types for the Pollinations.ai cover generation provider.
// API reference: https://gen.pollinations.ai/docs (OpenAPI schema at /docs/open-api/generate-schema)
//
// Endpoint: GET https://gen.pollinations.ai/image/{URL_ENCODED_PROMPT}
//   query:  model, width, height, seed, nologo, enhance, safe
//   header: Authorization: Bearer <pk_|sk_...>  (optional — anonymous tier works)
//
// gen.pollinations.ai/image/models  → object[] (full catalogue with auth)
// (legacy image.pollinations.ai/models was abandoned — silently routed all
//  models to `sana`; see app/services/pollinations/client.ts header.)

/**
 * Persisted client config — lives in localStorage at acestep.pollinations.config.
 *
 * apiKey is OPTIONAL: anonymous tier works (1 req/15s, may include a small
 * watermark). With a token (pk_ or sk_ from auth.pollinations.ai) the user
 * gets the seed tier (1 req/5s, no watermark).
 */
export interface PollinationsConfig {
  apiKey: string;        // '' = anonymous tier
  model: string;         // '' until user picks. Live list comes from /image/models.
  width: number;         // default 1024 — square is recommended for album covers
  height: number;        // default 1024
  seedMode: 'song' | 'random'; // 'song' = derive from songId for reproducibility on retake
  enhance: boolean;      // expand short prompts via Pollinations LLM (legacy param, kept for forward compat)
  nologo: boolean;       // strip watermark (legacy param, only effective with auth)
  safe: boolean;         // SFW filter — default true; false requires auth + token tier
}

export type PolErrorCode =
  | 'KEY_INVALID'
  | 'PAYMENT_REQUIRED'
  | 'RATE_LIMITED'
  | 'MODEL_UNAVAILABLE'
  | 'PROMPT_REJECTED'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'UNKNOWN';

export class PollinationsError extends Error {
  constructor(
    public readonly code: PolErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'PollinationsError';
  }
}

/** Returned by the /image/models endpoint. May come back as plain string array
 *  (current behavior — `["sana"]` on free tier) or as objects with id/description.
 *  We normalize to a uniform shape. */
export interface PolModelInfo {
  id: string;
  description?: string;
}

// NOTE: a separate `PolGenResult` type lives in
// app/server/src/services/pollinations.ts — it's the actual server-side
// return shape. This client-side bundle no longer needs a duplicate type.

/** Input shape for buildCoverPrompt — narrow subset of song meta. */
export interface CoverPromptInput {
  title: string;
  /** ACE-Step caption / style description, e.g. "synthwave, 80s, female vocals" */
  caption: string;
  /** Original user brief (Простой mode topic) — '' if not present. */
  topic: string;
  /** ISO-639-1 language code of the song lyrics. Image prompt stays in English
   *  regardless because diffusion models are predominantly English-trained. */
  language: string;
  /** True for instrumentals — adds a hint about no vocalist persona. */
  instrumental: boolean;
}
