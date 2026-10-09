// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../context/I18nContext';
import { LmSettings } from './LmSettings';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('the language model selector', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  const render = (extra: Partial<React.ComponentProps<typeof LmSettings>> = {}) =>
    act(() => root.render(
      <I18nProvider><LmSettings
        useOpenRouter={false} lmBackend="pt" onLmBackendChange={vi.fn()} lmModel="acestep-5Hz-lm-0.6B" onLmModelChange={vi.fn()} lmEditingRef={{ current: false }}
        modelSwitchStatus="" onApply={vi.fn()} thinking={false} onThinkingChange={vi.fn()} loraLoaded={false} activeLmModel="acestep-5Hz-lm-0.6B"
        t={(key) => key} tf={(_key, fallback) => fallback} {...extra}
      /></I18nProvider>,
    ));
  const options = () => [...container.querySelectorAll('option')].map((o) => [o.getAttribute('value'), o.textContent]).filter(([v]) => String(v).startsWith('acestep-5Hz-lm-'));

  it('says which models are not downloaded, and only those', () => {
    render({ lmOnDisk: ['acestep-5Hz-lm-0.6B'] });
    expect(options()).toEqual([
      ['acestep-5Hz-lm-0.6B', 'lmModel06B'],
      ['acestep-5Hz-lm-1.7B', 'lmModel17B — modelNotDownloaded'],
      ['acestep-5Hz-lm-4B', 'lmModel4B — modelNotDownloaded'],
    ]);
  });

  it('adds nothing while the server has not said what is on the disk', () => {
    render({ lmOnDisk: null });
    expect(options().map(([, text]) => text)).toEqual(['lmModel06B', 'lmModel17B', 'lmModel4B']);
    render({}); // the prop is optional
    expect(options().map(([, text]) => text)).toEqual(['lmModel06B', 'lmModel17B', 'lmModel4B']);
  });

  it('shows the last failure under the button, and nothing when there is none', () => {
    render({ applyError: 'Could not download LM 1.7B.' });
    expect(container.querySelector('[data-testid="lm-apply-error"]')!.textContent).toBe('Could not download LM 1.7B.');
    render({ applyError: null });
    expect(container.querySelector('[data-testid="lm-apply-error"]')).toBeNull();
  });

  it('does not show the failure when the remote provider is used instead (the local LM is not what runs)', () => {
    render({ applyError: 'x', useOpenRouter: true });
    expect(container.querySelector('[data-testid="lm-apply-error"]')).toBeNull();
  });
});

// CreatePanel is too heavy to mount here: what it must pass on and call is read from its source.
describe('CreatePanel wiring', () => {
  const source = readFileSync(path.resolve(process.cwd(), 'components/CreatePanel.tsx'), 'utf-8');
  it('hands the disk state and the failure to the selector, and applies through the service', () => {
    expect(source).toContain('lmOnDisk={lmOnDisk}');
    expect(source).toContain('applyError={lmApplyError}');
    expect(source).toContain('await applyLmSettings({');
    expect(source).not.toContain("setModelSwitchStatus(data.error || 'Failed')"); // the old silent-ish handler
  });
  it('learns what is on the disk from the three places that read the models (the poll, the refresh, the end of an apply)', () => {
    expect(source.match(/lmOnDiskFrom\(/g)!.length).toBeGreaterThanOrEqual(3);
  });
});
