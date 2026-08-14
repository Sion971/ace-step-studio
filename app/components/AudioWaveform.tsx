import React, { useEffect, useRef, useState, useCallback } from 'react';

interface AudioWaveformProps {
  url: string;
  currentTime: number;
  duration: number;
  activeColor?: string;
  inactiveColor?: string;
  height?: number;
  onClick?: (percent: number) => void;
  // Region selection (repaint mode)
  regionStart?: number;  // seconds
  regionEnd?: number;    // seconds (-1 = end)
  onRegionChange?: (start: number, end: number) => void;
  regionColor?: string;
}

export const AudioWaveform: React.FC<AudioWaveformProps> = ({
  url,
  currentTime,
  duration,
  activeColor = '#ec4899',
  inactiveColor = 'rgba(255,255,255,0.1)',
  height = 32,
  onClick,
  regionStart,
  regionEnd,
  onRegionChange,
  regionColor = 'rgba(168,85,247,0.25)',
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [waveData, setWaveData] = useState<number[]>([]);
  const [dragging, setDragging] = useState<'start' | 'end' | 'create' | null>(null);
  const dragStartX = useRef(0);

  // Decode audio and extract waveform
  useEffect(() => {
    if (!url) return;
    let cancelled = false;

    const decode = async () => {
      try {
        const res = await fetch(url);
        const buf = await res.arrayBuffer();
        const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
        const audio = await ctx.decodeAudioData(buf);
        ctx.close();
        if (cancelled) return;

        const raw = audio.getChannelData(0);
        const barCount = 80;
        const samplesPerBar = Math.floor(raw.length / barCount);
        const bars: number[] = [];

        for (let i = 0; i < barCount; i++) {
          const start = i * samplesPerBar;
          const end = Math.min(start + samplesPerBar, raw.length);
          let sum = 0;
          for (let j = start; j < end; j++) sum += raw[j] * raw[j];
          bars.push(Math.sqrt(sum / (end - start)));
        }

        const max = Math.max(...bars, 0.01);
        setWaveData(bars.map(b => Math.max(b / max, 0.05)));
      } catch {
        // Silently fail
      }
    };

    decode();
    return () => { cancelled = true; };
  }, [url]);

  // Draw
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || waveData.length === 0) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;

    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const gap = 1;
    const barW = (w - gap * (waveData.length - 1)) / waveData.length;
    const progress = duration > 0 ? currentTime / duration : 0;

    // Region bounds
    const hasRegion = onRegionChange && regionStart !== undefined && duration > 0;
    const rStart = hasRegion ? (regionStart! / duration) : 0;
    const rEnd = hasRegion ? ((regionEnd === undefined || regionEnd < 0) ? 1 : regionEnd / duration) : 0;

    // Draw region background
    if (hasRegion) {
      ctx.fillStyle = regionColor;
      ctx.fillRect(rStart * w, 0, (rEnd - rStart) * w, h);
    }

    // Draw bars
    waveData.forEach((amp, i) => {
      const barH = Math.max(amp * h * 0.9, 2);
      const x = i * (barW + gap);
      const y = (h - barH) / 2;
      const barPos = (i + 0.5) / waveData.length;
      const played = barPos <= progress;
      const inRegion = hasRegion && barPos >= rStart && barPos <= rEnd;

      ctx.fillStyle = inRegion ? '#a855f7' : (played ? activeColor : inactiveColor);
      ctx.beginPath();
      ctx.roundRect(x, y, barW, barH, 1);
      ctx.fill();
    });

    // Draw region handles
    if (hasRegion) {
      [rStart, rEnd].forEach((pos, idx) => {
        const x = pos * w;
        ctx.fillStyle = '#a855f7';
        ctx.fillRect(x - 1.5, 0, 3, h);
        // Handle grip
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(x, h / 2, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#a855f7';
        ctx.beginPath();
        ctx.arc(x, h / 2, 2.5, 0, Math.PI * 2);
        ctx.fill();
      });
    }
  }, [waveData, currentTime, duration, activeColor, inactiveColor, regionStart, regionEnd, regionColor, onRegionChange]);

  const pctToTime = useCallback((pct: number) => {
    return Math.max(0, Math.min(duration, pct * duration));
  }, [duration]);

  const getPercent = useCallback((e: React.MouseEvent | MouseEvent) => {
    if (!containerRef.current) return 0;
    const rect = containerRef.current.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (!onRegionChange || !containerRef.current || duration <= 0) {
      // No region mode — just seek
      if (onClick) {
        const pct = getPercent(e);
        onClick(pct);
      }
      return;
    }

    const pct = getPercent(e);
    const rS = (regionStart || 0) / duration;
    const rE = (regionEnd === undefined || regionEnd < 0) ? 1 : regionEnd / duration;

    // Check if near handles (within 3%)
    if (Math.abs(pct - rS) < 0.03) {
      setDragging('start');
    } else if (Math.abs(pct - rE) < 0.03) {
      setDragging('end');
    } else {
      // Create new region by dragging
      setDragging('create');
      dragStartX.current = pct;
      onRegionChange(pctToTime(pct), -1);
    }

    e.preventDefault();
  }, [onRegionChange, onClick, regionStart, regionEnd, duration, getPercent, pctToTime]);

  useEffect(() => {
    if (!dragging) return;

    const handleMove = (e: MouseEvent) => {
      const pct = getPercent(e);
      if (!onRegionChange) return;

      if (dragging === 'start') {
        const end = (regionEnd === undefined || regionEnd < 0) ? duration : regionEnd;
        onRegionChange(pctToTime(Math.min(pct, end / duration - 0.01)), end);
      } else if (dragging === 'end') {
        const start = regionStart || 0;
        onRegionChange(start, pctToTime(Math.max(pct, start / duration + 0.01)));
      } else if (dragging === 'create') {
        const s = Math.min(dragStartX.current, pct);
        const e2 = Math.max(dragStartX.current, pct);
        onRegionChange(pctToTime(s), pctToTime(e2));
      }
    };

    const handleUp = () => setDragging(null);

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [dragging, onRegionChange, regionStart, regionEnd, duration, getPercent, pctToTime]);

  if (waveData.length === 0) return null;

  return (
    <div
      ref={containerRef}
      className="w-full cursor-pointer select-none"
      style={{ height }}
      onMouseDown={handleMouseDown}
    >
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '100%', display: 'block' }}
      />
    </div>
  );
};
