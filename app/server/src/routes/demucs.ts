// routes/demucs.ts
//
// Separation de stems via Demucs, dans son venv Python ISOLE (voir
// config.demucs, distinct de config.pipeline et config.basicPitch).
// Appel PONCTUEL — spawn, attente, resultat, fin — meme principe que
// routes/midi.ts, mais produit PLUSIEURS fichiers (4 ou 6 stems) au lieu
// d'un seul : chaque stem est depose dans un dossier de staging dedie,
// servi en HTTP, plutot qu'envoye directement en reponse.
//
// Remplace la separation precedente, cote navigateur uniquement
// (demucs-web/, WASM) : fonctionnelle mais plafonnee par la RAM du poste
// client, en particulier pour le mode 6 stems (confirme a l'epoque comme
// un vrai blocage). L'inference Python native cote serveur n'a pas cette
// limite.

import { Router, Request, Response } from 'express';
import multer from 'multer';
import { spawn } from 'child_process';
import { existsSync, mkdtempSync, mkdirSync, renameSync, rmSync, readdirSync, statSync } from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import { config } from '../config/index.js';

const router = Router();

/** Purge les sous-dossiers de staging plus vieux que le TTL configure.
 *  Autonome (pas de dependance a un planificateur externe) — lance une
 *  fois au demarrage du serveur puis toutes les 10 minutes. */
function purgeExpiredStems(): void {
  if (!existsSync(config.demucsStaging.dir)) return;
  const now = Date.now();
  for (const entry of readdirSync(config.demucsStaging.dir)) {
    const entryPath = path.join(config.demucsStaging.dir, entry);
    try {
      const age = now - statSync(entryPath).mtimeMs;
      if (age > config.demucsStaging.ttlMs) {
        rmSync(entryPath, { recursive: true, force: true });
        console.log(`[demucs] Staging purge : ${entry} (age ${Math.round(age / 60000)} min)`);
      }
    } catch {
      // Dossier deja supprime entre-temps (purge concurrente) — ignore.
    }
  }
}

mkdirSync(config.demucsStaging.dir, { recursive: true });
purgeExpiredStems();
setInterval(purgeExpiredStems, 10 * 60 * 1000);

// Meme limite de taille et meme raisonnement que midi.ts : un WAV PCM
// brut non compresse pour un morceau de ~10 minutes en stereo 44100 Hz
// 16 bits pese ~214 Mo, 250 Mo couvre confortablement ce cas avec de la
// marge pour un format deja compresse (mp3/flac) plus long encore.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 250 * 1024 * 1024 } });

interface SeparateResult {
  success: boolean;
  model?: string;
  stems?: Record<string, string>;
  elapsedSeconds?: number;
  error?: string;
}

/** Lance le script Python dans le venv isole, avec timeout. Retourne le
 *  JSON qu'il ecrit sur stdout (voir demucs_separate.py — contrat
 *  strict, une seule ligne JSON, jamais du texte libre). */
function runSeparation(inputPath: string, outputDir: string, stemMode: '4' | '6'): Promise<SeparateResult> {
  return new Promise((resolve, reject) => {
    if (!existsSync(config.demucs.pythonPath)) {
      reject(new Error(
        `Environnement Demucs introuvable : ${config.demucs.pythonPath}. ` +
        `Lance setup-demucs-venv.sh depuis app/server/ avant d'utiliser cette fonctionnalite.`
      ));
      return;
    }

    const proc = spawn(config.demucs.pythonPath, [config.demucs.scriptPath, inputPath, outputDir, stemMode], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    // stderr = progression/diagnostic (voir le script), on le relaie tel
    // quel dans les logs serveur sans bloquer sur son contenu.
    proc.stderr.on('data', (chunk) => { console.log(`[demucs] ${chunk.toString().trim()}`); });

    const timeout = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`Separation interrompue apres ${config.demucs.timeoutMs / 1000}s (timeout).`));
    }, config.demucs.timeoutMs);

    proc.on('close', () => {
      clearTimeout(timeout);
      const line = stdout.trim().split('\n').pop() || '';
      try {
        resolve(JSON.parse(line) as SeparateResult);
      } catch {
        reject(new Error(`Sortie inattendue du script de separation : ${stdout.slice(0, 500)}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

router.post('/separate', upload.single('audio'), async (req: Request, res: Response) => {
  if (!req.file) {
    res.status(400).json({ error: 'Aucun fichier audio recu (champ "audio" attendu).' });
    return;
  }

  const stemMode = req.body?.stems === '6' ? '6' : '4';

  // Dossier temporaire dedie a CETTE requete pour le fichier d'entree et
  // la sortie brute de Demucs — nettoye systematiquement en fin de
  // traitement (succes ou echec). Distinct du dossier de staging final
  // (plus bas), qui lui doit survivre le temps que le navigateur
  // recupere chaque stem.
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'demucs-'));
  const inputPath = path.join(tmpDir, 'input' + path.extname(req.file.originalname || '.wav'));
  const rawOutputDir = path.join(tmpDir, 'stems');

  try {
    const fs = await import('fs/promises');
    await fs.writeFile(inputPath, req.file.buffer);

    const result = await runSeparation(inputPath, rawOutputDir, stemMode);

    if (!result.success || !result.stems) {
      res.status(500).json({ error: result.error || 'Echec de la separation, raison inconnue.' });
      return;
    }

    // Deplace les stems vers le dossier de staging public (purge
    // automatique par TTL, voir config.demucsStaging), sous un
    // identifiant unique par requete pour ne jamais collisionner avec
    // une autre separation en cours.
    const stagingId = randomUUID();
    const stagingDir = path.join(config.demucsStaging.dir, stagingId);
    mkdirSync(stagingDir, { recursive: true });

    const stemUrls: Record<string, string> = {};
    for (const [stemName, stemPath] of Object.entries(result.stems)) {
      const destPath = path.join(stagingDir, `${stemName}.wav`);
      renameSync(stemPath, destPath);
      stemUrls[stemName] = `/api/demucs/stems/${stagingId}/${stemName}.wav`;
    }

    res.json({
      success: true,
      model: result.model,
      elapsedSeconds: result.elapsedSeconds,
      stems: stemUrls,
    });
  } catch (error) {
    console.error('[demucs] Separation error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Erreur interne.' });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// GET /api/demucs/stems/:stagingId/:fileName — sert un stem depose en
// staging. Validation stricte du nom de fichier (pas de traversee de
// chemin possible via ".." ou un separateur) avant toute resolution de
// chemin disque.
router.get('/stems/:stagingId/:fileName', (req: Request, res: Response) => {
  const { stagingId, fileName } = req.params;
  if (!/^[a-f0-9-]+$/i.test(stagingId) || !/^[a-zA-Z0-9_-]+\.wav$/.test(fileName)) {
    res.status(400).json({ error: 'Identifiant ou nom de fichier invalide.' });
    return;
  }

  const filePath = path.join(config.demucsStaging.dir, stagingId, fileName);
  if (!existsSync(filePath)) {
    res.status(404).json({ error: 'Stem introuvable (peut-etre deja purge).' });
    return;
  }

  res.sendFile(filePath);
});

export default router;
