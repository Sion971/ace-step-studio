// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LM_DOWNLOADS, LISTED_LM_MODELS, MODEL_DOWNLOADS, downloadArgs, isDownloadableModel, isLmModel } from './model-downloads.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = (relative: string) => readFileSync(path.join(here, relative), 'utf-8');
const CHECKPOINTS = path.join('/studio', 'ACE-Step-1.5', 'checkpoints');

describe('the language models of the download table', () => {
  it('offers exactly the models the table can download, smallest first, each once', () => {
    expect([...LISTED_LM_MODELS].sort()).toEqual(Object.keys(LM_DOWNLOADS).sort());
    expect(new Set(LISTED_LM_MODELS).size).toBe(LISTED_LM_MODELS.length);
    expect(LISTED_LM_MODELS).toEqual(['acestep-5Hz-lm-0.6B', 'acestep-5Hz-lm-1.7B', 'acestep-5Hz-lm-4B']);
  });

  it('keeps the two tables apart: a language model is not a DiT model, and no name is in both', () => {
    for (const name of Object.keys(LM_DOWNLOADS)) expect(Object.keys(MODEL_DOWNLOADS), name).not.toContain(name);
    expect(isLmModel('acestep-5Hz-lm-1.7B')).toBe(true);
    expect(isLmModel('acestep-v15-turbo')).toBe(false);
    for (const name of ['constructor', '__proto__', 'toString', 'acestep-5Hz-lm-9B']) expect(isLmModel(name), name).toBe(false);
  });

  it('is downloadable by the same route as the DiT models, and nothing else changed', () => {
    for (const name of LISTED_LM_MODELS) expect(isDownloadableModel(name), name).toBe(true);
    expect(isDownloadableModel('acestep-v15-base')).toBe(true);
    for (const name of ['constructor', '__proto__', 'my-finetune', 'acestep-5Hz-lm-9B']) expect(isDownloadableModel(name), name).toBe(false);
  });

  it('downloads the 1.7B as a folder of the main repository, and the others from their own repository', () => {
    expect(downloadArgs('acestep-5Hz-lm-1.7B', CHECKPOINTS)).toEqual(['download', 'ACE-Step/Ace-Step1.5', '--include', 'acestep-5Hz-lm-1.7B/*', '--local-dir', CHECKPOINTS]);
    expect(downloadArgs('acestep-5Hz-lm-0.6B', CHECKPOINTS)).toEqual(['download', 'ACE-Step/acestep-5Hz-lm-0.6B', '--local-dir', path.join(CHECKPOINTS, 'acestep-5Hz-lm-0.6B')]);
    expect(downloadArgs('acestep-5Hz-lm-4B', CHECKPOINTS)).toEqual(['download', 'ACE-Step/acestep-5Hz-lm-4B', '--local-dir', path.join(CHECKPOINTS, 'acestep-5Hz-lm-4B')]);
    expect(downloadArgs('acestep-5Hz-lm-9B', CHECKPOINTS)).toBeNull();
  });

  it('the selector of the interface offers the same models', () => {
    const selector = source('../../../components/LmSettings.tsx');
    for (const name of LISTED_LM_MODELS) expect(selector, name).toContain(`'${name}'`);
  });

  it('the language model dropdown of the engine accepts a model downloaded after the engine started (same refusal as for the DiT)', () => {
    const engine = readFileSync(path.resolve(here, '../../../../ACE-Step-1.5/acestep/ui/gradio/interfaces/generation_service_config_rows.py'), 'utf-8');
    const start = engine.indexOf('lm_model_path = gr.Dropdown(');
    expect(start).toBeGreaterThan(-1);
    const call = engine.slice(start, engine.indexOf('\n        )\n', start));
    expect(call).toContain('choices=all_lm_models');
    expect(call).toContain('allow_custom_value=True');
  });
});
