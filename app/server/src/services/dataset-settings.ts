// services/dataset-settings.ts
//
// Reglages globaux d'un dataset d'entrainement, tels que l'interface Gradio
// d'ACE-Step les definit (acestep/ui/gradio/interfaces/training_dataset_tab_scan_settings.py) :
//   custom_tag        Textbox
//   tag_position      Radio : "prepend" | "append" | "replace"
//   all_instrumental  Checkbox
//   genre_ratio       Slider 0..100
// et que update_settings() applique au builder_state de la session Gradio.

export const TAG_POSITIONS = ['prepend', 'append', 'replace'] as const;
export type TagPosition = (typeof TAG_POSITIONS)[number];

export interface DatasetSettings {
  customTag: string;
  tagPosition: TagPosition;
  allInstrumental: boolean;
  genreRatio: number;
}

/**
 * Valide le corps d'une requete update-settings. Renvoie les reglages normalises, ou
 * { error } si une valeur serait rejetee par Gradio (mieux vaut un message clair ici).
 */
export function parseDatasetSettings(body: unknown): DatasetSettings | { error: string } {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;

  const customTag = typeof b.customTag === 'string' ? b.customTag.trim() : '';

  const position = typeof b.tagPosition === 'string' ? b.tagPosition.trim().toLowerCase() : '';
  if (!(TAG_POSITIONS as readonly string[]).includes(position)) {
    return { error: `Invalid tagPosition: expected one of ${TAG_POSITIONS.join(', ')}` };
  }

  let allInstrumental: boolean;
  if (typeof b.allInstrumental === 'boolean') allInstrumental = b.allInstrumental;
  else if (b.allInstrumental === 'true') allInstrumental = true;
  else if (b.allInstrumental === 'false') allInstrumental = false;
  else return { error: 'Invalid allInstrumental: expected a boolean' };

  const rawRatio = b.genreRatio;
  if (rawRatio === undefined || rawRatio === null || rawRatio === '') {
    return { error: 'Invalid genreRatio: expected a number between 0 and 100' };
  }
  const ratio = typeof rawRatio === 'number' ? rawRatio : Number(rawRatio);
  if (!Number.isFinite(ratio)) {
    return { error: 'Invalid genreRatio: expected a number between 0 and 100' };
  }

  return {
    customTag,
    tagPosition: position as TagPosition,
    allInstrumental,
    genreRatio: Math.min(100, Math.max(0, Math.round(ratio))),
  };
}
