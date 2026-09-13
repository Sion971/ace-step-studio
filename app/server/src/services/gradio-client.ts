import { Client } from "@gradio/client";
import { config } from '../config/index.js';

let clientInstance: Client | null = null;
let connectionPromise: Promise<Client> | null = null;

/**
 * Get a lazy-initialized Gradio client connected to the ACE-Step Gradio app.
 * Caches the connection for reuse across requests.
 */
export async function getGradioClient(): Promise<Client> {
  if (clientInstance) return clientInstance;
  if (connectionPromise) return connectionPromise;

  connectionPromise = (async () => {
    try {
      const client = await Client.connect(config.acestep.apiUrl, {
        events: ["data", "status"],
      });
      clientInstance = client;
      console.log(`[Gradio] Connected to ${config.acestep.apiUrl}`);
      return client;
    } catch (error) {
      console.error(`[Gradio] Failed to connect to ${config.acestep.apiUrl}:`, error);
      throw error;
    } finally {
      connectionPromise = null;
    }
  })();

  return connectionPromise;
}

/**
 * Reset the cached Gradio client, forcing a new connection on next use.
 */
export function resetGradioClient(): void {
  clientInstance = null;
  connectionPromise = null;
}

/**
 * Check if the Gradio app is reachable.
 * Tries multiple well-known endpoints to handle version differences.
 */
export async function isGradioAvailable(): Promise<boolean> {
  const baseUrl = config.acestep.apiUrl;
  const candidates = [
    `${baseUrl}/gradio_api/info`, // Gradio 5+
    `${baseUrl}/info`,            // Gradio 4.x fallback
    `${baseUrl}/`,                // Any HTTP response means server is up
  ];

  for (const url of candidates) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (response.ok || response.status < 500) return true;
    } catch {
      // Try next candidate
    }
  }
  return false;
}

// Composants Gradio de init_service_wrapper — identifies par introspection
// de http://localhost:8001/config (id, label, type, valeur). Fragile par
// nature : ces id sont propres a la mise en page ACTUELLE de l'interface
// Gradio native d'ACE-Step-1.5, et pourraient changer si une mise a jour
// amont ajoute/retire des composants avant eux dans l'arbre.
export const GRADIO_INIT_SERVICE_COMPONENTS = [
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

export const QUANTIZATION_COMPONENT_ID = 62;
export const MAIN_MODEL_PATH_COMPONENT_ID = 46;

/** Lit les valeurs actuelles des composants Gradio via /config, pour ne
 *  jamais ecraser un reglage en cours avec une valeur par defaut perimee
 *  lors du rappel de init_service_wrapper. */
export async function fetchCurrentInitServiceValues(): Promise<Map<number, unknown>> {
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

/**
 * Rappelle init_service_wrapper avec les valeurs LIVES actuelles, en
 * n'ecrasant que les composants precises dans `overrides` — jamais les
 * autres. Point d'entree UNIQUE et partage pour toute action qui doit
 * reinitialiser le service (changement de modele, bascule de
 * quantification, etc.), pour eviter que deux mecanismes distincts
 * (celui-ci et l'ancien /v1/init REST) ne desynchronisent leur propre
 * notion de "l'etat actuel" — confirme en pratique : basculer la
 * quantification via ce point d'entree APRES un changement de modele
 * fait via /v1/init rechargeait silencieusement l'ANCIEN modele de
 * demarrage, /v1/init ne mettant jamais a jour l'etat interne que LIT
 * init_service_wrapper via /config.
 */
export async function callInitServiceWrapper(overrides: Map<number, unknown>): Promise<string> {
  const currentValues = await fetchCurrentInitServiceValues();
  const orderedParams = GRADIO_INIT_SERVICE_COMPONENTS.map(({ id }) =>
    overrides.has(id) ? overrides.get(id) : currentValues.get(id)
  );

  const client = await getGradioClient();
  const result = await client.predict('/init_service_wrapper', orderedParams);
  return (result.data as unknown[])[0] as string;
}
