export const DEFAULT_STARTUP_LM = 'acestep-5Hz-lm-0.6B';

/**
 * The language model the engine starts with.
 *
 * `LM_MODEL` is this launcher's own variable. `ACESTEP_LM_MODEL_PATH` is the one
 * ACE-Step-1.5/.env.example documents (and the engine's own start scripts read):
 * it used to be silently ignored here, so a user who set it as documented kept
 * getting the 0.6B. Either works; `LM_MODEL` wins when both are set.
 */
export function startupLmModel(env: Record<string, string | undefined> = process.env): string {
  return (env.LM_MODEL || '').trim() || (env.ACESTEP_LM_MODEL_PATH || '').trim() || DEFAULT_STARTUP_LM;
}
