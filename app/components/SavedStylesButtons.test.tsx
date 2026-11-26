// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../context/I18nContext';
import { en } from '../i18n/en';
import { SavedStylesButtons, timeAgo } from './SavedStylesButtons';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const ROWS = [
  { id: 'a', name: 'Nuit synthé', style: 'synthétiseur éthéré, pads', created_at: '2026-11-26 10:00:00', updated_at: '2026-11-26 10:00:00' },
  { id: 'b', name: 'Gwoka', style: 'gwoka, tambours ka, chant responsorial', created_at: '2026-11-20 10:00:00', updated_at: '2026-11-20 10:00:00' },
];

describe('SavedStylesButtons', () => {
  let container: HTMLDivElement;
  let root: Root;
  let calls: { url: string; method: string; body?: any }[];
  const onPick = vi.fn();

  beforeEach(() => {
    calls = [];
    onPick.mockReset();
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith('/api/saved-styles') && method === 'GET') return json({ styles: ROWS });
      if (url.endsWith('/api/saved-styles') && method === 'POST') return json({ style: { ...ROWS[0], id: 'n' }, existed: false }, 201);
      if (method === 'DELETE') return json({ success: true });
      if (method === 'PATCH') return json({ style: { ...ROWS[1], name: JSON.parse(String(init!.body)).name } });
      return json({});
    }));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const render = async (style: string, token: string | null = 'tok') => {
    await act(async () => {
      root.render(<I18nProvider><SavedStylesButtons style={style} token={token} onPick={onPick} /></I18nProvider>);
    });
  };
  const win = () => document.body.querySelector('[data-saved-styles-window]');

  it('saves the style written in the box, and says so', async () => {
    await render('synthétiseur éthéré, pads');
    const save = container.querySelector<HTMLButtonElement>('[data-saved-styles-save]')!;
    await act(async () => { save.click(); });
    expect(calls).toContainEqual(expect.objectContaining({ method: 'POST', body: { style: 'synthétiseur éthéré, pads' } }));
    expect(save.title).toBe(en.styleSaved);
  });

  it('cannot save an empty style, nor anything when signed out', async () => {
    await render('   ');
    expect(container.querySelector<HTMLButtonElement>('[data-saved-styles-save]')!.disabled).toBe(true);
    await render('jazz', null);
    expect(container.querySelector<HTMLButtonElement>('[data-saved-styles-save]')!.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[data-saved-styles-open]')!.disabled).toBe(true);
  });

  it('lists the saved styles, searches them, puts one in the box, renames and deletes', async () => {
    await render('');
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-saved-styles-open]')!.click(); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(win()!.querySelectorAll('[data-saved-style]')).toHaveLength(2);

    const search = win()!.querySelector('input')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setValue.call(search, 'tambours'); search.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(win()!.querySelectorAll('[data-saved-style]')).toHaveLength(1);
    await act(async () => { setValue.call(search, 'zzz'); search.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(win()!.textContent).toContain(en.noStyleMatch);
    await act(async () => { setValue.call(search, ''); search.dispatchEvent(new Event('input', { bubbles: true })); });

    await act(async () => { (win()!.querySelector(`[title="${en.renameStyle}"]`) as HTMLButtonElement).click(); });
    const nameInput = win()!.querySelectorAll('input')[1] as HTMLInputElement;
    await act(async () => { setValue.call(nameInput, 'Ma nuit'); nameInput.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { nameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(calls).toContainEqual(expect.objectContaining({ url: '/api/saved-styles/a', method: 'PATCH', body: { name: 'Ma nuit' } }));

    await act(async () => { (win()!.querySelectorAll('[data-saved-style-delete]')[1] as HTMLButtonElement).click(); });
    expect(calls).toContainEqual(expect.objectContaining({ url: '/api/saved-styles/b', method: 'DELETE' }));
    expect(win()!.querySelectorAll('[data-saved-style]')).toHaveLength(1);

    await act(async () => { (win()!.querySelector(`[title="${en.useStyle}"]`) as HTMLButtonElement).click(); });
    expect(onPick).toHaveBeenCalledWith(expect.stringContaining('synthétiseur'));
    expect(win()).toBeNull();
  });

  it('says when nothing is saved yet', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ styles: [] })));
    await render('');
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-saved-styles-open]')!.click(); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(win()!.textContent).toContain(en.noSavedStyles);
  });
});

describe('timeAgo', () => {
  it('writes the time since, in the language given', () => {
    const now = Date.parse('2026-11-26T12:00:00Z');
    expect(timeAgo('2026-11-24 12:00:00', 'en', now)).toBe('2 days ago');
    expect(timeAgo('2026-11-26 11:59:58.500', 'fr', now)).toBe('maintenant');
    expect(timeAgo('n/a', 'en', now)).toBe('');
  });
});
