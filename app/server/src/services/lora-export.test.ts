// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from 'fs';
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
  const record = (over: object = {}) =>
    put('lora_output/training_info.json', JSON.stringify({
      startedAt: new Date(Date.now() - 60_000).toISOString(), adapterType: 'lora', modelVariant: 'base', baseModel: 'acestep-v15-base',
      rank: 16, alpha: 32, epochs: 100, learningRate: 0.0001, datasetName: 'mady', trigger: 'mady-style', samples: 3, ...over,
    }));
  const hub = (rel: string) => JSON.parse(readFileSync(path.join(base, rel, 'lora_hub.json'), 'utf8'));

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
    expect(out.listed).toBe(false); // nothing recorded, nothing to list
    expect(existsSync(path.join(out.destination, 'lora_hub.json'))).toBe(false);
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

  it('leaves the other adapter type\'s leftovers out of the export', async () => {
    record({ adapterType: 'lora' });
    put('lora_output/final/adapter_model.safetensors', 'lora');
    put('lora_output/final/adapter_config.json', '{}');
    put('lora_output/final/lokr_weights.safetensors', 'old lokr');
    const lora = await exportLora({ baseDir: base, exportPath: 'out/a' });
    expect(existsSync(path.join(lora.destination, 'lokr_weights.safetensors'))).toBe(false);
    expect(readFileSync(path.join(lora.destination, 'adapter_model.safetensors'), 'utf8')).toBe('lora');

    record({ adapterType: 'lokr' });
    const lokr = await exportLora({ baseDir: base, exportPath: 'out/b' });
    expect(existsSync(path.join(lokr.destination, 'adapter_model.safetensors'))).toBe(false);
    expect(existsSync(path.join(lokr.destination, 'adapter_config.json'))).toBe(false);
    expect(readFileSync(path.join(lokr.destination, 'lokr_weights.safetensors'), 'utf8')).toBe('old lokr');
  });

  it('without a record, keeps the newer of the two weights files', async () => {
    put('lora_output/final/adapter_model.safetensors', 'old lora');
    put('lora_output/final/adapter_config.json', '{}');
    put('lora_output/final/lokr_weights.safetensors', 'new lokr');
    const past = new Date(Date.now() - 3600_000);
    utimesSync(path.join(base, 'lora_output/final/adapter_model.safetensors'), past, past);
    const out = await exportLora({ baseDir: base, exportPath: 'out/c' });
    expect(existsSync(path.join(out.destination, 'adapter_model.safetensors'))).toBe(false);
    expect(existsSync(path.join(out.destination, 'lokr_weights.safetensors'))).toBe(true);
  });

  it('says so when nothing is trained yet', async () => {
    mkdirSync(path.join(base, 'lora_output'), { recursive: true });
    await expect(exportLora({ baseDir: base, exportPath: 'out/lora' })).rejects.toThrow(/No trained LoRA found/);
    await expect(exportLora({ baseDir: base, exportPath: 'out/lora' })).rejects.toBeInstanceOf(LoraExportError);
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

  it('lists the export with its trigger word, base model and training when the run was recorded', async () => {
    put('lora_output/final/adapter_model.safetensors', 'w');
    put('lora_output/final/adapter_config.json', '{}');
    record();
    const out = await exportLora({ baseDir: base, exportPath: 'lora_output/mady-v1' });
    expect(out.listed).toBe(true);
    const rec = hub('lora_output/mady-v1');
    expect(rec.source).toBe('studio-training');
    expect(rec.repo).toBeNull();
    expect(rec.file).toBe('adapter_model.safetensors');
    expect(rec.baseModel).toEqual(['acestep-v15-base']);
    expect(rec.sidecar.triggerWord).toBe('mady-style');
    expect(rec.training).toMatchObject({ adapterType: 'lora', rank: 16, alpha: 32, epochs: 100, datasetName: 'mady', samples: 3 });
  });

  it('ignores a record older than the weights: another run may have written them', async () => {
    put('lora_output/final/adapter_model.safetensors', 'w');
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(path.join(base, 'lora_output/final/adapter_model.safetensors'), old, old);
    record(); // started a minute ago, after those weights were written
    const out = await exportLora({ baseDir: base, exportPath: 'lora_output/stale' });
    expect(out.listed).toBe(false);
    expect(existsSync(path.join(out.destination, 'lora_hub.json'))).toBe(false);
  });

  it('names the export after the dataset and the adapter when no path is given, never reusing a name', async () => {
    put('lora_output/final/lokr_weights.safetensors', 'w');
    record({ adapterType: 'lokr' });
    const first = await exportLora({ baseDir: base, exportPath: '   ' });
    expect(first.destination).toBe(path.join(base, 'lora_output', 'mady-lokr'));
    const second = await exportLora({ baseDir: base });
    expect(second.destination).toBe(path.join(base, 'lora_output', 'mady-lokr-2'));
    expect(hub('lora_output/mady-lokr').file).toBe('lokr_weights.safetensors');
    expect(hub('lora_output/mady-lokr').training.adapterType).toBe('lokr');
  });

  it('falls back to a generic name when nothing is known about the run', async () => {
    put('lora_output/final/adapter_model.safetensors');
    const out = await exportLora({ baseDir: base });
    expect(out.destination).toBe(path.join(base, 'lora_output', 'trained-lora'));
  });

  it('refuses to overwrite a LoRA installed from the catalog, but re-exports over its own earlier export', async () => {
    put('lora_output/final/adapter_model.safetensors');
    put('lora_output/lofi/adapter_model.safetensors');
    put('lora_output/lofi/lora_hub.json', JSON.stringify({ schema: 1, source: 'huggingface', repo: 'a/b' }));
    await expect(exportLora({ baseDir: base, exportPath: 'lora_output/lofi' })).rejects.toThrow(/installed from the catalog/);
    expect(existsSync(path.join(base, 'lora_output/lofi/lora_hub.json'))).toBe(true);

    record();
    await exportLora({ baseDir: base, exportPath: 'lora_output/mine' });
    await expect(exportLora({ baseDir: base, exportPath: 'lora_output/mine' })).resolves.toMatchObject({ listed: true });
  });
});
