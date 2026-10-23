// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, it, expect, vi } from 'vitest';
import { TrackPicker } from './TrackPicker';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const tf = (_k: string, f: string) => f;

function mount(props: Partial<React.ComponentProps<typeof TrackPicker>>) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  const base = { mode: 'lego' as const, trackName: '', onTrackNameChange: vi.fn(), completeTrackClasses: '', onCompleteTrackClassesChange: vi.fn(), hasAudio: true, modelIsBase: true, tf };
  act(() => root.render(<TrackPicker {...base} {...props} />));
  return { el, root };
}

describe('TrackPicker', () => {
  it('lego: lists the tracks in a select and warns when the model is not a base one', () => {
    const { el, root } = mount({ modelIsBase: false });
    expect(el.querySelectorAll('option').length).toBe(13);
    expect(el.textContent).toContain('pure base model');
    act(() => root.unmount());
  });
  it('lego: warns when no audio is loaded', () => {
    const { el, root } = mount({ hasAudio: false });
    expect(el.textContent).toContain('Load a source audio first');
    act(() => root.unmount());
  });
  it('complete: toggles tracks into the comma list', () => {
    const onChange = vi.fn();
    const { el, root } = mount({ mode: 'complete', completeTrackClasses: 'drums', onCompleteTrackClassesChange: onChange });
    const buttons = Array.from(el.querySelectorAll('button'));
    act(() => { buttons.find((b) => b.textContent === 'Bass')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onChange).toHaveBeenCalledWith('drums,bass');
    act(() => { buttons.find((b) => b.textContent === 'Drums')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onChange).toHaveBeenLastCalledWith('');
    act(() => root.unmount());
  });
});
