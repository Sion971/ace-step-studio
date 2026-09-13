import { Router, Response } from 'express';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';
import { getGradioClient, callInitServiceWrapper, fetchCurrentInitServiceValues, QUANTIZATION_COMPONENT_ID, MAIN_MODEL_PATH_COMPONENT_ID } from '../services/gradio-client.js';

const router = Router();

// Local LoRA state tracking (Gradio doesn't have a dedicated status endpoint)
let loraState = {
  loaded: false,
  active: false,
  scale: 1.0,
  path: '',
};

// POST /api/lora/load — Load a LoRA adapter
router.post('/load', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { lora_path } = req.body;
    if (!lora_path || typeof lora_path !== 'string') {
      res.status(400).json({ error: 'lora_path is required' });
      return;
    }

    const client = await getGradioClient();
    const result = await client.predict('/load_lora', [lora_path]);
    const status = (result.data as unknown[])[0] as string;

    loraState = { loaded: true, active: true, scale: loraState.scale, path: lora_path };

    res.json({ message: status, lora_path, loaded: true });
  } catch (error) {
    console.error('[LoRA] Load error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to load LoRA' });
  }
});

// POST /api/lora/unload — Unload the current LoRA adapter
router.post('/unload', authMiddleware, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const client = await getGradioClient();
    const result = await client.predict('/unload_lora', []);
    const status = (result.data as unknown[])[0] as string;

    loraState = { loaded: false, active: false, scale: 1.0, path: '' };

    res.json({ message: status });
  } catch (error) {
    console.error('[LoRA] Unload error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to unload LoRA' });
  }
});

// POST /api/lora/scale — Set LoRA scale (0.0 - 1.0)
router.post('/scale', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { scale } = req.body;
    if (typeof scale !== 'number' || scale < 0 || scale > 1) {
      res.status(400).json({ error: 'scale must be a number between 0 and 1' });
      return;
    }

    const client = await getGradioClient();
    const result = await client.predict('/set_lora_scale', [scale]);
    const status = (result.data as unknown[])[0] as string;

    loraState.scale = scale;

    res.json({ message: status, scale });
  } catch (error) {
    console.error('[LoRA] Scale error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to set LoRA scale' });
  }
});

// POST /api/lora/toggle — Toggle LoRA on/off
router.post('/toggle', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { enabled } = req.body;
    const useLoRA = typeof enabled === 'boolean' ? enabled : !loraState.active;

    const client = await getGradioClient();
    const result = await client.predict('/set_use_lora', [useLoRA]);
    const status = (result.data as unknown[])[0] as string;

    loraState.active = useLoRA;

    res.json({ message: status, active: useLoRA });
  } catch (error) {
    console.error('[LoRA] Toggle error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to toggle LoRA' });
  }
});

// POST /api/lora/toggle-quantization — Active/desactive la quantification
// INT8 du DiT sans redemarrer le service complet. Necessaire pour charger
// un LoRA (incompatible avec la quantification, conflit PEFT/TorchAO
// documente en amont) sans editer .env + relancer run.sh/run.bat.
router.post('/toggle-quantization', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled (boolean) est requis' });
      return;
    }

    // Inclut explicitement le modele reellement actif (suivi cote
    // serveur dans generate.ts) — le composant Gradio "Main Model Path"
    // lu via /config reste bloque sur la valeur de demarrage et ne
    // reflete jamais un changement de modele fait en cours de route,
    // confirme en pratique. Sans cet override explicite, basculer la
    // quantification APRES un changement de modele rechargeait
    // silencieusement le modele de demarrage.
    const { getActiveLoadedModel } = await import('../routes/generate.js');
    const status = await callInitServiceWrapper(new Map<number, unknown>([
      [QUANTIZATION_COMPONENT_ID, enabled],
      [MAIN_MODEL_PATH_COMPONENT_ID, getActiveLoadedModel()],
    ]));

    res.json({ message: status, quantization_enabled: enabled });
  } catch (error) {
    console.error('[LoRA] Toggle quantization error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to toggle quantization' });
  }
});

// GET /api/lora/quantization-status — Etat actuel reel de la quantification
// INT8 (pas une supposition basee sur la VRAM) — permet a l'interface de
// n'afficher le bouton de desactivation que quand c'est reellement utile.
router.get('/quantization-status', authMiddleware, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const currentValues = await fetchCurrentInitServiceValues();
    const quantizationEnabled = Boolean(currentValues.get(QUANTIZATION_COMPONENT_ID));
    res.json({ quantization_enabled: quantizationEnabled });
  } catch (error) {
    console.error('[LoRA] Quantization status error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to read quantization status' });
  }
});

// GET /api/lora/status — Get current LoRA state
router.get('/status', authMiddleware, async (_req: AuthenticatedRequest, res: Response) => {
  res.json(loraState);
});

export default router;
