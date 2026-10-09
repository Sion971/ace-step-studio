// services/model-downloads.ts
//
// Which DiT models the Studio lists, and where each one is downloaded from.
//
// The list used to be written twice in routes/generate.ts (the models route and the download route), XL only, and a third copy of the
// repositories lives in services/acestep.ts. A model that was listed but had no repository could not be downloaded, and a model with a
// repository but not listed could not be chosen: one table now says both, and a test checks that they agree.
//
// Where the 2B models come from (ACE-Step's own INSTALL.md, and the repositories' file lists, read on Hugging Face):
//  - acestep-v15-turbo is NOT a repository of its own: it is a folder of the main repository ACE-Step/Ace-Step1.5, next to the VAE, the text
//    encoder and a language model. Only that folder is wanted (`--include`), downloaded into checkpoints/ so that it lands in checkpoints/acestep-v15-turbo/.
//  - acestep-v15-base has its own repository, with the files at its root: it is downloaded into checkpoints/acestep-v15-base/, like the XL ones.
//  - acestep-v15-sft has its own repository, with the files at its root like base (checked on a real download: model.safetensors in one file, config.json, silence_latent.pt, the .py files of the model).
//
// The language models (LM) are listed in a second table: same download mechanism, but they are not DiT models (no menu of DiT models, no post-processing of the download).
//  - acestep-5Hz-lm-0.6B and acestep-5Hz-lm-4B have a repository each (SUBMODEL_REGISTRY of the engine's model_downloader.py).
//  - acestep-5Hz-lm-1.7B is a folder of the main repository ACE-Step/Ace-Step1.5 (about 3.5 GB), fetched alone like the 2B turbo.

import path from 'path';

export interface ModelDownload {
  /** Hugging Face repository. */
  repo: string;
  /** Only this part of the repository (a `--include` pattern). Its files carry their own folder: they go to checkpoints/, not to checkpoints/<model>/. */
  include?: string;
}

/** Download source of every model the Studio can fetch. The key is the folder name in checkpoints/, never prefixed by an organisation. */
export const MODEL_DOWNLOADS: Record<string, ModelDownload> = {
  // XL (4B)
  'acestep-v15-xl-turbo': { repo: 'ACE-Step/acestep-v15-xl-turbo' },
  'acestep-v15-xl-sft': { repo: 'ACE-Step/acestep-v15-xl-sft' },
  // The "marcorez8/" prefix belongs to the VALUE (the real repository), never to the key (the folder name on disk).
  'acestep-v15-xl-turbo-bf16': { repo: 'marcorez8/acestep-v15-xl-turbo-bf16' },
  'acestep-v15-xl-merge-sft-turbo': { repo: 'jeankassio/acestep_v1.5_merge_sft_turbo_xl' },
  // 2B
  'acestep-v15-turbo': { repo: 'ACE-Step/Ace-Step1.5', include: 'acestep-v15-turbo/*' },
  'acestep-v15-sft': { repo: 'ACE-Step/acestep-v15-sft' },
  'acestep-v15-base': { repo: 'ACE-Step/acestep-v15-base' },
};

/** Download source of every language model the Studio can fetch (folder name in checkpoints/ -> source). */
export const LM_DOWNLOADS: Record<string, ModelDownload> = {
  'acestep-5Hz-lm-0.6B': { repo: 'ACE-Step/acestep-5Hz-lm-0.6B' },
  'acestep-5Hz-lm-1.7B': { repo: 'ACE-Step/Ace-Step1.5', include: 'acestep-5Hz-lm-1.7B/*' },
  'acestep-5Hz-lm-4B': { repo: 'ACE-Step/acestep-5Hz-lm-4B' },
};

/** The language models the selector of the LM offers, smallest first. */
export const LISTED_LM_MODELS: readonly string[] = ['acestep-5Hz-lm-0.6B', 'acestep-5Hz-lm-1.7B', 'acestep-5Hz-lm-4B'];

/** Whether `model` is a language model the Studio knows (an own-property test, like the others). */
export const isLmModel = (model: string): boolean => Object.prototype.hasOwnProperty.call(LM_DOWNLOADS, model);

/** The models offered by the menu, in the order the server proposes them (the client has its own display order). Each one has a download source. */
export const LISTED_DIT_MODELS: readonly string[] = [
  'acestep-v15-xl-turbo',
  'acestep-v15-xl-sft',
  'acestep-v15-xl-turbo-bf16',
  'acestep-v15-xl-merge-sft-turbo',
  'acestep-v15-turbo',
  'acestep-v15-sft',
  'acestep-v15-base',
];

/** Whether the Studio knows where to download `model` from. An own-property test: a name such as "constructor" is not a model. */
export const isDownloadableModel = (model: string): boolean => Object.prototype.hasOwnProperty.call(MODEL_DOWNLOADS, model) || isLmModel(model);

/**
 * Arguments of `python -m huggingface_hub.commands.huggingface_cli` that download `model` into `checkpointsDir`, or null for a model without a known source.
 * Own-repository models go to checkpoints/<model>; a model that is a folder of a larger repository (`include`) is fetched alone, into checkpoints/.
 */
export function downloadArgs(model: string, checkpointsDir: string): string[] | null {
  if (!isDownloadableModel(model)) return null;
  const { repo, include } = isLmModel(model) ? LM_DOWNLOADS[model] : MODEL_DOWNLOADS[model];
  if (include) return ['download', repo, '--include', include, '--local-dir', checkpointsDir];
  return ['download', repo, '--local-dir', path.join(checkpointsDir, model)];
}
