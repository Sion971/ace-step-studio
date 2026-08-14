import { writeFile, mkdir, copyFile, rm, readFile } from 'fs/promises';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { handle_file } from '@gradio/client';

// Get audio duration using ffprobe
function getAudioDuration(filePath: string): number {
  try {
    const result = execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
      { encoding: 'utf-8', timeout: 10000 }
    );
    const duration = parseFloat(result.trim());
    return isNaN(duration) ? 0 : Math.round(duration);
  } catch (error) {
    console.warn('Failed to get audio duration:', error);
    return 0;
  }
}
import { fileURLToPath } from 'url';
import { config } from '../config/index.js';
import { getGradioClient, resetGradioClient, isGradioAvailable } from './gradio-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AUDIO_DIR = path.join(__dirname, '../../public/audio');

const ACESTEP_API = config.acestep.apiUrl;

// Resolve ACE-Step path (from env or default relative path)
function resolveAceStepPath(): string {
  const envPath = process.env.ACESTEP_PATH;
  if (envPath) {
    return path.isAbsolute(envPath) ? envPath : path.resolve(process.cwd(), envPath);
  }
  // Default: sibling directory (server/src/services -> ../../../ACE-Step-1.5 = app/ACE-Step-1.5)
  return path.resolve(__dirname, '../../../ACE-Step-1.5');
}

// Resolve Python path cross-platform (supports venv and portable installations)
export function resolvePythonPath(baseDir: string): string {
  // Allow explicit override via env var (resolve to absolute path)
  if (process.env.PYTHON_PATH) {
    const envPath = process.env.PYTHON_PATH;
    return path.isAbsolute(envPath) ? envPath : path.resolve(envPath);
  }

  const isWindows = process.platform === 'win32';
  const pythonExe = isWindows ? 'python.exe' : 'python';

  // Check for portable installation first (python_embeded)
  const portablePath = path.join(baseDir, 'python_embeded', pythonExe);
  if (existsSync(portablePath)) {
    return portablePath;
  }

  // ACE-Step-Studio portable: python/ in project root (sibling of ACE-Step-1.5/)
  const studioPortablePath = path.join(baseDir, '..', 'python', pythonExe);
  if (existsSync(studioPortablePath)) {
    return studioPortablePath;
  }

  // Check common venv directory names (Pinokio uses 'env', others use '.venv' or 'venv')
  const venvDirs = ['env', '.venv', 'venv'];
  for (const venvDir of venvDirs) {
    const venvPython = isWindows
      ? path.join(baseDir, venvDir, 'Scripts', pythonExe)
      : path.join(baseDir, venvDir, 'bin', 'python');
    if (existsSync(venvPython)) {
      return venvPython;
    }
  }

  // Fallback to first option (will produce a clear error if not found)
  if (isWindows) {
    return path.join(baseDir, 'env', 'Scripts', pythonExe);
  }
  return path.join(baseDir, 'env', 'bin', 'python');
}

const ACESTEP_DIR = resolveAceStepPath();
const SCRIPTS_DIR = path.join(__dirname, '../../scripts');
const PYTHON_SCRIPT = path.join(SCRIPTS_DIR, 'simple_generate.py');

// ---------------------------------------------------------------------------
// Gradio generation: named args for /generation_wrapper
// ---------------------------------------------------------------------------

/**
 * Resolve an audio URL (e.g. /audio/file.mp3) to an absolute local file path.
 */
function resolveAudioPath(audioUrl: string): string {
  if (audioUrl.startsWith('/audio/')) {
    return path.join(AUDIO_DIR, audioUrl.replace('/audio/', ''));
  }
  if (audioUrl.startsWith('http')) {
    try {
      const parsed = new URL(audioUrl);
      if (parsed.pathname.startsWith('/audio/')) {
        return path.join(AUDIO_DIR, parsed.pathname.replace('/audio/', ''));
      }
    } catch { /* fall through */ }
  }
  return audioUrl;
}

/**
 * Prepare a local audio file for Gradio upload.
 * Returns a handle_file() wrapper or null if no file.
 */
