import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const dir = path.join(__dirname, '../server/audio-editor');
const read = (f: string) => readFileSync(path.join(dir, f), 'utf8');

// The editor is served under /editor/. A window opened from "/sp.html" reaches the server's catch-all, which answers with the
// whole application (the small analyser windows then showed the Studio itself).
describe('the pages the editor opens', () => {
  it('are reached under /editor/, never from the site root', () => {
    expect(read('ui-fx.js')).not.toMatch(/'\/'\s*\+\s*url\s*\+\s*'\.html/);
    expect(read('ui-fx.js')).toMatch(/'\/editor\/'\s*\+\s*url\s*\+\s*'\.html/);
    const ui = read('ui.js');
    expect(ui).not.toMatch(/window\.open \('\/(about|index-cache)\.html'\)/);
    expect(ui).toMatch(/window\.open \('\/editor\/about\.html'\)/);
  });

  it('exist, and the three analysis windows load the French dictionary', () => {
    for (const page of ['eq.html', 'sp.html', 'mix.html', 'about.html', 'index-cache.html']) expect(read(page).length, page).toBeGreaterThan(100);
    for (const page of ['eq.html', 'sp.html', 'mix.html']) expect(read(page), page).toContain('i18n-fr.js');
  });
});
