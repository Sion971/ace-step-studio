import { Router, Response } from 'express';
import multer from 'multer';
import path from 'path';
import { existsSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { pool } from '../db/pool.js';
import { generateUUID } from '../db/sqlite.js';
import { config } from '../config/index.js';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';
import { getGradioClient } from '../services/gradio-client.js';
import {
  generateMusicViaAPI,
  getJobStatus,
  getAudioStream,
  discoverEndpoints,
  checkSpaceHealth,
  cleanupJob,
  cancelJob,
  cancelAllJobs,
  getJobRawResponse,
  downloadAudioToBuffer,
  resolvePythonPath,
} from '../services/acestep.js';
import { getStorageProvider } from '../services/storage/factory.js';
import { tagMp3Buffer, fetchCoverImage, updateMp3Cover, type PollinationsCoverConfig } from '../services/id3-tagger.js';
import {
  startCoverGen,
  consumeCoverState,
  getCoverState,
} from '../services/cover-jobs.js';

const router = Router();

// Auto-generate a song title from lyrics or style when none is provided
function autoTitle(params: { title?: string; lyrics?: string; instrumental?: boolean; style?: string; songDescription?: string }): string {
  if (params.title?.trim()) return params.title.trim();

  // Trim to max 2 phrases, cut at sentence end, max 50 chars
  function trimTitle(raw: string): string {
    // Strip parentheses wrappers like (Вою, спасу)
    let t = raw.replace(/^\((.+)\)$/, '$1').trim();
    // Cut at first sentence boundary (. ! ?) if present
    const sentenceEnd = t.search(/[.!?]\s/);
    if (sentenceEnd > 0 && sentenceEnd < 50) {
      t = t.slice(0, sentenceEnd + 1).trim();
    }
    // Cut at second comma
    const parts = t.split(',');
    if (parts.length > 2) {
      t = parts.slice(0, 2).join(',').trim();
    }
    // Cut at 50 chars on word boundary
    if (t.length > 50) {
      t = t.slice(0, 50).replace(/\s+\S*$/, '').trimEnd() + '…';
    }
    return t;
  }

  // Try first meaningful lyric line from chorus, then fallback to any section
  if (!params.instrumental && params.lyrics) {
    const lines = params.lyrics.split('\n');

    // Look for first text line after [Chorus] / [Припев] / [Hook]
    let inChorus = false;
    for (const line of lines) {
      const t = line.trim();
      if (/^\[(chorus|припев|hook)/i.test(t)) {
        inChorus = true;
        continue;
      }
      if (inChorus && t && !/^\[.*\]$/.test(t)) {
        return trimTitle(t);
      }
      if (inChorus && /^\[/.test(t)) {
        inChorus = false;
      }
    }

    // Fallback: first meaningful line from any section
    for (const line of lines) {
      const t = line.trim();
      if (t && !/^\[.*\]$/.test(t)) {
        return trimTitle(t);
      }
    }
  }

  // Fall back to style or description — max 2 phrases
  const source = params.style || params.songDescription || '';
  if (source) {
    return trimTitle(source);
  }

  return 'Untitled';
}

const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB max
  fileFilter: (_req, file, cb) => {
    const allowedTypes = [
      'audio/mpeg',
      'audio/mp3', // Alternative MIME type for MP3
      'audio/mpeg3',
      'audio/x-mpeg-3',
      'audio/wav',
      'audio/x-wav',
      'audio/flac',
      'audio/x-flac',
      'audio/mp4',
      'audio/x-m4a',
      'audio/aac',
      'audio/ogg',
      'audio/webm',
      'video/mp4',
    ];

    // Also check file extension as fallback
    const allowedExtensions = ['.mp3', '.wav', '.flac', '.m4a', '.mp4', '.aac', '.ogg', '.webm', '.opus'];
    const fileExt = file.originalname.toLowerCase().match(/\.[^.]+$/)?.[0];

    if (allowedTypes.includes(file.mimetype) || (fileExt && allowedExtensions.includes(fileExt))) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type. Only common audio formats are allowed. Received: ${file.mimetype} (${file.originalname})`));
    }
  }
});

interface GenerateBody {
  // Mode
  customMode: boolean;

  // Simple Mode
  songDescription?: string;
  /** ACE-Step text prompt — alias of lyrics for custom mode. */
  prompt?: string;

  // Custom Mode
  lyrics: string;
  style: string;
  title: string;

  // Common
  instrumental: boolean;
  vocalLanguage?: string;

  // Music Parameters
  duration?: number;
  bpm?: number;
  keyScale?: string;
  timeSignature?: string;

  // Generation Settings
  inferenceSteps?: number;
  guidanceScale?: number;
  batchSize?: number;
  randomSeed?: boolean;
  seed?: number;
  thinking?: boolean;
  enhance?: boolean;
  audioFormat?: 'mp3' | 'flac';
  inferMethod?: 'ode' | 'sde';
  shift?: number;

  // LM Parameters
  lmTemperature?: number;
  lmCfgScale?: number;
  lmTopK?: number;
  lmTopP?: number;
  lmNegativePrompt?: string;
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
  repaintMode?: 'conservative' | 'balanced' | 'aggressive' | 'most_natural';
  repaintStrength?: number;

  // Model selection
  ditModel?: string;

  // DCW / Retake / FlowEdit / lora — mirrored from frontend GenerationParams
  dcwEnabled?: boolean;
  dcwMode?: 'low' | 'high' | 'double' | 'pix';
  dcwScaler?: number;
  dcwHighScaler?: number;
  dcwWavelet?: string;
  retakeSeed?: number;
  retakeVariance?: number;
  flowEditMorph?: boolean;
  flowEditSourceCaption?: string;
  flowEditSourceLyrics?: string;
  flowEditNMin?: number;
  flowEditNMax?: number;
  flowEditNAvg?: number;
  loraLoaded?: boolean;

  // OpenRouter
  openrouterModel?: string;

  // Pollinations.ai cover generation — opaque blob mirroring PollinationsCoverConfig
  // (see app/server/src/services/id3-tagger.ts). When `enabled=true` and a model
  // is set, the audio-gen pipeline routes the post-render cover fetch through
  // Pollinations, persists the bytes to /audio/{userId}/covers/{songId}.jpg and
  // writes that path into songs.cover_url.
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

router.post('/upload-audio', authMiddleware, (req: AuthenticatedRequest, res: Response, next: Function) => {
  audioUpload.single('audio')(req, res, (err: any) => {
    if (err) {
      res.status(400).json({ error: err.message || 'Invalid file upload' });
      return;
    }
    next();
  });
}, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'Audio file is required' });
      return;
    }

    const storage = getStorageProvider();
    const decodedName = Buffer.from(req.file.originalname || '', 'latin1').toString('utf8');
    const extFromName = path.extname(decodedName).toLowerCase();
    const extFromType = (() => {
      switch (req.file.mimetype) {
        case 'audio/mpeg':
          return '.mp3';
        case 'audio/wav':
        case 'audio/x-wav':
          return '.wav';
        case 'audio/flac':
        case 'audio/x-flac':
          return '.flac';
        case 'audio/ogg':
          return '.ogg';
        case 'audio/mp4':
        case 'audio/x-m4a':
        case 'audio/aac':
          return '.m4a';
        case 'audio/webm':
          return '.webm';
        case 'video/mp4':
          return '.mp4';
        default:
          return '';
      }
    })();
    const ext = extFromName || extFromType || '.audio';
    const key = `references/${req.user!.id}/${Date.now()}-${generateUUID()}${ext}`;
    const storedKey = await storage.upload(key, req.file.buffer, req.file.mimetype);
    const publicUrl = storage.getPublicUrl(storedKey);

    res.json({ url: publicUrl, key: storedKey });
  } catch (error) {
    console.error('Upload reference audio error:', error);
    res.status(500).json({ error: 'Failed to upload audio' });
  }
});

router.post('/', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const {
      customMode,
      songDescription,
      // `prompt` is the ACE-Step text prompt — frontend sends it for custom mode
      // (alias of lyrics). Was being silently dropped before.
      prompt,
      lyrics,
      style,
      title,
      instrumental,
      vocalLanguage,
      duration,
      bpm,
      keyScale,
      timeSignature,
      inferenceSteps,
      guidanceScale,
      batchSize,
      randomSeed,
      seed,
      thinking,
      enhance,
      audioFormat,
      inferMethod,
      shift,
      lmTemperature,
      lmCfgScale,
      lmTopK,
      lmTopP,
      lmNegativePrompt,
      lmBackend,
      lmModel,
      referenceAudioUrl,
      sourceAudioUrl,
      referenceAudioTitle,
      sourceAudioTitle,
      audioCodes,
      repaintingStart,
      repaintingEnd,
      instruction,
      audioCoverStrength,
      taskType,
      useAdg,
      cfgIntervalStart,
      cfgIntervalEnd,
      customTimesteps,
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
      trackName,
      completeTrackClasses,
      isFormatCaption,
      coverNoiseStrength,
      samplerMode,
      schedulerType,
      velocityNormThreshold,
      velocityEmaFactor,
      mp3Bitrate,
      mp3SampleRate,
      enableNormalization,
      normalizationDb,
      fadeInDuration,
      fadeOutDuration,
      latentShift,
      latentRescale,
      repaintMode,
      repaintStrength,
      ditModel,
      openrouterModel,
      pollinations,
      // DCW / Retake / FlowEdit / lora — frontend has been forwarding these
      // for a while, but the backend destructure was dropping them silently
      // on the floor. Added so the persisted `params` blob actually mirrors
      // what the user submitted (used by reuse-as-template, audit trails).
      dcwEnabled,
      dcwMode,
      dcwScaler,
      dcwHighScaler,
      dcwWavelet,
      retakeSeed,
      retakeVariance,
      flowEditMorph,
      flowEditSourceCaption,
      flowEditSourceLyrics,
      flowEditNMin,
      flowEditNMax,
      flowEditNAvg,
      loraLoaded,
    } = req.body as GenerateBody;

    if (!customMode && !songDescription) {
      res.status(400).json({ error: 'Song description required for simple mode' });
      return;
    }

    if (customMode && !style && !lyrics && !referenceAudioUrl) {
      res.status(400).json({ error: 'Style, lyrics, or reference audio required for custom mode' });
      return;
    }

    const params = {
      customMode,
      songDescription,
      prompt,
      lyrics,
      style,
      title,
      instrumental,
      vocalLanguage,
      duration,
      bpm,
      keyScale,
      timeSignature,
      inferenceSteps,
      guidanceScale,
      batchSize,
      randomSeed,
      seed,
      thinking,
      enhance,
      audioFormat,
      inferMethod,
      shift,
      lmTemperature,
      lmCfgScale,
      lmTopK,
      lmTopP,
      lmNegativePrompt,
      lmBackend,
      lmModel,
      referenceAudioUrl,
      sourceAudioUrl,
      referenceAudioTitle,
      sourceAudioTitle,
      audioCodes,
      repaintingStart,
      repaintingEnd,
      instruction,
      audioCoverStrength,
      taskType,
      useAdg,
      cfgIntervalStart,
      cfgIntervalEnd,
      customTimesteps,
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
      trackName,
      completeTrackClasses,
      isFormatCaption,
      coverNoiseStrength,
      samplerMode,
      schedulerType,
      velocityNormThreshold,
      velocityEmaFactor,
      mp3Bitrate,
      mp3SampleRate,
      enableNormalization,
      normalizationDb,
      fadeInDuration,
      fadeOutDuration,
      latentShift,
      latentRescale,
      repaintMode,
      repaintStrength,
      ditModel,
      openrouterModel,
      pollinations,
      // mirror to persisted params blob
      dcwEnabled,
      dcwMode,
      dcwScaler,
      dcwHighScaler,
      dcwWavelet,
      retakeSeed,
      retakeVariance,
      flowEditMorph,
      flowEditSourceCaption,
      flowEditSourceLyrics,
      flowEditNMin,
      flowEditNMax,
      flowEditNAvg,
      loraLoaded,
    };

    // Create job record in database
    const localJobId = generateUUID();
    await pool.query(
      `INSERT INTO generation_jobs (id, user_id, status, params, created_at, updated_at)
       VALUES (?, ?, 'queued', ?, datetime('now'), datetime('now'))`,
      [localJobId, req.user!.id, JSON.stringify(params)]
    );

    // NOTE: cover-gen is NOT kicked off here. It starts later in the status
    // poller, in the moment the audio job transitions queued→running for
    // THIS jobId. That keeps the user's "queue" mental model intact: a
    // cancelled queued job never spends user money on Pollinations, and
    // 10 queued clicks don't fire 10 simultaneous Pollinations calls.

    // Generation params logged

    // Start generation
    const { jobId: hfJobId } = await generateMusicViaAPI(params);

    // Update job with ACE-Step task ID
    await pool.query(
      `UPDATE generation_jobs SET acestep_task_id = ?, status = 'running', updated_at = datetime('now') WHERE id = ?`,
      [hfJobId, localJobId]
    );

    res.json({
      jobId: localJobId,
      status: 'queued',
      queuePosition: 1,
    });
  } catch (error) {
    console.error('Generate error:', error);
    res.status(500).json({ error: (error as Error).message || 'Generation failed' });
  }
});

router.get('/status/:jobId', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const jobResult = await pool.query(
      `SELECT id, user_id, acestep_task_id, status, params, result, error, created_at
       FROM generation_jobs
       WHERE id = ?`,
      [req.params.jobId]
    );

    if (jobResult.rows.length === 0) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    const job = jobResult.rows[0];

    if (job.user_id !== req.user!.id) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    // If job is still running, check ACE-Step status
    if (['pending', 'queued', 'running'].includes(job.status) && job.acestep_task_id) {
      try {
        const aceStatus = await getJobStatus(job.acestep_task_id);

        // First time we see this job in flight — kick off Pollinations cover
        // gen. ONLY on `running` (not `succeeded`): if we also fired on the
        // `succeeded` status, then after `attachCover.finally` runs
        // `consumeCoverState(jobId)` the entry is gone, and the next poll
        // (still seeing `succeeded`) would re-fire a brand-new cover gen
        // (= burns Pollinations quota + leaks bytes).
        // The "missed transition" risk is bounded: ACE-Step turbo audio takes
        // 30+s and we poll every 2s, so we'll always catch at least one
        // `running` poll between queued and succeeded.
        if (
          aceStatus.status === 'running' &&
          !getCoverState(req.params.jobId)
        ) {
          const params = typeof job.params === 'string' ? JSON.parse(job.params) : job.params;
          const pol = params?.pollinations;
          if (pol?.enabled && pol.model && pol.prompt) {
            const polCfg: PollinationsCoverConfig = {
              enabled: true,
              apiKey: pol.apiKey || '',
              model: pol.model,
              width: pol.width ?? 1024,
              height: pol.height ?? 1024,
              seedMode: pol.seedMode ?? 'song',
              enhance: pol.enhance ?? true,
              nologo: pol.nologo ?? true,
              safe: pol.safe ?? true,
              prompt: pol.prompt,
            };
            startCoverGen(req.params.jobId, polCfg);
          }
        }

        if (aceStatus.status !== job.status) {
          // Use optimistic lock: only update if status hasn't changed (prevents duplicate song creation)
          let updateQuery = `UPDATE generation_jobs SET status = ?, updated_at = datetime('now')`;
          const updateParams: unknown[] = [aceStatus.status];

          if (aceStatus.status === 'succeeded' && aceStatus.result) {
            updateQuery += `, result = ?`;
            updateParams.push(JSON.stringify(aceStatus.result));
          } else if (aceStatus.status === 'failed' && aceStatus.error) {
            updateQuery += `, error = ?`;
            updateParams.push(aceStatus.error);
            // Audio gen failed (CUDA OOM, timeout, model error). The cover-jobs
            // entry never gets consumed by the success-path attachCover, so
            // drop it here to prevent a Map leak per failed job.
            consumeCoverState(req.params.jobId);
          }

          updateQuery += ` WHERE id = ? AND status = ?`;
          updateParams.push(req.params.jobId, job.status);

          const updateResult = await pool.query(updateQuery, updateParams);
          const wasUpdated = updateResult.rowCount > 0;

          // If succeeded AND we were the first to update (optimistic lock), create song records
          if (aceStatus.status === 'succeeded' && aceStatus.result && wasUpdated) {
            const params = typeof job.params === 'string' ? JSON.parse(job.params) : job.params;
            const audioUrls = aceStatus.result.audioUrls.filter((url: string) => {
              const lower = url.toLowerCase();
              return lower.endsWith('.mp3') || lower.endsWith('.flac') || lower.endsWith('.wav');
            });
            const localPaths: string[] = [];
            const insertedSongIds: string[] = [];
            const storage = getStorageProvider();

            for (let i = 0; i < audioUrls.length; i++) {
              const audioUrl = audioUrls[i];
              const variationSuffix = audioUrls.length > 1 ? ` (v${i + 1})` : '';
              const songTitle = autoTitle(params) + variationSuffix;

              const songId = generateUUID();

              try {
                let { buffer } = await downloadAudioToBuffer(audioUrl);
                const ext = audioUrl.includes('.flac') ? '.flac' : '.mp3';

                // Tag MP3 with ID3 metadata (title, artist, fast picsum cover, lyrics).
                // We DO NOT block the audio-gen flow on Pollinations cover gen —
                // that can take 30-60s on cold path and would freeze the UI's
                // "Создать" button. Instead:
                //   1. Synchronously fetch a fast picsum cover for the ID3 tag
                //      (so downloaded MP3 has a thumbnail).
                //   2. After INSERT, kick off Pollinations cover gen in the
                //      background and UPDATE songs.cover_url when ready.
                if (ext === '.mp3') {
                  try {
                    // Fast path only — picsum, no Pollinations here.
                    const fastCover = await fetchCoverImage(songId, undefined);
                    buffer = tagMp3Buffer(buffer, {
                      title: songTitle,
                      artist: req.user!.username || 'ACE-Step Studio',
                      genre: params.style?.split(',')[0]?.trim(),
                      lyrics: params.instrumental ? undefined : params.lyrics,
                      bpm: aceStatus.result.bpm || params.bpm,
                      coverBuffer: fastCover?.buffer,
                      coverMimeType: fastCover?.mimeType,
                    });
                  } catch (tagErr) {
                    console.warn('ID3 tagging failed, saving without tags:', tagErr);
                  }
                }
                // cover_url is filled later by background Pollinations job
                // (see "BACKGROUND COVER GEN" below). For now insert NULL.
                const savedCoverUrl: string | null = null;

                const storageKey = `${req.user!.id}/${songId}${ext}`;
                await storage.upload(storageKey, buffer, `audio/${ext.slice(1)}`);
                const storedPath = storage.getPublicUrl(storageKey);

                // Get LRC for this specific audio track (by index)
                const trackLrc = aceStatus.result.lrcData?.[i] || null;

                await pool.query(
                  `INSERT INTO songs (id, user_id, title, lyrics, style, caption, audio_url,
                                      duration, bpm, key_scale, time_signature, tags, is_public, generation_params,
                                      dit_model, lm_model, lm_backend, generation_time, lrc_content, openrouter_model, cover_url, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
                  [
                    songId,
                    req.user!.id,
                    songTitle,
                    params.instrumental ? '[Instrumental]' : params.lyrics,
                    params.style,
                    params.style,
                    storedPath,
                    aceStatus.result.duration && aceStatus.result.duration > 0 ? aceStatus.result.duration : (params.duration && params.duration > 0 ? params.duration : 0),
                    aceStatus.result.bpm || params.bpm,
                    aceStatus.result.keyScale || params.keyScale,
                    aceStatus.result.timeSignature || params.timeSignature,
                    JSON.stringify([]),
                    JSON.stringify(params),
                    activeLoadedModel || params.ditModel || null,
                    activeLmModel || params.lmModel || null,
                    activeLmBackend || params.lmBackend || null,
                    aceStatus.result.generationTime || null,
                    trackLrc,
                    params.openrouterModel || null,
                    savedCoverUrl,
                  ]
                );

                localPaths.push(storedPath);
                insertedSongIds.push(songId);
              } catch (downloadError) {
                console.error(`Failed to download audio ${i + 1}:`, downloadError);
                // Still create song record with remote URL.
                // Fallback path: we don't have a local MP3 to tag, so cover_url
                // stays NULL — UI shows the seeded gradient.
                const trackLrcFallback = aceStatus.result.lrcData?.[i] || null;
                await pool.query(
                  `INSERT INTO songs (id, user_id, title, lyrics, style, caption, audio_url,
                                      duration, bpm, key_scale, time_signature, tags, is_public, generation_params,
                                      dit_model, lm_model, lm_backend, generation_time, lrc_content, openrouter_model, cover_url, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
                  [
                    songId,
                    req.user!.id,
                    songTitle,
                    params.instrumental ? '[Instrumental]' : params.lyrics,
                    params.style,
                    params.style,
                    audioUrl,
                    aceStatus.result.duration && aceStatus.result.duration > 0 ? aceStatus.result.duration : (params.duration && params.duration > 0 ? params.duration : 0),
                    aceStatus.result.bpm || params.bpm,
                    aceStatus.result.keyScale || params.keyScale,
                    aceStatus.result.timeSignature || params.timeSignature,
                    JSON.stringify([]),
                    JSON.stringify(params),
                    activeLoadedModel || params.ditModel || null,
                    activeLmModel || params.lmModel || null,
                    activeLmBackend || params.lmBackend || null,
                    aceStatus.result.generationTime || null,
                    trackLrcFallback,
                    params.openrouterModel || null,
                    null,
                  ]
                );
                localPaths.push(audioUrl);
                // Track even fallback songs so the cover-attach loop can
                // UPDATE their cover_url when Pollinations finishes
                // (downloads can fail but the song row exists with the
                // remote MP3 URL — covers still apply).
                insertedSongIds.push(songId);
              }
            }

            aceStatus.result.audioUrls = localPaths;
            cleanupJob(job.acestep_task_id);

            // Pollinations cover attachment — pure fire-and-forget. The
            // status response goes out immediately; cover_url is UPDATEed
            // whenever the background Pollinations gen finishes, regardless
            // of how slow it is. This guarantees audio-gen flow + the bulk
            // queue NEVER wait on image gen.
            const polEntry = getCoverState(req.params.jobId);
            if (insertedSongIds.length > 0 && polEntry) {
              const userId = req.user!.id;
              const songIds = [...insertedSongIds];
              const jobId = req.params.jobId;

              const attachCover = async (cover: { buffer: Buffer; mimeType: 'image/jpeg' | 'image/png' }) => {
                const coverExt = cover.mimeType === 'image/png' ? '.png' : '.jpg';
                for (const sid of songIds) {
                  try {
                    const coverKey = `${userId}/covers/${sid}${coverExt}`;
                    await storage.upload(coverKey, cover.buffer, cover.mimeType);
                    const url = storage.getPublicUrl(coverKey);
                    // `WHERE cover_url IS NULL` — guard against the race where
                    // the user opened the manual CoverRegenModal mid-generation
                    // and saved their pick before the auto-pipeline Promise
                    // resolved. The auto-pipeline must NOT overwrite a cover
                    // the user explicitly chose. (Manual save is the intent;
                    // auto fill is best-effort default.)
                    const updateResult = await pool.query('UPDATE songs SET cover_url = ?, updated_at = datetime(\'now\') WHERE id = ? AND cover_url IS NULL', [url, sid]);

                    // Also re-embed the new cover into the MP3's ID3 frame —
                    // without this the downloaded MP3 keeps showing the
                    // initial picsum thumbnail (baked in at generate.ts:668)
                    // forever, even though songs.cover_url already points at
                    // the Pollinations image. Skipped if (a) the manual modal
                    // already won the cover_url race (rowCount=0), (b) audio
                    // is remote-hosted, or (c) the storage provider has no
                    // read() method — best-effort, never breaks audio gen.
                    if (updateResult.rowCount > 0) {
                      try {
                        const audioRow = await pool.query(`SELECT audio_url FROM songs WHERE id = ?`, [sid]);
                        const audioUrl: string | null = audioRow.rows?.[0]?.audio_url || null;
                        if (audioUrl && audioUrl.startsWith('/audio/') && audioUrl.toLowerCase().endsWith('.mp3') && typeof storage.read === 'function') {
                          const audioKey = audioUrl.replace('/audio/', '');
                          const mp3Buffer: Buffer = await storage.read(audioKey);
                          const retagged = updateMp3Cover(mp3Buffer, cover.buffer, cover.mimeType);
                          await storage.upload(audioKey, retagged, 'audio/mpeg');
                        }
                      } catch (id3Err) {
                        console.warn(`[cover] ID3 re-embed failed for song ${sid}:`, id3Err);
                      }
                    }
                  } catch (e) {
                    console.warn(`[cover] attach failed for song ${sid}:`, e);
                  }
                }
              };

              if (polEntry.state === 'ready') {
                // Already done by the time audio finished — schedule to a
                // microtask so we still don't add latency to this response.
                Promise.resolve()
                  .then(() => attachCover(polEntry))
                  .finally(() => consumeCoverState(jobId));
              } else if (polEntry.state === 'pending') {
                polEntry.promise
                  .then((result) => { if (result.state === 'ready') return attachCover(result); })
                  .catch((e) => console.warn(`[cover] background attach failed for job ${jobId}:`, e))
                  .finally(() => consumeCoverState(jobId));
              } else {
                consumeCoverState(jobId);
              }
            }
          }
        }

        res.json({
          jobId: req.params.jobId,
          status: aceStatus.status,
          queuePosition: aceStatus.queuePosition,
          etaSeconds: aceStatus.etaSeconds,
          progress: aceStatus.progress,
          stage: aceStatus.stage,
          result: aceStatus.result,
          error: aceStatus.error,
        });
        return;
      } catch (aceError) {
        console.error('ACE-Step status check error:', aceError);
      }
    }

    // Return stored status
    res.json({
      jobId: req.params.jobId,
      status: job.status,
      progress: undefined,
      stage: undefined,
      result: job.result && typeof job.result === 'string' ? JSON.parse(job.result) : job.result,
      error: job.error,
    });
  } catch (error) {
    console.error('Status check error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/generate/cancel/:jobId — Cancel a single job
router.post('/cancel/:jobId', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { jobId } = req.params;

    // Cancel in the acestep queue
    const cancelled = cancelJob(jobId);

    // Drop any in-flight cover-gen entry — without this the entry stays in the
    // map forever (memory leak) and a stale Promise.then() may still write a
    // cover_url for a song row that is now in `failed` state (or never INSERTed).
    consumeCoverState(jobId);

    // Also update DB status
    await pool.query(
      `UPDATE generation_jobs SET status = 'failed', error = 'Cancelled by user', updated_at = datetime('now')
       WHERE id = ? AND user_id = ? AND status IN ('queued', 'running', 'pending')`,
      [jobId, req.user!.id]
    );

    res.json({ cancelled });
  } catch (error) {
    console.error('Cancel error:', error);
    res.status(500).json({ error: 'Failed to cancel' });
  }
});

// POST /api/generate/cancel-all — Cancel all queued and running jobs for the user
router.post('/cancel-all', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    // Cancel all in the acestep queue
    const count = cancelAllJobs();

    // Drop in-flight cover-gen entries for this user's jobs so we don't leak
    // map slots. Read pending/running jobs first so we know which keys to drop.
    const inFlight = await pool.query(
      `SELECT id FROM generation_jobs
       WHERE user_id = ? AND status IN ('queued', 'running', 'pending')`,
      [req.user!.id]
    );
    for (const row of inFlight.rows) consumeCoverState(row.id);

    // Also update DB
    const result = await pool.query(
      `UPDATE generation_jobs SET status = 'failed', error = 'Cancelled by user', updated_at = datetime('now')
       WHERE user_id = ? AND status IN ('queued', 'running', 'pending')`,
      [req.user!.id]
    );

    res.json({ cancelled: count || result.rowCount || 0 });
  } catch (error) {
    console.error('Cancel all error:', error);
    res.status(500).json({ error: 'Failed to cancel' });
  }
});

// POST /api/generate/reset — Hard reset: cancel + interrupt Gradio DiT diffusion
router.post('/reset', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    // 1. Cancel all queued jobs
    cancelAllJobs();

    // Drop in-flight cover-gen entries (same reason as /cancel-all)
    const inFlight = await pool.query(
      `SELECT id FROM generation_jobs
       WHERE user_id = ? AND status IN ('queued', 'running', 'pending')`,
      [req.user!.id]
    );
    for (const row of inFlight.rows) consumeCoverState(row.id);

    // 2. Update DB
    await pool.query(
      `UPDATE generation_jobs SET status = 'failed', error = 'Reset by user', updated_at = datetime('now')
       WHERE user_id = ? AND status IN ('queued', 'running', 'pending')`,
      [req.user!.id]
    );

    // 3. Send cancel to Gradio to interrupt DiT diffusion loop
    let gradioCancel = false;
    try {
      const r = await fetch(`${config.acestep.apiUrl}/v1/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(3000),
      });
      if (r.ok) gradioCancel = true;
    } catch {}

    res.json({ reset: true, gradioCancel });
  } catch (error) {
    console.error('Reset error:', error);
    res.status(500).json({ error: 'Failed to reset' });
  }
});

