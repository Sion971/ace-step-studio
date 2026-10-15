// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { trainedParts, type InstalledLoraDto } from '../services/loraHub';
import { en } from '../i18n/en';
import { fillTemplate } from '../utils/fillTemplate';

const t = (key: string) => (en as Record<string, string>)[key] ?? key;
const base: InstalledLoraDto = {
  name: 'mady-lokr', path: './lora_output/mady-lokr', repo: null, revision: null, file: null, sha256: null, installedAt: null, license: null,
  baseModel: ['acestep-v15-xl-base'], triggerWord: 'mady-style', recommended: { scale: null, steps: null, guidance: null, shift: null },
};

describe('what the LoRA menu says about a LoRA trained in the Studio', () => {
  it('names the model it needs, the adapter, its size, the epochs and the dataset', () => {
    const parts = trainedParts({ ...base, source: 'studio-training', training: { adapterType: 'lokr', rank: 16, alpha: 32, epochs: 100, datasetName: 'mady', samples: 3, trainedAt: null, modelVariant: 'xl_base' } }, t as any);
    expect(parts).toEqual([
      fillTemplate(t('loraHubNeeds'), { model: 'acestep-v15-xl-base' }),
      'LoKr',
      fillTemplate(t('loraHubAdapter'), { rank: 16 }),
      fillTemplate(t('loraHubEpochs'), { count: 100 }),
      fillTemplate(t('loraHubDataset'), { name: 'mady' }),
    ]);
  });

  it('leaves out what is unknown, and says nothing for a LoRA from the catalog', () => {
    expect(trainedParts({ ...base, baseModel: [], training: { adapterType: 'lora', rank: null, alpha: null, epochs: null, datasetName: null, samples: null, trainedAt: null, modelVariant: null } }, t as any)).toEqual(['LoRA']);
    expect(trainedParts(base, t as any)).toEqual([]);
  });
});
