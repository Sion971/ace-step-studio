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

const MAX_CAPTION = 160;
const MAX_TOPIC = 100;

const oneLine = (text: string, max: number): string => text.replace(/\s*[\r\n]+\s*/g, ', ').replace(/\s+/g, ' ').trim().slice(0, max).trim();

/**
 * The cover prompt sent to the local image model (SDXL Turbo). Short and purely positive on purpose: the model reads about
 * 77 tokens and is run without guidance, so a "no text, no logo" clause would not be obeyed — it would only add the words
 * "text" and "logo" to the picture. The server puts "album cover art" and a per-song art style in front of it.
 *
 * The title is left out: it would become visible lettering. A prompt tailored to the lyrics (LLM) replaces this one when
 * there is one — see CreatePanel.
 */
export function buildCoverPrompt(input: CoverPromptInput): string {
  const bits: string[] = [];
  const caption = oneLine(input.caption, MAX_CAPTION);
  const topic = oneLine(input.topic, MAX_TOPIC);
  if (caption) bits.push(caption);
  if (topic) bits.push(`inspired by ${topic}`);
  if (input.instrumental) bits.push('no people');
  bits.push('atmospheric, cinematic lighting, highly detailed');
  return bits.join(', ');
}
