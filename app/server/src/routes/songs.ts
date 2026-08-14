import { Router, Response } from 'express';
import { Readable } from 'node:stream';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import { pool } from '../db/pool.js';
import { authMiddleware, optionalAuthMiddleware, AuthenticatedRequest } from '../middleware/auth.js';
import { getStorageProvider } from '../services/storage/factory.js';
import { updateMp3Cover } from '../services/id3-tagger.js';

// 10MB cap — Pollinations images at 2048×2048 jpeg are typically 200-600KB,
// even PNG of the same dimensions stays comfortably under 5MB.
const coverUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!/^image\/(jpeg|png|webp)$/.test(file.mimetype)) {
      cb(new Error('Only JPEG/PNG/WEBP images are allowed'));
      return;
    }
    cb(null, true);
  },
});

const router = Router();

// Helper: resolve audio URL (generates signed URL for S3)
async function resolveAudioUrl(audioUrl: string | null): Promise<string | null> {
  if (!audioUrl) return null;

  if (audioUrl.startsWith('s3://')) {
    const storageKey = audioUrl.replace('s3://', '');
    const storage = getStorageProvider();
    return storage.getUrl(storageKey, 3600); // 1 hour expiry
  }

  return audioUrl;
}

// Helper: resolve audio URL for direct playback
async function resolveAccessibleAudioUrl(audioUrl: string | null, isPublic: boolean): Promise<string | null> {
  if (!audioUrl) return null;
  if (audioUrl.startsWith('s3://')) {
    const storageKey = audioUrl.replace('s3://', '');
    const storage = getStorageProvider();
    return isPublic ? storage.getPublicUrl(storageKey) : storage.getUrl(storageKey, 3600);
  }
  return audioUrl;
}

