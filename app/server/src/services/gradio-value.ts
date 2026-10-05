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
