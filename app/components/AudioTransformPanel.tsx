import React from 'react';

interface AudioTransformPanelProps {
  audioCodes: string;
  onAudioCodesChange: (value: string) => void;

  t: (key: string) => string;
  tf: (key: string, fallback: string) => string;
}

/**
 * Section « Transform » des Contrôles experts : codes audio précalculés.
 * (Les boutons Convert / Transcribe ont été retirés : ils n'étaient pas câblés côté serveur, Gradio n'expose pas ces lambdas.)
 *
 * La force de reprise et le type de tâche ne sont plus répétés ici : le bloc
 * AUDIO les propose déjà (curseurs « Force de la reprise audio » et « Fidélité »).
 *
 * Composant présentationnel : `audioCodes` reste dans CreatePanel.
 */
export const AudioTransformPanel: React.FC<AudioTransformPanelProps> = ({
  audioCodes,
  onAudioCodesChange,
  t,
  tf,
}) => {
  return (
    <>
      <div className="space-y-1">
        <h4 className="text-xs font-bold text-zinc-500 dark:text-zinc-400 uppercase tracking-wide" title={tf('hintTransform', 'Controls how much the output follows the input audio.')}>{t('transform')}</h4>
        <p className="text-[11px] text-zinc-400 dark:text-zinc-500">{t('controlSourceAudio')}</p>
      </div>
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400" title={tf('hintAudioCodes', 'Advanced: precomputed audio codes for conditioning.')}>{t('audioCodes')}</label>
        <textarea
          value={audioCodes}
          onChange={(e) => onAudioCodesChange(e.target.value)}
          placeholder={t('optionalAudioCodes')}
          className="w-full h-16 bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg p-2 text-xs text-zinc-900 dark:text-white focus:outline-none resize-none"
        />
      </div>
    </>
  );
};
