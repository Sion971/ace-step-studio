/** Narrow subset of song meta that the cover prompt is built from. */
export interface CoverPromptInput {
  title: string;
  /** ACE-Step caption / style description, e.g. "synthwave, 80s, female vocals" */
  caption: string;
  /** Original user brief (the description the song was asked from) — '' if not present. */
  topic: string;
  /** Language code of the lyrics. The image prompt stays in English: the image model is English-trained. */
  language: string;
  /** True for instrumentals. Kept for callers; the prompt now steers away from people for every song. */
  instrumental: boolean;
  /** The song's lyrics. When present (and not an instrumental), they carry the imagery instead of the sound description. */
  lyrics?: string;
}

// The server keeps about 240 characters of the prompt (the image model reads ~77 tokens after "album cover art, <style>"):
// the budget below keeps the scenery clause (38 characters) inside them.
const MAX_CAPTION = 90;
const MAX_TOPIC = 70;
const MAX_LYRICS = 90;
const MAX_CAPTION_WITH_LYRICS = 50;
// Lyrics that are too short to say anything about the song.
const MIN_LYRICS_CHARS = 20;

/** Scenery the model draws well at 512 px, appended unless the user asked for a person themselves. */
const SCENERY = 'landscape, still life, abstract shapes';

/**
 * Words that put a person in the picture. SDXL Turbo draws faces badly at 512 px with a few steps (warped, uncanny), and
 * it draws one as soon as it reads "vocals" or "singer". A negative clause cannot help: the model runs without guidance,
 * and "no people" only adds the word "people". So the vocal descriptors are dropped and scenery is asked for instead.
 */
const VOCAL_WORDS =
  /\b(?:(?:fe)?male\s+)?(?:lead\s+|backing\s+)?(?:vocals?|vocalists?|voices?|singers?|singing|sung)\b|\b(?:fe)?male\b/gi;
/** The user's own brief names a person, so they want one: no scenery steering. */
const ASKS_FOR_PERSON =
  /\b(?:portrait|person|people|man|men|woman|women|girl|boy|face|faces|couple|child|children|dancer|musician|figure|silhouette|singer|band|crowd)\b/i;

/**
 * Instruments name what the song SOUNDS like, not what the cover shows: "solo piano" in the caption turned a large share of
 * the covers into pianos. Dropped from the caption whenever the lyrics carry the imagery.
 */
const INSTRUMENT_WORDS =
  /\b(?:grand\s+|acoustic\s+|electric\s+|solo\s+)*(?:pianos?|keys|keyboards?|guitars?|bass|drums?|percussion|synths?|synthesi[sz]ers?|violins?|cellos?|strings|saxophones?|saxes|trumpets?|flutes?|organs?|harps?|banjos?|ukuleles?|arpeggiated|arpeggios?|chords?)\b/gi;
/** Words of a lyric line that make the model draw a face or a couple. */
const LYRIC_PERSON_WORDS = /\b(?:baby|babe|girl|boy|man|woman|lady|darling|b[ée]b[ée]|ch[ée]r(?:i|ie))\b/gi;

/**
 * A few lines of the lyrics worth showing to the image model: the first chorus (the hook carries the theme), else the first
 * verse. Section tags, ad-libs in brackets and repeated lines are removed. Empty when there is nothing usable.
 */
export function lyricsImagery(lyrics: string): string {
  const sections: string[][] = [];
  let current: string[] = [];
  let currentIsChorus = false;
  const chorusIdx: number[] = [];
  const flush = () => {
    if (current.length > 0) {
      if (currentIsChorus) chorusIdx.push(sections.length);
      sections.push(current);
    }
    current = [];
    currentIsChorus = false;
  };
  for (const raw of lyrics.split(/\r?\n/)) {
    const tag = raw.trim().match(/^\[(.+?)\]$/);
    if (tag) {
      flush();
      currentIsChorus = /chorus|refrain|hook|ref\./i.test(tag[1]);
      continue;
    }
    const line = raw
      .replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g, ' ')
      .replace(LYRIC_PERSON_WORDS, ' ')
      .replace(/[\s]+/g, ' ')
      .replace(/^[\s,.;:!?-]+|[\s,;:-]+$/g, '')
      .trim();
    if (line) current.push(line);
  }
  flush();
  const section = sections[chorusIdx[0] ?? 0];
  if (!section) return '';
  const seen = new Set<string>();
  const lines = section.filter((l) => {
    const key = l.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return lines.join(', ');
}

const withoutVocalWords = (text: string): string =>
  text
    .replace(VOCAL_WORDS, '')
    .split(',')
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(', ');

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
 * Order: what the user typed (the brief), the imagery of the lyrics when the song has some (else nothing), the scenery
 * clause, then the caption cut to its first clause. The caption describes the SOUND ("solo piano"), so with lyrics it is
 * short and stripped of instruments. The title is left out: it would become visible lettering. A prompt tailored to the
 * lyrics by the language model replaces this one when there is one — see CreatePanel.
 */
export function buildCoverPrompt(input: CoverPromptInput): string {
  const imagery = input.instrumental || !input.lyrics ? '' : lyricsImagery(input.lyrics);
  const fromLyrics = imagery.length >= MIN_LYRICS_CHARS;
  const topic = clip(oneLine(input.topic), MAX_TOPIC);
  let caption = withoutVocalWords(oneLine(input.caption));
  if (fromLyrics) caption = withoutVocalWords(caption.replace(INSTRUMENT_WORDS, ''));
  caption = clip(caption, fromLyrics ? MAX_CAPTION_WITH_LYRICS : MAX_CAPTION);
  const scenery = ASKS_FOR_PERSON.test(topic) ? '' : SCENERY;

  const bits: string[] = [];
  if (topic) bits.push(topic);
  if (fromLyrics) {
    // The lyrics carry the imagery; the caption (a description of the sound) comes after the scenery clause.
    bits.push(clip(imagery, MAX_LYRICS));
    if (scenery) bits.push(scenery);
    if (caption && caption !== topic) bits.push(caption);
  } else {
    if (caption && caption !== topic) bits.push(caption);
    if (scenery) bits.push(scenery);
  }
  bits.push('atmospheric, cinematic lighting, highly detailed');
  return bits.join(', ');
}
