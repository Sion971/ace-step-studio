// services/lora-compat.ts
//
// Will this LoRA work with the model the Studio has loaded, and with this GPU? A pure function: the model and the memory are passed in (the
// interface already has both: GET /api/generate/model-status and /system-info), so it can be tested on its own.
//
// What it says, and what it refuses to say:
//  - "incompatible" only for a size mismatch: a LoRA trained on the 2B model cannot be loaded on an XL one (the layers do not have the same
//    dimensions). That is the one thing that is certain.
//  - A family mismatch (a LoRA trained on Turbo, used on Base) does load, but it was tuned for other steps and guidance and the result differs
//    (a published card says its 8-step / low-guidance pairing "produces mush" on the base model): a warning, not a refusal.
//  - "compatible" only when the size AND the family are known on both sides and equal. Anything less is "unknown", never a guess.
//  - Several sources speak (the author's metadata file, the repository, adapter_config.json, the tags): when they disagree, that is reported.

import path from 'node:path';

export type ModelFamily = 'turbo' | 'base' | 'sft' | 'other';
export type ModelSize = '2B' | 'XL';

export interface ModelSpec {
  family: ModelFamily | null;
  size: ModelSize | null;
}

/**
 * The Studio's own models (app/utils/modelNames.ts: MODEL_INFO). vramMin is the minimum VRAM in GB that the Studio announces for each one.
 * Kept in step with the client table by a test that reads it.
 */
export const STUDIO_MODELS: Record<string, ModelSpec & { vramMin: number }> = {
  'acestep-v15-base': { family: 'base', size: '2B', vramMin: 6 },
  'acestep-v15-sft': { family: 'sft', size: '2B', vramMin: 6 },
  'acestep-v15-turbo': { family: 'turbo', size: '2B', vramMin: 6 },
  'acestep-v15-xl-base': { family: 'base', size: 'XL', vramMin: 12 },
  'acestep-v15-xl-sft': { family: 'sft', size: 'XL', vramMin: 12 },
  'acestep-v15-xl-turbo': { family: 'turbo', size: 'XL', vramMin: 12 },
  'acestep-v15-xl-turbo-bf16': { family: 'turbo', size: 'XL', vramMin: 8 },
  'acestep-v15-xl-merge-sft-turbo': { family: 'other', size: 'XL', vramMin: 12 },
};

/** What can be read from a model name written by a person ("AceStep v1.5 Turbo (2B)") or by the Studio ("acestep-v15-xl-base"). */
export function describeModel(text: string | null | undefined): ModelSpec {
  const raw = (text ?? '').trim();
  if (!raw) return { family: null, size: null };
  const id = path.posix.basename(raw.replace(/\\/g, '/').replace(/\/+$/, ''));
  const known = STUDIO_MODELS[id];
  if (known) return { family: known.family, size: known.size };

  const t = raw.toLowerCase();
  let size: ModelSize | null = null;
  if (/(^|[^a-z0-9])(xl|4\s*b)([^a-z0-9]|$)/.test(t)) size = 'XL';
  else if (/(^|[^a-z0-9])2\s*b([^a-z0-9]|$)/.test(t)) size = '2B';
  else if (/acestep-v15-/.test(t)) size = '2B'; // the Studio names only its XL models with "xl"

  let family: ModelFamily | null = null;
  if (/merge/.test(t)) family = 'other';
  else if (/turbo/.test(t)) family = 'turbo';
  else if (/(^|[^a-z0-9])sft([^a-z0-9]|$)/.test(t)) family = 'sft';
  else if (/(^|[^a-z0-9])base([^a-z0-9]|$)/.test(t)) family = 'base';
  return { family, size };
}

export type EvidenceSource = 'metadata file' | 'repository' | 'adapter config' | 'tags';

export interface Requirement extends ModelSpec {
  /** The text it was read from, or a short summary of where size and family came from. */
  label: string;
  sources: EvidenceSource[];
  /** True when two sources disagree about the size or the family. */
  conflict: boolean;
}

/** The part of a card that says which base model the LoRA was made for. */
export interface CardEvidence {
  baseModel: string[];
  tags: string[];
  adapter: { baseModel: string | null } | null;
  sidecar: { baseModelRequired: string | null; baseModel: string | null; baseModelScale: string | null } | null;
}

