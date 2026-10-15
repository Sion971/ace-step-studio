// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { engineDownMessage } from './gradio-value.js';

describe('engineDownMessage', () => {
  it('recognises the Gradio client error seen when the engine is stopped', () => {
    const err = { type: 'status', stage: 'error', broken: true, message: 'Connection errored out. ', endpoint: '/export_lora' };
    expect(engineDownMessage(err)).toMatch(/engine is not reachable/);
  });

  it('recognises network failures of Node', () => {
    expect(engineDownMessage(new Error('fetch failed'))).not.toBeNull();
    expect(engineDownMessage(Object.assign(new Error('x'), { cause: { code: 'ECONNREFUSED' } }))).not.toBeNull();
    expect(engineDownMessage('connect ECONNRESET 127.0.0.1:7860')).not.toBeNull();
  });

  it('leaves real engine errors alone', () => {
    expect(engineDownMessage(new Error('Dataset not found'))).toBeNull();
    expect(engineDownMessage({ message: 'CUDA out of memory' })).toBeNull();
    expect(engineDownMessage(undefined)).toBeNull();
  });
});
