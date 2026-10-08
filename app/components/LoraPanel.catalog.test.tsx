// @vitest-environment happy-dom
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider, useI18n } from '../context/I18nContext';
import { LoraPanel } from './LoraPanel';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const lofi = {
  name: 'lofi', path: './lora_output/lofi', repo: 'user/lofi', revision: 'a'.repeat(40), file: 'lofi.safetensors', sha256: 'b'.repeat(64), installedAt: '2026-10-08T00:00:00Z',
  license: null, baseModel: ['AceStep v1.5 Turbo (2B)'], triggerWord: 'roti-l0f1y', recommended: { scale: 0.8, steps: 8, guidance: 7, shift: 3 },
};
const entry = {
  id: 'lofi', repo: 'user/lofi', file: 'lofi.safetensors', revision: 'a'.repeat(40), sha256: 'b'.repeat(64), name: 'Lo-Fi', description: 'A lo-fi style.', author: 'Someone', license: null,
  baseModel: 'AceStep v1.5 Turbo (2B)', genre: 'lo-fi', tags: [], triggerWord: 'roti-l0f1y', recommended: lofi.recommended, sizeBytes: 88_130_248, verified: null, installed: lofi,
  compatibility: { verdict: 'compatible', reasons: [], vramGb: 8, active: null, required: { family: 'turbo', size: '2B', label: 'x', sources: [], conflict: false } },
};

describe('LoraPanel and the catalog', () => {
  let container: HTMLDivElement;
  let root: Root;
  let installed: unknown[];
  let loras: { name: string; path: string }[];

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('language', 'en');
    installed = [lofi];
    loras = [{ name: 'my-trained-lora', path: './lora_output/final' }, { name: 'lofi', path: './lora_output/lofi' }];
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const path = String(input).split('?')[0];
      const bodies: Record<string, unknown> = {
        '/api/lora/available': { loras },
        '/api/lora/quantization-status': { quantization_enabled: false },
        '/api/lora-hub/installed': { installed },
        '/api/lora-hub/catalog': { entries: [entry], problems: [] },
        '/api/generate/model-status': { state: 'ready', connected: true, activeModel: 'acestep-v15-turbo' },
        '/api/generate/system-info': { vram_total: 8 },
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
  const q = (id: string) => document.body.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  const click = async (el: Element | null) => { await act(async () => { (el as HTMLElement).click(); }); };
  const select = () => document.body.querySelector('select') as HTMLSelectElement;
  const range = () => document.body.querySelector('input[type="range"]') as HTMLInputElement;

  async function mount(loraLoaded = false) {
    const Page: React.FC = () => {
      const { t } = useI18n();
      const [loaded, setLoaded] = useState(loraLoaded);
      return <LoraPanel token="tok" t={t as unknown as (k: string) => string} selectedModel="acestep-v15-turbo" loraLoaded={loaded} onLoadedChange={setLoaded} />;
    };
    await act(async () => { root.render(<I18nProvider><Page /></I18nProvider>); });
    await click([...document.body.querySelectorAll('button')].find((b) => b.textContent === 'LoRA') ?? null);
    await settle(20);
  }

  it('offers the catalog from the panel, and opens it', async () => {
    await mount();
    const open = q('lora-open-catalog');
    expect(open?.textContent).toBe('Browse the catalog');
    expect(q('lora-catalog')).toBeNull();
    await click(open);
    await settle(20);
    expect(q('lora-catalog')).not.toBeNull();
    expect(q('hub-entry-lofi')?.textContent).toContain('Lo-Fi');
  });

  it('shows the trigger word and the recommended settings of the LoRA that was installed from the catalog', async () => {
    await mount();
    await act(async () => { select().value = './lora_output/lofi'; select().dispatchEvent(new Event('change', { bubbles: true })); });
    await settle(10);
    const info = q('lora-selected-info');
    expect(info?.textContent).toContain('roti-l0f1y');
    expect(info?.textContent).toContain('Put this word in your prompt for the style to apply.');
    expect(info?.textContent).toContain('Scale: 0.8 · Steps: 8 · Guidance: 7 · Shift: 3');
  });

  it('shows nothing of the kind for a LoRA that was trained here: it has no such file', async () => {
    await mount();
    await act(async () => { select().value = './lora_output/final'; select().dispatchEvent(new Event('change', { bubbles: true })); });
    await settle(10);
    expect(q('lora-selected-info')).toBeNull();
  });

  it('"Use" selects the LoRA, sets the scale the author recommends, and closes the catalog (loading stays an explicit gesture)', async () => {
    await mount();
    expect(select().value).toBe('./lora_output/final'); // the first of the list, before anything is chosen
    expect(range().value).toBe('1');
    await click(q('lora-open-catalog'));
    await settle(20);
    await click(q('hub-use-lofi'));
    await settle(20);
    expect(q('lora-catalog')).toBeNull();
    expect(select().value).toBe('./lora_output/lofi');
    expect(range().value).toBe('0.8');
    expect(q('lora-selected-info')?.textContent).toContain('roti-l0f1y');
    const load = [...document.body.querySelectorAll('button')].find((b) => b.textContent === 'Load');
    expect(load).toBeDefined(); // it is not loaded by itself
    expect(document.body.textContent).toContain('LoRA Unloaded');
  });

  it('does not touch the scale of a LoRA that is already loaded: the slider acts on THAT one', async () => {
    await mount(true);
    expect(range().value).toBe('1');
    await click(q('lora-open-catalog'));
    await settle(20);
    await click(q('hub-use-lofi'));
    await settle(20);
    expect(select().value).toBe('./lora_output/lofi'); // selected, to be loaded after unloading the current one
    expect(range().value).toBe('1'); // unchanged
  });

  it('keeps working when the hub cannot be reached: the panel is the same as before', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => (String(input).includes('lora-hub') ? Promise.reject(new TypeError('x')) : new Response(JSON.stringify(String(input).includes('available') ? { loras } : { quantization_enabled: false }), { status: 200 }))));
    await mount();
    expect(q('lora-open-catalog')).not.toBeNull();
    expect(q('lora-selected-info')).toBeNull();
    expect(select().options.length).toBe(2);
  });
});
