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
});
