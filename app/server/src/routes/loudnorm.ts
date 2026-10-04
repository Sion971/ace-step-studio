// routes/loudnorm.ts
//
// Normalisation de loudness (LUFS) via le filtre loudnorm de ffmpeg, en
// DEUX passes pour un resultat precis : une premiere passe mesure les
// vraies caracteristiques du fichier (loudnorm ne peut pas bien corriger
// sans les avoir mesurees au prealable), la seconde applique la
// correction avec ces valeurs mesurees plutot que des estimations.
// Nettement plus fidele qu'une normalisation en une seule passe.
//
// Cibles par plateforme (LUFS integre / crete vraie dBTP), confirmees
// via plusieurs sources independantes recentes (2026) :
//   Spotify -14/-1.0, Apple Music -16/-1.0, YouTube -14/-1.0,
//   Tidal -14/-1.0, Amazon Music -14/-2.0, Deezer -15/-1.0

import { Router, Request, Response } from 'express';
import multer from 'multer';
import { spawn } from 'child_process';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';

const router = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 250 * 1024 * 1024 } });

interface LoudnormMeasurement {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
}

/** Lance ffmpeg et capture sa sortie stderr complete — c'est la ou
 *  loudnorm ecrit a la fois sa progression ET, en fin de passe
 *  d'analyse, le bloc JSON mesure (ffmpeg n'ecrit jamais de donnees
 *  sur stdout pour un filtre audio, seulement le flux encode lui-meme
 *  si une sortie fichier est demandee). */
function runFfmpeg(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg a echoue (code ${code}) : ${stderr.slice(-800)}`));
        return;
      }
      resolve(stderr);
    });
    proc.on('error', reject);
  });
}

/** Extrait le bloc JSON que loudnorm ecrit en fin de passe d'analyse —
 *  entoure d'autres lignes de log ffmpeg, jamais seul sur stderr. */
function extractLoudnormJson(stderr: string): LoudnormMeasurement {
  const start = stderr.lastIndexOf('{');
  const end = stderr.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('Impossible de lire les mesures loudnorm dans la sortie ffmpeg.');
  }
  return JSON.parse(stderr.slice(start, end + 1));
}

router.post('/normalize', upload.single('audio'), async (req: Request, res: Response) => {
  if (!req.file) {
    res.status(400).json({ error: 'Aucun fichier audio recu (champ "audio" attendu).' });
    return;
  }

  const targetI = parseFloat(req.body?.targetI) || -14;
  const targetTP = parseFloat(req.body?.targetTP) || -1.0;
  const targetLRA = parseFloat(req.body?.targetLRA) || 11;

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'loudnorm-'));
  const inputPath = path.join(tmpDir, 'input' + path.extname(req.file.originalname || '.wav'));
  const outputPath = path.join(tmpDir, 'output.wav');

  try {
    const fs = await import('fs/promises');
    await fs.writeFile(inputPath, req.file.buffer);

    // Passe 1 : mesure, aucun fichier de sortie reel (-f null -).
    const analysisArgs = [
      '-i', inputPath,
      '-af', `loudnorm=I=${targetI}:TP=${targetTP}:LRA=${targetLRA}:print_format=json`,
      '-f', 'null', '-',
    ];
    const analysisOutput = await runFfmpeg(analysisArgs);
    const measured = extractLoudnormJson(analysisOutput);

    // Passe 2 : application, avec les valeurs reellement mesurees et
    // linear=true — une correction lineaire simple plutot qu'un
    // limiteur dynamique, coherente avec l'objectif de preserver le
    // caractere du mix plutot que de l'ecraser.
    const applyArgs = [
      '-i', inputPath,
      '-af', [
        `loudnorm=I=${targetI}:TP=${targetTP}:LRA=${targetLRA}`,
        `measured_I=${measured.input_i}`,
        `measured_TP=${measured.input_tp}`,
        `measured_LRA=${measured.input_lra}`,
        `measured_thresh=${measured.input_thresh}`,
        `offset=${measured.target_offset}`,
        'linear=true',
        'print_format=json',
      ].join(':'),
      '-ar', '48000',
      '-y', outputPath,
    ];
    await runFfmpeg(applyArgs);

    if (!existsSync(outputPath)) {
      res.status(500).json({ error: 'ffmpeg a termine sans erreur mais le fichier de sortie est introuvable.' });
      return;
    }

    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Content-Disposition', 'attachment; filename="normalized.wav"');
    res.sendFile(outputPath, (err) => {
      rmSync(tmpDir, { recursive: true, force: true });
      if (err) console.error('[loudnorm] Erreur envoi fichier:', err);
    });
  } catch (error) {
    rmSync(tmpDir, { recursive: true, force: true });
    console.error('[loudnorm] Normalization error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Erreur interne.' });
  }
});

export default router;
