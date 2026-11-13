// services/lyrics-align.ts
//
// Synchronised lyrics (LRC) timed from what Whisper heard.
//
// The engine times the lyrics from the model's attention, which is often wrong at the start of a song: the first
// lines of a verse all land on 00:00.00, or the first sung line is put in the middle of an instrumental intro. Whisper
// hears the song and gives the time of each sung word, but mishears some words. Here the written lyrics stay as they
// are and only take their times from Whisper: the two word sequences are aligned (in order, allowing words missing on
// either side), and each line starts at the time of its first word that was heard. Lines with no word heard get a time
// between their neighbours.
import type { TimedWord } from './lyrics-structure.js';

export interface AlignedLine {
  /** Start time in seconds. */
  time: number;
  /** The line as written in the lyrics. */
  text: string;
  /** A [Verse] / [Chorus]... tag. */
  isSection: boolean;
  /** True when the time comes from words Whisper heard, false when it was estimated from the neighbours. */
  heard: boolean;
}

export interface AlignResult {
  lines: AlignedLine[];
  /** Lyric words matched to a heard word, and lyric words in all (sections excluded). */
  matchedWords: number;
  totalWords: number;
  lrc: string;
}

const SECTION_RE = /^\s*\[[^\]]*\]\s*$/;

/** Lower case, no accents, letters and digits only; "s'éteindre" gives "s" and "eteindre". */
export function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9Ѐ-ӿ぀-ヿ一-鿿가-힯]+/g, ' ')
    .split(' ')
    .filter(Boolean);
}

/** How close two normalised words are, from 0 to 1 (1 - edit distance / longer length). */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const m = a.length;
  const n = b.length;
  if (!m || !n) return 0;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}

const MATCH_EXACT = 3;
const MATCH_CLOSE = 1.5; // similarity >= 0.6: a misheard word ("l'anio" for "l'agneau")
const MISMATCH = -2;
const GAP = -1;

/**
 * Global alignment of the lyric words with the heard words (Needleman-Wunsch).
 * Returns, for each lyric word, the index of the heard word it matches, or -1.
 */
export function alignWords(lyric: string[], heard: string[]): number[] {
  const m = lyric.length;
  const n = heard.length;
  const result = new Array<number>(m).fill(-1);
  if (!m || !n) return result;
  // score[i][j] for lyric[0..i) and heard[0..j); move 0 = diagonal, 1 = skip a lyric word, 2 = skip a heard word.
  const score = new Float64Array((m + 1) * (n + 1));
  const move = new Uint8Array((m + 1) * (n + 1));
  const at = (i: number, j: number) => i * (n + 1) + j;
  for (let i = 1; i <= m; i++) { score[at(i, 0)] = i * GAP; move[at(i, 0)] = 1; }
  for (let j = 1; j <= n; j++) { score[at(0, j)] = j * GAP; move[at(0, j)] = 2; }
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const s = similarity(lyric[i - 1], heard[j - 1]);
      const pair = s === 1 ? MATCH_EXACT : s >= 0.6 ? MATCH_CLOSE : MISMATCH;
      const diag = score[at(i - 1, j - 1)] + pair;
      const up = score[at(i - 1, j)] + GAP;
      const left = score[at(i, j - 1)] + GAP;
      if (diag >= up && diag >= left) { score[at(i, j)] = diag; move[at(i, j)] = 0; }
      else if (up >= left) { score[at(i, j)] = up; move[at(i, j)] = 1; }
      else { score[at(i, j)] = left; move[at(i, j)] = 2; }
    }
  }
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    const mv = move[at(i, j)];
    if (mv === 0) {
      if (similarity(lyric[i - 1], heard[j - 1]) >= 0.6) result[i - 1] = j - 1;
      i--; j--;
    } else if (mv === 1) i--;
    else j--;
  }
  return result;
}

const fmt = (t: number): string => {
  const total = Math.max(0, Math.round(t * 100));
  const minutes = Math.floor(total / 6000);
  const rest = total - minutes * 6000;
  return `[${String(minutes).padStart(2, '0')}:${String(Math.floor(rest / 100)).padStart(2, '0')}.${String(rest % 100).padStart(2, '0')}]`;
};

export function toLrc(lines: AlignedLine[]): string {
  return lines.map((l) => `${fmt(l.time)}${l.text}`).join('\n');
}

