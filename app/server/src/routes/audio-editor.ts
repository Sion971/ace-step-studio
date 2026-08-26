// routes/audio-editor.ts
//
// Depot temporaire d'un fichier audio, pour que l'editeur AudioMass (page
// SEPAREE, voir SongDropdownMenu.tsx -> onEditAudio) puisse le charger via
// une vraie URL HTTP (?audioUrl=...) plutot qu'une URL blob: qui ne serait
// valide que dans la page React d'origine.
//
// Concu specifiquement pour les stems Demucs, qui n'existent qu'en memoire
// cote navigateur (Float32Array) — jamais de fichier serveur reel avant
// ce depot. Le fichier est purge automatiquement apres un delai court
// (voir config.audioEditorStaging.ttlMs) : l'editeur le recupere presque
// immediatement a l'ouverture, pas besoin de le conserver plus longtemps.

import { Router, Request, Response } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { mkdirSync, unlink, existsSync } from 'fs';
import path from 'path';
import { config } from '../config/index.js';

const router = Router();

try {
  mkdirSync(config.audioEditorStaging.dir, { recursive: true });
} catch {
  // Dossier deja present
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, config.audioEditorStaging.dir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.wav';
    cb(null, `${uuidv4()}${ext}`);
  },
});

// Meme limite que /api/midi/convert : un WAV PCM brut non compresse pour
// un morceau de plusieurs minutes en stereo 44100 Hz 16 bits pese
// facilement plus de 100 Mo.
const upload = multer({ storage, limits: { fileSize: 250 * 1024 * 1024 } });

router.post('/stage', upload.single('audio'), (req: Request, res: Response) => {
  if (!req.file) {
    res.status(400).json({ error: 'Aucun fichier audio recu (champ "audio" attendu).' });
    return;
  }

  const filename = req.file.filename;
  const filePath = path.join(config.audioEditorStaging.dir, filename);

  // Purge automatique — l'editeur recupere le fichier des son ouverture,
  // ce delai est une marge de securite, pas un delai d'attente normal.
  setTimeout(() => {
    if (existsSync(filePath)) {
      unlink(filePath, (err) => {
        if (err) console.error('[audio-editor] Failed to purge staged file:', err);
      });
    }
  }, config.audioEditorStaging.ttlMs);

  res.json({ url: `/audio-editor-staged/${filename}` });
});

export default router;
