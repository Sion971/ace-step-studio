import React from 'react';

export interface CotDebugTogglesValues {
  useAdg: boolean;
  allowLmBatch: boolean;
  useCotMetas: boolean;
  useCotCaption: boolean;
  useCotLanguage: boolean;
  autogen: boolean;
  constrainedDecodingDebug: boolean;
  isFormatCaption: boolean;
  getScores: boolean;
  getLrc: boolean;
}

interface CotDebugTogglesProps {
  values: CotDebugTogglesValues;
  /** Un seul callback, clé du champ modifié — évite dix props onChange
   *  individuelles pour dix booléens uniformes. */
  onToggle: (key: keyof CotDebugTogglesValues) => void;
  t: (key: string) => string;
  tf: (key: string, fallback: string) => string;
}

/**
 * Grille des dix interrupteurs de raisonnement (chain-of-thought) et de
 * débogage : ADG, lots LM, CoT sur métadonnées/légende/langue, autogen,
 * débogage du décodage contraint, légende formatée, scores, sortie LRC.
 *
 * `useAdg` est aussi lu par GuidanceSettings (les préréglages l'activent) —
 * l'état reste dans CreatePanel, seule sa case à cocher vit ici.
 *
 * Composant présentationnel : les dix états restent dans CreatePanel.
 */
export const CotDebugToggles: React.FC<CotDebugTogglesProps> = ({ values, onToggle, t, tf }) => {
  const items: Array<{ key: keyof CotDebugTogglesValues; label: string; hintKey: string; hintFallback: string }> = [
    { key: 'useAdg', label: t('useAdg'), hintKey: 'hintUseAdg', hintFallback: 'Adaptive Dual Guidance: dynamically adjusts CFG for quality. Base model only; slower.' },
    { key: 'allowLmBatch', label: t('allowLmBatch'), hintKey: 'hintAllowLmBatch', hintFallback: 'Allow the LM to run in larger batches for speed (more VRAM).' },
    { key: 'useCotMetas', label: t('useCotMetas'), hintKey: 'hintUseCotMetas', hintFallback: 'Let the LM reason about metadata like BPM, key, duration.' },
    { key: 'useCotCaption', label: t('useCotCaption'), hintKey: 'hintUseCotCaption', hintFallback: 'Let the LM reason about the caption/style text.' },
    { key: 'useCotLanguage', label: t('useCotLanguage'), hintKey: 'hintUseCotLanguage', hintFallback: 'Let the LM reason about language selection.' },
    { key: 'autogen', label: t('autogen'), hintKey: 'hintAutogen', hintFallback: 'Auto-generate missing fields when possible.' },
    { key: 'constrainedDecodingDebug', label: t('constrainedDecodingDebug'), hintKey: 'hintConstrainedDecodingDebug', hintFallback: 'Include debug info for constrained decoding.' },
    { key: 'isFormatCaption', label: t('formatCaption'), hintKey: 'hintFormatCaption', hintFallback: 'Use the formatted caption produced by the AI formatter.' },
    { key: 'getScores', label: t('getScores'), hintKey: 'hintGetScores', hintFallback: 'Return scorer outputs for diagnostics.' },
    { key: 'getLrc', label: t('getLrcLyrics'), hintKey: 'hintGetLrcLyrics', hintFallback: 'Return synced lyric (LRC) output when available.' },
  ];

  return (
    <div className="grid grid-cols-2 gap-3">
      {items.map((item) => (
        <label
          key={item.key}
          className="flex items-center gap-2 text-xs font-medium text-zinc-600 dark:text-zinc-400"
          title={tf(item.hintKey, item.hintFallback)}
        >
          <input
            type="checkbox"
            checked={values[item.key]}
            onChange={() => onToggle(item.key)}
          />
          {item.label}
        </label>
      ))}
    </div>
  );
};
