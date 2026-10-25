// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const editor = vi.hoisted(() => ({ playing: false, pause: vi.fn(), fire: vi.fn(), unsaved: false }));
vi.mock('./studioBridge', async (orig) => ({
  ...(await orig<typeof import('./studioBridge')>()),
  getEditorApi: vi.fn(() => ({ multitrack: {}, fireEvent: editor.fire })),
  pauseEditor: vi.fn(() => { if (editor.playing) editor.pause(); }),
  hasUnsavedWork: vi.fn(() => editor.unsaved),
  editorSignature: vi.fn(() => 'sig'),
  waitForEditor: vi.fn(async () => null),
  listEditorClipNames: vi.fn(() => []),
  listEditorClips: vi.fn(() => []),
}));
import { editorSignature, hasUnsavedWork, pauseEditor } from './studioBridge';
import { StudioPage } from './StudioPage';
import { I18nProvider } from '../context/I18nContext';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(window as any).happyDOM?.settings && ((window as any).happyDOM.settings.disableIframePageLoading = true);

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove(); root = null; host = null;
  editor.playing = false; editor.unsaved = false; editor.pause.mockClear(); editor.fire.mockClear();
  vi.useRealTimers(); vi.unstubAllGlobals();
});

async function mount(active: boolean) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ models: [] }) })));
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  const render = (a: boolean) => act(async () => { root!.render(<I18nProvider><StudioPage songs={[]} active={a} /></I18nProvider>); });
  await render(active);
  return render;
}

describe('the Studio stays alive behind the other pages', () => {
  it('stops the sound when another page is shown, and only then', async () => {
    editor.playing = true;
    const render = await mount(true);
    expect(pauseEditor).not.toHaveBeenCalled();
    await render(false);
    expect(editor.pause).toHaveBeenCalledTimes(1);
    await render(false);
    expect(editor.pause).toHaveBeenCalledTimes(1);
  });

  it('has the editor measure itself again when the Studio comes back', async () => {
    vi.useFakeTimers();
    const render = await mount(true);
    await render(false);
    expect(editor.fire).not.toHaveBeenCalled();
    await render(true);
    await act(async () => { vi.advanceTimersByTime(100); });
    expect(editor.fire).toHaveBeenCalledWith('RequestResize');
  });

  it('asks before the page is closed or reloaded with work that was not saved as a project', async () => {
    await mount(true);
    editor.unsaved = true;
    const risky = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(risky);
    expect(risky.defaultPrevented).toBe(true);
    editor.unsaved = false;
    const calm = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(calm);
    expect(calm.defaultPrevented).toBe(false);
    expect(hasUnsavedWork).toHaveBeenCalled();
  });

  it('stops asking once the page is gone from the application', async () => {
    await mount(true);
    act(() => root!.unmount());
    root = null;
    editor.unsaved = true;
    const ev = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(editorSignature).toBeDefined();
  });
});

describe('the application', () => {
  const app = readFileSync(path.join(__dirname, '../App.tsx'), 'utf8');
  it('draws the Studio apart from the page switch, kept once opened, and shows it only on its own page', () => {
    expect(app).not.toMatch(/case 'studio':\s*return \(\s*<StudioPage/);
    expect(app).toMatch(/studioOpened \|\| currentView === 'studio'/);
    expect(app).toMatch(/currentView === 'studio' \? 'contents' : 'hidden'/);
    expect(app).toMatch(/active=\{currentView === 'studio'\}/);
  });
});
