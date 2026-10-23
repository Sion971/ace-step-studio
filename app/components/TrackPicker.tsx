import React from 'react';

// Pistes que le moteur sait générer, isoler ou compléter (Lego, Extract, Complete). Clé i18n + repli anglais pour chaque piste.
export const TRACK_NAMES = [
  'woodwinds', 'brass', 'fx', 'synth', 'strings', 'percussion',
  'keyboard', 'guitar', 'bass', 'drums', 'backing_vocals', 'vocals',
] as const;

export const TRACK_LABELS: Record<(typeof TRACK_NAMES)[number], [string, string]> = {
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
  /** Lego et Complete : fabriquer aussi un mix avec l'audio source (le moteur ne rend que la nouvelle piste). */
  mixWithSource: boolean;
  onMixWithSourceChange: (value: boolean) => void;
  mixLevel: number;
  onMixLevelChange: (value: number) => void;
  /** Lego : la region choisie fait moins de 3 s (limite du moteur) ; ou ne couvre pas tout l'audio (pas de mix dans ce cas). */
  regionTooShort?: boolean;
  regionPartial?: boolean;
  /** Style est vide : seule la piste demandee part comme description. */
  styleEmpty?: boolean;
  tf: (key: string, fallback: string) => string;
}

/**
 * Choix de la piste pour les modes Lego, Extract et Complete, dans le bloc AUDIO. Remplace les champs « Nom de la piste » et
 * « Classes de piste complètes » des réglages avancés, que rien ne reliait à un mode.
 *
 * Composant présentationnel : les deux états restent dans CreatePanel.
 */
export const TrackPicker: React.FC<TrackPickerProps> = ({
  mode, trackName, onTrackNameChange, completeTrackClasses, onCompleteTrackClassesChange, hasAudio, modelIsBase,
  mixWithSource, onMixWithSourceChange, mixLevel, onMixLevelChange, regionTooShort, regionPartial, styleEmpty, tf,
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
      {mode !== 'extract' && (
        <div className="space-y-1.5 pt-1">
          <label className="flex items-start gap-2 text-[11px] text-zinc-600 dark:text-zinc-300 cursor-pointer">
            <input
              type="checkbox"
              checked={mixWithSource}
              onChange={(e) => onMixWithSourceChange(e.target.checked)}
              className="mt-0.5 w-3.5 h-3.5 rounded accent-pink-500"
            />
            <span>{tf('trackMixLabel', 'Also make a mix with the original (the new track alone is kept too)')}</span>
          </label>
          {mixWithSource && (
            <div className="flex items-center gap-2 pl-5">
              <span className="text-[10px] text-zinc-500 dark:text-zinc-400 flex-shrink-0">{tf('trackMixLevel', 'Level of the new track in the mix')}</span>
              <input type="range" min={0} max={150} step={5} value={mixLevel} onChange={(e) => onMixLevelChange(Number(e.target.value))} className="flex-1 h-1 accent-pink-500 cursor-pointer" />
              <span className="text-[10px] text-zinc-500 tabular-nums w-9 text-right">{mixLevel}%</span>
            </div>
          )}
          {mixWithSource && mode === 'lego' && regionPartial && <p className="text-[10px] text-amber-500">{tf('trackMixPartial', 'The mix is made only when the region covers the whole audio.')}</p>}
        </div>
      )}
      {mode === 'lego' && regionTooShort && <p className="text-[10px] text-amber-500">{tf('trackRegionShort', 'The region is shorter than 3 s: the engine needs at least 3 s to work with.')}</p>}
      {styleEmpty && <p className="text-[10px] text-amber-500">{tf('trackStyleEmpty', 'Describe the track in Style (in English, e.g. "clean funky electric guitar, rhythmic chord stabs"): otherwise only its name is sent.')}</p>}
      {!modelIsBase && <p className="text-[10px] text-amber-500">{tf('trackNeedsBase', 'This mode needs a pure base model (for example XL Base), not a turbo or SFT one.')}</p>}
      {!hasAudio && <p className="text-[10px] text-amber-500">{tf('trackNeedsAudio', 'Load a source audio first: without it this task cannot start.')}</p>}
      {mode === 'complete' && selected.length === 0 && <p className="text-[10px] text-zinc-400">{tf('trackNeedsChoice', 'Choose at least one track.')}</p>}
      {mode !== 'complete' && !trackName && <p className="text-[10px] text-zinc-400">{tf('trackNeedsChoice', 'Choose at least one track.')}</p>}
    </div>
  );
};
