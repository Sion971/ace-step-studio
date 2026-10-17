// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../context/I18nContext';
import { UseAiCoverToggle } from './UseAiCoverToggle';
import { en } from '../i18n/en';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('UseAiCoverToggle', () => {
  let container: HTMLDivElement;
  let root: Root;
  let status: { available: boolean; reason?: string };
  const onChange = vi.fn();

  const render = async (value: boolean) => {
    await act(async () => {
      root.render(<I18nProvider><UseAiCoverToggle value={value} onChange={onChange} token="tok" /></I18nProvider>);
    });
    await act(async () => { await Promise.resolve(); });
  };
  const toggle = () => container.querySelector<HTMLButtonElement>('[data-ai-cover-toggle]')!;
  const note = () => container.querySelector('[data-ai-cover-note]')!.textContent;

  beforeEach(() => {
    onChange.mockReset();
    status = { available: true };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(status), { status: 200, headers: { 'Content-Type': 'application/json' } })));
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

  it('turns the preference on and off when the server can make AI covers', async () => {
    await render(false);
    expect(toggle().disabled).toBe(false);
    expect(note()).toBe(en['aiCover.useToggleHint']);
    act(() => toggle().click());
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('shows the switch on when it is on', async () => {
    await render(true);
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
  });

  it('is off and disabled in processor mode, and says why', async () => {
    status = { available: false, reason: 'cpu-mode' };
    await render(true);
    expect(toggle().disabled).toBe(true);
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(note()).toBe(en['aiCover.unavailableCpu']);
    act(() => toggle().click());
    expect(onChange).not.toHaveBeenCalled();
  });

  it('says the model could not start when the GPU path is broken', async () => {
    status = { available: false, reason: 'unavailable' };
    await render(false);
    expect(toggle().disabled).toBe(true);
    expect(note()).toBe(en['aiCover.unavailable']);
  });

  it('stays usable when the status cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await render(false);
    expect(toggle().disabled).toBe(false);
  });
});
