import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  // Pipeline process management
  pipeline: {
    pythonPath: process.env.PYTHON_PATH || path.join(__dirname, '../../../../python/python.exe'),
    aceStepDir: process.env.ACESTEP_PATH || path.join(__dirname, '../../../../ACE-Step-1.5'),
    defaultModel: process.env.DEFAULT_MODEL || 'marcorez8/acestep-v15-xl-turbo-bf16',
    port: parseInt(process.env.ACESTEP_PORT || '8001', 10),
    healthCheckInterval: 10_000,  // 10 seconds
    startupTimeout: 300_000,     // 5 minutes (model loading is slow)
    maxRestarts: 10,
    backoffBase: 500,            // ms, doubles each restart
    backoffMax: 15_000,          // 15 seconds max
  },

  // Conversion audio -> MIDI (basic-pitch, Spotify). Environnement Python
  // ISOLE, distinct du venv ACE-Step (pipeline.pythonPath ci-dessus) — evite
  // tout conflit avec les versions figees de torch/torchaudio/numpy
  // qu'ACE-Step exige. Pas de gestion de processus persistant ici (contraste
  // avec pipeline.* plus haut) : un appel ponctuel par conversion, le
  // processus se termine de lui-meme une fois le MIDI ecrit.
  basicPitch: {
    pythonPath: process.env.BASIC_PITCH_PYTHON_PATH || path.join(__dirname, '../../basic-pitch-venv/bin/python3'),
    scriptPath: path.join(__dirname, '../../scripts/basic_pitch_convert.py'),
    // Timeout genereux mais fini : ONNX sur CPU pour un stem de quelques
    // minutes devrait prendre quelques secondes, pas les dizaines de
    // minutes observees avec la tentative navigateur/TensorFlow.js —
    // si ca depasse ce delai, quelque chose ne va pas, mieux vaut echouer
    // proprement que bloquer indefiniment.
    timeoutMs: 120_000,
  },

  // SQLite database
  database: {
    path: process.env.DATABASE_PATH || path.join(__dirname, '../../data/acestep.db'),
  },

  // ACE-Step API (local)
  acestep: {
    apiUrl: process.env.ACESTEP_API_URL || 'http://localhost:8001',
  },

  // Pexels (optional - for video backgrounds)
  pexels: {
    apiKey: process.env.PEXELS_API_KEY || '',
  },

  // Frontend URL
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',

  // Storage (local only)
  storage: {
    provider: 'local' as const,
    audioDir: process.env.AUDIO_DIR || path.join(__dirname, '../../public/audio'),
  },

  // Zone de depot temporaire pour "Ouvrir dans l'editeur" (stems separes
  // par Demucs, existant uniquement comme buffers en memoire cote
  // navigateur — jamais de fichier serveur reel). L'editeur AudioMass
  // s'ouvre comme une page SEPAREE : une URL blob: creee dans la page
  // React ne lui est pas accessible. On encode le stem en WAV cote
  // client, on le depose ici temporairement, et l'editeur le recupere
  // via une vraie URL HTTP de meme origine — voir routes/audio-editor.ts.
  audioEditorStaging: {
    dir: process.env.AUDIO_EDITOR_STAGING_DIR || path.join(__dirname, '../../temp/audio-editor-staging'),
    ttlMs: 5 * 60 * 1000, // purge automatique 5 min apres depot — l'editeur
    // recupere le fichier presque immediatement a l'ouverture, pas besoin
    // de le garder plus longtemps.
  },

  // Training datasets (inside ACE-Step-1.5 so Gradio can access them)
  datasets: {
    dir: process.env.DATASETS_DIR || path.join(__dirname, '../../../ACE-Step-1.5/datasets'),
    uploadsDir: process.env.DATASETS_UPLOADS_DIR || path.join(__dirname, '../../../ACE-Step-1.5/datasets/uploads'),
  },

  // Simplified JWT (for local session, not critical security)
  jwt: {
    secret: process.env.JWT_SECRET || 'ace-step-ui-local-secret',
    expiresIn: '365d', // Long-lived for local app
  },
};
