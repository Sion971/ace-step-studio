// services/lora-available.ts
//
// The LoRA that GET /api/lora/available offers: the folders of lora_output/ that hold a complete adapter, minus "checkpoints" (intermediate saves of a
// training, not something ready to load) and "runs" (training logs).
//  - LoRA (PEFT): adapter_config.json + adapter_model.safetensors.
//  - LoKr (LyCORIS): lokr_weights.safetensors alone - the engine recognises it by that file, there is no adapter_config.json.
import { existsSync, readdirSync, renameSync, statSync } from 'fs';
import path from 'path';

export const LOKR_WEIGHTS = 'lokr_weights.safetensors';
const EXCLUDED_LORA_DIRS = new Set(['checkpoints', 'runs']);

export interface AvailableLora {
  name: string;
  path: string;
  /** Only set for LoKr; absent means a regular LoRA. */
  adapterType?: 'lokr';
}

export function listAvailableLoras(loraDir: string): AvailableLora[] {
  if (!existsSync(loraDir)) return [];

  const loras: AvailableLora[] = [];
  for (const entry of readdirSync(loraDir)) {
    if (EXCLUDED_LORA_DIRS.has(entry)) continue;
    const entryPath = path.join(loraDir, entry);
    if (!statSync(entryPath).isDirectory()) continue;

    if (existsSync(path.join(entryPath, LOKR_WEIGHTS))) {
      loras.push({ name: entry, path: `./lora_output/${entry}`, adapterType: 'lokr' });
      continue;
    }

    // PEFT insists on the exact name "adapter_model.safetensors": a LoRA downloaded under its repository's own file name looks valid but fails to
    // load with a confusing message. Renamed automatically only when UNAMBIGUOUS: one single .safetensors file, not already correctly named.
    const hasConfig = existsSync(path.join(entryPath, 'adapter_config.json'));
    const correctlyNamedPath = path.join(entryPath, 'adapter_model.safetensors');
    let hasSafetensors = existsSync(correctlyNamedPath);

    if (hasConfig && !hasSafetensors) {
      const safetensorFiles = readdirSync(entryPath).filter((f) => f.endsWith('.safetensors'));
      if (safetensorFiles.length === 1) {
        const oldPath = path.join(entryPath, safetensorFiles[0]);
        try {
          renameSync(oldPath, correctlyNamedPath);
          console.log(`[LoRA] Renomme automatiquement : ${entry}/${safetensorFiles[0]} -> adapter_model.safetensors`);
          hasSafetensors = true;
        } catch (renameError) {
          console.error(`[LoRA] Echec du renommage automatique pour ${entry}:`, renameError);
        }
      }
    }

    if (!hasConfig || !hasSafetensors) continue;

    loras.push({ name: entry, path: `./lora_output/${entry}` });
  }

  loras.sort((a, b) => a.name.localeCompare(b.name));
  return loras;
}
