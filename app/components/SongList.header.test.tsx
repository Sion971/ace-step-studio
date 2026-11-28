// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../context/I18nContext';
import { SongList } from './SongList';

// The list only reads the signed-in user from the auth context: nobody is signed in here.
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: null, token: null }) }));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('the header of the song list', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  const render = (extra: Record<string, unknown> = {}) => act(() => root.render(
    <I18nProvider>
      <SongList
        songs={[]} currentSong={null} selectedSong={null} likedSongIds={new Set()} isPlaying={false}
        onPlay={vi.fn()} onSelect={vi.fn()} onToggleLike={vi.fn()} onAddToPlaylist={vi.fn()} onDelete={vi.fn()}
        {...(extra as any)}
      />
    </I18nProvider>,
  ));

  it('stays at the top of the scrolling area, over the songs, with an opaque background', () => {
    render({ activeWorkspaceName: 'Concerts', onBackToWorkspaces: vi.fn() });
    const header = container.querySelector<HTMLElement>('[data-song-list-header]')!;
    expect(header).not.toBeNull();
    const classes = header.className.split(/\s+/);
    for (const c of ['sticky', '-top-6', 'z-20', 'bg-white', 'dark:bg-black']) expect(classes, c).toContain(c);
  });

  it('ends with a soft fade instead of a line, over the width of the songs', () => {
    render();
    const header = container.querySelector<HTMLElement>('[data-song-list-header]')!;
    const fade = header.querySelector<HTMLElement>('[data-song-list-fade]')!;
    expect(fade).not.toBeNull();
    const classes = fade.className.split(/\s+/);
    for (const c of ['absolute', 'top-full', 'left-6', 'right-6', 'pointer-events-none', 'from-white', 'dark:from-black']) expect(classes, c).toContain(c);
    expect(fade.getAttribute('aria-hidden')).toBe('true');
  });

  it('ends the list with the same soft fade at the bottom edge', () => {
    render();
    const fade = container.querySelector<HTMLElement>('[data-song-list-bottom-fade]')!;
    expect(fade).not.toBeNull();
    const classes = fade.className.split(/\s+/);
    for (const c of ['sticky', '-bottom-32', 'pointer-events-none', 'from-white', 'dark:from-black']) expect(classes, c).toContain(c);
    expect(fade.closest('.max-w-5xl')).not.toBeNull();
  });

  it('holds the workspace breadcrumb and the search box, so both stay in view', () => {
    render({ activeWorkspaceName: 'Concerts', onBackToWorkspaces: vi.fn() });
    const header = container.querySelector<HTMLElement>('[data-song-list-header]')!;
    expect(header.textContent).toContain('Concerts');
    expect(header.querySelector('input[type="text"]')).not.toBeNull();
  });

  it('is inside the element that scrolls, and the songs come after it', () => {
    render();
    const header = container.querySelector<HTMLElement>('[data-song-list-header]')!;
    expect(header.closest('.overflow-y-auto')).not.toBeNull();
    const list = container.querySelector('.space-y-2')!;
    expect(header.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
