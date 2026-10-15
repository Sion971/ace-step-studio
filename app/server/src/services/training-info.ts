// services/training-info.ts
//
// What the Studio knows about a training run, kept so that the exported LoRA can be listed with it: the trigger word (the custom tag of the
// dataset, found in the manifest.json that preprocessing writes next to the tensors), the base model, the adapter and its size.
//   - written when training starts:   <output dir>/training_info.json
//   - read when the LoRA is exported, then copied next to the weights as lora_hub.json: the file the LoRA menu already reads for the
//     LoRA installed from the catalog (trigger word, recommended settings), marked source "studio-training".
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import type { TrainingParams } from './training-runner.js';
import { boundedInteger, boundedNumber, plain } from './lora-text.js';

export const TRAINING_INFO_FILE = 'training_info.json';
export const TRAINED_LORA_SOURCE = 'studio-training';
const WEIGHT_FILES = ['adapter_model.safetensors', 'lokr_weights.safetensors'];
const RESERVED_NAMES = new Set(['checkpoints', 'runs']);

export interface TrainingInfo {
  startedAt: string;
  adapterType: 'lora' | 'lokr';
  modelVariant: string | null;
  /** The Studio's id of the base model ("acestep-v15-xl-base"), when the variant is one of the known ones. */
  baseModel: string | null;
  rank: number | null;
  alpha: number | null;
  epochs: number | null;
  learningRate: number | null;
  datasetName: string | null;
  /** The custom tag of the dataset: the word to put in a prompt for the style to apply. */
  trigger: string | null;
  samples: number | null;
}

/** What the lora_hub.json of a trained LoRA says, as shown in the LoRA menu. */
export interface TrainingSummary {
  adapterType: 'lora' | 'lokr';
  rank: number | null;
  alpha: number | null;
  epochs: number | null;
  datasetName: string | null;
  samples: number | null;
  trainedAt: string | null;
  modelVariant: string | null;
}

const STUDIO_MODELS: Record<string, string> = {
  base: 'acestep-v15-base',
  sft: 'acestep-v15-sft',
  turbo: 'acestep-v15-turbo',
  xl_base: 'acestep-v15-xl-base',
  xl_sft: 'acestep-v15-xl-sft',
  xl_turbo: 'acestep-v15-xl-turbo',
};

export function baseModelFor(variant: unknown): string | null {
  if (typeof variant !== 'string') return null;
  const v = variant.trim().toLowerCase();
  if (STUDIO_MODELS[v]) return STUDIO_MODELS[v];
  return /^acestep-v15-[a-z0-9-]{1,60}$/.test(v) ? v : null;
}

function resolveIn(aceDir: string, value: string | undefined, fallback: string): string {
  const v = (value ?? '').trim() || fallback;
  return path.isAbsolute(v) ? v : path.resolve(aceDir, v);
}

/** The dataset behind the tensors: its name, its custom tag and its size, from the manifest.json written by preprocessing. */
export function readDatasetInfo(tensorDir: string): { name: string | null; trigger: string | null; samples: number | null } {
  try {
    const raw = JSON.parse(readFileSync(path.join(tensorDir, 'manifest.json'), 'utf8'));
    const meta = raw && typeof raw === 'object' && raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {};
    return {
      name: plain(meta.name, 80),
      trigger: plain(meta.custom_tag, 60),
      samples: boundedInteger(raw?.num_samples ?? meta.num_samples, 0, 1_000_000),
    };
  } catch {
    return { name: null, trigger: null, samples: null };
  }
}

export function buildTrainingInfo(params: TrainingParams, dataset: ReturnType<typeof readDatasetInfo>, now: Date): TrainingInfo {
  return {
    startedAt: now.toISOString(),
    adapterType: params.adapterType === 'lokr' ? 'lokr' : 'lora',
    modelVariant: plain(params.modelVariant, 60),
    baseModel: baseModelFor(params.modelVariant),
    rank: boundedInteger(params.rank, 1, 4096),
    alpha: boundedNumber(params.alpha, 0, 8192),
    epochs: boundedInteger(params.epochs, 1, 1_000_000),
    learningRate: boundedNumber(params.learningRate, 0, 1000),
    datasetName: dataset.name,
    trigger: dataset.trigger,
    samples: dataset.samples,
  };
}

/** Called when a training run starts: records it next to where the adapter will be written. */
export function recordTrainingStart(params: TrainingParams, aceDir: string, now: Date = new Date()): TrainingInfo {
  const tensorDir = resolveIn(aceDir, params.tensorDir, './datasets/preprocessed_tensors');
  const outputDir = resolveIn(aceDir, params.outputDir, './lora_output');
  const info = buildTrainingInfo(params, readDatasetInfo(tensorDir), now);
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(path.join(outputDir, TRAINING_INFO_FILE), JSON.stringify(info, null, 2));
  return info;
}

