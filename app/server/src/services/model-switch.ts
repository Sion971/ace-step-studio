// services/model-switch.ts
//
// Whether the engine is changing its model. A model change reloads the model inside the running engine: its web server
// stays up, so "is the engine available?" says yes, but a generation sent during the change fails with "Model not fully
// initialized" (seen on 2026-11-17: a song started right after choosing another model in the Create tab). Generations wait
// here for the change to end.

let current: Promise<void> | null = null;

/** Marks the start of a model change; call the returned function when it ends, failed or not. */
export function beginModelSwitch(): () => void {
  let end!: () => void;
  const done = new Promise<void>((resolve) => { end = resolve; });
  current = done;
  return () => {
    if (current === done) current = null;
    end();
  };
}

export function isModelSwitching(): boolean {
  return current !== null;
}

/** Waits until no model change is going on (or `timeoutMs` passed); true when the engine is free. */
export async function waitForModelSwitch(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (current) {
    const left = deadline - Date.now();
    if (left <= 0) return false;
    await Promise.race([current, new Promise((r) => setTimeout(r, Math.min(left, 1000)))]);
  }
  return true;
}
