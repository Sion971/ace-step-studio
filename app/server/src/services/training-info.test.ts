// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { baseModelFor, loadTrainingInfo, readDatasetInfo, readTrainedRecord, recordTrainingStart } from './training-info.js';

describe('training info', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'training-info-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const manifest = (meta: object, samples = 3) => {
    mkdirSync(path.join(dir, 'datasets/tensors'), { recursive: true });
    writeFileSync(path.join(dir, 'datasets/tensors/manifest.json'), JSON.stringify({ metadata: meta, samples: [], num_samples: samples }));
  };

  it('maps the training variants to the Studio models', () => {
    expect(baseModelFor('base')).toBe('acestep-v15-base');
    expect(baseModelFor('xl_turbo')).toBe('acestep-v15-xl-turbo');
    expect(baseModelFor('acestep-v15-xl-sft')).toBe('acestep-v15-xl-sft');
    expect(baseModelFor('my-finetune')).toBeNull();
    expect(baseModelFor(undefined)).toBeNull();
  });

  it('reads the trigger word, name and size from the manifest of the tensors', () => {
    manifest({ name: 'mady', custom_tag: ' mady-style ' });
    expect(readDatasetInfo(path.join(dir, 'datasets/tensors'))).toEqual({ name: 'mady', trigger: 'mady-style', samples: 3 });
    expect(readDatasetInfo(path.join(dir, 'nowhere'))).toEqual({ name: null, trigger: null, samples: null });
  });

  it('records a run at its start, relative paths resolved from the ACE-Step folder', () => {
    manifest({ name: 'mady', custom_tag: 'mady-style' });
    const info = recordTrainingStart(
      { tensorDir: './datasets/tensors', outputDir: './lora_output', modelVariant: 'xl_base', adapterType: 'lokr', rank: 16, alpha: 32, epochs: 50, learningRate: 0.0001 },
      dir,
      new Date('2026-10-15T01:00:00Z'),
    );
    expect(info).toMatchObject({ adapterType: 'lokr', baseModel: 'acestep-v15-xl-base', rank: 16, alpha: 32, epochs: 50, datasetName: 'mady', trigger: 'mady-style', samples: 3 });
    expect(loadTrainingInfo(path.join(dir, 'lora_output'))).toEqual(info);
  });

  it('works without a manifest: the run is recorded, with no trigger word', () => {
    const info = recordTrainingStart({}, dir);
    expect(info.trigger).toBeNull();
    expect(info.adapterType).toBe('lora');
    expect(loadTrainingInfo(path.join(dir, 'lora_output'))).not.toBeNull();
  });

  it('reads a damaged or hostile record as nothing', () => {
    const out = path.join(dir, 'lora_output');
    mkdirSync(out, { recursive: true });
    for (const bad of ['not json', '[]', JSON.stringify({ startedAt: 'yesterday' }), JSON.stringify({})]) {
      writeFileSync(path.join(out, 'training_info.json'), bad);
      expect(loadTrainingInfo(out), bad).toBeNull();
    }
    writeFileSync(path.join(out, 'training_info.json'), JSON.stringify({ startedAt: '2026-10-15T01:00:00Z', trigger: '<b>x</b>'.repeat(30), rank: 'big', epochs: -3 }));
    const info = loadTrainingInfo(out)!;
    expect(info.trigger).not.toMatch(/[<>]/);
    expect((info.trigger ?? '').length).toBeLessThanOrEqual(60);
    expect(info.rank).toBeNull();
    expect(info.epochs).toBeNull();
  });

  it('shows training details only for what the Studio itself recorded', () => {
    expect(readTrainedRecord({ source: 'huggingface', training: { rank: 16 } })).toEqual({});
    expect(readTrainedRecord({})).toEqual({});
    expect(readTrainedRecord({ source: 'studio-training', training: { adapterType: 'lokr', rank: 16, epochs: 'many', datasetName: 'x' } })).toEqual({
      source: 'studio-training',
      training: { adapterType: 'lokr', rank: 16, alpha: null, epochs: null, datasetName: 'x', samples: null, trainedAt: null, modelVariant: null },
    });
  });
});
