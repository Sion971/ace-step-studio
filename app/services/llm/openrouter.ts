import { OpenRouter } from '@openrouter/sdk';
import { llmStorage } from './storage';
import { buildGenerate, buildFormat, type ChatMessage } from './prompts';
import { extractPartial } from './partialJson';
import {
  OpenRouterError,
  type ErrorCode,
  type SongDraft,
  type SongDraftInput,
  type FormatInput,
  type GenEvent,
} from './types';

// Strict json_schema for capable models. Validators that strict mode disallows
// (minItems/maxItems on arrays, minimum/maximum on integers) are NOT here —
// the prompt enforces ranges (BPM 40-220, durationSec 15-600, tags 3-6).
const SCHEMA = {
  name: 'SongDraft',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'caption', 'lyrics', 'tags', 'bpm', 'keyScale', 'timeSignature', 'durationSec', 'coverPrompt'],
    properties: {
      title: { type: 'string' },
      caption: { type: 'string' },
      lyrics: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      bpm: { type: 'integer' },
      keyScale: { type: 'string' },
      timeSignature: { type: 'string' },
      durationSec: { type: 'integer' },
      coverPrompt: { type: 'string' },
    },
  },
} as const;

const REQUIRED_FIELDS = SCHEMA.schema.required;
const SANITY_CHECK_THRESHOLD = 200;

const PROJECT_HEADERS = {
  httpReferer: 'https://github.com/timoncool/ACE-Step-Studio',
  appTitle: 'ACE-Step Studio',
} as const;

export interface RunOpts {
  signal: AbortSignal;
  onEvent: (e: GenEvent) => void;
}

// In-memory cache for /models response (keyed by api key) — saves a roundtrip
// when the user fires multiple generations in a session.
const modelsCache = new Map<string, { fetchedAt: number; data: any[] }>();
const MODELS_TTL_MS = 60 * 60 * 1000;

function mapErrorToCode(err: any): ErrorCode {
  const status = err?.status ?? err?.response?.status ?? null;
  if (err?.name === 'AbortError') return 'NETWORK';
  if (status === 401) return 'KEY_INVALID';
  if (status === 402) return 'INSUFFICIENT_FUNDS';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 404 || status === 503) return 'MODEL_UNAVAILABLE';
  if (status === 400) return 'SCHEMA_UNSUPPORTED';
  if (typeof status === 'number') return 'UNKNOWN';
  return 'NETWORK';
}

function makeClient(apiKey: string): OpenRouter {
  return new OpenRouter({
    apiKey,
    httpReferer: PROJECT_HEADERS.httpReferer,
    appTitle: PROJECT_HEADERS.appTitle,
  } as any);
}

async function listModels(client: OpenRouter, apiKey: string, force = false): Promise<any[]> {
  const cached = modelsCache.get(apiKey);
  if (!force && cached && Date.now() - cached.fetchedAt < MODELS_TTL_MS) return cached.data;
  // SDK exposes models.list — name varies across versions. Try both shapes.
  const anyClient = client as any;
  try {
    let res: any;
    if (anyClient.models?.list) res = await anyClient.models.list();
    else if (anyClient.models?.listAvailableModels) res = await anyClient.models.listAvailableModels();
    else throw new Error('models.list not on SDK client');
    const data = Array.isArray(res?.data) ? res.data : (Array.isArray(res) ? res : []);
    modelsCache.set(apiKey, { fetchedAt: Date.now(), data });
    return data;
  } catch (e) {
    // Fallback: hit /models directly (SDK may not expose it in browser builds)
    const r = await fetch('https://openrouter.ai/api/v1/models', {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': PROJECT_HEADERS.httpReferer,
        'X-Title': PROJECT_HEADERS.appTitle,
      },
    });
    if (!r.ok) throw new OpenRouterError(mapErrorToCode({ status: r.status }), `models list ${r.status}`);
    const json = await r.json();
    const data = Array.isArray(json?.data) ? json.data : [];
    modelsCache.set(apiKey, { fetchedAt: Date.now(), data });
    return data;
  }
}

export async function refreshModelList(apiKey: string): Promise<any[]> {
  if (!apiKey) return [];
  return listModels(makeClient(apiKey), apiKey, true);
}

