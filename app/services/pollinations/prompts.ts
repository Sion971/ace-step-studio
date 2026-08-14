import type { CoverPromptInput } from './types';

/**
 * Build a single English prompt string for Pollinations cover generation.
 *
 * Diffusion image models train predominantly on English captions, so we keep
 * the framing in English regardless of song language. The song title is
 * passed verbatim — it can be Cyrillic / CJK and the model will still latch
 * onto the typographic feeling without us rendering text on the image
 * (we explicitly forbid text on the cover via negative phrases since
 * txt-on-image rendering is unreliable across diffusion models).
 */
export function buildCoverPrompt(input: CoverPromptInput): string {
  const bits: string[] = [
    'square music album cover artwork',
    'high quality, professional, atmospheric, cinematic lighting',
  ];

  // Deliberately NOT including the title — Pollinations image models (especially
  // zimage with enhance=true) routinely render the title as visible text on the
  // cover even when we ask for "no text". Title goes into the song metadata,
  // the cover should be purely visual.
  if (input.caption.trim()) {
    bits.push(`genre and mood: ${input.caption.trim()}`);
  }
  if (input.topic.trim()) {
    bits.push(`inspired by: ${input.topic.trim()}`);
  }
  if (input.instrumental) {
    bits.push('purely instrumental track aesthetic, no vocalist persona');
  }

  // Strong negative guidance against any text rendering on the cover.
  // The leading "absolutely" + repeated phrasing helps zimage / enhance-true
  // honour the constraint.
  bits.push('absolutely no text anywhere, no letters, no words, no typography, no captions, no song title, no band name, no watermark, no logo, no signs, no signage');

  return bits.filter(Boolean).join(', ');
}
