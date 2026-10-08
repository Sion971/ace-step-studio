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
//  - acestep-v15-sft is expected to be laid out like base (the engine's documentation lists it the same way); its file list was not read.

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
export const isDownloadableModel = (model: string): boolean => Object.prototype.hasOwnProperty.call(MODEL_DOWNLOADS, model);

/**
 * Arguments of `python -m huggingface_hub.commands.huggingface_cli` that download `model` into `checkpointsDir`, or null for a model without a known source.
 * Own-repository models go to checkpoints/<model>; a model that is a folder of a larger repository (`include`) is fetched alone, into checkpoints/.
 */
export function downloadArgs(model: string, checkpointsDir: string): string[] | null {
  if (!isDownloadableModel(model)) return null;
  const { repo, include } = MODEL_DOWNLOADS[model];
  if (include) return ['download', repo, '--include', include, '--local-dir', checkpointsDir];
  return ['download', repo, '--local-dir', path.join(checkpointsDir, model)];
}
