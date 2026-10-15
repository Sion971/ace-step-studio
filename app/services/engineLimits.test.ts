import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchEngineLimits } from './engineLimits';

const ok = (body: unknown) => ({ ok: true, json: async () => body }) as unknown as Response;
const notYet = () => ({ ok: false, json: async () => ({}) }) as unknown as Response;

describe('watchEngineLimits', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reports the engine values as soon as the server has them', async () => {
    const onLimits = vi.fn();
    const fetchLimits = vi.fn().mockResolvedValue(ok({ max_duration_with_lm: 480, max_duration_without_lm: 600 }));
    watchEngineLimits(fetchLimits, onLimits);
    await vi.advanceTimersByTimeAsync(0);
    expect(onLimits).toHaveBeenCalledWith({ withLm: 480, withoutLm: 600 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchLimits).toHaveBeenCalledTimes(1);
  });

  it('asks again every few seconds while the engine has not reported them (503, or server down)', async () => {
    const onLimits = vi.fn();
    const fetchLimits = vi.fn()
      .mockResolvedValueOnce(notYet())
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValue(ok({ max_duration_with_lm: 240, max_duration_without_lm: 360 }));
    watchEngineLimits(fetchLimits, onLimits, { intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(onLimits).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(onLimits).toHaveBeenCalledWith({ withLm: 240, withoutLm: 360 });
    expect(fetchLimits).toHaveBeenCalledTimes(3);
  });

  it('gives up after maxAttempts, and stops when told to', async () => {
    const fetchLimits = vi.fn().mockResolvedValue(notYet());
    watchEngineLimits(fetchLimits, vi.fn(), { intervalMs: 1000, maxAttempts: 3 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchLimits).toHaveBeenCalledTimes(3);

    const other = vi.fn().mockResolvedValue(notYet());
    const stop = watchEngineLimits(other, vi.fn(), { intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(other).toHaveBeenCalledTimes(1);
  });
});
