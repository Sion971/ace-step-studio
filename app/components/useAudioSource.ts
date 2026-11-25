// The audio field of the Create panel: the reference / source audio, the mode menu, the library window's data, uploads,
// drag and drop, and what a cover takes from its source. Taken out of CreatePanel.tsx as is; the panel keeps the
// generation settings and passes in what this needs from them.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Song } from '../types';
import { AUDIO_MODE_MAP, type AudioModeId } from './audioModes';
import type { LibraryTab, ReferenceTrack } from './AudioLibraryModal';
import { coverMetaFromSong, type CoverMeta } from './coverPrefill';
import { KEY_SIGNATURES, TIME_SIGNATURES } from './musicalOptions';

interface CoverFields { title: string; lyrics: string; bpm: number; keyScale: string; timeSignature: string; vocalLanguage: string; instrumental: boolean }

type Setter<T> = (value: T) => void;

/** The modes whose source is a copy made by the server first. */
export type ProcessKind = 'reverse' | 'speed' | 'crop';
// Reverse and Speed process the source as soon as it is loaded; Crop waits for the part to keep to be chosen.
const processKindOf = (mode: AudioModeId): 'reverse' | 'speed' | null => (mode === 'reverse' || mode === 'speed' ? mode : null);

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

/** The factors offered in Speed mode. */
export const SPEED_FACTORS = [0.75, 0.9, 1.1, 1.25, 1.5];

export interface PendingAudioSelection {
  target: 'reference' | 'source';
  url: string;
  title?: string;
  mode?: AudioModeId;
  meta?: CoverMeta;
}

export interface UseAudioSourceOptions {
  token: string | null;
  createdSongs: Song[];
  importedSongs: Song[];
  onReferenceTracksChanged?: () => void;
  /** A new import was made here (an upload, a reversed copy): the app files it in the workspace open, then lists it. */
  onImportCreated?: (trackId: string) => Promise<void> | void;
  pendingAudioSelection?: PendingAudioSelection | null;
  onAudioSelectionApplied?: () => void;
  setTaskType: Setter<string>;
  setAudioCoverStrength: Setter<number>;
  setCoverNoiseStrength: Setter<number>;
  /** Opens the analysis window for an audio just imported, when that option is on. */
  offerAnalysis: (url: string, title?: string) => void;
  analysisAuto: boolean;
  /** The word added to the title of a reversed audio: "Title (reversed)". */
  reversedSuffix: string;
  /** How a speed factor is written in a title, e.g. "×1,25". */
  speedLabel: (factor: number) => string;
  /** The fields a cover fills from its source (and gives back when the source is removed). */
  title: string;
  setTitle: Setter<string>;
  lyrics: string;
  setLyrics: (val: string | ((prev: string) => string)) => void;
  bpm: number;
  setBpm: Setter<number>;
  keyScale: string;
  setKeyScale: Setter<string>;
  timeSignature: string;
  setTimeSignature: Setter<string>;
  vocalLanguage: string;
  setVocalLanguage: Setter<string>;
  instrumental: boolean;
  setInstrumental: Setter<boolean>;
}

