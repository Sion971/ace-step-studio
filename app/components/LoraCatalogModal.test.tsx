// @vitest-environment happy-dom
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../context/I18nContext';
import { en } from '../i18n/en';
import { fr } from '../i18n/fr';
import { LoraCatalogModal } from './LoraCatalogModal';
import type { CardDto, CatalogEntryDto, CompatibilityDto, InstalledLoraDto, JobDto, ReasonDto, StudioContext } from '../services/loraHub';
import { LoraHubApiError } from '../services/loraHub';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// ------------------------------------------------------------------------------------------------------------------- fixtures --
const compat = (verdict: CompatibilityDto['verdict'] = 'compatible', reasons: ReasonDto[] = []): CompatibilityDto => ({
  verdict, reasons, vramGb: 8, active: null, required: { family: 'turbo', size: '2B', label: 'AceStep v1.5 Turbo (2B)', sources: ['metadata file'], conflict: false },
});
const installedDto = (over: Partial<InstalledLoraDto> = {}): InstalledLoraDto => ({
  name: 'lofi', path: './lora_output/lofi', repo: 'user/lofi', revision: 'a'.repeat(40), file: 'lofi.safetensors', sha256: 'b'.repeat(64), installedAt: '2026-10-08T00:00:00Z',
  license: null, baseModel: ['AceStep v1.5 Turbo (2B)'], triggerWord: 'roti-l0f1y', recommended: { scale: 0.8, steps: 8, guidance: 7, shift: 3 }, ...over,
});
const entry = (over: Partial<CatalogEntryDto> = {}): CatalogEntryDto => ({
  id: 'lofi', repo: 'user/lofi', file: 'lofi.safetensors', revision: 'a'.repeat(40), sha256: 'b'.repeat(64), name: 'Lo-Fi', description: 'A lo-fi style.', author: 'Someone', license: null,
  baseModel: 'AceStep v1.5 Turbo (2B)', genre: 'lo-fi', tags: ['lo-fi', 'chill'], triggerWord: 'roti-l0f1y', recommended: { scale: 0.8, steps: 8, guidance: 7, shift: 3 }, sizeBytes: 88_130_248,
  verified: { date: '2026-10-07', note: null }, installed: null, compatibility: compat(), ...over,
});
const job = (over: Partial<JobDto> = {}): JobDto => ({ id: 'j1', repo: 'user/lofi', name: 'lofi', state: 'downloading', bytesDone: 0, bytesTotal: 88_130_248, ...over });
const card = (over: Partial<CardDto> = {}): CardDto => ({
  repo: 'user/two', revision: 'c0ffee', license: 'mit', baseModel: [], tags: [], weights: [{ name: 'a.safetensors', size: 10_000_000 }, { name: 'b.safetensors', size: 20_000_000 }],
  selected: null, needsChoice: true, adapter: null, sidecar: null, suggestedName: 'two', alreadyInstalled: null, warnings: [], ...over,
});

function fakeApi(overrides: Record<string, unknown> = {}) {
  return {
    catalog: vi.fn(async () => ({ entries: [entry()], problems: [] as string[] })),
    installFromCatalog: vi.fn(async () => ({ job: job() })),
    inspect: vi.fn(async () => ({ card: card(), compatibility: compat() })),
    install: vi.fn(async () => ({ job: job({ id: 'link1', repo: 'user/two', name: 'two' }) })),
    job: vi.fn(async () => ({ job: job({ state: 'done', bytesDone: 88_130_248, result: { name: 'lofi', path: './lora_output/lofi' } }) })),
    installed: vi.fn(async () => ({ installed: [installedDto()] })),
    ...overrides,
  };
}

