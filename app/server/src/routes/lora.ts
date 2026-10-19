import { Router, Response } from 'express';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';
import { getGradioClient, callInitServiceWrapper, fetchCurrentInitServiceValues, QUANTIZATION_COMPONENT_ID, MAIN_MODEL_PATH_COMPONENT_ID } from '../services/gradio-client.js';
import { listAvailableLoras } from '../services/lora-available.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { describeLoadFailure } from '../services/lora-engine-status.js';
import { isStreamMode } from '../services/hardware-mode.js';
import { SMALL_GPU_QUANTIZATION_MESSAGE } from '../services/lora-text.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// app/server/src/routes/lora.ts -> remonte jusqu'a la racine du Studio,
// puis descend dans ACE-Step-1.5/lora_output — meme convention que
// tools.ts pour localiser les dossiers geres par ACE-Step-1.5.
export const LORA_OUTPUT_DIR = path.join(__dirname, '../../../../ACE-Step-1.5/lora_output');

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

    // The engine answers normally even when it loaded nothing ("❌ Failed to load LoRA: …"). That used to be recorded as loaded and shown as such.
    const failure = describeLoadFailure(status, lora_path);
    if (failure) {
      console.warn('[LoRA] The engine did not load it:', status);
      res.status(422).json({ error: failure.message, code: failure.code });
      return;
    }

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
    // Small-card mode: the engine keeps the DiT unquantized whatever this switch says; re-initialising it for nothing would only cost a minute.
    if (isStreamMode()) {
      res.status(409).json({ error: SMALL_GPU_QUANTIZATION_MESSAGE, code: 'small_gpu' });
      return;
    }
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled (boolean) is required' });
      return;
    }

    // Securite : la quantification est structurellement incompatible avec
    // un LoRA charge (conflit PEFT/TorchAO, voir la constante du fichier).
    // Activer la quantification pendant qu'un LoRA reste charge risquerait
    // un etat confus, voire un plantage similaire a ceux deja rencontres
    // avec le decalage d'appareil des tenseurs quantifies. Decharge
    // automatiquement AVANT de proceder, plutot que de laisser
    // l'utilisateur decouvrir le probleme plus tard.
    let loraAutoUnloaded = false;
    if (enabled && loraState.loaded) {
      console.log('[LoRA] Dechargement automatique avant activation de la quantification');
      const client = await getGradioClient();
      await client.predict('/unload_lora', []);
      loraState = { loaded: false, active: false, scale: 1.0, path: '' };
      loraAutoUnloaded = true;
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

    res.json({ message: status, quantization_enabled: enabled, lora_auto_unloaded: loraAutoUnloaded });
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
    // Small-card mode: the engine turns quantization off itself, whatever its start-up form still says. Report what it really does.
    if (isStreamMode()) {
      res.json({ quantization_enabled: false, small_gpu: true });
      return;
    }
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
  // small_gpu: the install runs in small-card mode (HW_MODE=stream): no quantization there. A LoRA does load: the engine adds it to each block as it passes through the card.
  res.json({ ...loraState, small_gpu: isStreamMode() });
});

// GET /api/lora/available — Liste les LoRA valides dans lora_output/, en
// excluant "checkpoints" (points de sauvegarde intermediaires
// d'entrainement, pas un adaptateur pret a charger) et "runs" (journaux
// d'entrainement, sans rapport). Ne retient que les dossiers contenant
// reellement un adapter_config.json + un .safetensors — evite de
// proposer un dossier vide ou incomplet dans le menu.
const EXCLUDED_LORA_DIRS = new Set(['checkpoints', 'runs']);

router.get('/available', authMiddleware, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    res.json({ loras: listAvailableLoras(LORA_OUTPUT_DIR) });
  } catch (error) {
    console.error('[LoRA] Available list error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to list available LoRAs' });
  }
});

export default router;
