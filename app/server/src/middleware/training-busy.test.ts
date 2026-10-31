// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trainingRunner } from '../services/training-runner.js';
import { TRAINING_BUSY_MESSAGE, blockWhileTraining } from './training-busy.js';

function fakeResponse() {
  const res: { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
}

describe('the guard that keeps the card for a running training', () => {
  afterEach(() => vi.restoreAllMocks());

  it('lets the request through when no training runs', () => {
    vi.spyOn(trainingRunner, 'isRunning').mockReturnValue(false);
    const res = fakeResponse();
    const next = vi.fn();
    blockWhileTraining({} as never, res as never, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('refuses it with a 409 and the reason while a training runs', () => {
    vi.spyOn(trainingRunner, 'isRunning').mockReturnValue(true);
    const res = fakeResponse();
    const next = vi.fn();
    blockWhileTraining({} as never, res as never, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ error: TRAINING_BUSY_MESSAGE, code: 'training_running' });
  });
});