async function prepareAudioFile(audioUrl: string | undefined): Promise<unknown> {
  if (!audioUrl) return null;

  const filePath = resolveAudioPath(audioUrl);

  try {
    if (existsSync(filePath)) {
      // Gradio Audio component uses type="filepath" — Python gets a path string.
      // Copy file into Gradio's temp directory with correct filename+extension.
      // Return FileData pointing to the temp copy — Gradio recognizes its own
      // temp paths and passes them directly to Python without re-downloading.
      const filename = path.basename(filePath);
      const gradioTmpDir = path.resolve(ACESTEP_DIR, '..', 'temp', 'gradio', `ref-${Date.now()}`);
      await mkdir(gradioTmpDir, { recursive: true });
      const tmpPath = path.join(gradioTmpDir, filename);
      await copyFile(filePath, tmpPath);
      return {
        path: tmpPath,
        orig_name: filename,
        meta: { _type: 'gradio.FileData' },
      };
    }
    if (audioUrl.startsWith('http')) {
      return handle_file(audioUrl);
    }
    console.warn(`[Gradio] Audio file not found: ${filePath}`);
    return null;
  } catch (error) {
    console.warn(`[Gradio] Failed to prepare audio file ${filePath}:`, error);
    if (audioUrl.startsWith('http')) {
      return handle_file(audioUrl);
    }
    return null;
  }
}

/**
 * Build named arguments for the Gradio /generation_wrapper endpoint.
 * Keys match the Python function signature in generation_run_wiring.py.
 * gr.State params (is_format_caption, batch states) are handled by Gradio automatically.
 */
