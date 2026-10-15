/**
 * Longest song the engine accepts. The server learns it from the engine's start-up output, so it is not known for the first
 * seconds after a launch: ask again until it is, then stop.
 */
export interface EngineLimits {
  withLm: number;
  withoutLm: number;
}

interface WatchOptions {
  intervalMs?: number;
  maxAttempts?: number;
}

/** Returns a function that stops the watching. `onLimits` is called once, with the engine's own values. */
export function watchEngineLimits(
  fetchLimits: () => Promise<Response>,
  onLimits: (limits: EngineLimits) => void,
  { intervalMs = 3000, maxAttempts = 60 }: WatchOptions = {},
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const attempt = async (n: number) => {
    try {
      const response = await fetchLimits();
      if (response.ok) {
        const data = await response.json();
        if (typeof data.max_duration_with_lm === 'number' && typeof data.max_duration_without_lm === 'number') {
          if (!stopped) onLimits({ withLm: data.max_duration_with_lm, withoutLm: data.max_duration_without_lm });
          return;
        }
      }
    } catch {
      // the server or the engine is not up yet
    }
    if (!stopped && n + 1 < maxAttempts) timer = setTimeout(() => void attempt(n + 1), intervalMs);
  };

  void attempt(0);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