/** The record of the last run that wrote into this folder, read as untrusted; null when absent or unusable. */
export function loadTrainingInfo(loraDir: string): TrainingInfo | null {
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(path.join(loraDir, TRAINING_INFO_FILE), 'utf8'));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const startedAt = typeof raw.startedAt === 'string' && Number.isFinite(Date.parse(raw.startedAt)) ? new Date(raw.startedAt).toISOString() : null;
  if (!startedAt) return null;
  return {
    startedAt,
    adapterType: raw.adapterType === 'lokr' ? 'lokr' : 'lora',
    modelVariant: plain(raw.modelVariant, 60),
    baseModel: baseModelFor(raw.baseModel),
    rank: boundedInteger(raw.rank, 1, 4096),
    alpha: boundedNumber(raw.alpha, 0, 8192),
    epochs: boundedInteger(raw.epochs, 1, 1_000_000),
    learningRate: boundedNumber(raw.learningRate, 0, 1000),
    datasetName: plain(raw.datasetName, 80),
    trigger: plain(raw.trigger, 60),
    samples: boundedInteger(raw.samples, 0, 1_000_000),
  };
}

/** Date of the newest file directly inside a folder, 0 if none. */
export function newestMtime(dir: string): number {
  let newest = 0;
  try {
    for (const name of readdirSync(dir)) {
      try {
        const st = statSync(path.join(dir, name));
        if (st.isFile() && st.mtimeMs > newest) newest = st.mtimeMs;
      } catch {
        /* a file that disappeared */
      }
    }
  } catch {
    /* no such folder */
  }
  return newest;
}

/**
 * Is this record about the weights in `sourceDir`? Another run may have been started since, or the weights may come from an earlier run: the
 * weights must have been written after the recorded start. A record that does not fit is ignored, never guessed at.
 */
export function trainingInfoIsCurrent(info: TrainingInfo, sourceDir: string): boolean {
  return newestMtime(sourceDir) >= Date.parse(info.startedAt) - 5000;
}

function slug(text: string): string {
  return text.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._-]+/, '').slice(0, 60) || 'trained';
}

/** A folder name for an export nobody named: the dataset and the adapter, numbered if taken. Never an existing folder. */
export function autoExportName(loraDir: string, info: TrainingInfo | null): string {
  const base = slug(`${info?.datasetName ?? 'trained'}-${info?.adapterType ?? 'lora'}`);
  for (let n = 1; n < 1000; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    if (!RESERVED_NAMES.has(name.toLowerCase()) && !existsSync(path.join(loraDir, name))) return name;
  }
  return `${base}-${Date.now()}`;
}

/** Writes the lora_hub.json that lists the exported folder in the LoRA menu with what is known about its training. */
export function writeTrainedLoraRecord(destination: string, info: TrainingInfo, now: Date = new Date()): void {
  const record = {
    schema: 1,
    source: TRAINED_LORA_SOURCE,
    repo: null,
    revision: null,
    file: WEIGHT_FILES.find((f) => existsSync(path.join(destination, f))) ?? null,
    sha256: null,
    license: null,
    baseModel: info.baseModel ? [info.baseModel] : [],
    tags: [],
    adapter: null,
    sidecar: { name: path.basename(destination), triggerWord: info.trigger, recommended: {} },
    installedAt: now.toISOString(),
    training: {
      adapterType: info.adapterType,
      rank: info.rank,
      alpha: info.alpha,
      epochs: info.epochs,
      learningRate: info.learningRate,
      datasetName: info.datasetName,
      samples: info.samples,
      trainedAt: info.startedAt,
      modelVariant: info.modelVariant,
    },
  };
  writeFileSync(path.join(destination, 'lora_hub.json'), JSON.stringify(record, null, 2));
}

/** From a lora_hub.json read as untrusted: what the menu shows about a LoRA trained here. Empty for anything else. */
export function readTrainedRecord(raw: Record<string, unknown>): { source?: string; training?: TrainingSummary } {
  if (raw.source !== TRAINED_LORA_SOURCE) return {};
  const t = raw.training && typeof raw.training === 'object' && !Array.isArray(raw.training) ? (raw.training as Record<string, unknown>) : {};
  return {
    source: TRAINED_LORA_SOURCE,
    training: {
      adapterType: t.adapterType === 'lokr' ? 'lokr' : 'lora',
      rank: boundedInteger(t.rank, 1, 4096),
      alpha: boundedNumber(t.alpha, 0, 8192),
      epochs: boundedInteger(t.epochs, 1, 1_000_000),
      datasetName: plain(t.datasetName, 80),
      samples: boundedInteger(t.samples, 0, 1_000_000),
      trainedAt: plain(t.trainedAt, 40),
      modelVariant: plain(t.modelVariant, 60),
    },
  };
}