/** Collects what every source says, in order of trust, and merges it. Null when nothing says anything about size or family. */
export function requiredBase(card: CardEvidence): Requirement | null {
  const found: { source: EvidenceSource; text: string; spec: ModelSpec }[] = [];
  const add = (source: EvidenceSource, text: string | null | undefined) => {
    if (!text) return;
    const spec = describeModel(text);
    if (spec.family || spec.size) found.push({ source, text, spec });
  };

  const side = card.sidecar;
  if (side) {
    add('metadata file', side.baseModelRequired);
    if (!side.baseModelRequired && side.baseModel) add('metadata file', side.baseModelScale ? `${side.baseModel} (${side.baseModelScale})` : side.baseModel);
  }
  for (const b of card.baseModel) add('repository', b);
  add('adapter config', card.adapter?.baseModel);
  const tags = card.tags.map((t) => t.toLowerCase());
  if (tags.includes('acestep-xl') || tags.includes('acestep-4b')) found.push({ source: 'tags', text: 'acestep-xl', spec: { family: null, size: 'XL' } });
  else if (tags.includes('acestep-2b')) found.push({ source: 'tags', text: 'acestep-2b', spec: { family: null, size: '2B' } });

  if (found.length === 0) return null;
  const first = <K extends keyof ModelSpec>(key: K) => found.find((f) => f.spec[key] !== null)?.spec[key] ?? null;
  const distinct = <K extends keyof ModelSpec>(key: K) => new Set(found.map((f) => f.spec[key]).filter((v) => v !== null)).size;
  return {
    family: first('family'),
    size: first('size'),
    label: found[0].text,
    sources: [...new Set(found.map((f) => f.source))],
    conflict: distinct('family') > 1 || distinct('size') > 1,
  };
}

export type Verdict = 'compatible' | 'warning' | 'incompatible' | 'unknown';

export interface Reason {
  code: 'requirement_unknown' | 'active_model_unknown' | 'size_mismatch' | 'family_mismatch' | 'comparison_incomplete' | 'conflicting_info' | 'vram_low';
  severity: 'blocking' | 'warning' | 'info';
  /** What the interface needs to write the sentence (model names, sizes, GB), never a sentence itself. */
  params: Record<string, string | number | null>;
}

export interface Compatibility {
  verdict: Verdict;
  required: Requirement | null;
  active: (ModelSpec & { id: string; vramMin: number | null }) | null;
  vramGb: number | null;
  reasons: Reason[];
}

/** The VRAM the Studio announces for the model this LoRA calls for (the smallest one that matches). */
export function vramNeeded(required: ModelSpec): number | null {
  const candidates = Object.values(STUDIO_MODELS).filter((m) => (!required.size || m.size === required.size) && (!required.family || m.family === required.family));
  return candidates.length > 0 ? Math.min(...candidates.map((m) => m.vramMin)) : null;
}

export function checkCompatibility(input: { required: Requirement | null; activeModel?: string | null; vramGb?: number | null }): Compatibility {
  const { required } = input;
  const activeId = input.activeModel?.trim() || null;
  const activeSpec = activeId ? describeModel(activeId) : null;
  const active = activeId && activeSpec ? { id: activeId, ...activeSpec, vramMin: STUDIO_MODELS[path.posix.basename(activeId)]?.vramMin ?? null } : null;
  const vramGb = typeof input.vramGb === 'number' && Number.isFinite(input.vramGb) && input.vramGb > 0 ? input.vramGb : null;
  const reasons: Reason[] = [];
  const reasonOnly = (code: Reason['code'], severity: Reason['severity'], params: Reason['params'] = {}) => reasons.push({ code, severity, params });

  if (!required) {
    reasonOnly('requirement_unknown', 'info');
  } else {
    if (required.conflict) reasonOnly('conflicting_info', 'warning', { sources: required.sources.join(', ') });
    if (!active) {
      reasonOnly('active_model_unknown', 'info');
    } else {
      // A merged model ("other") is not of one family: nothing can be said about the family on that side.
      const sizeKnown = required.size !== null && active.size !== null;
      const familyKnown = required.family !== null && active.family !== null && active.family !== 'other';
      if (sizeKnown && required.size !== active.size) {
        reasonOnly('size_mismatch', 'blocking', { required: required.size, active: active.size, activeModel: active.id });
      } else {
        if (familyKnown && required.family !== active.family) {
          reasonOnly('family_mismatch', 'warning', { required: required.family, active: active.family, activeModel: active.id });
        }
        if (!sizeKnown || !familyKnown) {
          reasonOnly('comparison_incomplete', 'info', { requiredSize: required.size, requiredFamily: required.family, activeSize: active.size, activeFamily: active.family });
        }
      }
    }
    const needed = vramNeeded(required);
    if (needed !== null && vramGb !== null && vramGb < needed) {
      reasonOnly('vram_low', 'warning', { needed, vramGb, size: required.size, family: required.family });
    }
  }

  let verdict: Verdict;
  if (reasons.some((r) => r.severity === 'blocking')) verdict = 'incompatible';
  else if (!required) verdict = 'unknown';
  else if (reasons.some((r) => r.severity === 'warning')) verdict = 'warning';
  else if (!active || reasons.some((r) => r.code === 'comparison_incomplete')) verdict = 'unknown';
  else verdict = 'compatible';

  return { verdict, required, active, vramGb, reasons };
}
