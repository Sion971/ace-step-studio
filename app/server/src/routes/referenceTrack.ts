import { Router, Response } from 'express';
import multer from 'multer';
import path from 'path';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import { pool } from '../db/pool.js';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';
import { getStorageProvider } from '../services/storage/factory.js';
import { withAnalysis } from '../services/track-analysis.js';
import { findWhisperExecutable, transcribeWithWhisper } from '../services/whisper.js';
import { coverKeyFor, extractEmbeddedCover } from '../services/audio-cover.js';

const router = Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AUDIO_DIR = path.join(__dirname, '../../public/audio');

const coverUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!/^image\/(jpeg|png|webp)$/.test(file.mimetype)) { cb(new Error('Only JPEG/PNG/WEBP images are allowed')); return; }
    cb(null, true);
  },
});

/** The URL of an import's cover, or '' when it has none. */
function coverUrlOf(coverKey: string | null | undefined): string {
  return coverKey ? getStorageProvider().getPublicUrl(coverKey) : '';
}

/** Takes out the picture embedded in an import's file and records it ('' when there is none, so it is looked for once). */
async function attachEmbeddedCover(trackId: string, storageKey: string, data: Buffer): Promise<string> {
  const jpeg = await extractEmbeddedCover(data, path.extname(storageKey));
  let coverKey = '';
  if (jpeg) {
    coverKey = coverKeyFor(storageKey);
    await getStorageProvider().upload(coverKey, jpeg, 'image/jpeg');
  }
  await pool.query('UPDATE reference_tracks SET cover_key = $1 WHERE id = $2', [coverKey, trackId]);
  return coverKey;
}

// Imports made before covers were read: their pictures are taken out in the background, one at a time, once per server run.
const coverBackfill = new Set<string>();
async function backfillCovers(rows: { id: string; storage_key: string }[]): Promise<void> {
  for (const row of rows) {
    if (coverBackfill.has(row.id)) continue;
    coverBackfill.add(row.id);
    try {
      const data = await fs.readFile(path.join(AUDIO_DIR, row.storage_key));
      await attachEmbeddedCover(row.id, row.storage_key, data);
    } catch {
      // A file not on local disk (another storage) or unreadable: looked once, left without a cover.
      await pool.query("UPDATE reference_tracks SET cover_key = '' WHERE id = $1", [row.id]).catch(() => {});
    }
  }
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
  fileFilter: (_req, file, cb) => {
    const allowedTypes = [
      'audio/mpeg',
      'audio/wav',
      'audio/flac',
      'audio/mp3',
      'audio/x-wav',
      'audio/x-flac',
      'audio/mp4',
      'audio/x-m4a',
      'audio/aac',
      'video/mp4',
      // Format natif du navigateur pour MediaRecorder (voir VoiceRecorder.tsx
      // — enregistrement direct au micro). Opus/webm est un format audio
      // legitime et courant, pas un cas limite a exclure.
      'audio/webm',
    ];
    if (allowedTypes.includes(file.mimetype) || file.mimetype.startsWith('audio/webm') || file.originalname.match(/\.(mp3|wav|flac|m4a|mp4|webm)$/i)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only MP3, WAV, FLAC, M4A, and MP4 are allowed.'));
    }
  }
});

