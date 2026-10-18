// @vitest-environment node
import { describe, it, expect, afterEach, vi } from 'vitest';
import { startPresence } from './presence';

afterEach(() => vi.unstubAllGlobals());

describe('startPresence', () => {
  it('opens one event stream on /api/presence', () => {
    const opened: string[] = [];
    vi.stubGlobal('EventSource', class { constructor(url: string) { opened.push(url); } });
    expect(startPresence()).not.toBeNull();
    expect(opened).toEqual(['/api/presence']);
  });

  it('does nothing where the browser has no EventSource', () => {
    vi.stubGlobal('EventSource', undefined);
    expect(startPresence()).toBeNull();
  });

  it('never breaks the page if opening fails', () => {
    vi.stubGlobal('EventSource', class { constructor() { throw new Error('blocked'); } });
    expect(startPresence()).toBeNull();
  });
});
