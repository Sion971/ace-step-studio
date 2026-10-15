// services/lora-export.ts
//
// Export of a trained LoRA: a plain copy of the `final` folder (or, failing that, of the newest `checkpoints/epoch_N`) to the
// path chosen by the user. It used to go through the Gradio engine, which is stopped while a LoRA trains ("Free VRAM") and
// answered "Connection errored out" right when the user wanted to export. Copying files needs no engine.
import { readdirSync, statSync } from 'fs';
import { cp, mkdir, rm } from 'fs/promises';
import path from 'path';

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

export interface LoraExportOptions {
  /** The ACE-Step folder: relative paths are resolved against it and nothing outside it is touched. */
  baseDir: string;
  exportPath?: string;
  loraOutputDir?: string;
}

export async function exportLora(opts: LoraExportOptions): Promise<{ source: string; destination: string }> {
  const baseDir = path.resolve(opts.baseDir);
  const exportPath = (opts.exportPath ?? '').trim();
  if (!exportPath) throw new LoraExportError('Export path is required');

  const loraDir = resolveInside(baseDir, (opts.loraOutputDir ?? '').trim() || './lora_output', 'LoRA output folder');
  const destination = resolveInside(baseDir, exportPath, 'Export path');
  const source = findTrainedLora(loraDir);

  // The destination is emptied before the copy: never let that be the trained adapter or a folder holding it.
  if (isInside(destination, source) || isInside(source, destination)) {
    throw new LoraExportError('The export path would overwrite the trained LoRA itself; choose another folder');
  }

  await mkdir(path.dirname(destination), { recursive: true });
  await rm(destination, { recursive: true, force: true });
  await cp(source, destination, { recursive: true });
  return { source, destination };
}
