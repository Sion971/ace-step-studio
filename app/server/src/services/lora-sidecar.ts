// services/lora-sidecar.ts
//
// Reads the `<weights>.metadata.json` file that some authors publish next to their LoRA (schema_version 1: the trigger word, the recommended
// scale / steps / guidance / shift, the base model the LoRA requires, the license...). Written from a real file of a published ACE-Step 1.5
// LoRA, not from a description of it.
//
// Everything here is best effort and untrusted: a field that is missing, of the wrong type or out of range becomes null, never an error,
// and free text goes through the same cleaning as the rest of what an author writes (lora-text.ts). It is information to show and to
// pre-fill, not a source of truth: a metadata file can be stale or wrong, so it is cross-checked against what the Hub itself reports.

import path from 'node:path';
import { boundedInteger, boundedNumber, normalizeSha, plain, plainList } from './lora-text.js';

/** The newest schema_version this reader was written for. */
export const KNOWN_SCHEMA_VERSION = 1;

export interface SidecarInfo {
  schemaVersion: number | null;
  name: string | null;
  version: string | null;
  author: string | null;
  description: string | null;
  /** model.base_model, e.g. "AceStep v1.5 Turbo". */
  baseModel: string | null;
  /** model.base_model_scale, e.g. "2B". */
  baseModelScale: string | null;
  /** compatibility.base_model_required, e.g. "AceStep v1.5 Turbo (2B)": the sentence that matters for compatibility. */
  baseModelRequired: string | null;
  genre: string | null;
  tags: string[];
  triggerWord: string | null;
  triggerWords: string[];
  recommended: { scale: number | null; steps: number | null; guidance: number | null; shift: number | null; sampleRate: number | null };
  /** [lowest, highest] LoRA scale the author tested. */
  testedScale: [number, number] | null;
  examplePrompts: { caption: string; bpm: number | null; key: string | null }[];
  license: string | null;
  sourceUrl: string | null;
  weightsFile: string | null;
  sha256: string | null;
  sizeBytes: number | null;
}

const asObject = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/**
 * Only http(s) links, whole: a link that is too long, or that holds a space or a control character, is refused rather than cut or cleaned, because
 * a cut link points somewhere else. This ends up as a link in the interface.
 */
function safeUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 300 || /[\s\u0000-\u001f\u007f<>"'`]/.test(value)) return null;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.href.length <= 300 ? url.href : null;
  } catch {
    return null;
  }
}

/** Null when the text is not a JSON object at all (the caller decides what to say); otherwise whatever could be read, plus warnings. */
export function parseSidecar(text: string): { info: SidecarInfo; warnings: string[] } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const root = asObject(raw);
  const model = asObject(root.model);
  const classification = asObject(root.classification);
  const inference = asObject(root.inference);
  const compatibility = asObject(root.compatibility);
  const files = asObject(root.files);
  const distribution = asObject(root.distribution);
  const warnings: string[] = [];

  const schemaVersion = boundedInteger(root.schema_version, 0, 10_000);
  if (schemaVersion !== null && schemaVersion > KNOWN_SCHEMA_VERSION) {
    warnings.push(`The metadata file uses a newer format (version ${schemaVersion}) than the Studio knows (version ${KNOWN_SCHEMA_VERSION}): some information may be missing.`);
  }

  const triggerWords = plainList(inference.trigger_words, 10, 60);
  const triggerWord = plain(inference.primary_trigger_word, 60) ?? triggerWords[0] ?? null;

  let testedScale: [number, number] | null = null;
  if (Array.isArray(inference.tested_strength_range) && inference.tested_strength_range.length === 2) {
    const low = boundedNumber(inference.tested_strength_range[0], 0, 4);
    const high = boundedNumber(inference.tested_strength_range[1], 0, 4);
    if (low !== null && high !== null && low <= high) testedScale = [low, high];
  }

  const examplePrompts = (Array.isArray(inference.example_prompts) ? inference.example_prompts : [])
    .slice(0, 5)
    .map((example) => {
      const e = asObject(example);
      const caption = plain(e.caption, 300);
      return caption ? { caption, bpm: boundedNumber(e.bpm, 20, 400), key: plain(e.key, 20) } : null;
    })
    .filter((e): e is { caption: string; bpm: number | null; key: string | null } => e !== null);

  return {
    warnings,
    info: {
      schemaVersion,
      name: plain(root.name, 80),
      version: plain(root.version, 30),
      author: plain(root.author, 80),
      description: plain(root.description, 600),
      baseModel: plain(model.base_model, 80),
      baseModelScale: plain(model.base_model_scale, 20),
      baseModelRequired: plain(compatibility.base_model_required, 120),
      genre: plain(classification.primary_genre, 60),
      tags: plainList(classification.tags, 20, 60),
      triggerWord,
      triggerWords,
      recommended: {
        scale: boundedNumber(inference.recommended_strength, 0, 4),
        steps: boundedInteger(inference.recommended_steps, 1, 200),
        guidance: boundedNumber(inference.recommended_guidance, 0, 50),
        shift: boundedNumber(inference.recommended_shift, 0, 20),
        sampleRate: boundedInteger(inference.sample_rate, 8000, 192_000),
      },
      testedScale,
      examplePrompts,
      license: plain(distribution.license, 64),
      sourceUrl: safeUrl(distribution.source_url),
      weightsFile: plain(files.weights, 200),
      sha256: normalizeSha(files.sha256),
      sizeBytes: boundedInteger(files.size_bytes, 0, 2 ** 40),
    },
  };
}

/**
 * Which `.metadata.json` goes with these weights: the one named after them (lo_fi-v1.safetensors -> lo_fi-v1.metadata.json), or the only one in
 * their folder. With several and no match it picks nothing: a wrong file is worse than none.
 */
export function pickSidecar(fileNames: string[], weightsName: string): { name: string | null; ambiguous: boolean } {
  const dir = path.posix.dirname(weightsName);
  const inFolder = fileNames.filter((n) => /\.metadata\.json$/i.test(n) && path.posix.dirname(n) === dir);
  const stem = path.posix.basename(weightsName).replace(/\.safetensors$/i, '').toLowerCase();
  const exact = inFolder.find((n) => path.posix.basename(n).toLowerCase() === `${stem}.metadata.json`);
  if (exact) return { name: exact, ambiguous: false };
  if (inFolder.length === 1) return { name: inFolder[0], ambiguous: false };
  return { name: null, ambiguous: inFolder.length > 1 };
}
