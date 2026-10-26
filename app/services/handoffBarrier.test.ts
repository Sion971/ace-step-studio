// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createHandoffBarrier } from './handoffBarrier';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('createHandoffBarrier', () => {
  it('lets the first click go at once', async () => {
    const b = createHandoffBarrier();
    let went = false;
    b.enter().previous.then(() => { went = true; });
    await tick();
    expect(went).toBe(true);
  });

  it('holds the second click until the first has handed off', async () => {
    const b = createHandoffBarrier();
    const first = b.enter();
    const second = b.enter();
    let secondWent = false;
    second.previous.then(() => { secondWent = true; });
    await tick();
    expect(secondWent).toBe(false);
    first.done();
    await tick();
    expect(secondWent).toBe(true);
  });

  it('keeps the order across three clicks, even when they finish out of order', async () => {
    const b = createHandoffBarrier();
    const a = b.enter(); const c2 = b.enter(); const c3 = b.enter();
    const order: number[] = [];
    c2.previous.then(() => order.push(2));
    c3.previous.then(() => order.push(3));
    c3.done(); // finishing early (cancelled) must not release the second one
    await tick();
    expect(order).toEqual([]);
    a.done();
    await tick();
    expect(order).toEqual([2]);
    c2.done();
    await tick();
    expect(order).toEqual([2, 3]);
  });

  it('calling done twice is harmless', async () => {
    const b = createHandoffBarrier();
    const first = b.enter();
    first.done(); first.done();
    let went = false;
    b.enter().previous.then(() => { went = true; });
    await tick();
    expect(went).toBe(true);
  });
});
