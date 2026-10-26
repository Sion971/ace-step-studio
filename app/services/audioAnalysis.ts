// services/audioAnalysis.ts
//
// "Analyser l'audio" : ce que le moteur comprend d'un morceau importe (style, paroles, BPM, tonalite, mesure, duree,
// langue), et comment le reporter dans les champs de l'onglet Creer.

export interface AudioAnalysis {
  available: boolean;
  status: string;
  caption: string;
  lyrics: string;
  bpm: number | null;
  duration: number | null;
  keyScale: string;
  language: string;
  timeSignature: string;
}

export type AnalysisFieldId = 'caption' | 'lyrics' | 'bpm' | 'keyScale' | 'timeSignature' | 'duration' | 'language';

export class AnalysisError extends Error {
  constructor(public code: 'busy' | 'failed', message: string) {
    super(message);
  }
}

export async function analyzeAudio(audioUrl: string, token: string, signal?: AbortSignal): Promise<AudioAnalysis> {
  const response = await fetch('/api/audio-analysis', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ audioUrl }),
    signal,
  });
  const body = await response.json().catch(() => ({} as { analysis?: AudioAnalysis; error?: string }));
  if (response.status === 409) throw new AnalysisError('busy', 'busy');
  if (!response.ok || !body.analysis) throw new AnalysisError('failed', body.error || response.statusText);
  return body.analysis as AudioAnalysis;
}

/** The fields that actually have a value, in display order. */
export function availableFields(a: AudioAnalysis): AnalysisFieldId[] {
  const out: AnalysisFieldId[] = [];
  if (a.caption) out.push('caption');
  if (a.lyrics) out.push('lyrics');
  if (a.bpm) out.push('bpm');
  if (a.keyScale) out.push('keyScale');
  if (a.timeSignature) out.push('timeSignature');
  if (a.duration) out.push('duration');
  if (a.language) out.push('language');
  return out;
}

/** The engine takes the time signature as a number (2, 3, 4, 6); "4/4" and "6/8" are reduced to it. */
export function timeSignatureValue(text: string): string {
  const m = /^\s*(\d+)/.exec(text);
  return m ? m[1] : '';
}

export interface AnalysisSetters {
  setStyle: (v: string) => void;
  setLyrics: (v: string) => void;
  setBpm: (v: number) => void;
  setKeyScale: (v: string) => void;
  setTimeSignature: (v: string) => void;
  setDuration: (v: number) => void;
  setVocalLanguage: (v: string) => void;
}

/** Writes the chosen fields into the form. */
export function applyAnalysis(a: AudioAnalysis, chosen: ReadonlySet<AnalysisFieldId>, s: AnalysisSetters): void {
  if (chosen.has('caption') && a.caption) s.setStyle(a.caption);
  if (chosen.has('lyrics') && a.lyrics) s.setLyrics(a.lyrics);
  if (chosen.has('bpm') && a.bpm) s.setBpm(a.bpm);
  if (chosen.has('keyScale') && a.keyScale) s.setKeyScale(a.keyScale);
  if (chosen.has('timeSignature')) {
    const v = timeSignatureValue(a.timeSignature);
    if (v) s.setTimeSignature(v);
  }
  if (chosen.has('duration') && a.duration) s.setDuration(Math.round(a.duration));
  if (chosen.has('language') && a.language && a.language !== 'unknown') s.setVocalLanguage(a.language);
}
