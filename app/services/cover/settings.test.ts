import { describe, it, expect, beforeEach } from 'vitest';
import { aiCoverStorage } from './settings';

describe('aiCoverStorage', () => {
  beforeEach(() => localStorage.clear());

  it('is off until the user turns it on', () => {
    expect(aiCoverStorage.get()).toBe(false);
  });

  it('remembers the choice', () => {
    aiCoverStorage.set(true);
    expect(aiCoverStorage.get()).toBe(true);
    aiCoverStorage.set(false);
    expect(aiCoverStorage.get()).toBe(false);
  });
});
