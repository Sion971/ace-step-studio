// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { Presence } from './presence.js';

/** A clock and a timer the test drives by hand. */
function fakeTime() {
  let t = 1_000_000;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let next = 1;
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => {
      const id = next++;
      timers.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimer: (h: unknown) => void timers.delete(h as number),
    pending: () => timers.size,
    /** Moves the clock; timers due fire in order. `jump` skips the time without waking timers in between (a sleeping computer). */
    advance(ms: number) {
      const end = t + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        t = due[1].at;
        due[1].fn();
      }
      t = end;
    },
    sleep(ms: number) {
      t += ms;
      const due = [...timers.entries()].filter(([, v]) => v.at <= t).sort((a, b) => a[1].at - b[1].at);
      for (const [id, v] of due) {
        timers.delete(id);
        v.fn();
      }
    },
  };
}

function make(options: { busy?: () => boolean; enabled?: boolean } = {}) {
  const time = fakeTime();
  const log: string[] = [];
  let quits = 0;
  const presence = new Presence({
    onQuit: () => void quits++,
    isBusy: options.busy,
    enabled: options.enabled,
    graceMs: 20_000,
    busyRecheckMs: 30_000,
    now: time.now,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
    log: (m) => void log.push(m),
  });
  return { presence, time, log, quits: () => quits };
}

describe('Presence', () => {
  it('stops the Studio once the last page has been gone for the grace period', () => {
    const { presence, time, quits } = make();
    const end = presence.connect();
    time.advance(60_000);
    expect(quits()).toBe(0); // a page is open
    end();
    time.advance(19_000);
    expect(quits()).toBe(0);
    time.advance(2_000);
    expect(quits()).toBe(1);
  });

  it('does not stop on a reload: the page comes back inside the grace period', () => {
    const { presence, time, quits } = make();
    presence.connect()();
    time.advance(5_000);
    const again = presence.connect();
    time.advance(120_000);
    expect(quits()).toBe(0);
    expect(presence.count).toBe(1);
    again();
  });

  it('keeps going while another page is still open', () => {
    const { presence, time, quits } = make();
    const a = presence.connect();
    const b = presence.connect();
    a();
    time.advance(120_000);
    expect(quits()).toBe(0);
    b();
    time.advance(21_000);
    expect(quits()).toBe(1);
  });

  it('never stops if no page ever connected (the browser may have failed to open)', () => {
    const { time, quits, presence } = make();
    time.advance(24 * 3600_000);
    expect(quits()).toBe(0);
    expect(presence.count).toBe(0);
  });

  it('does nothing when the mechanism is off', () => {
    const { presence, time, quits } = make({ enabled: false });
    presence.connect()();
    time.advance(10 * 60_000);
    expect(quits()).toBe(0);
  });

  it('waits for unfinished work, then stops', () => {
    let busy = true;
    const { presence, time, quits, log } = make({ busy: () => busy });
    presence.connect()();
    time.advance(21_000);
    expect(quits()).toBe(0);
    time.advance(5 * 60_000);
    expect(quits()).toBe(0);
    expect(log.filter((m) => m.includes('waiting')).length).toBe(1); // said once, not every re-check
    busy = false;
    time.advance(31_000);
    expect(quits()).toBe(1);
  });

  it('a page that comes back while it waits for the work cancels the stop', () => {
    let busy = true;
    const { presence, time, quits } = make({ busy: () => busy });
    presence.connect()();
    time.advance(21_000);
    presence.connect();
    busy = false;
    time.advance(10 * 60_000);
    expect(quits()).toBe(0);
  });

  it('does not conclude anything after the computer slept through the delay', () => {
    const { presence, time, quits } = make();
    presence.connect()();
    time.sleep(8 * 3600_000); // laptop lid closed: the pages could not reconnect yet
    expect(quits()).toBe(0);
    const back = presence.connect(); // they do, right after waking
    time.advance(60_000);
    expect(quits()).toBe(0);
    back();
  });

  it('asks only once and ignores a connection ended twice', () => {
    const { presence, time, quits } = make();
    const end = presence.connect();
    end();
    end();
    expect(presence.count).toBe(0);
    time.advance(5 * 60_000);
    expect(quits()).toBe(1);
  });
});