// Get user's reference tracks
router.get('/', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT id, filename, storage_key, duration, file_size_bytes, tags, created_at, analysis, cover_key
       FROM reference_tracks
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [req.user!.id]
    );

    const storage = getStorageProvider();
    const tracks = result.rows.map(row => ({
      ...withAnalysis(row),
      audio_url: storage.getPublicUrl(row.storage_key),
      cover_url: coverUrlOf(row.cover_key),
    }));

    res.json({ tracks });
    const unchecked = result.rows.filter(row => row.cover_key === null || row.cover_key === undefined);
    if (unchecked.length) backfillCovers(unchecked).catch(() => {});
  } catch (error) {
    console.error('Get reference tracks error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Upload a new reference track
router.post('/', authMiddleware, upload.single('audio'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }

    const userId = req.user!.id;
    // Multer decodes originalname as latin1; re-decode as UTF-8 for Cyrillic support
    const originalFilename = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    const ext = path.extname(originalFilename) || '.mp3';
    const timestamp = Date.now();
    const key = `reference-tracks/${userId}/${timestamp}${ext}`;

    const storage = getStorageProvider();
    await storage.upload(key, req.file.buffer, req.file.mimetype);
    const audioUrl = storage.getPublicUrl(key);
    const whisperAvailable = Boolean(await findWhisperExecutable());

    // Parse tags from request body if provided
    const tags = req.body.tags ? JSON.parse(req.body.tags) : null;

    const result = await pool.query(
      `INSERT INTO reference_tracks (user_id, filename, storage_key, file_size_bytes, tags)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [userId, originalFilename, key, req.file.size, tags]
    );

    // The picture embedded in the file (an MP3's cover) becomes the import's cover.
    const coverKey = await attachEmbeddedCover(result.rows[0].id, key, req.file.buffer).catch(() => '');

    res.status(201).json({
      track: {
        ...result.rows[0],
        cover_key: coverKey,
        audio_url: audioUrl,
        cover_url: coverUrlOf(coverKey),
      },
      whisper_available: whisperAvailable
    });
  } catch (error) {
    console.error('Upload reference track error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: 'Failed to upload reference track', details: errorMessage });
  }
});

// Set the cover of an import from the cover window (an uploaded picture or one made by the AI).
router.post('/:id/cover', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  coverUpload.single('cover')(req, res, async (err: any) => {
    if (err) {
      res.status(err?.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err?.message || 'Upload failed' });
      return;
    }
    try {
      const check = await pool.query('SELECT user_id, storage_key, cover_key FROM reference_tracks WHERE id = $1', [req.params.id]);
      if (check.rows.length === 0) { res.status(404).json({ error: 'Track not found' }); return; }
      if (check.rows[0].user_id !== req.user!.id) { res.status(403).json({ error: 'Access denied' }); return; }
      if (!req.file?.buffer?.length) { res.status(400).json({ error: 'Empty cover upload' }); return; }
      const ext = req.file.mimetype === 'image/png' ? '.png' : req.file.mimetype === 'image/webp' ? '.webp' : '.jpg';
      const coverKey = coverKeyFor(check.rows[0].storage_key, ext);
      const storage = getStorageProvider();
      await storage.upload(coverKey, req.file.buffer, req.file.mimetype);
      const previous: string | null = check.rows[0].cover_key || null;
      if (previous && previous !== coverKey) await storage.delete(previous).catch(() => {});
      await pool.query('UPDATE reference_tracks SET cover_key = $1 WHERE id = $2', [coverKey, req.params.id]);
      res.json({ coverUrl: coverUrlOf(coverKey) });
    } catch (error) {
      console.error('Set reference track cover error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
});

// Update reference track (duration, tags)
router.patch('/:id', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    // Verify ownership
    const check = await pool.query(
      'SELECT user_id FROM reference_tracks WHERE id = $1',
      [req.params.id]
    );
    if (check.rows.length === 0) {
      res.status(404).json({ error: 'Track not found' });
      return;
    }
    if (check.rows[0].user_id !== req.user!.id) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const { duration, tags } = req.body;
    const updates: string[] = [];
    const values: unknown[] = [];
    let paramCount = 1;

    if (duration !== undefined) {
      updates.push(`duration = $${paramCount}`);
      values.push(duration);
      paramCount++;
    }
    if (tags !== undefined) {
      updates.push(`tags = $${paramCount}`);
      values.push(tags);
      paramCount++;
    }

    if (updates.length === 0) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }

    values.push(req.params.id);
    const result = await pool.query(
      `UPDATE reference_tracks SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );

    const storage = getStorageProvider();
    res.json({
      track: {
        ...result.rows[0],
        audio_url: storage.getPublicUrl(result.rows[0].storage_key)
      }
    });
  } catch (error) {
    console.error('Update reference track error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Transcribe a reference track with whisper (if available)
router.post('/:id/transcribe', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const whisperCmd = await findWhisperExecutable();
    if (!whisperCmd) {
      res.status(404).json({ error: 'Whisper not available' });
      return;
    }

    const result = await pool.query(
      'SELECT user_id, filename, storage_key FROM reference_tracks WHERE id = $1',
      [req.params.id]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Track not found' });
      return;
    }
    if (result.rows[0].user_id !== req.user!.id) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const audioPath = path.join(AUDIO_DIR, result.rows[0].storage_key);
    const buffer = await fs.readFile(audioPath);
    const controller = new AbortController();

    req.on('close', () => controller.abort());

    const lyrics = await transcribeWithWhisper(buffer, result.rows[0].filename, controller.signal);
    if (controller.signal.aborted) return;

    res.json({ lyrics: lyrics || '' });
  } catch (error) {
    console.error('Transcribe reference track error:', error);
    res.status(500).json({ error: 'Failed to transcribe' });
  }
});

// Delete a reference track
router.delete('/:id', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    // Verify ownership
    const check = await pool.query(
      'SELECT user_id, storage_key, cover_key FROM reference_tracks WHERE id = $1',
      [req.params.id]
    );
    if (check.rows.length === 0) {
      res.status(404).json({ error: 'Track not found' });
      return;
    }
    if (check.rows[0].user_id !== req.user!.id) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    // Delete from storage
    const storage = getStorageProvider();
    if (check.rows[0].cover_key) await storage.delete(check.rows[0].cover_key).catch(() => {});
    try {
      await storage.delete(check.rows[0].storage_key);
    } catch (storageError) {
      console.error('Failed to delete from storage:', storageError);
    }

    // Delete from database
    await pool.query('DELETE FROM reference_tracks WHERE id = $1', [req.params.id]);

    res.json({ success: true });
  } catch (error) {
    console.error('Delete reference track error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
