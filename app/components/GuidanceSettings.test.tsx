// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, it, expect, vi } from 'vitest';
import { GuidanceSettings } from './GuidanceSettings';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const base = {
  cfgIntervalStart: 0, onCfgIntervalStartChange: vi.fn(), cfgIntervalEnd: 1, onCfgIntervalEndChange: vi.fn(),
  customTimesteps: '', onCustomTimestepsChange: vi.fn(), scoreScale: 0.5, onScoreScaleChange: vi.fn(),
  lmBatchChunkSize: 8, onLmBatchChunkSizeChange: vi.fn(), useAdg: false, onUseAdgChange: vi.fn(),
  t: (k: string) => k, tf: (_k: string, f: string) => f,
};

function mount(turbo?: boolean) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => root.render(<GuidanceSettings {...base} turbo={turbo} />));
  return { el, root };
}

describe('GuidanceSettings', () => {
  it('est replie par defaut et se deplie au clic', () => {
    const { el, root } = mount();
    expect(el.textContent).not.toContain('presetCleanVocals');
    act(() => { el.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(el.textContent).toContain('presetCleanVocals');
    act(() => root.unmount());
  });
  it('ne montre rien pour un modele turbo', () => {
    const { el, root } = mount(true);
    expect(el.innerHTML).toBe('');
    act(() => root.unmount());
  });
});