// Audio proxy endpoint
router.get('/audio', async (req, res: Response) => {
  try {
    const audioPath = req.query.path as string;
    if (!audioPath) {
      res.status(400).json({ error: 'Path required' });
      return;
    }

    const audioResponse = await getAudioStream(audioPath);

    if (!audioResponse.ok) {
      res.status(audioResponse.status).json({ error: 'Failed to fetch audio' });
      return;
    }

    const contentType = audioResponse.headers.get('content-type');
    if (contentType) {
      res.setHeader('Content-Type', contentType);
    }

    const contentLength = audioResponse.headers.get('content-length');
    if (contentLength) {
      res.setHeader('Content-Length', contentLength);
    }

    const reader = audioResponse.body?.getReader();
    if (!reader) {
      res.status(500).json({ error: 'Failed to read audio stream' });
      return;
    }

    const pump = async (): Promise<void> => {
      const { done, value } = await reader.read();
      if (done) {
        res.end();
        return;
      }
      res.write(value);
      return pump();
    };

    await pump();
  } catch (error) {
    console.error('Audio proxy error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/history', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT id, acestep_task_id, status, params, result, error, created_at
       FROM generation_jobs
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT 50`,
      [req.user!.id]
    );

    res.json({ jobs: result.rows });
  } catch (error) {
    console.error('Get history error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/endpoints', authMiddleware, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const endpoints = await discoverEndpoints();
    res.json({ endpoints });
  } catch (error) {
    console.error('Discover endpoints error:', error);
    res.status(500).json({ error: 'Failed to discover endpoints' });
  }
});

// Model loading status (real-time) - initialized after activeLoadedModel
let modelLoadingStatus: { state: string; model: string; progress?: string } = {
  state: 'ready',
  model: 'marcorez8/acestep-v15-xl-turbo-bf16',
};

let lmSynced = false;
router.get('/model-status', async (_req, res: Response) => {
  // Check real Gradio health (includes LM info)
  let gradioAlive = false;
  try {
    const r = await fetch(`${config.acestep.apiUrl}/health`, { signal: AbortSignal.timeout(2000) });
    if (r.ok) {
      gradioAlive = true;
      const health = await r.json() as any;
      const data = health?.data || health;
      // Sync model info from Gradio on every poll
      if (data.dit_model) activeLoadedModel = data.dit_model;
      if (data.lm_model) activeLmModel = data.lm_model;
      if (data.lm_backend) activeLmBackend = data.lm_backend;
      // VRAM optimization flags
      if (data.offload_to_cpu !== undefined) activeOffloadToCpu = data.offload_to_cpu;
      if (data.chunked_ffn !== undefined) activeChunkedFfn = data.chunked_ffn;
      if (data.pinned_memory !== undefined) activePinnedMemory = data.pinned_memory;
    }
  } catch {}

  res.json({
    ...modelLoadingStatus,
    connected: gradioAlive,
    activeModel: activeLoadedModel,
    activeLmModel,
    activeLmBackend,
    offloadToCpu: activeOffloadToCpu,
    chunkedFfn: activeChunkedFfn,
    pinnedMemory: activePinnedMemory,
  });
});

// GPU/System info endpoint - uses nvidia-smi for real data (cached 2s)
let systemInfoCache: { data: any; ts: number } = { data: null, ts: 0 };
router.get('/system-info', async (_req, res: Response) => {
  const now = Date.now();
  if (systemInfoCache.data && now - systemInfoCache.ts < 2000) {
    res.json(systemInfoCache.data);
    return;
  }

  const { execSync } = await import('child_process');
  const os = await import('os');

  let gpu = 'N/A', vram_total = 0, vram_used = 0, gpu_util = 0, gpu_temp = 0;

  try {
    const smi = execSync(
      'nvidia-smi --query-gpu=name,memory.total,memory.used,utilization.gpu,temperature.gpu --format=csv,noheader,nounits',
      { encoding: 'utf-8', timeout: 3000 }
    ).trim();
    const parts = smi.split(',').map(s => s.trim());
    gpu = parts[0] || 'NVIDIA GPU';
    vram_total = Math.round(parseInt(parts[1] || '0') / 1024 * 10) / 10; // MiB to GB
    vram_used = Math.round(parseInt(parts[2] || '0') / 1024 * 10) / 10;
    gpu_util = parseInt(parts[3] || '0');
    gpu_temp = parseInt(parts[4] || '0');
  } catch {}

  const totalMem = Math.round(os.totalmem() / 1024 / 1024 / 1024 * 10) / 10;
  const freeMem = Math.round(os.freemem() / 1024 / 1024 / 1024 * 10) / 10;
  const usedMem = Math.round((totalMem - freeMem) * 10) / 10;
  const cpus = os.cpus();
  const cpuCount = cpus.length;
  const cpuLoad = cpus.reduce((sum, cpu) => {
    const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
    return sum + (1 - cpu.times.idle / total);
  }, 0) / cpuCount * 100;

  const data = {
    gpu, vram_total, vram_used, gpu_util, gpu_temp,
    ram_total: totalMem, ram_used: usedMem,
    cpu_cores: cpuCount, cpu_util: Math.round(cpuLoad),
  };
  systemInfoCache = { data, ts: now };
  res.json(data);
});

// Hot-swap model via Gradio /v1/init API (no process restart)
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'marcorez8/acestep-v15-xl-turbo-bf16';
let activeLoadedModel: string = DEFAULT_MODEL;
let activeLmModel: string = process.env.INIT_LLM === 'false' ? '' : 'acestep-5Hz-lm-0.6B';
let activeLmBackend: string = process.env.INIT_LLM === 'false' ? '' : 'pt';
let activeOffloadToCpu: boolean = false;
let activeChunkedFfn: number = 2;
let activePinnedMemory: boolean = false;

// Reset model state when pipeline restarts after crash
// Only reset variables — do NOT call resetGradioClient or switch-model here,
// Gradio isn't ready yet. The next health poll will reconnect automatically.
import('../services/pipeline-manager.js').then(({ pipelineManager }) => {
  pipelineManager.onRestart(() => {
    console.log('[Model] Pipeline restarted — resetting model state to defaults');
    activeLoadedModel = DEFAULT_MODEL;
    activeLmModel = process.env.INIT_LLM === 'false' ? '' : 'acestep-5Hz-lm-0.6B';
    activeLmBackend = process.env.INIT_LLM === 'false' ? '' : 'pt';
    modelLoadingStatus = { state: 'idle', model: '' };
    generationInProgress = false;
  });
}).catch(() => {});

// Generation lock — prevents switch-model during active generation
let generationInProgress = false;
export function setGenerationInProgress(v: boolean) { generationInProgress = v; }

router.post('/switch-model', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const { model, lmModel, lmBackend } = req.body;
  if (!model) {
    res.status(400).json({ error: 'model required' });
    return;
  }

  const { resetGradioClient } = await import('../services/gradio-client.js');
  const { pipelineManager } = await import('../services/pipeline-manager.js');
  const ACESTEP_API = config.acestep.apiUrl;

  // Wait for active generation to finish before switching model
  // CUDA graph capture during generation = instant crash
  if (generationInProgress) {
    console.log('[Model] Waiting for active generation to finish before switching...');
    const maxWait = 600_000; // 10 min max
    const start = Date.now();
    while (generationInProgress && Date.now() - start < maxWait) {
      await new Promise(r => setTimeout(r, 500));
    }
    if (generationInProgress) {
      res.status(503).json({ error: 'Generation still in progress after timeout' });
      return;
    }
    console.log('[Model] Generation finished, proceeding with switch');
  }

  // Pause health checks during model switch to prevent zombie kill
  pipelineManager.pauseHealthCheck();

  // Check if DiT is actually changing
  const ditBasename = (n: string) => n.replace(/^.*\//, '').replace(/[\\/]+$/, '');
  const ditChanging = ditBasename(model) !== ditBasename(activeLoadedModel);

  if (ditChanging) {
    modelLoadingStatus = { state: 'unloading', model: activeLoadedModel };
    console.log(`[Model] Unloading current DiT: ${activeLoadedModel}`);
    await new Promise(r => setTimeout(r, 500));
  }

  modelLoadingStatus = { state: 'loading', model };
  if (ditChanging) {
    console.log(`[Model] Switching DiT to: ${model}${lmModel ? `, LM to: ${lmModel}` : ''}`);
  } else {
    console.log(`[Model] Reloading LM: ${lmModel || 'default'}${lmBackend ? ` (${lmBackend})` : ''}`);
  }

  try {
    // Call Gradio's /v1/init — handles unload, download, and reload in-process
    const initRes = await fetch(`${ACESTEP_API}/v1/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        init_llm: !!lmModel,
        lm_model_path: lmModel || undefined,
        lm_backend: lmBackend || 'pt',
      }),
      signal: AbortSignal.timeout(300_000), // 5 min timeout for model download + load
    });

    if (!initRes.ok) {
      const errText = await initRes.text().catch(() => '');
      console.error(`[Model] /v1/init failed: ${initRes.status} ${errText}`);
      modelLoadingStatus = { state: 'error', model: errText || `HTTP ${initRes.status}` };
      res.status(500).json({ error: `Model switch failed: ${errText || initRes.status}` });
      return;
    }

    const result = await initRes.json() as any;
    console.log(`[Model] Switch result:`, JSON.stringify(result));

    // Check for error in response body (Gradio returns 200 with error in JSON)
    if (result?.code && result.code >= 400) {
      console.error(`[Model] Switch failed (API error):`, result.error);
      modelLoadingStatus = { state: 'error', model: result.error || 'Unknown error' };
      res.status(500).json({ error: `Model switch failed: ${result.error}` });
      return;
    }

    // Reset Gradio client to reconnect with new model state
    resetGradioClient();

    activeLoadedModel = result?.data?.loaded_model || model;
    activeLmModel = result?.data?.loaded_lm_model || lmModel || activeLmModel;
    if (lmBackend) activeLmBackend = lmBackend;
    // Parse LM status for backend info (e.g. "Model: ...\nDevice: ...")
    const lmStatus = result?.data?.lm_status || '';
    if (lmStatus.includes('Low GPU Memory Mode: True')) activeLmBackend = 'pt';
    console.log(`[Model] Active: DiT=${activeLoadedModel}, LM=${activeLmModel} (${activeLmBackend})`);
    modelLoadingStatus = { state: 'ready', model };

    console.log(`[Model] Switched to ${model} successfully (in-process, no restart)`);
    pipelineManager.resumeHealthCheck();
    res.json({ success: true, model, result: result?.data || result });
  } catch (error: any) {
    console.error(`[Model] Switch failed:`, error);
    modelLoadingStatus = { state: 'error', model: error.message };
    pipelineManager.resumeHealthCheck();
    res.status(500).json({ error: `Model switch failed: ${error.message}` });
  }
});

