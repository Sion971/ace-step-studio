// Preselected training settings, by GPU memory.
//
// The six presets are those that ACE-Step ships with its trainer (ACE-Step-1.5/acestep/training_v2/presets/*.json), minus what the
// Studio decides elsewhere (paths, model, seed). The two "free" presets (quick test, high quality) leave the memory settings alone: the
// upstream files switch to the 32-bit optimizer and keep the encoders on the GPU, which an 8 GB card cannot hold.

export interface PresetValues {
  rank: number;
  alpha: number;
  learningRate: number;
  batchSize: number;
  gradientAccumulation: number;
  epochs: number;
  warmupSteps: number;
  optimizerType: string;
  schedulerType: string;
  cfgRatio: number;
  saveEvery: number;
  gradientCheckpointing: boolean;
  offloadEncoder: boolean;
}

export type PresetId = 'vram_8gb' | 'vram_12gb' | 'vram_16gb' | 'vram_24gb_plus' | 'quick_test' | 'high_quality';

export interface TrainingPreset {
  id: PresetId;
  /** Key of the label in the translation tables. */
  labelKey: string;
  values: Partial<PresetValues>;
}

/** What the Studio used before presets existed; also the "Studio defaults" entry. */
export const DEFAULT_PRESET_VALUES: PresetValues = {
  rank: 16,
  alpha: 32,
  learningRate: 0.0001,
  batchSize: 1,
  gradientAccumulation: 4,
  epochs: 100,
  warmupSteps: 100,
  optimizerType: 'adamw8bit',
  schedulerType: 'cosine',
  cfgRatio: 0.15,
  saveEvery: 10,
  gradientCheckpointing: true,
  offloadEncoder: true,
};

const common = { learningRate: 0.0001, warmupSteps: 100, schedulerType: 'cosine', cfgRatio: 0.15, saveEvery: 10, gradientCheckpointing: true };

export const TRAINING_PRESETS: TrainingPreset[] = [
  { id: 'vram_8gb', labelKey: 'trainingPresetVram8',
    values: { ...common, rank: 16, alpha: 32, batchSize: 1, gradientAccumulation: 8, epochs: 100, optimizerType: 'adamw8bit', offloadEncoder: true } },
  { id: 'vram_12gb', labelKey: 'trainingPresetVram12',
    values: { ...common, rank: 32, alpha: 64, batchSize: 1, gradientAccumulation: 4, epochs: 100, optimizerType: 'adamw8bit', offloadEncoder: true } },
  { id: 'vram_16gb', labelKey: 'trainingPresetVram16',
    values: { ...common, rank: 64, alpha: 128, batchSize: 1, gradientAccumulation: 4, epochs: 100, optimizerType: 'adamw', offloadEncoder: false } },
  { id: 'vram_24gb_plus', labelKey: 'trainingPresetVram24',
    values: { ...common, rank: 128, alpha: 256, batchSize: 2, gradientAccumulation: 2, epochs: 100, optimizerType: 'adamw', offloadEncoder: false } },
  { id: 'quick_test', labelKey: 'trainingPresetQuick',
    values: { rank: 16, alpha: 32, batchSize: 1, gradientAccumulation: 4, epochs: 10, warmupSteps: 10, saveEvery: 5, learningRate: 0.0001, schedulerType: 'cosine', cfgRatio: 0.15 } },
  { id: 'high_quality', labelKey: 'trainingPresetHighQuality',
    values: { rank: 128, alpha: 256, batchSize: 1, gradientAccumulation: 4, epochs: 1000, warmupSteps: 100, saveEvery: 250, learningRate: 0.0001, schedulerType: 'cosine', cfgRatio: 0.15 } },
];

export const SCHEDULER_TYPES = ['cosine', 'cosine_restarts', 'linear', 'constant', 'constant_with_warmup'];
export const ATTENTION_TYPES = ['both', 'self', 'cross'];

/**
 * The preset that fits a GPU, or null when none should be chosen on its own (CPU, or memory unknown).
 * Thresholds follow torch's reported memory: a "16 GB" card reports ~15.6 GiB and a "24 GB" one ~23.5 GiB.
 */
export function presetForVram(vramGiB: number | undefined | null, mode?: string): PresetId | null {
  if (mode === 'cpu') return null;
  if (typeof vramGiB !== 'number' || !Number.isFinite(vramGiB) || vramGiB <= 0) return null;
  if (vramGiB < 10) return 'vram_8gb';
  if (vramGiB < 15.5) return 'vram_12gb';
  if (vramGiB < 22) return 'vram_16gb';
  return 'vram_24gb_plus';
}

export function findPreset(id: string): TrainingPreset | undefined {
  return TRAINING_PRESETS.find((p) => p.id === id);
}
