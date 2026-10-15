// services/gradio-value.ts
//
// Gradio renvoie, pour une sortie qu'un handler ne souhaite pas modifier, un
// objet gr.update() — { "__type__": "update", ... } — et non une valeur. Le
// recopier tel quel dans une reponse JSON fait afficher `{"__type__":"update"}`
// dans les champs de l'interface, et fausse tout calcul fait sur la valeur
// (par exemple le nombre de lignes d'un dataframe : 0 au lieu de N).
//
// Cas typique : un chargement de dataset qui echoue (« Dataset not found »)
// renvoie un message d'etat, puis un gr.update() pour toutes les autres sorties.
// Voir TROUBLESHOOTING.md, section 6.

export interface GradioUpdate {
  __type__: 'update';
  value?: unknown;
  [key: string]: unknown;
}

export function isGradioUpdate(v: unknown): v is GradioUpdate {
  return typeof v === 'object' && v !== null && (v as { __type__?: unknown }).__type__ === 'update';
}

/**
 * Valeur utile d'une sortie Gradio :
 *  - valeur ordinaire : renvoyee telle quelle ;
 *  - gr.update(value=X, ...) : X, la nouvelle valeur ;
 *  - gr.update() sans valeur (« ne change rien ») : undefined, que JSON.stringify omet.
 */
export function gv(v: unknown): unknown {
  if (isGradioUpdate(v)) return 'value' in v ? v.value : undefined;
  return v;
}

/** Nombre de lignes d'un dataframe Gradio ({ headers, data }) ; 0 si absent ou gr.update() sans valeur. */
export function dataframeRowCount(v: unknown): number {
  const frame = gv(v) as { data?: unknown } | undefined;
  return Array.isArray(frame?.data) ? (frame!.data as unknown[]).length : 0;
}

/**
 * Message d'erreur a renvoyer au front. Le client Gradio leve un objet simple
 * ({ type: 'status', message, ... }) et non une Error : `error instanceof Error`
 * etait donc faux et le texte generique masquait la vraie cause.
 */
export function gradioErrorMessage(error: unknown, fallback: string): string {
  let message: string | undefined;
  if (error instanceof Error) {
    message = error.message;
  } else if (typeof error === 'object' && error !== null) {
    const m = (error as { message?: unknown }).message;
    if (typeof m === 'string') message = m;
  }
  message = message?.trim();
  if (!message) return fallback;
  return message.length > 600 ? message.slice(0, 600) + '…' : message;
}

const ENGINE_DOWN = /connection errored out|fetch failed|econnrefused|econnreset|socket hang up|failed to connect|enotfound/i;

/**
 * The engine (Gradio) is stopped on purpose while a LoRA trains ("Free VRAM") and restarts when training ends. A call made in
 * the meantime fails with "Connection errored out", which tells the user nothing. Returns a clear message when the error looks
 * like an unreachable engine, null otherwise.
 */
export function engineDownMessage(error: unknown): string | null {
  let text = '';
  if (error instanceof Error) {
    text = `${error.message} ${String((error as { cause?: { code?: unknown } }).cause?.code ?? '')}`;
  } else if (typeof error === 'object' && error !== null) {
    const m = (error as { message?: unknown }).message;
    if (typeof m === 'string') text = m;
  } else if (typeof error === 'string') {
    text = error;
  }
  if (!ENGINE_DOWN.test(text)) return null;
  return 'The engine is not reachable. It is stopped while a LoRA trains and restarts by itself when training ends '
    + '(or use "Restart the server" in the Train tab). Wait for it to be ready, then try again.';
}