// Download model with SSE progress
router.get('/download-model', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const model = req.query.model as string;
  if (!model) {
    res.status(400).json({ error: 'model parameter required' });
    return;
  }

  const MODEL_HF_REPOS: Record<string, string> = {
    'acestep-v15-xl-turbo': 'ACE-Step/acestep-v15-xl-turbo',
    'acestep-v15-xl-sft': 'ACE-Step/acestep-v15-xl-sft',
    'marcorez8/acestep-v15-xl-turbo-bf16': 'marcorez8/acestep-v15-xl-turbo-bf16',
    'acestep-v15-xl-merge-sft-turbo': 'jeankassio/acestep_v1.5_merge_sft_turbo_xl',
  };

  const hfRepo = MODEL_HF_REPOS[model];
  if (!hfRepo) {
    res.status(400).json({ error: `Unknown model: ${model}` });
    return;
  }

  const ACESTEP_DIR = process.env.ACESTEP_PATH || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../ACE-Step-1.5');
  const modelDir = path.join(ACESTEP_DIR, 'checkpoints', model);

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data: any) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  send({ status: 'downloading', model, message: `Downloading ${model}...` });

  // Download via huggingface-cli (same as all other models, with progress bar)
  const { spawn } = await import('child_process');
  const pythonPath = resolvePythonPath(ACESTEP_DIR);
  const proc = spawn(pythonPath, [
    '-m', 'huggingface_hub.commands.huggingface_cli', 'download', hfRepo, '--local-dir', modelDir
  ], {
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', HF_HUB_ENABLE_HF_TRANSFER: '1' },
  });

  proc.stdout?.on('data', (chunk: Buffer) => {
    const line = chunk.toString().trim();
    if (line) send({ status: 'progress', message: line });
  });
  proc.stderr?.on('data', (chunk: Buffer) => {
    const line = chunk.toString().trim();
    if (line && !line.includes('Warning')) send({ status: 'progress', message: line });
  });
  proc.on('close', async (code) => {
    if (code === 0) {
      // Post-process: rename safetensors + copy config from reference model
      try {
        const { readdirSync, existsSync, copyFileSync, renameSync } = await import('fs');
        // Rename first .safetensors to model.safetensors if needed
        if (!existsSync(path.join(modelDir, 'model.safetensors'))) {
          const files = readdirSync(modelDir).filter(f => f.endsWith('.safetensors'));
          if (files.length > 0) {
            renameSync(path.join(modelDir, files[0]), path.join(modelDir, 'model.safetensors'));
            send({ status: 'progress', message: `Renamed ${files[0]} → model.safetensors` });
          }
        }
        // Copy config.json from xl-sft if missing
        if (!existsSync(path.join(modelDir, 'config.json'))) {
          const refDir = path.join(ACESTEP_DIR, 'checkpoints', 'acestep-v15-xl-sft');
          for (const fname of ['config.json', 'configuration_acestep_v15.py', 'silence_latent.pt']) {
            const src = path.join(refDir, fname);
            if (existsSync(src)) {
              copyFileSync(src, path.join(modelDir, fname));
              send({ status: 'progress', message: `Copied ${fname} from xl-sft` });
            }
          }
        }
      } catch (e) {
        send({ status: 'progress', message: `Post-process warning: ${e}` });
      }
      send({ status: 'done', model, message: 'Download complete' });
    } else {
      send({ status: 'error', model, message: `Download failed (exit ${code})` });
    }
    res.end();
  });

  req.on('close', () => proc.kill());
});

