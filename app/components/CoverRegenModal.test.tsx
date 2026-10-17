// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../context/I18nContext';
import { CoverRegenModal } from './CoverRegenModal';
import { en } from '../i18n/en';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const song: any = { id: 's1', title: 'Océane', style: 'r&b, easy to sing, joy' };

describe('CoverRegenModal (local AI cover)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let calls: Array<{ url: string; body?: any }>;
  let aiStatus: { available: boolean };
  let generate: () => Response;
  const onClose = vi.fn();
  const onCoverSaved = vi.fn();

  const flush = async () => { await act(async () => { await Promise.resolve(); }); await act(async () => { await Promise.resolve(); }); };
  const generateButton = () => container.querySelector<HTMLButtonElement>('[data-cover-generate]')!;

  beforeEach(async () => {
    calls = [];
    aiStatus = { available: true };
    generate = () => new Response(new Blob(['IMG'], { type: 'image/jpeg' }), { status: 200, headers: { 'Content-Type': 'image/jpeg', 'X-Cover-Seed': '77' } });
    onClose.mockReset();
    onCoverSaved.mockReset();
    (URL as any).createObjectURL = vi.fn(() => 'blob:preview');
    (URL as any).revokeObjectURL = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : init?.body });
      if (url === '/api/songs/cover-ai-status') return new Response(JSON.stringify(aiStatus), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url === '/api/songs/generate-cover') return generate();
      if (url === '/api/songs/s1/regen-cover') return new Response(JSON.stringify({ coverUrl: '/audio/u/covers/s1.jpg' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response('{}', { status: 404 });
    }));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<I18nProvider><CoverRegenModal song={song} token="tok" onClose={onClose} onCoverSaved={onCoverSaved} /></I18nProvider>);
    });
    await flush();
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

  it('starts from a prompt built from the song style, with no Pollinations model to pick', () => {
    const textarea = container.querySelector('textarea')!;
    expect(textarea.value.startsWith('r&b, easy to sing, joy')).toBe(true);
    expect(container.textContent).not.toMatch(/pollinations/i);
    expect(container.querySelector('[data-cover-note]')!.textContent).toBe(en['coverRegen.localHint']);
  });

  it('asks the local server for an image and previews it with its seed', async () => {
    await act(async () => { generateButton().click(); });
    await flush();
    const post = calls.find((c) => c.url === '/api/songs/generate-cover')!;
    expect(post.body.prompt).toContain('r&b, easy to sing, joy');
    expect(Number.isInteger(post.body.seed)).toBe(true);
    expect(container.querySelector('img')).not.toBeNull();
    expect(container.textContent).toContain('SDXL Turbo · seed');
  });

  it('saves the chosen image as the cover of the song', async () => {
    await act(async () => { generateButton().click(); });
    await flush();
    const save = [...container.querySelectorAll('button')].find((b) => b.textContent === en['coverRegen.saveAsCover'])!;
    await act(async () => { save.click(); });
    await flush();
    expect(calls.some((c) => c.url === '/api/songs/s1/regen-cover')).toBe(true);
    expect(onCoverSaved).toHaveBeenCalledWith('s1', '/audio/u/covers/s1.jpg');
    expect(onClose).toHaveBeenCalled();
  });

  it('blocks Generate and points to the upload when the machine cannot make AI covers', async () => {
    act(() => root.unmount());
    aiStatus = { available: false };
    root = createRoot(container);
    await act(async () => {
      root.render(<I18nProvider><CoverRegenModal song={song} token="tok" onClose={onClose} onCoverSaved={onCoverSaved} /></I18nProvider>);
    });
    await flush();
    expect(generateButton().disabled).toBe(true);
    expect(container.querySelector('[data-cover-note]')!.textContent).toBe(en['coverRegen.errUnavailable']);
  });

  it('shows a clear message when one generation fails', async () => {
    generate = () => new Response(JSON.stringify({ code: 'AI_FAILED', error: 'black image' }), { status: 502, headers: { 'Content-Type': 'application/json' } });
    await act(async () => { generateButton().click(); });
    await flush();
    expect(container.textContent).toContain(en['coverRegen.errFailed']);
  });

  it('learns from the server that AI covers are unavailable', async () => {
    generate = () => new Response(JSON.stringify({ code: 'AI_UNAVAILABLE', error: 'cpu-mode' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    await act(async () => { generateButton().click(); });
    await flush();
    expect(container.textContent).toContain(en['coverRegen.errUnavailable']);
    expect(generateButton().disabled).toBe(true);
  });
});
