// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL_DOWNLOADS, LISTED_DIT_MODELS, downloadArgs, isDownloadableModel } from './model-downloads.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = (relative: string) => readFileSync(path.join(here, relative), 'utf-8');
const CHECKPOINTS = path.join('/studio', 'ACE-Step-1.5', 'checkpoints');

describe('the models the Studio offers and where they come from', () => {
  it('every listed model has a download source, and every source is listed: a model cannot be offered without being fetchable, nor fetchable without being offered', () => {
    expect([...LISTED_DIT_MODELS].sort()).toEqual(Object.keys(MODEL_DOWNLOADS).sort());
  });

  it('offers the three 2B models next to the XL ones', () => {
    for (const id of ['acestep-v15-turbo', 'acestep-v15-sft', 'acestep-v15-base', 'acestep-v15-xl-turbo-bf16', 'acestep-v15-xl-turbo']) expect(LISTED_DIT_MODELS, id).toContain(id);
  });

  it('lists no model twice', () => {
    expect(new Set(LISTED_DIT_MODELS).size).toBe(LISTED_DIT_MODELS.length);
  });

  it('every listed model is known to the menu: size, steps and memory (the client table, read as text: the server build cannot import from outside src)', () => {
    const clientTable = source('../../../utils/modelNames.ts');
    for (const id of LISTED_DIT_MODELS) expect(clientTable, id).toContain(`'${id}': {`);
  });

  it('a key is the folder name on the disk, never prefixed by an organisation (the prefix belongs to the repository)', () => {
    for (const [key, { repo }] of Object.entries(MODEL_DOWNLOADS)) {
      expect(key, key).not.toContain('/');
      expect(repo, key).toMatch(/^[\w.-]+\/[\w.-]+$/);
    }
    expect(MODEL_DOWNLOADS['acestep-v15-xl-turbo-bf16'].repo).toBe('marcorez8/acestep-v15-xl-turbo-bf16');
  });

  it('the client menu lists every model the server offers: one forgotten there would be unreachable', () => {
    const menu = source('../../../components/ModelMenu.tsx');
    const order = menu.slice(menu.indexOf('const FIXED_ORDER = ['), menu.indexOf('];', menu.indexOf('const FIXED_ORDER = [')));
    for (const id of LISTED_DIT_MODELS) expect(order, id).toContain(`'${id}'`);
  });
});

describe('downloading', () => {
  it('a model with a repository of its own goes to checkpoints/<model>', () => {
    expect(downloadArgs('acestep-v15-base', CHECKPOINTS)).toEqual(['download', 'ACE-Step/acestep-v15-base', '--local-dir', path.join(CHECKPOINTS, 'acestep-v15-base')]);
    expect(downloadArgs('acestep-v15-xl-turbo-bf16', CHECKPOINTS)).toEqual(['download', 'marcorez8/acestep-v15-xl-turbo-bf16', '--local-dir', path.join(CHECKPOINTS, 'acestep-v15-xl-turbo-bf16')]);
  });

  it('the 2B turbo is a folder of the main repository: only that folder, into checkpoints/ (not the VAE, the text encoder and the language model that come with it)', () => {
    expect(downloadArgs('acestep-v15-turbo', CHECKPOINTS)).toEqual(['download', 'ACE-Step/Ace-Step1.5', '--include', 'acestep-v15-turbo/*', '--local-dir', CHECKPOINTS]);
  });

  it('an unknown model has no source, and a name that is a property of every object is not a model', () => {
    for (const unknown of ['my-finetune', '', 'acestep-v15-nope', '../etc', 'constructor', '__proto__', 'hasOwnProperty']) {
      expect(isDownloadableModel(unknown), unknown).toBe(false);
      expect(downloadArgs(unknown, CHECKPOINTS), unknown).toBeNull();
    }
  });
});

describe('the routes use this table, not a copy of it', () => {
  const generate = source('../routes/generate.ts');

  it('routes/generate.ts takes the list and the sources from here', () => {
    expect(generate).toContain("from '../services/model-downloads.js'");
    expect(generate).toContain('[...LISTED_DIT_MODELS]');
    expect(generate).toContain('downloadArgs(model');
    expect(generate).toContain('isDownloadableModel(model)');
  });

  it('and no longer holds a table of its own, nor the "XL only" list that hid the 2B models', () => {
    expect(generate).not.toContain('MODEL_HF_REPOS');
    expect(generate).not.toContain('XL (4B) models only');
    expect(generate).not.toMatch(/const ALL_DIT_MODELS = \[\s*\n/);
  });
});
