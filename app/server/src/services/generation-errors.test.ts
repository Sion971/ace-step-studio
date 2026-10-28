import { describe, it, expect } from 'vitest';
import {
  classifyGenerationFailure,
  friendlyTimeoutMessage,
  isFatalCudaError,
  isCudaError,
  CudaFailureTracker,
  friendlyCudaRestartMessage,
} from './generation-errors.js';

const ACE_TIMEOUT =
  'Music generation timed out after 600 seconds.  This usually means the GPU ran out of VRAM or the ' +
  'diffusion loop stalled.  Try reducing batch size, duration, or inference steps.';

describe('classifyGenerationFailure', () => {
  it('recognises the engine\'s answer to a cancel', () => {
    expect(classifyGenerationFailure('Gradio generation returned no audio files. Status: Error: Generation cancelled. Details: none')).toBe('cancelled');
  });

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

const STICKY =
  'CUDA error: out of memory\nSearch for `cudaErrorMemoryAllocation` in https://docs.nvidia.com for more information.\n' +
  'The CUDA driver logged these messages, which may provide useful details:\nSticky error detected\n' +
  'Returning 2 (CUDA_ERROR_OUT_OF_MEMORY) from cuCtxSynchronize_v2';

describe('isFatalCudaError', () => {
  it('recognises a lost CUDA context', () => {
    expect(isFatalCudaError(STICKY)).toBe(true);
    expect(isFatalCudaError('CUDA error: an illegal memory access was encountered')).toBe(true);
    expect(isFatalCudaError('CUDA error: device-side assert triggered')).toBe(true);
    expect(isFatalCudaError('Returning 700 (CUDA_ERROR_ILLEGAL_ADDRESS) from cuMemcpyDtoHAsync_v2')).toBe(true);
  });

  it('leaves a plain allocation failure alone: the next generation can succeed', () => {
    expect(isFatalCudaError('CUDA out of memory. Tried to allocate 2.00 GiB')).toBe(false);
    expect(isFatalCudaError('Insufficient free VRAM: need ~3.2 GB, only 1.9 GB available')).toBe(false);
    expect(isFatalCudaError(ACE_TIMEOUT)).toBe(false);
    expect(isFatalCudaError('')).toBe(false);
  });
});

describe('isCudaError', () => {
  it('matches errors of the CUDA runtime and its libraries, not a plain out-of-memory', () => {
    expect(isCudaError('CUDA error: out of memory')).toBe(true);
    expect(isCudaError('torch.AcceleratorError: something')).toBe(true);
    expect(isCudaError('CUBLAS_STATUS_EXECUTION_FAILED when calling cublasGemmEx')).toBe(true);
    expect(isCudaError('CUDA out of memory. Tried to allocate 2.00 GiB')).toBe(false);
    expect(isCudaError('Cannot set version_counter for inference tensor')).toBe(false);
  });
});

describe('CudaFailureTracker', () => {
  it('asks for a restart at once on a fatal error', () => {
    expect(new CudaFailureTracker().failed(STICKY)).toBe(true);
  });

  it('asks for one after two CUDA errors in a row, not after one', () => {
    const tracker = new CudaFailureTracker();
    expect(tracker.failed('CUDA error: out of memory')).toBe(false);
    expect(tracker.failed('CUDA error: out of memory')).toBe(true);
    expect(tracker.failed('CUDA error: out of memory')).toBe(false); // counting starts again after a restart request
  });

  it('forgets earlier CUDA errors after a success or a different failure', () => {
    const tracker = new CudaFailureTracker();
    tracker.failed('CUDA error: out of memory');
    tracker.succeeded();
    expect(tracker.failed('CUDA error: out of memory')).toBe(false);
    tracker.failed('Generation timed out after 600 seconds.');
    expect(tracker.failed('CUDA error: out of memory')).toBe(false);
  });

  it('never restarts for errors that are not CUDA errors', () => {
    const tracker = new CudaFailureTracker();
    for (let i = 0; i < 5; i++) expect(tracker.failed('Cannot set version_counter for inference tensor')).toBe(false);
  });
});

describe('friendlyCudaRestartMessage', () => {
  it('tells the person the card is to blame and that the queue goes on, keeping the first line of the cause', () => {
    const text = friendlyCudaRestartMessage(STICKY);
    expect(text).toContain('restarts by itself');
    expect(text).toContain('CUDA error: out of memory');
    expect(text).not.toContain('cuCtxSynchronize');
  });
});
