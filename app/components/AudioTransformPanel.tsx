import React from 'react';
import type { AudioModeDef } from './CreatePanel';

interface AudioTransformPanelProps {
  audioCodes: string;
  onAudioCodesChange: (value: string) => void;
  /** Requis pour activer le bouton « Convert to Codes » : sans audio source
   *  chargé, la conversion n'a rien à traiter. */
  sourceAudioUrl: string;

  audioCoverStrength: number;
  onAudioCoverStrengthChange: (value: number) => void;

  /** Lecture seule — le taskType est piloté par le mode du bloc AUDIO, pas
   *  modifiable ici, pour éviter une seconde source de vérité qui se
   *  contredirait silencieusement avec le sélecteur de mode. */
  taskType: string;
  activeAudioMode: AudioModeDef;
  activeAudioUrl: string;

  t: (key: string) => string;
  tf: (key: string, fallback: string) => string;
}

/**
 * Section « Transform » des Contrôles experts : codes audio précalculés
 * (avec les deux actions Convert/Transcribe, non câblées côté serveur —
 * Gradio n'expose pas ces lambdas comme endpoints nommés, voir les
 * commentaires d'origine conservés dans les gestionnaires), et l'accès
 * numérique brut à la force de reprise, à côté d'un rappel en lecture seule
 * du taskType actif.
 *
 * Composant présentationnel : `audioCodes` et `audioCoverStrength` restent
 * dans CreatePanel.
 */
export const AudioTransformPanel: React.FC<AudioTransformPanelProps> = ({
  audioCodes,
  onAudioCodesChange,
  sourceAudioUrl,
  audioCoverStrength,
  onAudioCoverStrengthChange,
  taskType,
  activeAudioMode,
  activeAudioUrl,
  t,
  tf,
}) => {
  const ActiveAudioModeIcon = activeAudioMode.icon;

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

      <div className="grid grid-cols-2 gap-3">
        {/* Lecture seule : le taskType est desormais pilote par le mode
            du bloc AUDIO, pour eviter deux sources de verite qui se
            contredisent silencieusement. */}
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400" title={tf('hintTaskType', 'Choose text-to-music or audio-based modes.')}>{t('taskType')}</label>
          <div className="w-full bg-zinc-100 dark:bg-black/30 border border-zinc-200 dark:border-white/10 rounded-xl px-2 py-1.5 text-xs text-zinc-500 dark:text-zinc-400 flex items-center gap-1.5 cursor-default">
            <ActiveAudioModeIcon size={12} className="flex-shrink-0 text-pink-500" />
            <span className="truncate">{activeAudioUrl ? activeAudioMode.label : (tf('textToMusic', 'Text to music'))}</span>
            <span className="ml-auto text-[9px] font-mono opacity-60 flex-shrink-0">{taskType}</span>
          </div>
        </div>
        {/* Non envoye au serveur pour Repaint (voir CreatePanel.tsx, payload
            audioCoverStrength) — masque ici pour la meme raison que le
            curseur equivalent du bloc AUDIO, sinon un champ visible et
            modifiable enverrait une valeur silencieusement ignoree. */}
        {taskType !== 'repaint' && (
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400" title={tf('hintAudioCoverStrength', 'Influence marginale entre 0 et 75 % : la fidelite harmonique et le grain montent tres legerement avec la valeur.')}>{t('audioCoverStrength')}</label>
            <input
              type="number"
              step="0.01"
              min="0"
              max="1"
              value={audioCoverStrength}
              onChange={(e) => onAudioCoverStrengthChange(Number(e.target.value))}
              className="w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-3 py-2 text-xs text-zinc-900 dark:text-white focus:outline-none"
            />
          </div>
        )}
      </div>
    </>
  );
};
