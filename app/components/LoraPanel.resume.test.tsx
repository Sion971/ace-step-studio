// @vitest-environment happy-dom
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider, useI18n } from '../context/I18nContext';
import { LoraPanel } from './LoraPanel';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('LoraPanel after a change of tab', () => {
  let container: HTMLDivElement;
  let root: Root;
  let status: Record<string, unknown>;
  let loadStatus: number;
  let loadCalls: number;

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('language', 'en');
    loadCalls = 0;
    loadStatus = 200;
    status = { loaded: true, active: true, scale: 0.7, path: './lora_output/rap', small_gpu: true };
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const path = String(input).split('?')[0];
      if (path === '/api/lora/load') {
        loadCalls += 1;
        return loadStatus === 200
          ? new Response(JSON.stringify({ message: 'ok', loaded: true }), { status: 200 })
          : new Response(JSON.stringify({ error: 'Adapter name already in use: rap. Use a different name or remove it first.' }), { status: loadStatus });
      }
      const bodies: Record<string, unknown> = {
        '/api/lora/available': { loras: [{ name: 'rap', path: './lora_output/rap' }, { name: 'other', path: './lora_output/other' }] },
        '/api/lora/quantization-status': { quantization_enabled: false },
        '/api/lora/status': status,
        '/api/lora-hub/installed': { installed: [] },
      };
      return path in bodies ? new Response(JSON.stringify(bodies[path]), { status: 200 }) : new Response('{}', { status: 404 });
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

  const settle = async (ms = 0) => {
    for (let waited = 0; waited <= ms; waited += 4) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 4)); });
  };
  const button = (label: string) => [...document.body.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement | undefined;

  // The Create page is mounted fresh, as after a visit to another tab: its own state says "not loaded".
  async function mountFresh() {
    const Page: React.FC = () => {
      const { t } = useI18n();
      const [loaded, setLoaded] = useState(false);
      return <LoraPanel token="tok" t={t as unknown as (k: string) => string} selectedModel="acestep-v15-xl-turbo-bf16" loraLoaded={loaded} onLoadedChange={setLoaded} />;
    };
    await act(async () => { root.render(<I18nProvider><Page /></I18nProvider>); });
    await act(async () => { button('LoRA')?.click(); });
    await settle(20);
  }

  it('shows the LoRA the engine still holds as loaded, with its path and scale', async () => {
    await mountFresh();
    expect(button('Unload')).toBeDefined();
    expect(button('Load')).toBeUndefined();
    expect((document.body.querySelector('select') as HTMLSelectElement).value).toBe('./lora_output/rap');
    expect((document.body.querySelector('input[type="range"]') as HTMLInputElement).value).toBe('0.7');
  });

  it('keeps showing "not loaded" when the engine holds nothing', async () => {
    status = { loaded: false, active: false, scale: 1, path: '', small_gpu: true };
    await mountFresh();
    expect(button('Load')).toBeDefined();
    expect(button('Unload')).toBeUndefined();
  });

  it('takes "Adapter name already in use" for what it says: the LoRA is loaded, no error is shown', async () => {
    status = { loaded: false, active: false, scale: 1, path: '', small_gpu: true }; // the interface was not told
    await mountFresh();
    loadStatus = 422;
    await act(async () => { button('Load')?.click(); });
    await settle(20);
    expect(loadCalls).toBe(1);
    expect(document.body.textContent).not.toContain('already in use');
    expect(button('Unload')).toBeDefined();
  });
});