export function useAudioSource({
  token, createdSongs, importedSongs, onReferenceTracksChanged, onImportCreated, pendingAudioSelection, onAudioSelectionApplied,
  setTaskType, setAudioCoverStrength, setCoverNoiseStrength, offerAnalysis, analysisAuto, reversedSuffix, speedLabel,
  title, setTitle, lyrics, setLyrics, bpm, setBpm, keyScale, setKeyScale, timeSignature, setTimeSignature,
  vocalLanguage, setVocalLanguage, instrumental, setInstrumental,
}: UseAudioSourceOptions) {
  const [referenceAudioUrl, setReferenceAudioUrl] = useState('');
  const [sourceAudioUrl, setSourceAudioUrl] = useState('');
  const [referenceAudioTitle, setReferenceAudioTitle] = useState('');
  const [sourceAudioTitle, setSourceAudioTitle] = useState('');

  const [isUploadingReference, setIsUploadingReference] = useState(false);
  const [isUploadingSource, setIsUploadingSource] = useState(false);
  const [isTranscribingReference, setIsTranscribingReference] = useState(false);
  const transcribeAbortRef = useRef<AbortController | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [isDraggingFile, setIsDraggingFile] = useState(false);

  const referenceInputRef = useRef<HTMLInputElement>(null);
  const sourceInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const [showAudioModal, setShowAudioModal] = useState(false);

  const [audioModalTarget, setAudioModalTarget] = useState<'reference' | 'source'>('reference');
  // Emplacement audio unifie : le mode decide de la case du payload ET du taskType.
  const [audioMode, setAudioMode] = useState<AudioModeId>('inspiration');
  const [showAudioMenu, setShowAudioMenu] = useState(false);
  const audioMenuRef = useRef<HTMLDivElement>(null);
  // « Depuis la bibliotheque » + « Importer » occupaient trop de largeur a cote
  // du selecteur de mode. Regroupes dans un menu, comme le « + Audio » de Suno.
  const [showAudioAddMenu, setShowAudioAddMenu] = useState(false);
  const audioAddMenuRef = useRef<HTMLDivElement>(null);
  const referenceAudioRef = useRef<HTMLAudioElement>(null);
  const sourceAudioRef = useRef<HTMLAudioElement>(null);
  const [referencePlaying, setReferencePlaying] = useState(false);
  const [sourcePlaying, setSourcePlaying] = useState(false);
  const [referenceTime, setReferenceTime] = useState(0);
  const [sourceTime, setSourceTime] = useState(0);
  const [referenceDuration, setReferenceDuration] = useState(0);
  const [sourceDuration, setSourceDuration] = useState(0);
  // What a cover's source filled in, and the fields as they were before: see applyCoverMeta / undoCoverMeta.
  const coverUndoRef = useRef<{ before: CoverFields; after: CoverFields } | null>(null);

  // The library window (AudioLibraryModal.tsx): the imports it lists, and the tab it opens on.
  const [referenceTracks, setReferenceTracks] = useState<ReferenceTrack[]>([]);
  const [isLoadingTracks, setIsLoadingTracks] = useState(false);
  const [audioModalTab, setAudioModalTab] = useState<LibraryTab>('uploads');
  // "Reverse" and "Speed" modes: the server is making a processed copy of the source (which one, while it works); the
  // error of the last try. A source removed or replaced meanwhile makes the result stale (processRunRef): it is dropped.
  const [processingKind, setProcessingKind] = useState<ProcessKind | null>(null);
  const [processError, setProcessError] = useState<{ kind: ProcessKind; message: string } | null>(null);
  const processRunRef = useRef(0);
  // Speed mode: the factor (1.25 = a quarter faster) and whether the pitch is kept (else it follows, like a record
  // played faster). The original behind the copy loaded, so that another factor starts again from it.
  const [speedFactor, setSpeedFactor] = useState(1.25);
  const [speedKeepPitch, setSpeedKeepPitch] = useState(true);
  const speedOriginRef = useRef<{ url: string; title?: string; meta?: CoverMeta } | null>(null);
  // Crop mode: the source loaded is the cut copy (the part kept), not yet the whole song to choose it in.
  const [cropDone, setCropDone] = useState(false);

  const getAudioLabel = (url: string) => {
    try {
      const parsed = new URL(url);
      const name = decodeURIComponent(parsed.pathname.split('/').pop() || parsed.hostname);
      return name.replace(/\.[^/.]+$/, '') || name;
    } catch {
      const parts = url.split('/');
      const name = decodeURIComponent(parts[parts.length - 1] || url);
      return name.replace(/\.[^/.]+$/, '') || name;
    }
  };

  useEffect(() => {
    if (!pendingAudioSelection) return;
    applyAudioTargetUrl(
      pendingAudioSelection.target,
      pendingAudioSelection.url,
      pendingAudioSelection.title,
      pendingAudioSelection.mode,
      pendingAudioSelection.meta
    );
    onAudioSelectionApplied?.();
  }, [pendingAudioSelection, onAudioSelectionApplied]);

  useEffect(() => {
    const getDragKind = (e: DragEvent): 'file' | 'audio' | null => {
      if (!e.dataTransfer) return null;
      const types = Array.from(e.dataTransfer.types);
      if (types.includes('Files')) return 'file';
      if (types.includes('application/x-ace-audio')) return 'audio';
      return null;
    };

    const handleDragEnter = (e: DragEvent) => {
      const kind = getDragKind(e);
      if (!kind) return;
      dragDepthRef.current += 1;
      setIsDraggingFile(true);
      e.preventDefault();
    };

    const handleDragLeave = (e: DragEvent) => {
      const kind = getDragKind(e);
      if (!kind) return;
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) {
        setIsDraggingFile(false);
      }
    };

    const handleDrop = (e: DragEvent) => {
      const kind = getDragKind(e);
      if (!kind) return;
      e.preventDefault();
      dragDepthRef.current = 0;
      setIsDraggingFile(false);
    };

    window.addEventListener('dragenter', handleDragEnter);
    window.addEventListener('dragleave', handleDragLeave);
    window.addEventListener('drop', handleDrop);

    return () => {
      window.removeEventListener('dragenter', handleDragEnter);
      window.removeEventListener('dragleave', handleDragLeave);
      window.removeEventListener('drop', handleDrop);
    };
  }, []);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>, target: 'reference' | 'source') => {
    const file = e.target.files?.[0];
    if (file) {
      void uploadReferenceTrack(file, target);
    }
    e.target.value = '';
  };

  const openAudioModal = (target: 'reference' | 'source', tab: LibraryTab = 'uploads') => {
    setAudioModalTarget(target);
    setAudioModalTab(tab);
    setShowAudioModal(true);
    void fetchReferenceTracks();
  };

  const fetchReferenceTracks = useCallback(async () => {
    if (!token) return;
    setIsLoadingTracks(true);
    try {
      const response = await fetch('/api/reference-tracks', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (response.ok) {
        const data = await response.json();
        setReferenceTracks(data.tracks || []);
      }
    } catch (err) {
      console.error('Failed to fetch reference tracks:', err);
    } finally {
      setIsLoadingTracks(false);
    }
  }, [token]);

  const uploadReferenceTrack = async (file: File, target?: 'reference' | 'source') => {
    if (!token) {
      setUploadError('Please sign in to upload audio.');
      return;
    }
    // Resolve the target up front so the correct loading flag is used
    // throughout (previously this always flipped isUploadingReference,
    // even for source/cover uploads, leaving isUploadingSource dead).
    const selectedTarget = target ?? audioModalTarget;
    const setIsUploading = selectedTarget === 'source' ? setIsUploadingSource : setIsUploadingReference;
    setUploadError(null);
    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.append('audio', file);

      const response = await fetch('/api/reference-tracks', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Upload failed');
      }

      const data = await response.json();
      setReferenceTracks(prev => [data.track, ...prev]);
      announceNewImport(data.track.id);

      // Also set as current reference/source
      applyAudioTargetUrl(selectedTarget, data.track.audio_url, data.track.filename);
      offerAnalysis(data.track.audio_url, data.track.filename);
      // The analysis window transcribes the lyrics itself: doing it here too ran Whisper twice at once.
      if (data.whisper_available && data.track?.id && !(analysisAuto && token)) {
        void transcribeReferenceTrack(data.track.id).then(() => undefined);
      } else {
        setShowAudioModal(false);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Upload failed';
      setUploadError(message);
    } finally {
      setIsUploading(false);
    }
  };

  const transcribeReferenceTrack = async (trackId: string) => {
    if (!token) return;
    setIsTranscribingReference(true);
    const controller = new AbortController();
    transcribeAbortRef.current = controller;
    try {
      const response = await fetch(`/api/reference-tracks/${trackId}/transcribe`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error('Failed to transcribe');
      }
      const data = await response.json();
      if (data.lyrics) {
        setLyrics(prev => prev || data.lyrics);
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      console.error('Transcription failed:', err);
    } finally {
      if (transcribeAbortRef.current === controller) {
        transcribeAbortRef.current = null;
      }
      setIsTranscribingReference(false);
    }
  };

  const cancelTranscription = () => {
    if (transcribeAbortRef.current) {
      transcribeAbortRef.current.abort();
      transcribeAbortRef.current = null;
    }
    setIsTranscribingReference(false);
  };

  const deleteReferenceTrack = async (trackId: string) => {
    if (!token) return;
    try {
      const response = await fetch(`/api/reference-tracks/${trackId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (response.ok) {
        setReferenceTracks(prev => prev.filter(t => t.id !== trackId));
        onReferenceTracksChanged?.();
      }
    } catch (err) {
      console.error('Failed to delete track:', err);
    }
  };

  const useReferenceTrack = (track: { audio_url: string; title?: string }) => {
    applyAudioTargetUrl(audioModalTarget, track.audio_url, track.title);
    setShowAudioModal(false);
  };

  // An import played in the library window had no length recorded: keep it (database, then the lists).
  const recordTrackDuration = (trackId: string, seconds: number) => {
    if (!token) return;
    fetch(`/api/reference-tracks/${trackId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ duration: seconds })
    }).then(() => {
      setReferenceTracks(prev => prev.map(t => (t.id === trackId ? { ...t, duration: seconds } : t)));
      onReferenceTracksChanged?.();
    }).catch(() => undefined);
  };

  const clearReferenceSlot = () => {
    setReferenceAudioUrl('');
    setReferenceAudioTitle('');
    setReferencePlaying(false);
    setReferenceTime(0);
    setReferenceDuration(0);
  };

  const clearSourceSlot = () => {
    setSourceAudioUrl('');
    setSourceAudioTitle('');
    setSourcePlaying(false);
    setSourceTime(0);
    setSourceDuration(0);
  };

  // Emplacement UNIQUE : charger un audio vide systematiquement l'autre case.
  // Le pipeline n'arbitre que sur `taskType`, donc garder les deux remplies
  // rendait l'une des deux silencieusement inerte.
  const applyAudioTargetUrl = (target: 'reference' | 'source', url: string, title?: string, mode?: AudioModeId, meta?: CoverMeta) => {
    // Si l'appelant precise un mode explicite (ex: "Reprendre la chanson"
    // vise toujours 'cover'), on bascule audioMode AVANT de deriver
    // taskType — sinon taskType dependait du mode DEJA actif au moment du
    // clic, pas de l'intention reelle de l'action. C'etait la cause du
    // "l'audio charge mais la section Cover ne s'affiche pas" quand on
    // declenchait l'action depuis un autre mode que Cover.
    if (mode && AUDIO_MODE_MAP[mode]) {
      setAudioMode(mode);
    }
    const effectiveAudioMode = mode && AUDIO_MODE_MAP[mode] ? mode : audioMode;
    // Reverse and Speed modes: what is loaded is a copy made by the server (played backwards, faster or slower).
    const kind = processKindOf(effectiveAudioMode);
    if (target === 'source' && kind && !isProcessedImport(url, kind)) {
      clearReferenceSlot();
      clearSourceSlot();
      void processIntoSource(kind, url, title, meta);
      return;
    }
    processRunRef.current += 1;
    speedOriginRef.current = null;
    setCropDone(false);
    const derivedTitle = title ? title.replace(/\.[^/.]+$/, '') : getAudioLabel(url);
    if (target === 'reference') {
      clearSourceSlot();
      setReferenceAudioUrl(url);
      setReferenceAudioTitle(derivedTitle);
      setReferenceTime(0);
      setReferenceDuration(0);
    } else {
      clearReferenceSlot();
      setSourceAudioUrl(url);
      setSourceAudioTitle(derivedTitle);
      setSourceTime(0);
      setSourceDuration(0);
    }
    // Le taskType decoule du mode actif, plus d'un basculement implicite.
    const activeMode = AUDIO_MODE_MAP[effectiveAudioMode];
    setTaskType(activeMode.field === target ? activeMode.taskType : 'text2music');
    // A cover starts from the source's words and musical facts; the style stays the user's. Every way of loading the
    // source comes through here (the song's Cover action, the library window, a song dropped on the field), so the
    // song is looked up by its audio when the caller did not pass its details.
    if (target === 'source' && activeMode.field === 'source' && activeMode.taskType === 'cover') {
      if (meta) applyCoverMeta(meta);
      else prefillCoverFromSong(url);
    }
  };

  // A new import goes into the workspace open (the app files it there before listing it, so it does not show in
  // "My workspace" meanwhile). Without that callback, the list is simply refreshed.
  const announceNewImport = (trackId: string | undefined) => {
    if (trackId && onImportCreated) void onImportCreated(trackId);
    else onReferenceTracksChanged?.();
  };

  // The source's details, found among the user's songs or imported audios by its audio.
  const songOfAudio = (url: string) => createdSongs.find(s => s.audioUrl === url) ?? importedSongs.find(s => s.audioUrl === url);
  const prefillCoverFromSong = (url: string) => {
    const song = songOfAudio(url);
    if (song) applyCoverMeta(coverMetaFromSong(song));
  };

  // An import that is already a copy of this kind ("Title (reversed)", "Title (×1,25)"): loaded as it is, not
  // processed again (which would turn a reversed copy back, or speed a copy up twice).
  const isProcessedImport = (url: string, kind: ProcessKind) => {
    const song = importedSongs.find(s => s.audioUrl === url);
    if (!song) return false;
    const name = song.title.trim();
    return kind === 'reverse' ? name.endsWith(`(${reversedSuffix})`) : /\(×[\d.,]+\)$/.test(name);
  };

  // Reverse and Speed modes. The server makes the copy (a new import), which becomes the source of a cover. The cover
  // takes the words, key and tempo of the original song (played backwards, the copy has none of its own; sped up, its
  // tempo is the original's times the factor, and its key is lost unless the pitch is kept). The song made is named
  // after the copy: "Title (reversed)", "Title (×1,25)".
  const processIntoSource = async (
    kind: ProcessKind, url: string, title: string | undefined, meta: CoverMeta | undefined,
    speed = { factor: speedFactor, keepPitch: speedKeepPitch },
    range?: { start: number; end: number },
  ): Promise<boolean> => {
    const run = ++processRunRef.current;
    const original = meta ?? (songOfAudio(url) ? coverMetaFromSong(songOfAudio(url)!) : undefined);
    const base = title ? title.replace(/\.[^/.]+$/, '') : getAudioLabel(url);
    const label = kind === 'reverse' ? reversedSuffix
      : kind === 'speed' ? speedLabel(speed.factor)
      : `${clock(range!.start)}–${clock(range!.end)}`;
    const name = `${base} (${label})`;
    speedOriginRef.current = kind === 'speed' ? { url, title, meta } : null;
    setProcessError(null);
    if (!token) { setProcessError({ kind, message: 'Please sign in.' }); return false; }
    setProcessingKind(kind);
    try {
      const response = await fetch(`/api/reference-tracks/${kind}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(kind === 'reverse' ? { audioUrl: url, filename: name }
          : kind === 'speed' ? { audioUrl: url, filename: name, factor: speed.factor, keepPitch: speed.keepPitch }
          : { audioUrl: url, filename: name, start: range!.start, end: range!.end }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.track?.audio_url) throw new Error(data.details || data.error || response.statusText);
      setReferenceTracks(prev => [data.track, ...prev]);
      announceNewImport(data.track.id);
      if (run !== processRunRef.current) return false;
      setSourceAudioUrl(data.track.audio_url);
      setSourceAudioTitle(name);
      setSourceTime(0);
      setSourceDuration(0);
      setTaskType(AUDIO_MODE_MAP[kind].taskType);
      const adjusted: CoverMeta = { ...original, title: name };
      if (kind === 'speed') {
        if (original?.bpm) adjusted.bpm = Math.round(original.bpm * speed.factor);
        // Pitch following the speed: the key is no longer the original's, so it goes back to Auto.
        if (!speed.keepPitch) adjusted.keyScale = '';
      }
      applyCoverMeta(adjusted);
      setCropDone(kind === 'crop');
      // The part kept is now the source of a plain cover: the mode menu says so, rather than still "Crop" over the
      // cover settings. Choosing Crop again cuts the part itself.
      if (kind === 'crop') setAudioMode('cover');
      return true;
    } catch (err) {
      if (run === processRunRef.current) setProcessError({ kind, message: err instanceof Error ? err.message : String(err) });
      return false;
    } finally {
      if (run === processRunRef.current) setProcessingKind(null);
    }
  };

  // Speed mode: another factor, or the pitch kept or not. With a copy already loaded, a new one is made from the
  // original (the earlier copy stays among the imports).
  const chooseSpeed = (factor: number, keepPitch: boolean) => {
    setSpeedFactor(factor);
    setSpeedKeepPitch(keepPitch);
    const origin = speedOriginRef.current;
    if (origin && audioMode === 'speed') {
      clearSourceSlot();
      void processIntoSource('speed', origin.url, origin.title, origin.meta, { factor, keepPitch });
    }
  };

  // Crop mode: the part of the source chosen (in seconds) is cut by the server; the copy, "Title (0:30–1:15)", takes
  // its place and is the source of a cover. The whole song stays shown until the copy is there (or if it fails).
  const cropSource = (start: number, end: number) => {
    if (!sourceAudioUrl) return Promise.resolve(false);
    return processIntoSource('crop', sourceAudioUrl, sourceAudioTitle || undefined, undefined, undefined, { start, end });
  };

  const applyCoverMeta = (meta: CoverMeta) => {
    const current: CoverFields = { title, lyrics, bpm, keyScale, timeSignature, vocalLanguage, instrumental };
    const after: CoverFields = { ...current };
    if (meta.title) after.title = meta.title;
    if (meta.instrumental !== undefined) after.instrumental = meta.instrumental;
    if (meta.lyrics) after.lyrics = meta.lyrics;
    if (meta.bpm) after.bpm = meta.bpm;
    // '' is Auto: a copy whose key is no longer the original's sets it back explicitly.
    if (meta.keyScale !== undefined && KEY_SIGNATURES.includes(meta.keyScale)) after.keyScale = meta.keyScale;
    if (meta.timeSignature && TIME_SIGNATURES.includes(meta.timeSignature)) after.timeSignature = meta.timeSignature;
    if (meta.language) after.vocalLanguage = meta.language;
    // Kept so that removing the source gives the fields back; a second source keeps the fields from before the first.
    coverUndoRef.current = { before: coverUndoRef.current?.before ?? current, after };
    setTitle(after.title);
    setInstrumental(after.instrumental);
    if (after.lyrics !== current.lyrics) setLyrics(after.lyrics);
    setBpm(after.bpm);
    setKeyScale(after.keyScale);
    setTimeSignature(after.timeSignature);
    setVocalLanguage(after.vocalLanguage);
  };

  // Removing the cover's source puts back what the cover filled in, field by field, unless the user changed it since.
  const undoCoverMeta = () => {
    const undo = coverUndoRef.current;
    coverUndoRef.current = null;
    if (!undo) return;
    const { before, after } = undo;
    if (title === after.title) setTitle(before.title);
    if (lyrics === after.lyrics && lyrics !== before.lyrics) setLyrics(before.lyrics);
    if (bpm === after.bpm) setBpm(before.bpm);
    if (keyScale === after.keyScale) setKeyScale(before.keyScale);
    if (timeSignature === after.timeSignature) setTimeSignature(before.timeSignature);
    if (vocalLanguage === after.vocalLanguage) setVocalLanguage(before.vocalLanguage);
    if (instrumental === after.instrumental) setInstrumental(before.instrumental);
  };

  // Changement de mode : on deplace le fichier deja charge vers la case que le
  // nouveau mode va reellement lire, pour ne pas le perdre silencieusement.
  //
  // Force (audioCoverStrength) et Fidelite (coverNoiseStrength) sont des
  // valeurs UNIQUES, partagees entre tous les modes — pas de reglage par
  // mode dans l'etat. Des essais manuels ont montre que les defauts
  // generiques (0.5 / 0) produisent du gresillement plutot qu'un vrai cover
  // ou une vraie inspiration. On applique donc des valeurs eprouvees pour
  // ces deux modes precis, a CHAQUE bascule — y compris par-dessus un
  // reglage manuel du mode precedent, sur demande explicite (pas de
  // detection de "l'utilisateur a-t-il deja touche ces curseurs").
  // Non revalide par une mesure controlee comme en TROUBLESHOOTING #22 :
  // valeurs empiriques d'un seul utilisateur, a affiner si besoin.
  const AUDIO_MODE_DEFAULTS: Partial<Record<AudioModeId, { strength: number; noise: number }>> = {
    cover: { strength: 0.15, noise: 0.12 },
    // A cover of the audio played backwards: at 0.15 the lyrics are sung, at 0.4 three quarters of them were lost (one listening test).
    reverse: { strength: 0.15, noise: 0.12 },
    // A cover of the audio sped up or slowed down: 0.15 was the best in a listening test, 0.4 gave artefacts.
    speed: { strength: 0.15, noise: 0.12 },
    crop: { strength: 0.15, noise: 0.12 },
    inspiration: { strength: 0.40, noise: 0 },
  };

  const changeAudioMode = (id: AudioModeId) => {
    const next = AUDIO_MODE_MAP[id];
    if (!next || !next.available) return;
    const prev = AUDIO_MODE_MAP[audioMode];
    setShowAudioMenu(false);
    setAudioMode(id);
    // Crop chosen again with a part already cut: that part is shown to be cut in turn.
    if (id === 'crop') setCropDone(false);

    const modeDefaults = AUDIO_MODE_DEFAULTS[id];
    if (modeDefaults) {
      setAudioCoverStrength(modeDefaults.strength);
      setCoverNoiseStrength(modeDefaults.noise);
    }

    const currentUrl = prev.field === 'reference' ? referenceAudioUrl : sourceAudioUrl;
    const currentTitle = prev.field === 'reference' ? referenceAudioTitle : sourceAudioTitle;

    if (currentUrl && prev.field !== next.field) {
      if (next.field === 'reference') {
        clearSourceSlot();
        setReferenceAudioUrl(currentUrl);
        setReferenceAudioTitle(currentTitle);
        setReferenceTime(0);
        setReferenceDuration(0);
      } else {
        clearReferenceSlot();
        setSourceAudioUrl(currentUrl);
        setSourceAudioTitle(currentTitle);
        setSourceTime(0);
        setSourceDuration(0);
      }
    }
    setTaskType(currentUrl ? next.taskType : 'text2music');
    // Switching to Cover with an audio already loaded (e.g. in Inspiration): the audio moves to the source field, and
    // the cover takes the song's words as if it had been loaded there. Moving between two cover modes keeps the
    // lyrics as the user left them.
    if (currentUrl && next.field === 'source' && next.taskType === 'cover' && prev.taskType !== 'cover') {
      prefillCoverFromSong(currentUrl);
    }
    // Switching to Reverse or Speed with an audio loaded: that audio is processed and its copy takes its place.
    const kind = processKindOf(id);
    if (currentUrl && kind && prev.id !== id && !isProcessedImport(currentUrl, kind)) {
      clearReferenceSlot();
      clearSourceSlot();
      void processIntoSource(kind, currentUrl, currentTitle, undefined);
    }
  };

  const toggleAudio = (target: 'reference' | 'source') => {
    const audio = target === 'reference' ? referenceAudioRef.current : sourceAudioRef.current;
    if (!audio) return;
    if (audio.paused) {
      audio.play().catch(() => undefined);
    } else {
      audio.pause();
    }
  };

  // --- Emplacement audio actif (derive du mode) -----------------------------
  const activeAudioMode = AUDIO_MODE_MAP[audioMode];
  const audioTarget: 'reference' | 'source' = activeAudioMode.field;
  const isReferenceTarget = audioTarget === 'reference';
  const activeAudioUrl = isReferenceTarget ? referenceAudioUrl : sourceAudioUrl;
  const activeAudioTitle = isReferenceTarget ? referenceAudioTitle : sourceAudioTitle;
  const activeAudioPlaying = isReferenceTarget ? referencePlaying : sourcePlaying;
  const activeAudioTime = isReferenceTarget ? referenceTime : sourceTime;
  const activeAudioDuration = isReferenceTarget ? referenceDuration : sourceDuration;

  const activeAudioElRef = isReferenceTarget ? referenceAudioRef : sourceAudioRef;
  const activeAudioInputRef = isReferenceTarget ? referenceInputRef : sourceInputRef;

  const clearActiveAudio = () => {
    processRunRef.current += 1;
    speedOriginRef.current = null;
    setCropDone(false);
    setProcessingKind(null);
    setProcessError(null);
    if (isReferenceTarget) clearReferenceSlot(); else { clearSourceSlot(); undoCoverMeta(); }
    setTaskType('text2music');
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>, target: 'reference' | 'source') => {
    e.preventDefault();
    // Le listener global sur window ne recevra pas cet événement à cause du
    // stopPropagation() des zones de dépôt : on réinitialise l'état ici.
    dragDepthRef.current = 0;
    setIsDraggingFile(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      void uploadReferenceTrack(file, target);
      return;
    }
    const payload = e.dataTransfer.getData('application/x-ace-audio');
    if (payload) {
      try {
        const data = JSON.parse(payload);
        if (data?.url) {
          applyAudioTargetUrl(target, data.url, data.title);
        }
      } catch {
        // ignore
      }
    }
  };

  // Fermeture du menu « Ajouter » au clic exterieur / Echap.
  useEffect(() => {
    if (!showAudioAddMenu) return;
    const onPointerDown = (e: MouseEvent) => {
      if (audioAddMenuRef.current && !audioAddMenuRef.current.contains(e.target as Node)) {
        setShowAudioAddMenu(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowAudioAddMenu(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [showAudioAddMenu]);

  // Fermeture du menu de mode audio au clic exterieur / Echap.
  useEffect(() => {
    if (!showAudioMenu) return;
    const onPointerDown = (e: MouseEvent) => {
      if (audioMenuRef.current && !audioMenuRef.current.contains(e.target as Node)) {
        setShowAudioMenu(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowAudioMenu(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [showAudioMenu]);

  return {
    activeAudioDuration, activeAudioElRef, activeAudioInputRef, activeAudioMode, activeAudioPlaying, activeAudioTime,
    activeAudioTitle, activeAudioUrl, audioAddMenuRef, audioMenuRef, audioModalTab, audioModalTarget, audioMode,
    audioTarget, cancelTranscription, changeAudioMode, clearActiveAudio, deleteReferenceTrack, fetchReferenceTracks,
    getAudioLabel, handleDrop, handleFileSelect, isDraggingFile, isLoadingTracks, isReferenceTarget,
    isTranscribingReference, isUploadingReference, isUploadingSource, openAudioModal, recordTrackDuration,
    referenceAudioRef, referenceAudioTitle, referenceAudioUrl, referenceInputRef, referenceTracks, setAudioMode,
    setReferenceDuration, setReferencePlaying, setReferenceTime, setShowAudioAddMenu, setShowAudioMenu,
    setShowAudioModal, setSourceDuration, setSourcePlaying, setSourceTime, showAudioAddMenu, showAudioMenu,
    showAudioModal, sourceAudioRef, sourceAudioTitle, sourceAudioUrl, sourceDuration, sourceInputRef, toggleAudio,
    uploadError, uploadReferenceTrack, useReferenceTrack, processingKind, processError,
    speedFactor, speedKeepPitch, chooseSpeed, cropDone, cropSource,
  };
}
