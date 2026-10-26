import type { SongDraft } from './llm/types';

/** What the engine's local LM returns for a description (POST /api/generate/create-sample). */
export interface LocalSample {
  caption?: string;
  lyrics?: string;
  bpm?: number;
  duration?: number;
  keyScale?: string;
  timeSignature?: string;
}

/**
 * Turns the local LM's answer into the same draft the OpenRouter pre-flight
 * produces, so the generation reads one kind of draft whatever wrote it.
 * Returns null when the LM gave neither a style nor lyrics: there is nothing
 * to build on, which counts as a failed pre-flight.
 */
export function sampleToDraft(sample: LocalSample | null | undefined): SongDraft | null {
  if (!sample) return null;
  const caption = (sample.caption || '').trim();
  const lyrics = (sample.lyrics || '').trim();
  if (!caption && !lyrics) return null;
  return {
    title: '',
    caption,
    lyrics,
    tags: [],
    bpm: sample.bpm && sample.bpm > 0 ? sample.bpm : 0,
    keyScale: sample.keyScale || '',
    timeSignature: sample.timeSignature || '',
    durationSec: sample.duration && sample.duration > 0 ? sample.duration : 0,
    coverPrompt: '',
  };
}

/** The LM takes a language to sing in, or nothing; the app's "Auto / Instrumental" value is 'unknown'. */
export function lmLanguage(vocalLanguage: string): string | undefined {
  return vocalLanguage && vocalLanguage !== 'unknown' ? vocalLanguage : undefined;
}
