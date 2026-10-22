// services/lyrics-duration.ts
//
// A length for a song whose duration is left on "auto". The engine cannot choose one without the language model (then it falls back to
// 120 s); with lyrics that do not fit in 120 s the model skips words. The length is estimated from the lyrics themselves: each sung line
// takes about two bars (a bar lasts 240 / bpm seconds), a long line takes more, an echo in parentheses overlaps the main line, and the sections without words
// (intro, outro, solo...) take their own time. The result is a rounded number of seconds, never below 60 s and never above `maxSeconds`.

const MIN_SECONDS = 60;
const DEFAULT_MAX_SECONDS = 240;
const MIN_BPM = 60;
const MAX_BPM = 180;
const DEFAULT_BPM = 100;
const TAIL_SECONDS = 6;
const BEATS_PER_BAR = 4;
// A line takes this many bars: 1.25 plus one bar per 8 words, at least 1.75 and at most 3 (calibrated on a 3:59 song of 30 lines at 90 bpm).
const BARS_BASE = 1.25;
const WORDS_PER_BAR = 8;
const MIN_BARS = 1.75;
const MAX_BARS = 3;
const ECHO_WEIGHT = 0.4;
const SECTION_GAP_SECONDS = 2;
const INSTRUMENTAL_SECTION_SECONDS = 8;
const INSTRUMENTAL_TAG = /\b(intro|outro|instrumental|interlude|solo|break|drop|buildup|build-up|fade)\b/i;
const VOCAL_TAG = /\b(verse|chorus|pre-chorus|prechorus|refrain|hook|bridge|breakdown|rap)\b/i;

export interface LyricsDurationOptions {
  /** Tempo in beats per minute when the user chose one; the line length follows it. */
  bpm?: number;
  /** Upper bound in seconds (the interface's maximum). */
  maxSeconds?: number;
}

function wordCount(text: string): number {
  return text.split(/[\s]+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** Seconds estimated for the lyrics, or null when they hold nothing to sing. */
export function estimateDurationFromLyrics(lyrics: string | null | undefined, options: LyricsDurationOptions = {}): number | null {
  if (!lyrics || !lyrics.trim()) return null;
  const bpm = Math.min(MAX_BPM, Math.max(MIN_BPM, options.bpm && options.bpm > 0 ? options.bpm : DEFAULT_BPM));
  const secondsPerBar = (BEATS_PER_BAR * 60) / bpm;
  const maxSeconds = options.maxSeconds && options.maxSeconds > MIN_SECONDS ? options.maxSeconds : DEFAULT_MAX_SECONDS;

  let seconds = 0;
  let sungLines = 0;
  for (const raw of lyrics.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const tag = /^\[(.*)\]$/.exec(line);
    if (tag) {
      const name = tag[1];
      if (INSTRUMENTAL_TAG.test(name) && !VOCAL_TAG.test(name)) seconds += INSTRUMENTAL_SECTION_SECONDS;
      else seconds += SECTION_GAP_SECONDS;
      continue;
    }
    const words = wordCount(line);
    if (words === 0) continue;
    const echo = /^\(.*\)$/.test(line);
    const bars = Math.min(MAX_BARS, Math.max(MIN_BARS, BARS_BASE + words / WORDS_PER_BAR));
    seconds += bars * secondsPerBar * (echo ? ECHO_WEIGHT : 1);
    if (!echo) sungLines += 1;
  }
  if (sungLines === 0) return null;
  seconds += TAIL_SECONDS;
  const rounded = Math.round(seconds / 5) * 5;
  return Math.min(maxSeconds, Math.max(MIN_SECONDS, rounded));
}
