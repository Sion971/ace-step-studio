import React from 'react';

export type RepaintMode = 'conservative' | 'balanced' | 'aggressive' | 'most_natural';

interface RepaintSettingsProps {
  taskType: string;
  repaintMode: RepaintMode;
  onRepaintModeChange: (value: RepaintMode) => void;
  repaintStrength: number;
  onRepaintStrengthChange: (value: number) => void;
  repaintingStart: number;
  onRepaintingStartChange: (value: number) => void;
  repaintingEnd: number;
  onRepaintingEndChange: (value: number) => void;
  t: (key: string) => string;
  tf: (key: string, fallback: string) => string;
}

/**
 * Réglages avancés du repaint : mode et force (visibles seulement en
 * `taskType === 'repaint'`), plus une saisie numérique de la région
 * (`repaintingStart`/`repaintingEnd`) toujours visible.
 *
 * Ces champs numériques dupliquent volontairement le curseur et le
 * sélecteur de région déjà présents dans le bloc AUDIO (voir la zone
 * `isRepaintMode` juste après le lecteur/forme d'onde) : c'est un accès
 * brut de secours, sur le même modèle que `audioCoverStrength` dans
 * AudioTransformPanel. Comportement existant préservé tel quel — aucune
 * fusion des deux UI dans ce découpage.
 *
 * Composant présentationnel : les quatre états restent dans CreatePanel.
 */
export const RepaintSettings: React.FC<RepaintSettingsProps> = ({
  taskType,
  repaintMode,
  onRepaintModeChange,
  repaintStrength,
  onRepaintStrengthChange,
  repaintingStart,
  onRepaintingStartChange,
  repaintingEnd,
  onRepaintingEndChange,
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
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{tf('repaintStrengthLabel', 'Repaint Strength')}</label>
            <input
              type="number" step="0.05" min="0" max="1"
              value={repaintStrength}
              onChange={(e) => onRepaintStrengthChange(Number(e.target.value))}
              className="w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-3 py-2 text-xs text-zinc-900 dark:text-white focus:outline-none"
            />
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400" title={tf('hintRepaintingStart', 'Start time for the region to repaint (seconds).')}>{t('repaintingStart')}</label>
          <input
            type="number"
            step="0.1"
            min="0"
            value={repaintingStart}
            onChange={(e) => onRepaintingStartChange(Number(e.target.value))}
            className="w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-3 py-2 text-xs text-zinc-900 dark:text-white focus:outline-none"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400" title={tf('hintRepaintingEnd', 'End time for the region to repaint (seconds).')}>{t('repaintingEnd')}</label>
          <input
            type="number"
            step="0.1"
            min="-1"
            value={repaintingEnd}
            onChange={(e) => onRepaintingEndChange(Number(e.target.value))}
            className="w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-3 py-2 text-xs text-zinc-900 dark:text-white focus:outline-none"
          />
        </div>
      </div>
    </>
  );
};
