// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../context/I18nContext';
import { LibraryView } from './LibraryView';

// The view only reads the signed-in user from the auth context: nobody is signed in here.
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: null, token: null }) }));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('the tabs of the library', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  const render = () => act(() => root.render(
    <I18nProvider>
      <LibraryView
        allSongs={[]} likedSongs={[]} playlists={[]} workspaces={[]} referenceTracks={[]}
        onPlaySong={vi.fn()} onCreatePlaylist={vi.fn()} onCreateWorkspace={vi.fn()} onSelectPlaylist={vi.fn()} onSelectWorkspace={vi.fn()} onAddToPlaylist={vi.fn()}
      />
    </I18nProvider>,
  ));

  it('stay at the top of the scrolling area, over the list, with an opaque background', () => {
    render();
    const bar = container.querySelector<HTMLElement>('[data-library-tabs]')!;
    expect(bar).not.toBeNull();
    const classes = bar.className.split(/\s+/);
    // -top-6 / lg:-top-10 cancel the padding of the scrolling area (p-6 / lg:p-10): a sticky offset is counted from its content box.
    for (const c of ['sticky', '-top-6', 'lg:-top-10', 'z-20', 'pb-4', 'bg-white', 'dark:bg-black']) expect(classes, c).toContain(c);
    expect(bar.closest('.overflow-y-auto')).not.toBeNull();
  });

  it('keep the title of the page with them, so it does not scroll away', () => {
    render();
    const bar = container.querySelector<HTMLElement>('[data-library-tabs]')!;
    expect(bar.querySelector('h1')).not.toBeNull();
    expect(bar.querySelector('h1')!.textContent!.trim().length).toBeGreaterThan(0);
  });

  it('hold the five tabs, and come before the content', () => {
    render();
    const bar = container.querySelector<HTMLElement>('[data-library-tabs]')!;
    expect(bar.querySelectorAll('button').length).toBe(5);
    expect(bar.compareDocumentPosition(container.querySelector('.space-y-1')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
