import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Mic, Square, Play, Pause, RotateCcw, Loader2, X } from 'lucide-react';

interface VoiceRecorderProps {
  token: string | null;
  onSongCreated: (song: unknown) => void;
  t: (key: string) => string;
  tf: (key: string, fallback: string) => string;
}

type RecorderStep = 'idle' | 'recording' | 'preview' | 'describing' | 'saving';

/**
 * Bouton "Enregistrer" independant du bloc AUDIO (qui ne sert qu'a fournir
 * de l'audio en ENTREE d'une generation IA — Cover, Inspiration, etc.).
 * Celui-ci ne passe jamais par la generation : enregistrement au micro,
 * apercu, titre/description, puis sauvegarde directe comme vraie chanson.
 *
 * Reutilise l'infrastructure de stockage existante (meme fournisseur que
 * reference-tracks/generation), mais via /api/songs/upload-audio — une
 * route dediee, sans creer de ligne dans reference_tracks. Premiere
 * version reutilisait POST /api/reference-tracks directement (meme route
 * que uploadReferenceTrack dans CreatePanel) ; chaque piste de reference
 * s'affiche independamment dans SongList (fonctionnalite volontaire, pour
 * reutiliser un audio televerse dans une future generation), ce qui
 * faisait apparaitre l'enregistrement en double, sous son nom de fichier
 * interne, attribue a "Unknown". Supprimer l'entree apres coup n'etait
 * pas une option non plus : la suppression d'une reference-track efface
 * aussi le fichier en stockage, cassant la lecture de la vraie chanson
 * qui pointe vers ce meme fichier. D'ou cette route dediee cote serveur.
 * Puis POST /api/songs pour l'enregistrer comme chanson. Ne l'ajoute a
 * aucun espace de travail — la vue par defaut ("Mon espace de travail")
 * l'inclut automatiquement par exclusion, sans etape supplementaire.
 *
 * Composant entierement autonome (etat, logique MediaRecorder, requetes)
 * pour eviter de faire grossir CreatePanel — seul le bouton et le prop
 * onSongCreated s'y integrent.
 */
