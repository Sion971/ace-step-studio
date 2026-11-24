// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../context/I18nContext';
import type { Song } from '../types';
import { en } from '../i18n/en';

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ isAuthenticated: true, token: 'tok', user: { id: 'u1', username: 'me' } }),
}));

import { CreatePanel } from './CreatePanel';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const SONG = {
  id: 's1', userId: 'u1', title: 'Pas sur la route', audioUrl: '/audio/s1.mp3', style: 'piano',
  lyrics: '[Verse 1]\nPas sur la route\nDans le vent du soir', bpm: 84, keyScale: 'D minor', timeSignature: '4',
  generationParams: { vocalLanguage: 'fr' }, coverUrl: '', duration: '2:59', createdAt: new Date(), tags: [],
} as unknown as Song;

// Loading a source in Cover mode WITHOUT the details (the library window and a dropped song go this way): the panel
// must find the song by its audio and take its lyrics. Before the fix only the song's Cover action carried them.
describe('Cover source loaded from the library or by drag', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('fills the lyrics from the song found by its audio', async () => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <CreatePanel onGenerate={() => {}} isGenerating={false} createdSongs={[SONG]}
            pendingAudioSelection={{ target: 'source', url: '/audio/s1.mp3', title: 'Pas sur la route', mode: 'cover' }} />
        </I18nProvider>,
      );
    });
    await act(async () => { await Promise.resolve(); });
    const areas = Array.from(container.querySelectorAll('textarea')).map(a => a.value);
    expect(areas.some(v => v.includes('Dans le vent du soir'))).toBe(true);
    expect(container.querySelector('[data-testid="source-duration"]')).not.toBeNull();
    expect(Array.from(container.querySelectorAll('input')).some(i => i.value === 'Pas sur la route')).toBe(true);
  });

  it('gives the fields back when the source is removed', async () => {
    localStorage.setItem('ace-lyrics', 'mes paroles a moi');
    await act(async () => {
      root.render(
        <I18nProvider>
          <CreatePanel onGenerate={() => {}} isGenerating={false} createdSongs={[SONG]}
            pendingAudioSelection={{ target: 'source', url: '/audio/s1.mp3', title: 'Pas sur la route', mode: 'cover' }} />
        </I18nProvider>,
      );
    });
    const values = () => Array.from(container.querySelectorAll('textarea')).map(a => a.value);
    expect(values().some(v => v.includes('Dans le vent du soir'))).toBe(true);
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-clear-audio]')!.click(); });
    expect(values().some(v => v.includes('Dans le vent du soir'))).toBe(false);
    expect(values()).toContain('mes paroles a moi');
  });

  it('fills the lyrics from an analysed import found by its audio', async () => {
    const imported = { ...SONG, id: 'upload_t1', audioUrl: '/audio/ref/t1.mp3', lyrics: '[Chorus]\nI will sing of the wonders' } as Song;
    await act(async () => {
      root.render(
        <I18nProvider>
          <CreatePanel onGenerate={() => {}} isGenerating={false} createdSongs={[SONG]} importedSongs={[imported]}
            pendingAudioSelection={{ target: 'source', url: '/audio/ref/t1.mp3', title: 'Je chanterai', mode: 'cover' }} />
        </I18nProvider>,
      );
    });
    const areas = Array.from(container.querySelectorAll('textarea')).map(a => a.value);
    expect(areas.some(v => v.includes('I will sing of the wonders'))).toBe(true);
  });

  it('loads a song picked in the library window, with its lyrics', async () => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <CreatePanel onGenerate={() => {}} isGenerating={false} createdSongs={[SONG]} />
        </I18nProvider>,
      );
    });
    const buttons = () => Array.from(container.querySelectorAll('button'));
    // Cover mode, then "Add", "From the library", tab "Created", "Use".
    await act(async () => { buttons().find(b => b.title.startsWith(en.audioModeInspiration))!.click(); });
    await act(async () => { buttons().find(b => b.textContent?.startsWith(en.audioModeCover))!.click(); });
    await act(async () => { buttons().find(b => b.textContent?.trim() === en.addAudio)!.click(); });
    await act(async () => { buttons().find(b => b.textContent?.trim() === en.fromLibrary)!.click(); });
    await act(async () => { buttons().find(b => b.textContent?.trim() === en.createdTab)!.click(); });
    expect(container.querySelector('.fixed.inset-0.z-\\[120\\]')).not.toBeNull();
    await act(async () => { buttons().find(b => b.textContent?.trim() === en.useTrack)!.click(); });
    const areas = Array.from(container.querySelectorAll('textarea')).map(a => a.value);
    expect(areas.some(v => v.includes('Dans le vent du soir'))).toBe(true);
    expect(container.querySelector('.fixed.inset-0.z-\\[120\\]')).toBeNull();
  });

  it('fills the lyrics when an audio loaded in Inspiration is switched to Cover', async () => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <CreatePanel onGenerate={() => {}} isGenerating={false} createdSongs={[SONG]}
            pendingAudioSelection={{ target: 'reference', url: '/audio/s1.mp3', title: 'Pas sur la route', mode: 'inspiration' }} />
        </I18nProvider>,
      );
    });
    const lyricsShown = () => Array.from(container.querySelectorAll('textarea')).some(a => a.value.includes('Dans le vent du soir'));
    expect(lyricsShown()).toBe(false);
    const modeButton = Array.from(container.querySelectorAll('button')).find(b => b.title.startsWith(en.audioModeInspiration))!;
    await act(async () => { modeButton.click(); });
    const coverItem = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.startsWith(en.audioModeCover))!;
    await act(async () => { coverItem.click(); });
    expect(lyricsShown()).toBe(true);
  });

  it('Reverse: the source becomes the reversed copy made by the server, with the original song\'s lyrics', async () => {
    localStorage.setItem('ace-title', 'Mon titre');
    const onImportCreated = vi.fn();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/reference-tracks/reverse') {
        expect(JSON.parse(String(init?.body))).toEqual({ audioUrl: '/audio/s1.mp3', filename: 'Pas sur la route (reversed)' });
        return new Response(JSON.stringify({ track: { id: 'r1', filename: 'Pas sur la route (reversed).flac', audio_url: '/audio/ref/r1.flac' } }), { status: 201, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => {
      root.render(
        <I18nProvider>
          <CreatePanel onGenerate={() => {}} isGenerating={false} createdSongs={[SONG]} onImportCreated={onImportCreated}
            pendingAudioSelection={{ target: 'source', url: '/audio/s1.mp3', title: 'Pas sur la route', mode: 'reverse' }} />
        </I18nProvider>,
      );
    });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(fetchMock).toHaveBeenCalledWith('/api/reference-tracks/reverse', expect.anything());
    const sources = Array.from(container.querySelectorAll('audio')).map(a => a.getAttribute('src'));
    expect(sources).toContain('/audio/ref/r1.flac');
    expect(sources).not.toContain('/audio/s1.mp3');
    expect(container.textContent).toContain('Pas sur la route (reversed)');
    const areas = Array.from(container.querySelectorAll('textarea')).map(a => a.value);
    expect(areas.some(v => v.includes('Dans le vent du soir'))).toBe(true);
    expect(container.querySelector('[data-reversing]')).toBeNull();
    // The copy is handed to the app, which files it in the workspace open.
    expect(onImportCreated).toHaveBeenCalledWith('r1');
    // The song to make is named after the reversed copy; removing the source gives the title back.
    const titleInput = () => Array.from(container.querySelectorAll('input')).find(i => i.value.includes('(reversed)') || i.value === 'Mon titre');
    expect(titleInput()?.value).toBe('Pas sur la route (reversed)');
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-clear-audio]')!.click(); });
    expect(titleInput()?.value).toBe('Mon titre');
  });

  it('Reverse: an error of the server is shown and nothing is loaded', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url === '/api/reference-tracks/reverse'
      ? new Response(JSON.stringify({ error: 'Failed to reverse the audio', details: 'ffmpeg failed' }), { status: 500, headers: { 'Content-Type': 'application/json' } })
      : new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })));
    await act(async () => {
      root.render(
        <I18nProvider>
          <CreatePanel onGenerate={() => {}} isGenerating={false} createdSongs={[SONG]}
            pendingAudioSelection={{ target: 'source', url: '/audio/s1.mp3', title: 'Pas sur la route', mode: 'reverse' }} />
        </I18nProvider>,
      );
    });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(container.textContent).toContain(en.reverseFailed);
    expect(container.textContent).toContain('ffmpeg failed');
    expect(Array.from(container.querySelectorAll('audio')).map(a => a.getAttribute('src'))).not.toContain('/audio/s1.mp3');
  });

  it('Reverse: switching to it with an audio loaded reverses that audio', async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => url === '/api/reference-tracks/reverse'
      ? new Response(JSON.stringify({ track: { id: 'r1', filename: 'x.flac', audio_url: '/audio/ref/r1.flac' } }), { status: 201, headers: { 'Content-Type': 'application/json' } })
      : new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => {
      root.render(
        <I18nProvider>
          <CreatePanel onGenerate={() => {}} isGenerating={false} createdSongs={[SONG]}
            pendingAudioSelection={{ target: 'reference', url: '/audio/s1.mp3', title: 'Pas sur la route', mode: 'inspiration' }} />
        </I18nProvider>,
      );
    });
    const buttons = () => Array.from(container.querySelectorAll('button'));
    await act(async () => { buttons().find(b => b.title.startsWith(en.audioModeInspiration))!.click(); });
    await act(async () => { buttons().find(b => b.textContent?.startsWith(en.audioModeReverse))!.click(); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    const call = fetchMock.mock.calls.find(c => c[0] === '/api/reference-tracks/reverse')!;
    expect(JSON.parse(String((call[1] as RequestInit).body)).audioUrl).toBe('/audio/s1.mp3');
    expect(Array.from(container.querySelectorAll('audio')).map(a => a.getAttribute('src'))).toContain('/audio/ref/r1.flac');
  });

  it('an audio uploaded in the panel is handed to the app, to go into the workspace open', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url === '/api/reference-tracks'
      ? new Response(JSON.stringify({ track: { id: 'u9', filename: 'mon.wav', audio_url: '/audio/ref/u9.wav' } }), { status: 201, headers: { 'Content-Type': 'application/json' } })
      : new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })));
    const onImportCreated = vi.fn();
    await act(async () => {
      root.render(
        <I18nProvider>
          <CreatePanel onGenerate={() => {}} isGenerating={false} createdSongs={[SONG]} onImportCreated={onImportCreated} />
        </I18nProvider>,
      );
    });
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, 'files', { value: [new File(['x'], 'mon.wav', { type: 'audio/wav' })] });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(onImportCreated).toHaveBeenCalledWith('u9');
  });

  it('Speed: the copy at ×1.25 keeps the lyrics and key, gets the tempo times 1.25; another factor starts from the original', async () => {
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/reference-tracks/speed') {
        const body = JSON.parse(String(init?.body));
        bodies.push(body);
        const n = bodies.length;
        return new Response(JSON.stringify({ track: { id: `v${n}`, filename: `${body.filename}.flac`, audio_url: `/audio/ref/v${n}.flac` } }), { status: 201, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    await act(async () => {
      root.render(
        <I18nProvider>
          <CreatePanel onGenerate={() => {}} isGenerating={false} createdSongs={[SONG]}
            pendingAudioSelection={{ target: 'source', url: '/audio/s1.mp3', title: 'Pas sur la route', mode: 'speed' }} />
        </I18nProvider>,
      );
    });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(bodies[0]).toEqual({ audioUrl: '/audio/s1.mp3', filename: 'Pas sur la route (×1.25)', factor: 1.25, keepPitch: true });
    const inputs = () => Array.from(container.querySelectorAll('input')).map(i => i.value);
    const selects = () => Array.from(container.querySelectorAll('select')).map(s => s.value);
    expect(inputs()).toContain('Pas sur la route (×1.25)');
    expect(container.textContent).toContain('105'); // 84 BPM × 1.25
    expect(selects()).toContain('D minor');
    expect(Array.from(container.querySelectorAll('textarea')).some(a => a.value.includes('Dans le vent du soir'))).toBe(true);
    expect(Array.from(container.querySelectorAll('audio')).map(a => a.getAttribute('src'))).toContain('/audio/ref/v1.flac');

    const factorButton = (label: string) => Array.from(container.querySelectorAll('[data-speed-options] button')).find(b => b.textContent === label) as HTMLButtonElement;
    await act(async () => { factorButton('×0.9').click(); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(bodies[1]).toEqual({ audioUrl: '/audio/s1.mp3', filename: 'Pas sur la route (×0.9)', factor: 0.9, keepPitch: true });
    expect(inputs()).toContain('Pas sur la route (×0.9)');

    // Pitch following the speed: the key is no longer the original's, it goes back to Auto.
    const keep = container.querySelector<HTMLInputElement>('[data-speed-options] input[type="checkbox"]')!;
    await act(async () => { keep.click(); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(bodies[2]).toMatchObject({ audioUrl: '/audio/s1.mp3', factor: 0.9, keepPitch: false });
    expect(selects()).not.toContain('D minor');
  });
});
