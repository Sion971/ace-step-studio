// services/loraHub.ts
//
// What the interface needs to talk to the LoRA hub (/api/lora-hub/*) and to write what it answers, kept apart from React so that it can be tested
// on its own.
//
// Why this is not just `api()` from services/api.ts: that wrapper turns an error into the text "409: message" and drops the rest. The hub's errors
// carry a CODE (catalog_checksum_mismatch, busy, choose_file...), which is what the interface translates, and sometimes a list (the weights files to
// choose from). Here an error keeps both.
//
// The texts the server sends back are in English and are only a fallback: the interface writes its own, in the user's language, from the codes.

import type { TranslationKey } from '../i18n/translations';
import { fillTemplate } from '../utils/fillTemplate';
import { getModelDisplayName } from '../utils/modelNames';

type T = (key: TranslationKey) => string;

// ------------------------------------------------------------------------------------------------------------------------- shapes --
export type Verdict = 'compatible' | 'warning' | 'incompatible' | 'unknown';
export type ModelFamily = 'turbo' | 'base' | 'sft' | 'other';

export interface ReasonDto {
  code: 'requirement_unknown' | 'active_model_unknown' | 'size_mismatch' | 'family_mismatch' | 'comparison_incomplete' | 'conflicting_info' | 'vram_low';
  severity: 'blocking' | 'warning' | 'info';
  params: Record<string, string | number | null>;
}

export interface RequirementDto {
  family: ModelFamily | null;
  size: '2B' | 'XL' | null;
  label: string;
  sources: string[];
  conflict: boolean;
}

export interface CompatibilityDto {
  verdict: Verdict;
  required: RequirementDto | null;
  active: { id: string; family: ModelFamily | null; size: '2B' | 'XL' | null } | null;
  vramGb: number | null;
  reasons: ReasonDto[];
}

export interface RecommendedDto {
  scale: number | null;
  steps: number | null;
  guidance: number | null;
  shift: number | null;
}

export interface InstalledLoraDto {
  name: string;
  path: string;
  repo: string | null;
  revision: string | null;
  file: string | null;
  sha256: string | null;
  installedAt: string | null;
  license: string | null;
  baseModel: string[];
  triggerWord: string | null;
  recommended: RecommendedDto;
}

export interface CatalogEntryDto {
  id: string;
  repo: string;
  file: string | null;
  revision: string | null;
  sha256: string | null;
  name: string;
  description: string | null;
  author: string | null;
  license: string | null;
  baseModel: string | null;
  genre: string | null;
  tags: string[];
  triggerWord: string | null;
  recommended: RecommendedDto;
  sizeBytes: number | null;
  verified: { date: string; note: string | null } | null;
  installed: InstalledLoraDto | null;
  compatibility: CompatibilityDto;
}

export interface JobDto {
  id: string;
  repo: string;
  name: string;
  state: 'downloading' | 'verifying' | 'installing' | 'done' | 'failed';
  bytesDone: number;
  bytesTotal: number | null;
  error?: { message: string; code: string };
  result?: { name: string; path: string };
}

export interface CardDto {
  repo: string;
  revision: string;
  license: string | null;
  baseModel: string[];
  tags: string[];
  weights: { name: string; size: number | null }[];
  selected: { name: string; size: number | null } | null;
  needsChoice: boolean;
  adapter: { rank: number | null; alpha: number | null; baseModel: string | null } | null;
  sidecar: { name: string | null; author: string | null; description: string | null; triggerWord: string | null; recommended: RecommendedDto } | null;
  suggestedName: string;
  alreadyInstalled: string | null;
  warnings: string[];
}

export interface StudioContext {
  activeModel?: string;
  vramGb?: number;
}

// ------------------------------------------------------------------------------------------------------------------------ errors --
export class LoraHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'LoraHubApiError';
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
const defaultFetch: FetchLike = (input, init) => fetch(input, init);

