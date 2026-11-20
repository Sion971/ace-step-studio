// services/word-timing.ts
//
// Word-by-word karaoke: when each word of the synchronised lyrics is sung, from the words Whisper heard. The lines keep the
// times of their LRC; inside a line, a word lights up when Whisper heard it. A word heard out of its line's time window (a
// stray match) or not heard at all gets a time between its neighbours, in proportion to their lengths; a line where no word
// was heard keeps the even split of the plain karaoke.
import { alignWords, normalizeWords } from './lyrics-align.js';
import type { TimedWord } from './lyrics-structure.js';

export interface TimedLine {
  /** Start of the line (from the LRC), in seconds. */
  time: number;
  text: string;
}

/** A heard word may start this much before its line's LRC time and still count (LRC times are rounded, singers anticipate). */
const EARLY_S = 0.6;

/**
 * For each line, the start time of each of its words (split on spaces, as the karaoke shows them), or null when no word of
 * the line was heard. `lineEnds[i]` is when line i stops being sung (the next line's time, or the end of the song).
 */
export function wordStartsPerLine(lines: TimedLine[], lineEnds: number[], heardWords: TimedWord[]): (number[] | null)[] {
  // The heard words, split like the lyrics ("s'éteindre" heard as one word gives two tokens, both at its time).
  const heard: string[] = [];
  const heardTime: number[] = [];
  for (const w of heardWords) {
    for (const token of normalizeWords(w.word)) {
      heard.push(token);
      heardTime.push(w.start);
    }
  }

  // The lyric tokens, remembering their line and the shown word they belong to.
  const lyric: string[] = [];
  const owner: Array<{ line: number; word: number }> = [];
  const shownWords = lines.map((l) => l.text.split(/\s+/).filter(Boolean));
  shownWords.forEach((words, li) => {
    words.forEach((w, wi) => {
      for (const token of normalizeWords(w)) {
        lyric.push(token);
        owner.push({ line: li, word: wi });
      }
    });
  });
  const match = alignWords(lyric, heard);

  // A shown word takes the time of its first token that was heard inside the line's window.
  const found: (number | null)[][] = shownWords.map((words) => words.map(() => null));
  match.forEach((h, k) => {
    if (h < 0) return;
    const { line, word } = owner[k];
    const t = heardTime[h];
    if (t < lines[line].time - EARLY_S || t >= lineEnds[line]) return;
    if (found[line][word] === null) found[line][word] = t;
  });

  return shownWords.map((words, li) => {
    const times = found[li];
    if (!words.length || times.every((t) => t === null)) return null;
    const start = lines[li].time;
    const end = lineEnds[li];
    // Keep the heard times in order: one earlier than the word before it is a stray match.
    let last = -Infinity;
    const kept = times.map((t) => {
      if (t === null || t < last) return null;
      last = t;
      return t;
    });
    // Unheard words: between their neighbours, in proportion to the words' lengths.
    const weight = words.map((w) => Math.max(2, w.length));
    const out: number[] = new Array(words.length);
    let i = 0;
    while (i < words.length) {
      if (kept[i] !== null) { out[i] = kept[i] as number; i++; continue; }
      let j = i;
      while (j < words.length && kept[j] === null) j++;
      const from = i > 0 ? out[i - 1] : Math.min(start, kept[j] ?? start);
      // The last unheard words end the line at 90 % of its time, like the plain karaoke.
      const to = j < words.length ? (kept[j] as number) : Math.max(from, start + (end - start) * 0.9);
      const span = weight.slice(i > 0 ? i - 1 : i, j).reduce((a, b) => a + b, 0) || 1;
      let acc = i > 0 ? weight[i - 1] : 0;
      for (let k = i; k < j; k++) {
        out[k] = from + ((to - from) * acc) / span;
        acc += weight[k];
      }
      i = j;
    }
    // Never before the line starts, never backwards.
    for (let k = 0; k < out.length; k++) out[k] = Math.max(k ? out[k - 1] : start, out[k]);
    return out;
  });
}
