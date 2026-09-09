import { Router, Response } from 'express';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';
import { getGradioClient } from '../services/gradio-client.js';
import { config } from '../config/index.js';

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

// Composants Gradio lus/reconstruits pour rappeler init_service_wrapper —
// identifies par introspection de http://localhost:8001/config (id, label,
// type, valeur). Fragile par nature : ces id sont propres a la mise en page
// ACTUELLE de l'interface Gradio native d'ACE-Step-1.5, et pourraient
// changer si une mise a jour amont ajoute/retire des composants avant
// eux dans l'arbre. Si un id attendu venait a disparaitre ou a changer
// de type, GRADIO_INIT_SERVICE_COMPONENTS ci-dessous devrait etre revu.
const GRADIO_INIT_SERVICE_COMPONENTS = [
  { id: 41, label: 'Checkpoint File' },
  { id: 46, label: 'Main Model Path' },
  { id: 47, label: 'Device' },
  { id: 57, label: 'Initialize 5Hz LM' },
  { id: 53, label: '5Hz LM Model Path' },
  { id: 54, label: '5Hz LM Backend' },
  { id: 58, label: 'Use Flash Attention' },
  { id: 59, label: 'Offload to CPU' },
  { id: 60, label: 'Offload DiT to CPU' },
  { id: 61, label: 'Compile Model (torch.compile)' },
  { id: 62, label: 'INT8 Quantization' },
  { id: 63, label: 'MLX DiT (Apple Silicon)' },
  { id: 176, label: 'Generation Mode' },
  { id: 299, label: 'Batch Size' },
  { id: 50, label: 'VAE' },
] as const;

const QUANTIZATION_COMPONENT_ID = 62;

/** Lit les valeurs actuelles des composants Gradio via /config, pour ne
 *  jamais ecraser un reglage en cours avec une valeur par defaut perimee
 *  lors du rappel de init_service_wrapper. */
async function fetchCurrentInitServiceValues(): Promise<Map<number, unknown>> {
  const response = await fetch(`${config.acestep.apiUrl}/config`);
  if (!response.ok) {
    throw new Error(`Impossible de lire la configuration Gradio (HTTP ${response.status})`);
  }
  const data = await response.json() as { components?: Array<{ id: number; props?: { value?: unknown } }> };
  const components = data.components ?? [];

  const values = new Map<number, unknown>();
  for (const { id, label } of GRADIO_INIT_SERVICE_COMPONENTS) {
    const found = components.find((c) => c.id === id);
    if (!found) {
      throw new Error(`Composant Gradio introuvable (id ${id}, attendu : "${label}") — la mise en page a peut-etre change en amont.`);
    }
    values.set(id, found.props?.value);
  }
  return values;
}

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

    const currentValues = await fetchCurrentInitServiceValues();
    const orderedParams = GRADIO_INIT_SERVICE_COMPONENTS.map(({ id }) =>
      id === QUANTIZATION_COMPONENT_ID ? enabled : currentValues.get(id)
    );

    const client = await getGradioClient();
    const result = await client.predict('/init_service_wrapper', orderedParams);
    const status = (result.data as unknown[])[0] as string;

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
