export interface Song {
  id: string;
  title: string;
  lyrics: string;
  style: string;
  coverUrl: string;
  duration: string;
  createdAt: Date;
  isGenerating?: boolean;
  jobId?: string; // Active generation job ID for cancel
  queuePosition?: number; // Position in queue (undefined = actively generating, number = waiting in queue)
  progress?: number;
  stage?: string;
  generationParams?: any;
  tags: string[];
  audioUrl?: string;
  isPublic?: boolean;
  likeCount?: number;
  viewCount?: number;
  userId?: string;
  creator?: string;
  creator_avatar?: string;
  ditModel?: string;
  lmModel?: string;
  lmBackend?: string;
  openrouterModel?: string | null;
  generationTime?: number;
  lrcContent?: string;
  bpm?: number;
  keyScale?: string;
  timeSignature?: string;
}

export interface Playlist {
  id: string;
  name: string;
  description?: string;
  coverUrl?: string;
  cover_url?: string;
  songIds?: string[];
  isPublic?: boolean;
  is_public?: boolean;
  user_id?: string;
  creator?: string;
  created_at?: string;
  song_count?: number;
  songs?: any[];
}

export interface Comment {
  id: string;
  songId: string;
  userId: string;
  username: string;
  content: string;
  createdAt: Date;
}

export interface GenerationParams {
  // Mode
  customMode: boolean;

  // Simple Mode
  songDescription?: string;

  // Custom Mode
  prompt: string;
  lyrics: string;
  style: string;
  title: string;
  ditModel?: string;

  // Common
  instrumental: boolean;
  vocalLanguage: string;

  // Music Parameters
  bpm: number;
  keyScale: string;
  timeSignature: string;
  duration: number;

  // Generation Settings
  inferenceSteps: number;
  guidanceScale: number;
  batchSize: number;
  randomSeed: boolean;
  seed: number;
  thinking: boolean;
  enhance?: boolean;
  audioFormat: 'mp3' | 'flac';
  inferMethod: 'ode' | 'sde';
  shift: number;

  // LM Parameters
  lmTemperature: number;
  lmCfgScale: number;
  lmTopK: number;
  lmTopP: number;
  lmNegativePrompt: string;
  lmBackend?: 'pt' | 'vllm';
  lmModel?: string;

  // Expert Parameters
  referenceAudioUrl?: string;
  sourceAudioUrl?: string;
  referenceAudioTitle?: string;
  sourceAudioTitle?: string;
  audioCodes?: string;
  repaintingStart?: number;
  repaintingEnd?: number;
  instruction?: string;
  audioCoverStrength?: number;
  taskType?: string;
  useAdg?: boolean;
  cfgIntervalStart?: number;
  cfgIntervalEnd?: number;
  customTimesteps?: string;
  useCotMetas?: boolean;
  useCotCaption?: boolean;
  useCotLanguage?: boolean;
  autogen?: boolean;
  constrainedDecodingDebug?: boolean;
  allowLmBatch?: boolean;
  getScores?: boolean;
  getLrc?: boolean;
  scoreScale?: number;
  lmBatchChunkSize?: number;
  trackName?: string;
  completeTrackClasses?: string[];
  isFormatCaption?: boolean;

  // v1.5 XL parameters
  coverNoiseStrength?: number;
  samplerMode?: string;
  schedulerType?: string;
  velocityNormThreshold?: number;
  velocityEmaFactor?: number;
  mp3Bitrate?: string;
  mp3SampleRate?: number;
  enableNormalization?: boolean;
  normalizationDb?: number;
  fadeInDuration?: number;
  fadeOutDuration?: number;
  latentShift?: number;
  latentRescale?: number;
  repaintMode?: 'conservative' | 'balanced' | 'aggressive';
  repaintStrength?: number;

  // OpenRouter
  openrouterModel?: string | null;

  // DCW (Differential Correction in Wavelet domain) — present at runtime,
  // typed here so the App.tsx whitelist can drop the `as any` casts.
  dcwEnabled?: boolean;
  dcwMode?: 'low' | 'high' | 'double' | 'pix';
  dcwScaler?: number;
  dcwHighScaler?: number;
  dcwWavelet?: string;

  // Retake / Flow-edit
  retakeSeed?: number;
  retakeVariance?: number;
  flowEditMorph?: boolean;
  flowEditSourceCaption?: string;
  flowEditSourceLyrics?: string;
  flowEditNMin?: number;
  flowEditNMax?: number;
  flowEditNAvg?: number;

  // LoRA loaded flag
  loraLoaded?: boolean;

  // Pre-created placeholder card id from CreatePanel — App.tsx promotes the
  // existing card instead of creating a duplicate.
  _tempId?: string;

  // Pollinations.ai cover-generation config — opaque blob mirrored to backend.
  pollinations?: {
    enabled: boolean;
    apiKey?: string;
    model?: string;
    width?: number;
    height?: number;
    seedMode?: 'song' | 'random';
    enhance?: boolean;
    nologo?: boolean;
    safe?: boolean;
    prompt?: string;
  };
}

export interface PlayerState {
  currentSong: Song | null;
  isPlaying: boolean;
  progress: number;
  volume: number;
}

export interface User {
  id: string;
  username: string;
  createdAt: Date;
  followerCount?: number;
  followingCount?: number;
  isFollowing?: boolean;
  isAdmin?: boolean;
  avatar_url?: string;
  banner_url?: string;
}

export interface UserProfile {
  user: User;
  publicSongs: Song[];
  publicPlaylists: Playlist[];
  stats: {
    totalSongs: number;
    totalLikes: number;
  };
}

// Simplified views for ACE-Step UI
export type View = 'create' | 'library' | 'training' | 'tools' | 'profile' | 'song' | 'playlist' | 'search' | 'news';
