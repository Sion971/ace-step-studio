import { describe, it, expect } from 'vitest';
import { classifyGenerationFailure, friendlyTimeoutMessage } from './generation-errors.js';

const ACE_TIMEOUT =
  'Music generation timed out after 600 seconds.  This usually means the GPU ran out of VRAM or the ' +
  'diffusion loop stalled.  Try reducing batch size, duration, or inference steps.';

describe('classifyGenerationFailure', () => {
  it('reports ACE-Step\'s timeout as a timeout, although its text mentions VRAM', () => {
    expect(ACE_TIMEOUT).toContain('VRAM');
    expect(classifyGenerationFailure(ACE_TIMEOUT)).toBe('timeout');
  });

  it('still reports a real out-of-memory error', () => {
    expect(classifyGenerationFailure('Insufficient free VRAM: need ~3.2 GB, only 1.9 GB available')).toBe('out-of-memory');
    expect(classifyGenerationFailure('CUDA out of memory (VRAM exhausted)')).toBe('out-of-memory');
  });

  it('leaves other errors alone', () => {
    expect(classifyGenerationFailure('Cannot set version_counter for inference tensor')).toBe('other');
    expect(classifyGenerationFailure('')).toBe('other');
  });

  it('matches whatever limit was configured', () => {
    expect(classifyGenerationFailure('Music generation timed out after 3600 seconds.')).toBe('timeout');
  });
});

describe('friendlyTimeoutMessage', () => {
  it('keeps the configured limit and no longer blames the GPU memory', () => {
    const text = friendlyTimeoutMessage(ACE_TIMEOUT);
    expect(text).toContain('timed out after 600 seconds');
    expect(text).toContain('ACESTEP_GENERATION_TIMEOUT');
    expect(text).not.toContain('ran out of VRAM');
  });

  it('copes with an unexpected message', () => {
    expect(friendlyTimeoutMessage('boom')).toContain('after ? seconds');
  });
});