export async function getModelList(apiKey: string): Promise<any[]> {
  if (!apiKey) return [];
  return listModels(makeClient(apiKey), apiKey, false);
}

export async function testApiKey(apiKey: string, model?: string): Promise<{ ok: true }> {
  // Use the cheapest, most-broadly-supported test: GET /models with the key.
  // It's a single round-trip, doesn't bill any completion tokens, and works
  // for every model on the platform (avoids picking a specific model that
  // might not be live for this user).
  const r = await fetch('https://openrouter.ai/api/v1/models', {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': PROJECT_HEADERS.httpReferer,
      'X-Title': PROJECT_HEADERS.appTitle,
    },
  });
  if (!r.ok) {
    throw new OpenRouterError(mapErrorToCode({ status: r.status }), `key test failed: ${r.status}`);
  }
  void model; // intentional: keep param for backwards compat
  return { ok: true };
}

// Strip markdown ```json ... ``` fences some models add even when asked for JSON.
function stripCodeFence(s: string): string {
  const t = s.trimStart();
  if (!t.startsWith('```')) return s;
  const m = t.match(/^```(?:json)?\s*\n?/i);
  if (!m) return s;
  let inner = t.slice(m[0].length);
  const closeIdx = inner.lastIndexOf('```');
  if (closeIdx >= 0) inner = inner.slice(0, closeIdx);
  return inner.trim();
}

export class OpenRouterProvider {
  generate(input: SongDraftInput, opts: RunOpts): Promise<SongDraft> {
    const cfg = llmStorage.getOpenRouter();
    const messages = buildGenerate(input, cfg.systemPromptGenerate);
    return this.run(messages, opts, 0, { thinking: !!input.thinking });
  }

  format(input: FormatInput, opts: RunOpts): Promise<SongDraft> {
    const cfg = llmStorage.getOpenRouter();
    const messages = buildFormat(input, cfg.systemPromptFormat);
    return this.run(messages, opts, 0, { thinking: !!input.thinking });
  }

  private async run(
    messages: ChatMessage[],
    opts: RunOpts,
    attempt: number,
    extra: { thinking: boolean },
  ): Promise<SongDraft> {
    const cfg = llmStorage.getOpenRouter();
    if (!cfg.apiKey) throw new OpenRouterError('KEY_MISSING', 'OpenRouter API key not set');
    if (!cfg.model) throw new OpenRouterError('MODEL_UNAVAILABLE', 'OpenRouter model not selected — pick one from the list');

    const client = makeClient(cfg.apiKey);

    // Adaptive request body: only forward params the chosen model declares
    // support for in its OpenRouter `supported_parameters` field.
    let supported: Set<string>;
    try {
      const models = await listModels(client, cfg.apiKey);
      const meta = models.find((m: any) => m && m.id === cfg.model);
      const list = Array.isArray(meta?.supported_parameters) ? meta.supported_parameters : [];
      supported = new Set<string>(list);
    } catch {
      supported = new Set<string>(['temperature', 'top_p', 'max_tokens', 'response_format', 'stream']);
    }

    const reqBody: Record<string, unknown> = {
      model: cfg.model,
      messages,
      stream: true,
    };
    const setIf = (param: string, value: unknown): void => {
      if (supported.has(param)) reqBody[param] = value;
    };
    setIf('temperature', cfg.temperature);
    setIf('top_p', cfg.topP);
    setIf('frequency_penalty', cfg.frequencyPenalty);
    setIf('presence_penalty', cfg.presencePenalty);
    setIf('repetition_penalty', cfg.repetitionPenalty);
    setIf('max_tokens', cfg.maxTokens);
    if (cfg.topK > 0) setIf('top_k', cfg.topK);
    if (cfg.minP > 0) setIf('min_p', cfg.minP);
    if (cfg.seed !== null) setIf('seed', cfg.seed);
    if (extra.thinking) setIf('reasoning', { effort: 'medium' });

    const hasStructured = supported.has('structured_outputs');
    const hasResponseFormat = supported.has('response_format');
    if (attempt === 0 && hasStructured) {
      reqBody.response_format = { type: 'json_schema', json_schema: SCHEMA };
    } else if (hasResponseFormat) {
      reqBody.response_format = { type: 'json_object' };
    }

    // SDK signature differs slightly between versions — try both common shapes.
    const callSDK = async () => {
      const c: any = client.chat;
      try {
        return await c.send({ ...reqBody, signal: opts.signal });
      } catch {
        return await c.send({ chatRequest: reqBody, signal: opts.signal });
      }
    };

    let stream: any;
    try {
      stream = await callSDK();
    } catch (e: any) {
      const code = mapErrorToCode(e);
      if (code === 'SCHEMA_UNSUPPORTED' && attempt === 0) {
        const fallback: ChatMessage[] = [
          ...messages,
          { role: 'user', content: `Match this exact JSON shape:\n${JSON.stringify(SCHEMA.schema)}` },
        ];
        return this.run(fallback, opts, 1, extra);
      }
      throw new OpenRouterError(code, String(e?.message || e), e);
    }

    let firstChunkSeen = false;
    let raw = '';
    let usageEmitted = false;

    try {
      for await (const chunk of stream as AsyncIterable<any>) {
        if (opts.signal.aborted) {
          throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        }
        if (!firstChunkSeen) {
          firstChunkSeen = true;
          opts.onEvent({ type: 'firstChunk' });
        }

        const delta: string = chunk?.choices?.[0]?.delta?.content || '';
        if (delta) raw += delta;

        const usage = chunk?.usage;
        if (usage && !usageEmitted) {
          usageEmitted = true;
          opts.onEvent({
            type: 'usage',
            promptTokens: usage.prompt_tokens || usage.promptTokens || 0,
            completionTokens: usage.completion_tokens || usage.completionTokens || 0,
            costUsd: typeof usage.cost === 'number' ? usage.cost : null,
          });
        }

        const view = stripCodeFence(raw);

        if (view.length >= SANITY_CHECK_THRESHOLD && !view.trimStart().startsWith('{')) {
          if (attempt === 0) {
            const fallback: ChatMessage[] = [
              ...messages,
              { role: 'user', content: 'Return JSON only, matching the schema, no prose, no markdown fences.' },
            ];
            return this.run(fallback, opts, 1, extra);
          }
          throw new OpenRouterError('SCHEMA_NONCOMPLIANT', 'model returned non-JSON content');
        }

        const partResult = extractPartial(view);
        const ev: GenEvent = { type: 'chunk', raw, partial: partResult.closed };
        if (partResult.openStringField) (ev as any).openStringField = partResult.openStringField;
        opts.onEvent(ev);
      }
    } catch (e: any) {
      if (opts.signal.aborted || e?.name === 'AbortError') throw e;
      if (e instanceof OpenRouterError) throw e;
      throw new OpenRouterError(mapErrorToCode(e), String(e?.message || e), e);
    }

    opts.onEvent({ type: 'streamDone', raw });

    let draft: SongDraft;
    try {
      draft = JSON.parse(stripCodeFence(raw));
      // Tolerate models / stale custom system prompts that don't emit `coverPrompt`
      // (the field was added later). Empty string is a valid value per types.ts;
      // the keyword fallback in buildCoverPrompt fills in for cover gen.
      if (typeof (draft as any).coverPrompt !== 'string') {
        (draft as any).coverPrompt = '';
      }
    } catch {
      if (attempt === 0) {
        const fallback: ChatMessage[] = [
          ...messages,
          { role: 'user', content: 'Return JSON only, no prose, no markdown fences.' },
        ];
        return this.run(fallback, opts, 1, extra);
      }
      throw new OpenRouterError('INVALID_JSON', 'failed to parse model response after retry');
    }

    for (const field of REQUIRED_FIELDS) {
      if (!(field in draft)) {
        if (attempt === 0) {
          const fallback: ChatMessage[] = [
            ...messages,
            { role: 'user', content: 'Return JSON only, no prose. Include all required fields.' },
          ];
          return this.run(fallback, opts, 1, extra);
        }
        throw new OpenRouterError('INVALID_JSON', `missing field: ${field}`);
      }
    }
    return draft;
  }
}
