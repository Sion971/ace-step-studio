// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { STUDIO_MODELS, checkCompatibility, describeModel, requiredBase, vramNeeded, type CardEvidence } from './lora-compat.js';

/** What the Hub, the adapter config and the author's metadata file said about a real LoRA (ryanontheinside/lo_fi-acestep1.5-v1). */
const LOFI: CardEvidence = {
  baseModel: ['AceStep v1.5 Turbo (2B)'],
  tags: ['peft', 'acestep', 'acestep-2b', 'audio', 'lo-fi', 'lora', 'music', 'text-to-audio'],
  adapter: { baseModel: 'acestep-v15-turbo' },
  sidecar: { baseModelRequired: 'AceStep v1.5 Turbo (2B)', baseModel: 'AceStep v1.5 Turbo', baseModelScale: '2B' },
};
const nothing: CardEvidence = { baseModel: [], tags: [], adapter: null, sidecar: null };
const evidence = (over: Partial<CardEvidence>): CardEvidence => ({ ...nothing, ...over });
const check = (card: CardEvidence, activeModel?: string | null, vramGb?: number | null) => checkCompatibility({ required: requiredBase(card), activeModel, vramGb });
const codes = (c: ReturnType<typeof check>) => c.reasons.map((r) => r.code);

describe('describeModel', () => {
  it('reads the Studio\'s own model ids', () => {
    expect(describeModel('acestep-v15-turbo')).toEqual({ family: 'turbo', size: '2B' });
    expect(describeModel('acestep-v15-base')).toEqual({ family: 'base', size: '2B' });
    expect(describeModel('acestep-v15-sft')).toEqual({ family: 'sft', size: '2B' });
    expect(describeModel('acestep-v15-xl-base')).toEqual({ family: 'base', size: 'XL' });
    expect(describeModel('acestep-v15-xl-turbo-bf16')).toEqual({ family: 'turbo', size: 'XL' });
    expect(describeModel('acestep-v15-xl-merge-sft-turbo')).toEqual({ family: 'other', size: 'XL' });
  });

  it('reads what a person writes', () => {
    expect(describeModel('AceStep v1.5 Turbo (2B)')).toEqual({ family: 'turbo', size: '2B' });
    expect(describeModel('ACE-Step 1.5 XL SFT')).toEqual({ family: 'sft', size: 'XL' });
    expect(describeModel('acestep-v15-xl-base (4B)')).toEqual({ family: 'base', size: 'XL' });
    expect(describeModel('ACE-Step/acestep-v15-turbo')).toEqual({ family: 'turbo', size: '2B' });
    expect(describeModel('/root/checkpoints/acestep-v15-turbo')).toEqual({ family: 'turbo', size: '2B' });
    expect(describeModel('some-merge-of-things')).toEqual({ family: 'other', size: null });
  });

  it('does not invent what it cannot read', () => {
    for (const text of [null, undefined, '', '   ', 'ACE-Step/Ace-Step1.5', 'my-custom-model', 'turbine', 'database', 'xlarge', 'b2b']) {
      const spec = describeModel(text as string);
      expect(spec, String(text)).toEqual({ family: null, size: null });
    }
    expect(describeModel('Turbo').family).toBe('turbo');
    expect(describeModel('Turbo').size).toBeNull();
  });
});

