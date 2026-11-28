import React, { useEffect, useId, useLayoutEffect, useRef } from 'react';

/**
 * The Studio logo (same drawing as app/favicon.svg), animated: a bright trail draws the wave, then the star lights up
 * with a flash, and sparks when the logo is large enough to see them. No zoom: only the trail, the star and the sparks
 * move.
 *
 * - It plays once when it appears.
 * - `replayOnHover`: hovering the logo plays it again (unless it is already playing).
 * - `loop`: it plays again and again while true (a generation running, the engine starting); when it turns false the
 *   current pass ends and the logo stays still.
 * - With "reduce motion" asked by the system, the logo stays still.
 */
export const LOGO_WAVE = 'M5 20 L9 20 L11.5 13 L14.5 24 L17 9 L19.5 20 L21 20';
export const LOGO_STAR = 'M0 -4.2 L1.1 -1.1 L4.2 0 L1.1 1.1 L0 4.2 L-1.1 1.1 L-4.2 0 L-1.1 -1.1 Z';
const FLASH = 'M0 -9 L.5 -.5 L9 0 L.5 .5 L0 9 L-.5 .5 L-9 0 L-.5 -.5 Z';

const DRAW_S = 1.1; // the trail draws the wave
const STAR_S = 1.0; // the star starts lighting up just before the trail ends
const PASS_S = 2.2; // one pass, star and sparks included
const LOOP_REST_S = 0.8; // pause between two passes in a loop
const SPARKS_FROM_PX = 56; // smaller, the sparks are under a pixel

type Spark = { x: number; y: number; vx: number; vy: number; born: number };

const ease = (x: number) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  } catch {
    return false;
  }
}

interface AnimatedLogoProps {
  size: number;
  loop?: boolean;
  replayOnHover?: boolean;
  className?: string;
  title?: string;
}

