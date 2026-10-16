/* ============================================================================
 * AbCompare.tsx — écoute « Avant / Après » d'un même morceau
 *
 * Un seul bouton lecture, un sélecteur à deux boutons (original / traité) et une
 * barre de position commune. Changer de côté pendant la lecture garde la position
 * et l'état (lecture ou pause) : on entend la différence à l'instant exact, sans
 * repartir du début. Les deux fichiers sont chargés ensemble et restent calés
 * sur la même position.
 * ==========================================================================*/

import React, { useEffect, useRef, useState } from 'react';
import { Play, Pause } from 'lucide-react';

export type AbSide = 'before' | 'after';

interface AbCompareProps {
  beforeUrl: string;
  afterUrl: string;
  beforeLabel: string;
  afterLabel: string;
  playLabel: string;
  pauseLabel: string;
  hint?: string;
}

const formatTime = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export const AbCompare: React.FC<AbCompareProps> = ({ beforeUrl, afterUrl, beforeLabel, afterLabel, playLabel, pauseLabel, hint }) => {
  const beforeRef = useRef<HTMLAudioElement>(null);
  const afterRef = useRef<HTMLAudioElement>(null);
  const [side, setSide] = useState<AbSide>('after');
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);

  const el = (which: AbSide) => (which === 'before' ? beforeRef.current : afterRef.current);

  // Pause the two files when the component goes away (the window closes while a side is playing).
  useEffect(() => () => { beforeRef.current?.pause(); afterRef.current?.pause(); }, []);

  const togglePlay = () => {
    const current = el(side);
    if (!current) return;
    if (current.paused) {
      void current.play();
      setPlaying(true);
    } else {
      current.pause();
      setPlaying(false);
    }
  };

  const choose = (next: AbSide) => {
    if (next === side) return;
    const from = el(side);
    const to = el(next);
    if (!from || !to) { setSide(next); return; }
    const wasPlaying = !from.paused;
    to.currentTime = from.currentTime; // same position on the other file
    from.pause();
    setSide(next);
    if (wasPlaying) void to.play();
  };

  const seek = (value: number) => {
    for (const which of ['before', 'after'] as AbSide[]) {
      const e = el(which);
      if (e) e.currentTime = value;
    }
    setTime(value);
  };

  const onLoaded = (which: AbSide) => {
    const d = el(which)?.duration;
    if (d && Number.isFinite(d)) setDuration((prev) => Math.max(prev, d));
  };

  const tab = (which: AbSide, label: string) => (
    <button
      type="button"
      data-ab={which}
      aria-pressed={side === which}
      onClick={() => choose(which)}
      className={`flex-1 py-2 text-xs font-semibold rounded-md transition-colors ${
        side === which
          ? 'bg-white dark:bg-zinc-700 text-zinc-900 dark:text-white shadow-sm'
          : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="rounded-xl border border-pink-500/60 bg-zinc-50 dark:bg-black/20 p-3 space-y-3">
      <div className="flex items-center gap-3">
        <button
          type="button"
          data-ab-play
          onClick={togglePlay}
          aria-label={playing ? pauseLabel : playLabel}
          className="w-11 h-11 flex-shrink-0 rounded-full bg-gradient-to-br from-pink-500 to-orange-500 text-white flex items-center justify-center shadow-lg shadow-pink-500/20 hover:brightness-110 transition"
        >
          {playing ? <Pause size={18} /> : <Play size={18} className="ml-0.5" />}
        </button>
        <div className="flex-1 flex p-1 rounded-lg bg-zinc-200/70 dark:bg-zinc-800 gap-1">
          {tab('before', beforeLabel)}
          {tab('after', afterLabel)}
        </div>
      </div>

      <div className="flex items-center gap-2 text-[11px] text-zinc-500 dark:text-zinc-400 tabular-nums">
        <span className="w-9 text-right">{formatTime(time)}</span>
        <input
          type="range"
          data-ab-seek
          min={0}
          max={duration || 1}
          step={0.1}
          value={Math.min(time, duration || 1)}
          onChange={(e) => seek(parseFloat(e.target.value))}
          className="flex-1 accent-pink-500"
        />
        <span className="w-9">{formatTime(duration)}</span>
      </div>

      {hint && <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{hint}</p>}

      <audio
        ref={beforeRef}
        src={beforeUrl}
        preload="auto"
        className="hidden"
        onLoadedMetadata={() => onLoaded('before')}
        onTimeUpdate={() => { if (side === 'before') setTime(beforeRef.current?.currentTime ?? 0); }}
        onEnded={() => { setPlaying(false); }}
      />
      <audio
        ref={afterRef}
        src={afterUrl}
        preload="auto"
        className="hidden"
        onLoadedMetadata={() => onLoaded('after')}
        onTimeUpdate={() => { if (side === 'after') setTime(afterRef.current?.currentTime ?? 0); }}
        onEnded={() => { setPlaying(false); }}
      />
    </div>
  );
};
