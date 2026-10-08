// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../context/I18nContext';
import { ModelMenu, type FetchedModel } from './ModelMenu';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const XL = ['acestep-v15-xl-turbo', 'acestep-v15-xl-sft', 'acestep-v15-xl-turbo-bf16', 'acestep-v15-xl-merge-sft-turbo'];
const TWO_B = ['acestep-v15-turbo', 'acestep-v15-sft', 'acestep-v15-base'];

/** What the server answers: every offered model, with what is on the disk. */
const served = (onDisk: string[] = [], active: string | null = null, extra: FetchedModel[] = []): FetchedModel[] => [
  ...[...XL, ...TWO_B].map((name) => ({ name, is_active: name === active, is_preloaded: onDisk.includes(name) || name === active })),
  ...extra,
];

describe('the model menu and the memory of the card', () => {
  let container: HTMLDivElement;
  let root: Root;
  let calls: { url: string; init?: RequestInit }[];
  let systemInfo: () => Promise<Response>;
  const setSelectedModel = vi.fn();
  const setFetchedModels = vi.fn();
  const setModelSwitchStatus = vi.fn();

  const respond = (body: unknown) => async () => new Response(JSON.stringify(body), { status: 200 });

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('language', 'en');
    calls = [];
    setSelectedModel.mockReset();
    setFetchedModels.mockReset();
    setModelSwitchStatus.mockReset();
    systemInfo = respond({ vram_total: 8 });
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      const url = String(input);
      if (url.startsWith('/api/generate/system-info')) return systemInfo();
      if (url.startsWith('/api/generate/download-model')) return new Response('data: {"status":"done"}\n\n', { status: 200 });
      if (url.startsWith('/api/generate/switch-model')) return new Response(JSON.stringify({ success: true }), { status: 200 });
      if (url.startsWith('/api/generate/models')) return new Response(JSON.stringify({ models: [] }), { status: 200 });
      return new Response('{}', { status: 404 });
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

  const settle = async (ms = 20) => { for (let waited = 0; waited <= ms; waited += 4) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 4)); }); };
  const q = (id: string) => document.body.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  const click = async (el: Element | null) => { await act(async () => { (el as HTMLElement).click(); }); await settle(); };
  const options = () => [...document.body.querySelectorAll('[data-testid^="model-option-"]')].map((el) => (el as HTMLElement).dataset.testid!.replace('model-option-', ''));
  const trigger = () => container.querySelector('button') as HTMLButtonElement;

  async function mount(fetchedModels: FetchedModel[], selectedModel = 'acestep-v15-xl-turbo-bf16', token: string | null = null) {
    await act(async () => {
      root.render(
        <I18nProvider>
          <ModelMenu
            selectedModel={selectedModel}
            setSelectedModel={setSelectedModel}
            modelLoadingState={{ state: 'ready', model: selectedModel, connected: true }}
            fetchedModels={fetchedModels}
            setFetchedModels={setFetchedModels}
            setModelSwitchStatus={setModelSwitchStatus}
            token={token}
            lmModel="acestep-5Hz-lm-0.6B"
            lmBackend="pt"
            lmEditingRef={{ current: false }}
          />
        </I18nProvider>,
      );
    });
    await settle();
  }

  it('on an 8 GB card: the 2B models and the compact XL are listed, the big XL are behind a link that counts them', async () => {
    await mount(served(['acestep-v15-xl-turbo-bf16'], 'acestep-v15-xl-turbo-bf16'));
    await click(trigger());
    expect(options()).toEqual(['acestep-v15-xl-turbo-bf16', 'acestep-v15-turbo', 'acestep-v15-sft', 'acestep-v15-base']);
    expect(q('model-menu-toggle-more')!.textContent).toBe('Show models that need more VRAM (3)');
    expect(document.body.querySelector('[data-testid^="model-vram-note-"]')).toBeNull(); // nothing shown is too big
  });

  it('the link brings them back, each saying what it needs against what the card has, and the link then hides them again', async () => {
    await mount(served(['acestep-v15-xl-turbo-bf16'], 'acestep-v15-xl-turbo-bf16'));
    await click(trigger());
    await click(q('model-menu-toggle-more'));
    expect(options()).toEqual([...XL, ...TWO_B]);
    expect(q('model-vram-note-acestep-v15-xl-turbo')!.textContent).toBe('Needs 12 GB of VRAM (yours: 8 GB)');
    expect(q('model-vram-note-acestep-v15-xl-merge-sft-turbo')).not.toBeNull();
    expect(q('model-vram-note-acestep-v15-turbo')).toBeNull(); // it fits: no note
    expect(q('model-vram-note-acestep-v15-xl-turbo-bf16')).toBeNull(); // 8 asked, 8 had
    expect(q('model-menu-toggle-more')!.textContent).toBe('Hide models that need more VRAM');
    await click(q('model-menu-toggle-more'));
    expect(options()).toEqual(['acestep-v15-xl-turbo-bf16', 'acestep-v15-turbo', 'acestep-v15-sft', 'acestep-v15-base']);
  });

  it('a "8 GB" card that reports 7.6 keeps the models made for 8', async () => {
    systemInfo = respond({ vram_total: 7.6 });
    await mount(served(), 'acestep-v15-turbo'); // the compact XL is neither chosen nor on the disk: only the margin keeps it listed
    await click(trigger());
    expect(options()).toContain('acestep-v15-xl-turbo-bf16');
    expect(q('model-menu-toggle-more')!.textContent).toBe('Show models that need more VRAM (3)');
  });

  it('a model already on the disk stays listed even if the card is too small for it, with its note; it is not counted as folded', async () => {
    await mount(served(['acestep-v15-xl-turbo', 'acestep-v15-xl-turbo-bf16'], 'acestep-v15-xl-turbo-bf16'));
    await click(trigger());
    expect(options()).toContain('acestep-v15-xl-turbo');
    expect(q('model-vram-note-acestep-v15-xl-turbo')!.textContent).toBe('Needs 12 GB of VRAM (yours: 8 GB)');
    expect(q('model-menu-toggle-more')!.textContent).toBe('Show models that need more VRAM (2)');
  });

  it('the chosen model stays listed, whatever its size', async () => {
    await mount(served(), 'acestep-v15-xl-sft');
    await click(trigger());
    expect(options()).toContain('acestep-v15-xl-sft');
    expect(options()).not.toContain('acestep-v15-xl-turbo');
  });

  it('hides nothing on a card with enough memory, and offers no link', async () => {
    systemInfo = respond({ vram_total: 24 });
    await mount(served());
    await click(trigger());
    expect(options()).toEqual([...XL, ...TWO_B]);
    expect(q('model-menu-toggle-more')).toBeNull();
  });

  it('hides nothing when the memory is unknown: no card, engine down, or an answer that is not a number', async () => {
    for (const answer of [respond({ vram_total: 0 }), respond({}), respond({ vram_total: 'lots' }), async () => new Response('nope', { status: 500 }), async () => { throw new Error('offline'); }]) {
      systemInfo = answer;
      act(() => root.unmount());
      root = createRoot(container);
      await mount(served());
      await click(trigger());
      expect(options(), String(answer)).toEqual([...XL, ...TWO_B]);
      expect(q('model-menu-toggle-more')).toBeNull();
    }
  });

  it('asks again when the menu is opened if the first answer failed (the server may start after the page), then stops asking', async () => {
    let attempt = 0;
    systemInfo = async () => { attempt += 1; if (attempt === 1) throw new Error('server starting'); return new Response(JSON.stringify({ vram_total: 8 }), { status: 200 }); };
    await mount(served(['acestep-v15-xl-turbo-bf16'], 'acestep-v15-xl-turbo-bf16'));
    expect(attempt).toBe(1);
    await click(trigger());
    expect(attempt).toBe(2);
    expect(options()).toEqual(['acestep-v15-xl-turbo-bf16', 'acestep-v15-turbo', 'acestep-v15-sft', 'acestep-v15-base']);
    await click(trigger());
    await click(trigger());
    expect(attempt).toBe(2);
  });

  it('never hides a model it knows nothing about: converted, merged or fine-tuned by the user', async () => {
    await mount(served([], null, [{ name: 'my-finetune', is_active: false, is_preloaded: false }]));
    await click(trigger());
    expect(options()).toContain('my-finetune');
  });

  it('when the server is unreachable the menu still offers the whole fixed list, 2B included', async () => {
    systemInfo = respond({ vram_total: 24 });
    await mount([]);
    await click(trigger());
    expect(options()).toEqual([...XL, ...TWO_B]);
  });

  it('choosing a 2B that is not downloaded downloads it, then switches to it', async () => {
    await mount(served(['acestep-v15-xl-turbo-bf16'], 'acestep-v15-xl-turbo-bf16'), 'acestep-v15-xl-turbo-bf16', 'tok');
    await click(trigger());
    await click(q('model-option-acestep-v15-turbo'));
    await settle(60);
    expect(setSelectedModel).toHaveBeenCalledWith('acestep-v15-turbo');
    const download = calls.find((c) => c.url.startsWith('/api/generate/download-model'));
    expect(download?.url).toBe('/api/generate/download-model?model=acestep-v15-turbo');
    expect((download?.init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    const sw = calls.find((c) => c.url.startsWith('/api/generate/switch-model'));
    expect(JSON.parse(String(sw?.init?.body))).toMatchObject({ model: 'acestep-v15-turbo' });
    expect(calls.findIndex((c) => c === download)).toBeLessThan(calls.findIndex((c) => c === sw));
  });

  it('a 2B already on the disk is switched to without downloading', async () => {
    await mount(served(['acestep-v15-xl-turbo-bf16', 'acestep-v15-turbo'], 'acestep-v15-xl-turbo-bf16'), 'acestep-v15-xl-turbo-bf16', 'tok');
    await click(trigger());
    await click(q('model-option-acestep-v15-turbo'));
    await settle(60);
    expect(calls.some((c) => c.url.startsWith('/api/generate/download-model'))).toBe(false);
    expect(calls.some((c) => c.url.startsWith('/api/generate/switch-model'))).toBe(true);
  });

  it('speaks the user\'s language: French, with "vous"', async () => {
    localStorage.setItem('language', 'fr');
    await mount(served(['acestep-v15-xl-turbo-bf16'], 'acestep-v15-xl-turbo-bf16'));
    await click(trigger());
    expect(q('model-menu-toggle-more')!.textContent).toBe('Afficher les modèles qui demandent plus de VRAM (3)');
    await click(q('model-menu-toggle-more'));
    expect(q('model-vram-note-acestep-v15-xl-turbo')!.textContent).toBe('Demande 12 Go de VRAM (vous en avez 8 Go)');
    expect(q('model-menu-toggle-more')!.textContent).toBe('Masquer les modèles qui demandent plus de VRAM');
  });
});
