// routes/midi.ts
//
// Conversion audio -> MIDI via basic-pitch, dans son venv Python ISOLE
// (voir config.basicPitch, distinct de config.pipeline qui gere ACE-Step
// lui-meme). Appel PONCTUEL — spawn, attente, resultat, fin — pas de
// processus persistant a gerer contrairement a pipeline-manager.ts.
//
// Remplace la tentative precedente (conversion dans le navigateur via
// TensorFlow.js), abandonnee suite a l'echec de compilation de shader
// WebGL sur cette configuration : le repli CPU en JavaScript prenait
// plus de 50 minutes pour 19 secondes de musique. L'inference native
// via ONNX cote serveur devrait etre nettement plus rapide.

import { Router, Request, Response } from 'express';
import multer from 'multer';
import { spawn } from 'child_process';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';
import { config } from '../config/index.js';

const router = Router();

// Fichier temporaire en memoire, jamais ecrit sur disque avant qu'on le
// place nous-memes dans un dossier temporaire dedie — evite de polluer un
// dossier d'upload partage avec des fichiers ephemeres.
// 50 Mo etait insuffisant : un WAV PCM brut non compresse pour un morceau
// de 5 minutes en stereo 44100 Hz 16 bits pese deja ~107 Mo (duree_s *
// 44100 * 2 canaux * 2 octets). 250 Mo couvre confortablement un morceau
// de ~10 minutes, largement au-dela de ce que produit une generation.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 250 * 1024 * 1024 } });

interface ConvertResult {
  success: boolean;
  noteCount?: number;
  elapsedSeconds?: number;
  outputPath?: string;
  warning?: string;
  error?: string;
}

/** Lance le script Python dans le venv isole, avec timeout. Retourne le
 *  JSON qu'il ecrit sur stdout (voir basic_pitch_convert.py — contrat
 *  strict, une seule ligne JSON, jamais du texte libre). */
function runConversion(inputPath: string, outputPath: string): Promise<ConvertResult> {
  return new Promise((resolve, reject) => {
    if (!existsSync(config.basicPitch.pythonPath)) {
      reject(new Error(
        `Environnement basic-pitch introuvable : ${config.basicPitch.pythonPath}. ` +
        `Lance setup-basic-pitch-venv.sh depuis app/server/ avant d'utiliser cette fonctionnalite.`
      ));
      return;
    }

    const proc = spawn(config.basicPitch.pythonPath, [config.basicPitch.scriptPath, inputPath, outputPath], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    // stderr = progression/diagnostic (voir le script), on le relaie tel
    // quel dans les logs serveur sans bloquer sur son contenu.
    proc.stderr.on('data', (chunk) => { console.log(`[basic-pitch] ${chunk.toString().trim()}`); });

    const timeout = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`Conversion interrompue apres ${config.basicPitch.timeoutMs / 1000}s (timeout).`));
    }, config.basicPitch.timeoutMs);

    proc.on('close', () => {
      clearTimeout(timeout);
      const line = stdout.trim().split('\n').pop() || '';
      try {
        resolve(JSON.parse(line) as ConvertResult);
      } catch {
        reject(new Error(`Sortie inattendue du script de conversion : ${stdout.slice(0, 500)}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

router.post('/convert', upload.single('audio'), async (req: Request, res: Response) => {
  if (!req.file) {
    res.status(400).json({ error: 'Aucun fichier audio recu (champ "audio" attendu).' });
    return;
  }

  // Dossier temporaire dedie a CETTE requete — nettoye systematiquement
  // en fin de traitement (succes ou echec), jamais laisse trainer.
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'basic-pitch-'));
  const inputPath = path.join(tmpDir, 'input' + path.extname(req.file.originalname || '.wav'));
  const outputPath = path.join(tmpDir, 'output.mid');

  try {
    const fs = await import('fs/promises');
    await fs.writeFile(inputPath, req.file.buffer);

    const result = await runConversion(inputPath, outputPath);

    if (!result.success) {
      res.status(500).json({ error: result.error || 'Echec de la conversion, raison inconnue.' });
      return;
    }

    if (result.noteCount === 0) {
      res.status(200).json({ warning: result.warning, noteCount: 0 });
      return;
    }

    if (!existsSync(outputPath)) {
      res.status(500).json({ error: 'Le script a rapporte un succes mais le fichier MIDI est introuvable.' });
      return;
    }

    res.setHeader('Content-Type', 'audio/midi');
    res.setHeader('Content-Disposition', 'attachment; filename="conversion.mid"');
    res.sendFile(outputPath, (err) => {
      // Nettoyage APRES l'envoi effectif du fichier, pas avant — sinon
      // sendFile echouerait a lire un fichier deja supprime.
      rmSync(tmpDir, { recursive: true, force: true });
      if (err) console.error('[basic-pitch] Erreur envoi fichier MIDI:', err);
    });
  } catch (error) {
    rmSync(tmpDir, { recursive: true, force: true });
    console.error('[basic-pitch] Conversion error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Erreur interne.' });
  }
});

export default router;
