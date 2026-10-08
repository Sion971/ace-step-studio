// services/lora-sidecar.fixtures.ts
//
// A metadata file with the exact STRUCTURE of a real one published next to a real ACE-Step 1.5 LoRA (every section, every key, nulls where the
// author left nulls), but with invented values: the real file declares no license, so it is not copied here. Shared by the tests.

type Json = Record<string, unknown>;

export function exampleSidecar(sha256: string, overrides: Json = {}): Json {
  return {
    $schema: '../../../_adapter_metadata.schema.json',
    schema_version: 1,
    id: 'example-lofi-v1',
    name: 'Example Lo-Fi',
    version: '1.0',
    description: 'Example style. Covers: a mellow beat, vinyl crackle, jazzy chords; and a second, slower prompt.',
    author: 'Example Author',
    created_at: '2026-01-01T00:00:00Z',
    model: {
      type: 'lora',
      base_model: 'AceStep v1.5 Turbo',
      base_model_scale: '2B',
      architecture: 'diffusion-transformer',
      format: 'safetensors',
      peft: { library: 'peft', version: '0.18.1' },
    },
    classification: { primary_genre: 'lo-fi', secondary_genres: [], tags: ['mellow beat', 'vinyl crackle', 'jazzy chords'], moods: [] },
    inference: {
      primary_trigger_word: 'ex-l0f1',
      trigger_words: [],
      caption_template: '<trigger>, <description>, <tags>',
      recommended_strength: 1.0,
      tested_strength_range: [0.3, 1.0],
      sample_rate: 48000,
      recommended_steps: 8,
      recommended_shift: 3.0,
      recommended_guidance: 7.0,
      example_prompts: [
        { caption: 'mellow beat, vinyl crackle, jazzy chords', bpm: 80.0, key: 'F minor' },
        { caption: 'slow chords, soft drums, ambient textures', bpm: 70.0, key: 'A minor' },
      ],
    },
    training: {
      rank: 64, alpha: 128, dropout: 0.1, target_modules: ['q_proj', 'k_proj', 'v_proj', 'o_proj'], epochs: 500, steps: 7500, batch_size: 1,
      optimizer: 'adamw_fused', lr: 0.0003, warmup_steps: 100, seed: 42, final_avg_loss: 0.5, trained_at: '2026-01-01T00:00:00Z',
    },
    dataset: {
      source: 'synthetic', size: 15, total_duration_seconds: 3000.0, bpm: { min: 70.0, max: 188.0, median: 125.0 },
      key_distribution: { 'C major': 2, 'A♭ major': 2 }, language_distribution: { en: 4, fr: 5 }, instrumental_fraction: 0.0,
    },
    evaluation: { method: 'example', scales_tested: [0.0, 0.3, 0.5, 0.7, 1.0], best_scale: 1.0, best_score: 0.98, baseline_score: 0.97, delta_vs_baseline: 0.01, verdict: 'positive' },
    compatibility: { framework: 'diffusers', base_model_required: 'AceStep v1.5 Turbo (2B)', library_minimums: { peft: '0.18.0', torch: '2.0' } },
    files: { weights: 'adapter_model.safetensors', size_bytes: 50000, sha256 },
    assets: { preview_audio: null, preview_video: null, cover_image: null },
    distribution: { license: null, source_url: null },
    ...overrides,
  };
}
