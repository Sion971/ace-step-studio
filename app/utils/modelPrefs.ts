/**
 * Steps and guidance chosen by the user, remembered for each model.
 *
 * The Create tab puts the model's defaults when the model changes (Turbo 8 steps, Base / SFT / merges
 * 50 steps and guidance 7). A value the user then sets by hand is kept for that model and comes back
 * the next time it is chosen, even after a restart: a Base/Turbo merge can stay at 24 steps and
 * guidance 3 while the Turbo keeps its 8 steps. Stored in the browser (localStorage), like the
 * selected model.
 */
export interface ModelPrefs {
  inferenceSteps?: number;
  guidanceScale?: number;
}

export const MODEL_PREFS_KEY = 'ace-model-prefs';

type Store = Pick<Storage, 'getItem' | 'setItem'>;

function readAll(store: Store): Record<string, ModelPrefs> {
  try {
    const parsed = JSON.parse(store.getItem(MODEL_PREFS_KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The values remembered for this model; only valid numbers are returned. */
export function getModelPrefs(modelId: string, store: Store = localStorage): ModelPrefs {
  const saved = readAll(store)[modelId] || {};
  const prefs: ModelPrefs = {};
  if (isNumber(saved.inferenceSteps)) prefs.inferenceSteps = saved.inferenceSteps;
  if (isNumber(saved.guidanceScale)) prefs.guidanceScale = saved.guidanceScale;
  return prefs;
}

/** Remembers a value the user set by hand for this model; the other values are kept. */
export function rememberModelPref(modelId: string, pref: ModelPrefs, store: Store = localStorage): void {
  if (!modelId) return;
  try {
    const all = readAll(store);
    all[modelId] = { ...all[modelId], ...pref };
    store.setItem(MODEL_PREFS_KEY, JSON.stringify(all));
  } catch {
    // storage full or blocked: the defaults keep working
  }
}
