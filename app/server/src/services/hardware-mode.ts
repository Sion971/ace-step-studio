import path from 'path';
import { config } from '../config/index.js';
import { readHardwareProfile } from './download-tracker.js';

export type HardwareMode = 'cpu' | 'stream' | 'gpu' | undefined;

/**
 * The install's hardware mode: HW_MODE in the environment, else hardware_profile.env.
 *   cpu    the processor only (no usable card);
 *   stream a small card (about 3 GB or less): the engine stays on the processor, the card runs the DiT blocks one at a time
 *          and the audio decoding (acestep/core/generation/handler/small_gpu_stream.py);
 *   gpu    the card holds the models.
 */
export function hardwareMode(): HardwareMode {
  const fromEnv = process.env.HW_MODE;
  if (fromEnv) return fromEnv === 'cpu' || fromEnv === 'stream' || fromEnv === 'gpu' ? fromEnv : undefined;
  const file = process.env.HARDWARE_PROFILE_PATH || path.join(config.pipeline.aceStepDir, '..', 'hardware_profile.env');
  return readHardwareProfile(file)?.mode;
}

/** True when the install chose the processor (HW_MODE=cpu in the environment, or in hardware_profile.env). */
export function isCpuMode(): boolean {
  if (process.env.HW_MODE) return process.env.HW_MODE === 'cpu';
  const file = process.env.HARDWARE_PROFILE_PATH || path.join(config.pipeline.aceStepDir, '..', 'hardware_profile.env');
  return readHardwareProfile(file)?.mode === 'cpu';
}

/** True when the install chose the small-card stream mode (HW_MODE=stream). */
export function isStreamMode(): boolean {
  return hardwareMode() === 'stream';
}
