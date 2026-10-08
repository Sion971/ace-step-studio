// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { adapterSafeName, describeLoadFailure, folderNameOf } from './lora-engine-status.js';

// the message the engine really sent (Firefox console, 2026-10-08)
const REAL_FAILURE = `❌ Failed to load LoRA: 'module name can\\'t contain ".", got: lo_fi-acestep1.5-v1'`;

describe('describeLoadFailure', () => {
  it('takes a reply that does not announce a failure for a success, as before', () => {
    for (const status of ['✅ LoRA loaded from ./lora_output/final', 'LoRA loaded', '', undefined, null, 42, {}]) {
      expect(describeLoadFailure(status, './lora_output/final'), String(status)).toBeNull();
    }
  });

  it('does not take a refusal for a success', () => {
    for (const status of ['❌ Failed to load LoRA: boom', '  ❌ No model loaded', '✗ nope', 'Failed to load LoRA: boom', 'failed to load adapter']) {
      expect(describeLoadFailure(status, './lora_output/final'), status).not.toBeNull();
    }
  });

  it('says what the engine said, without its mark, when it is not about the name', () => {
    expect(describeLoadFailure('❌ Failed to load LoRA: size mismatch for lora_A', './lora_output/final')).toEqual({ code: 'lora_load_failed', message: 'Failed to load LoRA: size mismatch for lora_A' });
    expect(describeLoadFailure('❌', './lora_output/final')).toEqual({ code: 'lora_load_failed', message: 'The engine could not load this LoRA.' });
  });

  it('explains the real failure: which folder, and what to call it instead', () => {
    const failure = describeLoadFailure(REAL_FAILURE, './lora_output/lo_fi-acestep1.5-v1');
    expect(failure).toMatchObject({ code: 'invalid_adapter_name' });
    const message = (failure as { message: string }).message;
    expect(message).toContain('"lo_fi-acestep1.5-v1"');
    expect(message).toContain('Rename the folder to "lo_fi-acestep1_5-v1"');
    expect(message).toContain('lora_output');
  });

  it('blames the name only when the engine says so AND the folder has a dot: never on a guess', () => {
    expect(describeLoadFailure(`❌ Failed to load LoRA: 'module name can\\'t contain ".", got: x'`, './lora_output/final')).toMatchObject({ code: 'lora_load_failed' }); // no dot in this folder
    expect(describeLoadFailure('❌ Failed to load LoRA: out of memory', './lora_output/a.b')).toMatchObject({ code: 'lora_load_failed' }); // a dot, but not the cause
  });

  it('recognizes the message with the backslash that Python puts before the apostrophe, and without it', () => {
    const withBackslash = `❌ Failed to load LoRA: 'module name can\\'t contain ".", got: a.b'`;
    const without = `❌ Failed to load LoRA: module name can't contain ".", got: a.b`;
    for (const text of [withBackslash, without]) expect(describeLoadFailure(text, './lora_output/a.b'), text).toMatchObject({ code: 'invalid_adapter_name' });
  });

  it('copes with Windows paths and a trailing slash', () => {
    expect(describeLoadFailure(REAL_FAILURE, '.\\lora_output\\my.lora\\')).toMatchObject({ code: 'invalid_adapter_name', message: expect.stringContaining('"my_lora"') });
  });
});

describe('folder names', () => {
  it('reads the folder name of a path', () => {
    expect(folderNameOf('./lora_output/final')).toBe('final');
    expect(folderNameOf('./lora_output/a.b/')).toBe('a.b');
    expect(folderNameOf('C:\\x\\y.z')).toBe('y.z');
    expect(folderNameOf('')).toBe('');
  });
  it('proposes a name without dots', () => {
    expect(adapterSafeName('lo_fi-acestep1.5-v1')).toBe('lo_fi-acestep1_5-v1');
    expect(adapterSafeName('final')).toBe('final');
    expect(adapterSafeName('a.b.c')).toBe('a_b_c');
  });
});
