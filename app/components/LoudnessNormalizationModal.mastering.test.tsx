// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../context/I18nContext';
import { LoudnessNormalizationModal } from './LoudnessNormalizationModal';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('the mastering part of the loudness window', () => {
  let container: HTMLDivElement;
  let root: Root;
  let posted: FormData | null;

  beforeEach(() => {
    posted = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    (URL as any).createObjectURL = vi.fn(() => 'blob:result');
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/loudnorm/normalize') {
        posted = init?.body as FormData;
        return new Response(new Blob(['x'], { type: 'audio/wav' }), { status: 200 });
      }
      return new Response(new Blob(['y'], { type: 'audio/mpeg' }), { status: 200 });
    }));
    act(() => root.render(<I18nProvider><LoudnessNormalizationModal audioUrl="/audio/a.mp3" songTitle="Song" onClose={() => {}} /></I18nProvider>));
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

  const preset = (id: string) => container.querySelector<HTMLButtonElement>(`[data-preset="${id}"]`)!;
  const slider = (key: string) => container.querySelector<HTMLInputElement>(`[data-mastering="${key}"]`)!;
  const setSlider = (key: string, value: number) => act(() => {
    const el = slider(key);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, String(value));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const normalize = async () => {
    const buttons = [...container.querySelectorAll('button')].filter((b) => !b.hasAttribute('data-preset'));
    const go = buttons[buttons.length - 1];
    await act(async () => { go.click(); });
    await act(async () => { await Promise.resolve(); });
  };

  it('starts with everything at 0, so a plain normalization stays as it was', async () => {
    for (const k of ['harmonics', 'warmth', 'tone', 'glue', 'width']) expect(slider(k).value).toBe('0');
    await normalize();
    expect(posted).not.toBeNull();
    for (const k of ['harmonics', 'warmth', 'tone', 'glue', 'width']) expect(posted!.get(k)).toBe('0');
  });

  it('moves the sliders with a preset, and sends them to the server', async () => {
    act(() => preset('warm').click());
    expect([slider('harmonics').value, slider('warmth').value, slider('tone').value, slider('glue').value, slider('width').value]).toEqual(['15', '55', '-30', '35', '10']);
    await normalize();
    expect(posted!.get('warmth')).toBe('55');
    expect(posted!.get('tone')).toBe('-30');
    expect(posted!.get('targetI')).toBe('-14');
    // the result shows the single before/after player, on the processed side
    expect(container.querySelector('[data-ab="after"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelectorAll('[data-ab-play]').length).toBe(1);
  });

  it('keeps the value of a slider moved by hand', async () => {
    act(() => preset('light').click());
    setSlider('glue', 80);
    expect(slider('glue').value).toBe('80');
    await normalize();
    expect(posted!.get('glue')).toBe('80');
    expect(posted!.get('harmonics')).toBe('25');
  });
});
