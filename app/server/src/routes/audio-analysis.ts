import { Router, Response } from 'express';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';
import { prepareAudioFile, hasUnfinishedGeneration, resolveAudioPath } from '../services/acestep.js';
import { getGradioClient } from '../services/gradio-client.js';
import { promises as fsp } from 'fs';
import path from 'path';
import { analyzeAudio, compactWords, expandWords, withWhisperLyrics } from '../services/audio-analysis.js';
import { transcribeWithWhisperDetailed, transcribeWordsWithWhisper } from '../services/whisper.js';
import { findTrackIdByUrl, loadTrackAnalysis, saveTrackAnalysis, withCorrectedLyrics } from '../services/track-analysis.js';

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
    const modelAnalysis = await analyzeAudio(audioUrl, {
      prepareFile: prepareAudioFile,
      predict: (endpoint, args) => client.predict(endpoint, args) as Promise<{ data: unknown }>,
    });
    // Real lyrics and language from Whisper when it is installed (the model's are an estimate).
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    const analysis = await withWhisperLyrics(modelAnalysis, {
        readAudio: async () => {
          const file = resolveAudioPath(audioUrl);
          try { return { buffer: await fsp.readFile(file), name: path.basename(file) }; } catch { return null; }
        },
        transcribe: (buffer, name) => transcribeWithWhisperDetailed(buffer, name, controller.signal),
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

// POST /api/audio-analysis/lyrics  { audioUrl, lyrics }  ->  { saved, retimed, matchedWords, totalWords }
// The lyrics corrected by hand in the analysis window, kept with the imported audio: its analysis takes the corrected text, and its
// synchronised lyrics (used by the video and the player) are timed again from the words Whisper heard. An analysis made before the
// words were kept gets them from one more Whisper run (about half a minute for a song).
router.post('/lyrics', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const audioUrl = typeof req.body?.audioUrl === 'string' ? req.body.audioUrl : '';
  const lyrics = typeof req.body?.lyrics === 'string' ? req.body.lyrics.trim() : '';
  if (!audioUrl || !lyrics) {
    res.status(400).json({ error: 'audioUrl and lyrics are required' });
    return;
  }
  try {
    const trackId = req.user ? await findTrackIdByUrl(req.user.id, audioUrl) : null;
    if (!trackId) {
      // Not an imported audio (a created song...): nothing is kept, the form already has the text.
      res.json({ saved: false, retimed: false, matchedWords: 0, totalWords: 0 });
      return;
    }
    const stored = await loadTrackAnalysis(trackId);
    if (!stored) {
      res.json({ saved: false, retimed: false, matchedWords: 0, totalWords: 0 });
      return;
    }
    let analysis = stored;
    if (!analysis.words?.length) {
      const file = resolveAudioPath(audioUrl);
      try {
        const heard = await transcribeWordsWithWhisper(await fsp.readFile(file), path.basename(file), analysis.language);
        if (heard?.words.length) analysis = { ...analysis, words: compactWords(heard.words) };
      } catch (error) {
        console.warn('[Analysis] Whisper words for the corrected lyrics failed:', error);
      }
    }
    const result = withCorrectedLyrics(analysis, lyrics, expandWords(analysis.words || []));
    await saveTrackAnalysis(trackId, result.analysis);
    console.log(`[Analysis] corrected lyrics kept with the import: ${result.retimed ? `timed again, ${result.matchedWords}/${result.totalWords} words found` : 'text only (previous timing kept)'}`);
    res.json({ saved: true, retimed: result.retimed, matchedWords: result.matchedWords, totalWords: result.totalWords });
  } catch (error) {
    console.error('[Analysis] corrected lyrics not saved:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Not saved' });
  }
});

export default router;
