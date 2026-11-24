// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../context/I18nContext';
import { en } from '../i18n/en';
import type { Song } from '../types';
import { AudioLibraryModal, type ReferenceTrack } from './AudioLibraryModal';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const TRACK: ReferenceTrack = {
  id: 't1', filename: 'Je chanterai.mp3', storage_key: 'k', duration: 160, file_size_bytes: 1, tags: null,
  created_at: '2026-11-23', audio_url: '/audio/ref/t1.mp3',
};
const mine = { id: 's1', userId: 'u1', title: 'Pas sur la route', audioUrl: '/audio/s1.mp3', duration: '2:59' } as Song;
const notMine = { id: 's2', userId: 'u2', title: 'Autre', audioUrl: '/audio/s2.mp3', duration: '1:00' } as Song;
const making = { id: 's3', userId: 'u1', title: 'En cours', audioUrl: '/audio/s3.mp3', isGenerating: true } as Song;

describe('AudioLibraryModal', () => {
  let container: HTMLDivElement;
  let root: Root;
  const handlers = { onUpload: vi.fn(), onCancelTranscription: vi.fn(), onDelete: vi.fn(), onUse: vi.fn(), onDurationKnown: vi.fn(), onClose: vi.fn() };

  const render = async (initialTab: 'uploads' | 'created' = 'uploads') => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <AudioLibraryModal target="source" initialTab={initialTab} tracks={[TRACK]} isLoading={false}
            createdSongs={[mine, notMine, making]} userId="u1" isUploading={false} isTranscribing={false} uploadError={null}
            {...handlers} />
        </I18nProvider>,
      );
    });
  };
  const button = (text: string) => Array.from(container.querySelectorAll('button')).find(b => b.textContent?.trim() === text)!;

  beforeEach(() => {
    Object.values(handlers).forEach(h => h.mockReset());
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('lists the imports and uses or deletes one', async () => {
    await render();
    expect(container.textContent).toContain(en.coverModalTitle);
    expect(container.textContent).toContain('Je chanterai');
    expect(container.textContent).toContain('2:40');
    await act(async () => { button(en.useTrack).click(); });
    expect(handlers.onUse).toHaveBeenCalledWith({ audio_url: '/audio/ref/t1.mp3', title: 'Je chanterai.mp3' });
    const del = container.querySelector('svg.lucide-trash2, svg.lucide-trash-2')!.closest('button')!;
    await act(async () => { del.click(); });
    expect(handlers.onDelete).toHaveBeenCalledWith('t1');
  });

  it('shows the user\'s finished songs in the Created tab', async () => {
    await render('uploads');
    await act(async () => { button(en.createdTab).click(); });
    expect(container.textContent).toContain('Pas sur la route');
    expect(container.textContent).not.toContain('Autre');
    expect(container.textContent).not.toContain('En cours');
    await act(async () => { button(en.useTrack).click(); });
    expect(handlers.onUse).toHaveBeenCalledWith({ audio_url: '/audio/s1.mp3', title: 'Pas sur la route' });
  });

  it('closes from the backdrop', async () => {
    await render();
    await act(async () => { (container.querySelector('.backdrop-blur-sm') as HTMLElement).click(); });
    expect(handlers.onClose).toHaveBeenCalled();
  });
});
