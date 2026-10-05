// services/dataset-paths.ts
//
// Un dataset (JSON) copie d'une autre installation, d'une autre machine, ou dont
// le dossier a ete renomme, contient des chemins audio absolus perimes
// ("audio_path"). Consequences : Gradio refuse de servir l'apercu audio
// (InvalidPathError : fichier hors du dossier courant et de temp), et le script
// de pretraitement ne trouve pas les fichiers.
//
// healDatasetAudioPaths() retrouve les fichiers deplaces et corrige les chemins
// DANS le JSON :
//   1. meme position relative sous le dossier datasets de CETTE installation
//      (.../datasets/uploads/<nom>/x.mp3 -> <datasetsDir>/uploads/<nom>/x.mp3) ;
//   2. a defaut, meme nom de fichier sous <uploadsDir>/<nom du dataset>/.
// Les chemins Windows (C:\\...\\datasets\\uploads\\...) copies sur Linux, et
// inversement, sont geres. Un chemin sans correspondance est laisse tel quel.
//
// Securite : seuls les JSON situes sous datasetsDir sont lus et ecrits, et un
// chemin de remplacement n'est accepte que s'il est sous datasetsDir (un JSON
// importe ne peut pas faire pointer l'aperçu vers un fichier quelconque via « .. »).
// Une sauvegarde du JSON d'origine est ecrite une seule fois (<fichier>.bak-paths).

import { existsSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import path from 'path';

export interface DatasetPathOptions {
  /** Dossier datasets de CETTE installation (.../ACE-Step-1.5/datasets). */
  datasetsDir: string;
  /** Dossier des audios importes (.../datasets/uploads). */
  uploadsDir: string;
  /** Dossier depuis lequel le moteur resout les chemins relatifs (.../ACE-Step-1.5). */
  baseDir: string;
}

export interface HealResult {
  total: number;
  missing: number;
  repaired: number;
  unresolved: number;
  backupPath?: string;
  error?: string;
}

const toPosix = (p: string): string => p.replace(/\\/g, '/');

function isInside(candidate: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function candidatesFor(audioPath: string, datasetName: string, opts: DatasetPathOptions): string[] {
  const posix = toPosix(audioPath);
  const withLead = posix.startsWith('/') ? posix : '/' + posix;
  const out: string[] = [];
  const marker = '/datasets/';
  const at = withLead.lastIndexOf(marker);
  if (at !== -1) {
    out.push(path.join(opts.datasetsDir, ...withLead.slice(at + marker.length).split('/')));
  }
  const base = posix.split('/').pop() ?? '';
  if (base) out.push(path.join(opts.uploadsDir, datasetName, base));
  return out;
}

export async function healDatasetAudioPaths(jsonPath: string, opts: DatasetPathOptions): Promise<HealResult> {
  const result: HealResult = { total: 0, missing: 0, repaired: 0, unresolved: 0 };

  // Seuls les datasets de cette installation sont concernes.
  if (!isInside(jsonPath, opts.datasetsDir)) return result;

  let raw: string;
  try {
    raw = await readFile(jsonPath, 'utf-8');
  } catch {
    return result; // fichier absent : le chargement le signalera lui-meme
  }
  let dataset: any;
  try {
    dataset = JSON.parse(raw);
  } catch {
    return result;
  }
  if (!dataset || !Array.isArray(dataset.samples)) return result;

  const datasetName = String(dataset.metadata?.name || path.basename(jsonPath, path.extname(jsonPath)));
  result.total = dataset.samples.length;

  let changed = false;
  for (const sample of dataset.samples) {
    const original = sample?.audio_path;
    if (typeof original !== 'string' || !original) continue;
    const resolved = path.isAbsolute(original) ? original : path.resolve(opts.baseDir, original);
    if (existsSync(resolved)) continue;

    result.missing++;
    const found = candidatesFor(original, datasetName, opts).find(
      (candidate) => isInside(candidate, opts.datasetsDir) && existsSync(candidate),
    );
    if (found) {
      sample.audio_path = found;
      result.repaired++;
      changed = true;
    } else {
      result.unresolved++;
    }
  }
  if (!changed) return result;

  try {
    const backup = `${jsonPath}.bak-paths`;
    if (!existsSync(backup)) await writeFile(backup, raw, 'utf-8');
    result.backupPath = backup;
    await writeFile(jsonPath, JSON.stringify(dataset, null, 2), 'utf-8');
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    result.repaired = 0;
  }
  return result;
}
