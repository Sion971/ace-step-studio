/** Narrow subset of song meta that the cover prompt is built from. */
export interface CoverPromptInput {
  title: string;
  /** ACE-Step caption / style description, e.g. "synthwave, 80s, female vocals" */
  caption: string;
  /** Original user brief (the description the song was asked from) — '' if not present. */
  topic: string;
  /** Language code of the lyrics. The image prompt stays in English: the image model is English-trained. */
  language: string;
  /** True for instrumentals — adds a hint about no vocalist persona. */
  instrumental: boolean;
}

const MAX_CAPTION = 110;
const MAX_TOPIC = 100;

const oneLine = (text: string): string => text.replace(/\s*[\r\n]+\s*/g, ', ').replace(/\s+/g, ' ').trim();

/**
 * At most `max` characters, cut at the last comma / full stop / semicolon, else the last space, never in the middle of a
 * word: the language model writes a whole paragraph as caption, and a sentence cut in half reads as noise to the image model.
 */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const stop = Math.max(head.lastIndexOf(','), head.lastIndexOf('.'), head.lastIndexOf(';'));
  const cut = stop >= max * 0.4 ? stop : head.lastIndexOf(' ');
  return (cut > 0 ? head.slice(0, cut) : head).replace(/[\s,.;:]+$/, '');
}

/**
 * The cover prompt sent to the local image model (SDXL Turbo). Short and purely positive on purpose: the model reads about
 * 77 tokens and is run without guidance, so a "no text, no logo" clause would not be obeyed — it would only add the words
 * "text" and "logo" to the picture. The server puts "album cover art" and a per-song art style in front of it.
 *
 * What the user typed (the brief) comes first, then the caption cut to its first clause. The title is left out: it would
 * become visible lettering. A prompt tailored to the lyrics (LLM) replaces this one when there is one — see CreatePanel.
 */
export function buildCoverPrompt(input: CoverPromptInput): string {
  const bits: string[] = [];
  const topic = clip(oneLine(input.topic), MAX_TOPIC);
  const caption = clip(oneLine(input.caption), MAX_CAPTION);
  if (topic) bits.push(topic);
  if (caption && caption !== topic) bits.push(caption);
  if (input.instrumental) bits.push('no people');
  bits.push('atmospheric, cinematic lighting, highly detailed');
  return bits.join(', ');
}
