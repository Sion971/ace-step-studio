/* ============================================================================
 * StemSeparationModal.tsx — separation de stems cote serveur (Demucs)
 *
 * Remplace l'ancien flux "ouvrir /demucs-web/ dans un nouvel onglet"
 * (navigateur/WASM, plafonne par la RAM du poste pour le mode 6 stems).
 * Appelle /api/demucs/separate (voir routes/demucs.ts), affiche la
 * progression, puis chaque stem avec lecture et telechargement individuel.
 * ==========================================================================*/

import React, { useState, useRef } from 'react';
import { X, Layers, Download, Loader2, Play, Pause } from 'lucide-react';
import { useI18n } from '../context/I18nContext';

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
  const [playingStem, setPlayingStem] = useState<string | null>(null);
  const audioRefs = useRef<Record<string, HTMLAudioElement | null>>({});

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

  const togglePlay = (stemName: string) => {
    // Un seul stem joue a la fois — met en pause les autres avant de
    // demarrer celui demande, evite une cacophonie si l'utilisateur
    // clique sur plusieurs pistes a la suite.
    Object.entries(audioRefs.current).forEach(([name, el]) => {
      if (name !== stemName && el) el.pause();
    });

    const el = audioRefs.current[stemName];
    if (!el) return;

    if (playingStem === stemName) {
      el.pause();
      setPlayingStem(null);
    } else {
      void el.play();
      setPlayingStem(stemName);
    }
  };

  const handleDownload = (stemName: string, url: string) => {
    const link = document.createElement('a');
    link.href = url;
    link.download = `${songTitle || 'stem'}-${stemName}.wav`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
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
            <div className="space-y-2">
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                {Object.keys(result.stems).length} pistes separees en {result.elapsedSeconds}s
              </p>
              {Object.entries(result.stems).map(([stemName, url]) => (
                <div
                  key={stemName}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-zinc-50 dark:bg-black/20 border border-zinc-100 dark:border-white/5"
                >
                  <button
                    onClick={() => togglePlay(stemName)}
                    className="w-8 h-8 flex-shrink-0 rounded-full bg-pink-500 text-white flex items-center justify-center hover:bg-pink-600 transition-colors"
                  >
                    {playingStem === stemName ? <Pause size={14} /> : <Play size={14} className="ml-0.5" />}
                  </button>
                  <span className="flex-1 text-sm font-medium text-zinc-800 dark:text-zinc-200 capitalize">
                    {STEM_LABELS[stemName] || stemName}
                  </span>
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
                    onEnded={() => setPlayingStem(null)}
                    className="hidden"
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
