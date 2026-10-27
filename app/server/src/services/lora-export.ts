// services/lora-export.ts
//
// Export of a trained LoRA: a plain copy of the `final` folder (or, failing that, of the newest `checkpoints/epoch_N`). It used to go through
// the Gradio engine, which is stopped while a LoRA trains ("Free VRAM") and answered "Connection errored out" right when the user wanted to
// export. Copying files needs no engine.
//
// The copy is also listed in the LoRA menu with what the Studio recorded when the run started (trigger word, base model, adapter, size): a
// lora_hub.json is written next to the weights (see training-info.ts). Without a path, the export is named after the dataset.
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { cp, mkdir, rm } from 'fs/promises';
import path from 'path';
import { TRAINED_LORA_SOURCE, autoExportName, loadTrainingInfo, trainingInfoIsCurrent, writeTrainedLoraRecord } from './training-info.js';

/** A problem the user can fix (bad path, nothing trained yet): reported as HTTP 400, not as a server fault. */
export class LoraExportError extends Error {}

function isInside(base: string, target: string): boolean {
  const rel = path.relative(base, target);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

function resolveInside(baseDir: string, value: string, label: string): string {
  const abs = path.isAbsolute(value) ? path.resolve(value) : path.resolve(baseDir, value);
  if (!isInside(baseDir, abs)) {
    throw new LoraExportError(`${label} must stay inside the ACE-Step folder (${baseDir}): ${abs}`);
  }
  return abs;
}

function hasFiles(dir: string): boolean {
  try {
    return statSync(dir).isDirectory() && readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/** The folder holding the trained adapter: `final`, else the newest `checkpoints/epoch_N`. */
export function findTrainedLora(loraDir: string): string {
  const finalDir = path.join(loraDir, 'final');
  if (hasFiles(finalDir)) return finalDir;

  const checkpointsDir = path.join(loraDir, 'checkpoints');
  let epochs: { name: string; n: number }[] = [];
  try {
    epochs = readdirSync(checkpointsDir)
      .map((name) => ({ name, m: /^epoch_(\d+)/.exec(name) }))
      .filter((e) => e.m && hasFiles(path.join(checkpointsDir, e.name)))
      .map((e) => ({ name: e.name, n: Number(e.m![1]) }));
  } catch {
    /* no checkpoints folder */
  }
  if (epochs.length === 0) {
    throw new LoraExportError(`No trained LoRA found in ${loraDir} (expected a "final" folder or "checkpoints/epoch_N")`);
  }
  epochs.sort((a, b) => a.n - b.n);
  return path.join(checkpointsDir, epochs[epochs.length - 1].name);
}

/** A LoRA installed from the catalog must not be replaced by an export: only a folder this export wrote itself may be overwritten. */
function refuseOverwritingInstalled(destination: string): void {
  const file = path.join(destination, 'lora_hub.json');
  if (!existsSync(file)) return;
  let source: unknown;
  try {
    source = JSON.parse(readFileSync(file, 'utf8'))?.source;
  } catch {
    source = undefined;
  }
  if (source !== TRAINED_LORA_SOURCE) {
    throw new LoraExportError(`"${path.basename(destination)}" is a LoRA installed from the catalog; choose another name`);
  }
}

export interface LoraExportOptions {
  /** The ACE-Step folder: relative paths are resolved against it and nothing outside it is touched. */
  baseDir: string;
  /** Blank: a name is made from the dataset and the adapter, inside the LoRA output folder. */
  exportPath?: string;
  loraOutputDir?: string;
}

export interface LoraExportResult {
  source: string;
  destination: string;
  /** True when the training details were recorded, so the LoRA menu shows its trigger word and base model. */
  listed: boolean;
}

const PEFT_FILE = 'adapter_model.safetensors';
const LOKR_FILE = 'lokr_weights.safetensors';

/**
 * The trainer writes into one shared `final` folder, so a LoRA run leaves a LoKr's weights behind (and the other way round). Copied as they are,
 * they end up in the wrong export - and since the engine prefers lokr_weights.safetensors, a "LoRA" folder would silently load an old LoKr.
 * The adapter type comes from what the Studio recorded; without a record, from whichever weights file is newer. Unknown: nothing is left out.
 */
export function staleFilesFor(sourceDir: string, recordedType: 'lora' | 'lokr' | null): Set<string> {
  let type = recordedType;
  if (!type) {
    try {
      const peft = statSync(path.join(sourceDir, PEFT_FILE)).mtimeMs;
      const lokr = statSync(path.join(sourceDir, LOKR_FILE)).mtimeMs;
      type = lokr > peft ? 'lokr' : 'lora';
    } catch {
      return new Set();
    }
  }
  return new Set(type === 'lokr' ? [PEFT_FILE, 'adapter_config.json'] : [LOKR_FILE]);
}

export async function exportLora(opts: LoraExportOptions): Promise<LoraExportResult> {
  const baseDir = path.resolve(opts.baseDir);
  const loraDir = resolveInside(baseDir, (opts.loraOutputDir ?? '').trim() || './lora_output', 'LoRA output folder');
  const source = findTrainedLora(loraDir);

  const recorded = loadTrainingInfo(loraDir);
  const info = recorded && trainingInfoIsCurrent(recorded, source) ? recorded : null;

  const requested = (opts.exportPath ?? '').trim();
  const destination = requested ? resolveInside(baseDir, requested, 'Export path') : path.join(loraDir, autoExportName(loraDir, info));

  // The destination is emptied before the copy: never let that be the trained adapter or a folder holding it.
  if (isInside(destination, source) || isInside(source, destination)) {
    throw new LoraExportError('The export path would overwrite the trained LoRA itself; choose another folder');
  }
  refuseOverwritingInstalled(destination);

  await mkdir(path.dirname(destination), { recursive: true });
  await rm(destination, { recursive: true, force: true });
  const stale = staleFilesFor(source, info?.adapterType ?? null);
  await cp(source, destination, {
    recursive: true,
    filter: (file) => path.dirname(file) !== source || !stale.has(path.basename(file)),
  });
  if (info) writeTrainedLoraRecord(destination, info);
  return { source, destination, listed: info !== null };
}
