import React from 'react';
import { AudioWaveform } from './AudioWaveform';
import type { AudioModeDef } from './CreatePanel';

interface AudioPlayerPanelProps {
  activeAudioUrl: string;
  activeAudioMode: AudioModeDef;
  activeAudioTitle: string;
  activeAudioTime: number;
  activeAudioDuration: number;
  activeAudioPlaying: boolean;
  activeAudioElRef: React.RefObject<HTMLAudioElement>;
  isReferenceTarget: boolean;
  isRepaintMode: boolean;
  isDraggingFile: boolean;
  coverModeMissingSource: boolean;

  audioCoverStrength: number;
  onAudioCoverStrengthChange: (value: number) => void;
  coverNoiseStrength: number;
  onCoverNoiseStrengthChange: (value: number) => void;
  /** Lecture seule — determine juste le texte d'aide affiche sous
   *  Fidelite (different en Inspiration). La vraie source de verite reste
   *  isReferenceTarget dans CreatePanel. */
  audioTarget: 'reference' | 'source';

  repaintStrength: number;
  onRepaintStrengthChange: (value: number) => void;
  repaintingStart: number;
  onRepaintingStartChange: (value: number) => void;
  repaintingEnd: number;
  onRepaintingEndChange: (value: number) => void;

  onToggleAudio: () => void;
  onClearAudio: () => void;

  formatTime: (seconds: number) => string;
  getAudioLabel: (url: string) => string;
  t: (key: string) => string;
  tf: (key: string, fallback: string) => string;
}

/**
 * Corps du bloc AUDIO : lecteur (si un audio est charge) avec forme d'onde
 * et reglages contextuels au mode (Force/Fidelite hors Repaint, Strength/
 * Region en Repaint — voir TROUBLESHOOTING #23 sur pourquoi Force/Fidelite
 * ne doivent JAMAIS etre masquees sans etre aussi neutralisees dans la
 * charge utile, ce qui reste gere par CreatePanel), ou zone de depot vide
 * sinon. Voir AudioModeHeader pour l'en-tete (libelle + selecteur de mode).
 *
 * Composant presentationnel : tous les etats restent dans CreatePanel.
 */