router.get('/models', async (_req, res: Response) => {
  try {
    const ACESTEP_DIR = process.env.ACESTEP_PATH || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../ACE-Step-1.5');
    const checkpointsDir = path.join(ACESTEP_DIR, 'checkpoints');

    // All known DiT models from Gradio's model_downloader.py registry:
    // - MAIN_MODEL_COMPONENTS includes "acestep-v15-turbo" (bundled with main download)
    // - SUBMODEL_REGISTRY includes the rest (separate HuggingFace repos, auto-downloaded on init)
    // XL (4B) models only — ACE-Step Studio
    const ALL_DIT_MODELS = [
      'acestep-v15-xl-turbo',                    // XL Turbo (8 steps, no CFG)
      'acestep-v15-xl-sft',                      // XL SFT (50 steps, with CFG)
      'marcorez8/acestep-v15-xl-turbo-bf16',     // XL Turbo BF16 (community, smaller)
      'acestep-v15-xl-merge-sft-turbo',          // XL SFT+Turbo merge (community, 50 steps)
    ];

    // Query Gradio /v1/models to get the currently loaded/active model
    let activeModel: string | null = null;
    try {
      const apiRes = await fetch(`${config.acestep.apiUrl}/v1/models`);
      if (apiRes.ok) {
        const data = await apiRes.json() as any;
        const gradioModels = data?.data?.models || data?.models || [];
        if (gradioModels.length > 0) {
          activeModel = gradioModels[0]?.name || null;
        }
      }
    } catch {
      // Gradio API unavailable
    }

    // Check which models are downloaded (exist on disk)
    // Matches Gradio's handler.py check_model_exists() and get_available_acestep_v15_models()
    const { existsSync, statSync } = await import('fs');
    const downloaded = new Set<string>();
    for (const model of ALL_DIT_MODELS) {
      const modelPath = path.join(checkpointsDir, model);
      try {
        if (existsSync(modelPath) && statSync(modelPath).isDirectory()) {
          downloaded.add(model);
        }
      } catch { /* skip */ }
    }

    // Scan for any additional models on disk not in the registry
    // Detects: user-converted (BF16), merged, community, or LoRA-trained models
    // A valid model folder contains at least one .safetensors file
    try {
      const { readdirSync } = await import('fs');
      for (const entry of readdirSync(checkpointsDir)) {
        const entryPath = path.join(checkpointsDir, entry);
        try {
          if (!statSync(entryPath).isDirectory()) continue;
          // Skip known non-model dirs (LM models, VAE, embeddings)
          if (entry.startsWith('acestep-5Hz-lm-') || entry === 'vae' || entry.startsWith('Qwen')) continue;
          // Check if folder contains safetensors files (= it's a model)
          const files = readdirSync(entryPath);
          const hasSafetensors = files.some((f: string) => f.endsWith('.safetensors'));
          if (hasSafetensors) {
            downloaded.add(entry);
            if (!ALL_DIT_MODELS.includes(entry)) {
              ALL_DIT_MODELS.push(entry);
            }
          }
        } catch { /* skip unreadable entries */ }
      }
      // Also scan nested dirs (e.g. marcorez8/acestep-v15-xl-turbo-bf16)
      for (const entry of readdirSync(checkpointsDir)) {
        const entryPath = path.join(checkpointsDir, entry);
        try {
          if (!statSync(entryPath).isDirectory()) continue;
          // Check for nested model folders (HuggingFace org/repo style)
          for (const sub of readdirSync(entryPath)) {
            const subPath = path.join(entryPath, sub);
            if (!statSync(subPath).isDirectory()) continue;
            const subFiles = readdirSync(subPath);
            if (subFiles.some((f: string) => f.endsWith('.safetensors'))) {
              const fullName = `${entry}/${sub}`;
              downloaded.add(fullName);
              if (!ALL_DIT_MODELS.includes(fullName)) {
                ALL_DIT_MODELS.push(fullName);
              }
            }
          }
        } catch { /* skip */ }
      }
    } catch { /* checkpoints dir may not exist */ }

    const KNOWN_MODELS = new Set([
      'acestep-v15-xl-turbo',
      'acestep-v15-xl-sft',
      'marcorez8/acestep-v15-xl-turbo-bf16',
      'acestep-v15-xl-merge-sft-turbo',
    ]);

    const models = ALL_DIT_MODELS.map(name => ({
      name,
      is_active: name === activeModel || name === activeLoadedModel,
      is_preloaded: downloaded.has(name),
      is_custom: !KNOWN_MODELS.has(name),
    }));

    // Sort: active first, then downloaded, then alphabetical
    models.sort((a, b) => {
      if (a.is_active !== b.is_active) return a.is_active ? -1 : 1;
      if (a.is_preloaded !== b.is_preloaded) return a.is_preloaded ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    res.json({ models });
  } catch (error) {
    console.error('Models error:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /api/generate/random-description — random sample (upstream renamed → /create_random_sample HTTP)
router.get('/random-description', authMiddleware, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const r = await fetch(`${config.acestep.apiUrl}/create_random_sample`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sample_type: 'simple_mode' }),
    });
    if (!r.ok) throw new Error(`/create_random_sample HTTP ${r.status}`);
    const wrapped: any = await r.json();
    const data = wrapped?.data ?? wrapped ?? {};
    res.json({
      description: data.prompt || data.description || data.caption || '',
      instrumental: data.instrumental ?? false,
      vocalLanguage: data.vocal_language || data.vocalLanguage || 'unknown',
    });
  } catch (error) {
    console.error('Random description error:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

router.get('/health', async (_req, res: Response) => {
  try {
    const healthy = await checkSpaceHealth();
    res.json({ healthy, aceStepUrl: config.acestep.apiUrl });
  } catch (error) {
    res.json({ healthy: false, aceStepUrl: config.acestep.apiUrl, error: (error as Error).message });
  }
});

router.get('/limits', async (_req, res: Response) => {
  try {
    const { spawn } = await import('child_process');
    const ACESTEP_DIR = process.env.ACESTEP_PATH || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../ACE-Step-1.5');
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const SCRIPTS_DIR = path.join(__dirname, '../../scripts');
    const LIMITS_SCRIPT = path.join(SCRIPTS_DIR, 'get_limits.py');
    const pythonPath = resolvePythonPath(ACESTEP_DIR);

    const result = await new Promise<{ success: boolean; data?: any; error?: string }>((resolve) => {
      const proc = spawn(pythonPath, [LIMITS_SCRIPT], {
        cwd: ACESTEP_DIR,
        env: {
          ...process.env,
          ACESTEP_PATH: ACESTEP_DIR,
        },
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => { stdout += data.toString(); });
      proc.stderr.on('data', (data) => { stderr += data.toString(); });

      proc.on('close', (code) => {
        if (code === 0 && stdout) {
          try {
            const parsed = JSON.parse(stdout);
            resolve({ success: true, data: parsed });
          } catch {
            resolve({ success: false, error: 'Failed to parse limits result' });
          }
        } else {
          resolve({ success: false, error: stderr || 'Failed to read limits' });
        }
      });

      proc.on('error', (err) => {
        resolve({ success: false, error: err.message });
      });
    });

    if (result.success && result.data) {
      res.json(result.data);
    } else {
      res.status(500).json({ error: result.error || 'Failed to load limits' });
    }
  } catch (error) {
    console.error('Limits error:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

router.get('/debug/:taskId', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const rawResponse = getJobRawResponse(req.params.taskId);
    if (!rawResponse) {
      res.status(404).json({ error: 'Job not found or no raw response available' });
      return;
    }
    res.json({ rawResponse });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// Create Sample endpoint - LLM generates caption/lyrics/metadata from description (Simple Mode).
// Calls our custom /v1/create_sample_from_query (inspiration path) — runs the LLM directly
// on the description to AUTO-GENERATE lyrics. Do NOT use upstream /format_input here:
// that endpoint requires user-provided lyrics and forces "[Instrumental]" if they're empty.
router.post('/create-sample', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { query, instrumental, vocalLanguage, lmTemperature } = req.body;

    if (!query) {
      res.status(400).json({ error: 'query (song description) is required' });
      return;
    }

    const r = await fetch(`${config.acestep.apiUrl}/v1/create_sample_from_query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        instrumental: instrumental ?? false,
        vocal_language: vocalLanguage || null,
        temperature: lmTemperature ?? 0.85,
      }),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw new Error(`/v1/create_sample_from_query HTTP ${r.status}: ${text.slice(0, 200)}`);
    }
    const wrapped: any = await r.json();
    if (wrapped?.code && wrapped.code !== 200 && wrapped?.error) {
      throw new Error(wrapped.error);
    }
    const data = wrapped?.data ?? wrapped ?? {};

    res.json({
      caption: data.caption || '',
      lyrics: data.lyrics || '',
      bpm: data.bpm || 0,
      duration: data.duration || -1,
      keyScale: data.key_scale || '',
      vocalLanguage: data.vocal_language || vocalLanguage || 'en',
      timeSignature: data.time_signature || '',
      instrumental: data.instrumental ?? instrumental ?? false,
      status: 'Sample created',
    });
  } catch (error) {
    console.error('[CreateSample] Error:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

// Format endpoint - uses LLM to enhance style/lyrics
router.post('/format', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { caption, lyrics, bpm, duration, keyScale, timeSignature, temperature, topK, topP, lmModel, lmBackend, vocalLanguage } = req.body;

    if (!caption && !lyrics) {
      res.status(400).json({ error: 'Caption/style or lyrics is required' });
      return;
    }

    const ACESTEP_API_URL = config.acestep.apiUrl;

    // Build param_obj for the REST API
    const paramObj: Record<string, unknown> = {};
    if (bpm && bpm > 0) paramObj.bpm = bpm;
    if (duration && duration > 0) paramObj.duration = duration;
    if (keyScale) paramObj.key = keyScale;
    if (timeSignature) paramObj.time_signature = timeSignature;

    // Call FastAPI /format_input (upstream replaced Gradio /format_caption + /format_lyrics
    // with a single endpoint that returns caption + lyrics + metadata in one call).
    try {
      console.log('[Format] Calling /format_input...');
      const r = await fetch(`${ACESTEP_API_URL}/format_input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: caption || '',
          lyrics: lyrics || '',
          temperature: temperature ?? 0.85,
        }),
      });
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        throw new Error(`/format_input HTTP ${r.status}: ${text.slice(0, 200)}`);
      }
      const wrapped: any = await r.json();
      if (wrapped?.code && wrapped.code !== 200 && wrapped?.error) {
        throw new Error(wrapped.error);
      }
      const d = wrapped?.data ?? wrapped ?? {};

      res.json({
        caption: d.caption || caption,
        lyrics: d.lyrics || lyrics || '',
        bpm: d.bpm || (bpm ?? 0),
        duration: d.duration || (duration ?? -1),
        key_scale: d.key_scale || keyScale || '',
        vocal_language: d.vocal_language || vocalLanguage || 'unknown',
        time_signature: d.time_signature || timeSignature || '',
      });
      return;
    } catch (gradioErr: any) {
      console.error('[Format] /format_input failed, falling back to python spawn:', gradioErr?.message);
    }

    // Fallback: Python spawn (only reached when Gradio is unreachable)
    const { spawn } = await import('child_process');
    const ACESTEP_DIR = process.env.ACESTEP_PATH || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../ACE-Step-1.5');
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const SCRIPTS_DIR = path.join(__dirname, '../../scripts');
    const FORMAT_SCRIPT = path.join(SCRIPTS_DIR, 'format_sample.py');
    const pythonPath = resolvePythonPath(ACESTEP_DIR);

    const args = [FORMAT_SCRIPT, '--caption', caption, '--json'];
    if (lyrics) args.push('--lyrics', lyrics);
    if (bpm && bpm > 0) args.push('--bpm', String(bpm));
    if (duration && duration > 0) args.push('--duration', String(duration));
    if (keyScale) args.push('--key-scale', keyScale);
    if (timeSignature) args.push('--time-signature', timeSignature);
    if (temperature !== undefined) args.push('--temperature', String(temperature));
    if (topK && topK > 0) args.push('--top-k', String(topK));
    if (topP !== undefined) args.push('--top-p', String(topP));
    if (lmModel) args.push('--lm-model', lmModel);
    if (lmBackend) args.push('--lm-backend', lmBackend);

    console.log(`[Format] Fallback spawn: ${pythonPath} ${args.join(' ')}`);
    const result = await new Promise<{ success: boolean; data?: any; error?: string }>((resolve) => {
      const proc = spawn(pythonPath, args, {
        cwd: ACESTEP_DIR,
        env: { ...process.env, ACESTEP_PATH: ACESTEP_DIR },
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => { stdout += data.toString(); });
      proc.stderr.on('data', (data) => { stderr += data.toString(); });

      proc.on('close', (code) => {
        if (code === 0 && stdout) {
          const lines = stdout.trim().split('\n');
          let jsonStr = '';
          for (let i = lines.length - 1; i >= 0; i--) {
            if (lines[i].startsWith('{')) { jsonStr = lines[i]; break; }
          }
          try {
            const parsed = JSON.parse(jsonStr || stdout);
            resolve({ success: true, data: parsed });
          } catch {
            console.error('[Format] Failed to parse stdout:', stdout.slice(0, 500));
            resolve({ success: false, error: 'Failed to parse format result' });
          }
        } else {
          console.error(`[Format] Process exited with code ${code}`);
          if (stdout) console.error('[Format] stdout:', stdout.slice(0, 1000));
          if (stderr) console.error('[Format] stderr:', stderr.slice(0, 1000));
          resolve({ success: false, error: stderr || stdout || `Format process exited with code ${code}` });
        }
      });

      proc.on('error', (err) => {
        console.error('[Format] Spawn error:', err.message);
        resolve({ success: false, error: err.message });
      });
    });

    if (result.success && result.data) {
      res.json(result.data);
    } else {
      console.error('[Format] Python error:', result.error);
      res.status(500).json({ success: false, error: result.error });
    }
  } catch (error) {
    console.error('[Format] Route error:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

export default router;
