// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { listAvailableLoras } from './lora-available.js';

describe('listAvailableLoras', () => {
  let dir: string;
  const put = (rel: string) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), 'x');
  };
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'lora-available-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('is empty when the folder does not exist', () => {
    expect(listAvailableLoras(path.join(dir, 'nope'))).toEqual([]);
  });

  it('lists a complete LoRA, and a LoKr by its weights file alone', () => {
    put('rock/adapter_config.json');
    put('rock/adapter_model.safetensors');
    put('rock-lokr/lokr_weights.safetensors');
    expect(listAvailableLoras(dir)).toEqual([
      { name: 'rock', path: './lora_output/rock' },
      { name: 'rock-lokr', path: './lora_output/rock-lokr', adapterType: 'lokr' },
    ]);
  });

  it('skips checkpoints, runs, incomplete folders and loose files', () => {
    put('checkpoints/epoch_1/adapter_model.safetensors');
    put('runs/events.out');
    put('half/adapter_config.json');
    put('only-weights/adapter_model.safetensors');
    put('training_info.json');
    expect(listAvailableLoras(dir)).toEqual([]);
  });

  it('renames a single oddly named weights file next to its config, and only then', () => {
    put('hub/adapter_config.json');
    put('hub/lo_fi-v1.safetensors');
    put('two/adapter_config.json');
    put('two/a.safetensors');
    put('two/b.safetensors');
    expect(listAvailableLoras(dir).map((l) => l.name)).toEqual(['hub']);
    expect(existsSync(path.join(dir, 'hub/adapter_model.safetensors'))).toBe(true);
    expect(existsSync(path.join(dir, 'two/a.safetensors'))).toBe(true);
  });
});
