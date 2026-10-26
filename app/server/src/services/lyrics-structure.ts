// services/lyrics-structure.ts
//
// Whisper gives the sung phrases with their times, not the song's sections. This rebuilds [Verse] / [Chorus]... WITHOUT touching a word:
//  - a pause between two phrases starts a new stanza,
//  - stanzas that come back (same words, even slightly different) are the chorus,
//  - a long pause with no singing is an [Instrumental] (or the [Intro] at the start).
// The labels are a guess from the repetitions and the pauses; the words are Whisper's.

export interface TimedLine { start: number; end: number; text: string }

export const STANZA_GAP_S = 2;
export const INSTRUMENTAL_GAP_S = 10;
export const INTRO_S = 10;

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

export function structureLyrics(input: TimedLine[]): string {
  const lines = input.map((l) => ({ ...l, text: l.text.trim() })).filter((l) => l.text && !isNoise(l.text));
  if (!lines.length) return '';

  // Stanzas: a pause starts a new one.
  const stanzas: { lines: string[]; start: number; end: number }[] = [];
  for (const l of lines) {
    const last = stanzas[stanzas.length - 1];
    if (last && !(l.start - last.end >= STANZA_GAP_S)) { // no times (NaN): same stanza
      last.lines.push(l.text);
      last.end = Math.max(last.end, l.end);
    } else {
      stanzas.push({ lines: [l.text], start: l.start, end: l.end });
    }
  }
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
  if (first.start >= INTRO_S) out.push('[Intro]', '');
  stanzas.forEach((s, i) => {
    if (i > 0 && s.start - stanzas[i - 1].end >= INSTRUMENTAL_GAP_S) out.push('[Instrumental]', '');
    let tag: string;
    if (group[i] === chorusGroup) { tag = 'Chorus'; choruses++; }
    else if (size.get(group[i])! < 2 && choruses >= 2 && i < lastChorus) tag = 'Bridge';
    else if (size.get(group[i])! < 2 && lastChorus >= 0 && i > lastChorus) tag = 'Outro';
    else { verse++; tag = `Verse ${verse}`; }
    out.push(`[${tag}]`, ...s.lines, '');
  });
  return out.join('\n').trim();
}
