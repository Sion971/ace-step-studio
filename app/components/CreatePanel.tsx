import { LoraPanel } from './LoraPanel';
import { VocalSettings, type VocalGender } from './VocalSettings';
import { SeedSettings } from './SeedSettings';
import { FlowEditSettings } from './FlowEditSettings';
import { OutputSettings } from './OutputSettings';
import { SamplingSettings } from './SamplingSettings';
import { ModelMenu } from './ModelMenu';
import { isTurboModel } from '../utils/modelNames';
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Sparkles, ChevronDown, Settings2, Trash2, Music2, Sliders, Dices, RefreshCw, Plus, Upload, Play, Pause, Loader2, Disc3, Undo2, Wand2, Square, Scissors, Repeat, Gauge, Layers, ArrowRightToLine, Library } from 'lucide-react';
import { AudioWaveform } from './AudioWaveform';
import { GenerationParams, Song } from '../types';
import { useAuth } from '../context/AuthContext';
import { useI18n } from '../context/I18nContext';
import { generateApi, settingsApi } from '../services/api';
import { MAIN_STYLES } from '../data/genres';
import { EditableSlider } from './EditableSlider';
import { UseOpenRouterToggle } from './UseOpenRouterToggle';
import { LmProviderPanel } from './LmProviderPanel';
import { GenerationStatusPanel } from './GenerationStatusPanel';
import { UsePollinationsToggle } from './UsePollinationsToggle';
import { PollinationsPanel } from './PollinationsPanel';
import { useOpenRouterGeneration } from '../services/llm/useOpenRouterGeneration';
import { OpenRouterProvider } from '../services/llm/openrouter';
import { llmStorage } from '../services/llm/storage';
import type { SongDraft } from '../services/llm/types';
import { pollinationsStorage } from '../services/pollinations/storage';
import { buildCoverPrompt } from '../services/pollinations/prompts';

interface ReferenceTrack {
  id: string;
  filename: string;
  storage_key: string;
  duration: number | null;
  file_size_bytes: number | null;
  tags: string[] | null;
  created_at: string;
  audio_url: string;
}

// ---------------------------------------------------------------------------
// AUDIO MODES — un seul emplacement audio, un menu de mode (façon Suno).
//
// `field`    : dans quelle case du payload part l'URL (contrat backend inchangé)
// `taskType` : la valeur envoyee au pipeline quand un audio est charge
// `available`: false = visible dans le menu mais grise (pas encore branche)
//
// Reference et Cover ne peuvent PAS coexister : le pipeline n'arbitre que sur
// `taskType`, qui est unique. Le menu rend cette exclusivite explicite.
// ---------------------------------------------------------------------------
export type AudioModeId =
  | 'cover' | 'inspiration' | 'mashup' | 'sample'
  | 'extend' | 'repaint' | 'crop' | 'reverse' | 'speed';

export interface AudioModeDef {
  id: AudioModeId;
  group: 'remix' | 'edit';
  field: 'reference' | 'source';
  taskType: string;
  label: string;
  // Libelle court affiche sur le bouton d'en-tete, ou la place est comptee.
  // « Remplacer une section » debordait du panneau.
  short: string;
  desc: string;
  icon: React.ComponentType<{ size?: number | string; className?: string }>;
  available: boolean;
}

export const AUDIO_MODES: AudioModeDef[] = [
  // --- REMIX -------------------------------------------------------------
  { id: 'cover',       group: 'remix', field: 'source',    taskType: 'cover',
    label: 'Cover',      short: 'Cover', desc: 'Recree ce morceau dans un autre genre',
    icon: RefreshCw, available: true },
  { id: 'inspiration', group: 'remix', field: 'reference', taskType: 'text2music',
    label: 'Inspiration', short: 'Inspiration', desc: 'S\'inspire librement — la couleur, pas les details',
    icon: Sparkles, available: true },
  { id: 'mashup',      group: 'remix', field: 'source',    taskType: 'cover',
    label: 'Mashup',     short: 'Mashup', desc: 'Melange avec un autre morceau',
    icon: Layers, available: false },
  { id: 'sample',      group: 'remix', field: 'source',    taskType: 'cover',
    label: 'Sample',     short: 'Sample', desc: 'Utilise un extrait dans un nouveau morceau',
    icon: Disc3, available: false },
  // --- MODIFICATION ------------------------------------------------------
  { id: 'repaint',     group: 'edit',  field: 'source',    taskType: 'repaint',
    label: 'Remplacer une section', short: 'Section', desc: 'Regenere une portion choisie',
    icon: Wand2, available: true },
  { id: 'extend',      group: 'edit',  field: 'source',    taskType: 'extend',
    label: 'Prolonger',  short: 'Prolonger', desc: 'Prolonge le morceau la ou il s\'arrete',
    icon: ArrowRightToLine, available: false },
  { id: 'crop',        group: 'edit',  field: 'source',    taskType: 'repaint',
    label: 'Rogner',     short: 'Rogner', desc: 'Decoupe a une sous-section',
    icon: Scissors, available: false },
  { id: 'reverse',     group: 'edit',  field: 'source',    taskType: 'cover',
    label: 'Inverser',   short: 'Inverser', desc: 'Joue l\'audio a l\'envers',
    icon: Repeat, available: false },
  { id: 'speed',       group: 'edit',  field: 'source',    taskType: 'cover',
    label: 'Vitesse',    short: 'Vitesse', desc: 'Change la vitesse de lecture',
    icon: Gauge, available: false },
];

// Ancien defaut code en dur du champ `instruction`. Il n'etait jamais vide,
// donc `params.instruction || (...)` dans acestep.ts l.186 court-circuitait
// toujours les instructions specifiques a cover / repaint : le DiT recevait
// l'instruction du text2music meme en cover, d'ou les artefacts.
// On le garde uniquement pour neutraliser la valeur persistee en base.
export const LEGACY_INSTRUCTION_DEFAULT =
  'Fill the audio semantic mask based on the given conditions:';

// Instruction que le serveur appliquera si le champ est laisse vide.
// Sert de placeholder informatif dans les reglages avances.
export const defaultInstructionFor = (taskType: string): string =>
  taskType === 'cover'
    ? 'Generate audio semantic tokens based on the given conditions:'
    : taskType === 'repaint'
      ? 'Repaint the mask area based on the given conditions:'
      : 'Fill the audio semantic mask based on the given conditions:';

export const AUDIO_MODE_MAP = AUDIO_MODES.reduce((acc, m) => {
  acc[m.id] = m;
  return acc;
}, {} as Record<AudioModeId, AudioModeDef>);

interface CreatePanelProps {
  onGenerate: (params: GenerationParams) => void;
  isGenerating: boolean;
  activeJobCount?: number;
  initialData?: { song: Song, timestamp: number } | null;
  createdSongs?: Song[];
  pendingAudioSelection?: { target: 'reference' | 'source'; url: string; title?: string } | null;
  onAudioSelectionApplied?: () => void;
  /** Returns a promise that resolves when all currently-running generation
   *  jobs have completed. Used to serialize bulk clicks: the next click's
   *  LLM pre-flight + POST happen only after the previous track is fully
   *  done (audio + cover). Resolves immediately when no jobs are active. */
  waitForJobsToDrain?: () => Promise<void>;
  /** Bump the parent's "pending click" counter synchronously the moment the
   *  user clicks Create, so the N/10 badge shows instantly even though
   *  LLM pre-flight + POST will take seconds. */
  incrementPendingClicks?: (n?: number) => void;
  /** Decrement when the click has handed off to a real active job (or
   *  failed) — pairs 1:1 with incrementPendingClicks. */
  decrementPendingClicks?: (n?: number) => void;
  /** Create an instant placeholder song card at click time. Returns the
   *  temp id so the caller can pass it through onGenerate as `_tempId` and
   *  reuse the same card instead of creating a duplicate. */
createTempSongForClick?: (descriptionPreview: string, ditModel?: string) => string;
  updateTempSongForClick?: (tempId: string, patch: Partial<Song>) => void;
  removeTempSongForClick?: (tempId: string) => void;
  /** Register an AbortController for the in-flight OpenRouter pre-flight call
   *  so the parent's cancel-button (single + cancel-all) can abort it. */
  registerPreflightAbort?: (tempId: string, ac: AbortController) => void;
  unregisterPreflightAbort?: (tempId: string) => void;
}

const KEY_SIGNATURES = [
  '',
  'C major', 'C minor',
  'C# major', 'C# minor',
  'Db major', 'Db minor',
  'D major', 'D minor',
  'D# major', 'D# minor',
  'Eb major', 'Eb minor',
  'E major', 'E minor',
  'F major', 'F minor',
  'F# major', 'F# minor',
  'Gb major', 'Gb minor',
  'G major', 'G minor',
  'G# major', 'G# minor',
  'Ab major', 'Ab minor',
  'A major', 'A minor',
  'A# major', 'A# minor',
  'Bb major', 'Bb minor',
  'B major', 'B minor'
];

const TIME_SIGNATURES = ['', '2', '3', '4', '6', 'N/A'];

const TRACK_NAMES = [
  'woodwinds', 'brass', 'fx', 'synth', 'strings', 'percussion',
  'keyboard', 'guitar', 'bass', 'drums', 'backing_vocals', 'vocals',
];


