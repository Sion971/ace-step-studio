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
  // The settings that most change a result, to compare a good generation with a bad one.
  const key = typeof args.key_scale === 'string' ? args.key_scale.trim() : '';
  parts.push(`key=${key || 'auto'}`);
  const guidance = asNumber(args.guidance_scale);
  if (guidance !== null) parts.push(`guidance=${guidance}`);
  const shift = asNumber(args.shift);
  if (shift !== null) parts.push(`shift=${shift}`);
  if (typeof args.use_adg === 'boolean') parts.push(`adg=${args.use_adg ? 'on' : 'off'}`);
  // random_seed_checkbox=false means the seed typed in the app is the one the engine must use.
  if (typeof args.random_seed_checkbox === 'boolean') {
    parts.push(`seed=${args.random_seed_checkbox ? 'random' : String(args.seed ?? '?')}`);
  }
  if (args.task_type === 'lego' || args.task_type === 'repaint') {
    const rs = asNumber(args.repainting_start);
    const re = asNumber(args.repainting_end);
    if (rs !== null || re !== null) parts.push(`region=${rs ?? 0}-${re !== null && re >= 0 ? re : 'end'}`);
  }
  const batch = asNumber(args.batch_size_input);
  if (batch !== null && batch > 1) parts.push(`batch=${batch}`);
  return `[Generate] ${parts.join(', ')}`;
}
