import path from 'path';
import { config } from '../config/index.js';
import { readHardwareProfile } from './download-tracker.js';

/** True when the install chose the processor (HW_MODE=cpu in the environment, or in hardware_profile.env). */
export function isCpuMode(): boolean {
  if (process.env.HW_MODE) return process.env.HW_MODE === 'cpu';
  const file = process.env.HARDWARE_PROFILE_PATH || path.join(config.pipeline.aceStepDir, '..', 'hardware_profile.env');
  return readHardwareProfile(file)?.mode === 'cpu';
}
