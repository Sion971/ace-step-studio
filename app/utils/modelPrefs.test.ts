import { describe, expect, it } from 'vitest';
import { MODEL_PREFS_KEY, getModelPrefs, rememberModelPref } from './modelPrefs';

function memoryStore(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => { data[k] = v; },
    data,
  };
}

const MERGE = 'acestep-v15-xl-merge-base-turbo30';
const TURBO = 'acestep-v15-xl-turbo-bf16';

describe('steps and guidance remembered per model', () => {
  it('returns nothing for a model never adjusted', () => {
    expect(getModelPrefs(MERGE, memoryStore())).toEqual({});
  });

  it('keeps each value per model, the second one not erasing the first', () => {
    const store = memoryStore();
    rememberModelPref(MERGE, { inferenceSteps: 24 }, store);
    rememberModelPref(MERGE, { guidanceScale: 3 }, store);
    rememberModelPref(TURBO, { inferenceSteps: 8 }, store);
    expect(getModelPrefs(MERGE, store)).toEqual({ inferenceSteps: 24, guidanceScale: 3 });
    expect(getModelPrefs(TURBO, store)).toEqual({ inferenceSteps: 8 });
  });

  it('ignores a damaged or odd saved value', () => {
    expect(getModelPrefs(MERGE, memoryStore({ [MODEL_PREFS_KEY]: '{not json' }))).toEqual({});
    const odd = memoryStore({ [MODEL_PREFS_KEY]: JSON.stringify({ [MERGE]: { inferenceSteps: 'x', guidanceScale: 4 } }) });
    expect(getModelPrefs(MERGE, odd)).toEqual({ guidanceScale: 4 });
  });

  it('survives a storage that refuses to write', () => {
    const store = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
    expect(() => rememberModelPref(MERGE, { inferenceSteps: 24 }, store)).not.toThrow();
  });
});
