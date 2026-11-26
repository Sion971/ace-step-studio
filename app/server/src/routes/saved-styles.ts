// routes/saved-styles.ts
//
// "My styles": styles the user liked and saved (from the Style box of the Create tab, or from a song's details), to put
// back in the Style box later. Kept in the database, per user, like songs and playlists: they survive a browser cleared
// or another computer.
//
// The same text saved twice is one style: saving it again moves it back to the top of the list (and renames it if a
// name is given).

import { Router, Response } from 'express';
import { randomUUID } from 'crypto';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';

export interface SavedStyle {
  id: string;
  name: string;
  style: string;
  created_at: string;
  updated_at: string;
}

/** Where the styles are kept: the database by default, something else in the tests. */
export interface SavedStylesStore {
  list(userId: string): Promise<SavedStyle[]>;
  findByStyle(userId: string, style: string): Promise<SavedStyle | null>;
  insert(userId: string, row: { id: string; name: string; style: string }): Promise<SavedStyle>;
  touch(userId: string, id: string, name?: string): Promise<SavedStyle | null>;
  rename(userId: string, id: string, name: string): Promise<SavedStyle | null>;
  remove(userId: string, id: string): Promise<boolean>;
}

export const MAX_STYLE = 2000;
export const MAX_NAME = 80;

const oneLine = (raw: unknown, max: number) =>
  String(raw ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** The text kept: trimmed, without control characters, at most MAX_STYLE characters ('' when there is nothing). */
export const cleanStyle = (raw: unknown): string =>
  String(raw ?? '').replace(/[\u0000-\u0009\u000b-\u001f]/g, ' ').trim().slice(0, MAX_STYLE);

/** The name: the one given, else the start of the style ("ethereal synth, electronic synth…"). */
export function nameFor(rawName: unknown, style: string): string {
  const given = oneLine(rawName, MAX_NAME);
  if (given) return given;
  const flat = oneLine(style, 400);
  return flat.length > 40 ? `${flat.slice(0, 40).trimEnd()}…` : flat;
}

// The pool turns $1, $2... into "?" in the order they appear, not by number: in every query below they appear in order.
// Times to the millisecond, so that a style saved again in the same second still moves to the top.
const NOW = "strftime('%Y-%m-%d %H:%M:%f', 'now')";

// The database, imported when first used (so that the tests, which give their own store, never open it).
const sqlStore: SavedStylesStore = {
  async list(userId) {
    const { pool } = await import('../db/pool.js');
    return (await pool.query('SELECT id, name, style, created_at, updated_at FROM saved_styles WHERE user_id = $1 ORDER BY updated_at DESC, created_at DESC', [userId])).rows;
  },
  async findByStyle(userId, style) {
    const { pool } = await import('../db/pool.js');
    return (await pool.query('SELECT id, name, style, created_at, updated_at FROM saved_styles WHERE user_id = $1 AND style = $2', [userId, style])).rows[0] ?? null;
  },
  async insert(userId, row) {
    const { pool } = await import('../db/pool.js');
    return (await pool.query(
      `INSERT INTO saved_styles (id, user_id, name, style, created_at, updated_at)
       VALUES ($1, $2, $3, $4, ${NOW}, ${NOW})
       RETURNING id, name, style, created_at, updated_at`,
      [row.id, userId, row.name, row.style],
    )).rows[0];
  },
  async touch(userId, id, name) {
    const { pool } = await import('../db/pool.js');
    return (await pool.query(
      `UPDATE saved_styles SET updated_at = ${NOW}, name = COALESCE($1, name)
       WHERE id = $2 AND user_id = $3 RETURNING id, name, style, created_at, updated_at`,
      [name ?? null, id, userId],
    )).rows[0] ?? null;
  },
  async rename(userId, id, name) {
    const { pool } = await import('../db/pool.js');
    return (await pool.query(
      'UPDATE saved_styles SET name = $1 WHERE id = $2 AND user_id = $3 RETURNING id, name, style, created_at, updated_at',
      [name, id, userId],
    )).rows[0] ?? null;
  },
  async remove(userId, id) {
    const { pool } = await import('../db/pool.js');
    return (await pool.query('DELETE FROM saved_styles WHERE id = $1 AND user_id = $2', [id, userId])).rowCount > 0;
  },
};

export function createSavedStylesRouter(store: SavedStylesStore = sqlStore): Router {
  const router = Router();

  router.get('/', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
    try {
      res.json({ styles: await store.list(req.user!.id) });
    } catch (error) {
      console.error('List saved styles error:', error);
      res.status(500).json({ error: 'Failed to list the saved styles' });
    }
  });

  // { style, name? }: 201 with the new style, or 200 with the one that had the same text (moved back to the top).
  router.post('/', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const style = cleanStyle(req.body?.style);
      if (!style) {
        res.status(400).json({ error: 'The style is empty' });
        return;
      }
      const userId = req.user!.id;
      const givenName = oneLine(req.body?.name, MAX_NAME) || undefined;
      const existing = await store.findByStyle(userId, style);
      if (existing) {
        res.json({ style: await store.touch(userId, existing.id, givenName), existed: true });
        return;
      }
      const saved = await store.insert(userId, { id: randomUUID(), name: nameFor(givenName, style), style });
      res.status(201).json({ style: saved, existed: false });
    } catch (error) {
      console.error('Save style error:', error);
      res.status(500).json({ error: 'Failed to save the style' });
    }
  });

  router.patch('/:id', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const name = oneLine(req.body?.name, MAX_NAME);
      if (!name) {
        res.status(400).json({ error: 'The name is empty' });
        return;
      }
      const renamed = await store.rename(req.user!.id, req.params.id, name);
      if (!renamed) {
        res.status(404).json({ error: 'Style not found' });
        return;
      }
      res.json({ style: renamed });
    } catch (error) {
      console.error('Rename style error:', error);
      res.status(500).json({ error: 'Failed to rename the style' });
    }
  });

  router.delete('/:id', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!(await store.remove(req.user!.id, req.params.id))) {
        res.status(404).json({ error: 'Style not found' });
        return;
      }
      res.json({ success: true });
    } catch (error) {
      console.error('Delete style error:', error);
      res.status(500).json({ error: 'Failed to delete the style' });
    }
  });

  return router;
}

export default createSavedStylesRouter();
