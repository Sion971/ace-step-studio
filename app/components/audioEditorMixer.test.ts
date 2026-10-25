import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const html = readFileSync(path.join(__dirname, '../server/audio-editor/mix.html'), 'utf8');

// The mixer lays its strips out in a row that scrolls sideways; the master is the last one, so with many channels it was pushed out
// of the window. It has to stay pinned at the right edge, with the channels scrolling underneath.
describe('the mixer window', () => {
  const master = /\.s\.master\{([^}]*)\}/.exec(html)?.[1] ?? '';
  it('keeps the master strip in view at the right edge', () => {
    expect(master).toMatch(/position:sticky/);
    expect(master).toMatch(/right:0/);
  });
  it('draws the master above the channels, with a background of its own', () => {
    expect(master).toMatch(/z-index:\s*[1-9]/);
    expect(master).toMatch(/background:/);
  });
});
