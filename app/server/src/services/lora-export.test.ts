// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { exportLora, findTrainedLora, LoraExportError } from './lora-export.js';

describe('LoRA export by file copy', () => {
  let base: string;
  const put = (rel: string, content = 'x') => {
    const file = path.join(base, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  };

  beforeEach(() => { base = mkdtempSync(path.join(tmpdir(), 'lora-export-')); });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('copies the final folder', async () => {
    put('lora_output/final/adapter_model.safetensors', 'weights');
    put('lora_output/final/adapter_config.json', '{}');
    const out = await exportLora({ baseDir: base, exportPath: './lora_output/mon_lora', loraOutputDir: './lora_output' });
    expect(out.destination).toBe(path.join(base, 'lora_output', 'mon_lora'));
    expect(readFileSync(path.join(out.destination, 'adapter_model.safetensors'), 'utf8')).toBe('weights');
    expect(existsSync(path.join(out.destination, 'adapter_config.json'))).toBe(true);
    expect(existsSync(path.join(base, 'lora_output/final/adapter_model.safetensors'))).toBe(true);
  });

  it('falls back to the newest checkpoint, compared as numbers, when final is missing or empty', async () => {
    mkdirSync(path.join(base, 'lora_output/final'), { recursive: true });
    put('lora_output/checkpoints/epoch_9/a.safetensors', 'nine');
    put('lora_output/checkpoints/epoch_10/a.safetensors', 'ten');
    put('lora_output/checkpoints/notes/readme.txt');
    expect(findTrainedLora(path.join(base, 'lora_output'))).toBe(path.join(base, 'lora_output/checkpoints/epoch_10'));
    const out = await exportLora({ baseDir: base, exportPath: 'out/lora', loraOutputDir: 'lora_output' });
    expect(readFileSync(path.join(out.destination, 'a.safetensors'), 'utf8')).toBe('ten');
  });

  it('replaces an earlier export instead of mixing the two', async () => {
    put('lora_output/final/new.safetensors');
    put('out/lora/old.safetensors');
    await exportLora({ baseDir: base, exportPath: 'out/lora' });
    expect(existsSync(path.join(base, 'out/lora/old.safetensors'))).toBe(false);
    expect(existsSync(path.join(base, 'out/lora/new.safetensors'))).toBe(true);
  });

  it('says so when nothing is trained yet', async () => {
    mkdirSync(path.join(base, 'lora_output'), { recursive: true });
    await expect(exportLora({ baseDir: base, exportPath: 'out/lora' })).rejects.toThrow(/No trained LoRA found/);
    await expect(exportLora({ baseDir: base, exportPath: 'out/lora' })).rejects.toBeInstanceOf(LoraExportError);
  });

  it('requires an export path', async () => {
    put('lora_output/final/a.safetensors');
    await expect(exportLora({ baseDir: base, exportPath: '   ' })).rejects.toThrow(/Export path is required/);
  });

  it('refuses to leave the ACE-Step folder', async () => {
    put('lora_output/final/a.safetensors');
    await expect(exportLora({ baseDir: base, exportPath: '../elsewhere' })).rejects.toThrow(/must stay inside/);
    await expect(exportLora({ baseDir: base, exportPath: path.join(tmpdir(), 'elsewhere') })).rejects.toThrow(/must stay inside/);
    await expect(exportLora({ baseDir: base, exportPath: 'x', loraOutputDir: '../other' })).rejects.toThrow(/must stay inside/);
  });

  it('never empties the trained adapter or a folder that contains it', async () => {
    put('lora_output/final/a.safetensors', 'keep');
    for (const target of ['lora_output/final', 'lora_output', '.', 'lora_output/final/inner']) {
      await expect(exportLora({ baseDir: base, exportPath: target }), target).rejects.toThrow(/overwrite the trained LoRA/);
    }
    expect(readFileSync(path.join(base, 'lora_output/final/a.safetensors'), 'utf8')).toBe('keep');
  });
});