describe('requiredBase', () => {
  it('reads a real LoRA: every source agrees', () => {
    expect(requiredBase(LOFI)).toEqual({ family: 'turbo', size: '2B', label: 'AceStep v1.5 Turbo (2B)', sources: ['metadata file', 'repository', 'adapter config', 'tags'], conflict: false });
  });

  it('trusts the author\'s metadata first, then the repository, then the adapter config, then the tags', () => {
    expect(requiredBase(evidence({ sidecar: { baseModelRequired: 'x Base (2B)', baseModel: null, baseModelScale: null }, baseModel: ['acestep-v15-xl-turbo'] }))?.label).toBe('x Base (2B)');
    expect(requiredBase(evidence({ baseModel: ['AceStep Turbo (2B)'], adapter: { baseModel: 'acestep-v15-xl-base' } }))?.label).toBe('AceStep Turbo (2B)');
    expect(requiredBase(evidence({ adapter: { baseModel: 'acestep-v15-sft' }, tags: ['acestep-xl'] }))?.label).toBe('acestep-v15-sft');
  });

  it('builds the requirement from the metadata\'s two halves when it has no single sentence', () => {
    const spec = requiredBase(evidence({ sidecar: { baseModelRequired: null, baseModel: 'AceStep v1.5 Turbo', baseModelScale: '2B' } }));
    expect(spec).toMatchObject({ family: 'turbo', size: '2B' });
  });

  it('completes what one source leaves out with another', () => {
    expect(requiredBase(evidence({ baseModel: ['AceStep v1.5 Turbo'], tags: ['acestep-2b'] }))).toMatchObject({ family: 'turbo', size: '2B', conflict: false });
    expect(requiredBase(evidence({ tags: ['ACESTEP-XL'] }))).toMatchObject({ family: null, size: 'XL' });
  });

  it('says when sources contradict each other', () => {
    const spec = requiredBase(evidence({ sidecar: { baseModelRequired: 'AceStep v1.5 Turbo (2B)', baseModel: null, baseModelScale: null }, adapter: { baseModel: 'acestep-v15-xl-base' } }));
    expect(spec?.conflict).toBe(true);
    expect(spec).toMatchObject({ family: 'turbo', size: '2B' }); // the most trusted source still leads
    expect(requiredBase(evidence({ baseModel: ['acestep-v15-turbo'], adapter: { baseModel: 'acestep-v15-base' } }))?.conflict).toBe(true);
  });

  it('is null when nobody says anything about the size or the family', () => {
    expect(requiredBase(nothing)).toBeNull();
    expect(requiredBase(evidence({ baseModel: ['ACE-Step/Ace-Step1.5'], tags: ['peft', 'lora'], adapter: { baseModel: 'my-model' } }))).toBeNull();
  });
});

