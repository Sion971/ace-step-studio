// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { browserOpenCommand, maybeOpenBrowser } from './open-browser.js';

describe('browserOpenCommand', () => {
  it('uses each system\'s own opener', () => {
    expect(browserOpenCommand('http://localhost:3001', 'win32')).toBe('start "" "http://localhost:3001"');
    expect(browserOpenCommand('http://localhost:3001', 'darwin')).toBe('open "http://localhost:3001"');
    expect(browserOpenCommand('http://localhost:3001', 'linux')).toBe('xdg-open "http://localhost:3001"');
  });
});

describe('maybeOpenBrowser', () => {
  const run = () => {
    const commands: string[] = [];
    return { commands, fn: (c: string) => void commands.push(c) };
  };

  it('opens the page as soon as it is asked to, when the Studio runs the engine', () => {
    const r = run();
    expect(maybeOpenBrowser({ managed: true, port: 3002, env: {}, platform: 'linux', run: r.fn, log: () => {} })).toBe(true);
    expect(r.commands).toEqual(['xdg-open "http://localhost:3002"']);
  });

  it('does nothing when the engine is run by someone else', () => {
    const r = run();
    expect(maybeOpenBrowser({ managed: false, port: 3001, env: {}, run: r.fn, log: () => {} })).toBe(false);
    expect(r.commands).toEqual([]);
  });

  it('respects NO_AUTO_BROWSER (the Pinokio launcher opens its own tab)', () => {
    const r = run();
    expect(maybeOpenBrowser({ managed: true, port: 3001, env: { NO_AUTO_BROWSER: 'true' }, run: r.fn, log: () => {} })).toBe(false);
    expect(r.commands).toEqual([]);
  });

  it('only NO_AUTO_BROWSER=true disables it', () => {
    const r = run();
    expect(maybeOpenBrowser({ managed: true, port: 3001, env: { NO_AUTO_BROWSER: 'false' }, platform: 'darwin', run: r.fn, log: () => {} })).toBe(true);
    expect(r.commands).toEqual(['open "http://localhost:3001"']);
  });

  it('never throws, even if the opener is missing', () => {
    const logs: string[] = [];
    const broken = () => {
      throw new Error('xdg-open: not found');
    };
    expect(() => maybeOpenBrowser({ managed: true, port: 3001, env: {}, run: broken, log: (m) => logs.push(m) })).not.toThrow();
    expect(logs.join('\n')).toContain('Could not open the browser: xdg-open: not found');
  });

  it('says which address it opens', () => {
    const logs: string[] = [];
    maybeOpenBrowser({ managed: true, port: 3005, env: {}, run: () => {}, log: (m) => logs.push(m) });
    expect(logs).toEqual(['[Server] Opening browser: http://localhost:3005']);
  });
});