async function request<T>(path: string, token: string | null, options: { method?: string; body?: unknown; fetchImpl?: FetchLike } = {}): Promise<T> {
  const { method = 'GET', body, fetchImpl = defaultFetch } = options;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let response: Response;
  try {
    response = await fetchImpl(`/api/lora-hub${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'include' });
  } catch {
    throw new LoraHubApiError('The Studio server could not be reached.', 0, 'unreachable');
  }
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    const { error, code, ...details } = payload ?? {};
    throw new LoraHubApiError(typeof error === 'string' ? error : 'Request failed', response.status, typeof code === 'string' ? code : 'unknown', details);
  }
  return payload as T;
}

const contextQuery = (context: StudioContext): string => {
  const query = new URLSearchParams();
  if (context.activeModel) query.set('activeModel', context.activeModel);
  if (context.vramGb !== undefined) query.set('vramGb', String(context.vramGb));
  const text = query.toString();
  return text ? `?${text}` : '';
};

export function createLoraHubApi(fetchImpl?: FetchLike) {
  return {
    catalog: (token: string | null, context: StudioContext) => request<{ entries: CatalogEntryDto[]; problems: string[] }>(`/catalog${contextQuery(context)}`, token, { fetchImpl }),
    installFromCatalog: (token: string | null, id: string) =>
      request<{ job: JobDto }>(`/catalog/${encodeURIComponent(id)}/install`, token, { method: 'POST', body: {}, fetchImpl }),
    inspect: (token: string | null, source: string, context: StudioContext, file?: string) =>
      request<{ card: CardDto; compatibility: CompatibilityDto }>('/inspect', token, { method: 'POST', body: { source, ...(file ? { file } : {}), ...context }, fetchImpl }),
    install: (token: string | null, source: string, file?: string) =>
      request<{ job: JobDto }>('/install', token, { method: 'POST', body: { source, ...(file ? { file } : {}) }, fetchImpl }),
    job: (token: string | null, id: string) => request<{ job: JobDto }>(`/installs/${encodeURIComponent(id)}`, token, { fetchImpl }),
    installed: (token: string | null) => request<{ installed: InstalledLoraDto[] }>('/installed', token, { fetchImpl }),
  };
}

export const loraHubApi = createLoraHubApi();

// ------------------------------------------------------------------------------------------------------------- the loaded model --
/**
 * The model that is loaded and the GPU memory, as the Studio itself reads them. The loaded model is only trusted under the rule the rest of the
 * interface already applies (CreatePanel): the engine is connected AND says it is ready. While a model loads, unloads or failed to load, "the loaded
 * model" is not one thing, and a verdict built on it would be confident and wrong: it is left out, and the verdict says "unknown".
 */
export async function readStudioContext(fetchImpl: FetchLike = defaultFetch): Promise<StudioContext> {
  const get = async (url: string): Promise<Record<string, unknown> | null> => {
    try {
      const response = await fetchImpl(url);
      return response.ok ? ((await response.json()) as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const [status, system] = await Promise.all([get('/api/generate/model-status'), get('/api/generate/system-info')]);
  const context: StudioContext = {};
  if (status && status.connected === true && status.state === 'ready' && typeof status.activeModel === 'string' && status.activeModel.trim()) {
    context.activeModel = status.activeModel.trim();
  }
  if (system && typeof system.vram_total === 'number' && Number.isFinite(system.vram_total) && system.vram_total > 0) {
    context.vramGb = system.vram_total;
  }
  return context;
}

// ----------------------------------------------------------------------------------------------------------------------- display --
/** 88130248 -> "88.1 MB": decimal units, like the Hub shows them. */
export function formatBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '';
  const units = ['B', 'kB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  // a non-breaking space: "88.1" and "MB" must never be split over two lines
  return `${unit === 0 || value >= 100 ? Math.round(value) : value.toFixed(1)}\u00a0${units[unit]}`;
}

/** 0..100, or null while the total is not known. */
export function progressPercent(job: Pick<JobDto, 'bytesDone' | 'bytesTotal'>): number | null {
  if (!job.bytesTotal || job.bytesTotal <= 0) return null;
  return Math.max(0, Math.min(100, Math.floor((job.bytesDone / job.bytesTotal) * 100)));
}

export type Tone = 'good' | 'warn' | 'bad' | 'neutral';
const TONES: Record<Verdict, Tone> = { compatible: 'good', warning: 'warn', incompatible: 'bad', unknown: 'neutral' };
export const verdictTone = (verdict: Verdict): Tone => TONES[verdict];

const VERDICT_KEYS: Record<Verdict, TranslationKey> = {
  compatible: 'loraHubVerdictCompatible',
  warning: 'loraHubVerdictWarning',
  incompatible: 'loraHubVerdictIncompatible',
  unknown: 'loraHubVerdictUnknown',
};
export const verdictLabel = (verdict: Verdict, t: T): string => t(VERDICT_KEYS[verdict]);

const FAMILY_NAMES: Record<ModelFamily, string> = { turbo: 'Turbo', base: 'Base', sft: 'SFT', other: '' };

/**
 * The way the Studio itself names its models (utils/modelNames.ts): "XL Turbo" for the XL family, "Turbo" for the 2B one, to which the size is added
 * in brackets here because a LoRA has to be matched on it: { turbo, XL } -> "XL Turbo", { turbo, 2B } -> "Turbo (2B)". What is not known is left out.
 */
export function modelName(spec: { family: ModelFamily | null; size: '2B' | 'XL' | null } | null | undefined): string {
  if (!spec) return '';
  const family = spec.family ? FAMILY_NAMES[spec.family] : '';
  if (spec.size === 'XL') return ['XL', family].filter(Boolean).join(' ');
  if (spec.size === '2B') return family ? `${family} (2B)` : '2B';
  return family;
}

const SOURCE_KEYS: Record<string, TranslationKey> = {
  'metadata file': 'loraHubSrcMetadata',
  repository: 'loraHubSrcRepository',
  'adapter config': 'loraHubSrcAdapter',
  tags: 'loraHubSrcTags',
};

const text = (v: string | number | null | undefined): string => (v === null || v === undefined ? '' : String(v));

/** The sentence for one reason of a verdict, in the user's language. The server sends codes and values, never sentences. */
export function reasonMessage(reason: ReasonDto, t: T): string {
  const p = reason.params;
  switch (reason.code) {
    case 'size_mismatch': {
      // "the loaded model is 2B" says little: the Studio names its models ("Turbo"), so the sentence names the loaded one, with its size
      const shown = p.activeModel ? getModelDisplayName(String(p.activeModel)) : '';
      const loaded = !shown ? text(p.active) : /\bXL\b/.test(shown) ? shown : `${shown} (${text(p.active)})`; // "XL Turbo" already says its size
      return fillTemplate(t('loraHubReasonSize'), { required: text(p.required), active: loaded });
    }
    case 'family_mismatch':
      return fillTemplate(t('loraHubReasonFamily'), { required: FAMILY_NAMES[p.required as ModelFamily] || text(p.required), active: FAMILY_NAMES[p.active as ModelFamily] || text(p.active) });
    case 'comparison_incomplete':
      return t('loraHubReasonIncomplete');
    case 'conflicting_info': {
      // the server names its sources in English ("metadata file, repository"): they are written here in the user's language
      const names = text(p.sources).split(',').map((s) => s.trim()).filter(Boolean).map((s) => (SOURCE_KEYS[s] ? t(SOURCE_KEYS[s]) : s));
      return fillTemplate(t('loraHubReasonConflict'), { sources: names.join(', ') });
    }
    case 'vram_low':
      return fillTemplate(t('loraHubReasonVram'), { needed: text(p.needed), gb: text(p.vramGb) });
    case 'requirement_unknown':
      return t('loraHubReasonRequirement');
    case 'active_model_unknown':
      return t('loraHubReasonNoActive');
    default:
      return '';
  }
}

/**
 * What can be shown, in order: the blocking reasons, then the warnings, then the information. Each keeps its OWN severity: a card that cannot be used
 * because of its size must not show "this GPU has less memory than it would like" in the same red.
 */
export function reasonsToShow(compatibility: CompatibilityDto, t: T): { text: string; severity: ReasonDto['severity'] }[] {
  const order = { blocking: 0, warning: 1, info: 2 } as const;
  return [...compatibility.reasons]
    .sort((a, b) => order[a.severity] - order[b.severity])
    .map((reason) => ({ text: reasonMessage(reason, t), severity: reason.severity }))
    .filter((reason) => reason.text !== '');
}

/** The codes of the hub that have a sentence of their own here. Exported so that a test can compare them with the codes the server can send. */
export const HUB_ERROR_KEYS: Record<string, TranslationKey> = {
  invalid_source: 'loraHubErrSource',
  not_found: 'loraHubErrNotFound',
  forbidden: 'loraHubErrForbidden',
  rate_limited: 'loraHubErrRate',
  unsupported_format: 'loraHubErrFormat',
  no_weights: 'loraHubErrNotLora',
  no_adapter_config: 'loraHubErrNotLora',
  unsupported_adapter: 'loraHubErrNotLora',
  invalid_adapter_config: 'loraHubErrNotLora',
  already_installed: 'loraHubErrExists',
  already_installing: 'loraHubErrBusy',
  busy: 'loraHubErrBusy',
  too_large: 'loraHubErrTooBig',
  checksum_mismatch: 'loraHubErrChecksum',
  size_mismatch: 'loraHubErrChecksum',
  catalog_checksum_mismatch: 'loraHubErrChanged',
  download_stalled: 'loraHubErrStalled',
  network: 'loraHubErrNetwork',
  hub_error: 'loraHubErrNetwork',
  unexpected_response: 'loraHubErrNetwork',
  unreachable: 'loraHubErrNetwork',
};

/** An error of the hub, in the user's language. A code this interface does not know falls back on the server's own (English) sentence. */
export function errorMessage(error: { code?: string; message?: string }, t: T): string {
  const key = error.code ? HUB_ERROR_KEYS[error.code] : undefined;
  if (key) return t(key);
  return error.message && error.message !== 'Request failed' ? error.message : t('loraHubErrGeneric');
}

/** The scale to give the slider: the author's recommendation, kept inside what the slider can show (0 to 1). Null when the author recommends none. */
export function scaleFor(installed: Pick<InstalledLoraDto, 'recommended'>): number | null {
  const scale = installed.recommended.scale;
  return typeof scale === 'number' && Number.isFinite(scale) ? Math.max(0, Math.min(1, scale)) : null;
}

/** "Use" is offered once installed, unless the loaded model cannot take it at all. */
export const canUse = (entry: Pick<CatalogEntryDto, 'installed' | 'compatibility'>): boolean => entry.installed !== null && entry.compatibility.verdict !== 'incompatible';

/** The settings an author recommends, as short labelled values; what is not recommended is left out. */
export function recommendedParts(recommended: RecommendedDto, t: T): string[] {
  const parts: string[] = [];
  if (recommended.scale !== null) parts.push(fillTemplate(t('loraHubScale'), { value: recommended.scale }));
  if (recommended.steps !== null) parts.push(fillTemplate(t('loraHubSteps'), { value: recommended.steps }));
  if (recommended.guidance !== null) parts.push(fillTemplate(t('loraHubGuidance'), { value: recommended.guidance }));
  if (recommended.shift !== null) parts.push(fillTemplate(t('loraHubShift'), { value: recommended.shift }));
  return parts;
}
