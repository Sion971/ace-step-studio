import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { CreateModeSwitch, hasNothingToSend, readCreateView, saveCreateView, CREATE_VIEW_KEY } from './CreateModeSwitch';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const t = (k: string) => k;
const tf = (_k: string, f: string) => f;

function render(props: Partial<React.ComponentProps<typeof CreateModeSwitch>> = {}) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const onChange = vi.fn(); const onInstrumentalChange = vi.fn();
  act(() => root.render(<CreateModeSwitch view="custom" onChange={onChange} hidden={{ style: false, lyrics: false, audio: false }} instrumental={false} onInstrumentalChange={onInstrumentalChange} t={t} tf={tf} {...props} />));
  return { host, onChange, onInstrumentalChange, done: () => { act(() => root.unmount()); host.remove(); } };
}

describe('CreateModeSwitch', () => {
  it('switches view on click', () => {
    const r = render();
    act(() => { (r.host.querySelector('[data-testid="create-view-simple"]') as HTMLElement).click(); });
    expect(r.onChange).toHaveBeenCalledWith('simple');
    r.done();
  });

  it('shows nothing extra in the custom view', () => {
    const r = render({ hidden: { style: true, lyrics: true, audio: true } });
    expect(r.host.querySelector('[data-testid="create-simple-hidden"]')).toBeNull();
    r.done();
  });

  it('in the simple view, says which hidden fields are still used', () => {
    const r = render({ view: 'simple', hidden: { style: true, lyrics: false, audio: true } });
    const note = r.host.querySelector('[data-testid="create-simple-hidden"]')!.textContent!;
    expect(note).toContain('style');
    expect(note).toContain('audio');
    expect(note).not.toContain('paroles');
    r.done();
  });

  it('stays quiet in the simple view when nothing hidden is filled', () => {
    const r = render({ view: 'simple' });
    expect(r.host.querySelector('[data-testid="create-simple-hidden"]')).toBeNull();
    r.done();
  });

  it('keeps the instrumental choice reachable in the simple view', () => {
    const r = render({ view: 'simple' });
    act(() => { (r.host.querySelector('[data-testid="create-simple-instrumental"]') as HTMLInputElement).click(); });
    expect(r.onInstrumentalChange).toHaveBeenCalledWith(true);
    r.done();
  });
});

describe('remembered view', () => {
  it('defaults to the full panel and remembers the choice', () => {
    localStorage.removeItem(CREATE_VIEW_KEY);
    expect(readCreateView()).toBe('custom');
    saveCreateView('simple');
    expect(readCreateView()).toBe('simple');
    localStorage.setItem(CREATE_VIEW_KEY, 'junk');
    expect(readCreateView()).toBe('custom');
  });
});

describe('hasNothingToSend', () => {
  const none = { description: '', style: '', lyrics: '', referenceAudioUrl: '', sourceAudioUrl: '' };
  it('is true when everything is empty or blank', () => {
    expect(hasNothingToSend(none)).toBe(true);
    expect(hasNothingToSend({ ...none, description: '   ' })).toBe(true);
  });
  it('is false as soon as one source of content exists', () => {
    for (const k of Object.keys(none)) expect(hasNothingToSend({ ...none, [k]: 'x' })).toBe(false);
  });
});

describe('hasNothingToSend in the simple view', () => {
  const f = { description: '', style: 'rock', lyrics: 'la la', referenceAudioUrl: 'a.mp3', sourceAudioUrl: '' };
  it('blocks on an empty description even when hidden fields are filled', () => {
    expect(hasNothingToSend(f, 'simple')).toBe(true);
    expect(hasNothingToSend(f, 'custom')).toBe(false);
  });
  it('allows a description', () => {
    expect(hasNothingToSend({ ...f, description: 'une chanson', style: '' }, 'simple')).toBe(false);
  });
});
