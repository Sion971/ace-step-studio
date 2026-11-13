// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../context/I18nContext';

// The still is drawn on a canvas, which this test browser does not have.
vi.mock('../services/simpleVideo', async (orig) => ({
  ...(await orig<typeof import('../services/simpleVideo')>()),
  composeCoverStill: vi.fn(async () => 'data:image/jpeg;base64,AA=='),
}));
import { VideoGeneratorModal } from './VideoGeneratorModal';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('Video Studio title', () => {
  let container: HTMLDivElement;
  let root: Root;
  const song: any = { id: 's1', title: 'Jésus, Tu es mon Roc', creator: 'Sion_971', coverUrl: '', audioUrl: '/audio/a.mp3' };
  const render = async (s: any, isOpen = true) => {
    await act(async () => { root.render(<I18nProvider><VideoGeneratorModal isOpen={isOpen} song={s} onClose={() => {}} /></I18nProvider>); });
  };
  const titleInput = () => container.querySelectorAll<HTMLInputElement>('input:not([type])')[0];

  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  it('follows a renamed song without a page reload', async () => {
    await render(song);
    expect(titleInput().value).toBe('Jésus, Tu es mon Roc');
    await render({ ...song, title: 'Jésus, Tu es mon Roc (Psaumes 31)' });
    expect(titleInput().value).toBe('Jésus, Tu es mon Roc (Psaumes 31)');
  });

  it('takes the song title again when the window is reopened', async () => {
    await render(song);
    await render({ ...song, title: 'Nouveau titre' }, false);
    await render({ ...song, title: 'Nouveau titre' }, true);
    expect(titleInput().value).toBe('Nouveau titre');
    // A rename that comes back without the artist keeps the artist shown.
    expect(container.querySelectorAll<HTMLInputElement>('input:not([type])')[1].value).toBe('Sion_971');
  });
});