export const AudioPlayerPanel: React.FC<AudioPlayerPanelProps> = ({
  activeAudioUrl,
  activeAudioMode,
  activeAudioTitle,
  activeAudioTime,
  activeAudioDuration,
  activeAudioPlaying,
  activeAudioElRef,
  isReferenceTarget,
  isRepaintMode,
  isDraggingFile,
  coverModeMissingSource,
  audioCoverStrength,
  onAudioCoverStrengthChange,
  coverNoiseStrength,
  onCoverNoiseStrengthChange,
  audioTarget,
  repaintStrength,
  onRepaintStrengthChange,
  repaintingStart,
  onRepaintingStartChange,
  repaintingEnd,
  onRepaintingEndChange,
  onToggleAudio,
  onClearAudio,
  formatTime,
  getAudioLabel,
  t,
  tf,
}) => {
  return (
    <>
      {activeAudioUrl ? (
        <div className="p-2 space-y-2">
          <div className="flex items-center gap-3 p-2 rounded-lg bg-zinc-50 dark:bg-white/[0.03] border border-zinc-100 dark:border-white/5">
            <button
              type="button"
              onClick={onToggleAudio}
              className={`relative flex-shrink-0 w-10 h-10 rounded-full text-white flex items-center justify-center shadow-lg hover:scale-105 transition-transform ${
                isReferenceTarget
                  ? 'bg-gradient-to-br from-pink-500 to-purple-600 shadow-pink-500/20'
                  : 'bg-gradient-to-br from-emerald-500 to-teal-600 shadow-emerald-500/20'
              }`}
            >
              {activeAudioPlaying
                ? <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z"/></svg>
                : <svg className="w-4 h-4 ml-0.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>}
              <span className="absolute -bottom-1 -right-1 text-[8px] font-bold bg-zinc-900 text-white px-1 py-0.5 rounded">
                {formatTime(activeAudioDuration)}
              </span>
            </button>

            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between mb-1">
                <div className="text-xs font-medium text-zinc-800 dark:text-zinc-200 truncate">
                  {activeAudioTitle || getAudioLabel(activeAudioUrl)}
                </div>
                <span className="text-[10px] text-zinc-400 tabular-nums ml-2 flex-shrink-0">
                  {formatTime(activeAudioTime)} / {formatTime(activeAudioDuration)}
                </span>
              </div>
              <AudioWaveform
                url={activeAudioUrl}
                currentTime={activeAudioTime}
                duration={activeAudioDuration}
                activeColor={isReferenceTarget ? '#ec4899' : '#10b981'}
                inactiveColor="rgba(255,255,255,0.08)"
                height={isRepaintMode ? 48 : 28}
                onClick={!isRepaintMode ? ((pct) => { if (activeAudioElRef.current && activeAudioDuration > 0) activeAudioElRef.current.currentTime = pct * activeAudioDuration; }) : undefined}
                regionStart={isRepaintMode ? repaintingStart : undefined}
                regionEnd={isRepaintMode ? repaintingEnd : undefined}
                onRegionChange={isRepaintMode ? ((s, e) => { onRepaintingStartChange(Math.round(s * 10) / 10); onRepaintingEndChange(e < 0 ? -1 : Math.round(e * 10) / 10); }) : undefined}
              />
            </div>

            <button
              type="button"
              onClick={onClearAudio}
              className="p-1.5 rounded-full hover:bg-zinc-200 dark:hover:bg-white/10 text-zinc-400 hover:text-zinc-600 dark:hover:text-white transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
            </button>
          </div>

          {/* Reglages contextuels au mode */}
          <div className="space-y-2">
            {/* Ces deux parametres partent dans la charge utile hors
                Repaint uniquement (voir le payload dans CreatePanel) — les
                masquer ici sans les neutraliser recreerait le bug
                documente en TROUBLESHOOTING #23. Non documentes pour
                Repaint, qui a son propre controle "Strength" plus bas. */}
            {!isRepaintMode && (<>
            <div className="space-y-0.5">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-medium text-zinc-500 dark:text-zinc-400 w-14">{tf('audioCoverStrength', 'Reprise')}</span>
                <input type="range" min="0" max="1" step="0.01" value={audioCoverStrength} onChange={(e) => onAudioCoverStrengthChange(Number(e.target.value))} className="flex-1 h-1 accent-pink-500 cursor-pointer" />
                <span className="text-[10px] text-zinc-500 tabular-nums w-8 text-right">{Math.round(audioCoverStrength * 100)}%</span>
              </div>
              <p className="text-[9px] text-zinc-400 dark:text-zinc-500 pl-16">{tf('hintAudioCoverStrength', 'Influence marginale entre 0 et 75 % : la fidelite harmonique et le grain montent tres legerement avec la valeur.')}</p>
            </div>

            <div className="space-y-0.5">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-medium text-zinc-500 dark:text-zinc-400 w-14">{tf('coverNoiseStrength', 'Fidelite')}</span>
                <input type="range" min="0" max="1" step="0.01" value={coverNoiseStrength} onChange={(e) => onCoverNoiseStrengthChange(Number(e.target.value))} className="flex-1 h-1 accent-amber-500 cursor-pointer" />
                <span className={`text-[10px] tabular-nums w-8 text-right ${audioTarget === 'reference' && coverNoiseStrength > 0 ? 'text-red-500 font-medium' : 'text-zinc-500'}`}>{Math.round(coverNoiseStrength * 100)}%</span>
              </div>
              <p className="text-[9px] text-zinc-400 dark:text-zinc-500 pl-16">
                {audioTarget === 'reference'
                  ? tf('hintCoverNoiseRef', 'En mode Inspiration, toute valeur > 0 dégrade fortement le rendu. Laisser à 0.')
                  : tf('hintCoverNoiseStrength', 'Plus haut = plus proche de la source. Au-delà de ~40 %, quasi-copie.')}
              </p>
            </div>
            </>)}

            {isRepaintMode && (<>
              <div className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-medium text-zinc-500 dark:text-zinc-400 w-10">{tf('strength', 'Strength')}</span>
                  <input type="range" min="0" max="1" step="0.05" value={repaintStrength} onChange={(e) => onRepaintStrengthChange(Number(e.target.value))} className="flex-1 h-1 accent-purple-500 cursor-pointer" />
                  <span className="text-[10px] text-zinc-500 tabular-nums w-8 text-right">{Math.round(repaintStrength * 100)}%</span>
                </div>
                <p className="text-[9px] text-zinc-400 dark:text-zinc-500 pl-12">{tf('hintRepaintStrength', '0% — fully regenerate the region, 100% — leave it almost unchanged')}</p>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-medium text-zinc-500 dark:text-zinc-400 w-10">{tf('region', 'Region')}</span>
                <div className="flex items-center gap-1 flex-1">
                  <input type="number" step="0.1" min="0" placeholder="0s" value={repaintingStart || ''} onChange={(e) => onRepaintingStartChange(Number(e.target.value))} className="w-16 bg-zinc-100 dark:bg-black/30 border border-zinc-200 dark:border-white/10 rounded px-1.5 py-0.5 text-[10px] text-zinc-900 dark:text-white text-center focus:outline-none focus:border-purple-500" />
                  <span className="text-[10px] text-zinc-400">—</span>
                  <input type="number" step="0.1" min="-1" placeholder={tf('end', 'end')} value={repaintingEnd === -1 ? '' : repaintingEnd} onChange={(e) => onRepaintingEndChange(e.target.value === '' ? -1 : Number(e.target.value))} className="w-16 bg-zinc-100 dark:bg-black/30 border border-zinc-200 dark:border-white/10 rounded px-1.5 py-0.5 text-[10px] text-zinc-900 dark:text-white text-center focus:outline-none focus:border-purple-500" />
                  <span className="text-[10px] text-zinc-400">{tf('seconds', 'sec')}</span>
                </div>
              </div>
            </>)}
          </div>
        </div>
      ) : (
        <div className={`px-3 text-center text-[10px] text-zinc-400 transition-all ${isDraggingFile ? 'py-8 text-zinc-300 border-2 border-dashed border-zinc-600 rounded-lg mx-2 mb-2' : 'py-3'}`}>
          {isDraggingFile
            ? '↓ ' + activeAudioMode.label
            : (tf('dropAudioHere', 'Depose un audio ou utilise les boutons ci-dessus'))}
        </div>
      )}
      {coverModeMissingSource && !isDraggingFile && (
        <p className="px-3 pb-2 text-[10px] text-amber-500 text-center">
          {tf('warnCoverNoSource', 'Sans audio chargé, Cover génère du texte-à-musique — dépose un fichier pour un vrai cover.')}
        </p>
      )}
    </>
  );
};
