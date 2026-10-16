// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AbCompare } from './AbCompare';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// happy-dom does not play anything: a minimal stand-in keeps track of "paused" and of the position.
const proto = HTMLMediaElement.prototype as any;
const saved = { play: proto.play, pause: proto.pause, paused: Object.getOwnPropertyDescriptor(proto, 'paused') };

describe('the before / after listening', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.defineProperty(proto, 'paused', { configurable: true, get() { return this._paused ?? true; } });
    proto.play = function () { this._paused = false; return Promise.resolve(); };
    proto.pause = function () { this._paused = true; };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(
      <AbCompare beforeUrl="/before.mp3" afterUrl="blob:after" beforeLabel="Original" afterLabel="Mastered" playLabel="Play" pauseLabel="Pause" hint="Switch while it plays." />,
    ));
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    proto.play = saved.play;
    proto.pause = saved.pause;
    if (saved.paused) Object.defineProperty(proto, 'paused', saved.paused); else delete proto.paused;
  });

  const audio = (which: 'before' | 'after') => container.querySelectorAll('audio')[which === 'before' ? 0 : 1] as any;
  const click = (selector: string) => act(() => { (container.querySelector(selector) as HTMLElement).click(); });

  it('starts on the processed side, paused, with both files loaded', () => {
    expect(container.querySelector('[data-ab="after"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('[data-ab="before"]')!.getAttribute('aria-pressed')).toBe('false');
    expect(audio('before').getAttribute('src')).toBe('/before.mp3');
    expect(audio('after').getAttribute('src')).toBe('blob:after');
    expect(audio('before').paused && audio('after').paused).toBe(true);
  });

  it('plays the selected side only, and the button follows', () => {
    click('[data-ab-play]');
    expect(audio('after').paused).toBe(false);
    expect(audio('before').paused).toBe(true);
    expect(container.querySelector('[data-ab-play]')!.getAttribute('aria-label')).toBe('Pause');
    click('[data-ab-play]');
    expect(audio('after').paused).toBe(true);
    expect(container.querySelector('[data-ab-play]')!.getAttribute('aria-label')).toBe('Play');
  });

  it('switches while playing: other file takes over at the same position, the first stops', () => {
    click('[data-ab-play]');
    audio('after').currentTime = 42.5;
    click('[data-ab="before"]');
    expect(audio('before').currentTime).toBe(42.5);
    expect(audio('before').paused).toBe(false);
    expect(audio('after').paused).toBe(true);
    audio('before').currentTime = 50;
    click('[data-ab="after"]');
    expect(audio('after').currentTime).toBe(50);
    expect(audio('after').paused).toBe(false);
    expect(audio('before').paused).toBe(true);
  });

  it('switching while paused moves the position but does not start anything', () => {
    audio('after').currentTime = 10;
    click('[data-ab="before"]');
    expect(audio('before').currentTime).toBe(10);
    expect(audio('before').paused && audio('after').paused).toBe(true);
  });

  it('seeks both files to the same place', () => {
    const seek = container.querySelector<HTMLInputElement>('[data-ab-seek]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(seek, '0.5');
      seek.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(audio('before').currentTime).toBe(0.5);
    expect(audio('after').currentTime).toBe(0.5);
  });
});
