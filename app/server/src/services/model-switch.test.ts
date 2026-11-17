// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { beginModelSwitch, isModelSwitching, waitForModelSwitch } from './model-switch.js';

describe('model change in progress', () => {
  it('makes a generation wait until the new model is loaded', async () => {
    const end = beginModelSwitch();
    expect(isModelSwitching()).toBe(true);
    let started = false;
    const waiting = waitForModelSwitch(5000).then((ok) => { started = ok; });
    await new Promise((r) => setTimeout(r, 20));
    expect(started).toBe(false);
    end();
    await waiting;
    expect(started).toBe(true);
    expect(isModelSwitching()).toBe(false);
  });

  it('does not wait when no model change is going on', async () => {
    expect(await waitForModelSwitch(10)).toBe(true);
  });

  it('gives up after the time limit', async () => {
    const end = beginModelSwitch();
    expect(await waitForModelSwitch(30)).toBe(false);
    end();
  });

  it('the end of an older change does not clear a newer one', async () => {
    const endFirst = beginModelSwitch();
    const endSecond = beginModelSwitch();
    endFirst();
    expect(isModelSwitching()).toBe(true);
    endSecond();
    expect(isModelSwitching()).toBe(false);
  });
});
