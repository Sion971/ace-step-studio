// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AbCompare } from './AbCompare';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('the level matching of the before / after listening', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  const render = (beforeLufs: number | null, afterLufs: number | null) => act(() => root.render(
    <AbCompare beforeUrl="/b.mp3" afterUrl="blob:a" beforeLabel="Original" afterLabel="Mastered" playLabel="Play" pauseLabel="Pause" beforeLufs={beforeLufs} afterLufs={afterLufs} matchLabel="Match the volume ({{db}} dB)" />,
  ));
  const audio = (i: 0 | 1) => container.querySelectorAll('audio')[i] as HTMLAudioElement;
  const box = () => container.querySelector<HTMLInputElement>('[data-ab-match]');

  it('turns the louder file down by default, and says by how much', () => {
    render(-20, -14);
    expect(box()!.checked).toBe(true);
    expect(container.textContent).toContain('Match the volume (6.0 dB)');
    expect(audio(0).volume).toBe(1);
    expect(audio(1).volume).toBeCloseTo(0.501, 3);
  });

  it('gives both files their full volume back when the box is unchecked', () => {
    render(-20, -14);
    act(() => box()!.click());
    expect(box()!.checked).toBe(false);
    expect(audio(0).volume).toBe(1);
    expect(audio(1).volume).toBe(1);
  });

  it('turns the original down when it is the louder one', () => {
    render(-9, -14);
    expect(audio(0).volume).toBeCloseTo(0.562, 3);
    expect(audio(1).volume).toBe(1);
  });

  it('shows the two measured levels, so a small gap can be seen for what it is', () => {
    render(-20, -14);
    expect(container.querySelector('[data-ab-levels]')!.textContent).toBe('Original -20.0 LUFS · Mastered -14.0 LUFS');
    render(-14, -14.1); // negligible gap: no option, but the numbers still explain why nothing changes
    expect(box()).toBeNull();
    expect(container.querySelector('[data-ab-levels]')!.textContent).toBe('Original -14.0 LUFS · Mastered -14.1 LUFS');
    render(null, -14);
    expect(container.querySelector('[data-ab-levels]')).toBeNull();
  });

  it('shows nothing, and changes nothing, without both levels or with a negligible gap', () => {
    render(null, -14);
    expect(box()).toBeNull();
    render(-14, -14.1);
    expect(box()).toBeNull();
    expect(audio(0).volume).toBe(1);
    expect(audio(1).volume).toBe(1);
  });
});