/**
 * Times the lines of `lyrics` from the words Whisper heard.
 * `duration` (seconds) bounds the estimated times of the last lines when nothing after them was heard.
 */
export function alignLyrics(lyrics: string, heardWords: TimedWord[], duration?: number): AlignResult {
  const rawLines = lyrics.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  // Heard words, split like the lyrics ("s'éteindre" heard as one word gives two, both at its time).
  const heard: string[] = [];
  const heardTime: number[] = [];
  for (const w of heardWords) {
    for (const token of normalizeWords(w.word)) {
      heard.push(token);
      heardTime.push(w.start);
    }
  }

  const lyricTokens: string[] = [];
  const tokenLine: number[] = [];
  const lineTokenCount = rawLines.map(() => 0);
  rawLines.forEach((line, li) => {
    if (SECTION_RE.test(line)) return;
    for (const token of normalizeWords(line)) {
      lyricTokens.push(token);
      tokenLine.push(li);
      lineTokenCount[li]++;
    }
  });

  const match = alignWords(lyricTokens, heard);

  // A line starts at the time of its first heard word, set back by the words before it that were not heard.
  const times: (number | null)[] = rawLines.map(() => null);
  const firstIdx: number[] = rawLines.map(() => -1);
  let matchedWords = 0;
  lyricTokens.forEach((_, k) => {
    const li = tokenLine[k];
    if (firstIdx[li] === -1) firstIdx[li] = k;
    if (match[k] < 0) return;
    matchedWords++;
    if (times[li] === null) {
      const before = k - firstIdx[li];
      times[li] = Math.max(0, heardTime[match[k]] - before * 0.3);
    }
  });

  // Keep the heard times in order: a time earlier than an earlier line's is a stray match and is dropped.
  let last = -Infinity;
  for (let li = 0; li < rawLines.length; li++) {
    const t = times[li];
    if (t === null) continue;
    if (t < last) times[li] = null;
    else last = t;
  }

  // Lines with no heard word (and the section tags) get a time between their neighbours, in proportion to their words.
  const heardFlag = times.map((t) => t !== null);
  const end = duration && duration > 0 ? duration : null;
  let li = 0;
  while (li < rawLines.length) {
    if (times[li] !== null) { li++; continue; }
    let k = li;
    while (k < rawLines.length && times[k] === null) k++;
    const prevT = li > 0 ? (times[li - 1] as number) : null;
    const nextT = k < rawLines.length ? (times[k] as number) : null;
    const weights = rawLines.slice(li, k).map((_, o) => Math.max(1, lineTokenCount[li + o]));
    if (prevT === null && nextT !== null) {
      // Before the first heard line: section tags just before it take its time, sung lines a little before.
      for (let o = k - 1, t = nextT; o >= li; o--) {
        if (SECTION_RE.test(rawLines[o])) times[o] = t;
        else { t = Math.max(0, t - lineTokenCount[o] * 0.4); times[o] = t; }
      }
    } else if (prevT !== null) {
      const stop = nextT !== null ? nextT : end !== null ? Math.max(prevT, end - 1) : prevT + weights.reduce((a, b) => a + b, 0) * 0.4;
      // The previous line keeps its own words' share of the gap.
      const prevWeight = Math.max(1, lineTokenCount[li - 1]);
      const total = prevWeight + weights.reduce((a, b) => a + b, 0);
      let acc = prevWeight;
      for (let o = li; o < k; o++) {
        // A section tag starts with the line that follows it.
        times[o] = prevT + ((stop - prevT) * acc) / total;
        if (!SECTION_RE.test(rawLines[o])) acc += weights[o - li];
      }
    } else {
      for (let o = li; o < k; o++) times[o] = 0;
    }
    li = k;
  }
  // A section tag takes the time of the line after it.
  for (let o = rawLines.length - 2; o >= 0; o--) {
    if (SECTION_RE.test(rawLines[o]) && !SECTION_RE.test(rawLines[o + 1])) times[o] = times[o + 1];
  }

  const lines: AlignedLine[] = rawLines.map((text, o) => ({
    time: Math.round((times[o] as number) * 100) / 100,
    text,
    isSection: SECTION_RE.test(text),
    heard: heardFlag[o],
  }));
  return { lines, matchedWords, totalWords: lyricTokens.length, lrc: toLrc(lines) };
}
