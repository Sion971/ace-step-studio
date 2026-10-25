import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// The editor (AudioMass) is plain scripts in a page of its own; its French file is a browser IIFE, run here on the test document.
const SOURCE = readFileSync(path.join(__dirname, '../server/audio-editor/i18n-fr.js'), 'utf8');
type Api = { setLang: (l: string) => void; translate: (t: string) => string | null; lang: string };

function load(lang: string): Api {
  document.body.innerHTML = '';
  localStorage.setItem('language', lang);
  delete (window as any).PKAudioEditorI18n;
  new Function('window', 'document', SOURCE)(window, document);
  return (window as any).PKAudioEditorI18n as Api;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('the French of the editor', () => {
  beforeEach(() => { localStorage.clear(); });

  it('does nothing while the application is not in French', () => {
    const api = load('en');
    expect(api.lang).toBe('en');
    const b = document.createElement('button'); b.textContent = 'Effects'; document.body.appendChild(b);
    expect(b.textContent).toBe('Effects');
  });

  it('translates the texts already on the page, keeping the spaces and the check mark around them', () => {
    document.body.innerHTML = '<button> Effects </button><span>Follow Cursor &#10004;</span><i title="Mute"></i><input type="text" value="Mute">';
    localStorage.setItem('language', 'fr');
    delete (window as any).PKAudioEditorI18n;
    new Function('window', 'document', SOURCE)(window, document);
    expect(document.querySelector('button')!.textContent).toBe(' Effets ');
    expect(document.querySelector('span')!.textContent).toBe('Suivre le curseur ✔');
    expect(document.querySelector('i')!.getAttribute('title')).toBe('Muet');
    expect((document.querySelector('input') as HTMLInputElement).value).toBe('Mute'); // what the user types is never touched
  });

  it('translates what the editor creates later (windows, messages), and leaves unknown texts alone', async () => {
    const api = load('fr');
    expect(api.lang).toBe('fr');
    const m = document.createElement('div');
    m.innerHTML = '<div>Threshold</div><div>Some text nobody translated</div><span>Shft+Z</span>';
    document.body.appendChild(m);
    await tick();
    expect(m.children[0].textContent).toBe('Seuil');
    expect(m.children[1].textContent).toBe('Some text nobody translated');
    expect(m.children[2].textContent).toBe('Maj+Z');
  });

  it('follows the names the program composes: history entries, loop length', () => {
    const api = load('fr');
    expect(api.translate('Undo Add Clip')).toBe('Annuler ajout de clip');
    expect(api.translate('Redo Delete Clip')).toBe('Rétablir suppression de clip');
    expect(api.translate('Loop 2.988s')).toBe('Boucle 2.988 s');
    expect(api.translate('Rendering failed: boom')).toBe('Échec du rendu : boom');
    expect(api.translate('Hz')).toBeNull();
  });

  it('never translates the name of a clip, which the Studio reads back to find the song', async () => {
    load('fr');
    const clip = document.createElement('div'); clip.className = 'pk_mt_clip';
    clip.innerHTML = '<span>Loop</span>';
    document.body.appendChild(clip);
    await tick();
    expect(clip.textContent).toBe('Loop');
  });

  it('goes back to English when the application changes language, without reloading', () => {
    document.body.innerHTML = '<button>Effects</button>';
    localStorage.setItem('language', 'fr');
    delete (window as any).PKAudioEditorI18n;
    new Function('window', 'document', SOURCE)(window, document);
    expect(document.querySelector('button')!.textContent).toBe('Effets');
    localStorage.setItem('language', 'en');
    window.dispatchEvent(Object.assign(new Event('storage'), { key: 'language' }));
    expect(document.querySelector('button')!.textContent).toBe('Effects');
    localStorage.setItem('language', 'fr');
    window.dispatchEvent(Object.assign(new Event('storage'), { key: 'language' }));
    expect(document.querySelector('button')!.textContent).toBe('Effets');
  });

  it('has no duplicated key in the dictionary (the last one would silently win)', () => {
    const block = SOURCE.slice(SOURCE.indexOf('var FR = {'), SOURCE.indexOf('var ACTIONS'));
    const keys = [...block.matchAll(/^\t'((?:[^'\\]|\\.)+)':\s/gm)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(400);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('follows a French browser while no language was picked in the application', () => {
    localStorage.clear();
    const set = (v: string) => Object.defineProperty(window.navigator, 'language', { value: v, configurable: true });
    const original = window.navigator.language;
    try {
      set('fr-FR');
      delete (window as any).PKAudioEditorI18n;
      new Function('window', 'document', SOURCE)(window, document);
      expect((window as any).PKAudioEditorI18n.lang).toBe('fr');
      set('en-US');
      delete (window as any).PKAudioEditorI18n;
      new Function('window', 'document', SOURCE)(window, document);
      expect((window as any).PKAudioEditorI18n.lang).toBe('en');
      // a language picked by hand wins over the browser's
      set('fr-FR'); localStorage.setItem('language', 'en');
      delete (window as any).PKAudioEditorI18n;
      new Function('window', 'document', SOURCE)(window, document);
      expect((window as any).PKAudioEditorI18n.lang).toBe('en');
    } finally { set(original); }
  });
});
