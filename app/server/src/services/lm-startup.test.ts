// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { startupLmModel } from './lm-startup.js';

describe('startupLmModel', () => {
  it('is the 0.6B when nothing is set', () => {
    expect(startupLmModel({})).toBe('acestep-5Hz-lm-0.6B');
    expect(startupLmModel({ LM_MODEL: '  ', ACESTEP_LM_MODEL_PATH: '' })).toBe('acestep-5Hz-lm-0.6B');
  });
  it('reads LM_MODEL', () => {
    expect(startupLmModel({ LM_MODEL: 'acestep-5Hz-lm-1.7B' })).toBe('acestep-5Hz-lm-1.7B');
  });
  it('reads ACESTEP_LM_MODEL_PATH, the variable .env.example documents', () => {
    expect(startupLmModel({ ACESTEP_LM_MODEL_PATH: 'acestep-5Hz-lm-1.7B' })).toBe('acestep-5Hz-lm-1.7B');
  });
  it('lets LM_MODEL win over ACESTEP_LM_MODEL_PATH', () => {
    expect(startupLmModel({ LM_MODEL: 'acestep-5Hz-lm-4B', ACESTEP_LM_MODEL_PATH: 'acestep-5Hz-lm-1.7B' })).toBe('acestep-5Hz-lm-4B');
  });
});
