import React from 'react';

export type RepaintMode = 'conservative' | 'balanced' | 'aggressive' | 'most_natural';

interface RepaintSettingsProps {
  taskType: string;
  repaintMode: RepaintMode;
  onRepaintModeChange: (value: RepaintMode) => void;
  t: (key: string) => string;
  tf: (key: string, fallback: string) => string;
}

/**
 * Mode d'inpainting (visible seulement en `taskType === 'repaint'`).
 *
 * La force et la région (début/fin) ne sont plus saisies ici : le bloc AUDIO
 * les propose déjà (curseur « Force » et champs « Région »), sur les mêmes
 * états. Les garder en double ne faisait que surcharger les réglages avancés.
 *
 * Composant présentationnel : l'état reste dans CreatePanel.
 */
export const RepaintSettings: React.FC<RepaintSettingsProps> = ({
  taskType,
  repaintMode,
  onRepaintModeChange,
  t,
  tf,
}) => {
  return (
    <>
      {taskType === 'repaint' && (
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{tf('repaintModeLabel', 'Repaint Mode')}</label>
            <select
              value={repaintMode}
              onChange={(e) => onRepaintModeChange(e.target.value as RepaintMode)}
              className="w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-2 py-1.5 text-xs text-zinc-900 dark:text-white focus:outline-none focus:border-pink-500 transition-colors cursor-pointer [&>option]:bg-white [&>option]:dark:bg-zinc-800"
            >
              <option value="conservative">{tf('repaintConservative', 'Conservative')}</option>
              <option value="balanced">{tf('repaintBalanced', 'Balanced')}</option>
              <option value="aggressive">{tf('repaintAggressive', 'Aggressive')}</option>
              <option value="most_natural">{tf('repaintMostNatural', 'Most Natural')}</option>
            </select>
          </div>
        </div>
      )}
    </>
  );
};
