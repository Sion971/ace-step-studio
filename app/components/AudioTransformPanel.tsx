import React from 'react';

interface AudioTransformPanelProps {
  audioCodes: string;
  onAudioCodesChange: (value: string) => void;
  /** Requis pour activer le bouton « Convert to Codes » : sans audio source
   *  chargé, la conversion n'a rien à traiter. */
  sourceAudioUrl: string;

  t: (key: string) => string;
  tf: (key: string, fallback: string) => string;
}

/**
 * Section « Transform » des Contrôles experts : codes audio précalculés
 * (avec les deux actions Convert/Transcribe, non câblées côté serveur —
 * Gradio n'expose pas ces lambdas comme endpoints nommés, voir les
 * commentaires d'origine conservés dans les gestionnaires).
 *
 * La force de reprise et le type de tâche ne sont plus répétés ici : le bloc
 * AUDIO les propose déjà (curseurs « Force de la reprise audio » et « Fidélité »).
 *
 * Composant présentationnel : `audioCodes` reste dans CreatePanel.
 */
export const AudioTransformPanel: React.FC<AudioTransformPanelProps> = ({
  audioCodes,
  onAudioCodesChange,
  sourceAudioUrl,
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
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => {
              // Convert source audio to LM codes — requires Gradio lambda (not exposed as API)
              // This is a placeholder: Gradio's convert_src_audio_to_codes_wrapper is not a named endpoint
              console.log('Convert to Codes: requires source audio upload. Use Gradio UI for this feature.');
            }}
            disabled={!sourceAudioUrl}
            title={tf('hintConvertToCodes', 'Convert source audio to LM codes (requires source audio)')}
            className="px-2 py-1 rounded text-[10px] font-medium bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Convert to Codes
          </button>
          <button
            type="button"
            onClick={() => {
              // Transcribe audio codes to metadata — requires Gradio lambda (not exposed as API)
              console.log('Transcribe: requires audio codes. Use Gradio UI for this feature.');
            }}
            disabled={!audioCodes.trim()}
            title={tf('hintTranscribeCodes', 'Transcribe audio codes to metadata (requires audio codes)')}
            className="px-2 py-1 rounded text-[10px] font-medium bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Transcribe
          </button>
        </div>
      </div>
    </>
  );
};
