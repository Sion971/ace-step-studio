/* ============================================================================
 * StemSeparationModal.tsx — separation de stems cote serveur (Demucs)
 *
 * Remplace l'ancien flux "ouvrir /demucs-web/ dans un nouvel onglet"
 * (navigateur/WASM, plafonne par la RAM du poste pour le mode 6 stems).
 * Appelle /api/demucs/separate (voir routes/demucs.ts), affiche la
 * progression, puis chaque stem avec lecture et telechargement individuel.
 * ==========================================================================*/

import React, { useState, useRef, useEffect } from 'react';
import { X, Layers, Download, Loader2, Play, Pause, Volume2, VolumeX, Edit3, Music } from 'lucide-react';
import { useI18n } from '../context/I18nContext';
import { AudioWaveform } from './AudioWaveform';
import { MidiPianoRoll } from './MidiPianoRoll';

interface StemSeparationModalProps {
  audioUrl: string;
  songTitle?: string;
  onClose: () => void;
}

interface SeparateResponse {
  success: boolean;
  model?: string;
  elapsedSeconds?: number;
  stems?: Record<string, string>;
  error?: string;
}

const STEM_LABELS: Record<string, string> = {
  drums: 'Batterie',
  bass: 'Basse',
  other: 'Autres',
  vocals: 'Voix',
  guitar: 'Guitare',
  piano: 'Piano',
};

