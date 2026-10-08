// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../context/I18nContext';
import { ModelMenu, type FetchedModel } from './ModelMenu';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Un modèle téléchargé après le démarrage du moteur était refusé par Gradio (« not in the list of choices »), le serveur répondait 500, et le menu
// ignorait la réponse : rien n'expliquait pourquoi le Turbo ne se chargeait pas. Ces tests gardent que chaque échec est dit.
const model = (name: string, onDisk: boolean): FetchedModel => ({ name, is_active: false, is_preloaded: onDisk });

describe('the model menu says when a download or a switch fails', () => {
  let container: HTMLDivElement;
  let root: Root;
  let download: () => Response;
  let switchModel: () => Promise<Response>;
  const setSelectedModel = vi.fn();

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('language', 'en');
    setSelectedModel.mockReset();
    download = () => new Response('data: {"status":"done"}\n\n', { status: 200 });
    switchModel = async () => new Response(JSON.stringify({ success: true }), { status: 200 });
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = String(input);
      if (url.startsWith('/api/generate/system-info')) return new Response(JSON.stringify({ vram_total: 8 }), { status: 200 });
      if (url.startsWith('/api/generate/download-model')) return download();
      if (url.startsWith('/api/generate/switch-model')) return switchModel();
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
    vi.useRealTimers();
  });

  const settle = async (ms = 40) => { for (let waited = 0; waited <= ms; waited += 4) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 4)); }); };
  const alertText = () => document.body.querySelector('[data-testid="model-switch-error"]')?.textContent ?? null;

  async function pickTurbo(turboOnDisk: boolean) {
    await act(async () => {
      root.render(
        <I18nProvider>
          <ModelMenu
            selectedModel="acestep-v15-xl-turbo-bf16"
            setSelectedModel={setSelectedModel}
            modelLoadingState={{ state: 'ready', model: 'acestep-v15-xl-turbo-bf16', connected: true }}
            fetchedModels={[model('acestep-v15-xl-turbo-bf16', true), model('acestep-v15-turbo', turboOnDisk)]}
            setFetchedModels={vi.fn()}
            setModelSwitchStatus={vi.fn()}
            token="tok"
            lmModel="acestep-5Hz-lm-0.6B"
            lmBackend="pt"
            lmEditingRef={{ current: false }}
          />
        </I18nProvider>,
      );
    });
    await settle();
    await act(async () => { (container.querySelector('button') as HTMLElement).click(); });
    await settle();
    await act(async () => { (document.body.querySelector('[data-testid="model-option-acestep-v15-turbo"]') as HTMLElement).click(); });
    await settle(80);
  }

  it('says why when the engine refuses the switch (the real refusal of a model added after the start)', async () => {
    switchModel = async () => new Response(JSON.stringify({ error: `Model switch failed: Value: acestep-v15-turbo is not in the list of choices: ['acestep-v15-xl-turbo-bf16']` }), { status: 500 });
    await pickTurbo(true);
    expect(alertText()).toContain('Could not load Turbo');
    expect(alertText()).toContain('is not in the list of choices');
  });

  it('says it when the server cannot be reached', async () => {
    switchModel = async () => { throw new Error('Failed to fetch'); };
    await pickTurbo(true);
    expect(alertText()).toBe('Could not load Turbo: Failed to fetch');
  });

  it('gives the HTTP status when the refusal has no message, and survives an answer that is not JSON', async () => {
    switchModel = async () => new Response('<html>bad gateway</html>', { status: 502 });
    await pickTurbo(true);
    expect(alertText()).toContain('HTTP 502');
  });

  it('says it when the download fails, and does not try to load a model that is not there', async () => {
    download = () => new Response('data: {"status":"error","message":"boom"}\n\n', { status: 200 });
    await pickTurbo(false);
    expect(alertText()).toContain('Could not download');
    expect((fetch as any).mock.calls.some((c: string[]) => String(c[0]).startsWith('/api/generate/switch-model'))).toBe(false);
  });

  it('shows nothing when everything works', async () => {
    await pickTurbo(false);
    expect(alertText()).toBeNull();
    expect((fetch as any).mock.calls.some((c: string[]) => String(c[0]).startsWith('/api/generate/switch-model'))).toBe(true);
  });

  it('removes the message by itself after 15 seconds', async () => {
    switchModel = async () => new Response(JSON.stringify({ error: 'nope' }), { status: 500 });
    const timers = vi.spyOn(globalThis, 'setTimeout');
    await pickTurbo(true);
    expect(alertText()).not.toBeNull();
    const expire = timers.mock.calls.find((call) => call[1] === 15000)?.[0] as (() => void) | undefined;
    expect(expire, 'a 15 second timer was set').toBeTypeOf('function');
    await act(async () => { expire!(); });
    expect(alertText()).toBeNull();
    timers.mockRestore();
  });
});
