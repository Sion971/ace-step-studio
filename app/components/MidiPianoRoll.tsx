/* ============================================================================
 * MidiPianoRoll.tsx — visualiseur MIDI (piano roll) avec lecture audio
 *
 * Convertit un stem audio en MIDI via /api/midi/convert (basic-pitch,
 * deja existant cote serveur — voir routes/midi.ts), analyse le resultat
 * avec @tonejs/midi (parsing pur, pas de synthese), puis affiche un
 * piano roll (Canvas) et permet la lecture via un synthetiseur Tone.js
 * (Tone.PolySynth), le tout cote navigateur — rien n'est stocke
 * cote serveur au-dela de la conversion elle-meme.
 * ==========================================================================*/

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { X, Music, Loader2, Play, Pause, Download } from 'lucide-react';
import * as Tone from 'tone';
import { Midi } from '@tonejs/midi';
import { useI18n } from '../context/I18nContext';
import { fillTemplate } from '../utils/fillTemplate';

interface MidiPianoRollProps {
  audioUrl: string;
  stemName: string;
  onClose: () => void;
}

export const MidiPianoRoll: React.FC<MidiPianoRollProps> = ({
  audioUrl,
  stemName,
  onClose,
}) => {
  const { t } = useI18n();
  const [isConverting, setIsConverting] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [midi, setMidi] = useState<Midi | null>(null);
  const [midiBlob, setMidiBlob] = useState<Blob | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const synthRef = useRef<Tone.PolySynth | null>(null);
  const partRef = useRef<Tone.Part | null>(null);
  const rafRef = useRef<number | null>(null);

  // Plage de hauteurs reellement utilisee dans le morceau — affiche
  // seulement cette plage plutot que les 128 notes MIDI possibles,
  // pour une meilleure resolution verticale. Marge d'une octave de
  // chaque cote pour respirer visuellement.
  const [pitchRange, setPitchRange] = useState<[number, number]>([48, 72]);

  // --- Conversion audio -> MIDI, une seule fois a l'ouverture -----------
  useEffect(() => {
    let cancelled = false;

    const convert = async () => {
      try {
        const audioBlob = await fetch(audioUrl).then((r) => r.blob());
        const formData = new FormData();
        formData.append('audio', audioBlob, 'input.audio');

        const response = await fetch('/api/midi/convert', { method: 'POST', body: formData });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error || fillTemplate(t('midiFailed'), { status: response.status }));
        }

        const blob = await response.blob();
        if (cancelled) return;

        const arrayBuffer = await blob.arrayBuffer();
        const parsed = new Midi(arrayBuffer);

        const allNotes = parsed.tracks.flatMap((t) => t.notes);
        if (allNotes.length > 0) {
          const pitches = allNotes.map((n) => n.midi);
          setPitchRange([Math.max(0, Math.min(...pitches) - 12), Math.min(127, Math.max(...pitches) + 12)]);
        }

        setMidi(parsed);
        setMidiBlob(blob);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : t('midiConversionError'));
      } finally {
        if (!cancelled) setIsConverting(false);
      }
    };

    convert();
    return () => { cancelled = true; };
  }, [audioUrl]);

  // --- Dessin du piano roll -----------------------------------------------
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !midi) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const duration = midi.duration || 1;
    const [minPitch, maxPitch] = pitchRange;
    const pitchSpan = Math.max(1, maxPitch - minPitch);

    // Lignes de reperes horizontales (une par octave, sur les C)
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    for (let p = minPitch; p <= maxPitch; p++) {
      if (p % 12 === 0) {
        const y = h - ((p - minPitch) / pitchSpan) * h;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
    }

    // Notes
    const allNotes = midi.tracks.flatMap((t) => t.notes);
    allNotes.forEach((note) => {
      const x = (note.time / duration) * w;
      const noteW = Math.max((note.duration / duration) * w, 2);
      const y = h - ((note.midi - minPitch) / pitchSpan) * h;
      const noteH = Math.max(h / pitchSpan, 3);

      const playedAlready = note.time + note.duration <= currentTime;
      ctx.fillStyle = playedAlready ? 'rgba(236,72,153,0.4)' : '#ec4899';
      ctx.beginPath();
      ctx.roundRect(x, y - noteH, noteW, noteH, 1.5);
      ctx.fill();
    });

    // Tete de lecture
    if (duration > 0) {
      const playheadX = (currentTime / duration) * w;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(playheadX, 0);
      ctx.lineTo(playheadX, h);
      ctx.stroke();
    }
  }, [midi, pitchRange, currentTime]);

  useEffect(() => { draw(); }, [draw]);

  // --- Lecture (Tone.js) ---------------------------------------------------
  const stopPlayback = useCallback(() => {
    partRef.current?.stop();
    partRef.current?.dispose();
    partRef.current = null;
    Tone.Transport.stop();
    Tone.Transport.cancel();
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    setIsPlaying(false);
  }, []);

  const startPlayback = useCallback(async () => {
    if (!midi) return;
    // Tone.js exige un vrai geste utilisateur avant de demarrer son
    // AudioContext (politique des navigateurs) — ce bouton EST ce geste,
    // donc l'appel est sans risque ici.
    await Tone.start();

    if (!synthRef.current) {
      synthRef.current = new Tone.PolySynth(Tone.Synth).toDestination();
    }
    const synth = synthRef.current;

    const allNotes = midi.tracks.flatMap((t) => t.notes);
    const part = new Tone.Part((time, note: typeof allNotes[0]) => {
      synth.triggerAttackRelease(note.name, note.duration, time, note.velocity);
    }, allNotes.map((n) => [n.time, n])).start(0);
    part.loop = false;
    partRef.current = part;

    Tone.Transport.seconds = currentTime;
    Tone.Transport.start();
    setIsPlaying(true);

    const tick = () => {
      const t = Tone.Transport.seconds;
      setCurrentTime(t);
      if (midi.duration && t >= midi.duration) {
        stopPlayback();
        setCurrentTime(0);
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [midi, currentTime, stopPlayback]);

  const togglePlay = () => {
    if (isPlaying) stopPlayback();
    else void startPlayback();
  };

  const handleSeek = (e: React.MouseEvent) => {
    if (!containerRef.current || !midi?.duration) return;
    const rect = containerRef.current.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const newTime = pct * midi.duration;
    setCurrentTime(newTime);
    if (isPlaying) {
      stopPlayback();
      // Redemarre immediatement depuis la nouvelle position, plutot que
      // de laisser l'utilisateur relancer lui-meme la lecture — un clic
      // sur la barre pendant la lecture reste percu comme "se deplacer",
      // pas "s'arreter".
      setTimeout(() => void startPlayback(), 0);
    }
  };

  // Nettoyage a la fermeture — ne jamais laisser le synthetiseur ou le
  // Transport actifs une fois le modal ferme.
  useEffect(() => () => stopPlayback(), [stopPlayback]);

  const handleDownloadMidi = () => {
    if (!midiBlob) return;
    const url = URL.createObjectURL(midiBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${stemName}.mid`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const formatTime = (seconds: number): string => {
    if (!Number.isFinite(seconds)) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 z-[60] flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl border border-zinc-200 dark:border-white/10 w-full max-w-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-100 dark:border-white/5">
          <div className="flex items-center gap-2">
            <Music size={18} className="text-pink-500" />
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-white capitalize">
              MIDI — {stemName}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-zinc-400 hover:text-zinc-700 dark:hover:text-white rounded-lg hover:bg-zinc-100 dark:hover:bg-white/5 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        <div className="p-5 space-y-3">
          {isConverting && (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-zinc-500 dark:text-zinc-400">
              <Loader2 size={16} className="animate-spin" />
              {t('midiConverting')}
            </div>
          )}

          {error && (
            <div className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 px-3 py-2 rounded-lg">
              {error}
            </div>
          )}

          {midi && !isConverting && (
            <>
              <div
                ref={containerRef}
                onClick={handleSeek}
                className="cursor-pointer rounded-lg overflow-hidden bg-zinc-950"
                style={{ height: 220 }}
              >
                <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
              </div>

              <div className="flex items-center gap-3">
                <button
                  onClick={togglePlay}
                  className="w-10 h-10 flex-shrink-0 rounded-full bg-pink-500 text-white flex items-center justify-center hover:bg-pink-600 transition-colors shadow-lg shadow-pink-500/20"
                >
                  {isPlaying ? <Pause size={18} /> : <Play size={18} className="ml-0.5" />}
                </button>
                <span className="text-[11px] text-zinc-500 dark:text-zinc-400 tabular-nums">
                  {formatTime(currentTime)} / {formatTime(midi.duration)}
                </span>
                <div className="flex-1" />
                <button
                  onClick={handleDownloadMidi}
                  className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white transition-colors"
                >
                  <Download size={13} />
                  {t('midiDownload')}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