export const VoiceRecorder: React.FC<VoiceRecorderProps> = ({ token, onSongCreated, t, tf }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [step, setStep] = useState<RecorderStep>('idle');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [isPlayingPreview, setIsPlayingPreview] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordedBlobRef = useRef<Blob | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const revokePreviewUrl = useCallback(() => {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
  }, []);

  // Nettoyage complet a la fermeture de la fenetre — micro relache, minuteur
  // arrete, URL d'apercu revoquee. Sans ca, le micro resterait actif meme
  // apres avoir ferme la fenetre sans enregistrer.
  const resetAll = useCallback(() => {
    stopStream();
    clearTimer();
    revokePreviewUrl();
    mediaRecorderRef.current = null;
    chunksRef.current = [];
    recordedBlobRef.current = null;
    setStep('idle');
    setElapsedSeconds(0);
    setIsPlayingPreview(false);
    setTitle('');
    setDescription('');
    setError(null);
  }, [stopStream, clearTimer, revokePreviewUrl]);

  useEffect(() => resetAll, [resetAll]);

  const startRecording = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : '';
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        recordedBlobRef.current = blob;
        revokePreviewUrl();
        previewUrlRef.current = URL.createObjectURL(blob);
        setStep('preview');
        stopStream();
        clearTimer();
      };

      mediaRecorderRef.current = recorder;
      recorder.start();
      setStep('recording');
      setElapsedSeconds(0);
      timerRef.current = setInterval(() => setElapsedSeconds((s) => s + 1), 1000);
    } catch (err) {
      setError(
        err instanceof DOMException && err.name === 'NotAllowedError'
          ? tf('micPermissionDenied', "Acces au microphone refuse — autorise-le dans les reglages du navigateur.")
          : tf('micUnavailable', "Impossible d'acceder au microphone.")
      );
    }
  }, [stopStream, clearTimer, revokePreviewUrl, tf]);

  const stopRecording = useCallback(() => {
    mediaRecorderRef.current?.stop();
  }, []);

  const reRecord = useCallback(() => {
    revokePreviewUrl();
    recordedBlobRef.current = null;
    setIsPlayingPreview(false);
    void startRecording();
  }, [revokePreviewUrl, startRecording]);

  const togglePreviewPlayback = useCallback(() => {
    if (!previewAudioRef.current) return;
    if (isPlayingPreview) {
      previewAudioRef.current.pause();
    } else {
      void previewAudioRef.current.play();
    }
  }, [isPlayingPreview]);

  const handleSave = useCallback(async () => {
    if (!token || !recordedBlobRef.current || !title.trim()) return;
    setStep('saving');
    setError(null);
    try {
      const blob = recordedBlobRef.current;
      const ext = blob.type.includes('webm') ? 'webm' : 'wav';
      const formData = new FormData();
      formData.append('audio', blob, `recording-${Date.now()}.${ext}`);

      const uploadRes = await fetch('/api/songs/upload-audio', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      if (!uploadRes.ok) {
        const err = await uploadRes.json().catch(() => ({}));
        throw new Error(err.error || tf('recordingUploadFailed', "Echec de l'envoi de l'enregistrement."));
      }
      const uploadData = await uploadRes.json();
      const audioUrl = uploadData.audioUrl;
      if (!audioUrl) throw new Error(tf('recordingUploadFailed', "Echec de l'envoi de l'enregistrement."));

      const songRes = await fetch('/api/songs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          title: title.trim(),
          caption: description.trim() || undefined,
          audioUrl,
          duration: elapsedSeconds,
        }),
      });
      if (!songRes.ok) {
        const err = await songRes.json().catch(() => ({}));
        throw new Error(err.error || tf('recordingSaveFailed', "Echec de la sauvegarde de la chanson."));
      }
      const songData = await songRes.json();
      onSongCreated(songData.song);
      resetAll();
      setIsOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : tf('recordingSaveFailed', "Echec de la sauvegarde de la chanson."));
      setStep('preview');
    }
  }, [token, title, description, elapsedSeconds, onSongCreated, resetAll, tf]);

  const formatTime = (totalSeconds: number) => {
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const closeModal = () => {
    resetAll();
    setIsOpen(false);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl border border-zinc-200 dark:border-white/5 bg-white dark:bg-suno-card text-sm font-medium text-zinc-700 dark:text-zinc-200 hover:border-pink-500/40 hover:text-pink-500 transition-colors"
      >
        <Mic size={16} />
        {tf('recordSong', 'Enregistrer')}
      </button>

      {isOpen && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={closeModal} />
          <div className="relative w-[92%] max-w-lg rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-white/10 shadow-2xl overflow-hidden">
            <div className="p-5 pb-4">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-xl font-semibold text-zinc-900 dark:text-white">
                    {tf('recordSongTitle', 'Enregistrer une chanson')}
                  </h3>
                  <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
                    {tf('recordSongDescription', "Enregistre directement au micro, sans passer par la generation IA.")}
                  </p>
                </div>
                <button
                  onClick={closeModal}
                  className="p-1.5 rounded-lg hover:bg-zinc-100 dark:hover:bg-white/10 text-zinc-400 hover:text-zinc-900 dark:hover:text-white transition-colors"
                >
                  <X size={20} />
                </button>
              </div>

              <div className="mt-6 flex flex-col items-center">
                {step === 'idle' && (
                  <button
                    type="button"
                    onClick={() => void startRecording()}
                    className="flex items-center justify-center w-20 h-20 rounded-full bg-pink-500 hover:bg-pink-600 text-white transition-colors shadow-lg"
                  >
                    <Mic size={28} />
                  </button>
                )}

                {step === 'recording' && (
                  <>
                    <button
                      type="button"
                      onClick={stopRecording}
                      className="flex items-center justify-center w-20 h-20 rounded-full bg-red-500 hover:bg-red-600 text-white transition-colors shadow-lg animate-pulse"
                    >
                      <Square size={24} fill="currentColor" />
                    </button>
                    <p className="mt-3 text-lg font-mono text-zinc-900 dark:text-white">{formatTime(elapsedSeconds)}</p>
                    <p className="text-xs text-zinc-400 mt-1">{tf('recordingInProgress', 'Enregistrement en cours...')}</p>
                  </>
                )}

                {(step === 'preview' || step === 'describing' || step === 'saving') && previewUrlRef.current && (
                  <div className="w-full">
                    <audio
                      ref={previewAudioRef}
                      src={previewUrlRef.current}
                      onPlay={() => setIsPlayingPreview(true)}
                      onPause={() => setIsPlayingPreview(false)}
                      onEnded={() => setIsPlayingPreview(false)}
                      className="hidden"
                    />
                    <div className="flex items-center justify-center gap-3">
                      <button
                        type="button"
                        onClick={togglePreviewPlayback}
                        disabled={step === 'saving'}
                        className="flex items-center justify-center w-12 h-12 rounded-full bg-zinc-100 dark:bg-white/10 hover:bg-zinc-200 dark:hover:bg-white/20 text-zinc-700 dark:text-white transition-colors disabled:opacity-50"
                      >
                        {isPlayingPreview ? <Pause size={18} /> : <Play size={18} className="ml-0.5" />}
                      </button>
                      <span className="text-sm font-mono text-zinc-500 dark:text-zinc-400">{formatTime(elapsedSeconds)}</span>
                      <button
                        type="button"
                        onClick={reRecord}
                        disabled={step === 'saving'}
                        title={tf('recordAgain', 'Recommencer')}
                        className="flex items-center justify-center w-12 h-12 rounded-full bg-zinc-100 dark:bg-white/10 hover:bg-zinc-200 dark:hover:bg-white/20 text-zinc-700 dark:text-white transition-colors disabled:opacity-50"
                      >
                        <RotateCcw size={16} />
                      </button>
                    </div>

                    <div className="mt-5 space-y-3">
                      <input
                        type="text"
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        placeholder={tf('recordingTitlePlaceholder', 'Titre de la chanson')}
                        disabled={step === 'saving'}
                        className="w-full px-3 py-2 rounded-lg border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-white/5 text-sm text-zinc-900 dark:text-white placeholder-zinc-400 dark:placeholder-zinc-600 focus:outline-none focus:border-pink-500/50"
                      />
                      <textarea
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        placeholder={tf('recordingDescriptionPlaceholder', 'Description (optionnel)')}
                        disabled={step === 'saving'}
                        className="w-full h-20 px-3 py-2 rounded-lg border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-white/5 text-sm text-zinc-900 dark:text-white placeholder-zinc-400 dark:placeholder-zinc-600 focus:outline-none focus:border-pink-500/50 resize-none"
                      />
                    </div>
                  </div>
                )}

                {error && (
                  <p className="mt-3 text-xs text-red-500 text-center">{error}</p>
                )}
              </div>
            </div>

            {(step === 'preview' || step === 'describing' || step === 'saving') && (
              <div className="px-5 pb-5">
                <button
                  type="button"
                  onClick={() => void handleSave()}
                  disabled={!title.trim() || step === 'saving'}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-pink-500 hover:bg-pink-600 disabled:bg-zinc-300 dark:disabled:bg-white/10 disabled:cursor-not-allowed text-white font-medium transition-colors"
                >
                  {step === 'saving' ? (
                    <>
                      <Loader2 size={16} className="animate-spin" />
                      {tf('saving', 'Enregistrement...')}
                    </>
                  ) : (
                    tf('saveRecording', 'Sauvegarder')
                  )}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
};