// Get audio - proxies from S3 to avoid CORS issues
router.get('/:id/audio', optionalAuthMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT s.audio_url, s.is_public, s.user_id FROM songs s WHERE s.id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Song not found' });
      return;
    }

    const song = result.rows[0];

    if (!song.is_public && (!req.user || req.user.id !== song.user_id)) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const audioUrl = await resolveAudioUrl(song.audio_url);
    if (!audioUrl) {
      res.status(404).json({ error: 'Audio not available' });
      return;
    }

    // Local files - redirect
    if (audioUrl.startsWith('/')) {
      res.redirect(audioUrl);
      return;
    }

    // S3/remote - proxy to avoid CORS
    const range = req.headers.range;
    const audioRes = await fetch(audioUrl, {
      headers: range ? { Range: range } : undefined,
    });
    if (!audioRes.ok && audioRes.status !== 206) {
      res.status(502).json({ error: 'Failed to fetch audio' });
      return;
    }

    const contentType = audioRes.headers.get('content-type') || 'audio/mpeg';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Accept-Ranges', 'bytes');

    const contentLength = audioRes.headers.get('content-length');
    if (contentLength) {
      res.setHeader('Content-Length', contentLength);
    }

    const contentRange = audioRes.headers.get('content-range');
    if (contentRange) {
      res.status(206);
      res.setHeader('Content-Range', contentRange);
    }

    if (audioRes.body) {
      Readable.fromWeb(audioRes.body as any).pipe(res);
      return;
    }

    const arrayBuffer = await audioRes.arrayBuffer();
    res.send(Buffer.from(arrayBuffer));
  } catch (error) {
    console.error('Get audio error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get user's songs
router.get('/', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT s.id, s.title, s.lyrics, s.style, s.caption, s.cover_url, s.audio_url,
              s.duration, s.bpm, s.key_scale, s.time_signature, s.tags, s.is_public, 
              s.like_count, s.view_count, s.user_id, s.created_at, s.generation_params, s.dit_model, s.lm_model, s.lm_backend, s.generation_time, s.lrc_content, s.openrouter_model,
              COALESCE(u.username, 'Anonymous') as creator
       FROM songs s
       LEFT JOIN users u ON s.user_id = u.id
       WHERE s.user_id = $1
       ORDER BY s.created_at DESC`,
      [req.user!.id]
    );

    const songs = await Promise.all(
      result.rows.map(async (row) => ({
        ...row,
        audio_url: await resolveAccessibleAudioUrl(row.audio_url, row.is_public),
      }))
    );

    res.json({ songs });
  } catch (error) {
    console.error('Get songs error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get featured songs (random songs for discover page)
router.get('/public/featured', optionalAuthMiddleware, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    // Return random songs - for local app, show all songs randomly
    const result = await pool.query(
      `SELECT s.id, s.title, s.lyrics, s.style, s.caption, s.cover_url, s.audio_url,
              s.duration, s.bpm, s.key_scale, s.time_signature, s.tags, s.like_count, s.view_count, s.created_at, s.user_id,
              COALESCE(u.username, 'Anonymous') as creator, u.avatar_url as creator_avatar, s.generation_params, s.dit_model, s.lm_model, s.lm_backend, s.generation_time, s.openrouter_model
       FROM songs s
       LEFT JOIN users u ON s.user_id = u.id
       ORDER BY RANDOM()
       LIMIT 20`
    );

    const songs = await Promise.all(
      result.rows.map(async (row) => ({
        id: row.id,
        title: row.title,
        lyrics: row.lyrics,
        style: row.style,
        caption: row.caption,
        cover_url: row.cover_url,
        audio_url: await resolveAccessibleAudioUrl(row.audio_url, true),
        duration: row.duration,
        bpm: row.bpm,
        key_scale: row.key_scale,
        time_signature: row.time_signature,
        tags: row.tags || [],
        like_count: row.like_count || 0,
        view_count: row.view_count || 0,
        created_at: row.created_at,
        creator: row.creator,
        creator_avatar: row.creator_avatar,
        user_id: row.user_id,
        is_public: true
      }))
    );

    res.json({ songs });
  } catch (error) {
    console.error('Get featured/random songs error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get public songs (for explore/home)
router.get('/public', optionalAuthMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const offset = parseInt(req.query.offset as string) || 0;

    const result = await pool.query(
      `SELECT s.id, s.title, s.lyrics, s.style, s.caption, s.cover_url, s.audio_url,
              s.duration, s.bpm, s.key_scale, s.time_signature, s.tags, s.like_count, s.created_at,
              COALESCE(u.username, 'Anonymous') as creator, s.generation_params, s.dit_model, s.lm_model, s.lm_backend, s.generation_time, s.openrouter_model
       FROM songs s
       LEFT JOIN users u ON s.user_id = u.id
       WHERE s.is_public = true
       ORDER BY s.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const songs = await Promise.all(
      result.rows.map(async (row) => ({
        ...row,
        audio_url: await resolveAccessibleAudioUrl(row.audio_url, true),
      }))
    );

    res.json({ songs });
  } catch (error) {
    console.error('Get public songs error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get single song
router.get('/:id', optionalAuthMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT s.id, s.user_id, s.title, s.lyrics, s.style, s.caption, s.cover_url, s.audio_url,
              s.duration, s.bpm, s.key_scale, s.time_signature, s.tags, s.is_public, s.like_count, s.view_count, s.created_at,
              COALESCE(u.username, 'Anonymous') as creator, u.avatar_url as creator_avatar, s.generation_params, s.dit_model, s.lm_model, s.lm_backend, s.generation_time, s.openrouter_model
       FROM songs s
       LEFT JOIN users u ON s.user_id = u.id
       WHERE s.id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Song not found' });
      return;
    }

    const song = result.rows[0];

    // Check access
    if (!song.is_public && (!req.user || req.user.id !== song.user_id)) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const resolvedSong = {
      ...song,
      audio_url: await resolveAccessibleAudioUrl(song.audio_url, song.is_public),
    };

    res.json({ song: resolvedSong });
  } catch (error) {
    console.error('Get song error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get full song details (including comments)
router.get('/:id/full', optionalAuthMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const [songResult, commentsResult] = await Promise.all([
      pool.query(
        `SELECT s.id, s.user_id, s.title, s.lyrics, s.style, s.caption, s.cover_url, s.audio_url,
                s.duration, s.bpm, s.key_scale, s.time_signature, s.tags, s.is_public,
                s.like_count, s.view_count, s.created_at, s.generation_params, s.dit_model, s.lm_model, s.lm_backend, s.generation_time, s.lrc_content, s.openrouter_model,
                COALESCE(u.username, 'Anonymous') as creator, u.avatar_url as creator_avatar
         FROM songs s
         LEFT JOIN users u ON s.user_id = u.id
         WHERE s.id = $1`,
        [req.params.id]
      ),
      pool.query(
        `SELECT c.id, c.content, c.created_at, c.updated_at,
                u.id as user_id, u.username, u.avatar_url
         FROM comments c
         JOIN users u ON c.user_id = u.id
         WHERE c.song_id = $1
         ORDER BY c.created_at DESC`,
        [req.params.id]
      )
    ]);

    if (songResult.rows.length === 0) {
      res.status(404).json({ error: 'Song not found' });
      return;
    }

    const song = songResult.rows[0];

    // Check access
    if (!song.is_public && (!req.user || req.user.id !== song.user_id)) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    // Increment view count
    await pool.query('UPDATE songs SET view_count = view_count + 1 WHERE id = $1', [req.params.id]);

    const resolvedSong = {
      ...song,
      audio_url: await resolveAccessibleAudioUrl(song.audio_url, song.is_public),
    };

    res.json({
      song: resolvedSong,
      comments: commentsResult.rows
    });
  } catch (error) {
    console.error('Get full song error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create song (manual, not from generation)
router.post('/', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const {
      title,
      lyrics,
      style,
      caption,
      coverUrl,
      audioUrl,
      duration,
      bpm,
      keyScale,
      timeSignature,
      tags,
      isPublic,
    } = req.body;

    const result = await pool.query(
      `INSERT INTO songs (user_id, title, lyrics, style, caption, cover_url, audio_url,
                          duration, bpm, key_scale, time_signature, tags, is_public)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [
        req.user!.id,
        title,
        lyrics,
        style,
        caption,
        coverUrl,
        audioUrl,
        duration,
        bpm,
        keyScale,
        timeSignature,
        tags || [],
        isPublic || false,
      ]
    );

    res.status(201).json({ song: result.rows[0] });
  } catch (error) {
    console.error('Create song error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update song
router.patch('/:id', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    // Verify ownership
    const check = await pool.query('SELECT user_id FROM songs WHERE id = $1', [req.params.id]);
    if (check.rows.length === 0) {
      res.status(404).json({ error: 'Song not found' });
      return;
    }
    if (check.rows[0].user_id !== req.user!.id) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const updates: string[] = [];
    const values: unknown[] = [];
    let paramCount = 1;

    const allowedFields = ['title', 'lyrics', 'style', 'caption', 'cover_url', 'is_public', 'tags'];
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = $${paramCount}`);
        values.push(req.body[field]);
        paramCount++;
      }
    }

    if (updates.length === 0) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }

    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(req.params.id);

    await pool.query(
      `UPDATE songs SET ${updates.join(', ')} WHERE id = $${paramCount}`,
      values
    );

    // Return full song with creator JOIN
    const result = await pool.query(
      `SELECT s.*, COALESCE(u.username, 'Anonymous') as creator, u.avatar_url as creator_avatar
       FROM songs s LEFT JOIN users u ON s.user_id = u.id WHERE s.id = $1`,
      [req.params.id]
    );

    res.json({ song: result.rows[0] });
  } catch (error) {
    console.error('Update song error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete song
router.delete('/:id', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const check = await pool.query('SELECT user_id, audio_url, cover_url FROM songs WHERE id = $1', [req.params.id]);
    if (check.rows.length === 0) {
      res.status(404).json({ error: 'Song not found' });
      return;
    }
    if (check.rows[0].user_id !== req.user!.id) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const song = check.rows[0];
    const storage = getStorageProvider();

    // Delete audio file from storage
    if (song.audio_url) {
      try {
        // Handle local storage paths (/audio/filename.mp3 -> filename.mp3)
        const storageKey = song.audio_url.startsWith('/audio/')
          ? song.audio_url.replace('/audio/', '')
          : song.audio_url.replace('s3://', '');
        await storage.delete(storageKey);
      } catch (err) {
        console.error(`Failed to delete audio file ${song.audio_url}:`, err);
      }
    }

    // Delete cover image if it's stored locally
    if (song.cover_url && song.cover_url.startsWith('/audio/')) {
      try {
        const coverKey = song.cover_url.replace('/audio/', '');
        await storage.delete(coverKey);
      } catch (err) {
        console.error(`Failed to delete cover ${song.cover_url}:`, err);
      }
    }

    await pool.query('DELETE FROM songs WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete song error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /:id/regen-cover — manually regenerate the cover image. Frontend uploads
// the picked image (multipart field "cover") and we persist it to the same
// storage path that the auto-pipeline uses, then UPDATE songs.cover_url.
//
// We deliberately reuse the auto-pipeline path so that downloads/exports keep
// working unchanged — the only thing this endpoint does differently is that
// the image is provided by the user instead of being generated by the
// background cover-jobs pipeline.
router.post('/:id/regen-cover', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  coverUpload.single('cover')(req, res, async (err: any) => {
    if (err) {
      const msg = err?.message || 'Upload failed';
      const status = err?.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      res.status(status).json({ error: msg });
      return;
    }
    try {
      // Verify ownership, grab the previous cover_url so we can clean up an
      // orphaned file when the extension changes, and grab audio_url so we
      // can also patch the embedded ID3 cover frame in the MP3 itself.
      const check = await pool.query('SELECT user_id, cover_url, audio_url FROM songs WHERE id = $1', [req.params.id]);
      if (check.rows.length === 0) {
        res.status(404).json({ error: 'Song not found' });
        return;
      }
      if (check.rows[0].user_id !== req.user!.id) {
        res.status(403).json({ error: 'Access denied' });
        return;
      }
      if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
        res.status(400).json({ error: 'Empty cover upload' });
        return;
      }

      // Mirror the auto-pipeline path layout from app/server/src/routes/generate.ts
      // (attachCover): `${userId}/covers/${songId}${ext}`. Storage.upload
      // overwrites in place, so a re-generate with the SAME extension replaces
      // the previous file atomically. Cross-extension uploads are handled
      // explicitly below so we don't leak orphan files.
      const ext = req.file.mimetype === 'image/png'
        ? '.png'
        : req.file.mimetype === 'image/webp'
          ? '.webp'
          : '.jpg';
      const coverKey = `${req.user!.id}/covers/${req.params.id}${ext}`;
      const storage = getStorageProvider();
      await storage.upload(coverKey, req.file.buffer, req.file.mimetype);
      const coverUrl = storage.getPublicUrl(coverKey);

      // If the previous cover was a locally-stored file with a DIFFERENT
      // extension (e.g. user uploads webp over an existing .jpg), the old
      // file would otherwise stay orphaned on disk forever. Clean it up.
      // We only touch local-storage paths (`/audio/*`); remote URLs are
      // out of scope for this cleanup.
      const prevUrl: string | null = check.rows[0].cover_url || null;
      if (prevUrl && prevUrl.startsWith('/audio/') && !prevUrl.startsWith(coverUrl)) {
        try {
          const prevKey = prevUrl.replace('/audio/', '');
          // Avoid deleting the file we just wrote (e.g. local provider may
          // return an identical key when extension matches — already same path).
          if (prevKey !== coverKey) {
            await storage.delete(prevKey);
          }
        } catch (delErr) {
          // Non-fatal — orphan file is a minor disk-space cost, not a
          // correctness issue.
          console.warn(`[regen-cover] failed to delete previous cover ${prevUrl}:`, delErr);
        }
      }

      await pool.query(
        `UPDATE songs SET cover_url = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [coverUrl, req.params.id]
      );

      // Embed the new cover into the MP3's ID3 frame too — that way users
      // who download the file (or play it in any external music player)
      // see the picture they picked, not the seeded picsum thumbnail the
      // initial generation baked in. Best-effort: only the LocalStorage
      // provider implements `read()`; remote providers (S3 etc.) omit it
      // because the in-memory round-trip would be too expensive there. If
      // anything fails (read, retag, or re-upload) we still return success
      // because the DB cover_url is already updated → in-app UI cover works.
      const audioUrl: string | null = check.rows[0].audio_url || null;
      if (audioUrl && audioUrl.startsWith('/audio/') && audioUrl.toLowerCase().endsWith('.mp3') && typeof storage.read === 'function') {
        try {
          const audioKey = audioUrl.replace('/audio/', '');
          const mp3Buffer: Buffer = await storage.read(audioKey);
          const retagged = updateMp3Cover(mp3Buffer, req.file.buffer, req.file.mimetype);
          await storage.upload(audioKey, retagged, 'audio/mpeg');
        } catch (id3Err) {
          // Non-fatal — DB cover_url already points at the new image, only
          // the embedded thumbnail in the downloadable MP3 stays stale.
          console.warn(`[regen-cover] ID3 cover update failed for ${audioUrl}:`, id3Err);
        }
      }

      res.json({ coverUrl });
    } catch (e) {
      console.error('Regen cover error:', e);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
});

// Like/unlike song
router.post('/:id/like', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Check if already liked
    const existing = await client.query(
      'SELECT 1 FROM liked_songs WHERE user_id = $1 AND song_id = $2',
      [req.user!.id, req.params.id]
    );

    if (existing.rows.length > 0) {
      // Unlike
      await client.query('DELETE FROM liked_songs WHERE user_id = $1 AND song_id = $2', [
        req.user!.id,
        req.params.id,
      ]);
      // Decrement like_count
      await client.query(
        'UPDATE songs SET like_count = GREATEST(like_count - 1, 0) WHERE id = $1',
        [req.params.id]
      );
      await client.query('COMMIT');
      res.json({ liked: false });
    } else {
      // Like
      await client.query('INSERT INTO liked_songs (user_id, song_id) VALUES ($1, $2)', [
        req.user!.id,
        req.params.id,
      ]);
      // Increment like_count
      await client.query(
        'UPDATE songs SET like_count = like_count + 1 WHERE id = $1',
        [req.params.id]
      );
      await client.query('COMMIT');
      res.json({ liked: true });
    }
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Like song error:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// Get liked songs
router.get('/liked/list', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT s.id, s.title, s.lyrics, s.style, s.cover_url, s.audio_url,
              s.duration, s.tags, s.like_count, s.created_at, s.is_public,
              COALESCE(u.username, 'Anonymous') as creator, s.generation_params, s.dit_model, s.lm_model, s.lm_backend, s.generation_time, s.openrouter_model
       FROM liked_songs ls
       JOIN songs s ON ls.song_id = s.id
       LEFT JOIN users u ON s.user_id = u.id
       WHERE ls.user_id = $1
       ORDER BY ls.liked_at DESC`,
      [req.user!.id]
    );

    const songs = await Promise.all(
      result.rows.map(async (row) => ({
        ...row,
        audio_url: await resolveAccessibleAudioUrl(row.audio_url, row.is_public),
      }))
    );

    res.json({ songs });
  } catch (error) {
    console.error('Get liked songs error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Toggle song privacy
router.patch('/:id/privacy', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const check = await pool.query('SELECT user_id, is_public FROM songs WHERE id = $1', [req.params.id]);
    if (check.rows.length === 0) {
      res.status(404).json({ error: 'Song not found' });
      return;
    }
    if (check.rows[0].user_id !== req.user!.id) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const newPublicState = !check.rows[0].is_public;

    await pool.query('UPDATE songs SET is_public = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [
      newPublicState,
      req.params.id,
    ]);

    res.json({ isPublic: newPublicState });
  } catch (error) {
    console.error('Toggle privacy error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Track song play
router.post('/:id/play', optionalAuthMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await pool.query(
      `UPDATE songs
       SET view_count = COALESCE(view_count, 0) + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING view_count`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Song not found' });
      return;
    }

    res.json({ viewCount: result.rows[0].view_count });
  } catch (error) {
    console.error('Track play error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get comments for a song
router.get('/:id/comments', optionalAuthMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT c.id, c.content, c.created_at, u.username, u.id as user_id, u.avatar_url
       FROM comments c
       JOIN users u ON c.user_id = u.id
       WHERE c.song_id = $1
       ORDER BY c.created_at DESC`,
      [req.params.id]
    );

    res.json({ comments: result.rows });
  } catch (error) {
    console.error('Get comments error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Add comment to a song
router.post('/:id/comments', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { content } = req.body;

    if (!content || content.trim().length === 0) {
      res.status(400).json({ error: 'Comment content is required' });
      return;
    }

    // Check if song exists and is public
    const songCheck = await pool.query('SELECT is_public FROM songs WHERE id = $1', [req.params.id]);
    if (songCheck.rows.length === 0) {
      res.status(404).json({ error: 'Song not found' });
      return;
    }
    if (!songCheck.rows[0].is_public) {
      res.status(403).json({ error: 'Cannot comment on private songs' });
      return;
    }

    const result = await pool.query(
      `INSERT INTO comments (song_id, user_id, content)
       VALUES ($1, $2, $3)
       RETURNING id, content, created_at`,
      [req.params.id, req.user!.id, content.trim()]
    );

    const comment = {
      ...result.rows[0],
      username: req.user!.username,
      user_id: req.user!.id,
    };

    res.status(201).json({ comment });
  } catch (error) {
    console.error('Add comment error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete comment
router.delete('/comments/:commentId', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const check = await pool.query('SELECT user_id FROM comments WHERE id = $1', [req.params.commentId]);
    if (check.rows.length === 0) {
      res.status(404).json({ error: 'Comment not found' });
      return;
    }
    if (check.rows[0].user_id !== req.user!.id) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    await pool.query('DELETE FROM comments WHERE id = $1', [req.params.commentId]);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete comment error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