// --------------------------------------------------------------------------------------------------------------------- harness --
describe('LoraCatalogModal', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('language', 'en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  // React keeps the updates of an open act() until it closes, so the chain "poll -> state -> next timer" advances once per act: wait in many short ones.
  const settle = async (ms = 0) => {
    const step = 4;
    for (let waited = 0; waited <= ms; waited += step) await act(async () => { await new Promise((resolve) => setTimeout(resolve, step)); });
  };
  const q = (id: string) => document.body.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  const click = async (el: Element | null) => { await act(async () => { (el as HTMLElement).click(); }); };

  async function mount(options: { api?: ReturnType<typeof fakeApi>; context?: StudioContext; onClose?: () => void; onUse?: (i: InstalledLoraDto) => void; onInstalled?: () => void; pollMs?: number } = {}) {
    const api = options.api ?? fakeApi();
    const props = { token: 'tok', onClose: options.onClose ?? vi.fn(), onUse: options.onUse ?? vi.fn(), onInstalled: options.onInstalled, api: api as never, readContext: async () => options.context ?? { activeModel: 'acestep-v15-turbo', vramGb: 8 }, pollMs: options.pollMs ?? 5 };
    await act(async () => { root.render(<I18nProvider><LoraCatalogModal {...props} /></I18nProvider>); });
    await settle(10);
    return { api, props };
  }

  // ----------------------------------------------------------------------------------------------------------------- the list --
  it('lists the catalog with its verdict, and says which model is loaded', async () => {
    await mount();
    expect(q('lora-catalog')?.getAttribute('role')).toBe('dialog');
    expect(q('hub-context')?.textContent).toBe('Loaded model: Turbo · GPU memory: 8 GB');
    expect(q('hub-entry-lofi')?.textContent).toContain('Lo-Fi');
    expect(q('hub-verdict-lofi')?.textContent).toBe('Compatible');
    expect(q('hub-entry-lofi')?.textContent).toContain('Needs: Turbo (2B)');
    expect(q('hub-entry-lofi')?.textContent).toContain('88.1\u00a0MB');
    expect(q('hub-entry-lofi')?.textContent).toContain('Verified 2026-10-07');
    expect(q('hub-trigger-lofi')?.textContent).toBe('roti-l0f1y');
    expect(q('hub-entry-lofi')?.textContent).toContain('License not declared');
    expect(q('hub-entry-lofi')?.textContent).toContain('Scale: 0.8 · Steps: 8 · Guidance: 7 · Shift: 3');
  });

  it('asks the server with the loaded model and the memory', async () => {
    const { api } = await mount({ context: { activeModel: 'acestep-v15-xl-turbo', vramGb: 12 } });
    expect(api.catalog).toHaveBeenCalledWith('tok', { activeModel: 'acestep-v15-xl-turbo', vramGb: 12 });
  });

  it('says ONCE that the engine is not ready, never "compatible", and does not repeat it on every card', async () => {
    const api = fakeApi({ catalog: vi.fn(async () => ({ entries: [entry({ compatibility: compat('unknown', [{ code: 'active_model_unknown', severity: 'info', params: {} }]) }), entry({ id: 'two', name: 'Two', repo: 'user/two', file: null, revision: null, sha256: null, compatibility: compat('unknown', [{ code: 'active_model_unknown', severity: 'info', params: {} }]) })], problems: [] })) });
    await mount({ api, context: {} });
    expect(q('hub-context')?.textContent).toBe(en.loraHubContextUnknown);
    expect(q('hub-verdict-lofi')?.textContent).toBe('Unknown');
    expect(q('hub-verdict-two')?.textContent).toBe('Unknown');
    expect(document.body.textContent).not.toContain(en.loraHubReasonNoActive);
    expect(document.body.textContent).not.toContain('Compatible');
  });

  it('shows each reason in the color of its own severity', async () => {
    const reasons: ReasonDto[] = [
      { code: 'vram_low', severity: 'warning', params: { needed: 12, vramGb: 8 } },
      { code: 'size_mismatch', severity: 'blocking', params: { required: 'XL', active: '2B', activeModel: 'acestep-v15-turbo' } },
    ];
    await mount({ api: fakeApi({ catalog: vi.fn(async () => ({ entries: [entry({ compatibility: compat('incompatible', reasons) })], problems: [] })) }) });
    const items = [...document.body.querySelectorAll('[data-testid="hub-entry-lofi"] li')];
    expect(items.map((li) => li.getAttribute('data-severity'))).toEqual(['blocking', 'warning']); // blocking first, whatever order the server used
    expect(items[0].className).toContain('text-red');
    expect(items[1].className).toContain('text-amber');
    expect(items[0].textContent).toContain('cannot be loaded');
  });

  it('mentions the entries that were ignored, and says when the catalog is empty', async () => {
    await mount({ api: fakeApi({ catalog: vi.fn(async () => ({ entries: [entry()], problems: ['entries[2]: bad', 'entries[3]: bad'] })) }) });
    expect(document.body.textContent).toContain('Catalog entries ignored because they are not valid: 2');
    act(() => root.unmount());
    root = createRoot(container);
    await mount({ api: fakeApi({ catalog: vi.fn(async () => ({ entries: [], problems: [] })) }) });
    expect(document.body.textContent).toContain(en.loraHubEmpty);
  });

  it('writes everything in French when the interface is in French', async () => {
    localStorage.setItem('language', 'fr');
    await mount();
    expect(document.body.textContent).toContain(fr.loraHubTitle);
    expect(q('hub-verdict-lofi')?.textContent).toBe('Compatible');
    expect(q('hub-entry-lofi')?.textContent).toContain('Nécessite : Turbo (2B)');
    expect(q('hub-entry-lofi')?.textContent).toContain('Vérifié le 2026-10-07');
    expect(q('hub-entry-lofi')?.textContent).toContain('Licence non déclarée');
    expect(q('hub-install-lofi')?.textContent).toBe('Installer');
    expect(document.body.textContent).not.toMatch(/loraHub[A-Z]/); // no raw identifier
  });

  // -------------------------------------------------------------------------------------------------------------- installing --
  it('installs, follows the progress, then offers "Use"', async () => {
    const onInstalled = vi.fn();
    let current = job({ bytesDone: 30_000_000 }); // what the server answers to the next poll: set by the test, not by the clock
    const api = fakeApi({ job: vi.fn(async () => ({ job: current })) });
    api.catalog.mockResolvedValueOnce({ entries: [entry()], problems: [] });
    api.catalog.mockResolvedValue({ entries: [entry({ installed: installedDto() })], problems: [] });
    await mount({ api, onInstalled });

    await click(q('hub-install-lofi'));
    expect(api.installFromCatalog).toHaveBeenCalledWith('tok', 'lofi');
    await settle(20);
    const bar = document.body.querySelector('[role="progressbar"]');
    expect(bar).not.toBeNull();
    expect(bar?.getAttribute('aria-valuenow')).toBe('34'); // 30 MB of 88.1 MB
    expect(q('hub-progress')?.textContent).toContain('Downloading');
    expect(q('hub-progress')?.textContent).toContain('30.0\u00a0MB of 88.1\u00a0MB');
    expect((q('hub-install-lofi') as HTMLButtonElement).disabled).toBe(true);

    current = job({ state: 'verifying', bytesDone: 88_130_248 });
    await settle(20);
    expect(q('hub-progress')?.textContent).toContain('Checking the file');
    expect(onInstalled).not.toHaveBeenCalled(); // not before it is done

    current = job({ state: 'done', bytesDone: 88_130_248, result: { name: 'lofi', path: './lora_output/lofi' } });
    await settle(40);
    expect(q('hub-installed-lofi')?.textContent).toBe('Installed');
    expect(q('hub-install-lofi')).toBeNull();
    expect((q('hub-use-lofi') as HTMLButtonElement).disabled).toBe(false);
    expect(onInstalled).toHaveBeenCalledTimes(1);
    expect(api.catalog.mock.calls.length).toBeGreaterThanOrEqual(2); // the list was read again, to learn that it is installed
    expect(q('hub-progress')).toBeNull();
  });

  it('hands the installed LoRA to the panel when "Use" is pressed, then closes', async () => {
    const onUse = vi.fn();
    const onClose = vi.fn();
    await mount({ api: fakeApi({ catalog: vi.fn(async () => ({ entries: [entry({ installed: installedDto() })], problems: [] })) }), onUse, onClose });
    await click(q('hub-use-lofi'));
    expect(onUse).toHaveBeenCalledWith(installedDto());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not let an installed LoRA be used when the loaded model cannot take it', async () => {
    const reasons: ReasonDto[] = [{ code: 'size_mismatch', severity: 'blocking', params: { required: '2B', active: 'XL', activeModel: 'acestep-v15-xl-turbo' } }];
    const onUse = vi.fn();
    await mount({ api: fakeApi({ catalog: vi.fn(async () => ({ entries: [entry({ installed: installedDto(), compatibility: compat('incompatible', reasons) })], problems: [] })) }), onUse });
    const use = q('hub-use-lofi') as HTMLButtonElement;
    expect(use.disabled).toBe(true);
    expect(use.title).toContain('cannot be loaded');
    await click(use);
    expect(onUse).not.toHaveBeenCalled();
  });

  it('writes a failure in the user\'s language, never with the server\'s sentence, and lets the user try again', async () => {
    const api = fakeApi({ installFromCatalog: vi.fn(async () => { throw new LoraHubApiError('English server sentence', 409, 'catalog_checksum_mismatch'); }) });
    await mount({ api });
    await click(q('hub-install-lofi'));
    await settle(5);
    expect(q('hub-error-lofi')?.textContent).toBe(en.loraHubErrChanged);
    expect(document.body.textContent).not.toContain('English server sentence');
    expect(q('hub-install-lofi')?.textContent).toBe('Try again');
    await click(q('hub-install-lofi'));
    expect(api.installFromCatalog).toHaveBeenCalledTimes(2);
  });

  it('shows a failure that happens while the install runs', async () => {
    const api = fakeApi({ job: vi.fn(async () => ({ job: job({ state: 'failed', error: { code: 'download_stalled', message: 'The download stalled (no data for 60 s).' } }) })) });
    await mount({ api });
    await click(q('hub-install-lofi'));
    await settle(40);
    expect(q('hub-error-lofi')?.textContent).toBe(en.loraHubErrStalled);
    expect(q('hub-progress')).toBeNull();
  });

  it('keeps following the progress when the parent renders again and again (the panel renders at every keystroke of the prompt)', async () => {
    // The parent hands over NEW functions at every render. If the progress timer depended on them, it would be restarted each time, and with a
    // render faster than the poll it would never fire: the bar would stay where it is until the user stops typing.
    const states = [job({ bytesDone: 20_000_000 }), job({ state: 'done', bytesDone: 88_130_248, result: { name: 'lofi', path: './lora_output/lofi' } })];
    let poll = 0;
    const api = fakeApi({ job: vi.fn(async () => ({ job: states[Math.min(poll++, states.length - 1)] })) });
    api.catalog.mockResolvedValue({ entries: [entry({ installed: installedDto() })], problems: [] });
    api.catalog.mockResolvedValueOnce({ entries: [entry()], problems: [] });
    const render = () => root.render(
      <I18nProvider>
        <LoraCatalogModal token="tok" api={api as never} readContext={async () => ({ activeModel: 'acestep-v15-turbo' })} pollMs={30} onClose={() => undefined} onUse={() => undefined} onInstalled={() => undefined} />
      </I18nProvider>,
    );
    await act(async () => render());
    await settle(15);
    await click(q('hub-install-lofi'));
    for (let i = 0; i < 80; i++) await act(async () => { render(); await new Promise((resolve) => setTimeout(resolve, 3)); }); // a render every 3 ms, a poll every 30
    expect(api.job.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(q('hub-installed-lofi')?.textContent).toBe('Installed');
  });

  it('does not fail when it is closed in the middle of an install', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const api = fakeApi({ job: vi.fn(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); return { job: job({ bytesDone: 1 }) }; }) });
    await mount({ api });
    await click(q('hub-install-lofi'));
    await settle(12); // a poll is now waiting for the server
    await act(async () => root.unmount());
    root = createRoot(container);
    await new Promise((resolve) => setTimeout(resolve, 60)); // the answer arrives after the modal is gone
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  // ------------------------------------------------------------------------------------------------------------------- a link --
  const type = async (value: string) => {
    const input = document.body.querySelector('input[type="text"]') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    return input;
  };
  const checkButton = () => [...document.body.querySelectorAll('button')].find((b) => b.textContent === 'Check') as HTMLButtonElement;

  it('checks a link, and refuses a bad one in the user\'s language', async () => {
    const api = fakeApi({ inspect: vi.fn(async () => { throw new LoraHubApiError('x', 400, 'invalid_source'); }) });
    await mount({ api });
    expect(checkButton().disabled).toBe(true); // nothing typed yet
    await type('not a link');
    await click(checkButton());
    await settle(5);
    expect(q('hub-link-error')?.textContent).toBe(en.loraHubErrSource);
    expect(q('hub-link-card')).toBeNull();
    expect(api.inspect).toHaveBeenCalledWith('tok', 'not a link', { activeModel: 'acestep-v15-turbo', vramGb: 8 }, undefined);
  });

  it('asks which weights to install when there are several, then installs that file', async () => {
    const inspect = vi.fn(async (_token: unknown, _source: string, _ctx: StudioContext, file?: string) =>
      file
        ? { card: card({ needsChoice: false, selected: { name: file, size: 20_000_000 }, adapter: { rank: 64, alpha: 128, baseModel: 'acestep-v15-turbo' }, sidecar: { name: 'Two', author: null, description: null, triggerWord: 'tw', recommended: { scale: 1, steps: 8, guidance: null, shift: null } } }), compatibility: compat() }
        : { card: card(), compatibility: compat() },
    );
    const api = fakeApi({ inspect });
    await mount({ api });
    await type('user/two');
    await click(checkButton());
    await settle(5);
    expect(q('hub-link-card')?.textContent).toContain(en.loraHubChooseFile);
    const radios = [...document.body.querySelectorAll('input[type="radio"]')] as HTMLInputElement[];
    expect(radios).toHaveLength(2);
    expect((q('hub-install-link') as HTMLButtonElement).disabled).toBe(true); // a choice is needed first

    await click(radios[1]);
    await settle(5);
    expect(inspect).toHaveBeenLastCalledWith('tok', 'user/two', { activeModel: 'acestep-v15-turbo', vramGb: 8 }, 'b.safetensors');
    expect(q('hub-link-card')?.textContent).toContain('Adapter: rank 64');
    expect(q('hub-trigger-link')?.textContent).toBe('tw');
    expect((q('hub-install-link') as HTMLButtonElement).disabled).toBe(false);

    await click(q('hub-install-link'));
    expect(api.install).toHaveBeenCalledWith('tok', 'user/two', 'b.safetensors');
  });

  it('offers "Use" for a LoRA installed from a link, once it is done', async () => {
    const onUse = vi.fn();
    const api = fakeApi({
      inspect: vi.fn(async () => ({ card: card({ needsChoice: false, selected: { name: 'a.safetensors', size: 1 } }), compatibility: compat() })),
      job: vi.fn(async () => ({ job: job({ id: 'link1', name: 'two', state: 'done', result: { name: 'two', path: './lora_output/two' } }) })),
      installed: vi.fn(async () => ({ installed: [installedDto({ name: 'two', path: './lora_output/two' })] })),
    });
    await mount({ api, onUse });
    await type('user/two');
    await click(checkButton());
    await settle(5);
    await click(q('hub-install-link'));
    await settle(40);
    expect(q('hub-use-link')).not.toBeNull();
    await click(q('hub-use-link'));
    expect(onUse).toHaveBeenCalledWith(installedDto({ name: 'two', path: './lora_output/two' }));
  });

  // ------------------------------------------------------------------------------------------------------------- the catalog fails --
  it('says so when the catalog cannot be loaded, and loads it when the user tries again', async () => {
    const catalog = vi.fn().mockRejectedValueOnce(new LoraHubApiError('boom', 500, 'unknown')).mockResolvedValue({ entries: [entry()], problems: [] });
    await mount({ api: fakeApi({ catalog }) });
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(en.loraHubLoadFailed);
    expect(q('hub-entry-lofi')).toBeNull();
    await click([...document.body.querySelectorAll('button')].find((b) => b.textContent === 'Try again') ?? null);
    await settle(10);
    expect(q('hub-entry-lofi')).not.toBeNull();
    expect(document.body.querySelector('[role="alert"]')).toBeNull();
  });

  // ------------------------------------------------------------------------------------------------------------------ closing --
  it('closes with Escape, with the close button and by clicking outside, but not by clicking inside', async () => {
    const onClose = vi.fn();
    await mount({ onClose });
    await click(q('lora-catalog'));
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' })); });
    expect(onClose).toHaveBeenCalledTimes(1);
    await click(document.body.querySelector('button[aria-label="Close"]'));
    expect(onClose).toHaveBeenCalledTimes(2);
    await click(q('lora-catalog')?.parentElement ?? null);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('puts the focus on the close button when it opens', async () => {
    await mount();
    expect(document.activeElement).toBe(document.body.querySelector('button[aria-label="Close"]'));
  });
});
