// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// The pipeline child process is not started in unit tests: guard the wiring on the source instead.
describe('pipeline manager in small-card stream mode', () => {
  const source = readFileSync(resolve(__dirname, 'pipeline-manager.ts'), 'utf-8');

  it('asks the engine for the stream mode only when the install chose it', () => {
    expect(source).toContain("import { isCpuMode, isStreamMode } from './hardware-mode.js';");
    expect(source).toMatch(/\.\.\.\(isStreamMode\(\) \? \{ ACESTEP_SMALL_GPU_STREAM: '1' \} : \{\}\)/);
  });
});