async function buildGradioArgs(params: GenerationParams): Promise<Record<string, unknown>> {
  const caption = params.style || 'pop music';
  const prompt = params.customMode ? caption : (params.songDescription || caption);
  const lyrics = params.instrumental ? '' : (params.lyrics || '');
  const isThinking = params.thinking ?? false;
  const isEnhance = params.enhance ?? false;

  const referenceAudio = await prepareAudioFile(params.referenceAudioUrl);
  const sourceAudio = await prepareAudioFile(params.sourceAudioUrl);

  const needsSource = params.taskType === 'cover' || params.taskType === 'audio2audio' || params.taskType === 'repaint';
  if (needsSource && params.sourceAudioUrl && sourceAudio === null) {
    throw new Error(`Source audio file could not be loaded from: ${params.sourceAudioUrl}. Make sure the file was uploaded successfully.`);
  }

  const useCot = isEnhance || isThinking;
  const isTurbo = (params.ditModel || '').includes('turbo') && !(params.ditModel || '').includes('merge');
  const taskType = (params.taskType === 'audio2audio' ? 'cover' : params.taskType) || 'text2music';

  return {
    captions: prompt,
    lyrics,
    bpm: params.bpm && params.bpm > 0 ? params.bpm : 0,
    key_scale: params.keyScale || '',
    time_signature: params.timeSignature || '',
    vocal_language: params.vocalLanguage || 'en',
    inference_steps: Math.min(params.inferenceSteps ?? 8, isTurbo ? 20 : 200),
    guidance_scale: params.guidanceScale ?? 7.0,
    random_seed_checkbox: params.randomSeed !== false,
    seed: String(params.seed ?? -1),
    reference_audio: referenceAudio,
    audio_duration: params.duration && params.duration > 0 ? params.duration : -1,
    batch_size_input: Math.min(Math.max(params.batchSize ?? 1, 1), 16),
    src_audio: sourceAudio,
    text2music_audio_code_string: params.audioCodes || '',
    repainting_start: params.repaintingStart ?? 0.0,
    repainting_end: params.repaintingEnd ?? -1,
    instruction_display_gen: params.instruction || (
      taskType === 'cover' ? 'Generate audio semantic tokens based on the given conditions:' :
      taskType === 'repaint' ? 'Repaint the mask area based on the given conditions:' :
      'Fill the audio semantic mask based on the given conditions:'
    ),
    audio_cover_strength: params.audioCoverStrength ?? 1.0,
    cover_noise_strength: params.coverNoiseStrength ?? 0.0,
    task_type: taskType,
    no_fsq: false,
    use_adg: params.useAdg ?? false,
    cfg_interval_start: params.cfgIntervalStart ?? 0.0,
    cfg_interval_end: params.cfgIntervalEnd ?? 1.0,
    shift: Math.max(params.shift ?? 3.0, 1.0),
    infer_method: params.inferMethod || 'ode',
    sampler_mode: params.samplerMode || 'euler',
    scheduler_type: params.schedulerType || 'linear',
    velocity_norm_threshold: params.velocityNormThreshold ?? 0.0,
    velocity_ema_factor: params.velocityEmaFactor ?? 0.0,
    // DCW (Differential Correction in Wavelet domain) — CVPR 2026 quality boost
    dcw_enabled: params.dcwEnabled ?? true,
    dcw_mode: params.dcwMode || 'double',
    dcw_scaler: params.dcwScaler ?? 0.05,
    dcw_high_scaler: params.dcwHighScaler ?? 0.02,
    dcw_wavelet: params.dcwWavelet || 'haar',
    custom_timesteps: params.customTimesteps || '',
    audio_format: params.audioFormat || 'mp3',
    mp3_bitrate: params.mp3Bitrate || '128k',
    mp3_sample_rate: params.mp3SampleRate ?? 48000,
    lm_temperature: params.lmTemperature ?? 0.85,
    think_checkbox: isThinking,
    lm_cfg_scale: Math.max(params.lmCfgScale ?? 2.0, 1.0),
    lm_top_k: params.lmTopK ?? 0,
    lm_top_p: params.lmTopP ?? 0.9,
    lm_negative_prompt: params.lmNegativePrompt || 'NO USER INPUT',
    use_cot_metas: useCot ? (params.useCotMetas ?? true) : false,
    use_cot_caption: useCot ? (params.useCotCaption ?? true) : false,
    use_cot_language: useCot ? (params.useCotLanguage ?? true) : false,
    constrained_decoding_debug: params.constrainedDecodingDebug ?? false,
    allow_lm_batch: params.allowLmBatch ?? true,
    auto_score: params.getScores ?? false,
    auto_lrc: params.getLrc ?? false,
    score_scale: params.scoreScale ?? 0.5,
    lm_batch_chunk_size: params.lmBatchChunkSize ?? 8,
    track_name: params.trackName || null,
    complete_track_classes: params.completeTrackClasses || [],
    enable_normalization: params.enableNormalization ?? true,
    normalization_db: params.normalizationDb ?? -1.0,
    fade_in_duration: params.fadeInDuration ?? 0.0,
    fade_out_duration: params.fadeOutDuration ?? 0.0,
    latent_shift: params.latentShift ?? 0.0,
    latent_rescale: params.latentRescale ?? 1.0,
    repaint_mode: params.repaintMode || 'balanced',
    repaint_strength: params.repaintStrength ?? 0.5,
    // Retake — variance-preserving blend with an independent noise draw
    retake_variance: params.retakeVariance ?? 0.0,
    retake_seed: params.retakeSeed ?? -1,
    // Flow-edit (#1156) — text-edit overlay morphing src toward target
    flow_edit_morph: params.flowEditMorph ?? false,
    flow_edit_source_caption: params.flowEditSourceCaption ?? '',
    flow_edit_source_lyrics: params.flowEditSourceLyrics ?? '',
    flow_edit_n_min: params.flowEditNMin ?? 0.0,
    flow_edit_n_max: params.flowEditNMax ?? 1.0,
    flow_edit_n_avg: params.flowEditNAvg ?? 1,
    autogen_checkbox: params.autogen ?? false,
  };
}

/**
 * Download a Gradio audio result file to local storage.
 * Gradio returns file objects with { url, path, orig_name, ... }.
 * We copy from the server-local path (same machine) or download via URL.
 */
