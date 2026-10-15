// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatasetTab } from './DatasetTab';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// A browser empties the live FileList of an <input type="file"> as soon as its value is reset. The tab used to read the list
// after the reset, from inside a state updater, so picked files sometimes never showed up.
describe('dataset tab file picker', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('keeps every file picked, even two picks in a row', async () => {
    await act(async () => {
      root.render(<DatasetTab token={null} t={(k: string) => k} markStep={() => {}} />);
    });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    let live: File[] = [];
    Object.defineProperty(input, 'files', { get: () => live, configurable: true });
    Object.defineProperty(input, 'value', { get: () => '', set: () => { live = []; }, configurable: true });
    const pick = (name: string) => {
      live = [new File(['x'], name, { type: 'audio/wav' })];
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    await act(async () => {
      pick('first.wav');
      pick('second.wav');
    });
    expect(container.textContent).toContain('first.wav');
    expect(container.textContent).toContain('second.wav');
  });
});
