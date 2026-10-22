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

/** Smallest card (GiB as PyTorch sees it) on which the local cover model can share the card with the streamed music model. */
export const COVER_MIN_VRAM_GIB = 6;

/** The card's memory in GiB as PyTorch sees it: HW_VRAM_TORCH_MIB / HW_VRAM_MIB in the environment, else the profile file. */
function cardVramGiB(): number | undefined {
  for (const key of ['HW_VRAM_TORCH_MIB', 'HW_VRAM_MIB']) {
    const mib = Number(process.env[key]);
    if (process.env[key] && Number.isFinite(mib) && mib > 0) return mib / 1024;
  }
  const file = process.env.HARDWARE_PROFILE_PATH || path.join(config.pipeline.aceStepDir, '..', 'hardware_profile.env');
  return readHardwareProfile(file)?.vramGiB;
}

/**
 * True when the AI covers cannot run: stream mode on a card too small to hold the image model next to the music model.
 * Stream mode is also used on 6 to 8 GB cards (an XL model that does not fit), where the card has the room: there the
 * covers work. STUDIO_COVERS_ON_STREAM=on / off forces the answer; an unknown card size counts as too small.
 */
export function coversBlockedBySmallCard(): boolean {
  if (!isStreamMode()) return false;
  const forced = (process.env.STUDIO_COVERS_ON_STREAM || '').trim().toLowerCase();
  if (['on', '1', 'true', 'yes'].includes(forced)) return false;
  if (['off', '0', 'false', 'no'].includes(forced)) return true;
  const vram = cardVramGiB();
  return vram === undefined || vram < COVER_MIN_VRAM_GIB;
}

/** Largest card (GiB as PyTorch sees it) on which the regular mode cannot load a LoRA on an XL music model: the whole model has to go to the card first. */
export const XL_LORA_MAX_VRAM_GIB = 10;

export const XL_LORA_NEEDS_STREAM_MESSAGE =
  'A LoRA cannot be loaded on an XL model in normal mode on a card of 8 GB or less: loading it puts the whole model on the card, which is full. ' +
  'Switch to flux mode (./run.sh --mode flux, or run.bat --mode flux) to use this LoRA with the XL model, or pick a non-XL model.';

/**
 * True when loading a LoRA would fill the card: normal mode (not the processor, not stream), an XL model and a card of 10 GiB or less.
 * An unknown card size is not blamed (nothing is refused on a guess).
 */
export function loraNeedsStreamMode(model: string | undefined): boolean {
  if (!model || !/(^|[-_])xl([-_]|$)/i.test(model)) return false;
  const mode = hardwareMode();
  if (mode === 'cpu' || mode === 'stream') return false;
  const vram = cardVramGiB();
  return vram !== undefined && vram <= XL_LORA_MAX_VRAM_GIB;
}
