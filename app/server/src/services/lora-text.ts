// services/lora-text.ts
//
// What the author of a repository writes (cardData, adapter_config.json, the *.metadata.json file) is data, never trusted: only short plain
// strings and bounded numbers are kept from it, and what is kept is meant to be shown as text, never as markup. Shared by lora-hub.ts and
// lora-sidecar.ts so that both apply exactly the same rules.

/** A short plain string from free text written by the repository's author, or null. */
export function plain(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const s = value.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

export function plainList(value: unknown, maxItems: number, maxLen: number): string[] {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return list.map((v) => plain(v, maxLen)).filter((v): v is string => v !== null).slice(0, maxItems);
}

/** A finite number inside [min, max], or null. A string is not a number. */
export function boundedNumber(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null;
}

/** A whole number inside [min, max], or null. */
export function boundedInteger(value: unknown, min: number, max: number): number | null {
  const n = boundedNumber(value, min, max);
  return n !== null && Number.isInteger(n) ? n : null;
}

const SHA256 = /^[0-9a-f]{64}$/;
export function normalizeSha(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const hex = value.replace(/^sha256:/i, '').trim().toLowerCase();
  return SHA256.test(hex) ? hex : null;
}

/**
 * A model reference written by an author: "ACE-Step/Ace-Step1.5" is a Hub id and means something; "/root/checkpoints/acestep-v15-turbo" is a
 * folder on the author's own machine, of which only the last segment says anything.
 */
export function modelLabel(value: unknown, max = 160): string | null {
  const text = plain(value, max);
  if (!text) return null;
  if (/^([/~]|\.{1,2}\/|[A-Za-z]:[\\/])/.test(text) || text.includes('\\')) {
    const last = text.split(/[\\/]+/).filter(Boolean).pop();
    return last ?? null;
  }
  return text;
}

/** Why a LoRA cannot be loaded in small-card mode (HW_MODE=stream). Shown only when the interface did not already say it. */
export const SMALL_GPU_LORA_MESSAGE =
  'LoRA adapters are not supported in small-card mode (the music model is streamed through the card block by block). Use a card with more memory, or the regular processor mode, to apply a LoRA.';

/** Why the quantization switch does nothing in small-card mode. */
export const SMALL_GPU_QUANTIZATION_MESSAGE = 'Quantization is not used in small-card mode: the engine keeps the music model unquantized there.';
