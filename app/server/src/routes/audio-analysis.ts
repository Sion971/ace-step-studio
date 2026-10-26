import { Router, Response } from 'express';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';
import { prepareAudioFile, hasUnfinishedGeneration } from '../services/acestep.js';
import { getGradioClient } from '../services/gradio-client.js';
import { analyzeAudio } from '../services/audio-analysis.js';
import { findTrackIdByUrl, saveTrackAnalysis } from '../services/track-analysis.js';

const router = Router();

// POST /api/audio-analysis  { audioUrl }  ->  { analysis }
// One analysis at a time, and never during a generation: both use the card.
let busy = false;

router.post('/', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const audioUrl = typeof req.body?.audioUrl === 'string' ? req.body.audioUrl : '';
  if (!audioUrl) {
    res.status(400).json({ error: 'audioUrl is required' });
    return;
  }
  if (busy || hasUnfinishedGeneration()) {
    res.status(409).json({ error: 'busy' });
    return;
  }
  busy = true;
  try {
    const client = await getGradioClient();
    const analysis = await analyzeAudio(audioUrl, {
      prepareFile: prepareAudioFile,
      predict: (endpoint, args) => client.predict(endpoint, args) as Promise<{ data: unknown }>,
    });
    // Kept with the imported audio, so that the song details can show it. A failure here must not lose the answer.
    let saved = false;
    try {
      const trackId = req.user ? await findTrackIdByUrl(req.user.id, audioUrl) : null;
      if (trackId && analysis.available) {
        await saveTrackAnalysis(trackId, analysis);
        saved = true;
      }
    } catch (error) {
      console.warn('[Analysis] could not be saved with the track:', error);
    }
    res.json({ analysis, saved });
  } catch (error) {
    console.error('[Analysis] failed:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Analysis failed' });
  } finally {
    busy = false;
  }
});

export default router;
