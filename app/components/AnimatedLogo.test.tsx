// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import faviconSvg from '../favicon.svg?raw';
import { AnimatedLogo, LOGO_STAR, LOGO_WAVE } from './AnimatedLogo';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const proto = (globalThis as any).SVGPathElement.prototype;
const original = { getTotalLength: proto.getTotalLength, getPointAtLength: proto.getPointAtLength };
let roots: { root: Root; container: HTMLElement }[] = [];

function render(el: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(el));
  const entry = { root, container };
  roots.push(entry);
  return {
    container,
    rerender: (next: React.ReactElement) => act(() => root.render(next)),
    unmount: () => act(() => root.unmount()),
  };
}

describe('AnimatedLogo', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
    // happy-dom does not measure SVG paths
    proto.getTotalLength = () => 50;
    proto.getPointAtLength = (l: number) => ({ x: l / 2, y: 20 });
  });

  afterEach(() => {
    for (const { root, container } of roots) {
      try { act(() => root.unmount()); } catch { /* already unmounted */ }
      container.remove();
    }
    roots = [];
    vi.useRealTimers();
    Object.assign(proto, original);
  });

  const wave = (c: HTMLElement) => c.querySelectorAll('path')[1] as SVGPathElement;
  const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

  it('draws the same wave and star as the tab icon (app/favicon.svg)', () => {
    expect(faviconSvg.replace(/\s+/g, ' ')).toContain(`d="${LOGO_WAVE}"`);
    expect(faviconSvg.replace(/\s+/g, ' ')).toContain(`d="${LOGO_STAR}"`);
  });

  it('draws itself once when it appears, then stays still', () => {
    const { container } = render(<AnimatedLogo size={40} />);
    expect(wave(container).style.strokeDashoffset).toBe('50'); // hidden, about to be drawn
    advance(600);
    const mid = Number(wave(container).style.strokeDashoffset);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(50);
    advance(2000);
    expect(wave(container).style.strokeDashoffset).toBe('0');
    advance(3000);
    expect(wave(container).style.strokeDashoffset).toBe('0'); // no second pass
  });

  it('plays again on hover when asked to', () => {
    const { container } = render(<AnimatedLogo size={40} replayOnHover />);
    advance(2600);
    act(() => { container.querySelector('svg')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body })); });
    advance(300);
    expect(Number(wave(container).style.strokeDashoffset)).toBeGreaterThan(0);
  });

  it('loops while `loop` is true and finishes its pass when it turns false', () => {
    const { container, rerender } = render(<AnimatedLogo size={40} loop />);
    advance(3000 + 300); // one pass, the pause, and into the second pass
    expect(Number(wave(container).style.strokeDashoffset)).toBeGreaterThan(0);
    rerender(<AnimatedLogo size={40} loop={false} />);
    advance(3000);
    expect(wave(container).style.strokeDashoffset).toBe('0');
    advance(3000);
    expect(wave(container).style.strokeDashoffset).toBe('0');
  });

  it('adds sparks only when it is large enough to see them', () => {
    const small = render(<AnimatedLogo size={40} />);
    advance(1100);
    expect(small.container.querySelectorAll('circle').length).toBe(2); // the trail's head only
    small.unmount();
    const large = render(<AnimatedLogo size={64} />);
    advance(1100);
    expect(large.container.querySelectorAll('circle').length).toBeGreaterThan(2);
  });

  it('stays still when the system asks for less motion', () => {
    const matchMedia = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: q.includes('reduce') })) as any;
    try {
      const { container } = render(<AnimatedLogo size={40} loop />);
      advance(500);
      expect(wave(container).style.strokeDashoffset).toBe('');
    } finally {
      window.matchMedia = matchMedia;
    }
  });
});
