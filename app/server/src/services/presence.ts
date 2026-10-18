// services/presence.ts
//
// Stops the Studio when its page is closed. Started from the desktop launcher with no terminal window, the Studio had no way
// to be stopped: closing the browser tab left the server and the engine running (and the engine holds the graphics card).
//
// How: every open Studio page keeps one connection to GET /api/presence (routes/presence.ts). This class counts them. When
// the last one goes away it waits a grace period (a reload, or a tab the browser discarded and brings back, reconnects within
// seconds) and then asks for the shutdown. It never stops while there is unfinished work (a generation, a training run, a
// model download): it re-checks until the work is over, and a page that comes back cancels everything.
//
// Nothing happens until a page has connected at least once: a browser that failed to open must not make the Studio quit
// before anyone saw it. The whole mechanism is switched on by STUDIO_QUIT_ON_CLOSE=true (run.sh --quit-on-close).

export const DEFAULT_GRACE_MS = 20_000;
export const DEFAULT_BUSY_RECHECK_MS = 30_000;
/** A timer that fires this much later than planned means the computer was asleep: the pages had no chance to reconnect. */
const SLEEP_LATENESS_MS = 5_000;

export interface PresenceOptions {
  /** False: pages are counted but the Studio is never stopped (the default way to run it, from a terminal). */
  enabled?: boolean;
  /** Called once, when the Studio has been left alone long enough and is idle. */
  onQuit: () => void;
  /** True while something must not be interrupted (generation, training, download). */
  isBusy?: () => boolean;
  graceMs?: number;
  busyRecheckMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  log?: (message: string) => void;
}

export class Presence {
  private readonly enabled: boolean;
  private readonly onQuit: () => void;
  private readonly isBusy: () => boolean;
  private readonly graceMs: number;
  private readonly busyRecheckMs: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly log: (message: string) => void;

  private clients = 0;
  private seen = false;
  private quit = false;
  private waitingBusy = false;
  private timer: unknown = null;

  constructor(options: PresenceOptions) {
    this.enabled = options.enabled ?? true;
    this.onQuit = options.onQuit;
    this.isBusy = options.isBusy ?? (() => false);
    this.graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
    this.busyRecheckMs = options.busyRecheckMs ?? DEFAULT_BUSY_RECHECK_MS;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
    this.log = options.log ?? ((message) => console.log(message));
  }

  get count(): number {
    return this.clients;
  }

  /** A page connected. Returns the function to call when that connection ends (safe to call twice). */
  connect(): () => void {
    this.clients += 1;
    this.seen = true;
    this.cancel();
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.clients = Math.max(0, this.clients - 1);
      if (this.clients === 0) this.arm(this.graceMs, false);
    };
  }

  private cancel(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.waitingBusy = false;
  }

  private arm(delayMs: number, rechecking: boolean): void {
    if (!this.enabled || this.quit || !this.seen) return;
    if (this.timer !== null) this.clearTimer(this.timer);
    const armedAt = this.now();
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (this.quit || this.clients > 0) return;
      // The computer slept through the delay: give the pages a fresh chance to reconnect before concluding anything.
      if (this.now() - armedAt - delayMs > SLEEP_LATENESS_MS) {
        this.arm(this.graceMs, false);
        return;
      }
      if (this.isBusy()) {
        if (!rechecking || !this.waitingBusy) this.log('[Presence] No page is open but work is still running: waiting for it to finish before stopping.');
        this.waitingBusy = true;
        this.arm(this.busyRecheckMs, true);
        return;
      }
      this.quit = true;
      this.log('[Presence] The page was closed: stopping the Studio.');
      this.onQuit();
    }, delayMs);
  }
}
