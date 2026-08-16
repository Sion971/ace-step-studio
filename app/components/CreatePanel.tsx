import { LoraPanel } from './LoraPanel';
import { ModelMenu } from './ModelMenu';
import { isTurboModel } from '../utils/modelNames';
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Sparkles, ChevronDown, Settings2, Trash2, Music2, Sliders, Dices, Hash, RefreshCw, Plus, Upload, Play, Pause, Loader2, Disc3, Undo2, Wand2, Square } from 'lucide-react';
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
  createTempSongForClick?: (descriptionPreview: string) => string;
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

const VOCAL_LANGUAGE_KEYS = [
  { value: 'unknown', key: 'autoInstrumental' as const },
  { value: 'ar', key: 'vocalArabic' as const },
  { value: 'az', key: 'vocalAzerbaijani' as const },
  { value: 'bg', key: 'vocalBulgarian' as const },
  { value: 'bn', key: 'vocalBengali' as const },
  { value: 'ca', key: 'vocalCatalan' as const },
  { value: 'cs', key: 'vocalCzech' as const },
  { value: 'da', key: 'vocalDanish' as const },
  { value: 'de', key: 'vocalGerman' as const },
  { value: 'el', key: 'vocalGreek' as const },
  { value: 'en', key: 'vocalEnglish' as const },
  { value: 'es', key: 'vocalSpanish' as const },
  { value: 'fa', key: 'vocalPersian' as const },
  { value: 'fi', key: 'vocalFinnish' as const },
  { value: 'fr', key: 'vocalFrench' as const },
  { value: 'he', key: 'vocalHebrew' as const },
  { value: 'hi', key: 'vocalHindi' as const },
  { value: 'hr', key: 'vocalCroatian' as const },
  { value: 'ht', key: 'vocalHaitianCreole' as const },
  { value: 'hu', key: 'vocalHungarian' as const },
  { value: 'id', key: 'vocalIndonesian' as const },
  { value: 'is', key: 'vocalIcelandic' as const },
  { value: 'it', key: 'vocalItalian' as const },
  { value: 'ja', key: 'vocalJapanese' as const },
  { value: 'ko', key: 'vocalKorean' as const },
  { value: 'la', key: 'vocalLatin' as const },
  { value: 'lt', key: 'vocalLithuanian' as const },
  { value: 'ms', key: 'vocalMalay' as const },
  { value: 'ne', key: 'vocalNepali' as const },
  { value: 'nl', key: 'vocalDutch' as const },
  { value: 'no', key: 'vocalNorwegian' as const },
  { value: 'pa', key: 'vocalPunjabi' as const },
  { value: 'pl', key: 'vocalPolish' as const },
  { value: 'pt', key: 'vocalPortuguese' as const },
  { value: 'ro', key: 'vocalRomanian' as const },
  { value: 'ru', key: 'vocalRussian' as const },
  { value: 'sa', key: 'vocalSanskrit' as const },
  { value: 'sk', key: 'vocalSlovak' as const },
  { value: 'sr', key: 'vocalSerbian' as const },
  { value: 'sv', key: 'vocalSwedish' as const },
  { value: 'sw', key: 'vocalSwahili' as const },
  { value: 'ta', key: 'vocalTamil' as const },
  { value: 'te', key: 'vocalTelugu' as const },
  { value: 'th', key: 'vocalThai' as const },
  { value: 'tl', key: 'vocalTagalog' as const },
  { value: 'tr', key: 'vocalTurkish' as const },
  { value: 'uk', key: 'vocalUkrainian' as const },
  { value: 'ur', key: 'vocalUrdu' as const },
  { value: 'vi', key: 'vocalVietnamese' as const },
  { value: 'yue', key: 'vocalCantonese' as const },
  { value: 'zh', key: 'vocalChineseMandarin' as const },
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
  const [customMode, setCustomMode] = useState(false);

  // Simple Mode
  const [songDescription, setSongDescription] = useState(() => localStorage.getItem('ace-songDescription') || '');

  // Custom Mode
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
  const [vocalGender, setVocalGender] = useState<'male' | 'female' | ''>('');

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
  const [instruction, setInstruction] = useState('Fill the audio semantic mask based on the given conditions:');
  const [audioCoverStrength, setAudioCoverStrength] = useState(0.5);
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
        customMode, instrumental, vocalLanguage, vocalGender, bpm, keyScale, timeSignature, duration, batchSize, bulkCount,
        guidanceScale, thinking, enhance, getLrc, audioFormat, inferenceSteps, inferMethod,
        shift, lmTemperature, lmCfgScale, lmTopK, lmTopP, lmNegativePrompt, useAdg, samplerMode, schedulerType,
        dcwEnabled, dcwMode, dcwScaler, dcwHighScaler, dcwWavelet, retakeSeed, retakeVariance,
        flowEditMorph, flowEditSourceCaption, flowEditSourceLyrics, flowEditNMin, flowEditNMax, flowEditNAvg,
        mp3Bitrate, mp3SampleRate, ...overrides,
      };
      settingsApi.save(settings, token).catch(() => {});
    }, 1000);
  }, [token, customMode, instrumental, vocalLanguage, vocalGender, bpm, keyScale, timeSignature, duration, batchSize, bulkCount,
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
      if (s.customMode !== undefined) setCustomMode(s.customMode as boolean);
      if (s.instrumental !== undefined) setInstrumental(s.instrumental as boolean);
      if (s.vocalLanguage !== undefined) setVocalLanguage(s.vocalLanguage as string);
      if (s.vocalGender !== undefined) setVocalGender(s.vocalGender as 'male' | 'female' | '');
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
      if (s.retakeVariance !== undefined) setRetakeVariance(Number(s.retakeVariance));
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
  const [audioTab, setAudioTab] = useState<'reference' | 'source'>('reference');
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
        if (data.task_type !== undefined) setTaskType(data.task_type);
        if (data.audio_codes !== undefined) setAudioCodes(data.audio_codes);
        if (data.repainting_start !== undefined) setRepaintingStart(data.repainting_start);
        if (data.repainting_end !== undefined) setRepaintingEnd(data.repainting_end);
        if (data.instruction !== undefined) setInstruction(data.instruction);
        if (data.audio_cover_strength !== undefined) setAudioCoverStrength(data.audio_cover_strength);
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
      setCustomMode(true);
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

  const applyAudioTargetUrl = (target: 'reference' | 'source', url: string, title?: string) => {
    const derivedTitle = title ? title.replace(/\.[^/.]+$/, '') : getAudioLabel(url);
    if (target === 'reference') {
      setReferenceAudioUrl(url);
      setReferenceAudioTitle(derivedTitle);
      setReferenceTime(0);
      setReferenceDuration(0);
    } else {
      setSourceAudioUrl(url);
      setSourceAudioTitle(derivedTitle);
      setSourceTime(0);
      setSourceDuration(0);
      if (taskType === 'text2music') {
        setTaskType('cover');
      }
      // Reference and Cover are now independent — don't auto-fill
      if (false) {
      }
    }
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
    const slotsClaimed = bulkCount;
    incrementPendingClicks?.(slotsClaimed);
    // Create a visible placeholder card per bulk variant — instant feedback.
    const tempIds: string[] = [];
    if (createTempSongForClick) {
      const previewBase = (customMode ? (title || style || lyrics || 'Track') : (songDescription || 'Track')).slice(0, 60);
      for (let i = 0; i < slotsClaimed; i++) {
        const preview = slotsClaimed > 1 ? `${previewBase} (${i + 1})` : previewBase;
        tempIds.push(createTempSongForClick(preview));
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
    if (!customMode && useOpenRouter && !activeLmModel) {
      if (!songDescription.trim()) { releaseClaimedSlots(); return; }
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
        if (!perClickDraft) { releaseClaimedSlots(); return; }
        // Stamp the model id used for this song — `orHook` only updates this
        // for the explicit AI buttons, not the Simple-mode pre-flight, so
        // without this `params.openrouterModel` would always be null for
        // Simple+OR generations and the song-row badge tooltip would be empty.
        const orModelId = llmStorage.getOpenRouter().model;
        if (orModelId) setLastOpenRouterModelId(orModelId);
      } catch (e) {
        console.error('[Simple+OR] queued pre-flight failed:', e);
        releaseClaimedSlots();
        return;
      }
    }

    // After pre-flight we ALWAYS submit in customMode shape so the backend
    // doesn't try to re-expand the description through a non-existent LM.
    const effectiveCustomMode = customMode || (useOpenRouter && !activeLmModel);
    // Prefer this-click's per-click draft (set by the OR pre-flight above).
    // Fallback to refs (which reflect the LAST successful streamed gen).
    // Final fallback to the React state values shown in the form.
    const d = perClickDraft;
    const effStyle = effectiveCustomMode && (d?.caption || styleRef.current) ? (d?.caption || styleRef.current) : style;
    const effLyrics = effectiveCustomMode && (d?.lyrics || lyricsTextRef.current) ? (d?.lyrics || lyricsTextRef.current) : lyrics;
    const effTitle = effectiveCustomMode && (d?.title || titleRef.current) ? (d?.title || titleRef.current) : title;
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

      // Simple mode: use only songDescription + safe defaults, ignore custom mode settings
      // Custom mode: use all user-configured parameters
      // Pass the pre-created placeholder tempId so App.tsx promotes it instead
      // of creating a duplicate card.
      const tempIdForThisJob = tempIds[i];
      onGenerate(effectiveCustomMode ? {
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
        retakeSeed: Number(retakeSeed) || -1,
        retakeVariance,
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
      } : {
        // Simple mode — isolated defaults, no custom mode bleed-through
        _tempId: tempIdForThisJob,
        customMode: false,
        songDescription,
        prompt: songDescription,
        lyrics: instrumental ? '[Instrumental]' : '',
        style: '',
        title: '',
        ditModel: selectedModel,
        instrumental,
        vocalLanguage,
        // Le serveur active DCW par défaut. Sans ces champs, le mode Simple
        // l'appliquait quel que soit l'état de l'interrupteur, qui n'existe
        // que dans les réglages avancés du mode Personnalisé.
        dcwEnabled,
        dcwMode,
        dcwScaler,
        dcwHighScaler,
        dcwWavelet,
        bpm: 0,
        keyScale: '',
        timeSignature: '',
        duration: -1,
        inferenceSteps: 12,
        guidanceScale: 9.0,
        batchSize: 1,
        randomSeed: true,
        seed: -1,
        thinking: false,
        enhance: false,
        audioFormat: 'mp3' as const,
        inferMethod: 'ode' as const,
        lmBackend: 'pt' as const,
        lmModel: 'acestep-5Hz-lm-0.6B',
        shift: 3.0,
        taskType: 'text2music',
        getLrc,
        getScores: false,
        loraLoaded,
        // Pollinations cover-gen config — must be threaded through Simple
        // mode too. Without this, Simple+local-LM users who toggle the
        // Pollinations panel ON get effectiveCustomMode=false (because
        // !customMode && !(useOpenRouter && !activeLmModel)) and the
        // backend's startCoverGen guard `pol?.enabled && pol.model && pol.prompt`
        // fails (`pol` is undefined) → covers silently never generate.
        // Use the keyword-based prompt fallback since Simple+local-LM has
        // no LLM coverPrompt available (the local LM doesn't expose one).
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
            prompt: buildCoverPrompt({
              title: '',
              caption: '',
              topic: songDescription,
              language: vocalLanguage,
              instrumental,
            }),
          };
        })() : { enabled: false },
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

        {/* Header Row 2 - Simple / Custom toggle */}
        <div className="flex items-center bg-zinc-200 dark:bg-black/40 rounded-lg p-1 border border-zinc-300 dark:border-white/5">
          <button
            onClick={() => setCustomMode(false)}
            className={`flex-1 py-1.5 rounded-md text-xs font-semibold transition-all text-center ${!customMode ? 'bg-white dark:bg-zinc-800 text-black dark:text-white shadow-sm' : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-300'}`}
          >
            {t('simple')}
          </button>
          <button
            onClick={() => setCustomMode(true)}
            className={`flex-1 py-1.5 rounded-md text-xs font-semibold transition-all text-center ${customMode ? 'bg-white dark:bg-zinc-800 text-black dark:text-white shadow-sm' : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-300'}`}
          >
            {t('custom')}
          </button>
        </div>

        {/* SIMPLE MODE */}
        {!customMode && (
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
                  title={t('hintLoadRandom') || 'Load random description'}
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
            </div>

            {/* Upload Audio (Simple Mode - like Suno's upload button) */}
            {!sourceAudioUrl ? (
              <button
                type="button"
                onClick={() => {
                  setCustomMode(true);
                  setAudioTab('source');
                  setTimeout(() => {
                    sourceInputRef.current?.click();
                  }, 100);
                }}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl border-2 border-dashed border-zinc-300 dark:border-white/10 text-zinc-500 dark:text-zinc-400 hover:border-pink-400 dark:hover:border-pink-500 hover:text-pink-500 transition-colors text-xs font-medium"
              >
                <Upload size={14} />
                {t('uploadForCover') || 'Upload audio for Cover / Remix'}
              </button>
            ) : (
              <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-white dark:bg-suno-card border border-zinc-200 dark:border-white/5">
                <Disc3 size={14} className="text-pink-500 flex-shrink-0" />
                <span className="text-xs text-zinc-700 dark:text-zinc-300 truncate flex-1">
                  {sourceAudioTitle || 'Source audio'}
                </span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-pink-500/10 text-pink-500 font-medium">
                  {taskType === 'repaint' ? 'Repaint' : 'Cover'}
                </span>
                <button
                  type="button"
                  onClick={() => { setSourceAudioUrl(''); setSourceAudioTitle(''); setTaskType('text2music'); }}
                  className="text-zinc-400 hover:text-red-500 transition-colors"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            )}

            {/* Instrumental Toggle (Simple) */}
            <div className="flex items-center justify-between px-1">
              <label className="text-xs font-bold text-zinc-500 dark:text-zinc-400 uppercase tracking-wide">
                {t('instrumental')}
              </label>
              <button
                type="button"
                onClick={() => setInstrumental(!instrumental)}
                className={`relative w-10 h-5 rounded-full transition-colors flex-shrink-0 ${instrumental ? 'bg-pink-500' : 'bg-zinc-300 dark:bg-zinc-600'}`}
              >
                <span className={`absolute top-[2px] w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${instrumental ? 'left-[22px]' : 'left-[2px]'}`} />
              </button>
            </div>

            {/* Vocal Language (Simple) - hidden when instrumental */}
            {!instrumental && <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs font-bold text-zinc-500 dark:text-zinc-400 uppercase tracking-wide px-1">
                  {t('vocalLanguage')}
                </label>
                <select
                  value={vocalLanguage}
                  onChange={(e) => setVocalLanguage(e.target.value)}
                  className="w-full bg-white dark:bg-suno-card border border-zinc-200 dark:border-white/5 rounded-xl px-3 py-2 text-sm text-zinc-900 dark:text-white focus:outline-none focus:border-pink-500 dark:focus:border-pink-500 transition-colors cursor-pointer [&>option]:bg-white [&>option]:dark:bg-zinc-800 [&>option]:text-zinc-900 [&>option]:dark:text-white"
                >
                  {VOCAL_LANGUAGE_KEYS.map(lang => (
                    <option key={lang.value} value={lang.value}>{t(lang.key)}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-bold text-zinc-500 dark:text-zinc-400 uppercase tracking-wide px-1">
                  {t('vocalGender')}
                </label>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setVocalGender(vocalGender === 'male' ? '' : 'male')}
                    className={`flex-1 px-3 py-2 rounded-lg text-xs font-semibold border transition-colors ${vocalGender === 'male' ? 'bg-pink-600 text-white border-pink-600' : 'border-zinc-200 dark:border-white/10 text-zinc-600 dark:text-zinc-300 hover:border-zinc-300 dark:hover:border-white/20'}`}
                  >
                    {t('male')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setVocalGender(vocalGender === 'female' ? '' : 'female')}
                    className={`flex-1 px-3 py-2 rounded-lg text-xs font-semibold border transition-colors ${vocalGender === 'female' ? 'bg-pink-600 text-white border-pink-600' : 'border-zinc-200 dark:border-white/10 text-zinc-600 dark:text-zinc-300 hover:border-zinc-300 dark:hover:border-white/20'}`}
                  >
                    {t('female')}
                  </button>
                </div>
              </div>
            </div>}

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

          </div>
        )}

        {/* CUSTOM MODE */}
        {customMode && (
          <div className="space-y-5">
            {/* Reference Audio */}
            <div onDrop={(e) => { e.stopPropagation(); handleDrop(e, 'reference'); e.currentTarget.classList.remove('ring-2', 'ring-zinc-400/50'); }} onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); e.currentTarget.classList.add('ring-2', 'ring-zinc-400/50'); }} onDragLeave={(e) => { e.currentTarget.classList.remove('ring-2', 'ring-zinc-400/50'); }}
              className="bg-white dark:bg-[#1a1a1f] rounded-xl border border-zinc-200 dark:border-white/5 overflow-hidden transition-shadow">
              <div className="px-3 py-2 border-b border-zinc-100 dark:border-white/5 bg-zinc-50 dark:bg-white/[0.02] flex items-center justify-between">
                <span className="text-[11px] font-bold text-zinc-500 dark:text-zinc-400 uppercase tracking-wide">{t('reference')}</span>
                {!referenceAudioUrl && <div className="flex gap-1">
                  <button type="button" onClick={() => openAudioModal('reference', 'uploads')} className="px-2 py-0.5 rounded text-[10px] text-zinc-400 hover:text-zinc-200 hover:bg-white/10 transition-colors">{t('fromLibrary')}</button>
                  <button type="button" onClick={() => referenceInputRef.current?.click()} className="px-2 py-0.5 rounded text-[10px] text-zinc-400 hover:text-zinc-200 hover:bg-white/10 transition-colors">{t('upload')}</button>
                </div>}
              </div>
              {referenceAudioUrl ? (
                <div className="p-2">
                  <div className="flex items-center gap-3 p-2 rounded-lg bg-zinc-50 dark:bg-white/[0.03] border border-zinc-100 dark:border-white/5">
                    <button type="button" onClick={() => toggleAudio('reference')} className="relative flex-shrink-0 w-10 h-10 rounded-full bg-gradient-to-br from-pink-500 to-purple-600 text-white flex items-center justify-center shadow-lg shadow-pink-500/20 hover:scale-105 transition-transform">
                      {referencePlaying ? <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z"/></svg> : <svg className="w-4 h-4 ml-0.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>}
                      <span className="absolute -bottom-1 -right-1 text-[8px] font-bold bg-zinc-900 text-white px-1 py-0.5 rounded">{formatTime(referenceDuration)}</span>
                    </button>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-1">
                        <div className="text-xs font-medium text-zinc-800 dark:text-zinc-200 truncate">{referenceAudioTitle || getAudioLabel(referenceAudioUrl)}</div>
                        <span className="text-[10px] text-zinc-400 tabular-nums ml-2 flex-shrink-0">{formatTime(referenceTime)} / {formatTime(referenceDuration)}</span>
                      </div>
                      <AudioWaveform
                        url={referenceAudioUrl}
                        currentTime={referenceTime}
                        duration={referenceDuration}
                        activeColor="#ec4899"
                        inactiveColor="rgba(255,255,255,0.08)"
                        height={28}
                        onClick={(pct) => { if (referenceAudioRef.current && referenceDuration > 0) referenceAudioRef.current.currentTime = pct * referenceDuration; }}
                      />
                    </div>
                    <button type="button" onClick={() => { setReferenceAudioUrl(''); setReferenceAudioTitle(''); setReferencePlaying(false); setReferenceTime(0); setReferenceDuration(0); }} className="p-1.5 rounded-full hover:bg-zinc-200 dark:hover:bg-white/10 text-zinc-400 hover:text-zinc-600 dark:hover:text-white transition-colors">
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
                    </button>
                  </div>
                </div>
              ) : (
                <div className={`px-3 text-center text-[10px] text-zinc-400 transition-all ${isDraggingFile ? 'py-8 text-zinc-300 border-2 border-dashed border-zinc-600 rounded-lg mx-2 mb-2' : 'py-3'}`}>{isDraggingFile ? '↓ ' + (t('reference') || 'Reference') : (t('dropAudioHere') || 'Drop audio or use buttons above')}</div>
              )}
            </div>

            {/* Cover / Source Audio */}
            <div onDrop={(e) => { e.stopPropagation(); handleDrop(e, 'source'); e.currentTarget.classList.remove('ring-2', 'ring-zinc-400/50'); }} onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); e.currentTarget.classList.add('ring-2', 'ring-zinc-400/50'); }} onDragLeave={(e) => { e.currentTarget.classList.remove('ring-2', 'ring-zinc-400/50'); }}
              className="bg-white dark:bg-[#1a1a1f] rounded-xl border border-zinc-200 dark:border-white/5 overflow-hidden transition-shadow">
              <div className="px-3 py-2 border-b border-zinc-100 dark:border-white/5 bg-zinc-50 dark:bg-white/[0.02] flex items-center justify-between">
                <span className="text-[11px] font-bold text-zinc-500 dark:text-zinc-400 uppercase tracking-wide">{t('cover')}</span>
                {!sourceAudioUrl && <div className="flex gap-1">
                  <button type="button" onClick={() => openAudioModal('source', 'uploads')} className="px-2 py-0.5 rounded text-[10px] text-zinc-400 hover:text-zinc-200 hover:bg-white/10 transition-colors">{t('fromLibrary')}</button>
                  <button type="button" onClick={() => sourceInputRef.current?.click()} className="px-2 py-0.5 rounded text-[10px] text-zinc-400 hover:text-zinc-200 hover:bg-white/10 transition-colors">{t('upload')}</button>
                </div>}
              </div>
              {sourceAudioUrl ? (
                <div className="p-2 space-y-2">
                  <div className="flex items-center gap-3 p-2 rounded-lg bg-zinc-50 dark:bg-white/[0.03] border border-zinc-100 dark:border-white/5">
                    <button type="button" onClick={() => toggleAudio('source')} className="relative flex-shrink-0 w-10 h-10 rounded-full bg-gradient-to-br from-emerald-500 to-teal-600 text-white flex items-center justify-center shadow-lg shadow-emerald-500/20 hover:scale-105 transition-transform">
                      {sourcePlaying ? <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z"/></svg> : <svg className="w-4 h-4 ml-0.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>}
                      <span className="absolute -bottom-1 -right-1 text-[8px] font-bold bg-zinc-900 text-white px-1 py-0.5 rounded">{formatTime(sourceDuration)}</span>
                    </button>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-1">
                        <div className="text-xs font-medium text-zinc-800 dark:text-zinc-200 truncate">{sourceAudioTitle || getAudioLabel(sourceAudioUrl)}</div>
                        <span className="text-[10px] text-zinc-400 tabular-nums ml-2 flex-shrink-0">{formatTime(sourceTime)} / {formatTime(sourceDuration)}</span>
                      </div>
                      <AudioWaveform
                        url={sourceAudioUrl}
                        currentTime={sourceTime}
                        duration={sourceDuration}
                        activeColor="#10b981"
                        inactiveColor="rgba(255,255,255,0.08)"
                        height={taskType === 'repaint' ? 48 : 28}
                        onClick={taskType !== 'repaint' ? ((pct) => { if (sourceAudioRef.current && sourceDuration > 0) sourceAudioRef.current.currentTime = pct * sourceDuration; }) : undefined}
                        regionStart={taskType === 'repaint' ? repaintingStart : undefined}
                        regionEnd={taskType === 'repaint' ? repaintingEnd : undefined}
                        onRegionChange={taskType === 'repaint' ? ((s, e) => { setRepaintingStart(Math.round(s * 10) / 10); setRepaintingEnd(e < 0 ? -1 : Math.round(e * 10) / 10); }) : undefined}
                      />
                    </div>
                    <button type="button" onClick={() => { setSourceAudioUrl(''); setSourceAudioTitle(''); setSourcePlaying(false); setSourceTime(0); setSourceDuration(0); setTaskType('text2music'); }} className="p-1.5 rounded-full hover:bg-zinc-200 dark:hover:bg-white/10 text-zinc-400 hover:text-zinc-600 dark:hover:text-white transition-colors">
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
                    </button>
                  </div>
                  {/* Cover/Repaint controls */}
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-medium text-zinc-500 dark:text-zinc-400 w-10">{t('mode') || 'Mode'}</span>
                      <div className="flex items-center gap-1 bg-zinc-100 dark:bg-black/20 rounded-lg p-0.5 flex-1">
                        <button type="button" onClick={() => setTaskType('cover')} className={`flex-1 py-1 rounded-md text-[10px] font-medium transition-all text-center ${taskType === 'cover' || taskType === 'audio2audio' ? 'bg-white dark:bg-zinc-700 text-zinc-900 dark:text-white shadow-sm' : 'text-zinc-500'}`}>Cover</button>
                        <button type="button" onClick={() => setTaskType('repaint')} className={`flex-1 py-1 rounded-md text-[10px] font-medium transition-all text-center ${taskType === 'repaint' ? 'bg-white dark:bg-zinc-700 text-zinc-900 dark:text-white shadow-sm' : 'text-zinc-500'}`}>Repaint</button>
                      </div>
                    </div>
                    <div className="space-y-0.5">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-medium text-zinc-500 dark:text-zinc-400 w-10">{t('audioCoverStrength') || 'Influence'}</span>
                        <input type="range" min="0" max="1" step="0.01" value={audioCoverStrength} onChange={(e) => setAudioCoverStrength(Number(e.target.value))} className="flex-1 h-1 accent-pink-500 cursor-pointer" />
                        <span className="text-[10px] text-zinc-500 tabular-nums w-8 text-right">{Math.round(audioCoverStrength * 100)}%</span>
                      </div>
                      <p className="text-[9px] text-zinc-400 dark:text-zinc-500 pl-12">{t('hintAudioCoverStrength') || '0% — model freedom, 100% — closest to the original'}</p>
                    </div>
                    {taskType === 'repaint' && (<>
                      <div className="space-y-0.5">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-medium text-zinc-500 dark:text-zinc-400 w-10">{t('strength') || 'Strength'}</span>
                          <input type="range" min="0" max="1" step="0.05" value={repaintStrength} onChange={(e) => setRepaintStrength(Number(e.target.value))} className="flex-1 h-1 accent-purple-500 cursor-pointer" />
                          <span className="text-[10px] text-zinc-500 tabular-nums w-8 text-right">{Math.round(repaintStrength * 100)}%</span>
                        </div>
                        <p className="text-[9px] text-zinc-400 dark:text-zinc-500 pl-12">{t('hintRepaintStrength') || '0% — fully regenerate the region, 100% — leave it almost unchanged'}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-medium text-zinc-500 dark:text-zinc-400 w-10">{t('region') || 'Region'}</span>
                        <div className="flex items-center gap-1 flex-1">
                          <input type="number" step="0.1" min="0" placeholder="0s" value={repaintingStart || ''} onChange={(e) => setRepaintingStart(Number(e.target.value))} className="w-16 bg-zinc-100 dark:bg-black/30 border border-zinc-200 dark:border-white/10 rounded px-1.5 py-0.5 text-[10px] text-zinc-900 dark:text-white text-center focus:outline-none focus:border-purple-500" />
                          <span className="text-[10px] text-zinc-400">—</span>
                          <input type="number" step="0.1" min="-1" placeholder={t('end') || 'end'} value={repaintingEnd === -1 ? '' : repaintingEnd} onChange={(e) => setRepaintingEnd(e.target.value === '' ? -1 : Number(e.target.value))} className="w-16 bg-zinc-100 dark:bg-black/30 border border-zinc-200 dark:border-white/10 rounded px-1.5 py-0.5 text-[10px] text-zinc-900 dark:text-white text-center focus:outline-none focus:border-purple-500" />
                          <span className="text-[10px] text-zinc-400">{t('seconds') || 'sec'}</span>
                        </div>
                      </div>
                    </>)}
                  </div>
                </div>
              ) : (
                <div className={`px-3 text-center text-[10px] text-zinc-400 transition-all ${isDraggingFile ? 'py-8 text-zinc-300 border-2 border-dashed border-zinc-600 rounded-lg mx-2 mb-2' : 'py-3'}`}>{isDraggingFile ? '↓ ' + (t('cover') || 'Cover') : (t('dropAudioForCover') || 'Drop audio for Cover / Remix')}</div>
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
                    title={t('aiGenerate') || 'Generate lyrics from scratch'}
                    onClick={useOpenRouter && isGenLyricsActive ? () => orHook.cancel() : () => handleAiGenerate('lyrics')}
                    disabled={(isGenLyricsActive && !useOpenRouter) || isFmtLyricsActive || (orRunning && !isGenLyricsActive) || !style.trim()}
                  >
                    {useOpenRouter && isGenLyricsActive
                      ? <Square size={14} />
                      : (isGenLyricsActive ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />)}
                  </button>
                  <button
                    className={`p-1.5 hover:bg-zinc-200 dark:hover:bg-white/10 rounded transition-colors ${isFmtLyricsActive ? 'text-pink-500' : 'text-zinc-500 hover:text-black dark:hover:text-white'}`}
                    title={t('aiFormat') || 'Enhance existing lyrics'}
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

            {/* Vocal Language & Gender (Custom mode) */}
            {customMode && !instrumental && (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-zinc-500 dark:text-zinc-400 uppercase tracking-wide px-1">
                    {t('vocalLanguage')}
                  </label>
                  <select
                    value={vocalLanguage}
                    onChange={(e) => setVocalLanguage(e.target.value)}
                    className="w-full bg-white dark:bg-suno-card border border-zinc-200 dark:border-white/5 rounded-xl px-3 py-2 text-sm text-zinc-900 dark:text-white focus:outline-none focus:border-pink-500 dark:focus:border-pink-500 transition-colors cursor-pointer [&>option]:bg-white [&>option]:dark:bg-zinc-800 [&>option]:text-zinc-900 [&>option]:dark:text-white"
                  >
                    {VOCAL_LANGUAGE_KEYS.map(lang => (
                      <option key={lang.value} value={lang.value}>{t(lang.key)}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-zinc-500 dark:text-zinc-400 uppercase tracking-wide px-1">
                    {t('vocalGender')}
                  </label>
                  <select
                    value={vocalGender}
                    onChange={(e) => setVocalGender(e.target.value as 'male' | 'female' | '')}
                    className="w-full bg-white dark:bg-suno-card border border-zinc-200 dark:border-white/5 rounded-xl px-3 py-2 text-sm text-zinc-900 dark:text-white focus:outline-none focus:border-pink-500 dark:focus:border-pink-500 transition-colors cursor-pointer [&>option]:bg-white [&>option]:dark:bg-zinc-800 [&>option]:text-zinc-900 [&>option]:dark:text-white"
                  >
                    <option value="">Auto</option>
                    <option value="male">{t('male')}</option>
                    <option value="female">{t('female')}</option>
                  </select>
                </div>
              </div>
            )}

            {/* LRC Toggle (Custom Mode) */}
            {customMode && (
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
            )}

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
                    title={t('aiGenerate') || 'Generate style from scratch'}
                    onClick={useOpenRouter && isGenStyleActive ? () => orHook.cancel() : () => handleAiGenerate('style')}
                    disabled={(isGenStyleActive && !useOpenRouter) || isFmtStyleActive || (orRunning && !isGenStyleActive) || !style.trim()}
                  >
                    {useOpenRouter && isGenStyleActive
                      ? <Square size={14} />
                      : (isGenStyleActive ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />)}
                  </button>
                  <button
                    className={`p-1.5 hover:bg-zinc-200 dark:hover:bg-white/10 rounded transition-colors ${isFmtStyleActive ? 'text-pink-500' : 'text-zinc-500 hover:text-black dark:hover:text-white'}`}
                    title={t('aiFormat') || 'Enhance existing style'}
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
        )}

        {/* Quick Settings (both modes) */}
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
        {customMode && (
          <LoraPanel
            token={token}
            t={t}
            selectedModel={selectedModel}
            loraLoaded={loraLoaded}
            onLoadedChange={setLoraLoaded}
          />
        )}

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
              title={t('hintBatchVariations') || 'Creates multiple variations in a single run. More variations = longer total time.'}
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
              title={t('hintInferenceSteps') || 'More steps usually improves quality but slows generation.'}
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
              title={t('hintGuidanceScale') || 'How strongly the model follows the prompt. Higher = stricter, lower = freer. 0 = no guidance (turbo).'}
            />

            {/* Audio Format, Inference Method, Sampler, Scheduler */}
            <div className="grid grid-cols-4 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{t('audioFormat')}</label>
                <select
                  value={audioFormat}
                  onChange={(e) => setAudioFormat(e.target.value as 'mp3' | 'flac')}
                  className="w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-xl px-2 py-1.5 text-xs text-zinc-900 dark:text-white focus:outline-none focus:border-pink-500 dark:focus:border-pink-500 transition-colors cursor-pointer [&>option]:bg-white [&>option]:dark:bg-zinc-800 [&>option]:text-zinc-900 [&>option]:dark:text-white"
                >
                  <option value="mp3">{t('mp3Smaller')}</option>
                  <option value="flac">{t('flacLossless')}</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{t('inferMethod')}</label>
                <select
                  value={inferMethod}
                  onChange={(e) => {
                    const val = e.target.value as 'ode' | 'sde';
                    setInferMethod(val);
                    // SDE only works with Euler
                    if (val === 'sde' && samplerMode !== 'euler') setSamplerMode('euler');
                  }}
                  className="w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-xl px-2 py-1.5 text-xs text-zinc-900 dark:text-white focus:outline-none focus:border-pink-500 dark:focus:border-pink-500 transition-colors cursor-pointer [&>option]:bg-white [&>option]:dark:bg-zinc-800 [&>option]:text-zinc-900 [&>option]:dark:text-white"
                >
                  <option value="ode">{t('odeDeterministic')}</option>
                  <option value="sde">{t('sdeStochastic')}</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{t('samplerMode') || 'Sampler'}</label>
                <select
                  value={samplerMode}
                  onChange={(e) => {
                    const val = e.target.value;
                    setSamplerMode(val);
                    // Non-euler samplers require ODE
                    if (val !== 'euler' && inferMethod === 'sde') setInferMethod('ode');
                    // Multistep samplers (deis/ipndm) need uniform steps → force linear scheduler
                    if ((val === 'deis' || val === 'ipndm') && schedulerType !== 'linear') setSchedulerType('linear');
                  }}
                  className="w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-xl px-2 py-1.5 text-xs text-zinc-900 dark:text-white focus:outline-none focus:border-pink-500 dark:focus:border-pink-500 transition-colors cursor-pointer [&>option]:bg-white [&>option]:dark:bg-zinc-800 [&>option]:text-zinc-900 [&>option]:dark:text-white"
                >
                  {(inferMethod === 'sde' || turboActive) ? (
                    <option value="euler">Euler</option>
                  ) : (
                    <>
                      <option value="euler">Euler (1st)</option>
                      <option value="heun">Heun (2nd)</option>
                      <option value="midpoint">Midpoint (2nd)</option>
                      <option value="a2s">A²S (2nd, fast)</option>
                      <option value="pingpong">PingPong (2nd)</option>
                      <option value="bogacki">Bogacki (3rd)</option>
                      <option value="rk4">RK4 (4th)</option>
                      <option value="dopri5">DOPRI5 (5th)</option>
                      <option value="deis">DEIS (multi)</option>
                      <option value="ipndm">iPNDM (multi)</option>
                    </>
                  )}
                </select>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{t('schedulerType') || 'Scheduler'}</label>
                <select
                  value={schedulerType}
                  onChange={(e) => {
                    const val = e.target.value;
                    setSchedulerType(val);
                    // Non-linear schedulers incompatible with multistep samplers
                    if (val !== 'linear' && (samplerMode === 'deis' || samplerMode === 'ipndm')) setSamplerMode('euler');
                  }}
                  className="w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-xl px-2 py-1.5 text-xs text-zinc-900 dark:text-white focus:outline-none focus:border-pink-500 dark:focus:border-pink-500 transition-colors cursor-pointer [&>option]:bg-white [&>option]:dark:bg-zinc-800 [&>option]:text-zinc-900 [&>option]:dark:text-white"
                >
                  {(samplerMode === 'deis' || samplerMode === 'ipndm' || turboActive) ? (
                    <option value="linear">Linear</option>
                  ) : (
                    <>
                      <option value="linear">Linear</option>
                      <option value="karras">Karras</option>
                      <option value="cosine">Cosine</option>
                      <option value="beta">Beta</option>
                      <option value="sway">Sway (F5-TTS)</option>
                      <option value="logit_normal">Logit-Normal (SD3)</option>
                      <option value="laplace">Laplace (SOTA)</option>
                    </>
                  )}
                </select>
              </div>
            </div>

            {/* DCW (Differential Correction in Wavelet domain) — CVPR 2026 quality boost */}
            <div className="rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50/50 dark:bg-black/10 p-3 space-y-2">
              <label className="text-xs font-semibold text-zinc-700 dark:text-zinc-300 flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={dcwEnabled}
                  onChange={(e) => setDcwEnabled(e.target.checked)}
                  className="w-3.5 h-3.5 rounded accent-pink-500"
                />
                {t('dcwEnabledLabel') || 'DCW Quality Correction'}
              </label>
              {dcwEnabled && (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <label className="text-[11px] text-zinc-600 dark:text-zinc-400">{t('dcwModeLabel') || 'Mode'}</label>
                      <select
                        value={dcwMode}
                        onChange={(e) => setDcwMode(e.target.value as 'low' | 'high' | 'double' | 'pix')}
                        className="w-full bg-white dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-2 py-1 text-xs text-zinc-900 dark:text-white focus:outline-none focus:border-pink-500 cursor-pointer [&>option]:bg-white [&>option]:dark:bg-zinc-800"
                      >
                        <option value="low">Low band</option>
                        <option value="high">High band</option>
                        <option value="double">Double (recommended)</option>
                        <option value="pix">Pixel</option>
                      </select>
                    </div>
                    <div className="space-y-1">
                      <label className="text-[11px] text-zinc-600 dark:text-zinc-400">{t('dcwWaveletLabel') || 'Wavelet'}</label>
                      <select
                        value={dcwWavelet}
                        onChange={(e) => setDcwWavelet(e.target.value)}
                        className="w-full bg-white dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-2 py-1 text-xs text-zinc-900 dark:text-white focus:outline-none focus:border-pink-500 cursor-pointer [&>option]:bg-white [&>option]:dark:bg-zinc-800"
                      >
                        <option value="haar">Haar (default)</option>
                        <option value="db2">db2</option>
                        <option value="db4">db4</option>
                        <option value="sym4">sym4</option>
                        <option value="sym8">sym8</option>
                        <option value="coif2">coif2</option>
                      </select>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <label className="text-[11px] text-zinc-600 dark:text-zinc-400 flex justify-between">
                        <span>{t('dcwScalerLabel') || 'Low scaler'}</span>
                        <span className="text-zinc-500">{dcwScaler.toFixed(3)}</span>
                      </label>
                      <input
                        type="range" min={0} max={0.1} step={0.005}
                        value={dcwScaler}
                        onChange={(e) => setDcwScaler(Number(e.target.value))}
                        className="w-full accent-pink-500"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[11px] text-zinc-600 dark:text-zinc-400 flex justify-between">
                        <span>{t('dcwHighScalerLabel') || 'High scaler'}</span>
                        <span className="text-zinc-500">{dcwHighScaler.toFixed(3)}</span>
                      </label>
                      <input
                        type="range" min={0} max={0.1} step={0.005}
                        value={dcwHighScaler}
                        onChange={(e) => setDcwHighScaler(Number(e.target.value))}
                        disabled={dcwMode !== 'double'}
                        className="w-full accent-pink-500 disabled:opacity-40"
                      />
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* Retake — variance-preserving blend with an independent noise draw */}
            <div className="rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50/50 dark:bg-black/10 p-3 space-y-2">
              <label className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                {t('retakeLabel') || 'Retake (variation seed)'}
              </label>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <label className="text-[11px] text-zinc-600 dark:text-zinc-400 flex justify-between">
                    <span>{t('retakeVarianceLabel') || 'Variance'}</span>
                    <span className="text-zinc-500">{retakeVariance.toFixed(2)}</span>
                  </label>
                  <input
                    type="range" min={0} max={1} step={0.01}
                    value={retakeVariance}
                    onChange={(e) => setRetakeVariance(Number(e.target.value))}
                    className="w-full accent-pink-500"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] text-zinc-600 dark:text-zinc-400">{t('retakeSeedLabel') || 'Retake seed (-1 = random)'}</label>
                  <input
                    type="text"
                    value={retakeSeed}
                    onChange={(e) => setRetakeSeed(e.target.value.replace(/[^0-9-]/g, ''))}
                    disabled={retakeVariance === 0}
                    className="w-full bg-white dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-2 py-1 text-xs text-zinc-900 dark:text-white focus:outline-none focus:border-pink-500 disabled:opacity-40"
                  />
                </div>
              </div>
            </div>

            {/* Flow-edit (#1156) — text-edit overlay morphing src toward target prompt/lyrics.
                Works only on text2music + cover + cover-nofsq tasks. */}
            {(['text2music', 'cover', 'cover-nofsq'].includes(taskType)) && (
              <div className="rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50/50 dark:bg-black/10 p-3 space-y-2">
                <label className="text-xs font-semibold text-zinc-700 dark:text-zinc-300 flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={flowEditMorph}
                    onChange={(e) => setFlowEditMorph(e.target.checked)}
                    className="w-3.5 h-3.5 rounded accent-pink-500"
                  />
                  {t('flowEditLabel') || 'Flow-edit (morph from source)'}
                </label>
                {flowEditMorph && (
                  <>
                    <div className="space-y-1">
                      <label className="text-[11px] text-zinc-600 dark:text-zinc-400">
                        {t('flowEditSourceCaptionLabel') || 'Source caption (original prompt)'}
                      </label>
                      <textarea
                        value={flowEditSourceCaption}
                        onChange={(e) => setFlowEditSourceCaption(e.target.value)}
                        rows={2}
                        placeholder={t('flowEditSourceCaptionPlaceholder') || 'Description of the source song to morph FROM'}
                        className="w-full bg-white dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-2 py-1 text-xs text-zinc-900 dark:text-white focus:outline-none focus:border-pink-500 resize-none"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[11px] text-zinc-600 dark:text-zinc-400">
                        {t('flowEditSourceLyricsLabel') || 'Source lyrics (original)'}
                      </label>
                      <textarea
                        value={flowEditSourceLyrics}
                        onChange={(e) => setFlowEditSourceLyrics(e.target.value)}
                        rows={2}
                        placeholder={t('flowEditSourceLyricsPlaceholder') || '[Verse] original lyrics...'}
                        className="w-full bg-white dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-2 py-1 text-xs text-zinc-900 dark:text-white focus:outline-none focus:border-pink-500 resize-none"
                      />
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <div className="space-y-1">
                        <label className="text-[11px] text-zinc-600 dark:text-zinc-400 flex justify-between">
                          <span>{t('flowEditNMinLabel') || 'n_min'}</span>
                          <span className="text-zinc-500">{flowEditNMin.toFixed(2)}</span>
                        </label>
                        <input
                          type="range" min={0} max={1} step={0.05}
                          value={flowEditNMin}
                          onChange={(e) => setFlowEditNMin(Number(e.target.value))}
                          className="w-full accent-pink-500"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[11px] text-zinc-600 dark:text-zinc-400 flex justify-between">
                          <span>{t('flowEditNMaxLabel') || 'n_max'}</span>
                          <span className="text-zinc-500">{flowEditNMax.toFixed(2)}</span>
                        </label>
                        <input
                          type="range" min={0} max={1} step={0.05}
                          value={flowEditNMax}
                          onChange={(e) => setFlowEditNMax(Number(e.target.value))}
                          className="w-full accent-pink-500"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[11px] text-zinc-600 dark:text-zinc-400 flex justify-between">
                          <span>{t('flowEditNAvgLabel') || 'n_avg'}</span>
                          <span className="text-zinc-500">{flowEditNAvg}</span>
                        </label>
                        <input
                          type="number" min={1} max={5} step={1}
                          value={flowEditNAvg}
                          onChange={(e) => setFlowEditNAvg(Math.max(1, Math.min(5, parseInt(e.target.value, 10) || 1)))}
                          className="w-full bg-white dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-2 py-1 text-xs text-zinc-900 dark:text-white focus:outline-none focus:border-pink-500"
                        />
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* MP3 Quality (only when mp3 format selected) */}
            {audioFormat === 'mp3' && (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{t('mp3BitrateLabel') || 'MP3 Bitrate'}</label>
                  <select
                    value={mp3Bitrate}
                    onChange={(e) => setMp3Bitrate(e.target.value)}
                    className="w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-xl px-2 py-1.5 text-xs text-zinc-900 dark:text-white focus:outline-none focus:border-pink-500 transition-colors cursor-pointer [&>option]:bg-white [&>option]:dark:bg-zinc-800"
                  >
                    <option value="64k">64 kbps</option>
                    <option value="128k">128 kbps</option>
                    <option value="192k">192 kbps</option>
                    <option value="256k">256 kbps</option>
                    <option value="320k">320 kbps</option>
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{t('mp3SampleRateLabel') || 'Sample Rate'}</label>
                  <select
                    value={mp3SampleRate}
                    onChange={(e) => setMp3SampleRate(Number(e.target.value))}
                    className="w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-xl px-2 py-1.5 text-xs text-zinc-900 dark:text-white focus:outline-none focus:border-pink-500 transition-colors cursor-pointer [&>option]:bg-white [&>option]:dark:bg-zinc-800"
                  >
                    <option value="44100">44.1 kHz</option>
                    <option value="48000">48 kHz</option>
                  </select>
                </div>
              </div>
            )}

            {/* Fade In/Out */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{t('fadeInLabel') || 'Fade In (s)'}</label>
                <input
                  type="number" step="0.1" min="0" max="10"
                  value={fadeInDuration}
                  onChange={(e) => setFadeInDuration(Number(e.target.value))}
                  className="w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-xl px-2 py-1.5 text-xs text-zinc-900 dark:text-white focus:outline-none focus:border-pink-500 transition-colors"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{t('fadeOutLabel') || 'Fade Out (s)'}</label>
                <input
                  type="number" step="0.1" min="0" max="10"
                  value={fadeOutDuration}
                  onChange={(e) => setFadeOutDuration(Number(e.target.value))}
                  className="w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-xl px-2 py-1.5 text-xs text-zinc-900 dark:text-white focus:outline-none focus:border-pink-500 transition-colors"
                />
              </div>
            </div>

            {/* OpenRouter toggle — selects between local LM and remote OpenRouter provider */}
            <UseOpenRouterToggle value={useOpenRouter} onChange={setUseOpenRouter} />

            {/* Local LM controls — hidden entirely when OpenRouter is active */}
            {!useOpenRouter && (
              <>
                {/* LM Backend */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{t('lmBackendLabel') || 'LM Backend'}</label>
                  <select
                    value={lmBackend}
                    onChange={e => { setLmBackend(e.target.value as 'pt' | 'vllm'); lmEditingRef.current = true; }}
                    className="w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-2 py-1.5 text-xs text-zinc-900 dark:text-white focus:outline-none cursor-pointer [&>option]:bg-white [&>option]:dark:bg-zinc-800 [&>option]:text-zinc-900 [&>option]:dark:text-white"
                  >
                    <option value="vllm">{t('lmBackendVllm') || 'VLLM (~9.2 GB VRAM)'}</option>
                    <option value="pt">{t('lmBackendPt') || 'PT (~1.6 GB VRAM)'}</option>
                  </select>
                  <p className="text-[10px] text-zinc-500">{t('lmBackendHint') || 'vLLM uses CUDA graphs for faster LLM inference'}</p>
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
                setModelSwitchStatus(`${t('applyingLmSettings') || 'Restarting pipeline'}...`);
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
                t('applyLmSettings') || 'Apply LM Settings (restart pipeline)'
              )}
            </button>}

            {/* ───── Pollinations.ai cover generation ─────
                Independent of the LLM provider above. When ON, after audio
                renders, the server hits Pollinations to generate an album
                cover and persists it to song.cover_url. */}
            <div className="border-t border-zinc-200 dark:border-white/5 pt-2 mt-2">
              <div className="text-[11px] uppercase tracking-wide text-zinc-500 dark:text-zinc-500 mb-1">
                {t('pollinations.sectionTitle') || 'Cover image (Pollinations.ai)'}
              </div>
              <UsePollinationsToggle value={usePollinations} onChange={setUsePollinations} />
              {usePollinations && <PollinationsPanel />}
            </div>

            {/* Seed */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Dices size={14} className="text-zinc-500" />
                  <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400" title={t('hintSeed') || 'Fixing the seed makes results repeatable. Random is recommended for variety.'}>{t('seed')}</span>
                </div>
                <button
                  onClick={() => setRandomSeed(!randomSeed)}
                  className={`w-10 h-5 rounded-full flex items-center transition-colors duration-200 px-0.5 border border-zinc-200 dark:border-white/5 ${randomSeed ? 'bg-pink-600' : 'bg-zinc-300 dark:bg-black/40'}`}
                >
                  <div className={`w-4 h-4 rounded-full bg-white transform transition-transform duration-200 shadow-sm ${randomSeed ? 'translate-x-5' : 'translate-x-0'}`} />
                </button>
              </div>
              <div className="flex items-center gap-2">
                <Hash size={14} className="text-zinc-500" />
                <input
                  type="number"
                  value={seed}
                  onChange={(e) => setSeed(Number(e.target.value))}
                  placeholder={t('enterFixedSeed')}
                  disabled={randomSeed}
                  className={`flex-1 bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-3 py-1.5 text-xs text-zinc-900 dark:text-white focus:outline-none ${randomSeed ? 'opacity-40 cursor-not-allowed' : ''}`}
                />
              </div>
              <p className="text-[10px] text-zinc-500">{randomSeed ? t('randomSeedRecommended') : t('fixedSeedReproducible')}</p>
            </div>

            {/* Thinking / Reasoning Toggle —
                  • Local LM mode: enables chain-of-thought caption/lyrics generation.
                  • OpenRouter mode: forwards reasoning hint to OR model (honored by reasoning models like Claude extended-thinking, GPT-5, DeepSeek-R1; ignored by others).
            */}
            {(useOpenRouter || activeLmModel !== '') && (
              <div className="flex items-center justify-between py-2 border-t border-zinc-100 dark:border-white/5">
                <span className={`text-xs font-medium ${loraLoaded ? 'text-zinc-400 dark:text-zinc-600' : 'text-zinc-600 dark:text-zinc-400'}`} title={useOpenRouter ? 'Forwards reasoning hint to OpenRouter (honored by reasoning-capable models, ignored by others).' : (t('hintThinkingCot') || 'Lets the lyric model reason about structure and metadata. Slightly slower.')}>
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
              title={t('hintShift') || 'Adjusts the diffusion schedule. Only affects base model.'}
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
                    <span title={t('hintLmParameters') || 'Controls the 5Hz lyric/caption model sampling behavior.'}>{t('lmParameters')}</span>
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
                  title={t('hintLmTemperature') || 'Higher temperature = more random word choices.'}
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
                  title={t('hintLmCfgScale') || 'How strongly the lyric model follows the prompt.'}
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
                    title={t('hintTopK') || 'Restricts choices to the K most likely tokens. 0 disables.'}
                  />
                  <EditableSlider
                    label={t('topP')}
                    value={lmTopP}
                    min={0}
                    max={1}
                    step={0.01}
                    onChange={setLmTopP}
                    formatDisplay={(val) => val.toFixed(2)}
                    title={t('hintTopP') || 'Samples from the smallest set whose total probability is P.'}
                  />
                </div>

                {/* LM Negative Prompt */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400" title={t('hintLmNegativePrompt') || 'Words or ideas to steer the lyric model away from.'}>{t('lmNegativePrompt')}</label>
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
              <h4 className="text-xs font-bold text-zinc-500 dark:text-zinc-400 uppercase tracking-wide" title={t('hintTransform') || 'Controls how much the output follows the input audio.'}>{t('transform')}</h4>
              <p className="text-[11px] text-zinc-400 dark:text-zinc-500">{t('controlSourceAudio')}</p>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400" title={t('hintAudioCodes') || 'Advanced: precomputed audio codes for conditioning.'}>{t('audioCodes')}</label>
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
                  title={t('hintConvertToCodes') || 'Convert source audio to LM codes (requires source audio)'}
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
                  title={t('hintTranscribeCodes') || 'Transcribe audio codes to metadata (requires audio codes)'}
                  className="px-2 py-1 rounded text-[10px] font-medium bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Transcribe
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400" title={t('hintTaskType') || 'Choose text-to-music or audio-based modes.'}>{t('taskType')}</label>
                <select
                  value={taskType}
                  onChange={(e) => setTaskType(e.target.value)}
                  className="w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-xl px-2 py-1.5 text-xs text-zinc-900 dark:text-white focus:outline-none focus:border-pink-500 dark:focus:border-pink-500 transition-colors cursor-pointer [&>option]:bg-white [&>option]:dark:bg-zinc-800 [&>option]:text-zinc-900 [&>option]:dark:text-white"
                >
                  <option value="text2music">{t('textToMusic')}</option>
                  <option value="audio2audio">{t('audio2audio')}</option>
                  <option value="cover">{t('coverTask')}</option>
                  <option value="repaint">{t('repaintTask')}</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400" title={t('hintAudioCoverStrength') || 'How strongly the source audio shapes the result.'}>{t('audioCoverStrength')}</label>
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
                  <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{t('repaintModeLabel') || 'Repaint Mode'}</label>
                  <select
                    value={repaintMode}
                    onChange={(e) => setRepaintMode(e.target.value as 'conservative' | 'balanced' | 'aggressive' | 'most_natural')}
                    className="w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-2 py-1.5 text-xs text-zinc-900 dark:text-white focus:outline-none focus:border-pink-500 transition-colors cursor-pointer [&>option]:bg-white [&>option]:dark:bg-zinc-800"
                  >
                    <option value="conservative">{t('repaintConservative') || 'Conservative'}</option>
                    <option value="balanced">{t('repaintBalanced') || 'Balanced'}</option>
                    <option value="aggressive">{t('repaintAggressive') || 'Aggressive'}</option>
                    <option value="most_natural">{t('repaintMostNatural') || 'Most Natural'}</option>
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{t('repaintStrengthLabel') || 'Repaint Strength'}</label>
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
                <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400" title={t('hintRepaintingStart') || 'Start time for the region to repaint (seconds).'}>{t('repaintingStart')}</label>
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
                <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400" title={t('hintRepaintingEnd') || 'End time for the region to repaint (seconds).'}>{t('repaintingEnd')}</label>
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
              <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400" title={t('hintInstruction') || 'Additional directives to guide generation.'}>{t('instruction')}</label>
              <textarea
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                className="w-full h-16 bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg p-2 text-xs text-zinc-900 dark:text-white focus:outline-none resize-none"
              />
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
                <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400" title={t('hintCfgIntervalStart') || 'Fraction of the diffusion process to start applying guidance.'}>{t('cfgIntervalStart')}</label>
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
                <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400" title={t('hintCfgIntervalEnd') || 'Fraction of the diffusion process to stop applying guidance.'}>{t('cfgIntervalEnd')}</label>
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
              <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400" title={t('hintCustomTimesteps') || 'Override the default timestep schedule (advanced).'}>{t('customTimesteps')}</label>
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
                <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400" title={t('hintScoreScale') || 'Scales score-based guidance (advanced).'}>{t('scoreScale')}</label>
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
                <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400" title={t('hintLmBatchChunkSize') || 'Bigger chunks can be faster but use more memory.'}>{t('lmBatchChunkSize')}</label>
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
                title={t('hintUseAdg') || 'Adaptive Dual Guidance: dynamically adjusts CFG for quality. Base model only; slower.'}
              >
                <input type="checkbox" checked={useAdg} onChange={() => setUseAdg(!useAdg)} />
                {t('useAdg')}
              </label>
              <label className="flex items-center gap-2 text-xs font-medium text-zinc-600 dark:text-zinc-400" title={t('hintAllowLmBatch') || 'Allow the LM to run in larger batches for speed (more VRAM).'}>
                <input type="checkbox" checked={allowLmBatch} onChange={() => setAllowLmBatch(!allowLmBatch)} />
                {t('allowLmBatch')}
              </label>
              <label className="flex items-center gap-2 text-xs font-medium text-zinc-600 dark:text-zinc-400" title={t('hintUseCotMetas') || 'Let the LM reason about metadata like BPM, key, duration.'}>
                <input type="checkbox" checked={useCotMetas} onChange={() => setUseCotMetas(!useCotMetas)} />
                {t('useCotMetas')}
              </label>
              <label className="flex items-center gap-2 text-xs font-medium text-zinc-600 dark:text-zinc-400" title={t('hintUseCotCaption') || 'Let the LM reason about the caption/style text.'}>
                <input type="checkbox" checked={useCotCaption} onChange={() => setUseCotCaption(!useCotCaption)} />
                {t('useCotCaption')}
              </label>
              <label className="flex items-center gap-2 text-xs font-medium text-zinc-600 dark:text-zinc-400" title={t('hintUseCotLanguage') || 'Let the LM reason about language selection.'}>
                <input type="checkbox" checked={useCotLanguage} onChange={() => setUseCotLanguage(!useCotLanguage)} />
                {t('useCotLanguage')}
              </label>
              <label className="flex items-center gap-2 text-xs font-medium text-zinc-600 dark:text-zinc-400" title={t('hintAutogen') || 'Auto-generate missing fields when possible.'}>
                <input type="checkbox" checked={autogen} onChange={() => setAutogen(!autogen)} />
                {t('autogen')}
              </label>
              <label className="flex items-center gap-2 text-xs font-medium text-zinc-600 dark:text-zinc-400" title={t('hintConstrainedDecodingDebug') || 'Include debug info for constrained decoding.'}>
                <input type="checkbox" checked={constrainedDecodingDebug} onChange={() => setConstrainedDecodingDebug(!constrainedDecodingDebug)} />
                {t('constrainedDecodingDebug')}
              </label>
              <label className="flex items-center gap-2 text-xs font-medium text-zinc-600 dark:text-zinc-400" title={t('hintFormatCaption') || 'Use the formatted caption produced by the AI formatter.'}>
                <input type="checkbox" checked={isFormatCaption} onChange={() => setIsFormatCaption(!isFormatCaption)} />
                {t('formatCaption')}
              </label>
              <label className="flex items-center gap-2 text-xs font-medium text-zinc-600 dark:text-zinc-400" title={t('hintGetScores') || 'Return scorer outputs for diagnostics.'}>
                <input type="checkbox" checked={getScores} onChange={() => setGetScores(!getScores)} />
                {t('getScores')}
              </label>
              <label className="flex items-center gap-2 text-xs font-medium text-zinc-600 dark:text-zinc-400" title={t('hintGetLrcLyrics') || 'Return synced lyric (LRC) output when available.'}>
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
        <button
          onClick={handleGenerate}
          className="w-full h-12 rounded-xl font-bold text-base flex items-center justify-center gap-2 transition-all transform active:scale-[0.98] bg-gradient-to-r from-orange-500 to-pink-600 text-white shadow-lg hover:brightness-110"
          disabled={!isAuthenticated || activeJobCount >= 10}
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
