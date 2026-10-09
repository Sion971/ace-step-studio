// services/lmSwitch.ts
//
// « Appliquer les réglages du LM » : télécharger le modèle de langage s'il manque, puis le charger.
//
// Le sélecteur proposait 0.6B, 1.7B et 4B, mais rien ne téléchargeait un LM depuis l'interface : le moteur ne le fait qu'à SON démarrage, pour le LM par défaut. Un LM absent
// du disque ne pouvait donc pas être choisi. Sans React, avec `fetch` injecté : le déroulement est testé seul.

export type LmApplyProgress = { kind: 'downloading'; percent?: number } | { kind: 'applying' };

export type LmApplyResult =
  | { ok: true }
  | { ok: false; stage: 'download' }
  | { ok: false; stage: 'switch'; reason: string };

export interface LmApplyOptions {
  token: string;
  /** Le modèle de musique (DiT) déjà choisi : il ne change pas ici. */
  selectedModel: string;
  lmModel: string;
  lmBackend: 'pt' | 'vllm';
  /** Les LM présents sur le disque ; null tant que le serveur ne l'a pas dit (alors rien n'est téléchargé : on ne devine pas). */
  lmOnDisk: readonly string[] | null;
  onProgress: (progress: LmApplyProgress) => void;
  fetchFn?: typeof fetch;
}

/** Lit un flux d'événements « data: {...} » du serveur ; vrai seulement si l'événement « done » arrive. Un flux coupé avant ne vaut pas un succès. */
async function readDownload(response: Response, onProgress: LmApplyOptions['onProgress']): Promise<boolean> {
  if (!response.ok || !response.body) return false;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let done = false;
  let failed = false;
  const handle = (line: string) => {
    if (!line.startsWith('data:')) return;
    let event: { status?: string; message?: string };
    try { event = JSON.parse(line.slice(5)); } catch { return; }
    if (event.status === 'done') done = true;
    else if (event.status === 'error') failed = true;
    else if (typeof event.message === 'string') {
      const percent = event.message.match(/(\d{1,3})%/);
      if (percent) onProgress({ kind: 'downloading', percent: Math.min(100, Number(percent[1])) });
    }
  };
  for (;;) {
    const { done: finished, value } = await reader.read();
    if (value) {
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      lines.forEach(handle);
    }
    if (finished) break;
  }
  if (pending) handle(pending);
  return done && !failed;
}

export async function applyLmSettings(options: LmApplyOptions): Promise<LmApplyResult> {
  const { token, selectedModel, lmModel, lmBackend, lmOnDisk, onProgress } = options;
  const fetchFn = options.fetchFn ?? fetch;
  const auth = { Authorization: `Bearer ${token}` };

  if (lmOnDisk !== null && !lmOnDisk.includes(lmModel)) {
    onProgress({ kind: 'downloading' });
    try {
      const response = await fetchFn(`/api/generate/download-model?model=${encodeURIComponent(lmModel)}`, { headers: auth });
      if (!(await readDownload(response, onProgress))) return { ok: false, stage: 'download' };
    } catch {
      return { ok: false, stage: 'download' };
    }
  }

  onProgress({ kind: 'applying' });
  try {
    const response = await fetchFn('/api/generate/switch-model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ model: selectedModel, lmModel, lmBackend }),
    });
    const data = (await response.json().catch(() => ({}))) as { success?: boolean; error?: string };
    if (data.success) return { ok: true };
    return { ok: false, stage: 'switch', reason: data.error || `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, stage: 'switch', reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Les LM présents sur le disque d'après la réponse de /api/generate/models ; null si le serveur ne le dit pas (serveur plus ancien : rien n'est deviné). */
export function lmOnDiskFrom(list: unknown): string[] | null {
  if (!Array.isArray(list)) return null;
  return list
    .filter((m): m is { name: string; is_preloaded: boolean } => !!m && typeof m === 'object' && typeof (m as { name?: unknown }).name === 'string' && (m as { is_preloaded?: unknown }).is_preloaded === true)
    .map((m) => m.name);
}
