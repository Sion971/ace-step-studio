import { isTurboModel } from './modelNames';

/**
 * Saved settings that belong to the model, not to the user.
 *
 * The Create tab sets them each time the model changes (Turbo: shift 3 and DCW on; Base, SFT and merges:
 * shift 1 and DCW off). The settings saved on the server are reloaded a moment after that, and they carry
 * the values of the last model used: after a session on a merge, the Turbo came back with shift 1 and no DCW,
 * which gave artifacts. These keys are therefore not restored, like the steps and the guidance already were.
 * The sampler and the scheduler are kept, except on a Turbo, which only runs Euler with the linear schedule.
 */
const ALWAYS_FROM_MODEL = ['shift', 'dcwEnabled'] as const;
const TURBO_ONLY_EULER = ['samplerMode', 'schedulerType'] as const;

export function withoutModelSettings<T extends Record<string, unknown>>(saved: T, modelId: string): T {
  const kept: Record<string, unknown> = { ...saved };
  for (const key of ALWAYS_FROM_MODEL) delete kept[key];
  if (isTurboModel(modelId)) for (const key of TURBO_ONLY_EULER) delete kept[key];
  return kept as T;
}
