// services/lyrics-structure.ts
//
// Whisper gives the sung phrases with their times, not the song's sections. This rebuilds [Verse] / [Chorus]... WITHOUT touching a word:
//  - a pause between two phrases starts a new stanza,
//  - stanzas that come back (same words, even slightly different) are the chorus,
//  - a long pause with no singing is an [Instrumental] (or the [Intro] at the start).
//  - a stanza that runs on for more than MAX_STANZA_LINES phrases is cut at its longest pauses (sung phrases often follow each other
//    with less than STANZA_GAP_S between them).
// The labels are a guess from the repetitions and the pauses; the words are Whisper's.

export interface TimedLine { start: number; end: number; text: string }

export const STANZA_GAP_S = 2;
export const INSTRUMENTAL_GAP_S = 10;
export const INTRO_S = 10;
export const MAX_STANZA_LINES = 6;
export const MIN_SPLIT_GAP_S = 0.5;

export interface TimedWord { start: number; end: number; word: string }

/** A pause this long between two words ends the phrase; so does a comma, a full stop... after a word. */
export const PHRASE_GAP_S = 0.6;
export const MAX_PHRASE_WORDS = 12;

/**
 * Whisper's own segments follow each other without a gap (one starts where the previous ends), so the pauses of the song are
 * lost. The times of the WORDS keep them: the phrases are rebuilt from the words, cut at a pause or at the punctuation.
 */
export function wordsToLines(words: TimedWord[]): TimedLine[] {
  const lines: TimedLine[] = [];
  let cur: { start: number; end: number; words: string[] } | null = null;
  for (const w of words) {
    const text = w.word.trim();
    if (!text) continue;
    const prev: string | undefined = cur?.words[cur.words.length - 1];
    const breaks = !cur || !(w.start - cur.end < PHRASE_GAP_S) || /[,.;:!?…]$/.test(prev || '') || cur.words.length >= MAX_PHRASE_WORDS;
    if (breaks) {
      if (cur) lines.push({ start: cur.start, end: cur.end, text: cur.words.join(' ') });
      cur = { start: w.start, end: w.end, words: [text] };
    } else if (cur) {
      cur.words.push(text);
      cur.end = Math.max(cur.end, w.end);
    }
  }
  if (cur) lines.push({ start: cur.start, end: cur.end, text: cur.words.join(' ') });
  return lines;
}

/** Whisper writes "...", "♪" or nothing for music: not lyrics. */
export const isNoise = (text: string): boolean => /^[\s.…♪♫\-–—_*]*$/.test(text);

const words = (lines: string[]): Set<string> =>
  new Set(
    lines.join(' ').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9À-￿\s]/g, ' ').split(/\s+/).filter((w) => w.length > 1),
  );

/** Share of words in common (0..1). */
export function similarity(a: string[], b: string[]): number {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return 0;
  let common = 0;
  for (const w of x) if (y.has(w)) common++;
  return common / Math.min(x.size, y.size) * 0.5 + common / new Set([...x, ...y]).size * 0.5;
}

/**
 * `labels`: write the [Verse] / [Chorus]... tags. Off by default: they are a guess from pauses and repetitions that is often wrong on
 * real songs, and a wrong tag is worse than none. Without them the stanzas are only separated by a blank line.
 */
export function structureLyrics(input: TimedLine[], labels = false): string {
  const lines = input.map((l) => ({ ...l, text: l.text.trim() })).filter((l) => l.text && !isNoise(l.text));
  if (!lines.length) return '';

  // Stanzas: a pause starts a new one.
  type Line = { start: number; end: number; text: string };
  const raw: Line[][] = [];
  for (const l of lines) {
    const last = raw[raw.length - 1];
    if (last && !(l.start - last[last.length - 1].end >= STANZA_GAP_S)) last.push(l); // no times (NaN): same stanza
    else raw.push([l]);
  }
  // A long run of phrases is cut where the pause is longest.
  const split = (run: Line[]): Line[][] => {
    if (run.length <= MAX_STANZA_LINES) return [run];
    let at = -1;
    let best = MIN_SPLIT_GAP_S;
    for (let i = 1; i < run.length; i++) {
      const gap = run[i].start - run[i - 1].end;
      // Prefer cutting near the middle when pauses are alike.
      if (gap > best + 1e-9 || (at > 0 && Math.abs(gap - best) < 1e-9 && Math.abs(i - run.length / 2) < Math.abs(at - run.length / 2))) { best = gap; at = i; }
    }
    if (at < 0) return [run];
    return [...split(run.slice(0, at)), ...split(run.slice(at))];
  };
  const stanzas = raw.flatMap(split).map((run) => ({ lines: run.map((l) => l.text), start: run[0].start, end: run[run.length - 1].end }));
  // Too little to tell sections apart: the plain phrases.
  if (stanzas.length < 2) return lines.map((l) => l.text).join('\n');

  // Groups of stanzas that come back.
  const group: number[] = stanzas.map((_, i) => i);
  for (let i = 0; i < stanzas.length; i++) {
    for (let j = i + 1; j < stanzas.length; j++) {
      if (group[j] === j && similarity(stanzas[i].lines, stanzas[j].lines) >= 0.6) group[j] = group[i];
    }
  }
  const size = new Map<number, number>();
  group.forEach((g) => size.set(g, (size.get(g) || 0) + 1));
  const repeated = [...size.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const chorusGroup = repeated.length ? repeated[0][0] : -1;

  const lastChorus = group.lastIndexOf(chorusGroup);
  let choruses = 0;
  let verse = 0;
  const out: string[] = [];
  const first = stanzas[0];
  if (labels && first.start >= INTRO_S) out.push('[Intro]', '');
  stanzas.forEach((s, i) => {
    if (i > 0 && s.start - stanzas[i - 1].end >= INSTRUMENTAL_GAP_S) { if (labels) out.push('[Instrumental]', ''); }
    let tag: string;
    if (group[i] === chorusGroup) { tag = 'Chorus'; choruses++; }
    else if (size.get(group[i])! < 2 && choruses >= 2 && i < lastChorus) tag = 'Bridge';
    else if (size.get(group[i])! < 2 && lastChorus >= 0 && i > lastChorus) tag = 'Outro';
    else { verse++; tag = `Verse ${verse}`; }
    out.push(...(labels ? [`[${tag}]`] : []), ...s.lines, '');
  });
  return out.join('\n').trim();
}