async function downloadGradioAudioFile(
  fileObj: { url?: string; path?: string; orig_name?: string },
  destPath: string,
): Promise<void> {
  await mkdir(path.dirname(destPath), { recursive: true });

  // Prefer direct filesystem copy (both servers on same machine)
  if (fileObj.path && existsSync(fileObj.path)) {
    await copyFile(fileObj.path, destPath);
    return;
  }

  // Fall back to HTTP download via Gradio URL (use temp file for atomicity)
  if (fileObj.url) {
    const response = await fetch(fileObj.url);
    if (!response.ok) {
      throw new Error(`Failed to download Gradio audio: ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) {
      throw new Error('Downloaded audio file is empty');
    }
    const tmpPath = destPath + '.tmp';
    await writeFile(tmpPath, buffer);
    const { rename } = await import('fs/promises');
    await rename(tmpPath, destPath);
    return;
  }

  throw new Error('Gradio file object has neither path nor url');
}

// ---------------------------------------------------------------------------
// Generation types & interfaces (unchanged public API)
// ---------------------------------------------------------------------------

export interface GenerationParams {
  // Mode
  customMode: boolean;

  // Simple Mode
  songDescription?: string;

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

  // DCW (Differential Correction in Wavelet domain) — CVPR 2026 quality boost
  dcwEnabled?: boolean;
  dcwMode?: 'low' | 'high' | 'double' | 'pix';
  dcwScaler?: number;
  dcwHighScaler?: number;
  dcwWavelet?: string;

  // Retake — variance-preserving blend with an independent noise draw
  retakeSeed?: number;
  retakeVariance?: number;

  // Flow-edit (#1156) — text-edit overlay morphing src toward target prompt/lyrics
  flowEditMorph?: boolean;
  flowEditSourceCaption?: string;
  flowEditSourceLyrics?: string;
  flowEditNMin?: number;
  flowEditNMax?: number;
  flowEditNAvg?: number;

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
}

interface GenerationResult {
  audioUrls: string[];
  duration: number;
  bpm?: number;
  keyScale?: string;
  timeSignature?: string;
  status: string;
  generationTime?: number;
  lrcData?: (string | null)[];
}

interface JobStatus {
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  queuePosition?: number;
  etaSeconds?: number;
  progress?: number;
  stage?: string;
  result?: GenerationResult;
  error?: string;
}

interface ActiveJob {
  params: GenerationParams;
  startTime: number;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  taskId?: string;
  result?: GenerationResult;
  error?: string;
  processPromise?: Promise<void>;
  rawResponse?: unknown;
  queuePosition?: number;
  progress?: number;
  stage?: string;
}

const activeJobs = new Map<string, ActiveJob>();

// Periodic cleanup of old jobs (every 10 minutes, remove jobs older than 1 hour)
setInterval(() => cleanupOldJobs(3600000), 600000);

// Job queue for sequential processing (GPU can only handle one job at a time)
const jobQueue: string[] = [];
let isProcessingQueue = false;

// Health check - verify Gradio app is reachable
export async function checkSpaceHealth(): Promise<boolean> {
  return isGradioAvailable();
}

// ---------------------------------------------------------------------------
// Model switching — call /v1/init to change the active DiT model
// ---------------------------------------------------------------------------

async function getActiveModel(): Promise<string | null> {
  try {
    const res = await fetch(`${ACESTEP_API}/v1/models`);
    if (!res.ok) return null;
    const data = await res.json() as any;
    const models = data?.data?.models || data?.models || [];
    return models[0]?.name || null;
  } catch {
    return null;
  }
}

// HuggingFace repo mapping for auto-download
const MODEL_HF_REPOS: Record<string, string> = {
  'acestep-v15-xl-turbo': 'ACE-Step/acestep-v15-xl-turbo',
  'acestep-v15-xl-sft': 'ACE-Step/acestep-v15-xl-sft',
  'marcorez8/acestep-v15-xl-turbo-bf16': 'marcorez8/acestep-v15-xl-turbo-bf16',
};

async function ensureModelDownloaded(ditModel: string): Promise<void> {
  const checkpointsDir = path.join(ACESTEP_DIR, 'checkpoints');
  const modelDir = path.join(checkpointsDir, ditModel);
  if (existsSync(modelDir)) return; // already downloaded

  const hfRepo = MODEL_HF_REPOS[ditModel];
  if (!hfRepo) {
    console.warn(`[Model] Unknown model '${ditModel}', skipping auto-download`);
    return;
  }

  console.log(`[Model] Auto-downloading '${hfRepo}' to '${modelDir}'...`);
  const pythonPath = resolvePythonPath(ACESTEP_DIR);
  const { execSync } = await import('child_process');
  try {
    execSync(
      `"${pythonPath}" -m huggingface_hub.commands.huggingface_cli download ${hfRepo} --local-dir "${modelDir}"`,
      { stdio: 'inherit', timeout: 3600_000, env: { ...process.env, HF_HUB_ENABLE_HF_TRANSFER: '1', PYTHONIOENCODING: 'utf-8' } }
    );
    console.log(`[Model] Downloaded '${ditModel}' successfully`);
  } catch (err) {
    console.error(`[Model] Failed to download '${ditModel}':`, err);
    throw new Error(`Failed to download model '${ditModel}'`);
  }
}

async function switchModelIfNeeded(ditModel: string): Promise<void> {
  const activeModel = await getActiveModel();
  if (activeModel === ditModel) return; // already loaded, no-op

  // Auto-download if not on disk
  await ensureModelDownloaded(ditModel);

  console.log(`[Model] Switching from '${activeModel ?? 'unknown'}' to '${ditModel}'`);
  const res = await fetch(`${ACESTEP_API}/v1/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: ditModel, init_llm: false }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Model switch to '${ditModel}' failed: ${res.status} ${err}`);
  }
  console.log(`[Model] Switched to '${ditModel}'`);
}

// Discover endpoints (for compatibility)
export async function discoverEndpoints(): Promise<unknown> {
  return { provider: 'acestep-gradio', endpoint: ACESTEP_API };
}

// Reset client — forces Gradio reconnection on next request
export function resetClient(): void {
  resetGradioClient();
}

// ---------------------------------------------------------------------------
// Job queue
// ---------------------------------------------------------------------------

async function processQueue(): Promise<void> {
  if (isProcessingQueue) return;
  isProcessingQueue = true;

  while (jobQueue.length > 0) {
    const jobId = jobQueue[0];
    const job = activeJobs.get(jobId);

    if (job && job.status === 'queued') {
      try {
        await processGeneration(jobId, job.params, job);
      } catch (error: any) {
        const msg = error?.message || String(error);
        job.status = 'failed';
        job.error = msg;
        if (msg.includes('VRAM') || msg.includes('Insufficient free')) {
          console.error(`\n❌ [${jobId}] NOT ENOUGH GPU MEMORY`);
          console.error(`   ${msg.match(/need ~[\d.]+ GB, only [\d.]+ GB available/)?.[0] || msg}`);
          console.error(`   Reduce duration/batch or switch to a lighter model\n`);
        } else {
          console.error(`[${jobId}] Generation failed: ${msg}`);
        }
      }
    }

    // Remove from queue after processing (whether success or failure)
    jobQueue.shift();

    // Update queue positions for remaining jobs
    jobQueue.forEach((id, index) => {
      const queuedJob = activeJobs.get(id);
      if (queuedJob) {
        queuedJob.queuePosition = index + 1;
      }
    });
  }

  isProcessingQueue = false;
}

// Submit generation job to queue
export async function generateMusicViaAPI(params: GenerationParams): Promise<{ jobId: string }> {
  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  // Queue limit: max 10 jobs
  const MAX_QUEUE_SIZE = 10;
  if (jobQueue.length >= MAX_QUEUE_SIZE) {
    throw new Error(`Queue is full (${MAX_QUEUE_SIZE} jobs). Wait for current jobs to finish.`);
  }

  const job: ActiveJob = {
    params,
    startTime: Date.now(),
    status: 'queued',
    queuePosition: jobQueue.length + 1,
  };

  activeJobs.set(jobId, job);
  jobQueue.push(jobId);

  // Job queued

  // Start processing the queue (will be a no-op if already processing)
  processQueue().catch(err => console.error('Queue processing error:', err));

  return { jobId };
}

// ---------------------------------------------------------------------------
// processGeneration — Gradio only
// ---------------------------------------------------------------------------

async function processGeneration(
  jobId: string,
  params: GenerationParams,
  job: ActiveJob,
): Promise<void> {
  job.status = 'running';
  job.stage = 'starting';

  // Guard: cover/audio2audio requires a source or audio codes
  if ((params.taskType === 'cover' || params.taskType === 'audio2audio') && !params.sourceAudioUrl && !params.audioCodes) {
    job.status = 'failed';
    job.error = `task_type='${params.taskType}' requires a source audio or audio codes`;
    return;
  }

  // Wait for Gradio if it's loading/switching
  let gradioUp = await isGradioAvailable();
  if (!gradioUp) {
    job.stage = 'Ожидание загрузки модели...';
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 2000));
      gradioUp = await isGradioAvailable();
      if (gradioUp) break;
    }
    if (!gradioUp) {
      job.status = 'failed';
      job.error = 'Gradio pipeline not available after 2 minutes';
      return;
    }
  }

  await processGenerationViaGradio(jobId, params, job);
}

async function processGenerationViaGradio(
  jobId: string,
  params: GenerationParams,
  job: ActiveJob,
): Promise<void> {
  // Note: model switching is handled via /switch-model endpoint (Gradio pipeline restart).
  // The /v1/init API is only available in FastAPI mode (acestep-api), not Gradio pipeline.

  const client = await getGradioClient();
  const args = await buildGradioArgs(params);

  const caption = params.style || 'pop music';
  const prompt = params.customMode ? caption : (params.songDescription || caption);

  job.stage = 'generating';

  // Signal that generation is in progress (blocks model switch)
  let setGenFlag: ((v: boolean) => void) | undefined;
  try {
    const genModule = await import('../routes/generate.js');
    setGenFlag = genModule.setGenerationInProgress;
    setGenFlag?.(true);
  } catch {}

  let result;
  try {
    result = await client.predict('/generation_wrapper', args);
  } finally {
    setGenFlag?.(false);
  }
  const data = result.data as unknown[];

  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`Gradio returned unexpected data format: ${typeof data}`);
  }

  // Extract audio files from the result
  // Outputs 0-7: individual audio samples (filepath objects)
  // Output 8: "All Generated Files" as list[filepath]
  // Output 9: "Generation Details" (string)
  // Output 10: "Generation Status" (string)
  // Output 11: "Seed" (string)
  const allFiles = data[8]; // list of file objects
  const genDetails = data[9] as string | undefined;
  const genStatus = data[10] as string | undefined;
  const genSeed = data[11] as string | undefined;
  // LRC data — find in Gradio outputs
  const lrcData: string[] = [];
  for (let i = 12; i < data.length; i++) {
    const val = data[i];
    // Check string
    if (typeof val === 'string' && /\[\d{2}:\d{2}/.test(val)) {
      lrcData.push(val);
    }
    // Check Gradio update object {value: "...", ...}
    if (val && typeof val === 'object' && (val as any).value && typeof (val as any).value === 'string') {
      const v = (val as any).value;
      if (/\[\d{2}:\d{2}/.test(v)) {
        lrcData.push(v);
      }
    }
  }

  // Collect audio file objects — prefer the "All Generated Files" list
  let audioFileObjects: Array<{ url?: string; path?: string; orig_name?: string }> = [];

  if (Array.isArray(allFiles) && allFiles.length > 0) {
    audioFileObjects = allFiles.filter(
      (f: any) => f && (f.path || f.url) && isAudioFile(f.orig_name || f.path || '')
    );
  }

  // Fallback: check individual sample outputs (indices 0-7)
  if (audioFileObjects.length === 0) {
    for (let i = 0; i < 8; i++) {
      const fileObj = data[i] as any;
      if (fileObj && (fileObj.path || fileObj.url)) {
        audioFileObjects.push(fileObj);
      }
    }
  }

  if (audioFileObjects.length === 0) {
    throw new Error(`Gradio generation returned no audio files. Status: ${genStatus || 'unknown'}. Details: ${genDetails || 'none'}`);
  }

  // Download audio files to local storage
  const audioUrls: string[] = [];
  let actualDuration = 0;
  const audioFormat = params.audioFormat ?? 'mp3';

  for (const fileObj of audioFileObjects) {
    const origName = fileObj.orig_name || fileObj.path || '';
    const ext = origName.includes('.flac') ? '.flac' : `.${audioFormat}`;
    const filename = `${jobId}_${audioUrls.length}${ext}`;
    const destPath = path.join(AUDIO_DIR, filename);

    await downloadGradioAudioFile(fileObj, destPath);

    if (audioUrls.length === 0) {
      actualDuration = getAudioDuration(destPath);
    }

    audioUrls.push(`/audio/${filename}`);
  }

  // Parse metadata from generation details if available
  const metas = parseGenerationDetails(genDetails);

  const finalDuration = actualDuration > 0
    ? actualDuration
    : (metas.duration || params.duration || 0);

  const generationTime = Math.round((Date.now() - job.startTime) / 1000);

  job.status = 'succeeded';
  job.result = {
    audioUrls,
    duration: finalDuration,
    bpm: metas.bpm || params.bpm,
    keyScale: metas.keyScale || params.keyScale,
    timeSignature: metas.timeSignature || params.timeSignature,
    generationTime,
    lrcData,
    status: 'succeeded',
  };
  job.rawResponse = { genDetails, genStatus };
  // Completed via Gradio
}

function isAudioFile(name: string): boolean {
  return /\.(mp3|flac|wav|ogg|m4a)$/i.test(name);
}

function parseGenerationDetails(details: string | undefined): {
  bpm?: number;
  duration?: number;
  keyScale?: string;
  timeSignature?: string;
} {
  if (!details) return {};
  try {
    // Generation details may contain key-value pairs
    const bpmMatch = details.match(/BPM:\s*(\d+)/i);
    const durationMatch = details.match(/Duration:\s*([\d.]+)/i);
    const keyMatch = details.match(/Key:\s*([A-G][#b♯♭]?\s*(?:major|minor))/i);
    const timeMatch = details.match(/Time Signature:\s*(\d+(?:\/\d+)?)/i);
    return {
      bpm: bpmMatch ? parseInt(bpmMatch[1]) : undefined,
      duration: durationMatch ? parseFloat(durationMatch[1]) : undefined,
      keyScale: keyMatch ? keyMatch[1] : undefined,
      timeSignature: timeMatch ? timeMatch[1] : undefined,
    };
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Job status
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Job status (simplified — no more REST polling for progress)
// ---------------------------------------------------------------------------

export async function getJobStatus(jobId: string): Promise<JobStatus> {
  const job = activeJobs.get(jobId);

  if (!job) {
    return {
      status: 'failed',
      error: 'Job not found',
    };
  }

  if (job.status === 'succeeded' && job.result) {
    return {
      status: 'succeeded',
      result: job.result,
    };
  }

  if (job.status === 'failed') {
    return {
      status: 'failed',
      error: job.error || 'Generation failed',
    };
  }

  const elapsed = Math.floor((Date.now() - job.startTime) / 1000);

  if (job.status === 'queued') {
    return {
      status: job.status,
      queuePosition: job.queuePosition,
      etaSeconds: (job.queuePosition || 1) * 180,
    };
  }

  // Running — Gradio handles its own queue, we just report estimated time
  return {
    status: job.status,
    etaSeconds: Math.max(0, 180 - elapsed),
    progress: job.progress,
    stage: job.stage,
  };
}

// Get raw response for debugging
export function getJobRawResponse(jobId: string): unknown | null {
  const job = activeJobs.get(jobId);
  return job?.rawResponse || null;
}

// ---------------------------------------------------------------------------
// Audio helpers (unchanged)
// ---------------------------------------------------------------------------

export async function getAudioStream(audioPath: string): Promise<Response> {
  if (audioPath.startsWith('http')) {
    return fetch(audioPath);
  }

  if (audioPath.startsWith('/audio/')) {
    const localPath = path.join(AUDIO_DIR, audioPath.replace('/audio/', ''));
    try {
      const buffer = await readFile(localPath);
      const ext = localPath.endsWith('.flac') ? 'flac' : 'mpeg';
      return new Response(buffer, {
        status: 200,
        headers: { 'Content-Type': `audio/${ext}` }
      });
    } catch (err) {
      console.error('Failed to read local audio file:', localPath, err);
      return new Response(null, { status: 404 });
    }
  }

  // Absolute path — try reading directly from disk (Gradio output files)
  if (audioPath.startsWith('/')) {
    try {
      const buffer = await readFile(audioPath);
      const ext = audioPath.endsWith('.flac') ? 'flac' : audioPath.endsWith('.wav') ? 'wav' : 'mpeg';
      return new Response(buffer, {
        status: 200,
        headers: { 'Content-Type': `audio/${ext}` }
      });
    } catch {
      // Fall through to Gradio API
    }
  }

  const url = `${ACESTEP_API}/v1/audio?path=${encodeURIComponent(audioPath)}`;
  return fetch(url);
}

export async function downloadAudio(remoteUrl: string, songId: string): Promise<string> {
  await mkdir(AUDIO_DIR, { recursive: true });

  const response = await getAudioStream(remoteUrl);
  if (!response.ok) {
    throw new Error(`Failed to download audio: ${response.status}`);
  }

  const buffer = await response.arrayBuffer();
  const ext = remoteUrl.includes('.flac') ? '.flac' : '.mp3';
  const filename = `${songId}${ext}`;
  const filepath = path.join(AUDIO_DIR, filename);

  await writeFile(filepath, Buffer.from(buffer));

  return `/audio/${filename}`;
}

export async function downloadAudioToBuffer(remoteUrl: string): Promise<{ buffer: Buffer; size: number }> {
  const response = await getAudioStream(remoteUrl);
  if (!response.ok) {
    throw new Error(`Failed to download audio: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  return { buffer, size: buffer.length };
}

export function cancelJob(jobId: string): boolean {
  // Remove from queue if still queued
  const queueIdx = jobQueue.indexOf(jobId);
  if (queueIdx !== -1) {
    jobQueue.splice(queueIdx, 1);
    // Update positions for remaining jobs
    jobQueue.forEach((id, index) => {
      const queuedJob = activeJobs.get(id);
      if (queuedJob) queuedJob.queuePosition = index + 1;
    });
  }

  const job = activeJobs.get(jobId);
  if (!job) return false;

  job.status = 'failed';
  job.error = 'Cancelled by user';
  return true;
}

export function cancelAllJobs(): number {
  let cancelled = 0;

  // Cancel all queued jobs
  while (jobQueue.length > 0) {
    const id = jobQueue.pop()!;
    const job = activeJobs.get(id);
    if (job && job.status === 'queued') {
      job.status = 'failed';
      job.error = 'Cancelled by user';
      cancelled++;
    }
  }

  // Mark running jobs as failed too (Gradio predict can't be aborted mid-flight,
  // but the job will be marked as cancelled so the frontend stops polling)
  for (const [id, job] of activeJobs) {
    if (job.status === 'running') {
      job.status = 'failed';
      job.error = 'Cancelled by user';
      cancelled++;
    }
  }

  return cancelled;
}

export function cleanupJob(jobId: string): void {
  activeJobs.delete(jobId);
}

export function cleanupOldJobs(maxAgeMs: number = 3600000): void {
  const now = Date.now();
  for (const [jobId, job] of activeJobs) {
    if (now - job.startTime > maxAgeMs) {
      activeJobs.delete(jobId);
    }
  }
}