export const StemSeparationModal: React.FC<StemSeparationModalProps> = ({
  audioUrl,
  songTitle,
  onClose,
}) => {
  const { t } = useI18n();
  const [stemCount, setStemCount] = useState<4 | 6>(4);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SeparateResponse | null>(null);
  // Lecture synchronisee : un seul etat de lecture pour TOUTES les
  // pistes (plus de lecture independante par piste) ; chaque piste a son
  // propre etat muet/son a la place. currentTime/duration suivent une
  // piste de reference (la premiere) — les autres sont systematiquement
  // alignees sur elle a chaque play/pause/deplacement, jamais laissees
  // deriver independamment.
  const [isPlaying, setIsPlaying] = useState(false);
  const [mutedStems, setMutedStems] = useState<Record<string, boolean>>({});
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [midiStemName, setMidiStemName] = useState<string | null>(null);
  const audioRefs = useRef<Record<string, HTMLAudioElement | null>>({});
  const stemOrder = useRef<string[]>([]);

  const handleSeparate = async () => {
    setIsLoading(true);
    setError(null);
    setResult(null);

    try {
      // L'audio vient d'une URL deja accessible (meme origine ou absolue),
      // pas d'un fichier local — on le recupere nous-memes pour le
      // reemballer en multipart/form-data, format attendu par la route.
      const audioBlob = await fetch(audioUrl).then((r) => r.blob());
      const formData = new FormData();
      formData.append('audio', audioBlob, 'input.audio');
      formData.append('stems', String(stemCount));

      const response = await fetch('/api/demucs/separate', {
        method: 'POST',
        body: formData,
      });
      const data: SeparateResponse = await response.json();

      if (!response.ok || !data.success) {
        setError(data.error || 'Echec de la separation.');
        return;
      }

      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur reseau.');
    } finally {
      setIsLoading(false);
    }
  };

  // Piste de reference pour la progression affichee — la premiere de la
  // liste, fixee une seule fois quand le resultat arrive (pas recalculee
  // a chaque rendu, pour ne jamais changer de reference en cours de
  // lecture).
  useEffect(() => {
    if (result?.stems) stemOrder.current = Object.keys(result.stems);
  }, [result]);

  useEffect(() => {
    const refStemName = stemOrder.current[0];
    const refEl = refStemName ? audioRefs.current[refStemName] : null;
    if (!refEl) return;

    const onTimeUpdate = () => setCurrentTime(refEl.currentTime);
    const onLoadedMetadata = () => setDuration(refEl.duration);
    const onEnded = () => setIsPlaying(false);

    refEl.addEventListener('timeupdate', onTimeUpdate);
    refEl.addEventListener('loadedmetadata', onLoadedMetadata);
    refEl.addEventListener('ended', onEnded);
    return () => {
      refEl.removeEventListener('timeupdate', onTimeUpdate);
      refEl.removeEventListener('loadedmetadata', onLoadedMetadata);
      refEl.removeEventListener('ended', onEnded);
    };
  }, [result]);

  const togglePlayAll = () => {
    const elements = Object.values(audioRefs.current).filter(Boolean) as HTMLAudioElement[];
    if (isPlaying) {
      elements.forEach((el) => el.pause());
      setIsPlaying(false);
    } else {
      // Realigne toutes les pistes sur la reference avant de demarrer —
      // evite qu'une piste restee en avance/retard d'une pause/reprise
      // precedente ne desynchronise l'ensemble.
      elements.forEach((el) => { el.currentTime = currentTime; });
      elements.forEach((el) => void el.play());
      setIsPlaying(true);
    }
  };

  const toggleMute = (stemName: string) => {
    setMutedStems((prev) => ({ ...prev, [stemName]: !prev[stemName] }));
  };

  const handleSeek = (newTime: number) => {
    Object.values(audioRefs.current).forEach((el) => {
      if (el) el.currentTime = newTime;
    });
    setCurrentTime(newTime);
  };

  const formatTime = (seconds: number): string => {
    if (!Number.isFinite(seconds)) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  // Applique l'etat muet au DOM a chaque changement — React ne pilote pas
  // la propriete "muted" d'un <audio> depuis un attribut passe une seule
  // fois au montage, elle doit etre reappliquee explicitement.
  useEffect(() => {
    Object.entries(audioRefs.current).forEach(([name, el]) => {
      if (el) el.muted = !!mutedStems[name];
    });
  }, [mutedStems]);

  const handleDownload = (stemName: string, url: string) => {
    const link = document.createElement('a');
    link.href = url;
    link.download = `${songTitle || 'stem'}-${stemName}.wav`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Ouvre toutes les pistes dans l'editeur AudioMass multipiste (page
  // SEPAREE, /editor), meme convention deja etablie par l'ancienne
  // version navigateur (voir demucs-web/app.js, "Open all in editor") :
  // listes separees par des virgules, chaque valeur encodee
  // individuellement. Contrairement a cette ancienne version, nos stems
  // ont deja une vraie URL serveur directe (/api/demucs/stems/...) —
  // pas besoin de les deposer d'abord via /api/audio-editor/stage, cette
  // etape n'etait necessaire que pour d'anciens buffers en memoire sans
  // fichier serveur reel.
  const handleOpenAllInEditor = () => {
    if (!result?.stems) return;
    const entries = Object.entries(result.stems);
    const audioUrls = entries.map(([, url]) => encodeURIComponent(url)).join(',');
    const audioNames = entries.map(([name]) => encodeURIComponent(STEM_LABELS[name] || name)).join(',');
    window.open(`/editor?audioUrls=${audioUrls}&audioNames=${audioNames}`, '_blank');
  };

  return (
    <>
    <div
      className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl border border-zinc-200 dark:border-white/10 w-full max-w-lg max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-100 dark:border-white/5">
          <div className="flex items-center gap-2">
            <Layers size={18} className="text-pink-500" />
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-white">
              {t('extractStems') || 'Extraire les stems'}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-zinc-400 hover:text-zinc-700 dark:hover:text-white rounded-lg hover:bg-zinc-100 dark:hover:bg-white/5 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {!result && (
            <>
              {/* Choix 4 ou 6 stems */}
              <div className="space-y-2">
                <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                  Nombre de pistes
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => setStemCount(4)}
                    disabled={isLoading}
                    className={`px-3 py-2.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                      stemCount === 4
                        ? 'bg-pink-500 text-white'
                        : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700'
                    }`}
                  >
                    4 pistes
                    <span className="block text-[10px] font-normal opacity-80 mt-0.5">
                      Separation generalement plus propre
                    </span>
                  </button>
                  <button
                    onClick={() => setStemCount(6)}
                    disabled={isLoading}
                    className={`px-3 py-2.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                      stemCount === 6
                        ? 'bg-pink-500 text-white'
                        : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700'
                    }`}
                  >
                    6 pistes
                    <span className="block text-[10px] font-normal opacity-80 mt-0.5">
                      + guitare et piano isoles
                    </span>
                  </button>
                </div>
              </div>

              <button
                onClick={handleSeparate}
                disabled={isLoading}
                className="w-full py-2.5 rounded-lg text-sm font-semibold bg-gradient-to-r from-pink-500 to-purple-600 text-white shadow-lg shadow-pink-500/20 hover:from-pink-600 hover:to-purple-700 transition-all disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {isLoading ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    Separation en cours... (peut prendre une minute)
                  </>
                ) : (
                  'Lancer la separation'
                )}
              </button>
            </>
          )}

          {error && (
            <div className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 px-3 py-2 rounded-lg">
              {error}
            </div>
          )}

          {result?.stems && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                  {Object.keys(result.stems).length} pistes separees en {result.elapsedSeconds}s
                </p>
                <button
                  onClick={handleOpenAllInEditor}
                  className="flex items-center gap-1.5 text-[11px] font-medium text-pink-600 dark:text-pink-400 hover:text-pink-700 dark:hover:text-pink-300 transition-colors"
                >
                  <Edit3 size={12} />
                  Ouvrir tout dans l'editeur
                </button>
              </div>

              {/* Lecture maitre + progression partagee */}
              <div className="flex items-center gap-3 px-1">
                <button
                  onClick={togglePlayAll}
                  className="w-10 h-10 flex-shrink-0 rounded-full bg-pink-500 text-white flex items-center justify-center hover:bg-pink-600 transition-colors shadow-lg shadow-pink-500/20"
                  title={isPlaying ? 'Pause' : 'Lecture de toutes les pistes'}
                >
                  {isPlaying ? <Pause size={18} /> : <Play size={18} className="ml-0.5" />}
                </button>
                <span className="text-[11px] text-zinc-500 dark:text-zinc-400 tabular-nums w-9 text-right">
                  {formatTime(currentTime)}
                </span>
                {/* Forme d'onde de la piste de reference (la meme qui pilote
                    currentTime/duration) — reutilise AudioWaveform tel quel,
                    deja utilise ailleurs dans le projet (decodage Web Audio,
                    clic pour se deplacer). */}
                <div className="flex-1">
                  <AudioWaveform
                    url={result.stems[stemOrder.current[0]]}
                    currentTime={currentTime}
                    duration={duration}
                    height={32}
                    onClick={(pct) => handleSeek(pct * duration)}
                  />
                </div>
                <span className="text-[11px] text-zinc-500 dark:text-zinc-400 tabular-nums w-9">
                  {formatTime(duration)}
                </span>
              </div>

              {Object.entries(result.stems).map(([stemName, url]) => {
                const isMuted = !!mutedStems[stemName];
                return (
                  <div
                    key={stemName}
                    className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-zinc-50 dark:bg-black/20 border border-zinc-100 dark:border-white/5"
                  >
                    <button
                      onClick={() => toggleMute(stemName)}
                      className={`w-8 h-8 flex-shrink-0 rounded-full flex items-center justify-center transition-colors ${
                        isMuted
                          ? 'bg-zinc-300 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-400'
                          : 'bg-pink-500 text-white hover:bg-pink-600'
                      }`}
                      title={isMuted ? 'Reactiver le son' : 'Couper le son'}
                    >
                      {isMuted ? <VolumeX size={14} /> : <Volume2 size={14} />}
                    </button>
                    <span className="flex-1 text-sm font-medium text-zinc-800 dark:text-zinc-200 capitalize">
                      {STEM_LABELS[stemName] || stemName}
                    </span>
                    <button
                      onClick={() => setMidiStemName(stemName)}
                      className="p-2 text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white rounded-lg hover:bg-zinc-200 dark:hover:bg-white/10 transition-colors"
                      title="Convertir en MIDI"
                    >
                      <Music size={15} />
                    </button>
                    <button
                      onClick={() => handleDownload(stemName, url)}
                      className="p-2 text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white rounded-lg hover:bg-zinc-200 dark:hover:bg-white/10 transition-colors"
                      title="Telecharger"
                    >
                      <Download size={15} />
                    </button>
                    <audio
                      ref={(el) => { audioRefs.current[stemName] = el; }}
                      src={url}
                      className="hidden"
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
    {midiStemName && result?.stems?.[midiStemName] && (
      <MidiPianoRoll
        audioUrl={result.stems[midiStemName]}
        stemName={STEM_LABELS[midiStemName] || midiStemName}
        onClose={() => setMidiStemName(null)}
      />
    )}
    </>
  );
};
