// utils/modelFit.ts
//
// Which models a graphics card can reasonably run, for the model menu.
//
// The memory a model needs is the `vramMin` of MODEL_INFO (the engine's own figures). It is an ESTIMATE: CPU offload runs bigger models, slowly.
// So nothing here refuses a model: it only decides which ones the menu shows first, and the menu offers the others behind a link.
//
// Three rules keep this from hiding what it should not:
//  - memory unknown (no NVIDIA card, engine not started, request failed): nothing is hidden, on no guess;
//  - a model that is not in MODEL_INFO (custom, converted, merged by the user) is never hidden: nothing is known about it;
//  - the caller keeps visible what is already chosen, loaded or on the disk (see ModelMenu).

import { MODEL_INFO } from './modelNames';

/**
 * A card reports its memory a little under its label: "8 GB" shows as 7.6 to 7.9 once the driver has taken its share, and 6 GB as 5.8. Without a margin,
 * such a card would lose the models made for it.
 */
export const VRAM_TOLERANCE_GB = 0.5;

/** The announced minimum of `modelId` in GB, or null when nothing is known about it. */
export function vramNeeded(modelId: string): number | null {
  if (!Object.prototype.hasOwnProperty.call(MODEL_INFO, modelId)) return null;
  const need = MODEL_INFO[modelId].vramMin;
  return Number.isFinite(need) && need > 0 ? need : null;
}

/** True only when the card's memory is known AND the model announces more than it has (within the tolerance). */
export function needsMoreVram(modelId: string, vramGb: number | null | undefined): boolean {
  if (typeof vramGb !== 'number' || !Number.isFinite(vramGb) || vramGb <= 0) return false;
  const need = vramNeeded(modelId);
  return need !== null && need > vramGb + VRAM_TOLERANCE_GB;
}

/** « 8 » for 8, « 7.6 » for 7.6: a whole number is written without its decimal. */
export function formatGb(gb: number): string {
  const rounded = Math.round(gb * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/**
 * Splits the menu's models: `tooBig` are those the card cannot run well and nothing keeps visible; `fitting` is everything else, in the same order.
 * `keep(id)` is true for a model that must stay listed whatever its size (the selected one, the loaded one, the ones already on the disk).
 */
export function splitByVram<T extends { id: string }>(models: readonly T[], vramGb: number | null | undefined, keep: (id: string) => boolean): { fitting: T[]; tooBig: T[] } {
  const fitting: T[] = [];
  const tooBig: T[] = [];
  for (const model of models) (needsMoreVram(model.id, vramGb) && !keep(model.id) ? tooBig : fitting).push(model);
  return { fitting, tooBig };
}
