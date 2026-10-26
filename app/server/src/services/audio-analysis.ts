// services/audio-analysis.ts
//
// "Analyser l'audio" : ce que le moteur comprend d'un morceau (description du style, paroles, BPM, tonalite, mesure,
// duree, langue). Le moteur convertit l'audio en codes, puis son modele de langage les lit (evenement Gradio
// `analyze_src_audio`, le meme que « Analyze » de l'interface Gradio).

export interface AudioAnalysis {
  /** The language model was loaded and answered. False: only the codes were made (nothing to show). */
  available: boolean;
  /** The engine's own status line (also the reason when `available` is false). */
  status: string;
  caption: string;
  lyrics: string;
  bpm: number | null;
  duration: number | null;
  keyScale: string;
  language: string;
  timeSignature: string;
}

const text = (v: unknown): string => (typeof v === 'string' && v.trim().toUpperCase() !== 'N/A' ? v.trim() : '');
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Turns the engine's answer (a list of 10 values: codes, status, caption, lyrics, bpm, duration, key, language, signature, flag). */
export function parseAnalysis(data: unknown): AudioAnalysis {
  const d = Array.isArray(data) ? data : [];
  const analysis: AudioAnalysis = {
    available: false,
    status: text(d[1]),
    caption: text(d[2]),
    lyrics: text(d[3]),
    bpm: num(d[4]) === null ? null : Math.round(num(d[4]) as number),
    duration: num(d[5]),
    keyScale: text(d[6]),
    language: text(d[7]),
    timeSignature: text(d[8]),
  };
  analysis.available = Boolean(
    analysis.caption || analysis.lyrics || analysis.bpm || analysis.keyScale || analysis.timeSignature || analysis.language,
  );
  return analysis;
}

export interface AnalysisDeps {
  prepareFile: (audioUrl: string) => Promise<unknown>;
  predict: (endpoint: string, args: unknown[]) => Promise<{ data: unknown }>;
}

export async function analyzeAudio(audioUrl: string, deps: AnalysisDeps): Promise<AudioAnalysis> {
  const file = await deps.prepareFile(audioUrl);
  if (!file) throw new Error('Audio file not found');
  const result = await deps.predict('/analyze_src_audio', [file, false]);
  return parseAnalysis(result.data);
}
