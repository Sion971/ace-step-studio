// @vitest-environment happy-dom
import { describe, expect, it, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { applyAnalysis, availableFields, timeSignatureValue, type AudioAnalysis } from '../services/audioAnalysis';

const full: AudioAnalysis = { available: true, status: 'ok', caption: 'dreamy synth pop', lyrics: '[Verse]\nla la', bpm: 96, duration: 187.4, keyScale: 'A minor', language: 'fr', timeSignature: '4' };

describe('audio analysis → form', () => {
  it('reduces a time signature to the number the engine takes', () => {
    expect(timeSignatureValue('4/4')).toBe('4');
    expect(timeSignatureValue('6/8')).toBe('6');
    expect(timeSignatureValue('')).toBe('');
  });

  it('lists only what the engine found', () => {
    expect(availableFields({ ...full, lyrics: '', bpm: null, duration: null })).toEqual(['caption', 'keyScale', 'timeSignature', 'language']);
  });

  it('writes only the checked fields', () => {
    const s = { setStyle: vi.fn(), setLyrics: vi.fn(), setBpm: vi.fn(), setKeyScale: vi.fn(), setTimeSignature: vi.fn(), setDuration: vi.fn(), setVocalLanguage: vi.fn() };
    applyAnalysis(full, new Set(['bpm', 'duration', 'timeSignature', 'language']), s);
    expect(s.setBpm).toHaveBeenCalledWith(96);
    expect(s.setDuration).toHaveBeenCalledWith(187);
    expect(s.setTimeSignature).toHaveBeenCalledWith('4');
    expect(s.setVocalLanguage).toHaveBeenCalledWith('fr');
    expect(s.setStyle).not.toHaveBeenCalled();
    expect(s.setLyrics).not.toHaveBeenCalled();
    expect(s.setKeyScale).not.toHaveBeenCalled();
  });
});

describe('AudioAnalysisDialog', () => {
  let root: Root | null = null;
  afterEach(() => { act(() => root?.unmount()); root = null; vi.unstubAllGlobals(); document.body.innerHTML = ''; });

  const mount = async (response: { status: number; body: unknown }, filled = {}) => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: response.status < 400, status: response.status, statusText: 'x', json: async () => response.body })));
    const { AudioAnalysisDialog } = await import('./AudioAnalysisDialog');
    const { I18nProvider } = await import('../context/I18nContext');
    const setters = { setStyle: vi.fn(), setLyrics: vi.fn(), setBpm: vi.fn(), setKeyScale: vi.fn(), setTimeSignature: vi.fn(), setDuration: vi.fn(), setVocalLanguage: vi.fn() };
    const onClose = vi.fn();
    const host = document.createElement('div'); document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<I18nProvider><AudioAnalysisDialog audioUrl="/audio/a.mp3" title="a" token="t" filled={filled} setters={setters} autoOpen onAutoOpenChange={() => {}} onClose={onClose} /></I18nProvider>);
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    return { setters, onClose };
  };

  it('runs by itself, shows the result, and applies the checked fields', async () => {
    const { setters, onClose } = await mount({ status: 200, body: { analysis: full } });
    expect(document.querySelector('[data-testid="analysis-bpm"]')).not.toBeNull();
    await act(async () => { (document.querySelector('[data-testid="analysis-apply"]') as HTMLButtonElement).click(); });
    expect(setters.setBpm).toHaveBeenCalledWith(96);
    expect(setters.setStyle).toHaveBeenCalledWith('dreamy synth pop');
    expect(onClose).toHaveBeenCalled();
  });

  it('starts with the already-filled fields unchecked', async () => {
    await mount({ status: 200, body: { analysis: full } }, { lyrics: true });
    expect((document.querySelector('[data-testid="analysis-lyrics"]') as HTMLInputElement).checked).toBe(false);
    expect((document.querySelector('[data-testid="analysis-caption"]') as HTMLInputElement).checked).toBe(true);
  });

  it('says so when the engine is busy', async () => {
    await mount({ status: 409, body: { error: 'busy' } });
    expect(document.body.textContent).toContain('busy');
  });
});
