import React from 'react';

// Pistes que le moteur sait générer, isoler ou compléter (Lego, Extract, Complete). Clé i18n + repli anglais pour chaque piste.
export const TRACK_NAMES = [
  'woodwinds', 'brass', 'fx', 'synth', 'strings', 'percussion',
  'keyboard', 'guitar', 'bass', 'drums', 'backing_vocals', 'vocals',
] as const;

const TRACK_LABELS: Record<(typeof TRACK_NAMES)[number], [string, string]> = {
  woodwinds: ['trackWoodwinds', 'Woodwinds'],
  brass: ['trackBrass', 'Brass'],
  fx: ['trackFx', 'Effects'],
  synth: ['trackSynth', 'Synth'],
  strings: ['trackStrings', 'Strings'],
  percussion: ['trackPercussion', 'Percussion'],
  keyboard: ['trackKeyboard', 'Keyboards'],
  guitar: ['trackGuitar', 'Guitar'],
  bass: ['trackBass', 'Bass'],
  drums: ['trackDrums', 'Drums'],
  backing_vocals: ['trackBackingVocals', 'Backing vocals'],
  vocals: ['trackVocals', 'Vocals'],
};

export type TrackMode = 'lego' | 'extract' | 'complete';

interface TrackPickerProps {
  mode: TrackMode;
  /** Piste unique (Lego, Extract). */
  trackName: string;
  onTrackNameChange: (value: string) => void;
  /** Pistes à ajouter (Complete), séparées par des virgules. */
  completeTrackClasses: string;
  onCompleteTrackClassesChange: (value: string) => void;
  hasAudio: boolean;
  modelIsBase: boolean;
  tf: (key: string, fallback: string) => string;
}

/**
 * Choix de la piste pour les modes Lego, Extract et Complete, dans le bloc AUDIO. Remplace les champs « Nom de la piste » et
 * « Classes de piste complètes » des réglages avancés, que rien ne reliait à un mode.
 *
 * Composant présentationnel : les deux états restent dans CreatePanel.
 */
export const TrackPicker: React.FC<TrackPickerProps> = ({
  mode, trackName, onTrackNameChange, completeTrackClasses, onCompleteTrackClassesChange, hasAudio, modelIsBase, tf,
}) => {
  const selected = completeTrackClasses.split(',').map((s) => s.trim()).filter(Boolean);
  const label = (name: (typeof TRACK_NAMES)[number]) => tf(TRACK_LABELS[name][0], TRACK_LABELS[name][1]);
  const title = mode === 'lego' ? tf('trackPickLego', 'Track to generate')
    : mode === 'extract' ? tf('trackPickExtract', 'Track to isolate')
    : tf('trackPickComplete', 'Tracks to add');

  return (
    <div className="px-3 pb-3 space-y-2" data-testid="track-picker">
      <span className="block text-[10px] font-medium text-zinc-500 dark:text-zinc-400">{title}</span>
      {mode === 'complete' ? (
        <div className="flex flex-wrap gap-1.5">
          {TRACK_NAMES.map((name) => {
            const on = selected.includes(name);
            return (
              <button
                key={name}
                type="button"
                aria-pressed={on}
                onClick={() => onCompleteTrackClassesChange((on ? selected.filter((s) => s !== name) : [...selected, name]).join(','))}
                className={`px-2 py-1 rounded-md text-[10px] font-medium border transition-colors ${
                  on
                    ? 'bg-pink-500/20 text-pink-400 border-pink-500/30'
                    : 'bg-white/5 text-zinc-400 border-white/10 hover:border-white/20 hover:text-zinc-200'
                }`}
              >
                {label(name)}
              </button>
            );
          })}
        </div>
      ) : (
        <select
          value={trackName}
          onChange={(e) => onTrackNameChange(e.target.value)}
          className="w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-2 py-1.5 text-xs text-zinc-900 dark:text-white focus:outline-none focus:border-pink-500 cursor-pointer [&>option]:bg-white [&>option]:dark:bg-zinc-800"
        >
          <option value="">{tf('trackPickChoose', 'Choose…')}</option>
          {TRACK_NAMES.map((name) => (
            <option key={name} value={name}>{label(name)}</option>
          ))}
        </select>
      )}
      {!modelIsBase && <p className="text-[10px] text-amber-500">{tf('trackNeedsBase', 'This mode needs a pure base model (for example XL Base), not a turbo or SFT one.')}</p>}
      {!hasAudio && <p className="text-[10px] text-amber-500">{tf('trackNeedsAudio', 'Load a source audio first: without it this task cannot start.')}</p>}
      {mode === 'complete' && selected.length === 0 && <p className="text-[10px] text-zinc-400">{tf('trackNeedsChoice', 'Choose at least one track.')}</p>}
      {mode !== 'complete' && !trackName && <p className="text-[10px] text-zinc-400">{tf('trackNeedsChoice', 'Choose at least one track.')}</p>}
    </div>
  );
};
