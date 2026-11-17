// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../context/I18nContext';
import { SongList } from './SongList';

vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: null, token: null }) }));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('an imported audio in the song list', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  it('opens the Video Studio with the import, its cover and its timed lyrics (the button did nothing)', () => {
    const onOpenVideo = vi.fn();
    const track = {
      id: 't1', filename: 'Jesus Tu es mon Roc.mp3', audio_url: '/audio/reference-tracks/u/1.mp3', cover_url: '/audio/reference-tracks/u/1.cover.jpg',
      duration: 246, created_at: '2026-11-16T10:00:00Z', analysis: { available: true, lrc: '[00:01.00]Ligne' } as any,
    };
    act(() => root.render(
      <I18nProvider>
        <SongList
          songs={[]} currentSong={null} selectedSong={null} likedSongIds={new Set()} isPlaying={false}
          onPlay={vi.fn()} onSelect={vi.fn()} onToggleLike={vi.fn()} onAddToPlaylist={vi.fn()} onDelete={vi.fn()}
          referenceTracks={[track]} onOpenVideo={onOpenVideo}
        />
      </I18nProvider>,
    ));
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('button')].filter((b) => /vid/i.test(b.title));
    expect(buttons.length).toBeGreaterThan(0);
    act(() => buttons[0].click());
    expect(onOpenVideo).toHaveBeenCalledTimes(1);
    const song = onOpenVideo.mock.calls[0][0];
    expect(song.id).toBe('upload_t1');
    expect(song.audioUrl).toBe('/audio/reference-tracks/u/1.mp3');
    expect(song.coverUrl).toBe('/audio/reference-tracks/u/1.cover.jpg');
    expect(song.lrcContent).toBe('[00:01.00]Ligne');
  });
});
