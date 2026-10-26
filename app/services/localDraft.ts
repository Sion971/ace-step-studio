import type { SongDraft } from './llm/types';

/** What the engine's local LM returns for a description (POST /api/generate/create-sample). */
export interface LocalSample {
  caption?: string;
  lyrics?: string;
  bpm?: number;
  duration?: number;
  keyScale?: string;
  timeSignature?: string;
  /** Language the LM picked for the lyrics ('' or 'unknown' when it did not). */
  vocalLanguage?: string;
}

/**
 * Turns the local LM's answer into the same draft the OpenRouter pre-flight
 * produces, so the generation reads one kind of draft whatever wrote it.
 * `description` is the user's text: a tempo written in it wins over the LM's.
 * Returns null when the LM gave neither a style nor lyrics: there is nothing
 * to build on, which counts as a failed pre-flight.
 */
export function sampleToDraft(sample: LocalSample | null | undefined, description = ''): SongDraft | null {
  if (!sample) return null;
  const caption = (sample.caption || '').trim();
  const lyrics = (sample.lyrics || '').trim();
  if (!caption && !lyrics) return null;
  return {
    title: '',
    caption,
    lyrics,
    tags: [],
    // A tempo written by the user in the description beats the LM's guess (a small LM often ignores it: 40, 50, 197 for "90-95 BPM").
    bpm: bpmFromText(description) || (sample.bpm && sample.bpm > 0 ? sample.bpm : 0),
    keyScale: sample.keyScale || '',
    timeSignature: sample.timeSignature || '',
    durationSec: sample.duration && sample.duration > 0 ? sample.duration : 0,
    coverPrompt: '',
    ...(realLanguage(sample.vocalLanguage) ? { language: realLanguage(sample.vocalLanguage) } : {}),
  };
}

/** The LM takes a language to sing in, or nothing; the app's "Auto / Instrumental" value is 'unknown'. */
export function lmLanguage(vocalLanguage: string): string | undefined {
  return vocalLanguage && vocalLanguage !== 'unknown' ? vocalLanguage : undefined;
}

const RANGE = String.raw`(\d{2,3})(?:\s*(?:-|–|—|to|à|a)\s*(\d{2,3}))?`;
const BPM_AFTER = new RegExp(RANGE + String.raw`\s*bpm\b`, 'i');
const BPM_BEFORE = new RegExp(String.raw`\bbpm\s*[:=]?\s*` + RANGE, 'i');

/**
 * The tempo the user wrote in a description ("90-95 BPM", "120bpm", "BPM: 100"), or 0.
 * A range gives its middle. Values outside 40-300 are ignored (not a tempo).
 */
export function bpmFromText(text: string): number {
  const m = BPM_AFTER.exec(text || '') || BPM_BEFORE.exec(text || '');
  if (!m) return 0;
  const lo = Number(m[1]);
  const hi = m[2] ? Number(m[2]) : lo;
  const ok = (n: number) => n >= 40 && n <= 300;
  if (!ok(lo)) return 0;
  return ok(hi) && hi >= lo ? Math.round((lo + hi) / 2) : lo;
}

/** A language code the engine can sing in: not empty, not 'unknown' (the app's Auto). */
export function realLanguage(code: string | undefined | null): string {
  const c = (code || '').trim();
  return c && c !== 'unknown' ? c : '';
}

/**
 * The language to send for the vocals. What the user chose wins; on Auto
 * ('unknown'), the language the LM wrote the lyrics in; otherwise unchanged.
 * Without it the engine got "unknown" for lyrics the LM had written in French.
 */
export function effectiveLanguage(userChoice: string, draftLanguage: string | undefined): string {
  return realLanguage(userChoice) || realLanguage(draftLanguage) || userChoice;
}
