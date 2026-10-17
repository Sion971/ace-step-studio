/**
 * Derive a stable integer seed from a song or job id, for reproducible covers on retake
 * (the result is kept in 31 bits, a positive int32).
 *
 * - An id that starts with 8 hex characters (a UUID) keeps its historical value: those 8 characters.
 * - Any other id is hashed whole (FNV-1a, then a murmur3-style finaliser so that the low bits are well mixed,
 *   because callers use `seed % 16`). This is the case of the audio job ids `job_<timestamp>_<random>` that
 *   cover-jobs actually receives. The previous code read `job_1791` as hex, got NaN and returned 0 for EVERY
 *   job: all covers shared seed 0, and the style index was always 0.
 */
export function songIdToSeed(songId: string): number {
  const hex = songId.replace(/-/g, '').slice(0, 8);
  if (/^[0-9a-f]{8}$/i.test(hex)) return parseInt(hex, 16) & 0x7fffffff;
  let h = 0x811c9dc5;
  for (let i = 0; i < songId.length; i++) {
    h ^= songId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h & 0x7fffffff;
}
