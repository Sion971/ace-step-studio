import { Router, Response } from 'express';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';
import { getGradioClient, callInitServiceWrapper, fetchCurrentInitServiceValues, QUANTIZATION_COMPONENT_ID, MAIN_MODEL_PATH_COMPONENT_ID } from '../services/gradio-client.js';
import { readdirSync, statSync, existsSync, renameSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// app/server/src/routes/lora.ts -> remonte jusqu'a la racine du Studio,
// puis descend dans ACE-Step-1.5/lora_output — meme convention que
// tools.ts pour localiser les dossiers geres par ACE-Step-1.5.
const LORA_OUTPUT_DIR = path.join(__dirname, '../../../../ACE-Step-1.5/lora_output');

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

// GET /api/lora/available — Liste les LoRA valides dans lora_output/, en
// excluant "checkpoints" (points de sauvegarde intermediaires
// d'entrainement, pas un adaptateur pret a charger) et "runs" (journaux
// d'entrainement, sans rapport). Ne retient que les dossiers contenant
// reellement un adapter_config.json + un .safetensors — evite de
// proposer un dossier vide ou incomplet dans le menu.
const EXCLUDED_LORA_DIRS = new Set(['checkpoints', 'runs']);

router.get('/available', authMiddleware, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    if (!existsSync(LORA_OUTPUT_DIR)) {
      res.json({ loras: [] });
      return;
    }

    const entries = readdirSync(LORA_OUTPUT_DIR);
    const loras: Array<{ name: string; path: string }> = [];

    for (const entry of entries) {
      if (EXCLUDED_LORA_DIRS.has(entry)) continue;
      const entryPath = path.join(LORA_OUTPUT_DIR, entry);
      if (!statSync(entryPath).isDirectory()) continue;

      // PEFT exige precisement le nom "adapter_model.safetensors" — un
      // fichier .safetensors present mais nomme differemment (courant
      // pour les LoRA telecharges depuis HuggingFace, qui gardent souvent
      // le nom d'origine de leur propre depot) semblerait valide ici sans
      // correction, mais echouerait au chargement avec un message confus
      // ("Failed to load LoRA: 'module name can't contain \".\"'" ou une
      // erreur de decalage de dimensions sans rapport avec le vrai
      // probleme). Renomme automatiquement quand c'est SANS AMBIGUITE :
      // un seul fichier .safetensors present, et il n'a pas deja le bon
      // nom. Ne renomme jamais si plusieurs candidats existent (ambigu,
      // mieux vaut laisser une intervention manuelle) ou si le fichier
      // correctement nomme existe deja (rien a faire).
      const hasConfig = existsSync(path.join(entryPath, 'adapter_config.json'));
      const correctlyNamedPath = path.join(entryPath, 'adapter_model.safetensors');
      let hasSafetensors = existsSync(correctlyNamedPath);

      if (hasConfig && !hasSafetensors) {
        const safetensorFiles = readdirSync(entryPath).filter((f) => f.endsWith('.safetensors'));
        if (safetensorFiles.length === 1) {
          const oldPath = path.join(entryPath, safetensorFiles[0]);
          try {
            renameSync(oldPath, correctlyNamedPath);
            console.log(`[LoRA] Renomme automatiquement : ${entry}/${safetensorFiles[0]} -> adapter_model.safetensors`);
            hasSafetensors = true;
          } catch (renameError) {
            console.error(`[LoRA] Echec du renommage automatique pour ${entry}:`, renameError);
          }
        }
      }

      if (!hasConfig || !hasSafetensors) continue;

      loras.push({ name: entry, path: `./lora_output/${entry}` });
    }

    loras.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ loras });
  } catch (error) {
    console.error('[LoRA] Available list error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to list available LoRAs' });
  }
});

export default router;
