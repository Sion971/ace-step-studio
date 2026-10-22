// services/generation-log.ts
//
// One line in the server's terminal for each generation, with what is really sent to the engine: when a result is not what was asked
// (a language, a length), this tells whether the request or the engine is at fault, without searching the engine's long log.

const asNumber = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** "[Generate] vocal_language=fr, duration=225 s, ..." from the arguments given to the engine. */
export function describeGenerationArgs(args: Record<string, unknown>): string {
  const lyrics = typeof args.lyrics === 'string' ? args.lyrics : '';
  const lines = lyrics.split(/\r?\n/).filter((l) => l.trim() && !/^\[.*\]$/.test(l.trim())).length;
  const duration = asNumber(args.audio_duration);
  const bpm = asNumber(args.bpm);
  const parts = [
    `vocal_language=${typeof args.vocal_language === 'string' && args.vocal_language ? args.vocal_language : '(empty)'}`,
    `duration=${duration !== null && duration > 0 ? `${duration} s` : 'auto (engine decides)'}`,
    `bpm=${bpm !== null && bpm > 0 ? bpm : 'auto'}`,
    `lyrics=${lines} line${lines === 1 ? '' : 's'}`,
    `task=${typeof args.task_type === 'string' ? args.task_type : '?'}`,
  ];
  const steps = asNumber(args.inference_steps);
  if (steps !== null) parts.push(`steps=${steps}`);
  const batch = asNumber(args.batch_size_input);
  if (batch !== null && batch > 1) parts.push(`batch=${batch}`);
  return `[Generate] ${parts.join(', ')}`;
}