export const AnimatedLogo: React.FC<AnimatedLogoProps> = ({ size, loop = false, replayOnHover = false, className, title }) => {
  const uid = useId().replace(/:/g, '');
  const line = useRef<SVGPathElement>(null);
  const glow = useRef<SVGPathElement>(null);
  const heads = useRef<SVGGElement>(null);
  const star = useRef<SVGPathElement>(null);
  const flash = useRef<SVGGElement>(null);
  const sparksLayer = useRef<SVGGElement>(null);
  const loopRef = useRef(loop);
  const running = useRef<number | null>(null);
  const play = useRef<() => void>(() => {});
  const withSparks = size >= SPARKS_FROM_PX;

  loopRef.current = loop;

  // Before the first paint: the wave hidden, ready to be drawn (or the still logo when motion is not wanted).
  useLayoutEffect(() => {
    const path = line.current;
    if (!path || typeof path.getTotalLength !== 'function' || prefersReducedMotion()) return;
    const length = path.getTotalLength();
    if (!(length > 0)) return;
    let sparks: Spark[] = [];
    let burst = false;
    let start = 0;

    const render = (t: number) => {
      const e = ease(Math.min(1, t / DRAW_S));
      for (const p of [line.current, glow.current]) {
        if (!p) continue;
        p.style.strokeDasharray = `${length}`;
        p.style.strokeDashoffset = `${length * (1 - e)}`;
      }
      glow.current?.setAttribute('opacity', `${t < DRAW_S ? 0.55 : Math.max(0, 0.55 - (t - DRAW_S) * 1.2)}`);
      const at = path.getPointAtLength(length * e);
      if (heads.current) {
        heads.current.setAttribute('transform', `translate(${at.x} ${at.y})`);
        heads.current.setAttribute('opacity', `${t < DRAW_S ? 1 : Math.max(0, 1 - (t - DRAW_S) * 4)}`);
      }
      const s = t - STAR_S;
      const scale = s <= 0 ? 0 : s < 0.25 ? 1.35 * (s / 0.25) : s < 0.5 ? 1.35 - 0.35 * ((s - 0.25) / 0.25) : 1;
      star.current?.setAttribute('transform', `scale(${scale}) rotate(${s > 0 ? Math.max(0, 45 - s * 180) : 45})`);
      if (flash.current) {
        const f = s > 0 && s < 0.7 ? (s < 0.15 ? s / 0.15 : 1 - (s - 0.15) / 0.55) * 0.9 : 0;
        flash.current.setAttribute('opacity', `${f}`);
        flash.current.setAttribute('transform', `scale(${s > 0 ? 0.6 + s * 0.8 : 0})`);
      }
      if (withSparks && sparksLayer.current) {
        if (t < DRAW_S && Math.random() < 0.6) {
          sparks.push({ x: at.x, y: at.y, vx: (Math.random() - 0.7) * 3, vy: (Math.random() - 0.5) * 3, born: t });
        }
        if (s > 0 && !burst) {
          burst = true;
          for (let i = 0; i < 10; i++) {
            const a = Math.random() * Math.PI * 2;
            const v = 2 + Math.random() * 4;
            sparks.push({ x: 24.5, y: 9, vx: Math.cos(a) * v, vy: Math.sin(a) * v, born: t });
          }
        }
        sparks = sparks.filter((k) => t - k.born < 0.9);
        sparksLayer.current.innerHTML = sparks
          .map((k) => {
            const d = t - k.born;
            return `<circle cx="${k.x + k.vx * d}" cy="${k.y + k.vy * d + d * d * 2}" r=".4" fill="#fff" opacity="${1 - d / 0.9}"/>`;
          })
          .join('');
      }
    };

    const frame = (now: number) => {
      const t = (now - start) / 1000;
      if (t < PASS_S) {
        render(t);
        running.current = requestAnimationFrame(frame);
      } else if (loopRef.current && t < PASS_S + LOOP_REST_S) {
        render(PASS_S);
        running.current = requestAnimationFrame(frame);
      } else if (loopRef.current) {
        start = now;
        sparks = [];
        burst = false;
        running.current = requestAnimationFrame(frame);
      } else {
        render(PASS_S);
        if (sparksLayer.current) sparksLayer.current.innerHTML = '';
        running.current = null;
      }
    };

    play.current = () => {
      if (running.current !== null) return;
      start = performance.now();
      sparks = [];
      burst = false;
      render(0);
      running.current = requestAnimationFrame(frame);
    };
    play.current();
    return () => {
      if (running.current !== null) cancelAnimationFrame(running.current);
      running.current = null;
      play.current = () => {};
    };
  }, [withSparks]);

  // A loop that starts while the logo is still: start a pass now.
  useEffect(() => {
    if (loop) play.current();
  }, [loop]);

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={className}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      data-testid="animated-logo"
      data-looping={loop ? 'true' : 'false'}
      onMouseEnter={replayOnHover ? () => play.current() : undefined}
    >
      <defs>
        <linearGradient id={`g${uid}`} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#ec4899" />
          <stop offset="100%" stopColor="#9333ea" />
        </linearGradient>
        <filter id={`b${uid}`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="0.9" />
        </filter>
        <clipPath id={`c${uid}`}>
          <rect width="32" height="32" rx="9" />
        </clipPath>
      </defs>
      <rect width="32" height="32" rx="9" fill={`url(#g${uid})`} />
      <g clipPath={`url(#c${uid})`}>
        <g ref={sparksLayer} />
        <path ref={glow} d={LOGO_WAVE} stroke="#fff" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" fill="none" filter={`url(#b${uid})`} opacity="0" />
        <path ref={line} d={LOGO_WAVE} stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        <g ref={heads} opacity="0">
          <circle r="1.6" fill="#fff" filter={`url(#b${uid})`} />
          <circle r="0.9" fill="#fff" />
        </g>
        <g transform="translate(24.5,9)">
          <g ref={flash} opacity="0">
            <path d={FLASH} fill="#fff" filter={`url(#b${uid})`} />
          </g>
          <path ref={star} d={LOGO_STAR} fill="#fff" />
        </g>
      </g>
    </svg>
  );
};