describe('checkCompatibility', () => {
  it('is compatible only when size and family are known on both sides and equal', () => {
    const result = check(LOFI, 'acestep-v15-turbo', 8);
    expect(result.verdict).toBe('compatible');
    expect(result.reasons).toEqual([]);
    expect(result.active).toMatchObject({ id: 'acestep-v15-turbo', family: 'turbo', size: '2B', vramMin: 6 });
  });

  it('refuses a size mismatch, because the layers do not fit', () => {
    for (const active of ['acestep-v15-xl-turbo', 'acestep-v15-xl-base', 'acestep-v15-xl-turbo-bf16', 'acestep-v15-xl-merge-sft-turbo']) {
      const result = check(LOFI, active);
      expect(result.verdict, active).toBe('incompatible');
      expect(result.reasons.find((r) => r.code === 'size_mismatch')).toMatchObject({ severity: 'blocking', params: { required: '2B', active: 'XL', activeModel: active } });
    }
    expect(check(evidence({ baseModel: ['acestep-v15-xl-turbo'] }), 'acestep-v15-turbo').verdict).toBe('incompatible');
  });

  it('warns, without refusing, when the family differs: it loads, but it was tuned for other steps', () => {
    for (const active of ['acestep-v15-base', 'acestep-v15-sft']) {
      const result = check(LOFI, active, 8);
      expect(result.verdict, active).toBe('warning');
      expect(result.reasons).toEqual([{ code: 'family_mismatch', severity: 'warning', params: { required: 'turbo', active: active.endsWith('base') ? 'base' : 'sft', activeModel: active } }]);
    }
    expect(check(evidence({ baseModel: ['acestep-v15-base'] }), 'acestep-v15-turbo').verdict).toBe('warning');
  });

  it('says "unknown" rather than guess when the requirement is missing', () => {
    const result = check(nothing, 'acestep-v15-turbo');
    expect(result.verdict).toBe('unknown');
    expect(result.required).toBeNull();
    expect(codes(result)).toEqual(['requirement_unknown']);
  });

  it('says "unknown" when there is no model to compare with, and still reports the requirement', () => {
    for (const active of [undefined, null, '', '  ']) {
      const result = check(LOFI, active as string | undefined);
      expect(result.verdict).toBe('unknown');
      expect(result.required).toMatchObject({ family: 'turbo', size: '2B' });
      expect(codes(result)).toEqual(['active_model_unknown']);
    }
  });

  it('says "unknown" when the comparison is incomplete, even if what is known matches', () => {
    const tagsOnly = check(evidence({ tags: ['acestep-2b'] }), 'acestep-v15-turbo');
    expect(tagsOnly.verdict).toBe('unknown');
    expect(codes(tagsOnly)).toEqual(['comparison_incomplete']);
    // a merged model has no single family
    const merged = check(evidence({ baseModel: ['acestep-v15-xl-turbo'] }), 'acestep-v15-xl-merge-sft-turbo');
    expect(merged.verdict).toBe('unknown');
    expect(codes(merged)).toContain('comparison_incomplete');
    // a model the Studio does not know
    expect(check(LOFI, 'my-custom-dit').verdict).toBe('unknown');
  });

  it('reports a disagreement between sources as a warning, never as "compatible"', () => {
    const result = check(evidence({ sidecar: { baseModelRequired: 'AceStep v1.5 Turbo (2B)', baseModel: null, baseModelScale: null }, adapter: { baseModel: 'acestep-v15-xl-base' } }), 'acestep-v15-turbo');
    expect(result.verdict).toBe('warning');
    expect(codes(result)).toContain('conflicting_info');
  });

  it('puts a blocking mismatch before any warning', () => {
    const result = check(evidence({ baseModel: ['acestep-v15-xl-base'] }), 'acestep-v15-turbo', 4);
    expect(result.verdict).toBe('incompatible');
    expect(codes(result)).toEqual(['size_mismatch', 'vram_low']);
  });

  describe('memory', () => {
    it('warns when the GPU is below what the model this LoRA calls for needs', () => {
      expect(vramNeeded({ family: 'turbo', size: '2B' })).toBe(6);
      expect(vramNeeded({ family: 'turbo', size: 'XL' })).toBe(8); // the bf16 build
      expect(vramNeeded({ family: 'base', size: 'XL' })).toBe(12);
      expect(vramNeeded({ family: null, size: 'XL' })).toBe(8);
      const low = check(evidence({ baseModel: ['acestep-v15-xl-base'] }), 'acestep-v15-xl-base', 8);
      expect(low.reasons.find((r) => r.code === 'vram_low')).toMatchObject({ severity: 'warning', params: { needed: 12, vramGb: 8, size: 'XL', family: 'base' } });
      expect(low.verdict).toBe('warning');
      expect(check(evidence({ baseModel: ['acestep-v15-xl-base'] }), 'acestep-v15-xl-base', 12).verdict).toBe('compatible');
      expect(codes(check(LOFI, 'acestep-v15-turbo', 4))).toEqual(['vram_low']);
    });

    it('does not warn without a figure, and ignores a figure that cannot be one', () => {
      for (const bad of [undefined, null, 0, -8, NaN, Infinity, '8' as unknown as number]) {
        const result = check(LOFI, 'acestep-v15-turbo', bad);
        expect(codes(result), String(bad)).not.toContain('vram_low');
        expect(result.vramGb, String(bad)).toBeNull();
      }
    });
  });
});

describe('the model table', () => {
  const clientSource = readFileSync(path.resolve(__dirname, '../../../utils/modelNames.ts'), 'utf-8');
  const block = clientSource.slice(clientSource.indexOf('export const MODEL_INFO'));
  const clientVram = Object.fromEntries(
    [...block.matchAll(/'(acestep-v15-[a-z0-9-]+)':\s*\{[^}]*?vramMin:\s*(\d+)/g)].map((m) => [m[1], Number(m[2])]),
  );

  it('has the same models and the same minimum memory as the interface\'s own table', () => {
    expect(Object.keys(clientVram).length).toBeGreaterThanOrEqual(6); // guards the reading of the client file itself
    expect(Object.fromEntries(Object.entries(STUDIO_MODELS).map(([id, m]) => [id, m.vramMin]))).toEqual(clientVram);
  });

  it('describes every model it lists consistently with how a name is read', () => {
    for (const [id, spec] of Object.entries(STUDIO_MODELS)) expect(describeModel(id), id).toEqual({ family: spec.family, size: spec.size });
  });
});
