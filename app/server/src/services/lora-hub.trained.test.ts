// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { LoraHub } from './lora-hub.js';
import { writeTrainedLoraRecord, type TrainingInfo } from './training-info.js';

describe('LoRA trained in the Studio, in the installed list', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'lora-hub-trained-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const info: TrainingInfo = {
    startedAt: '2026-10-15T01:00:00.000Z', adapterType: 'lokr', modelVariant: 'xl_base', baseModel: 'acestep-v15-xl-base',
    rank: 16, alpha: 32, epochs: 100, learningRate: 0.0001, datasetName: 'mady', trigger: 'mady-style', samples: 3,
  };

  it('lists an exported LoRA with its trigger word, base model and training', () => {
    const folder = path.join(dir, 'mady-lokr');
    mkdirSync(folder);
    writeFileSync(path.join(folder, 'lokr_weights.safetensors'), 'w');
    writeTrainedLoraRecord(folder, info);
    const [entry] = new LoraHub({ loraDir: dir }).listInstalled();
    expect(entry).toMatchObject({
      name: 'mady-lokr', path: './lora_output/mady-lokr', repo: null, file: 'lokr_weights.safetensors', baseModel: ['acestep-v15-xl-base'],
      triggerWord: 'mady-style', source: 'studio-training',
      training: { adapterType: 'lokr', rank: 16, epochs: 100, datasetName: 'mady', samples: 3 },
    });
  });

  it('does not add training fields to a LoRA installed from the catalog', () => {
    const folder = path.join(dir, 'lofi');
    mkdirSync(folder);
    writeFileSync(path.join(folder, 'lora_hub.json'), JSON.stringify({ schema: 1, source: 'huggingface', repo: 'a/b', training: { rank: 9 } }));
    const [entry] = new LoraHub({ loraDir: dir }).listInstalled();
    expect(entry.repo).toBe('a/b');
    expect(entry).not.toHaveProperty('training');
    expect(entry).not.toHaveProperty('source');
  });
});
