import { PollinationsError, type PolErrorCode, type PolModelInfo } from './types';

// Pollinations.ai has two related domains:
//   image.pollinations.ai  — legacy direct image-gen, simplified /models
//                             endpoint that only ever returns ["sana"] regardless
//                             of auth tier (free-tier consolidation).
//   gen.pollinations.ai    — current OpenAPI host. /image/models returns the
//                             full live model catalogue (kontext, gptimage,
//                             gptimage-large, flux, zimage, wan-image,
//                             qwen-image, klein, …) with pricing + descriptions
//                             when called with an Authorization Bearer token.
//
// We use gen.pollinations.ai/image/* for everything — the legacy host gave
// us a single-model list that confused users.
//
// CORS: gen.pollinations.ai answers OPTIONS preflight with
// `Access-Control-Allow-Origin: *` and `Access-Control-Allow-Headers: *`,
// so sending `Authorization: Bearer …` from the browser is allowed.
const BASE = 'https://gen.pollinations.ai';

function authHeaders(apiKey: string): Record<string, string> {
  const h: Record<string, string> = {};
  if (apiKey) h.Authorization = `Bearer ${apiKey}`;
  return h;
}

function mapStatusToCode(status: number | null): PolErrorCode {
  if (status === 401 || status === 403) return 'KEY_INVALID';
  // 402 = Pollinations tier-gating. Model requires Flower/Nectar (paid),
  // user's token is Seed/Anonymous. UI surfaces this as a hint to switch
  // to a Seed-tier model (flux, sana) or upgrade their token.
  if (status === 402) return 'PAYMENT_REQUIRED';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 404 || status === 503) return 'MODEL_UNAVAILABLE';
  if (status && status >= 400 && status < 500) return 'PROMPT_REJECTED';
  if (status && status >= 500) return 'UNKNOWN';
  return 'NETWORK';
}

// In-memory cache: per-key result is small (string[]). Keyed on apiKey so an
// anonymous and an authed call don't share each other's seen-list, which can
// differ on Pollinations' side (paid models surface only with token).
const modelsCache = new Map<string, { fetchedAt: number; data: PolModelInfo[] }>();
const MODELS_TTL_MS = 60 * 60 * 1000;

async function fetchModels(apiKey: string, force = false): Promise<PolModelInfo[]> {
  // We keep the apiKey in the cache key so that future server-side proxies
  // (which can validate token) won't conflict with anonymous results.
  const cacheKey = apiKey || '__anon__';
  const cached = modelsCache.get(cacheKey);
  if (!force && cached && Date.now() - cached.fetchedAt < MODELS_TTL_MS) return cached.data;

  let res: Response;
  try {
    res = await fetch(`${BASE}/image/models`, { headers: authHeaders(apiKey) });
  } catch (e: any) {
    throw new PollinationsError('NETWORK', String(e?.message || e), e);
  }
  if (!res.ok) {
    throw new PollinationsError(mapStatusToCode(res.status), `models list ${res.status}`);
  }
  const json = await res.json().catch(() => null);
  // gen.pollinations.ai/image/models shape:
  //   [{name, aliases, pricing, description, input_modalities, output_modalities}]
  // legacy fallback: ["sana"] (string array)
  let normalized: PolModelInfo[] = [];
  if (Array.isArray(json)) {
    normalized = json
      .map((m: unknown): PolModelInfo | null => {
        if (typeof m === 'string') return { id: m };
        if (m && typeof m === 'object') {
          const obj = m as Record<string, unknown>;
          // Skip non-image models (the catalogue mixes in video models like
          // ltx-2 and nova-reel — we only want text-to-image / image-to-image).
          const out = obj.output_modalities;
          if (Array.isArray(out) && !out.includes('image')) return null;
          const id = typeof obj.name === 'string' ? obj.name
                   : typeof obj.id   === 'string' ? obj.id
                   : null;
          if (!id) return null;
          return {
            id,
            description: typeof obj.description === 'string' ? obj.description : undefined,
          };
        }
        return null;
      })
      .filter((x): x is PolModelInfo => x !== null);
  }
  modelsCache.set(cacheKey, { fetchedAt: Date.now(), data: normalized });
  return normalized;
}

export async function getPollinationsModels(apiKey: string): Promise<PolModelInfo[]> {
  return fetchModels(apiKey, false);
}

export async function refreshPollinationsModels(apiKey: string): Promise<PolModelInfo[]> {
  return fetchModels(apiKey, true);
}

/**
 * Lightweight key validity check — hits /models with the key.
 * Cheaper than firing a real generation. Note that Pollinations' /models
 * returns 200 even for invalid tokens (see APIDOCS), so this is more of a
 * reachability ping than a strict key-validity check; for now that's good
 * enough — real validation happens implicitly when cover-gen runs.
 */
export async function testPollinationsKey(apiKey: string): Promise<{ ok: true }> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/image/models`, { headers: authHeaders(apiKey) });
  } catch (e: any) {
    throw new PollinationsError('NETWORK', String(e?.message || e), e);
  }
  if (!res.ok) {
    throw new PollinationsError(mapStatusToCode(res.status), `key test failed: ${res.status}`);
  }
  return { ok: true };
}
