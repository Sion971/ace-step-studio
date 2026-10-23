/**
 * Tâches « par piste » du moteur : Lego, Extract et Complete.
 *
 * - lego    : génère UNE piste (guitare, basse…) en s'appuyant sur l'audio source ;
 * - extract : isole UNE piste d'un mixage ;
 * - complete: ajoute des pistes à une piste seule.
 *
 * Le moteur (Gradio) utilise le texte d'instruction TEL QUEL : c'est l'interface Gradio d'origine qui le fabrique à partir de la piste
 * choisie. Le Studio doit donc le fabriquer lui aussi, sinon le moteur reçoit « Fill the audio semantic mask… » sans nom de piste. Les
 * phrases ci-dessous sont celles de TASK_INSTRUCTIONS (ACE-Step-1.5/acestep/constants.py).
 *
 * Ces tâches ne sont proposées par le moteur que pour un modèle base PUR : ni turbo, ni SFT, ni fusion (model_config.py).
 */

export const TRACK_TASKS = ['lego', 'extract', 'complete'] as const;
export type TrackTask = (typeof TRACK_TASKS)[number];

export const TRACK_NAMES = [
  'woodwinds', 'brass', 'fx', 'synth', 'strings', 'percussion',
  'keyboard', 'guitar', 'bass', 'drums', 'backing_vocals', 'vocals',
] as const;

export const isTrackTask = (taskType?: string): taskType is TrackTask =>
  !!taskType && (TRACK_TASKS as readonly string[]).includes(taskType);

/** Modèle base pur : « base » dans l'identifiant, sans « turbo », « sft » ni « merge ». */
export const isPureBaseModel = (modelId?: string): boolean => {
  const id = (modelId || '').toLowerCase();
  return id.includes('base') && !id.includes('turbo') && !id.includes('sft') && !id.includes('merge');
};

/** Instruction du moteur pour une tâche par piste ; chaîne vide si la tâche n'en est pas une. */
export const buildTrackInstruction = (
  taskType: string | undefined,
  trackName?: string,
  trackClasses?: string[],
): string => {
  const track = (trackName || '').trim().toUpperCase();
  const classes = (trackClasses || []).map((c) => c.trim().toUpperCase()).filter(Boolean);
  switch (taskType) {
    case 'extract':
      return track ? `Extract the ${track} track from the audio:` : 'Extract the track from the audio:';
    case 'lego':
      return track ? `Generate the ${track} track based on the audio context:` : 'Generate the track based on the audio context:';
    case 'complete':
      return classes.length ? `Complete the input track with ${classes.join(' | ')}:` : 'Complete the input track:';
    default:
      return '';
  }
};

export interface TrackTaskInput {
  taskType?: string;
  ditModel?: string;
  sourceAudioUrl?: string;
  trackName?: string;
  completeTrackClasses?: string[];
}

/** Message d'erreur si la demande ne peut pas aboutir côté moteur, sinon null. */
export const validateTrackTask = (p: TrackTaskInput): string | null => {
  if (!isTrackTask(p.taskType)) return null;
  if (!isPureBaseModel(p.ditModel)) {
    return `task_type='${p.taskType}' needs a pure base model (for example XL Base), not a turbo, SFT or merged one`;
  }
  if (!p.sourceAudioUrl) return `task_type='${p.taskType}' requires a source audio`;
  if (p.taskType === 'complete') {
    if (!p.completeTrackClasses || p.completeTrackClasses.length === 0) return "task_type='complete' requires at least one track to add";
  } else if (!(p.trackName || '').trim()) {
    return `task_type='${p.taskType}' requires a track name`;
  }
  return null;
};
