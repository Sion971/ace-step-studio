import React from 'react';

// Liste de classes d'instruments/pistes utilisée par les modes "trackName"
// (piste unique à générer) et "completeTrackClasses" (ensemble de classes à
// compléter). Déplacée ici depuis CreatePanel.tsx : elle n'est référencée
// que par ce composant.
export const TRACK_NAMES = [
  'woodwinds', 'brass', 'fx', 'synth', 'strings', 'percussion',
  'keyboard', 'guitar', 'bass', 'drums', 'backing_vocals', 'vocals',
];

interface TrackSettingsProps {
  trackName: string;
  onTrackNameChange: (value: string) => void;
  completeTrackClasses: string;
  onCompleteTrackClassesChange: (value: string) => void;
  t: (key: string) => string;
}

/**
 * Sélection d'une piste cible unique (`trackName`) et de l'ensemble des
 * classes de piste à compléter (`completeTrackClasses`), toutes deux basées
 * sur la même liste TRACK_NAMES.
 *
 * Composant présentationnel : les deux états restent dans CreatePanel, qui
 * les lit à la construction de la charge utile.
 */
export const TrackSettings: React.FC<TrackSettingsProps> = ({
  trackName,
  onTrackNameChange,
  completeTrackClasses,
  onCompleteTrackClassesChange,
  t,
}) => {
  const selected = completeTrackClasses.split(',').map((s) => s.trim()).filter(Boolean);

  return (
    <>
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{t('trackName')}</label>
        <select
          value={trackName}
          onChange={(e) => onTrackNameChange(e.target.value)}
          className="w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-2 py-1.5 text-xs text-zinc-900 dark:text-white focus:outline-none cursor-pointer [&>option]:bg-white [&>option]:dark:bg-zinc-800"
        >
          <option value="">None</option>
          {TRACK_NAMES.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{t('completeTrackClasses')}</label>
        <div className="flex flex-wrap gap-2">
          {TRACK_NAMES.map((name) => {
            const isChecked = selected.includes(name);
            return (
              <label key={name} className="flex items-center gap-1 text-[10px] font-medium text-zinc-500 dark:text-zinc-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={() => {
                    const next = isChecked
                      ? selected.filter((s) => s !== name)
                      : [...selected, name];
                    onCompleteTrackClassesChange(next.join(','));
                  }}
                  className="accent-pink-600"
                />
                {name}
              </label>
            );
          })}
        </div>
      </div>
    </>
  );
};
