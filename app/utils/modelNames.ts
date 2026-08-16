/**
 * Noms d'affichage des modèles DiT.
 *
 * Module partagé : `CreatePanel` (via `ModelMenu`) et `SongList` en avaient
 * chacun leur copie, qui ont divergé — celle de `SongList` renvoyait « XL »
 * pour tout modèle absent de son mapping, y compris `acestep-v15-base`.
 *
 * Volontairement sans dépendance React ni i18n : ce fichier doit rester
 * importable depuis n'importe quel composant sans en tirer d'autres.
 */

/** Repli lorsque l'identifiant du modèle est absent (chansons anciennes). */
const UNKNOWN_MODEL_LABEL = 'XL';

const DISPLAY_NAMES: Record<string, string> = {
  // Famille 2B — ~4,5 Go sur disque, tourne confortablement sous 8 Go de VRAM
  'acestep-v15-base': 'Base',
  'acestep-v15-sft': 'SFT',
  'acestep-v15-turbo': 'Turbo',
  // Famille XL (DiT 4B)
  'acestep-v15-xl-base': 'XL Base',
  'acestep-v15-xl-sft': 'XL SFT',
  'acestep-v15-xl-turbo': 'XL Turbo',
  'marcorez8/acestep-v15-xl-turbo-bf16': 'XL Turbo BF16',
  'acestep-v15-xl-merge-sft-turbo': 'XL Merge SFT+Turbo',
};

/**
 * Nom court affiché pour un identifiant de modèle.
 *
 * Les modèles connus passent par le mapping ; les autres (personnalisés,
 * convertis, fusionnés) sont mis en forme automatiquement :
 * `acestep-v15-base` → « Base », `mon-lora-fp16` → « Mon LoRA FP16 ».
 */
export const getModelDisplayName = (modelId?: string): string => {
  if (!modelId) return UNKNOWN_MODEL_LABEL;
  if (DISPLAY_NAMES[modelId]) return DISPLAY_NAMES[modelId];

  let name = modelId.includes('/') ? modelId.split('/').pop()! : modelId;
  name = name
    .replace(/^acestep-v15-/i, '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    // Abréviations
    .replace(/\bXl\b/g, 'XL')
    .replace(/\bBf16\b/g, 'BF16')
    .replace(/\bFp16\b/g, 'FP16')
    .replace(/\bFp32\b/g, 'FP32')
    .replace(/\bLora\b/g, 'LoRA')
    // SFT+Turbo doit passer avant SFT et Turbo pris séparément
    .replace(/Sft Turbo/gi, 'SFT+Turbo')
    .replace(/\bSft\b/g, 'SFT');
  return name;
};

export interface ModelInfoEntry {
  /** Taille sur disque, dossier complet. Mesurée quand le modèle est installé. */
  size: string;
  /** Nombre de steps de diffusion recommandé (source : Model Zoo amont). */
  steps: number;
  /** VRAM minimale annoncée, en Go. Sert à signaler les modèles trop lourds. */
  vramMin: number;
  /** Clé i18n de la description ; `descFallback` sert si la clé n'existe pas. */
  descKey: string;
  descFallback: string;
}

/**
 * Métadonnées d'affichage des modèles du Model Zoo.
 *
 * Tailles : mesurées sur disque (`du -sh ACE-Step-1.5/checkpoints/*`) pour les
 * modèles installés, estimées par analogie sinon — le dossier contient plus que
 * le seul `model.safetensors`, d'où l'écart avec les chiffres annoncés en amont.
 *
 * Steps et VRAM : documentation amont (README, section Model Zoo). Les modèles
 * turbo tournent sans CFG en 8 steps ; base et sft utilisent CFG en 50 steps.
 */
export const MODEL_INFO: Record<string, ModelInfoEntry> = {
  // --- Famille 2B ---------------------------------------------------------
  'acestep-v15-base': {
    size: '4.5 GB', steps: 50, vramMin: 6,
    descKey: 'modelDescBase', descFallback: '2B, versatile',
  },
  'acestep-v15-sft': {
    size: '4.5 GB', steps: 50, vramMin: 6,
    descKey: 'modelDescSft2b', descFallback: '2B, refined',
  },
  'acestep-v15-turbo': {
    size: '~4.5 GB', steps: 8, vramMin: 6,
    descKey: 'modelDescTurbo2b', descFallback: '2B, fast',
  },
  // --- Famille XL (DiT 4B) ------------------------------------------------
  'acestep-v15-xl-base': {
    size: '18.8 GB', steps: 50, vramMin: 12,
    descKey: 'modelDescXlBase', descFallback: '4B, versatile',
  },
  'acestep-v15-xl-sft': {
    size: '18.8 GB', steps: 50, vramMin: 12,
    descKey: 'modelDescSft', descFallback: '4B, max quality',
  },
  'acestep-v15-xl-turbo': {
    size: '18.8 GB', steps: 8, vramMin: 12,
    descKey: 'modelDescTurbo', descFallback: '4B, fast',
  },
  'marcorez8/acestep-v15-xl-turbo-bf16': {
    size: '9.3 GB', steps: 8, vramMin: 8,
    descKey: 'modelDescBf16', descFallback: '4B BF16, compact',
  },
  'acestep-v15-xl-merge-sft-turbo': {
    size: '19.9 GB', steps: 50, vramMin: 12,
    descKey: 'modelDescMerge', descFallback: '4B SFT+Turbo merge',
  },
};

/**
 * Variante turbo : pas de CFG, ~20 steps maximum, échantillonneur euler seul.
 * Le modèle fusionné SFT+Turbo se comporte comme un SFT (50 steps, CFG).
 */
export const isTurboModel = (modelId: string): boolean => {
  if (modelId.includes('merge')) return false;
  return modelId.includes('turbo');
};

/**
 * VRAM minimale annoncée pour un modèle, ou `null` si inconnu.
 * Un modèle absent de MODEL_INFO (personnalisé, converti) ne déclenche
 * aucun avertissement : on ne sait rien de ses besoins.
 */
export const getModelVramMin = (modelId: string): number | null =>
  MODEL_INFO[modelId]?.vramMin ?? null;