export const CreatePanel: React.FC<CreatePanelProps> = ({
  onGenerate,
  isGenerating,
  activeJobCount = 0,
  initialData,
  createdSongs = [],
  pendingAudioSelection,
  onAudioSelectionApplied,
  waitForJobsToDrain,
  incrementPendingClicks,
  decrementPendingClicks,
  createTempSongForClick,
  updateTempSongForClick,
  removeTempSongForClick,
  registerPreflightAbort,
  unregisterPreflightAbort,
}) => {
  const { isAuthenticated, token, user } = useAuth();
  const { t } = useI18n();

  // `t()` renvoie la clé elle-même quand la traduction manque. Le motif
  // `tf('x', 'repli')` recevait donc toujours une chaîne non vide à gauche et
  // n'appliquait jamais le repli — d'où des libellés bruts comme
  // « generationSeed » affichés à l'écran. `tf()` détecte le cas « clé revenue
  // inchangée » et bascule sur le repli.
  const tf = useCallback((key: string, fallback: string): string => {
    const value = t(key);
    return !value || value === key ? fallback : value;
  }, [t]);

  // Randomly select 6 music tags from MAIN_STYLES
  const [musicTags, setMusicTags] = useState<string[]>(() => {
    const shuffled = [...MAIN_STYLES].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, 6);
  });

  // Function to refresh music tags
  const refreshMusicTags = useCallback(() => {
    const shuffled = [...MAIN_STYLES].sort(() => Math.random() - 0.5);
    setMusicTags(shuffled.slice(0, 6));
  }, []);

  // Mode

  // Simple Mode
  const [songDescription, setSongDescription] = useState(() => localStorage.getItem('ace-songDescription') || '');

  // Contenu du morceau
  const [lyrics, setLyricsRaw] = useState(() => localStorage.getItem('ace-lyrics') || '');
  const [style, setStyleRaw] = useState(() => localStorage.getItem('ace-style') || '');
  const [title, setTitle] = useState(() => localStorage.getItem('ace-title') || '');

  // Undo history for lyrics and style
  const lyricsHistoryRef = useRef<string[]>([]);
  const styleHistoryRef = useRef<string[]>([]);
  const setLyrics = useCallback((val: string | ((prev: string) => string)) => {
    setLyricsRaw(prev => {
      const newVal = typeof val === 'function' ? val(prev) : val;
      if (prev && prev !== newVal) lyricsHistoryRef.current.push(prev);
      if (lyricsHistoryRef.current.length > 20) lyricsHistoryRef.current.shift();
      return newVal;
    });
  }, []);
  const setStyle = useCallback((val: string | ((prev: string) => string)) => {
    setStyleRaw(prev => {
      const newVal = typeof val === 'function' ? val(prev) : val;
      if (prev && prev !== newVal) styleHistoryRef.current.push(prev);
      if (styleHistoryRef.current.length > 20) styleHistoryRef.current.shift();
      return newVal;
    });
  }, []);
  const undoLyrics = useCallback(() => {
    const prev = lyricsHistoryRef.current.pop();
    if (prev !== undefined) setLyricsRaw(prev);
  }, []);
  const undoStyle = useCallback(() => {
    const prev = styleHistoryRef.current.pop();
    if (prev !== undefined) setStyleRaw(prev);
  }, []);

  // Common
  const [instrumental, setInstrumental] = useState(false);
  const [vocalLanguage, setVocalLanguage] = useState('en');
  const [vocalGender, setVocalGender] = useState<VocalGender>('');

  // Music Parameters
  const [bpm, setBpm] = useState(0);
  const [keyScale, setKeyScale] = useState('');
  const [timeSignature, setTimeSignature] = useState('');

  // Advanced Settings
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [duration, setDuration] = useState(-1);
  const [batchSize, setBatchSize] = useState(1);
  const [bulkCount, setBulkCount] = useState(1);
  const [guidanceScale, setGuidanceScale] = useState(9.0);
  const [randomSeed, setRandomSeed] = useState(true);
  const [seed, setSeed] = useState(-1);

  // -1 signifie "aleatoire" pour le moteur : eteindre l'interrupteur sans
  // saisir de nombre ne fixait donc rien du tout. On tire une graine reelle
  // au moment de la bascule, comme le font les interfaces de diffusion.
  const toggleRandomSeed = () => {
    setRandomSeed((prev) => {
      const next = !prev;
      if (!next && (seed === -1 || seed === 0)) {
        setSeed(Math.floor(Math.random() * 4294967295));
      }
      return next;
    });
  };
  const [thinking, setThinking] = useState(false); // Default false for GPU compatibility
  const [enhance, setEnhance] = useState(false); // AI Enhance: uses LLM to enrich caption & generate metadata
  const [audioFormat, setAudioFormat] = useState<'mp3' | 'flac'>('mp3');
  const [inferenceSteps, setInferenceSteps] = useState(12);
  const [inferMethod, setInferMethod] = useState<'ode' | 'sde'>('ode');
  const [lmBackend, setLmBackend] = useState<'pt' | 'vllm'>('pt');
  const [lmModel, setLmModel] = useState('');
  // Tracks the *actual* LM model loaded on the backend (server-reported, distinct
  // from `lmModel` which represents the user-selected target). Empty string means
  // no local LM is currently loaded.
  const [activeLmModel, setActiveLmModel] = useState('');
  // True after the first successful server poll — used to defer the default-ON
  // toggle effect so we don't race against the initial render state.
  const [serverPollSeen, setServerPollSeen] = useState<boolean>(false);
  const [shift, setShift] = useState(3.0);

  // OpenRouter (LLM provider) integration
  const [useOpenRouter, setUseOpenRouter] = useState<boolean>(() => {
    const stored = llmStorage.getUseOpenRouter();
    // Default ON when never set: in `run-no-lm.bat` the local LM is unavailable
    // so the AI buttons must route through OpenRouter to do anything at all.
    // Users on `run.bat` who want the local LM can flip the toggle off in one
    // click; the choice is then persisted.
    return stored ?? true;
  });
  const [lastOpenRouterModelId, setLastOpenRouterModelId] = useState<string | null>(null);

  // Pollinations.ai cover generation — independent toggle, default OFF.
  const [usePollinations, setUsePollinations] = useState<boolean>(() => {
    return pollinationsStorage.getUsePollinations() ?? false;
  });
  useEffect(() => { pollinationsStorage.setUsePollinations(usePollinations); }, [usePollinations]);

  // FIFO queue for OR pre-flight LLM calls — bulk clicks chain through this
  // ref so the LLM hits one request at a time AND each click waits for the
  // previous track's full completion (audio + cover) before its own LLM
  // starts. The shared `orHook` singleton is reserved for explicit AI-buttons
  // (Generate/Format) whose streaming UI demands a single source of truth.
  const llmPreflightQueueRef = useRef<Promise<SongDraft | null>>(Promise.resolve(null));

  // LM Parameters (under Expert)
  const [showLmParams, setShowLmParams] = useState(false);
  const [lmTemperature, setLmTemperature] = useState(0.8);
  const [lmCfgScale, setLmCfgScale] = useState(2.2);
  const [lmTopK, setLmTopK] = useState(0);
  const [lmTopP, setLmTopP] = useState(0.92);
  const [lmNegativePrompt, setLmNegativePrompt] = useState('NO USER INPUT');

  // Expert Parameters (now in Advanced section)
  const [referenceAudioUrl, setReferenceAudioUrl] = useState('');
  const [sourceAudioUrl, setSourceAudioUrl] = useState('');
  const [referenceAudioTitle, setReferenceAudioTitle] = useState('');
  const [sourceAudioTitle, setSourceAudioTitle] = useState('');
  const [audioCodes, setAudioCodes] = useState('');
  const [repaintingStart, setRepaintingStart] = useState(0);
  const [repaintingEnd, setRepaintingEnd] = useState(-1);
  // Vide par defaut : acestep.ts choisit alors l'instruction adaptee au taskType.
  const [instruction, setInstruction] = useState('');
  const [audioCoverStrength, setAudioCoverStrength] = useState(0.5);
  // `cover_noise_strength` etait accepte par acestep.ts (`?? 0.0`) mais aucun
  // etat ne l'alimentait : il valait donc toujours 0, sans marge de manoeuvre
  // pour s'ecarter proprement de la source. Expose ici.
  const [coverNoiseStrength, setCoverNoiseStrength] = useState(0);
  const [taskType, setTaskType] = useState('text2music');
  const [useAdg, setUseAdg] = useState(false);
  const [cfgIntervalStart, setCfgIntervalStart] = useState(0.0);
  const [cfgIntervalEnd, setCfgIntervalEnd] = useState(1.0);
  const [customTimesteps, setCustomTimesteps] = useState('');
  const [useCotMetas, setUseCotMetas] = useState(true);
  const [useCotCaption, setUseCotCaption] = useState(true);
  const [useCotLanguage, setUseCotLanguage] = useState(true);
  const [autogen, setAutogen] = useState(false);
  const [constrainedDecodingDebug, setConstrainedDecodingDebug] = useState(false);
  const [allowLmBatch, setAllowLmBatch] = useState(true);
  const [getScores, setGetScores] = useState(false);
  const [getLrc, setGetLrc] = useState(false);
  const [scoreScale, setScoreScale] = useState(0.5);
  const [lmBatchChunkSize, setLmBatchChunkSize] = useState(8);
  const [trackName, setTrackName] = useState('');
  const [completeTrackClasses, setCompleteTrackClasses] = useState('');
  const [isFormatCaption, setIsFormatCaption] = useState(false);

  // v1.5 XL parameters
  const [samplerMode, setSamplerMode] = useState('euler');
  const [schedulerType, setSchedulerType] = useState('linear');
  // DCW (Differential Correction in Wavelet domain) — CVPR 2026 quality boost.
  // Default ON per upstream v0.1.7. No-op when pytorch_wavelets is missing.
  const [dcwEnabled, setDcwEnabled] = useState(true);
  const [dcwMode, setDcwMode] = useState<'low' | 'high' | 'double' | 'pix'>('double');
  const [dcwScaler, setDcwScaler] = useState(0.05);
  const [dcwHighScaler, setDcwHighScaler] = useState(0.02);
  const [dcwWavelet, setDcwWavelet] = useState('haar');
  // Retake — variance-preserving blend with an independent noise draw
  const [retakeSeed, setRetakeSeed] = useState('-1');
  const [retakeVariance, setRetakeVariance] = useState(0.0);
  // Interrupteur explicite : avant, `retakeVariance === 0` grisait le champ de
  // graine sans rien expliquer. Un booleen dedie replie tout le panneau.
  const [retakeEnabled, setRetakeEnabled] = useState(false);
  // Flow-edit (#1156) — text-edit overlay morphing src toward target prompt/lyrics.
  // Works on text2music + cover + cover-nofsq tasks only.
  const [flowEditMorph, setFlowEditMorph] = useState(false);
  const [flowEditSourceCaption, setFlowEditSourceCaption] = useState('');
  const [flowEditSourceLyrics, setFlowEditSourceLyrics] = useState('');
  const [flowEditNMin, setFlowEditNMin] = useState(0.0);
  const [flowEditNMax, setFlowEditNMax] = useState(1.0);
  const [flowEditNAvg, setFlowEditNAvg] = useState(1);
  const [mp3Bitrate, setMp3Bitrate] = useState('128k');
  const [mp3SampleRate, setMp3SampleRate] = useState(48000);
  const [fadeInDuration, setFadeInDuration] = useState(0.0);
  const [fadeOutDuration, setFadeOutDuration] = useState(0.0);
  const [repaintMode, setRepaintMode] = useState<'conservative' | 'balanced' | 'aggressive' | 'most_natural'>('balanced');
  const [repaintStrength, setRepaintStrength] = useState(0.5);

  const [maxDurationWithLm, setMaxDurationWithLm] = useState(240);
  const [maxDurationWithoutLm, setMaxDurationWithoutLm] = useState(240);

  // LoRA — l'état complet vit dans <LoraPanel />, seul loraLoaded remonte ici
  // (paramètres de génération + désactivation de thinking/useAdg).
  const [loraLoaded, setLoraLoaded] = useState(false);
  const settingsLoadedRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const saveSettingsToServer = useCallback((overrides?: Record<string, unknown>) => {
    if (!token || !settingsLoadedRef.current) return;
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const settings: Record<string, unknown> = {
        instrumental, vocalLanguage, vocalGender, bpm, keyScale, timeSignature, duration, batchSize, bulkCount,
        guidanceScale, thinking, enhance, getLrc, audioFormat, inferenceSteps, inferMethod,
        shift, lmTemperature, lmCfgScale, lmTopK, lmTopP, lmNegativePrompt, useAdg, samplerMode, schedulerType,
        dcwEnabled, dcwMode, dcwScaler, dcwHighScaler, dcwWavelet, retakeSeed, retakeVariance,
        flowEditMorph, flowEditSourceCaption, flowEditSourceLyrics, flowEditNMin, flowEditNMax, flowEditNAvg,
        mp3Bitrate, mp3SampleRate, ...overrides,
      };
      settingsApi.save(settings, token).catch(() => {});
    }, 1000);
  }, [token, instrumental, vocalLanguage, vocalGender, bpm, keyScale, timeSignature, duration, batchSize, bulkCount,
      guidanceScale, thinking, enhance, getLrc, audioFormat, inferenceSteps, inferMethod,
      shift, lmTemperature, lmCfgScale, lmTopK, lmTopP, lmNegativePrompt, useAdg, samplerMode, schedulerType,
      dcwEnabled, dcwMode, dcwScaler, dcwHighScaler, dcwWavelet, retakeSeed, retakeVariance,
      flowEditMorph, flowEditSourceCaption, flowEditSourceLyrics, flowEditNMin, flowEditNMax, flowEditNAvg,
      mp3Bitrate, mp3SampleRate]);

  // Auto-save when any setting changes
  React.useEffect(() => {
    saveSettingsToServer();
  }, [saveSettingsToServer]);

  // Save input fields to localStorage
  React.useEffect(() => { localStorage.setItem('ace-songDescription', songDescription); }, [songDescription]);
  React.useEffect(() => { localStorage.setItem('ace-lyrics', lyrics); }, [lyrics]);
  React.useEffect(() => { localStorage.setItem('ace-style', style); }, [style]);
  React.useEffect(() => { localStorage.setItem('ace-title', title); }, [title]);

  // OpenRouter: default toggle ON in no-LM mode (only if user hasn't explicitly set it).
  // Gated on serverPollSeen so we don't race against the initial render —
  // the initial activeLmModel='' is meaningless until the server has replied.
  useEffect(() => {
    if (!serverPollSeen) return;
    if (llmStorage.getUseOpenRouter() === null && !activeLmModel) {
      setUseOpenRouter(true);
    }
  }, [serverPollSeen, activeLmModel]);

  // OpenRouter: persist toggle on every change
  useEffect(() => { llmStorage.setUseOpenRouter(useOpenRouter); }, [useOpenRouter]);

  // Load settings on mount (once)
  const settingsLoadedOnceRef = useRef(false);
  React.useEffect(() => {
    if (!token || settingsLoadedOnceRef.current) return;
    settingsLoadedOnceRef.current = true;
    settingsApi.get(token).then(s => {
      if (s.instrumental !== undefined) setInstrumental(s.instrumental as boolean);
      if (s.vocalLanguage !== undefined) setVocalLanguage(s.vocalLanguage as string);
      if (s.vocalGender !== undefined) setVocalGender(s.vocalGender as VocalGender);
      // BPM/Key/Duration — persist user's manual values
      if (s.bpm != null) setBpm(Number(s.bpm) || 0);
      if (s.keyScale != null) setKeyScale(String(s.keyScale || ''));
      if (s.timeSignature != null) setTimeSignature(String(s.timeSignature || ''));
      if (s.duration != null) setDuration(Number(s.duration) || -1);
      if (s.batchSize !== undefined) setBatchSize(s.batchSize as number);
      if (s.bulkCount !== undefined) setBulkCount(s.bulkCount as number);
      // guidanceScale, inferenceSteps, useAdg — auto-determined by model via useEffect
      if (s.thinking !== undefined) setThinking(s.thinking as boolean);
      if (s.enhance !== undefined) setEnhance(s.enhance as boolean);
      if (s.getLrc !== undefined) setGetLrc(s.getLrc as boolean);
      if (s.audioFormat !== undefined) setAudioFormat(s.audioFormat as 'mp3' | 'flac');
      // inferenceSteps — auto-determined by model via useEffect
      if (s.inferMethod !== undefined) setInferMethod(s.inferMethod as 'ode' | 'sde');
      // lmModel and lmBackend are synced from server — don't restore from localStorage
      if (s.shift !== undefined) setShift(s.shift as number);
      if (s.lmTemperature !== undefined) setLmTemperature(s.lmTemperature as number);
      if (s.lmCfgScale !== undefined) setLmCfgScale(s.lmCfgScale as number);
      if (s.lmTopK !== undefined) setLmTopK(s.lmTopK as number);
      if (s.lmTopP !== undefined) setLmTopP(s.lmTopP as number);
      if (s.lmNegativePrompt !== undefined) setLmNegativePrompt(s.lmNegativePrompt as string);
      // useAdg — auto-determined by model via useEffect
      if (s.samplerMode !== undefined) setSamplerMode(s.samplerMode as string);
      if (s.schedulerType !== undefined) setSchedulerType(s.schedulerType as string);
      if (s.dcwEnabled !== undefined) setDcwEnabled(s.dcwEnabled as boolean);
      if (s.dcwMode !== undefined) setDcwMode(s.dcwMode as 'low' | 'high' | 'double' | 'pix');
      if (s.dcwScaler !== undefined) setDcwScaler(Number(s.dcwScaler));
      if (s.dcwHighScaler !== undefined) setDcwHighScaler(Number(s.dcwHighScaler));
      if (s.dcwWavelet !== undefined) setDcwWavelet(s.dcwWavelet as string);
      if (s.retakeSeed !== undefined) setRetakeSeed(String(s.retakeSeed));
      if (s.retakeVariance !== undefined) {
        setRetakeVariance(Number(s.retakeVariance));
        setRetakeEnabled(Number(s.retakeVariance) > 0);
      }
      if (s.flowEditMorph !== undefined) setFlowEditMorph(s.flowEditMorph as boolean);
      if (s.flowEditSourceCaption !== undefined) setFlowEditSourceCaption(s.flowEditSourceCaption as string);
      if (s.flowEditSourceLyrics !== undefined) setFlowEditSourceLyrics(s.flowEditSourceLyrics as string);
      if (s.flowEditNMin !== undefined) setFlowEditNMin(Number(s.flowEditNMin));
      if (s.flowEditNMax !== undefined) setFlowEditNMax(Number(s.flowEditNMax));
      if (s.flowEditNAvg !== undefined) setFlowEditNAvg(Number(s.flowEditNAvg));
      if (s.mp3Bitrate !== undefined) setMp3Bitrate(s.mp3Bitrate as string);
      if (s.mp3SampleRate !== undefined) setMp3SampleRate(s.mp3SampleRate as number);
      settingsLoadedRef.current = true;
    }).catch(() => { settingsLoadedRef.current = true; });
  }, [token]);

  // Model selection
  const [selectedModel, setSelectedModel] = useState<string>(() => {
    return localStorage.getItem('ace-model') || 'marcorez8/acestep-v15-xl-turbo-bf16';
  });
  const [modelSwitchStatus, setModelSwitchStatus] = useState<string | null>(null);
  const [modelSwitchProgress, setModelSwitchProgress] = useState<number>(0);
  const [modelLoadingState, setModelLoadingState] = useState<{ state: string; model: string; connected?: boolean; activeModel?: string; backendDown?: boolean }>({ state: 'ready', model: '', connected: false, backendDown: true });
  const previousModelRef = useRef<string>(selectedModel);
  // When true, user is editing LM settings — don't overwrite with server values
  const lmEditingRef = useRef(false);
  // When true, the next run of the model-dependent auto-adjust effect is
  // skipped — set by the "reuse song" effect right before it restores a
  // song's own ditModel + inferenceSteps/guidanceScale/useAdg together, so
  // those restored values aren't immediately clobbered by the model's
  // generic defaults.
  const skipNextModelAdjustRef = useRef(false);
  // Mirrors modelSwitchStatus so the poll interval below (set up once with
  // an empty dependency array) always reads the live value instead of the
  // `null` it would otherwise capture forever in its closure.
  const modelSwitchStatusRef = useRef(modelSwitchStatus);
  useEffect(() => { modelSwitchStatusRef.current = modelSwitchStatus; }, [modelSwitchStatus]);

  // Poll model loading status every 2s
  React.useEffect(() => {
    const poll = setInterval(async () => {
      try {
        const res = await fetch('/api/generate/model-status');
        if (res.ok) {
          const data = await res.json();
          setModelLoadingState({ ...data, backendDown: false });
          // Sync selectedModel with real active model (only when ready + connected)
          // Don't override during model switch (user already selected the target).
          // Read from the ref (always current), NOT the `modelSwitchStatus` state —
          // this effect only runs once ([] deps), so the state would otherwise stay
          // stuck at its initial `null` value forever and this guard would never work.
          if (data.state === 'ready' && data.activeModel && data.connected && !modelSwitchStatusRef.current) {
            setSelectedModel(prev => {
              if (prev !== data.activeModel) {
                localStorage.setItem('ace-model', data.activeModel);
                return data.activeModel;
              }
              return prev;
            });
            // Sync LM from server — unless user is actively editing settings
            if (!lmEditingRef.current) {
              if (data.activeLmModel) setLmModel(data.activeLmModel);
              if (data.activeLmBackend) setLmBackend(data.activeLmBackend);
            }
            // Always track the *actual* loaded LM (independent of editing state).
            // Empty string when backend reports no LM available.
            setActiveLmModel(typeof data.activeLmModel === 'string' ? data.activeLmModel : '');
            // Mark that at least one server poll has completed successfully so the
            // default-ON toggle effect can evaluate against real server state.
            setServerPollSeen(true);
          }
          // During loading, show the target model
          if (data.state === 'loading' && data.model) {
            setSelectedModel(data.model);
          }
          // Refresh models list
          const modelsRes = await fetch('/api/generate/models');
          if (modelsRes.ok) {
            const modelsData = await modelsRes.json();
            if (modelsData.models) setFetchedModels(modelsData.models);
          }
        }
      } catch {
        // Backend not reachable
        setModelLoadingState(prev => ({ ...prev, connected: false, backendDown: true }));
      }
    }, 2000);
    return () => clearInterval(poll);
  }, []);
  
  // Available models fetched from backend
  const [fetchedModels, setFetchedModels] = useState<{ name: string; is_active: boolean; is_preloaded: boolean }[]>([]);

  // Fallback model list when backend is unavailable
  // Model metadata
  // Map model ID to short display name
  // Check if model is a turbo variant (no CFG, max ~20 steps, euler only)
  const turboActive = isTurboModel(selectedModel);

  const [isUploadingReference, setIsUploadingReference] = useState(false);
  const [isUploadingSource, setIsUploadingSource] = useState(false);
  const [isTranscribingReference, setIsTranscribingReference] = useState(false);
  const transcribeAbortRef = useRef<AbortController | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // Vrai quand le dernier clic a genere malgre un pre-vol en echec : les
  // paroles manqueront. Sans ce signal, l'echec n'apparaissait que dans la
  // console du navigateur.
  const [preflightFailed, setPreflightFailed] = useState(false);
  const [isFormattingStyle, setIsFormattingStyle] = useState(false);
  const [isFormattingLyrics, setIsFormattingLyrics] = useState(false);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [dragKind, setDragKind] = useState<'file' | 'audio' | null>(null);
  const referenceInputRef = useRef<HTMLInputElement>(null);
  const sourceInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const [showAudioModal, setShowAudioModal] = useState(false);
  const [audioModalTarget, setAudioModalTarget] = useState<'reference' | 'source'>('reference');
  const [tempAudioUrl, setTempAudioUrl] = useState('');
  // Emplacement audio unifie : le mode decide de la case du payload ET du taskType.
  const [audioMode, setAudioMode] = useState<AudioModeId>('cover');
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

  // Reference tracks modal state
  const [referenceTracks, setReferenceTracks] = useState<ReferenceTrack[]>([]);
  const [isLoadingTracks, setIsLoadingTracks] = useState(false);
  const [playingTrackId, setPlayingTrackId] = useState<string | null>(null);
  const [playingTrackSource, setPlayingTrackSource] = useState<'uploads' | 'created' | null>(null);
  const modalAudioRef = useRef<HTMLAudioElement>(null);
  const [modalTrackTime, setModalTrackTime] = useState(0);
  const [modalTrackDuration, setModalTrackDuration] = useState(0);
  const [libraryTab, setLibraryTab] = useState<'uploads' | 'created'>('uploads');

  const createdTrackOptions = useMemo(() => {
    return createdSongs
      .filter(song => !song.isGenerating)
      .filter(song => (user ? song.userId === user.id : true))
      .filter(song => Boolean(song.audioUrl))
      .map(song => ({
        id: song.id,
        title: song.title || 'Untitled',
        audio_url: song.audioUrl!,
        duration: song.duration,
      }));
  }, [createdSongs, user]);

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

  // Resize Logic
  const [lyricsHeight, setLyricsHeight] = useState(() => {
    const saved = localStorage.getItem('acestep_lyrics_height');
    return saved ? parseInt(saved, 10) : 144; // Default h-36 is 144px (9rem * 16)
  });
  const [isResizing, setIsResizing] = useState(false);
  const lyricsRef = useRef<HTMLDivElement>(null);
  // Mirrors lyricsHeight so the mouseup handler below (whose effect only
  // depends on [isResizing]) reads the live value instead of a stale one
  // captured when the drag started.
  const lyricsHeightRef = useRef(lyricsHeight);

  // Auto-adjust LM backend and params when model changes (including initial load)
  // Auto-adjust ALL model-dependent settings (including initial load)
  //
  // Skipped once when `skipNextModelAdjustRef` is set — used by the "reuse
  // song" effect below, which restores a song's own inferenceSteps/
  // guidanceScale/useAdg alongside its ditModel. Without this guard, this
  // effect fires right after on the new `selectedModel` and immediately
  // overwrites those restored values with the new model's defaults.
  useEffect(() => {
    if (skipNextModelAdjustRef.current) {
      skipNextModelAdjustRef.current = false;
      return;
    }
    const turbo = isTurboModel(selectedModel);
    // Steps & guidance
    if (turbo) {
      setInferenceSteps(8);
      setGuidanceScale(0.0);
      setUseAdg(false);
      // Turbo: only euler + linear
      setSamplerMode('euler');
      setSchedulerType('linear');
    } else {
      setInferenceSteps(50);
      setGuidanceScale(7.0);
      setUseAdg(true);
    }
    // LM backend: XL models (~19GB) don't fit with vLLM (~9GB) on 24GB
    if (selectedModel.includes('xl')) {
      setLmBackend('pt');
    } else {
      setLmBackend('vllm');
    }
  }, [selectedModel]);

  // Auto-disable thinking and ADG when LoRA is loaded
  useEffect(() => {
    if (loraLoaded) {
      if (thinking) setThinking(false);
      if (useAdg) setUseAdg(false);
    }
  }, [loraLoaded]);

  // Load generation parameters from JSON file
  const handleLoadParamsFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target?.result as string);
        if (data.lyrics !== undefined) setLyrics(data.lyrics);
        if (data.style !== undefined) setStyle(data.style);
        if (data.title !== undefined) setTitle(data.title);
        if (data.caption !== undefined) setStyle(data.caption);
        if (data.instrumental !== undefined) setInstrumental(data.instrumental);
        if (data.vocal_language !== undefined) setVocalLanguage(data.vocal_language);
        if (data.bpm !== undefined) setBpm(data.bpm);
        if (data.key_scale !== undefined) setKeyScale(data.key_scale);
        if (data.time_signature !== undefined) setTimeSignature(data.time_signature);
        if (data.duration !== undefined) setDuration(data.duration);
        if (data.inference_steps !== undefined) setInferenceSteps(data.inference_steps);
        if (data.guidance_scale !== undefined) setGuidanceScale(data.guidance_scale);
        if (data.audio_format !== undefined) setAudioFormat(data.audio_format);
        if (data.infer_method !== undefined) setInferMethod(data.infer_method);
        if (data.seed !== undefined) { setSeed(data.seed); setRandomSeed(false); }
        if (data.shift !== undefined) setShift(data.shift);
        if (data.lm_temperature !== undefined) setLmTemperature(data.lm_temperature);
        if (data.lm_cfg_scale !== undefined) setLmCfgScale(data.lm_cfg_scale);
        if (data.lm_top_k !== undefined) setLmTopK(data.lm_top_k);
        if (data.lm_top_p !== undefined) setLmTopP(data.lm_top_p);
        if (data.lm_negative_prompt !== undefined) setLmNegativePrompt(data.lm_negative_prompt);
        if (data.task_type !== undefined) {
          setTaskType(data.task_type);
          // Le bloc AUDIO pilote desormais le taskType : on realigne le mode
          // pour que l'UI ne contredise pas les parametres restaures.
          if (data.task_type === 'repaint') setAudioMode('repaint');
          else if (data.task_type === 'cover' || data.task_type === 'audio2audio') setAudioMode('cover');
        }
        if (data.audio_codes !== undefined) setAudioCodes(data.audio_codes);
        if (data.repainting_start !== undefined) setRepaintingStart(data.repainting_start);
        if (data.repainting_end !== undefined) setRepaintingEnd(data.repainting_end);
        // Une valeur persistee egale a l'ancien defaut code en dur reintroduirait
        // le bug : on la traite comme vide pour laisser le serveur decider.
        if (data.instruction !== undefined) {
          setInstruction(data.instruction === LEGACY_INSTRUCTION_DEFAULT ? '' : data.instruction);
        }
        if (data.audio_cover_strength !== undefined) setAudioCoverStrength(data.audio_cover_strength);
        if (data.cover_noise_strength !== undefined) setCoverNoiseStrength(data.cover_noise_strength);
      } catch {
        console.error('Failed to parse parameters JSON');
      }
    };
    reader.readAsText(file);
    e.target.value = ''; // reset so same file can be reloaded
  };

  // Reuse Effect - must be after all state declarations
  useEffect(() => {
    if (initialData) {
      const s = initialData.song;
      const p = s.generationParams || {};
      setLyrics(s.lyrics || p.lyrics || '');
      setStyle(s.style || p.style || '');
      setTitle(s.title || '');
      setInstrumental(p.instrumental ?? (s.lyrics?.length === 0));
      // Restore ALL generation params
      if (p.vocalLanguage) setVocalLanguage(p.vocalLanguage);
      if (p.vocalGender) setVocalGender(p.vocalGender);
      if (p.bpm && p.bpm > 0) setBpm(p.bpm);
      if (p.keyScale) setKeyScale(p.keyScale);
      if (p.timeSignature) setTimeSignature(p.timeSignature);
      if (p.duration && p.duration > 0) setDuration(p.duration);
      if (p.inferenceSteps) setInferenceSteps(p.inferenceSteps);
      if (p.guidanceScale !== undefined) setGuidanceScale(p.guidanceScale);
      if (p.seed !== undefined && p.seed >= 0) { setSeed(p.seed); setRandomSeed(false); }
      if (p.shift !== undefined) setShift(p.shift);
      if (p.thinking !== undefined) setThinking(p.thinking);
      if (p.enhance !== undefined) setEnhance(p.enhance);
      if (p.audioFormat) setAudioFormat(p.audioFormat);
      if (p.inferMethod) setInferMethod(p.inferMethod);
      if (p.lmModel || p.lmBackend) {
        if (p.lmModel) setLmModel(p.lmModel);
        if (p.lmBackend) setLmBackend(p.lmBackend);
        lmEditingRef.current = true;
      }
      if (p.ditModel) {
        // Only arm the skip when the model actually changes — otherwise the
        // auto-adjust effect never re-runs for THIS restore (same model =
        // unchanged dependency), and the flag would sit armed until the
        // user's next manual model switch, wrongly skipping that one instead.
        if (p.ditModel !== selectedModel) {
          skipNextModelAdjustRef.current = true;
        }
        setSelectedModel(p.ditModel);
        localStorage.setItem('ace-model', p.ditModel);
      }
      if (p.useAdg !== undefined) setUseAdg(p.useAdg);
      if (p.lmTemperature !== undefined) setLmTemperature(p.lmTemperature);
      if (p.lmCfgScale !== undefined) setLmCfgScale(p.lmCfgScale);
      if (p.lmTopK !== undefined) setLmTopK(p.lmTopK);
      if (p.lmTopP !== undefined) setLmTopP(p.lmTopP);
    }
  }, [initialData]);

  useEffect(() => {
    if (!pendingAudioSelection) return;
    applyAudioTargetUrl(
      pendingAudioSelection.target,
      pendingAudioSelection.url,
      pendingAudioSelection.title
    );
    onAudioSelectionApplied?.();
  }, [pendingAudioSelection, onAudioSelectionApplied]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;

      // Calculate new height based on mouse position relative to the lyrics container top
      // We can't easily get the container top here without a ref to it, 
      // but we can use dy (delta y) from the previous position if we tracked it,
      // OR simpler: just update based on movement if we track the start.
      //
      // Better approach for absolute sizing: 
      // 1. Get the bounding rect of the textarea wrapper on mount/resize start? 
      //    We can just rely on the fact that we are dragging the bottom.
      //    So new height = currentMouseY - topOfElement.

      if (lyricsRef.current) {
        const rect = lyricsRef.current.getBoundingClientRect();
        const newHeight = e.clientY - rect.top;
        // detailed limits: min 96px (h-24), max 600px
        if (newHeight > 96 && newHeight < 600) {
          lyricsHeightRef.current = newHeight;
          setLyricsHeight(newHeight);
        }
      }
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      document.body.style.cursor = 'default';
      document.body.style.userSelect = 'auto';
      // Save height to localStorage — read from the ref (always current)
      // rather than the `lyricsHeight` closed over when the drag started,
      // which would otherwise persist a stale value.
      localStorage.setItem('acestep_lyrics_height', String(lyricsHeightRef.current));
    };

    if (isResizing) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'ns-resize';
      document.body.style.userSelect = 'none'; // Prevent text selection while dragging
    }

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'default';
      document.body.style.userSelect = 'auto';
    };
  }, [isResizing]);

  const refreshModels = useCallback(async () => {
    try {
      const modelsRes = await fetch('/api/generate/models');
      if (modelsRes.ok) {
        const data = await modelsRes.json();
        const models = data.models || [];
        if (models.length > 0) {
          setFetchedModels(models);
          // Always sync to the backend's active model
          const active = models.find((m: any) => m.is_active);
          if (active) {
            setSelectedModel(active.name);
            localStorage.setItem('ace-model', active.name);
          }
        }
      }
    } catch {
      // ignore - will use fallback model list
    }
  }, []);

  useEffect(() => {
    const loadModelsAndLimits = async () => {
      await refreshModels();

      // Fetch limits
      try {
        const response = await fetch('/api/generate/limits');
        if (!response.ok) return;
        const data = await response.json();
        if (typeof data.max_duration_with_lm === 'number') {
          setMaxDurationWithLm(data.max_duration_with_lm);
        }
        if (typeof data.max_duration_without_lm === 'number') {
          setMaxDurationWithoutLm(data.max_duration_without_lm);
        }
      } catch {
        // ignore limits fetch failures
      }
    };

    loadModelsAndLimits();
  }, []);

  // Re-fetch models after generation completes to update active model
  const prevIsGeneratingRef = useRef(isGenerating);
  useEffect(() => {
    if (prevIsGeneratingRef.current && !isGenerating) {
      void refreshModels();
    }
    prevIsGeneratingRef.current = isGenerating;
  }, [isGenerating, refreshModels]);

  const activeMaxDuration = thinking ? maxDurationWithLm : maxDurationWithoutLm;

  useEffect(() => {
    if (duration > activeMaxDuration) {
      setDuration(activeMaxDuration);
    }
  }, [duration, activeMaxDuration]);

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
      setDragKind(kind);
      e.preventDefault();
    };

    const handleDragOver = (e: DragEvent) => {
      const kind = getDragKind(e);
      if (!kind) return;
      setDragKind(kind);
    };

    const handleDragLeave = (e: DragEvent) => {
      const kind = getDragKind(e);
      if (!kind) return;
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) {
        setIsDraggingFile(false);
        setDragKind(null);
      }
    };

    const handleDrop = (e: DragEvent) => {
      const kind = getDragKind(e);
      if (!kind) return;
      e.preventDefault();
      dragDepthRef.current = 0;
      setIsDraggingFile(false);
      setDragKind(null);
    };

    window.addEventListener('dragenter', handleDragEnter);
    window.addEventListener('dragover', handleDragOver);
    window.addEventListener('dragleave', handleDragLeave);
    window.addEventListener('drop', handleDrop);

    return () => {
      window.removeEventListener('dragenter', handleDragEnter);
      window.removeEventListener('dragover', handleDragOver);
      window.removeEventListener('dragleave', handleDragLeave);
      window.removeEventListener('drop', handleDrop);
    };
  }, []);

  const startResizing = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>, target: 'reference' | 'source') => {
    const file = e.target.files?.[0];
    if (file) {
      void uploadReferenceTrack(file, target);
    }
    e.target.value = '';
  };

  // Generate from scratch via createSample
  const [isGeneratingLyrics, setIsGeneratingLyrics] = useState(false);
  const [isGeneratingStyle, setIsGeneratingStyle] = useState(false);

  // OpenRouter generation hook. Uses refs to thread the live activeOp/activePrimary
  // into the onPartial callback (which captures values at first render otherwise).
  const orActiveOpRef = useRef<'generate' | 'format' | null>(null);
  const orActivePrimaryRef = useRef<'lyrics' | 'caption' | null>(null);
  const bpmRef = useRef(bpm); bpmRef.current = bpm;
  const durationRef = useRef(duration); durationRef.current = duration;
  const keyScaleRef = useRef(keyScale); keyScaleRef.current = keyScale;
  const timeSignatureRef = useRef(timeSignature); timeSignatureRef.current = timeSignature;
  // Refs the simple-mode→OR pre-flight reads after `await` to avoid stale
  // closure on the captured React state (which reflects the click moment,
  // not the post-streaming filled values).
  const styleRef = useRef(style); styleRef.current = style;
  const lyricsTextRef = useRef(lyrics); lyricsTextRef.current = lyrics;
  const titleRef = useRef(title); titleRef.current = title;

  const orHook = useOpenRouterGeneration({
    onPartial: (partial, openField) => {
      const activeOp = orActiveOpRef.current;
      const activePrimary = orActivePrimaryRef.current;

      // Primary semantic fills
      if (partial.caption && (activeOp === 'format' || activePrimary === 'caption')) {
        setStyle(partial.caption);
      }
      if (partial.lyrics && (
        activePrimary === 'lyrics' ||
        (activeOp === 'format' && activePrimary === 'caption')
      )) {
        setLyrics(partial.lyrics);
      }

      // Live-stream the open string field char-by-char into its textarea
      if (openField?.name === 'lyrics' && activePrimary === 'lyrics') {
        setLyrics(openField.valueSoFar);
      }
      if (openField?.name === 'caption' && activePrimary === 'caption') {
        setStyle(openField.valueSoFar);
      }

      // Aux fields: only-if-empty
      if (partial.bpm && bpmRef.current === 0) setBpm(partial.bpm);
      if (partial.durationSec && durationRef.current <= 0) setDuration(partial.durationSec);
      if (partial.keyScale && !keyScaleRef.current) setKeyScale(partial.keyScale);
      if (partial.timeSignature && !timeSignatureRef.current) {
        const ts = String(partial.timeSignature);
        setTimeSignature(ts.includes('/') ? ts : `${ts}/4`);
      }
    },
    onFinal: (_draft: SongDraft) => {
      setLastOpenRouterModelId(llmStorage.getOpenRouter().model);
    },
  });

  // Keep refs in sync with the hook's published state. onPartial fires *during*
  // a run, so we also set refs eagerly inside the run-dispatch branches below.
  useEffect(() => {
    orActiveOpRef.current = orHook.activeOp;
    orActivePrimaryRef.current = orHook.activePrimary;
  }, [orHook.activeOp, orHook.activePrimary]);

  const handleAiGenerate = async (target: 'style' | 'lyrics') => {
    if (useOpenRouter) {
      if (!style.trim()) return;
      const primary = target === 'style' ? 'caption' : 'lyrics';
      orActiveOpRef.current = 'generate';
      orActivePrimaryRef.current = primary;
      orHook.runGenerate({
        topic: style,
        primary,
        language: vocalLanguage || 'en',
        instrumental: target === 'style' ? instrumental : false,
        durationSec: duration > 0 ? duration : undefined,
        thinking,
      });
      return;
    }
    if (!token || !style.trim()) return;
    if (target === 'lyrics') setIsGeneratingLyrics(true);
    else setIsGeneratingStyle(true);
    try {
      const sample = await generateApi.createSample({
        query: style,
        instrumental: target === 'style' ? instrumental : false,
        vocalLanguage: vocalLanguage || 'en',
        lmTemperature,
        lmTopK: lmTopK > 0 ? lmTopK : undefined,
        lmTopP,
      }, token);
      if (target === 'lyrics') {
        if (sample.lyrics) setLyrics(sample.lyrics);
      } else {
        if (sample.caption) setStyle(sample.caption);
      }
      // Only fill from AI if user left it on Auto
      if (sample.bpm && sample.bpm > 0 && bpm === 0) setBpm(sample.bpm);
      if (sample.duration && sample.duration > 0 && duration <= 0) setDuration(sample.duration);
      if (sample.keyScale && !keyScale) setKeyScale(sample.keyScale);
      if (sample.timeSignature && !timeSignature) {
        const ts = String(sample.timeSignature);
        setTimeSignature(ts.includes('/') ? ts : `${ts}/4`);
      }
    } catch (e) { console.error('Generate failed:', e); }
    finally {
      if (target === 'lyrics') setIsGeneratingLyrics(false);
      else setIsGeneratingStyle(false);
    }
  };

  // Format/enhance existing content via LLM
  const handleFormat = async (target: 'style' | 'lyrics') => {
    if (useOpenRouter) {
      if (target === 'style' && !style.trim()) return;
      if (target === 'lyrics' && !lyrics.trim()) return;
      const primary = target === 'style' ? 'caption' : 'lyrics';
      orActiveOpRef.current = 'format';
      orActivePrimaryRef.current = primary;
      orHook.runFormat({
        caption: style,
        lyrics,
        bpm: bpm > 0 ? bpm : undefined,
        durationSec: duration > 0 ? duration : undefined,
        keyScale: keyScale || undefined,
        timeSignature: timeSignature || undefined,
        language: vocalLanguage || 'en',
        instrumental: target === 'style' ? instrumental : false,
        primary,
        thinking,
      });
      return;
    }
    if (!token) return;
    if (target === 'style' && !style.trim()) return;
    if (target === 'lyrics' && !lyrics.trim()) return;
    if (target === 'style') {
      setIsFormattingStyle(true);
    } else {
      setIsFormattingLyrics(true);
    }
    try {
      if (target === 'lyrics') {
        // Enhance existing lyrics via format endpoint
        const result = await generateApi.formatInput({
          caption: style,
          lyrics: lyrics,
          bpm: bpm > 0 ? bpm : undefined,
          duration: duration > 0 ? duration : undefined,
          keyScale: keyScale || undefined,
          timeSignature: timeSignature || undefined,
          temperature: lmTemperature,
          topK: lmTopK > 0 ? lmTopK : undefined,
          topP: lmTopP,
          lmModel: lmModel || 'acestep-5Hz-lm-0.6B',
          lmBackend: lmBackend || 'pt',
        }, token);
        if (result.lyrics) setLyrics(result.lyrics);
        if (result.bpm && result.bpm > 0 && bpm === 0) setBpm(result.bpm);
        if (result.duration && result.duration > 0 && duration <= 0) setDuration(result.duration);
        if (result.key_scale && !keyScale) setKeyScale(result.key_scale);
        if (result.time_signature && !timeSignature) {
          const ts = String(result.time_signature);
          setTimeSignature(ts.includes('/') ? ts : `${ts}/4`);
        }
      } else {
        // Format existing content via /format endpoint
        const result = await generateApi.formatInput({
          caption: style,
          lyrics: lyrics,
          bpm: bpm > 0 ? bpm : undefined,
          duration: duration > 0 ? duration : undefined,
          keyScale: keyScale || undefined,
          timeSignature: timeSignature || undefined,
          temperature: lmTemperature,
          topK: lmTopK > 0 ? lmTopK : undefined,
          topP: lmTopP,
          lmModel: lmModel || 'acestep-5Hz-lm-0.6B',
          lmBackend: lmBackend || 'pt',
          vocalLanguage: vocalLanguage || 'en',
        }, token);

        if (result.caption || result.lyrics || result.bpm || result.duration) {
          if (result.caption) setStyle(result.caption);
          if (result.lyrics) setLyrics(result.lyrics);
          if (result.bpm && result.bpm > 0 && bpm === 0) setBpm(result.bpm);
          if (result.duration && result.duration > 0 && duration <= 0) setDuration(result.duration);
          if (result.key_scale && !keyScale) setKeyScale(result.key_scale);
          if (result.time_signature && !timeSignature) {
            const ts = String(result.time_signature);
            setTimeSignature(ts.includes('/') ? ts : `${ts}/4`);
          }
          if (target === 'style') setIsFormatCaption(true);
        } else {
          console.error('Format failed:', result.error || result.status_message);
          alert(result.error || result.status_message || 'Format failed. Make sure the LLM is initialized.');
        }
      }
    } catch (err) {
      console.error('Format error:', err);
      alert('Format failed. The LLM may not be available.');
    } finally {
      if (target === 'style') {
        setIsFormattingStyle(false);
      } else {
        setIsFormattingLyrics(false);
      }
    }
  };

  const openAudioModal = (target: 'reference' | 'source', tab: 'uploads' | 'created' = 'uploads') => {
    setAudioModalTarget(target);
    setTempAudioUrl('');
    setLibraryTab(tab);
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

      // Also set as current reference/source
      applyAudioTargetUrl(selectedTarget, data.track.audio_url, data.track.filename);
      if (data.whisper_available && data.track?.id) {
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
        if (playingTrackId === trackId && playingTrackSource === 'uploads') {
          setPlayingTrackId(null);
          setPlayingTrackSource(null);
          if (modalAudioRef.current) {
            modalAudioRef.current.pause();
          }
        }
      }
    } catch (err) {
      console.error('Failed to delete track:', err);
    }
  };

  const useReferenceTrack = (track: { audio_url: string; title?: string }) => {
    applyAudioTargetUrl(audioModalTarget, track.audio_url, track.title);
    setShowAudioModal(false);
    setPlayingTrackId(null);
    setPlayingTrackSource(null);
  };

  const toggleModalTrack = (track: { id: string; audio_url: string; source: 'uploads' | 'created' }) => {
    if (playingTrackId === track.id) {
      if (modalAudioRef.current) {
        modalAudioRef.current.pause();
      }
      setPlayingTrackId(null);
      setPlayingTrackSource(null);
    } else {
      setPlayingTrackId(track.id);
      setPlayingTrackSource(track.source);
      if (modalAudioRef.current) {
        modalAudioRef.current.src = track.audio_url;
        modalAudioRef.current.play().catch(() => undefined);
      }
    }
  };

  const applyAudioUrl = () => {
    if (!tempAudioUrl.trim()) return;
    applyAudioTargetUrl(audioModalTarget, tempAudioUrl.trim());
    setShowAudioModal(false);
    setTempAudioUrl('');
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
  const applyAudioTargetUrl = (target: 'reference' | 'source', url: string, title?: string) => {
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
    const mode = AUDIO_MODE_MAP[audioMode];
    setTaskType(mode.field === target ? mode.taskType : 'text2music');
  };

  // Changement de mode : on deplace le fichier deja charge vers la case que le
  // nouveau mode va reellement lire, pour ne pas le perdre silencieusement.
  const changeAudioMode = (id: AudioModeId) => {
    const next = AUDIO_MODE_MAP[id];
    if (!next || !next.available) return;
    const prev = AUDIO_MODE_MAP[audioMode];
    setShowAudioMenu(false);
    setAudioMode(id);

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
  };

  const formatTime = (time: number) => {
    if (!Number.isFinite(time) || time <= 0) return '0:00';
    const minutes = Math.floor(time / 60);
    const seconds = Math.floor(time % 60);
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
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
  const isRepaintMode = audioMode === 'repaint';

  const clearActiveAudio = () => {
    if (isReferenceTarget) clearReferenceSlot(); else clearSourceSlot();
    setTaskType('text2music');
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>, target: 'reference' | 'source') => {
    e.preventDefault();
    // Le listener global sur window ne recevra pas cet événement à cause du
    // stopPropagation() des zones de dépôt : on réinitialise l'état ici.
    dragDepthRef.current = 0;
    setIsDraggingFile(false);
    setDragKind(null);
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

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
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

  // --- Pre-vol OpenRouter : conditions de declenchement --------------------
  // Le pre-vol se declenche des que les PAROLES sont vides : c'est le champ
  // que personne d'autre ne remplit (le LM local sait ecrire des paroles mais
  // pas de style, et rien ne les genere sur la route text2music standard).
  // Exiger aussi un style vide, comme dans une premiere version, laissait le
  // cas « style ecrit + paroles vides » sans aucun redacteur.
  const preflightWillRun =
    useOpenRouter && Boolean(songDescription.trim()) && !lyrics.trim();
  // Ce que le pre-vol comblera reellement : un champ deja rempli par
  // l'utilisateur n'est jamais ecrase (voir la resolution des eff* plus bas).
  const preflightWillFillStyle = preflightWillRun && !style.trim();
  // Le serveur (generate.ts l.423) exige style OU paroles OU audio de
  // reference. Quand l'un des trois est deja la, un echec du pre-vol ne doit
  // pas faire tomber la generation : on part sans le brouillon.
  const payloadValidWithoutDraft =
    Boolean(style.trim() || lyrics.trim() || referenceAudioUrl.trim() || sourceAudioUrl.trim());
  // Description saisie, rien pour la developper, et rien d'autre a envoyer :
  // la requete partirait en 400 « Style, lyrics, or reference audio required ».
  const descriptionCannotBeUsed =
    Boolean(songDescription.trim()) && !lyrics.trim() && !style.trim()
    && !useOpenRouter && !referenceAudioUrl.trim() && !sourceAudioUrl.trim();

  const handleGenerate = async () => {
    // Per-click LLM draft from pre-flight (used to populate effStyle/effLyrics/etc
    // and the Pollinations cover prompt). null = pre-flight either didn't run
    // (custom mode or local LM available) or failed (we'd have early-returned).
    // MUST be local to handleGenerate — declared at component-body scope, two
    // overlapping clicks within the same render would share the variable and
    // one would clobber the other's draft.
    let perClickDraft: SongDraft | null = null;

    // INSTANT visual feedback — bump the N/10 counter synchronously so the
    // user sees the click registered before LLM pre-flight kicks in. Each
    // bulk variant is its own slot in the badge (bulkCount=10 → +10).
    // The pending counter is handed off to the active counter inside
    // App.tsx after beginPollingJob registers each job — that keeps the
    // total continuous and avoids the 1→0→1 blink between pre-flight and
    // polling. Early-return / failure paths release the slot manually.
    // Echec previsible cote serveur : autant le dire ici plutot que de laisser
    // un 400 dans la console et une carte fantome dans la liste.
    // Le message est deja affiche en rouge sous la description ; ici on se
    // contente de ne pas partir, pour eviter le 400 et la carte fantome.
    if (descriptionCannotBeUsed) return;

    setPreflightFailed(false);
    const slotsClaimed = bulkCount;
    incrementPendingClicks?.(slotsClaimed);
    // Create a visible placeholder card per bulk variant — instant feedback.
    const tempIds: string[] = [];
    if (createTempSongForClick) {
      const previewBase = (title || style || lyrics || songDescription || 'Track').slice(0, 60);
      for (let i = 0; i < slotsClaimed; i++) {
        const preview = slotsClaimed > 1 ? `${previewBase} (${i + 1})` : previewBase;
        tempIds.push(createTempSongForClick(preview, selectedModel));
      }
    }
    let claimedSlotsRemaining = slotsClaimed;
    const releaseClaimedSlots = () => {
      if (claimedSlotsRemaining > 0) {
        decrementPendingClicks?.(claimedSlotsRemaining);
        // Remove any placeholder cards that never got promoted to real jobs.
        if (removeTempSongForClick) tempIds.forEach(id => removeTempSongForClick(id));
        claimedSlotsRemaining = 0;
      }
    };
    try {
    // Simple mode + OpenRouter ON + no local LM = pre-flight: ask OR to expand
    // the user's description into caption/lyrics/metadata, fill the same fields
    // a Custom-mode submission would have, then proceed as Custom.
    //
    // SEQUENTIAL queue: bulk clicks chain through llmPreflightQueueRef. Each
    // click also waits for waitForJobsToDrain() — the previous track's full
    // pipeline (LLM + audio + cover) must be done before the next click's LLM
    // even starts. This matches the user's "queue" mental model.
    //
    // CRITICAL: this MUST NOT use the shared `orHook` singleton — that hook is
    // single-flight and would conflict with explicit AI-Generate buttons.
    // We spawn a fresh OpenRouterProvider per click instead.
    // Pré-vol : style ET paroles vides + une description à développer.
    // Voir `preflightWillRun` plus haut pour le raisonnement.
    if (preflightWillRun) {
      // CRITICAL: `.catch(() => null)` BEFORE `.then` is the chain firewall —
      // it absorbs any rejection from the previous chain step so the FIFO
      // ref stays usable. Without it, one bad pre-flight permanently rejects
      // the chain and every future click inherits the rejection (LLM never
      // runs until reload).
      llmPreflightQueueRef.current = llmPreflightQueueRef.current.catch(() => null).then(async () => {
        if (waitForJobsToDrain) {
          try { await waitForJobsToDrain(); } catch { /* drain failures don't block our turn */ }
        }
        // Promote the placeholder card(s) — connecting to OpenRouter.
        // Stage gets refined as the OR stream progresses (see onEvent below):
        //   stageOpenRouterConnecting → stageOpenRouterStreaming → stageOpenRouterFinalizing
        // so the user sees concrete progress instead of a single static label.
        if (updateTempSongForClick) {
          tempIds.forEach(id => updateTempSongForClick(id, { stage: 'stageOpenRouterConnecting' }));
        }
        const ac = new AbortController();
        // Hard timeout — OpenRouter sometimes hangs (rate-limit, model
        // outage, network drop) and the user is left with a stuck card
        // and no way out. 90 s is generous for any thinking model + buffer
        // for streaming response; longer than that means the call is
        // effectively dead. AbortController.abort() drops the fetch and
        // throws AbortError out of client.generate(), which we catch below.
        const timeoutId = setTimeout(() => ac.abort(), 90_000);
        // Register so the user-facing cancel button (SongList row + Cancel-all)
        // can abort the in-flight HTTP request. We register against the FIRST
        // tempId of the bulk batch — if the user cancels we abort the whole
        // batch (Promise rejects → all tempIds get released together).
        if (tempIds[0] && registerPreflightAbort) {
          registerPreflightAbort(tempIds[0], ac);
        }
        try {
          const client = new OpenRouterProvider();
          return await client.generate(
            {
              topic: songDescription,
              primary: 'lyrics',
              language: vocalLanguage || 'en',
              instrumental,
              durationSec: duration > 0 ? duration : undefined,
              thinking,
            },
            {
              signal: ac.signal,
              onEvent: (ev) => {
                // Refine stage labels based on stream progress so the user
                // sees concrete state transitions: firstChunk = response is
                // arriving (model started generating), streamDone = stream
                // closed and we're parsing the JSON / validating fields.
                if (!updateTempSongForClick) return;
                if (ev.type === 'firstChunk') {
                  tempIds.forEach(id => updateTempSongForClick(id, { stage: 'stageOpenRouterStreaming' }));
                } else if (ev.type === 'streamDone') {
                  tempIds.forEach(id => updateTempSongForClick(id, { stage: 'stageOpenRouterFinalizing' }));
                }
              },
            },
          );
        } catch (e: any) {
          if (e?.name === 'AbortError' || ac.signal.aborted) {
            // Either user-clicked-cancel or our 90 s timeout fired. Either
            // way the chain step bails — the catch in the awaiting block
            // below releases slots and removes the placeholder card.
            console.warn('[Simple+OR] pre-flight aborted (cancel or timeout)');
          } else {
            console.error('[Simple+OR] pre-flight failed:', e);
          }
          return null;
        } finally {
          clearTimeout(timeoutId);
          if (tempIds[0] && unregisterPreflightAbort) {
            unregisterPreflightAbort(tempIds[0]);
          }
        }
      });
      try {
        perClickDraft = await llmPreflightQueueRef.current;
        // Echec du pre-vol (cle OpenRouter refusee, delai depasse, modele
        // indisponible…). On n'abandonne que si rien d'autre ne peut porter la
        // requete — sinon on genere sans les paroles plutot que de ne rien
        // faire, ce qui laissait l'utilisateur devant un bouton sans effet.
        if (!perClickDraft) {
          if (!payloadValidWithoutDraft) { releaseClaimedSlots(); return; }
          setPreflightFailed(true);
        }
        // Stamp the model id used for this song — `orHook` only updates this
        // for the explicit AI buttons, not the Simple-mode pre-flight, so
        // without this `params.openrouterModel` would always be null for
        // Simple+OR generations and the song-row badge tooltip would be empty.
        const orModelId = llmStorage.getOpenRouter().model;
        if (orModelId) setLastOpenRouterModelId(orModelId);
      } catch (e) {
        console.error('[Simple+OR] queued pre-flight failed:', e);
        if (!payloadValidWithoutDraft) { releaseClaimedSlots(); return; }
        setPreflightFailed(true);
        perClickDraft = null;
      }
    }

    // Charge utile unique depuis la suppression du mode Simple.
    const effectiveCustomMode = true;
    const d = perClickDraft;
    // Priorite : ce que l'utilisateur a ecrit dans le champ, puis le brouillon
    // du pre-vol de ce clic, puis la ref (derniere generation streamee).
    // L'ordre inverse ecrasait un style saisi a la main par la caption du LLM.
    const effStyle = style.trim() || d?.caption || styleRef.current || style;
    const effLyrics = lyrics.trim() || d?.lyrics || lyricsTextRef.current || lyrics;
    const effTitle = title.trim() || d?.title || titleRef.current || title;
    const effBpm = effectiveCustomMode && (d?.bpm || bpmRef.current) > 0 ? (d?.bpm || bpmRef.current) : bpm;
    const effKeyScale = effectiveCustomMode && (d?.keyScale || keyScaleRef.current) ? (d?.keyScale || keyScaleRef.current) : keyScale;
    const effTimeSig = effectiveCustomMode && (d?.timeSignature || timeSignatureRef.current) ? (d?.timeSignature || timeSignatureRef.current) : timeSignature;
    const effDuration = effectiveCustomMode && (d?.durationSec || durationRef.current) > 0 ? (d?.durationSec || durationRef.current) : duration;
    // LLM-tailored cover prompt for this exact song. Empty string falls
    // through to the keyword-based default in buildCoverPrompt.
    const effCoverPrompt = d?.coverPrompt || '';

    const styleWithGender = (() => {
      if (!vocalGender) return effStyle;
      const genderHint = vocalGender === 'male' ? 'Male vocals' : 'Female vocals';
      const trimmed = effStyle.trim();
      return trimmed ? `${trimmed}\n${genderHint}` : genderHint;
    })();

// Le moteur ignore le drapeau `instrumental` de la charge utile : seul le
    // contenu du champ paroles est interprété. On force donc le marqueur qu'il
    // reconnaît, et on neutralise l'indice de genre vocal, qui pousserait le
    // modèle vers du chant.
    const finalLyrics = instrumental ? '[Instrumental]' : effLyrics;
    const finalStyle = instrumental ? effStyle : styleWithGender;

    // Bulk generation: loop bulkCount times
    for (let i = 0; i < bulkCount; i++) {
      // Seed handling: first job uses user's seed, rest get random seeds
      let jobSeed = -1;
      if (!randomSeed && i === 0) {
        jobSeed = seed;
      } else if (!randomSeed && i > 0) {
        // Subsequent jobs get random seeds for variety
        jobSeed = Math.floor(Math.random() * 4294967295);
      }

      // Charge utile unique : tous les paramètres configurés par l'utilisateur.
      // Pass the pre-created placeholder tempId so App.tsx promotes it instead
      // of creating a duplicate card.
      const tempIdForThisJob = tempIds[i];
      onGenerate({
        _tempId: tempIdForThisJob,
        customMode: true,
        prompt: finalLyrics,
        lyrics: finalLyrics,
        style: finalStyle,
        title: bulkCount > 1 ? `${effTitle} (${i + 1})` : effTitle,
        ditModel: selectedModel,
        instrumental,
        vocalLanguage,
        bpm: effBpm,
        keyScale: effKeyScale,
        timeSignature: effTimeSig,
        duration: effDuration,
        inferenceSteps,
        guidanceScale,
        batchSize,
        randomSeed: randomSeed || i > 0,
        seed: jobSeed,
        thinking: !activeLmModel ? false : thinking,
        // Read directly from llmStorage rather than relying on the
        // `lastOpenRouterModelId` state — React state setters are async and
        // the value set in the pre-flight chain may not be observable on the
        // first click of a session by the time this synchronous closure
        // captures it. The localStorage read is sync and always fresh.
        openrouterModel: (useOpenRouter ? llmStorage.getOpenRouter().model : '') || lastOpenRouterModelId,
        // Pollinations cover-gen config — backend handles cover gen async on
        // queued→running transition (see app/server/src/routes/generate.ts).
        pollinations: usePollinations ? (() => {
          const polCfg = pollinationsStorage.getConfig();
          return {
            enabled: true,
            apiKey: polCfg.apiKey,
            model: polCfg.model,
            width: polCfg.width,
            height: polCfg.height,
            seedMode: polCfg.seedMode,
            enhance: polCfg.enhance,
            nologo: polCfg.nologo,
            safe: polCfg.safe,
            // Prefer the LLM-tailored cover prompt (visual sentences derived
            // from the lyrics) when available; fall back to a keyword-based
            // prompt assembled from caption/topic.
            prompt: effCoverPrompt || buildCoverPrompt({
              title: effTitle,
              caption: styleWithGender,
              topic: songDescription,
              language: vocalLanguage,
              instrumental,
            }),
          };
        })() : { enabled: false },
        enhance,
        audioFormat,
        inferMethod,
        lmBackend,
        lmModel,
        shift,
        lmTemperature,
        lmCfgScale,
        lmTopK,
        lmTopP,
        lmNegativePrompt,
        referenceAudioUrl: referenceAudioUrl.trim() || undefined,
        sourceAudioUrl: sourceAudioUrl.trim() || undefined,
        referenceAudioTitle: referenceAudioTitle.trim() || undefined,
        sourceAudioTitle: sourceAudioTitle.trim() || undefined,
        audioCodes: audioCodes.trim() || undefined,
        repaintingStart,
        repaintingEnd,
        instruction,
        audioCoverStrength,
        coverNoiseStrength,
        taskType,
        useAdg,
        cfgIntervalStart,
        cfgIntervalEnd,
        customTimesteps: customTimesteps.trim() || undefined,
        useCotMetas,
        useCotCaption,
        useCotLanguage,
        autogen,
        constrainedDecodingDebug,
        allowLmBatch,
        getScores,
        getLrc,
        scoreScale,
        lmBatchChunkSize,
        trackName: trackName.trim() || undefined,
        completeTrackClasses: (() => {
          const parsed = completeTrackClasses
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean);
          return parsed.length ? parsed : undefined;
        })(),
        isFormatCaption,
        samplerMode,
        schedulerType,
        dcwEnabled,
        dcwMode,
        dcwScaler,
        dcwHighScaler,
        dcwWavelet,
        retakeSeed: retakeEnabled ? (Number(retakeSeed) || -1) : -1,
        retakeVariance: retakeEnabled ? retakeVariance : 0,
        flowEditMorph,
        flowEditSourceCaption,
        flowEditSourceLyrics,
        flowEditNMin,
        flowEditNMax,
        flowEditNAvg,
        mp3Bitrate,
        mp3SampleRate,
        fadeInDuration: fadeInDuration > 0 ? fadeInDuration : undefined,
        fadeOutDuration: fadeOutDuration > 0 ? fadeOutDuration : undefined,
        repaintMode: taskType === 'repaint' ? repaintMode : undefined,
        repaintStrength: taskType === 'repaint' ? repaintStrength : undefined,
        loraLoaded,

      });
    }

    // Don't reset BPM/Key/Duration — user's manual values should persist.
    // Auto (0/'') means the model picks, manual values stay as set.

    // Reset bulk count after generation
    if (bulkCount > 1) {
      setBulkCount(1);
    }
    } catch (e) {
      // Hard failure inside handleGenerate (rare — pre-flight already has its
      // own catch). Release every slot we claimed so the badge doesn't stick.
      console.error('handleGenerate crashed:', e);
      releaseClaimedSlots();
    }
    // NOTE: success path does NOT release here. Each onGenerate call hands
    // off a slot to the active counter inside App.tsx (decrementPendingClicks
    // after beginPollingJob). Releasing here would cause a 1→0→1 blink while
    // the POST is still in flight.
  };

  // Derived per-button active flags — combine local-LM in-flight booleans with
  // the OpenRouter hook's active op/primary so each button shows its own loader
  // and others stay disabled while a run is in flight.
  const isGenLyricsActive = isGeneratingLyrics || (orHook.activeOp === 'generate' && orHook.activePrimary === 'lyrics');
  const isFmtLyricsActive = isFormattingLyrics || (orHook.activeOp === 'format' && orHook.activePrimary === 'lyrics');
  const isGenStyleActive  = isGeneratingStyle  || (orHook.activeOp === 'generate' && orHook.activePrimary === 'caption');
  const isFmtStyleActive  = isFormattingStyle  || (orHook.activeOp === 'format' && orHook.activePrimary === 'caption');
  const orRunning = orHook.activeOp !== null;
  // Reflects whichever target (reference/source) the audio modal is
  // currently uploading for — see uploadReferenceTrack.
  const isUploadingModalTarget = audioModalTarget === 'source' ? isUploadingSource : isUploadingReference;

  return (
    <div
      className="relative flex flex-col h-full bg-zinc-50 dark:bg-suno-panel w-full overflow-y-auto custom-scrollbar transition-colors duration-300"
    >
      {/* No overlay — drop targets are the Reference and Cover fields themselves */}
      <div className="p-4 pt-14 md:pt-4 pb-24 lg:pb-32 space-y-5">
        <input
          ref={referenceInputRef}
          type="file"
          accept="audio/*"
          onChange={(e) => handleFileSelect(e, 'reference')}
          className="hidden"
        />
        <input
          ref={sourceInputRef}
          type="file"
          accept="audio/*"
          onChange={(e) => handleFileSelect(e, 'source')}
          className="hidden"
        />
        <audio
          ref={referenceAudioRef}
          src={referenceAudioUrl || undefined}
          onPlay={() => setReferencePlaying(true)}
          onPause={() => setReferencePlaying(false)}
          onEnded={() => setReferencePlaying(false)}
          onTimeUpdate={(e) => setReferenceTime(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => setReferenceDuration(e.currentTarget.duration || 0)}
        />
        <audio
          ref={sourceAudioRef}
          src={sourceAudioUrl || undefined}
          onPlay={() => setSourcePlaying(true)}
          onPause={() => setSourcePlaying(false)}
          onEnded={() => setSourcePlaying(false)}
          onTimeUpdate={(e) => setSourceTime(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => setSourceDuration(e.currentTarget.duration || 0)}
        />

        {/* Header Row 1 - ACE-Step + Model Selection */}
        <ModelMenu
          selectedModel={selectedModel}
          setSelectedModel={setSelectedModel}
          modelLoadingState={modelLoadingState}
          fetchedModels={fetchedModels}
          setFetchedModels={setFetchedModels}
          setModelSwitchStatus={setModelSwitchStatus}
          token={token}
          lmModel={lmModel}
          lmBackend={lmBackend}
          lmEditingRef={lmEditingRef}
        />

        {/* PANNEAU DE CRÉATION — mode unique depuis la suppression de
            Simple / Personnalisé. Les deux modes construisaient des charges
            utiles divergentes, source de plusieurs bugs (voir §12). */}
          <div className="space-y-5">
            {/* Song Description */}
            <div className="bg-white dark:bg-suno-card rounded-xl border border-zinc-200 dark:border-white/5 overflow-hidden">
              <div className="px-3 py-2.5 flex items-center justify-between border-b border-zinc-100 dark:border-white/5 bg-zinc-50 dark:bg-white/5">
                <span className="text-xs font-bold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                  {t('describeYourSong')}
                </span>
                <button
                  type="button"
                  onClick={async () => {
                    if (!token) return;
                    try {
                      const result = await generateApi.getRandomDescription(token);
                      setSongDescription(result.description);
                      // Don't override user's instrumental/language settings from random description
                    } catch (err) {
                      console.error('Failed to load random description:', err);
                    }
                  }}
                  title={tf('hintLoadRandom', 'Load random description')}
                  className="p-1 rounded-md text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 hover:bg-zinc-200 dark:hover:bg-white/10 transition-colors"
                >
                  <Dices size={14} />
                </button>
              </div>
              <textarea
                value={songDescription}
                onChange={(e) => setSongDescription(e.target.value)}
                placeholder={t('songDescriptionPlaceholder')}
                className="w-full h-32 bg-transparent p-3 text-sm text-zinc-900 dark:text-white placeholder-zinc-400 dark:placeholder-zinc-600 focus:outline-none resize-none"
              />
              {/* Le pre-vol n'est plus declenche par un mode mais par l'etat des
                  champs : on l'annonce, sinon le comportement est invisible. */}
              {preflightWillRun && (
                <p className="px-3 pb-2.5 text-[10px] text-pink-500">
                  {preflightWillFillStyle
                    ? tf('hintPreflightActive', 'OpenRouter développera cette description en style et paroles à la génération.')
                    : tf('hintPreflightLyricsOnly', 'OpenRouter écrira les paroles à partir de cette description. Le style saisi est conservé.')}
                </p>
              )}
              {descriptionCannotBeUsed && (
                <p className="px-3 pb-2.5 text-[10px] text-red-500">
                  {tf('hintPreflightImpossible', 'Rien ne peut développer cette description : active OpenRouter, ou remplis Style ou Paroles.')}
                </p>
              )}
              {Boolean(songDescription.trim()) && !preflightWillRun && !descriptionCannotBeUsed && (
                <p className="px-3 pb-2.5 text-[10px] text-zinc-400 dark:text-zinc-500">
                  {lyrics.trim()
                    ? tf('hintPreflightSkipped', 'Des paroles sont déjà écrites : la description ne sera pas développée.')
                    : tf('hintPreflightNoOr', 'OpenRouter est désactivé : la description ne sera pas développée en paroles.')}
                </p>
              )}
            </div>

            {/* ─────────────────────────────────────────────────────────────
                AUDIO — emplacement unique + menu de mode (facon Suno).
                Remplace les deux anciennes fenetres RÉFÉRENCE et REPRISE :
                le pipeline n'arbitre que sur `taskType`, qui est unique, donc
                deux emplacements simultanes en rendaient toujours un inerte.
               ───────────────────────────────────────────────────────────── */}
            <div
              onDrop={(e) => { e.stopPropagation(); handleDrop(e, audioTarget); e.currentTarget.classList.remove('ring-2', 'ring-zinc-400/50'); }}
              onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); e.currentTarget.classList.add('ring-2', 'ring-zinc-400/50'); }}
              onDragLeave={(e) => { e.currentTarget.classList.remove('ring-2', 'ring-zinc-400/50'); }}
              className="bg-white dark:bg-[#1a1a1f] rounded-xl border border-zinc-200 dark:border-white/5 transition-shadow relative"
            >
              {/* En-tete : libelle + selecteur de mode */}
              <div className="px-3 py-2 border-b border-zinc-100 dark:border-white/5 bg-zinc-50 dark:bg-white/[0.02] flex items-center justify-between gap-2">
                <span className="text-[11px] font-bold text-zinc-500 dark:text-zinc-400 uppercase tracking-wide flex-shrink-0">
                  {tf('audio', 'Audio')}
                </span>

                <div className="flex items-center gap-1 min-w-0">
                  {!activeAudioUrl && (
                    <div className="relative flex-shrink-0" ref={audioAddMenuRef}>
                      <button
                        type="button"
                        onClick={() => { setShowAudioAddMenu((v) => !v); setShowAudioMenu(false); }}
                        className="flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-medium text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-100 hover:bg-zinc-200 dark:hover:bg-white/10 transition-colors whitespace-nowrap"
                      >
                        <Plus size={11} className="flex-shrink-0" />
                        <span>{tf('addAudio', 'Ajouter')}</span>
                        <ChevronDown size={10} className={`flex-shrink-0 transition-transform ${showAudioAddMenu ? 'rotate-180' : ''}`} />
                      </button>

                      {showAudioAddMenu && (
                        <div className="absolute left-0 top-full mt-1 z-50 w-52 rounded-xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#1f1f24] shadow-2xl overflow-hidden py-1">
                          <button
                            type="button"
                            onClick={() => { setShowAudioAddMenu(false); openAudioModal(audioTarget, 'uploads'); }}
                            className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-zinc-100 dark:hover:bg-white/5 transition-colors"
                          >
                            <Library size={14} className="text-zinc-400 flex-shrink-0" />
                            <span className="text-xs text-zinc-800 dark:text-zinc-100">{t('fromLibrary')}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => { setShowAudioAddMenu(false); activeAudioInputRef.current?.click(); }}
                            className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-zinc-100 dark:hover:bg-white/5 transition-colors"
                          >
                            <Upload size={14} className="text-zinc-400 flex-shrink-0" />
                            <span className="text-xs text-zinc-800 dark:text-zinc-100">{t('upload')}</span>
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Menu de mode */}
                  <div className="relative min-w-0" ref={audioMenuRef}>
                    <button
                      type="button"
                      onClick={() => { setShowAudioMenu((v) => !v); setShowAudioAddMenu(false); }}
                      className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-zinc-100 dark:bg-white/5 border border-zinc-200 dark:border-white/10 text-[10px] font-semibold text-zinc-700 dark:text-zinc-200 hover:bg-zinc-200 dark:hover:bg-white/10 transition-colors max-w-full"
                      title={`${activeAudioMode.label} — ${activeAudioMode.desc}`}
                    >
                      <activeAudioMode.icon size={11} className="text-pink-500 flex-shrink-0" />
                      <span className="truncate">{activeAudioMode.short}</span>
                      <ChevronDown size={11} className={`flex-shrink-0 transition-transform ${showAudioMenu ? 'rotate-180' : ''}`} />
                    </button>

                    {showAudioMenu && (
                      <div className="absolute right-0 top-full mt-1 z-50 w-72 rounded-xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#1f1f24] shadow-2xl overflow-hidden py-1">
                        {(['remix', 'edit'] as const).map((group) => (
                          <div key={group}>
                            <div className="px-3 pt-2 pb-1 text-[9px] font-bold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                              {group === 'remix' ? (tf('remix', 'Remix')) : (tf('modification', 'Modification'))}
                            </div>
                            {AUDIO_MODES.filter((m) => m.group === group).map((m) => {
                              const Icon = m.icon;
                              const isActive = m.id === audioMode;
                              return (
                                <button
                                  key={m.id}
                                  type="button"
                                  disabled={!m.available}
                                  onClick={() => changeAudioMode(m.id)}
                                  className={`w-full flex items-start gap-2.5 px-3 py-2 text-left transition-colors ${
                                    !m.available
                                      ? 'opacity-40 cursor-not-allowed'
                                      : isActive
                                        ? 'bg-pink-500/10'
                                        : 'hover:bg-zinc-100 dark:hover:bg-white/5'
                                  }`}
                                >
                                  <Icon size={14} className={`mt-0.5 flex-shrink-0 ${isActive ? 'text-pink-500' : 'text-zinc-400'}`} />
                                  <span className="min-w-0 flex-1">
                                    <span className="flex items-center gap-1.5">
                                      <span className={`text-xs font-medium ${isActive ? 'text-pink-500' : 'text-zinc-800 dark:text-zinc-100'}`}>
                                        {m.label}
                                      </span>
                                      {!m.available && (
                                        <span className="text-[8px] uppercase font-bold px-1 py-px rounded bg-zinc-200 dark:bg-white/10 text-zinc-500 dark:text-zinc-400">
                                          {tf('soon', 'bientot')}
                                        </span>
                                      )}
                                    </span>
                                    <span className="block text-[10px] text-zinc-500 dark:text-zinc-400 leading-tight mt-0.5">
                                      {m.desc}
                                    </span>
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Corps : lecteur si un audio est charge, zone de depot sinon */}
              {activeAudioUrl ? (
                <div className="p-2 space-y-2">
                  <div className="flex items-center gap-3 p-2 rounded-lg bg-zinc-50 dark:bg-white/[0.03] border border-zinc-100 dark:border-white/5">
                    <button
                      type="button"
                      onClick={() => toggleAudio(audioTarget)}
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
                        onRegionChange={isRepaintMode ? ((s, e) => { setRepaintingStart(Math.round(s * 10) / 10); setRepaintingEnd(e < 0 ? -1 : Math.round(e * 10) / 10); }) : undefined}
                      />
                    </div>

                    <button
                      type="button"
                      onClick={clearActiveAudio}
                      className="p-1.5 rounded-full hover:bg-zinc-200 dark:hover:bg-white/10 text-zinc-400 hover:text-zinc-600 dark:hover:text-white transition-colors"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
                    </button>
                  </div>

                  {/* Reglages contextuels au mode */}
                  <div className="space-y-2">
                    {/* Ces deux parametres partent dans la charge utile quel que
                        soit le mode. Les masquer hors mode source rendait leur
                        valeur invisible sans la neutraliser — c'est exactement ce
                        qui cassait le mode Inspiration. On les affiche toujours. */}
                    <div className="space-y-0.5">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-medium text-zinc-500 dark:text-zinc-400 w-14">{tf('audioCoverStrength', 'Reprise')}</span>
                        <input type="range" min="0" max="1" step="0.01" value={audioCoverStrength} onChange={(e) => setAudioCoverStrength(Number(e.target.value))} className="flex-1 h-1 accent-pink-500 cursor-pointer" />
                        <span className="text-[10px] text-zinc-500 tabular-nums w-8 text-right">{Math.round(audioCoverStrength * 100)}%</span>
                      </div>
                      <p className="text-[9px] text-zinc-400 dark:text-zinc-500 pl-16">{tf('hintAudioCoverStrength', 'Influence marginale entre 0 et 75 % : la fidelite harmonique et le grain montent tres legerement avec la valeur.')}</p>
                    </div>

                    <div className="space-y-0.5">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-medium text-zinc-500 dark:text-zinc-400 w-14">{tf('coverNoiseStrength', 'Fidelite')}</span>
                        <input type="range" min="0" max="1" step="0.01" value={coverNoiseStrength} onChange={(e) => setCoverNoiseStrength(Number(e.target.value))} className="flex-1 h-1 accent-amber-500 cursor-pointer" />
                        <span className={`text-[10px] tabular-nums w-8 text-right ${audioTarget === 'reference' && coverNoiseStrength > 0 ? 'text-red-500 font-medium' : 'text-zinc-500'}`}>{Math.round(coverNoiseStrength * 100)}%</span>
                      </div>
                      <p className="text-[9px] text-zinc-400 dark:text-zinc-500 pl-16">
                        {audioTarget === 'reference'
                          ? tf('hintCoverNoiseRef', 'En mode Inspiration, toute valeur > 0 dégrade fortement le rendu. Laisser à 0.')
                          : tf('hintCoverNoiseStrength', 'Plus haut = plus proche de la source. Au-delà de ~40 %, quasi-copie.')}
                      </p>
                    </div>

                    {isRepaintMode && (<>
                      <div className="space-y-0.5">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-medium text-zinc-500 dark:text-zinc-400 w-10">{tf('strength', 'Strength')}</span>
                          <input type="range" min="0" max="1" step="0.05" value={repaintStrength} onChange={(e) => setRepaintStrength(Number(e.target.value))} className="flex-1 h-1 accent-purple-500 cursor-pointer" />
                          <span className="text-[10px] text-zinc-500 tabular-nums w-8 text-right">{Math.round(repaintStrength * 100)}%</span>
                        </div>
                        <p className="text-[9px] text-zinc-400 dark:text-zinc-500 pl-12">{tf('hintRepaintStrength', '0% — fully regenerate the region, 100% — leave it almost unchanged')}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-medium text-zinc-500 dark:text-zinc-400 w-10">{tf('region', 'Region')}</span>
                        <div className="flex items-center gap-1 flex-1">
                          <input type="number" step="0.1" min="0" placeholder="0s" value={repaintingStart || ''} onChange={(e) => setRepaintingStart(Number(e.target.value))} className="w-16 bg-zinc-100 dark:bg-black/30 border border-zinc-200 dark:border-white/10 rounded px-1.5 py-0.5 text-[10px] text-zinc-900 dark:text-white text-center focus:outline-none focus:border-purple-500" />
                          <span className="text-[10px] text-zinc-400">—</span>
                          <input type="number" step="0.1" min="-1" placeholder={tf('end', 'end')} value={repaintingEnd === -1 ? '' : repaintingEnd} onChange={(e) => setRepaintingEnd(e.target.value === '' ? -1 : Number(e.target.value))} className="w-16 bg-zinc-100 dark:bg-black/30 border border-zinc-200 dark:border-white/10 rounded px-1.5 py-0.5 text-[10px] text-zinc-900 dark:text-white text-center focus:outline-none focus:border-purple-500" />
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
            </div>

            {/* Lyrics Input */}
            <div
              ref={lyricsRef}
              className="bg-white dark:bg-suno-card rounded-xl border border-zinc-200 dark:border-white/5 overflow-hidden transition-colors group focus-within:border-zinc-400 dark:focus-within:border-white/20 relative flex flex-col"
              style={{ height: 'auto' }}
            >
              <div className="flex items-center justify-between px-3 py-2.5 bg-zinc-50 dark:bg-white/5 border-b border-zinc-100 dark:border-white/5 flex-shrink-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-bold text-zinc-500 dark:text-zinc-400 uppercase tracking-wide" title={t('leaveLyricsEmpty')}>{t('lyrics')}</span>
                  <button
                    onClick={() => setInstrumental(!instrumental)}
                    className={`relative w-8 h-[18px] rounded-full transition-colors flex-shrink-0 ${instrumental ? 'bg-zinc-600 dark:bg-zinc-600' : 'bg-zinc-400 dark:bg-zinc-500'}`}
                    title={instrumental ? t('instrumental') : t('vocal')}
                  >
                    <span className={`absolute top-[3px] w-3 h-3 rounded-full bg-white shadow-sm transition-transform ${instrumental ? 'left-[3px]' : 'left-[17px]'}`} />
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  {lyricsHistoryRef.current.length > 0 && (
                    <button
                      className="p-1.5 hover:bg-zinc-200 dark:hover:bg-white/10 rounded text-zinc-400 hover:text-black dark:hover:text-white transition-colors"
                      title={t('undo')}
                      onClick={undoLyrics}
                    >
                      <Undo2 size={14} />
                    </button>
                  )}
                  <button
                    className="p-1.5 hover:bg-zinc-200 dark:hover:bg-white/10 rounded text-zinc-500 hover:text-black dark:hover:text-white transition-colors"
                    onClick={() => setLyrics('')}
                  >
                    <Trash2 size={14} />
                  </button>
                  <button
                    className={`p-1.5 hover:bg-zinc-200 dark:hover:bg-white/10 rounded transition-colors ${isGenLyricsActive ? 'text-pink-500' : 'text-zinc-500 hover:text-black dark:hover:text-white'}`}
                    title={tf('aiGenerate', 'Generate lyrics from scratch')}
                    onClick={useOpenRouter && isGenLyricsActive ? () => orHook.cancel() : () => handleAiGenerate('lyrics')}
                    disabled={(isGenLyricsActive && !useOpenRouter) || isFmtLyricsActive || (orRunning && !isGenLyricsActive) || !style.trim()}
                  >
                    {useOpenRouter && isGenLyricsActive
                      ? <Square size={14} />
                      : (isGenLyricsActive ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />)}
                  </button>
                  <button
                    className={`p-1.5 hover:bg-zinc-200 dark:hover:bg-white/10 rounded transition-colors ${isFmtLyricsActive ? 'text-pink-500' : 'text-zinc-500 hover:text-black dark:hover:text-white'}`}
                    title={tf('aiFormat', 'Enhance existing lyrics')}
                    onClick={useOpenRouter && isFmtLyricsActive ? () => orHook.cancel() : () => handleFormat('lyrics')}
                    disabled={(isFmtLyricsActive && !useOpenRouter) || isGenLyricsActive || (orRunning && !isFmtLyricsActive) || !lyrics.trim()}
                  >
                    {useOpenRouter && isFmtLyricsActive
                      ? <Square size={14} />
                      : (isFmtLyricsActive ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />)}
                  </button>
                </div>
              </div>
              {!instrumental && (
                <>
                  <textarea
                    value={lyrics}
                    onChange={(e) => setLyrics(e.target.value)}
                    placeholder={t('lyricsPlaceholder')}
                    className="w-full bg-transparent p-3 text-sm text-zinc-900 dark:text-white placeholder-zinc-400 dark:placeholder-zinc-600 focus:outline-none resize-none font-mono leading-relaxed"
                    style={{ height: `${lyricsHeight}px` }}
                  />
                  {/* Resize Handle */}
                  <div
                    onMouseDown={startResizing}
                    className="h-3 w-full cursor-ns-resize flex items-center justify-center hover:bg-zinc-100 dark:hover:bg-white/5 transition-colors absolute bottom-0 left-0 z-10"
                  >
                    <div className="w-8 h-1 rounded-full bg-zinc-300 dark:bg-zinc-700"></div>
                  </div>
                </>
              )}
            </div>

            {/* Langue du chant et genre de la voix — voir VocalSettings.tsx.
                Les trois valeurs restent ici : elles sont lues dans la
                construction de la charge utile et les appels LLM. */}
            <VocalSettings
              instrumental={instrumental}
              vocalLanguage={vocalLanguage}
              vocalGender={vocalGender}
              onVocalLanguageChange={setVocalLanguage}
              onVocalGenderChange={setVocalGender}
              t={t}
            />

            {/* LRC Toggle */}
              <div className="flex items-center justify-between">
                <label className="text-xs font-bold text-zinc-500 dark:text-zinc-400 uppercase tracking-wide">
                  LRC
                </label>
                <button
                  type="button"
                  onClick={() => setGetLrc(!getLrc)}
                  className={`relative w-10 h-5 rounded-full transition-colors flex-shrink-0 ${getLrc ? 'bg-pink-500' : 'bg-zinc-300 dark:bg-zinc-600'}`}
                >
                  <span className={`absolute top-[2px] w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${getLrc ? 'left-[22px]' : 'left-[2px]'}`} />
                </button>
              </div>

            {/* Style Input */}
            <div className="bg-white dark:bg-suno-card rounded-xl border border-zinc-200 dark:border-white/5 overflow-hidden transition-colors group focus-within:border-zinc-400 dark:focus-within:border-white/20">
              <div className="flex items-center justify-between px-3 py-2.5 bg-zinc-50 dark:bg-white/5 border-b border-zinc-100 dark:border-white/5">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-zinc-500 dark:text-zinc-400 uppercase tracking-wide">{t('styleOfMusic')}</span>
                    <button
                      onClick={() => setEnhance(!enhance)}
                      className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-all cursor-pointer ${enhance ? 'bg-violet-100 dark:bg-violet-500/20 text-violet-600 dark:text-violet-400' : 'text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300'}`}
                      title={t('enhanceTooltip')}
                    >
                      <Sparkles size={9} />
                      <span>{enhance ? 'ON' : 'OFF'}</span>
                    </button>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  {styleHistoryRef.current.length > 0 && (
                    <button
                      className="p-1.5 hover:bg-zinc-200 dark:hover:bg-white/10 rounded text-zinc-400 hover:text-black dark:hover:text-white transition-colors"
                      title={t('undo')}
                      onClick={undoStyle}
                    >
                      <Undo2 size={14} />
                    </button>
                  )}
                  <button
                    className="p-1.5 hover:bg-zinc-200 dark:hover:bg-white/10 rounded text-zinc-500 hover:text-black dark:hover:text-white transition-colors"
                    onClick={() => setStyle('')}
                  >
                    <Trash2 size={14} />
                  </button>
                  <button
                    className={`p-1.5 hover:bg-zinc-200 dark:hover:bg-white/10 rounded transition-colors ${isGenStyleActive ? 'text-pink-500' : 'text-zinc-500 hover:text-black dark:hover:text-white'}`}
                    title={tf('aiGenerate', 'Generate style from scratch')}
                    onClick={useOpenRouter && isGenStyleActive ? () => orHook.cancel() : () => handleAiGenerate('style')}
                    disabled={(isGenStyleActive && !useOpenRouter) || isFmtStyleActive || (orRunning && !isGenStyleActive) || !style.trim()}
                  >
                    {useOpenRouter && isGenStyleActive
                      ? <Square size={14} />
                      : (isGenStyleActive ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />)}
                  </button>
                  <button
                    className={`p-1.5 hover:bg-zinc-200 dark:hover:bg-white/10 rounded transition-colors ${isFmtStyleActive ? 'text-pink-500' : 'text-zinc-500 hover:text-black dark:hover:text-white'}`}
                    title={tf('aiFormat', 'Enhance existing style')}
                    onClick={useOpenRouter && isFmtStyleActive ? () => orHook.cancel() : () => handleFormat('style')}
                    disabled={(isFmtStyleActive && !useOpenRouter) || isGenStyleActive || (orRunning && !isFmtStyleActive) || !style.trim()}
                  >
                    {useOpenRouter && isFmtStyleActive
                      ? <Square size={14} />
                      : (isFmtStyleActive ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />)}
                  </button>
                  <button
                    className="p-1.5 hover:bg-zinc-200 dark:hover:bg-white/10 rounded transition-colors text-zinc-500 hover:text-black dark:hover:text-white"
                    title={t('refreshGenres')}
                    onClick={refreshMusicTags}
                  >
                    <Dices size={14} />
                  </button>
                </div>
              </div>
              <textarea
                value={style}
                onChange={(e) => setStyle(e.target.value)}
                placeholder={t('stylePlaceholder')}
                className="w-full h-20 bg-transparent p-3 text-sm text-zinc-900 dark:text-white placeholder-zinc-400 dark:placeholder-zinc-600 focus:outline-none resize-none"
              />
              <div className="px-3 pb-3 space-y-3">
                {/* Quick Tags */}
                <div className="flex flex-wrap gap-2">
                  {musicTags.map(tag => (
                    <button
                      key={tag}
                      onClick={() => setStyle(prev => prev ? `${prev}, ${tag}` : tag)}
                      className="text-[10px] font-medium bg-zinc-100 dark:bg-white/5 hover:bg-zinc-200 dark:hover:bg-white/10 text-zinc-600 dark:text-zinc-400 hover:text-black dark:hover:text-white px-2.5 py-1 rounded-full transition-colors border border-zinc-200 dark:border-white/5"
                    >
                      {tag}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* OpenRouter generation status — shown when a remote LLM run is in flight or just finished */}
            <GenerationStatusPanel
              state={orHook.state}
              onCancel={orHook.cancel}
              onRetry={orHook.retry}
              onDismiss={orHook.dismissError}
            />

            {/* Title Input */}
            <div className="bg-white dark:bg-suno-card rounded-xl border border-zinc-200 dark:border-white/5 overflow-hidden">
              <div className="px-3 py-2.5 text-xs font-bold uppercase tracking-wide text-zinc-500 dark:text-zinc-400 border-b border-zinc-100 dark:border-white/5 bg-zinc-50 dark:bg-white/5">
                {t('title')}
              </div>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t('nameSong')}
                className="w-full bg-transparent p-3 text-sm text-zinc-900 dark:text-white placeholder-zinc-400 dark:placeholder-zinc-600 focus:outline-none"
              />
            </div>
          </div>

        {/* Quick Settings */}
        <div className="bg-white dark:bg-suno-card rounded-xl border border-zinc-200 dark:border-white/5 p-4 space-y-4">
          <h3 className="text-xs font-bold text-zinc-500 dark:text-zinc-400 uppercase tracking-wide flex items-center gap-2">
            <Sliders size={14} />
            {t('quickSettings')}
          </h3>

          <EditableSlider
            label={t('duration')}
            value={duration}
            min={-1}
            max={activeMaxDuration}
            step={5}
            onChange={setDuration}
            formatDisplay={(val) => val === -1 ? t('auto') : `${val}${t('seconds')}`}
            title={''}
            autoLabel={t('auto')}
          />

          <EditableSlider
            label="BPM"
            value={bpm}
            min={0}
            max={300}
            step={5}
            onChange={setBpm}
            formatDisplay={(val) => !val ? 'Auto' : String(val)}
            autoLabel="Auto"
          />

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{t('key')}</label>
              <select
                value={keyScale}
                onChange={e => setKeyScale(e.target.value)}
                className="w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-xl px-2 py-1.5 text-xs text-zinc-900 dark:text-white focus:outline-none focus:border-pink-500 dark:focus:border-pink-500 transition-colors cursor-pointer [&>option]:bg-white [&>option]:dark:bg-zinc-800 [&>option]:text-zinc-900 [&>option]:dark:text-white"
              >
                <option value="">Auto</option>
                {KEY_SIGNATURES.filter(k => k).map(key => (
                  <option key={key} value={key}>{key}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{t('time')}</label>
              <select
                value={timeSignature}
                onChange={e => setTimeSignature(e.target.value)}
                className="w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-xl px-2 py-1.5 text-xs text-zinc-900 dark:text-white focus:outline-none focus:border-pink-500 dark:focus:border-pink-500 transition-colors cursor-pointer [&>option]:bg-white [&>option]:dark:bg-zinc-800 [&>option]:text-zinc-900 [&>option]:dark:text-white"
              >
                <option value="">Auto</option>
                {TIME_SIGNATURES.filter(t => t).map(time => (
                  <option key={time} value={time}>{time}</option>
                ))}
              </select>
            </div>
          </div>

          <EditableSlider
            label={t('variations')}
            value={batchSize}
            min={1}
            max={4}
            step={1}
            onChange={setBatchSize}
          />
        </div>

{/* LORA CONTROL PANEL */}
          <LoraPanel
            token={token}
            t={t}
            selectedModel={selectedModel}
            loraLoaded={loraLoaded}
            onLoadedChange={setLoraLoaded}
          />

        {/* ADVANCED SETTINGS */}
        <button
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="w-full flex items-center justify-between px-4 py-3 bg-white dark:bg-suno-card rounded-xl border border-zinc-200 dark:border-white/5 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-white/5 transition-colors"
        >
          <div className="flex items-center gap-2">
            <Settings2 size={16} className="text-zinc-500" />
            <span>{t('advancedSettings')}</span>
          </div>
          <ChevronDown size={16} className={`text-zinc-500 transition-transform ${showAdvanced ? 'rotate-180' : ''}`} />
        </button>

        {showAdvanced && (
          <div className="bg-white dark:bg-suno-card rounded-xl border border-zinc-200 dark:border-white/5 p-4 space-y-4">
            {/* Load Parameters from JSON */}
            <label className="flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-zinc-300 dark:border-white/15 text-xs font-medium text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-white/5 cursor-pointer transition-colors">
              <Upload size={14} />
              Load Parameters (JSON)
              <input
                type="file"
                accept=".json"
                onChange={handleLoadParamsFile}
                className="hidden"
              />
            </label>

            {/* Duration */}
            <EditableSlider
              label={t('duration')}
              value={duration}
              min={-1}
              max={600}
              step={5}
              onChange={setDuration}
              formatDisplay={(val) => val === -1 ? t('auto') : `${val}${t('seconds')}`}
              autoLabel={t('auto')}
              helpText={`${t('auto')} - 10 ${t('min')}`}
            />

            {/* Batch Size */}
            <EditableSlider
              label={t('batchSize')}
              value={batchSize}
              min={1}
              max={4}
              step={1}
              onChange={setBatchSize}
              helpText={t('numberOfVariations')}
              title={tf('hintBatchVariations', 'Creates multiple variations in a single run. More variations = longer total time.')}
            />

            {/* Bulk Generate */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{t('bulkGenerate')}</label>
                <span className="text-xs font-mono text-zinc-900 dark:text-white bg-zinc-100 dark:bg-black/20 px-2 py-0.5 rounded">
                  {bulkCount} {t(bulkCount === 1 ? 'job' : 'jobs')}
                </span>
              </div>
              <div className="flex items-center gap-1">
                {[1, 2, 3, 5, 10].map((count) => (
                  <button
                    key={count}
                    onClick={() => setBulkCount(count)}
                    className={`flex-1 py-2 rounded-lg text-xs font-bold transition-all ${
                      bulkCount === count
                        ? 'bg-gradient-to-r from-orange-500 to-pink-600 text-white shadow-md'
                        : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-700'
                    }`}
                  >
                    {count}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-zinc-500">{t('queueMultipleJobs')}</p>
            </div>

            {/* Inference Steps */}
            <EditableSlider
              label={t('inferenceSteps')}
              value={inferenceSteps}
              min={1}
              max={isTurboModel(selectedModel) ? 20 : 200}
              step={1}
              onChange={setInferenceSteps}
              helpText={t('moreStepsBetterQuality')}
              title={tf('hintInferenceSteps', 'More steps usually improves quality but slows generation.')}
            />

            {/* Guidance Scale */}
            <EditableSlider
              label={t('guidanceScale')}
              value={guidanceScale}
              min={0}
              max={selectedModel.includes('merge') ? 100 : 20}
              step={0.1}
              onChange={setGuidanceScale}
              formatDisplay={(val) => val.toFixed(1)}
              helpText={t('howCloselyFollowPrompt')}
              title={tf('hintGuidanceScale', 'How strongly the model follows the prompt. Higher = stricter, lower = freer. 0 = no guidance (turbo).')}
            />

            {/* Échantillonnage, sampler/scheduler et DCW — voir
                SamplingSettings.tsx. Les neuf états restent ici : ils sont
                lus à la construction de la charge utile. */}
            <SamplingSettings
              audioFormat={audioFormat}
              inferMethod={inferMethod}
              samplerMode={samplerMode}
              schedulerType={schedulerType}
              onAudioFormatChange={setAudioFormat}
              onInferMethodChange={setInferMethod}
              onSamplerModeChange={setSamplerMode}
              onSchedulerTypeChange={setSchedulerType}
              dcwEnabled={dcwEnabled}
              dcwMode={dcwMode}
              dcwScaler={dcwScaler}
              dcwHighScaler={dcwHighScaler}
              dcwWavelet={dcwWavelet}
              onDcwEnabledChange={setDcwEnabled}
              onDcwModeChange={setDcwMode}
              onDcwScalerChange={setDcwScaler}
              onDcwHighScalerChange={setDcwHighScaler}
              onDcwWaveletChange={setDcwWavelet}
              turboActive={turboActive}
              t={t}
              tf={tf}
            />

            {/* Flow-edit — voir FlowEditSettings.tsx. Les six états restent
                ici : ils sont lus à la construction de la charge utile. */}
            <FlowEditSettings
              taskType={taskType}
              morph={flowEditMorph}
              sourceCaption={flowEditSourceCaption}
              sourceLyrics={flowEditSourceLyrics}
              nMin={flowEditNMin}
              nMax={flowEditNMax}
              nAvg={flowEditNAvg}
              onMorphChange={setFlowEditMorph}
              onSourceCaptionChange={setFlowEditSourceCaption}
              onSourceLyricsChange={setFlowEditSourceLyrics}
              onNMinChange={setFlowEditNMin}
              onNMaxChange={setFlowEditNMax}
              onNAvgChange={setFlowEditNAvg}
              tf={tf}
            />

            {/* Qualité MP3 et fondus — voir OutputSettings.tsx. Les quatre
                états restent ici : ils sont lus à la construction de la
                charge utile. */}
            <OutputSettings
              audioFormat={audioFormat}
              bitrate={mp3Bitrate}
              sampleRate={mp3SampleRate}
              fadeIn={fadeInDuration}
              fadeOut={fadeOutDuration}
              onBitrateChange={setMp3Bitrate}
              onSampleRateChange={setMp3SampleRate}
              onFadeInChange={setFadeInDuration}
              onFadeOutChange={setFadeOutDuration}
              tf={tf}
            />

            {/* OpenRouter toggle — selects between local LM and remote OpenRouter provider */}
            <UseOpenRouterToggle value={useOpenRouter} onChange={setUseOpenRouter} />

            {/* Local LM controls — hidden entirely when OpenRouter is active */}
            {!useOpenRouter && (
              <>
                {/* LM Backend */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{tf('lmBackendLabel', 'LM Backend')}</label>
                  <select
                    value={lmBackend}
                    onChange={e => { setLmBackend(e.target.value as 'pt' | 'vllm'); lmEditingRef.current = true; }}
                    className="w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-2 py-1.5 text-xs text-zinc-900 dark:text-white focus:outline-none cursor-pointer [&>option]:bg-white [&>option]:dark:bg-zinc-800 [&>option]:text-zinc-900 [&>option]:dark:text-white"
                  >
                    <option value="vllm">{tf('lmBackendVllm', 'VLLM (~9.2 GB VRAM)')}</option>
                    <option value="pt">{tf('lmBackendPt', 'PT (~1.6 GB VRAM)')}</option>
                  </select>
                  <p className="text-[10px] text-zinc-500">{tf('lmBackendHint', 'vLLM uses CUDA graphs for faster LLM inference')}</p>
                </div>

                {/* LM Model */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{t('lmModelLabel')}</label>
                  <select
                    value={lmModel}
                    onChange={(e) => { setLmModel(e.target.value); lmEditingRef.current = true; }}
                    className="w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-2 py-1.5 text-xs text-zinc-900 dark:text-white focus:outline-none cursor-pointer [&>option]:bg-white [&>option]:dark:bg-zinc-800 [&>option]:text-zinc-900 [&>option]:dark:text-white"
                  >
                    <option value="acestep-5Hz-lm-0.6B">{t('lmModel06B')}</option>
                    <option value="acestep-5Hz-lm-1.7B">{t('lmModel17B')}</option>
                    <option value="acestep-5Hz-lm-4B">{t('lmModel4B')}</option>
                  </select>
                  <p className="text-[10px] text-zinc-500">{t('lmModelHint')}</p>
                </div>
              </>
            )}

            {/* OpenRouter provider config — shown when toggle is ON */}
            {useOpenRouter && <LmProviderPanel />}

            {/* Apply LM Settings button — only relevant when controlling local LM */}
            {!useOpenRouter && <button
              type="button"
              disabled={!!modelSwitchStatus || !lmModel}
              onClick={async () => {
                if (!token || !lmModel) return;
                setModelSwitchStatus(`${tf('applyingLmSettings', 'Restarting pipeline')}...`);
                try {
                  const res = await fetch('/api/generate/switch-model', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                    body: JSON.stringify({ model: selectedModel, lmModel, lmBackend }),
                  });
                  const data = await res.json();
                  if (data.success) {
                    setModelSwitchStatus('');
                    lmEditingRef.current = false; // re-sync from server on next poll
                  } else {
                    setModelSwitchStatus(data.error || 'Failed');
                    setTimeout(() => setModelSwitchStatus(''), 5000);
                  }
                } catch (err) {
                  setModelSwitchStatus('Error');
                  setTimeout(() => setModelSwitchStatus(''), 5000);
                }
              }}
              className={`w-full py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center justify-center gap-2 ${modelSwitchStatus ? 'bg-purple-800 text-purple-300 cursor-wait' : 'bg-purple-600 hover:bg-purple-700 text-white'}`}
            >
              {modelSwitchStatus ? (
                <><Loader2 size={12} className="animate-spin" /> {modelSwitchStatus}</>
              ) : (
                tf('applyLmSettings', 'Apply LM Settings (restart pipeline)')
              )}
            </button>}

            {/* ───── Pollinations.ai cover generation ─────
                Independent of the LLM provider above. When ON, after audio
                renders, the server hits Pollinations to generate an album
                cover and persists it to song.cover_url. */}
            <div className="border-t border-zinc-200 dark:border-white/5 pt-2 mt-2">
              <div className="text-[11px] uppercase tracking-wide text-zinc-500 dark:text-zinc-500 mb-1">
                {tf('pollinations.sectionTitle', 'Cover image (Pollinations.ai)')}
              </div>
              <UsePollinationsToggle value={usePollinations} onChange={setUsePollinations} />
              {usePollinations && <PollinationsPanel />}
            </div>

            {/* Graine de génération et Nouvelle prise — voir SeedSettings.tsx.
                Les six états restent ici : ils sont lus à la construction de
                la charge utile. */}
            <SeedSettings
              seed={seed}
              randomSeed={randomSeed}
              onSeedChange={setSeed}
              onToggleRandomSeed={toggleRandomSeed}
              bulkCount={bulkCount}
              retakeEnabled={retakeEnabled}
              retakeVariance={retakeVariance}
              retakeSeed={retakeSeed}
              onRetakeEnabledChange={setRetakeEnabled}
              onRetakeVarianceChange={setRetakeVariance}
              onRetakeSeedChange={setRetakeSeed}
              t={t}
              tf={tf}
            />

            {/* Thinking / Reasoning Toggle —
                  • Local LM mode: enables chain-of-thought caption/lyrics generation.
                  • OpenRouter mode: forwards reasoning hint to OR model (honored by reasoning models like Claude extended-thinking, GPT-5, DeepSeek-R1; ignored by others).
            */}
            {(useOpenRouter || activeLmModel !== '') && (
              <div className="flex items-center justify-between py-2 border-t border-zinc-100 dark:border-white/5">
                <span className={`text-xs font-medium ${loraLoaded ? 'text-zinc-400 dark:text-zinc-600' : 'text-zinc-600 dark:text-zinc-400'}`} title={useOpenRouter ? 'Forwards reasoning hint to OpenRouter (honored by reasoning-capable models, ignored by others).' : (tf('hintThinkingCot', 'Lets the lyric model reason about structure and metadata. Slightly slower.'))}>
                  {t('thinkingCot')}
                </span>
                <button
                  onClick={() => !loraLoaded && setThinking(!thinking)}
                  disabled={loraLoaded}
                  className={`w-10 h-5 rounded-full flex items-center transition-colors duration-200 px-0.5 border border-zinc-200 dark:border-white/5 ${thinking ? 'bg-pink-600' : 'bg-zinc-300 dark:bg-black/40'} ${loraLoaded ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                >
                  <div className={`w-4 h-4 rounded-full bg-white transform transition-transform duration-200 shadow-sm ${thinking ? 'translate-x-5' : 'translate-x-0'}`} />
                </button>
              </div>
            )}

            {/* Shift */}
            <EditableSlider
              label={t('shift')}
              value={shift}
              min={1}
              max={5}
              step={0.1}
              onChange={setShift}
              formatDisplay={(val) => val.toFixed(1)}
              helpText={t('timestepShiftForBase')}
              title={tf('hintShift', 'Adjusts the diffusion schedule. Only affects base model.')}
            />

            {/* Divider */}
            <div className="border-t border-zinc-200 dark:border-white/10 pt-4">
              <p className="text-[10px] text-zinc-500 uppercase tracking-wide font-bold mb-3">{t('expertControls')}</p>
            </div>

            {uploadError && (
              <div className="text-[11px] text-rose-500">{uploadError}</div>
            )}

            {/* LM Parameters — only relevant when a local LM is actually loaded */}
            {!useOpenRouter && activeLmModel !== '' &&(
              <button
                onClick={() => setShowLmParams(!showLmParams)}
                className="w-full flex items-center justify-between px-4 py-3 bg-white/60 dark:bg-black/20 rounded-xl border border-zinc-200/70 dark:border-white/10 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-white/5 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <Music2 size={16} className="text-zinc-500" />
                  <div className="flex flex-col items-start">
                    <span title={tf('hintLmParameters', 'Controls the 5Hz lyric/caption model sampling behavior.')}>{t('lmParameters')}</span>
                    <span className="text-[11px] text-zinc-400 dark:text-zinc-500 font-normal">{t('controlLyricGeneration')}</span>
                  </div>
                </div>
                <ChevronDown size={16} className={`text-zinc-500 transition-transform ${showLmParams ? 'rotate-180' : ''}`} />
              </button>
            )}

            {!useOpenRouter && activeLmModel !== '' &&showLmParams && (
              <div className="bg-white dark:bg-suno-card rounded-xl border border-zinc-200 dark:border-white/5 p-4 space-y-4">
                {/* LM Temperature */}
                <EditableSlider
                  label={t('lmTemperature')}
                  value={lmTemperature}
                  min={0}
                  max={2}
                  step={0.1}
                  onChange={setLmTemperature}
                  formatDisplay={(val) => val.toFixed(2)}
                  helpText={t('higherMoreRandom')}
                  title={tf('hintLmTemperature', 'Higher temperature = more random word choices.')}
                />

                {/* LM CFG Scale */}
                <EditableSlider
                  label={t('lmCfgScale')}
                  value={lmCfgScale}
                  min={1}
                  max={3}
                  step={0.1}
                  onChange={setLmCfgScale}
                  formatDisplay={(val) => val.toFixed(1)}
                  helpText={t('noCfgScale')}
                  title={tf('hintLmCfgScale', 'How strongly the lyric model follows the prompt.')}
                />

                {/* LM Top-K & Top-P */}
                <div className="grid grid-cols-2 gap-3">
                  <EditableSlider
                    label={t('topK')}
                    value={lmTopK}
                    min={0}
                    max={100}
                    step={1}
                    onChange={setLmTopK}
                    title={tf('hintTopK', 'Restricts choices to the K most likely tokens. 0 disables.')}
                  />
                  <EditableSlider
                    label={t('topP')}
                    value={lmTopP}
                    min={0}
                    max={1}
                    step={0.01}
                    onChange={setLmTopP}
                    formatDisplay={(val) => val.toFixed(2)}
                    title={tf('hintTopP', 'Samples from the smallest set whose total probability is P.')}
                  />
                </div>

                {/* LM Negative Prompt */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400" title={tf('hintLmNegativePrompt', 'Words or ideas to steer the lyric model away from.')}>{t('lmNegativePrompt')}</label>
                  <textarea
                    value={lmNegativePrompt}
                    onChange={(e) => setLmNegativePrompt(e.target.value)}
                    placeholder={t('thingsToAvoid')}
                    className="w-full h-16 bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg p-2 text-xs text-zinc-900 dark:text-white focus:outline-none resize-none"
                  />
                  <p className="text-[10px] text-zinc-500">{t('useWhenCfgScaleGreater')}</p>
                </div>
              </div>
            )}

            <div className="space-y-1">
              <h4 className="text-xs font-bold text-zinc-500 dark:text-zinc-400 uppercase tracking-wide" title={tf('hintTransform', 'Controls how much the output follows the input audio.')}>{t('transform')}</h4>
              <p className="text-[11px] text-zinc-400 dark:text-zinc-500">{t('controlSourceAudio')}</p>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400" title={tf('hintAudioCodes', 'Advanced: precomputed audio codes for conditioning.')}>{t('audioCodes')}</label>
              <textarea
                value={audioCodes}
                onChange={(e) => setAudioCodes(e.target.value)}
                placeholder={t('optionalAudioCodes')}
                className="w-full h-16 bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg p-2 text-xs text-zinc-900 dark:text-white focus:outline-none resize-none"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    // Convert source audio to LM codes — requires Gradio lambda (not exposed as API)
                    // This is a placeholder: Gradio's convert_src_audio_to_codes_wrapper is not a named endpoint
                    console.log('Convert to Codes: requires source audio upload. Use Gradio UI for this feature.');
                  }}
                  disabled={!sourceAudioUrl}
                  title={tf('hintConvertToCodes', 'Convert source audio to LM codes (requires source audio)')}
                  className="px-2 py-1 rounded text-[10px] font-medium bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Convert to Codes
                </button>
                <button
                  type="button"
                  onClick={() => {
                    // Transcribe audio codes to metadata — requires Gradio lambda (not exposed as API)
                    console.log('Transcribe: requires audio codes. Use Gradio UI for this feature.');
                  }}
                  disabled={!audioCodes.trim()}
                  title={tf('hintTranscribeCodes', 'Transcribe audio codes to metadata (requires audio codes)')}
                  className="px-2 py-1 rounded text-[10px] font-medium bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Transcribe
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              {/* Lecture seule : le taskType est desormais pilote par le mode
                  du bloc AUDIO, pour eviter deux sources de verite qui se
                  contredisent silencieusement. */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400" title={tf('hintTaskType', 'Choose text-to-music or audio-based modes.')}>{t('taskType')}</label>
                <div className="w-full bg-zinc-100 dark:bg-black/30 border border-zinc-200 dark:border-white/10 rounded-xl px-2 py-1.5 text-xs text-zinc-500 dark:text-zinc-400 flex items-center gap-1.5 cursor-default">
                  <activeAudioMode.icon size={12} className="flex-shrink-0 text-pink-500" />
                  <span className="truncate">{activeAudioUrl ? activeAudioMode.label : (tf('textToMusic', 'Text to music'))}</span>
                  <span className="ml-auto text-[9px] font-mono opacity-60 flex-shrink-0">{taskType}</span>
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400" title={tf('hintAudioCoverStrength', 'Influence marginale entre 0 et 75 % : la fidelite harmonique et le grain montent tres legerement avec la valeur.')}>{t('audioCoverStrength')}</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  max="1"
                  value={audioCoverStrength}
                  onChange={(e) => setAudioCoverStrength(Number(e.target.value))}
                  className="w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-3 py-2 text-xs text-zinc-900 dark:text-white focus:outline-none"
                />
              </div>
            </div>

            {/* Repaint Mode & Strength (only for repaint task) */}
            {taskType === 'repaint' && (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{tf('repaintModeLabel', 'Repaint Mode')}</label>
                  <select
                    value={repaintMode}
                    onChange={(e) => setRepaintMode(e.target.value as 'conservative' | 'balanced' | 'aggressive' | 'most_natural')}
                    className="w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-2 py-1.5 text-xs text-zinc-900 dark:text-white focus:outline-none focus:border-pink-500 transition-colors cursor-pointer [&>option]:bg-white [&>option]:dark:bg-zinc-800"
                  >
                    <option value="conservative">{tf('repaintConservative', 'Conservative')}</option>
                    <option value="balanced">{tf('repaintBalanced', 'Balanced')}</option>
                    <option value="aggressive">{tf('repaintAggressive', 'Aggressive')}</option>
                    <option value="most_natural">{tf('repaintMostNatural', 'Most Natural')}</option>
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{tf('repaintStrengthLabel', 'Repaint Strength')}</label>
                  <input
                    type="number" step="0.05" min="0" max="1"
                    value={repaintStrength}
                    onChange={(e) => setRepaintStrength(Number(e.target.value))}
                    className="w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-3 py-2 text-xs text-zinc-900 dark:text-white focus:outline-none"
                  />
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400" title={tf('hintRepaintingStart', 'Start time for the region to repaint (seconds).')}>{t('repaintingStart')}</label>
                <input
                  type="number"
                  step="0.1"
                  min="0"
                  value={repaintingStart}
                  onChange={(e) => setRepaintingStart(Number(e.target.value))}
                  className="w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-3 py-2 text-xs text-zinc-900 dark:text-white focus:outline-none"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400" title={tf('hintRepaintingEnd', 'End time for the region to repaint (seconds).')}>{t('repaintingEnd')}</label>
                <input
                  type="number"
                  step="0.1"
                  min="-1"
                  value={repaintingEnd}
                  onChange={(e) => setRepaintingEnd(Number(e.target.value))}
                  className="w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-3 py-2 text-xs text-zinc-900 dark:text-white focus:outline-none"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400" title={tf('hintInstruction', 'Additional directives to guide generation.')}>{t('instruction')}</label>
              <textarea
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                placeholder={defaultInstructionFor(taskType)}
                className="w-full h-16 bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg p-2 text-xs text-zinc-900 dark:text-white placeholder-zinc-400 dark:placeholder-zinc-600 focus:outline-none resize-none"
              />
              <p className="text-[10px] text-zinc-400 dark:text-zinc-500">
                {tf('hintInstructionEmpty', 'Laisser vide : l\'instruction est choisie automatiquement selon le mode audio.')}
              </p>
            </div>

            <div className="space-y-1">
              <h4 className="text-xs font-bold text-zinc-500 dark:text-zinc-400 uppercase tracking-wide">{t('guidance')}</h4>
              <p className="text-[11px] text-zinc-400 dark:text-zinc-500">{t('advancedCfgScheduling')}</p>
              {/* Presets */}
              <div className="flex flex-wrap gap-1.5 pt-1">
                {[
                  { label: t('presetDefault'), cfg: [0, 1], ts: '', score: 0.5, adg: false, desc: t('presetDefaultDesc') },
                  { label: t('presetCleanVocals'), cfg: [0, 0.5], ts: '', score: 0.5, adg: false, desc: t('presetCleanVocalsDesc') },
                  { label: t('presetCreative'), cfg: [0.2, 0.8], ts: '', score: 0.5, adg: false, desc: t('presetCreativeDesc') },
                  { label: t('presetCover'), cfg: [0, 0.95], ts: '', score: 0.5, adg: false, desc: t('presetCoverDesc') },
                  { label: t('presetStrict'), cfg: [0, 0.75], ts: '', score: 0.7, adg: false, desc: t('presetStrictDesc') },
                  { label: 'ADG', cfg: [0, 1], ts: '', score: 0.5, adg: true, desc: t('presetAdgDesc') },
                ].map(p => (
                  <button
                    key={p.label}
                    title={p.desc}
                    onClick={() => {
                      setCfgIntervalStart(p.cfg[0]);
                      setCfgIntervalEnd(p.cfg[1]);
                      setCustomTimesteps(p.ts);
                      setScoreScale(p.score);
                      setUseAdg(p.adg);
                    }}
                    className={`px-2 py-1 rounded-md text-[10px] font-medium transition-all border ${
                      cfgIntervalStart === p.cfg[0] && cfgIntervalEnd === p.cfg[1] && (useAdg === p.adg)
                        ? 'bg-pink-500/20 text-pink-400 border-pink-500/30'
                        : 'bg-white/5 text-zinc-400 border-white/10 hover:border-white/20 hover:text-zinc-200'
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400" title={tf('hintCfgIntervalStart', 'Fraction of the diffusion process to start applying guidance.')}>{t('cfgIntervalStart')}</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  max="1"
                  value={cfgIntervalStart}
                  onChange={(e) => setCfgIntervalStart(Number(e.target.value))}
                  className="w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-3 py-2 text-xs text-zinc-900 dark:text-white focus:outline-none"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400" title={tf('hintCfgIntervalEnd', 'Fraction of the diffusion process to stop applying guidance.')}>{t('cfgIntervalEnd')}</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  max="1"
                  value={cfgIntervalEnd}
                  onChange={(e) => setCfgIntervalEnd(Number(e.target.value))}
                  className="w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-3 py-2 text-xs text-zinc-900 dark:text-white focus:outline-none"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400" title={tf('hintCustomTimesteps', 'Override the default timestep schedule (advanced).')}>{t('customTimesteps')}</label>
              <input
                type="text"
                value={customTimesteps}
                onChange={(e) => setCustomTimesteps(e.target.value)}
                placeholder={t('timestepsPlaceholder')}
                className="w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-3 py-2 text-xs text-zinc-900 dark:text-white focus:outline-none"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400" title={tf('hintScoreScale', 'Scales score-based guidance (advanced).')}>{t('scoreScale')}</label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  max="1"
                  value={scoreScale}
                  onChange={(e) => setScoreScale(Number(e.target.value))}
                  className="w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-3 py-2 text-xs text-zinc-900 dark:text-white focus:outline-none"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400" title={tf('hintLmBatchChunkSize', 'Bigger chunks can be faster but use more memory.')}>{t('lmBatchChunkSize')}</label>
                <input
                  type="number"
                  min="1"
                  max="32"
                  step="1"
                  value={lmBatchChunkSize}
                  onChange={(e) => setLmBatchChunkSize(Number(e.target.value))}
                  className="w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-3 py-2 text-xs text-zinc-900 dark:text-white focus:outline-none"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{t('trackName')}</label>
              <select
                value={trackName}
                onChange={(e) => setTrackName(e.target.value)}
                className="w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-2 py-1.5 text-xs text-zinc-900 dark:text-white focus:outline-none cursor-pointer [&>option]:bg-white [&>option]:dark:bg-zinc-800"
              >
                <option value="">None</option>
                {TRACK_NAMES.map(name => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{t('completeTrackClasses')}</label>
              <div className="flex flex-wrap gap-2">
                {TRACK_NAMES.map(name => {
                  const selected = completeTrackClasses.split(',').map(s => s.trim()).filter(Boolean);
                  const isChecked = selected.includes(name);
                  return (
                    <label key={name} className="flex items-center gap-1 text-[10px] font-medium text-zinc-500 dark:text-zinc-400 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => {
                          const next = isChecked
                            ? selected.filter(s => s !== name)
                            : [...selected, name];
                          setCompleteTrackClasses(next.join(','));
                        }}
                        className="accent-pink-600"
                      />
                      {name}
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label
                className="flex items-center gap-2 text-xs font-medium text-zinc-600 dark:text-zinc-400"
                title={tf('hintUseAdg', 'Adaptive Dual Guidance: dynamically adjusts CFG for quality. Base model only; slower.')}
              >
                <input type="checkbox" checked={useAdg} onChange={() => setUseAdg(!useAdg)} />
                {t('useAdg')}
              </label>
              <label className="flex items-center gap-2 text-xs font-medium text-zinc-600 dark:text-zinc-400" title={tf('hintAllowLmBatch', 'Allow the LM to run in larger batches for speed (more VRAM).')}>
                <input type="checkbox" checked={allowLmBatch} onChange={() => setAllowLmBatch(!allowLmBatch)} />
                {t('allowLmBatch')}
              </label>
              <label className="flex items-center gap-2 text-xs font-medium text-zinc-600 dark:text-zinc-400" title={tf('hintUseCotMetas', 'Let the LM reason about metadata like BPM, key, duration.')}>
                <input type="checkbox" checked={useCotMetas} onChange={() => setUseCotMetas(!useCotMetas)} />
                {t('useCotMetas')}
              </label>
              <label className="flex items-center gap-2 text-xs font-medium text-zinc-600 dark:text-zinc-400" title={tf('hintUseCotCaption', 'Let the LM reason about the caption/style text.')}>
                <input type="checkbox" checked={useCotCaption} onChange={() => setUseCotCaption(!useCotCaption)} />
                {t('useCotCaption')}
              </label>
              <label className="flex items-center gap-2 text-xs font-medium text-zinc-600 dark:text-zinc-400" title={tf('hintUseCotLanguage', 'Let the LM reason about language selection.')}>
                <input type="checkbox" checked={useCotLanguage} onChange={() => setUseCotLanguage(!useCotLanguage)} />
                {t('useCotLanguage')}
              </label>
              <label className="flex items-center gap-2 text-xs font-medium text-zinc-600 dark:text-zinc-400" title={tf('hintAutogen', 'Auto-generate missing fields when possible.')}>
                <input type="checkbox" checked={autogen} onChange={() => setAutogen(!autogen)} />
                {t('autogen')}
              </label>
              <label className="flex items-center gap-2 text-xs font-medium text-zinc-600 dark:text-zinc-400" title={tf('hintConstrainedDecodingDebug', 'Include debug info for constrained decoding.')}>
                <input type="checkbox" checked={constrainedDecodingDebug} onChange={() => setConstrainedDecodingDebug(!constrainedDecodingDebug)} />
                {t('constrainedDecodingDebug')}
              </label>
              <label className="flex items-center gap-2 text-xs font-medium text-zinc-600 dark:text-zinc-400" title={tf('hintFormatCaption', 'Use the formatted caption produced by the AI formatter.')}>
                <input type="checkbox" checked={isFormatCaption} onChange={() => setIsFormatCaption(!isFormatCaption)} />
                {t('formatCaption')}
              </label>
              <label className="flex items-center gap-2 text-xs font-medium text-zinc-600 dark:text-zinc-400" title={tf('hintGetScores', 'Return scorer outputs for diagnostics.')}>
                <input type="checkbox" checked={getScores} onChange={() => setGetScores(!getScores)} />
                {t('getScores')}
              </label>
              <label className="flex items-center gap-2 text-xs font-medium text-zinc-600 dark:text-zinc-400" title={tf('hintGetLrcLyrics', 'Return synced lyric (LRC) output when available.')}>
                <input type="checkbox" checked={getLrc} onChange={() => setGetLrc(!getLrc)} />
                {t('getLrcLyrics')}
              </label>
            </div>
          </div>
        )}
      </div>

      {showAudioModal && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => { setShowAudioModal(false); setPlayingTrackId(null); setPlayingTrackSource(null); }}
          />
          <div className="relative w-[92%] max-w-lg rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-white/10 shadow-2xl overflow-hidden">
            {/* Header */}
            <div className="p-5 pb-4">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-xl font-semibold text-zinc-900 dark:text-white">
                    {audioModalTarget === 'reference' ? t('referenceModalTitle') : t('coverModalTitle')}
                  </h3>
                  <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
                    {audioModalTarget === 'reference'
                      ? t('referenceModalDescription')
                      : t('coverModalDescription')}
                  </p>
                </div>
                <button
                  onClick={() => { setShowAudioModal(false); setPlayingTrackId(null); setPlayingTrackSource(null); }}
                  className="p-1.5 rounded-lg hover:bg-zinc-100 dark:hover:bg-white/10 text-zinc-400 hover:text-zinc-900 dark:hover:text-white transition-colors"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
                  </svg>
                </button>
              </div>

              {/* Upload Button */}
              <button
                type="button"
                onClick={() => {
                  const input = document.createElement('input');
                  input.type = 'file';
                  input.accept = '.mp3,.wav,.flac,.m4a,.mp4,audio/*';
                  input.onchange = (e) => {
                    const file = (e.target as HTMLInputElement).files?.[0];
                    if (file) void uploadReferenceTrack(file);
                  };
                  input.click();
                }}
                disabled={isUploadingModalTarget || isTranscribingReference}
                className="mt-4 w-full flex items-center justify-center gap-2 rounded-xl border border-dashed border-zinc-300 dark:border-white/20 bg-zinc-50 dark:bg-white/5 px-4 py-3 text-sm font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-white/10 hover:border-zinc-400 dark:hover:border-white/30 transition-all"
              >
                {isUploadingModalTarget ? (
                  <>
                    <RefreshCw size={16} className="animate-spin" />
                    {t('uploadingAudio')}
                  </>
                ) : isTranscribingReference ? (
                  <>
                    <RefreshCw size={16} className="animate-spin" />
                    {t('transcribing')}
                  </>
                ) : (
                  <>
                    <Upload size={16} />
                    {t('uploadAudio')}
                    <span className="text-xs text-zinc-400 ml-1">{t('audioFormats')}</span>
                  </>
                )}
              </button>

              {uploadError && (
                <div className="mt-2 text-xs text-rose-500">{uploadError}</div>
              )}
              {isTranscribingReference && (
                <div className="mt-2 flex items-center justify-between text-xs text-zinc-400">
                  <span>{t('transcribingWithWhisper')}</span>
                  <button
                    type="button"
                    onClick={cancelTranscription}
                    className="text-zinc-600 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-white"
                  >
                    {t('cancel')}
                  </button>
                </div>
              )}
            </div>

            {/* Library Section */}
            <div className="border-t border-zinc-100 dark:border-white/5">
              <div className="px-5 py-3 flex items-center gap-2">
                <div className="flex items-center gap-1 bg-zinc-200/60 dark:bg-white/10 rounded-full p-0.5">
                  <button
                    type="button"
                    onClick={() => setLibraryTab('uploads')}
                    className={`px-3 py-1 rounded-full text-xs font-semibold transition-colors ${
                      libraryTab === 'uploads'
                        ? 'bg-zinc-900 dark:bg-white text-white dark:text-zinc-900'
                        : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200'
                    }`}
                  >
                    {t('uploaded')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setLibraryTab('created')}
                    className={`px-3 py-1 rounded-full text-xs font-semibold transition-colors ${
                      libraryTab === 'created'
                        ? 'bg-zinc-900 dark:bg-white text-white dark:text-zinc-900'
                        : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200'
                    }`}
                  >
                    {t('createdTab')}
                  </button>
                </div>
              </div>

              {/* Track List */}
              <div className="max-h-[280px] overflow-y-auto">
                {libraryTab === 'uploads' ? (
                  isLoadingTracks ? (
                    <div className="px-5 py-8 text-center">
                      <RefreshCw size={20} className="animate-spin mx-auto text-zinc-400" />
                      <p className="text-xs text-zinc-400 mt-2">{t('loadingTracks')}</p>
                    </div>
                  ) : referenceTracks.length === 0 ? (
                    <div className="px-5 py-8 text-center">
                      <Music2 size={24} className="mx-auto text-zinc-300 dark:text-zinc-600" />
                      <p className="text-sm text-zinc-400 mt-2">{t('noTracksYet')}</p>
                      <p className="text-xs text-zinc-400 mt-1">{t('uploadAudioFilesAsReferences')}</p>
                    </div>
                  ) : (
                    <div className="divide-y divide-zinc-100 dark:divide-white/5">
                      {referenceTracks.map((track) => (
                        <div
                          key={track.id}
                          className="px-5 py-3 flex items-center gap-3 hover:bg-zinc-50 dark:hover:bg-white/[0.02] transition-colors group"
                        >
                          {/* Play Button */}
                          <button
                            type="button"
                            onClick={() => toggleModalTrack({ id: track.id, audio_url: track.audio_url, source: 'uploads' })}
                            className="flex-shrink-0 w-9 h-9 rounded-full bg-zinc-100 dark:bg-white/10 text-zinc-600 dark:text-zinc-300 flex items-center justify-center hover:bg-zinc-200 dark:hover:bg-white/20 transition-colors"
                          >
                            {playingTrackId === track.id && playingTrackSource === 'uploads' ? (
                              <Pause size={14} fill="currentColor" />
                            ) : (
                              <Play size={14} fill="currentColor" className="ml-0.5" />
                            )}
                          </button>

                          {/* Track Info */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200 truncate">
                                {track.filename.replace(/\.[^/.]+$/, '')}
                              </span>
                              {track.tags && track.tags.length > 0 && (
                                <div className="flex gap-1">
                                  {track.tags.slice(0, 2).map((tag, i) => (
                                    <span key={i} className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-zinc-200 dark:bg-white/10 text-zinc-600 dark:text-zinc-400">
                                      {tag}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                            {/* Progress bar with seek - show when this track is playing */}
                            {playingTrackId === track.id && playingTrackSource === 'uploads' ? (
                              <div className="flex items-center gap-2 mt-1.5">
                                <span className="text-[10px] text-zinc-400 tabular-nums w-8">
                                  {formatTime(modalTrackTime)}
                                </span>
                                <div
                                  className="flex-1 h-1.5 rounded-full bg-zinc-200 dark:bg-white/10 cursor-pointer group/seek"
                                  onClick={(e) => {
                                    if (modalAudioRef.current && modalTrackDuration > 0) {
                                      const rect = e.currentTarget.getBoundingClientRect();
                                      const percent = (e.clientX - rect.left) / rect.width;
                                      modalAudioRef.current.currentTime = percent * modalTrackDuration;
                                    }
                                  }}
                                >
                                  <div
                                    className="h-full bg-gradient-to-r from-pink-500 to-purple-500 rounded-full relative"
                                    style={{ width: modalTrackDuration > 0 ? `${(modalTrackTime / modalTrackDuration) * 100}%` : '0%' }}
                                  >
                                    <div className="absolute right-0 top-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full bg-white shadow-md opacity-0 group-hover/seek:opacity-100 transition-opacity" />
                                  </div>
                                </div>
                                <span className="text-[10px] text-zinc-400 tabular-nums w-8 text-right">
                                  {formatTime(modalTrackDuration)}
                                </span>
                              </div>
                            ) : (
                              <div className="text-xs text-zinc-400 mt-0.5">
                                {track.duration ? formatTime(track.duration) : '--:--'}
                              </div>
                            )}
                          </div>

                          {/* Actions */}
                          <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button
                              type="button"
                              onClick={() => useReferenceTrack({ audio_url: track.audio_url, title: track.filename })}
                              className="px-3 py-1.5 rounded-lg bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 text-xs font-semibold hover:bg-zinc-800 dark:hover:bg-zinc-100 transition-colors"
                            >
                              {t('useTrack')}
                            </button>
                            <button
                              type="button"
                              onClick={() => void deleteReferenceTrack(track.id)}
                              className="p-1.5 rounded-lg hover:bg-zinc-200 dark:hover:bg-white/10 text-zinc-400 hover:text-rose-500 transition-colors"
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )
                ) : createdTrackOptions.length === 0 ? (
                  <div className="px-5 py-8 text-center">
                    <Music2 size={24} className="mx-auto text-zinc-300 dark:text-zinc-600" />
                    <p className="text-sm text-zinc-400 mt-2">{t('noCreatedSongsYet')}</p>
                    <p className="text-xs text-zinc-400 mt-1">{t('generateSongsToReuse')}</p>
                  </div>
                ) : (
                  <div className="divide-y divide-zinc-100 dark:divide-white/5">
                    {createdTrackOptions.map((track) => (
                      <div
                        key={track.id}
                        className="px-5 py-3 flex items-center gap-3 hover:bg-zinc-50 dark:hover:bg-white/[0.02] transition-colors group"
                      >
                        <button
                          type="button"
                          onClick={() => toggleModalTrack({ id: track.id, audio_url: track.audio_url, source: 'created' })}
                          className="flex-shrink-0 w-9 h-9 rounded-full bg-zinc-100 dark:bg-white/10 text-zinc-600 dark:text-zinc-300 flex items-center justify-center hover:bg-zinc-200 dark:hover:bg-white/20 transition-colors"
                        >
                          {playingTrackId === track.id && playingTrackSource === 'created' ? (
                            <Pause size={14} fill="currentColor" />
                          ) : (
                            <Play size={14} fill="currentColor" className="ml-0.5" />
                          )}
                        </button>

                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium text-zinc-800 dark:text-zinc-200 truncate">
                            {track.title}
                          </div>
                          {playingTrackId === track.id && playingTrackSource === 'created' ? (
                            <div className="flex items-center gap-2 mt-1.5">
                              <span className="text-[10px] text-zinc-400 tabular-nums w-8">
                                {formatTime(modalTrackTime)}
                              </span>
                              <div
                                className="flex-1 h-1.5 rounded-full bg-zinc-200 dark:bg-white/10 cursor-pointer group/seek"
                                onClick={(e) => {
                                  if (modalAudioRef.current && modalTrackDuration > 0) {
                                    const rect = e.currentTarget.getBoundingClientRect();
                                    const percent = (e.clientX - rect.left) / rect.width;
                                    modalAudioRef.current.currentTime = percent * modalTrackDuration;
                                  }
                                }}
                              >
                                <div
                                  className="h-full bg-gradient-to-r from-pink-500 to-purple-500 rounded-full relative"
                                  style={{ width: modalTrackDuration > 0 ? `${(modalTrackTime / modalTrackDuration) * 100}%` : '0%' }}
                                >
                                  <div className="absolute right-0 top-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full bg-white shadow-md opacity-0 group-hover/seek:opacity-100 transition-opacity" />
                                </div>
                              </div>
                              <span className="text-[10px] text-zinc-400 tabular-nums w-8 text-right">
                                {formatTime(modalTrackDuration)}
                              </span>
                            </div>
                          ) : (
                            <div className="text-xs text-zinc-400 mt-0.5">
                              {track.duration || '--:--'}
                            </div>
                          )}
                        </div>

                        <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            type="button"
                            onClick={() => useReferenceTrack({ audio_url: track.audio_url, title: track.title })}
                            className="px-3 py-1.5 rounded-lg bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 text-xs font-semibold hover:bg-zinc-800 dark:hover:bg-zinc-100 transition-colors"
                          >
                            {t('useTrack')}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Hidden audio element for modal playback */}
            <audio
              ref={modalAudioRef}
              onTimeUpdate={() => {
                if (modalAudioRef.current) {
                  setModalTrackTime(modalAudioRef.current.currentTime);
                }
              }}
              onLoadedMetadata={() => {
                if (modalAudioRef.current) {
                  setModalTrackDuration(modalAudioRef.current.duration);
                  // Update track duration in database if not set
                  const track = referenceTracks.find(t => t.id === playingTrackId);
                  if (playingTrackSource === 'uploads' && track && !track.duration && token) {
                    fetch(`/api/reference-tracks/${track.id}`, {
                      method: 'PATCH',
                      headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${token}`
                      },
                      body: JSON.stringify({ duration: Math.round(modalAudioRef.current.duration) })
                    }).then(() => {
                      setReferenceTracks(prev => prev.map(t =>
                        t.id === track.id ? { ...t, duration: Math.round(modalAudioRef.current?.duration || 0) } : t
                      ));
                    }).catch(() => undefined);
                  }
                }
              }}
              onEnded={() => setPlayingTrackId(null)}
            />
          </div>
        </div>
      )}

      {/* Footer Create Button */}
      <div className="p-4 mt-auto sticky bottom-0 bg-zinc-50/95 dark:bg-suno-panel/95 backdrop-blur-sm z-10 border-t border-zinc-200 dark:border-white/5 space-y-3">
        {preflightFailed && (
          <p className="text-[11px] text-amber-500 leading-snug">
            {tf('warnPreflightFailed', 'OpenRouter n\'a pas répondu (clé refusée ou service indisponible) : le morceau a été généré sans paroles. Vérifie ta clé dans les réglages avancés.')}
          </p>
        )}
        {descriptionCannotBeUsed && (
          <p className="text-[11px] text-red-500 leading-snug">
            {tf('errNothingToGenerate', 'Rien à envoyer au moteur : active OpenRouter pour développer la description, ou remplis Style ou Paroles.')}
          </p>
        )}
        <button
          onClick={handleGenerate}
          title={descriptionCannotBeUsed
            ? tf('errNothingToGenerate', 'Rien à envoyer au moteur : active OpenRouter pour développer la description, ou remplis Style ou Paroles.')
            : undefined}
          className={`w-full h-12 rounded-xl font-bold text-base flex items-center justify-center gap-2 transition-all transform active:scale-[0.98] bg-gradient-to-r from-orange-500 to-pink-600 text-white shadow-lg ${
            descriptionCannotBeUsed ? 'opacity-40 cursor-not-allowed' : 'hover:brightness-110'
          }`}
          disabled={!isAuthenticated || activeJobCount >= 10 || descriptionCannotBeUsed}
        >
          <Sparkles size={18} />
          <span>
            {bulkCount > 1
              ? `${t('createButton')} ${bulkCount} ${t('jobs')} (${bulkCount * batchSize} ${t('variations')})`
              : `${t('createButton')}${batchSize > 1 ? ` (${batchSize} ${t('variations')})` : ''}`
            }
          </span>
          {activeJobCount > 0 && (
            <span className={`ml-1 px-2 py-0.5 rounded-full text-xs tabular-nums ${activeJobCount >= 10 ? 'bg-red-500/30' : 'bg-white/20'}`}>
              {activeJobCount}/10
            </span>
          )}
        </button>
      </div>
    </div>
  );
};
