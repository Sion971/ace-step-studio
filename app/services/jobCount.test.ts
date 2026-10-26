// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { totalGenerationSlots } from './jobCount';

describe('totalGenerationSlots', () => {
  it('counts the running and queued jobs plus the clicks still waiting', () => {
    expect(totalGenerationSlots(2, 7)).toBe(9);
  });
  it('shows the waiting clicks even when no job has reached the server yet', () => {
    expect(totalGenerationSlots(0, 3)).toBe(3);
  });
  it('is 0 when nothing is going on, and never negative', () => {
    expect(totalGenerationSlots(0, 0)).toBe(0);
    expect(totalGenerationSlots(-1, 0)).toBe(0);
    expect(totalGenerationSlots(1, -2)).toBe(1);
  });
});
