// routes/studio-projects.ts
//
// Projets de l'onglet Studio : la session de l'editeur multipiste (pistes, clips,
// volumes, panoramiques, fondus, marqueurs... format .amss d'AudioMass) rangee
// cote serveur, par utilisateur, pour pouvoir la rouvrir plus tard. Sans cela
// "Enregistrer la session" de l'editeur ne fait que telecharger un fichier dans le
// navigateur, que l'on ne retrouve pas.
//
// Dossier : <data>/studio-projects/<userId>/<id>.amss + <id>.json (nom, date).

import { Router, Response } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { mkdirSync, existsSync } from 'fs';
import { readdir, readFile, writeFile, rename, unlink, stat } from 'fs/promises';
import path from 'path';
import { config } from '../config/index.js';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';

const router = Router();

export const PROJECTS_DIR = process.env.STUDIO_PROJECTS_DIR || path.join(path.dirname(config.database.path), 'studio-projects');
// Audio brut en flottants 32 bits : un morceau en plusieurs pistes pese vite plusieurs centaines de Mo.
const MAX_BYTES = 1024 * 1024 * 1024;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ProjectMeta {
  id: string;
  name: string;
  size: number;
  updatedAt: string;
}

/** The folder of a user. The id comes from the token, but it is checked anyway: it becomes part of a path. */
export function userDir(userId: string): string {
  if (!/^[\w-]+$/.test(userId)) throw new Error('invalid user id');
  return path.join(PROJECTS_DIR, userId);
}

export function cleanName(raw: unknown): string {
  const name = String(raw ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 80);
  return name || 'Projet';
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      try {
        const dir = userDir((req as AuthenticatedRequest).user!.id);
        mkdirSync(dir, { recursive: true });
        cb(null, dir);
      } catch (e) {
        cb(e as Error, '');
      }
    },
    filename: (_req, _file, cb) => cb(null, `.upload-${uuidv4()}.tmp`),
  }),
  limits: { fileSize: MAX_BYTES },
});

async function readMeta(dir: string, id: string): Promise<ProjectMeta | null> {
  try {
    const meta = JSON.parse(await readFile(path.join(dir, `${id}.json`), 'utf-8'));
    const st = await stat(path.join(dir, `${id}.amss`));
    return { id, name: String(meta.name || 'Projet'), size: st.size, updatedAt: String(meta.updatedAt || st.mtime.toISOString()) };
  } catch {
    return null;
  }
}

router.get('/', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const dir = userDir(req.user!.id);
    const files = existsSync(dir) ? await readdir(dir) : [];
    const list: ProjectMeta[] = [];
    for (const f of files) {
      const m = /^(.+)\.amss$/.exec(f);
      if (!m || !ID_RE.test(m[1])) continue;
      const meta = await readMeta(dir, m[1]);
      if (meta) list.push(meta);
    }
    list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    res.json({ projects: list });
  } catch (error) {
    console.error('List studio projects error:', error);
    res.status(500).json({ error: 'Failed to list projects' });
  }
});

// Create a project, or replace one (field "id"). The file is in the field "project", the name in "name".
router.post('/', authMiddleware, upload.single('project'), async (req: AuthenticatedRequest, res: Response) => {
  const tmp = req.file?.path;
  try {
    if (!req.file || !tmp) {
      res.status(400).json({ error: 'No project file received (field "project" expected).' });
      return;
    }
    const dir = userDir(req.user!.id);
    const asked = typeof req.body?.id === 'string' ? req.body.id : '';
    let id = uuidv4();
    if (asked) {
      if (!ID_RE.test(asked) || !existsSync(path.join(dir, `${asked}.amss`))) {
        await unlink(tmp).catch(() => {});
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      id = asked;
    }
    const previous = asked ? await readMeta(dir, id) : null;
    const name = req.body?.name ? cleanName(req.body.name) : previous?.name || 'Projet';
    await rename(tmp, path.join(dir, `${id}.amss`));
    const updatedAt = new Date().toISOString();
    await writeFile(path.join(dir, `${id}.json`), JSON.stringify({ name, updatedAt }), 'utf-8');
    const meta = await readMeta(dir, id);
    res.status(asked ? 200 : 201).json({ project: meta });
  } catch (error) {
    if (tmp) await unlink(tmp).catch(() => {});
    console.error('Save studio project error:', error);
    res.status(500).json({ error: 'Failed to save project' });
  }
});

router.get('/:id/file', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = String(req.params.id);
    if (!ID_RE.test(id)) { res.status(404).json({ error: 'Project not found' }); return; }
    const file = path.join(userDir(req.user!.id), `${id}.amss`);
    if (!existsSync(file)) { res.status(404).json({ error: 'Project not found' }); return; }
    res.type('application/octet-stream').sendFile(file);
  } catch (error) {
    console.error('Read studio project error:', error);
    res.status(500).json({ error: 'Failed to read project' });
  }
});

router.delete('/:id', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = String(req.params.id);
    if (!ID_RE.test(id)) { res.status(404).json({ error: 'Project not found' }); return; }
    const dir = userDir(req.user!.id);
    if (!existsSync(path.join(dir, `${id}.amss`))) { res.status(404).json({ error: 'Project not found' }); return; }
    await unlink(path.join(dir, `${id}.amss`));
    await unlink(path.join(dir, `${id}.json`)).catch(() => {});
    res.json({ success: true });
  } catch (error) {
    console.error('Delete studio project error:', error);
    res.status(500).json({ error: 'Failed to delete project' });
  }
});

export default router;
