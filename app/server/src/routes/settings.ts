import { Router, Response } from 'express';
import { pool } from '../db/pool.js';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';

const DEFAULTS: Record<string, unknown> = {
  customMode: false,
  instrumental: false,
  vocalLanguage: 'en',
  vocalGender: '',
  duration: -1,
  batchSize: 1,
  bulkCount: 1,
  guidanceScale: 9.0,
  thinking: false,
  enhance: false,
  audioFormat: 'mp3',
  inferenceSteps: 12,
  inferMethod: 'ode',
  lmModel: 'acestep-5Hz-lm-4B',
  shift: 3.0,
  lmTemperature: 0.8,
  lmCfgScale: 2.2,
  lmTopK: 0,
  lmTopP: 0.92,
  lmNegativePrompt: 'NO USER INPUT',
  useAdg: false,
  samplerMode: 'euler',
  schedulerType: 'linear',
  mp3Bitrate: '128k',
  mp3SampleRate: 48000,
};

const router = Router();

router.get('/', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await pool.query(
      'SELECT settings FROM users WHERE id = ?',
      [req.user!.id]
    );
    const stored = result.rows[0]?.settings;
    const parsed = stored ? JSON.parse(stored) : {};
    res.json({ ...DEFAULTS, ...parsed });
  } catch (error) {
    console.error('Get settings error:', error);
    res.json(DEFAULTS);
  }
});

router.put('/', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    // Merge with existing
    const result = await pool.query(
      'SELECT settings FROM users WHERE id = ?',
      [req.user!.id]
    );
    const stored = result.rows[0]?.settings;
    const current = stored ? JSON.parse(stored) : {};
    const updated = { ...current, ...req.body };

    await pool.query(
      `UPDATE users SET settings = ?, updated_at = datetime('now') WHERE id = ?`,
      [JSON.stringify(updated), req.user!.id]
    );
    res.json({ ...DEFAULTS, ...updated });
  } catch (error) {
    console.error('Save settings error:', error);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

export default router;
