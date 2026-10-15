// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatasetTab } from './DatasetTab';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const loaded = { status: 'ok', dataframe: { headers: [], data: [] }, sampleCount: 1, sample: null, settings: { datasetName: 'old' } };

describe('dataset tab paths', () => {
  let container: HTMLDivElement;
  let root: Root;
  let saved: string;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/save-dataset')) {
        const body = JSON.parse(String(init?.body));
        saved = body.savePath;
        return { ok: true, status: 200, json: async () => ({ status: 'saved', path: body.savePath }) };
      }
      return { ok: true, status: 200, json: async () => loaded };
    }));
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const setValue = (el: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const inputWith = (value: string) => Array.from(container.querySelectorAll('input[type="text"]')).filter(i => (i as HTMLInputElement).value === value) as HTMLInputElement[];

  it('follows the dataset name, then feeds the preprocess box once saved', async () => {
    await act(async () => { root.render(<DatasetTab token="tok" t={(k: string) => k} markStep={() => {}} />); });
    // the load button sits next to the dataset path field
    const pathInput = container.querySelector('input[placeholder="./datasets/my_dataset.json"]') as HTMLInputElement;
    await act(async () => { setValue(pathInput, './datasets/other.json'); });
    await act(async () => { (pathInput.nextElementSibling as HTMLButtonElement).click(); });
    // rename the dataset
    const nameInput = inputWith('old')[0];
    expect(nameInput).toBeTruthy();
    await act(async () => { setValue(nameInput, 'mercy'); });
    expect(inputWith('./datasets/mercy.json').length).toBeGreaterThanOrEqual(1);
    // the preprocess box still points at the file that exists
    const pre = container.querySelector('input[placeholder="./datasets/my_lora_dataset.json"]') as HTMLInputElement;
    expect(pre.value).toBe('./datasets/other.json');
    // save
    const saveBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'saveDataset')!;
    await act(async () => { saveBtn.click(); });
    expect(saved).toBe('./datasets/mercy.json');
    expect(pre.value).toBe('./datasets/mercy.json');
  });
});
