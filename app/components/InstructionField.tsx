import React from 'react';

// Ancien defaut code en dur du champ `instruction`. Il n'etait jamais vide,
// donc `params.instruction || (...)` dans acestep.ts l.186 court-circuitait
// toujours les instructions specifiques a cover / repaint : le DiT recevait
// l'instruction du text2music meme en cover, d'ou les artefacts.
// On le garde uniquement pour neutraliser la valeur persistee en base.
// Déplacée ici depuis CreatePanel.tsx lors du découpage des Contrôles
// experts : c'est la seule paire de constantes liées à ce composant.
export const LEGACY_INSTRUCTION_DEFAULT =
  'Fill the audio semantic mask based on the given conditions:';

// Instruction que le serveur appliquera si le champ est laisse vide.
// Sert de placeholder informatif dans les reglages avances.
export const defaultInstructionFor = (taskType: string): string =>
  taskType === 'cover'
    ? 'Generate audio semantic tokens based on the given conditions:'
    : taskType === 'repaint'
      ? 'Repaint the mask area based on the given conditions:'
      : 'Fill the audio semantic mask based on the given conditions:';

interface InstructionFieldProps {
  instruction: string;
  onInstructionChange: (value: string) => void;
  taskType: string;
  /** Vrai si le contenu a été tapé dans un mode audio différent de celui
   *  actif maintenant — signale un texte potentiellement incohérent avec
   *  l'opération en cours (voir CreatePanel.tsx, instructionMayBeStale). */
  showStaleWarning?: boolean;
  t: (key: string) => string;
  tf: (key: string, fallback: string) => string;
}

/**
 * Champ libre d'instructions additionnelles pour guider la génération.
 *
 * Composant présentationnel : `instruction` reste dans CreatePanel, qui le
 * lit à la construction de la charge utile. `taskType` n'est utilisé que
 * pour calculer le texte de repli affiché en placeholder.
 */
export const InstructionField: React.FC<InstructionFieldProps> = ({
  instruction,
  onInstructionChange,
  taskType,
  showStaleWarning,
  t,
  tf,
}) => {
  return (
    <div className="space-y-1.5">
      <label
        className="text-xs font-medium text-zinc-600 dark:text-zinc-400"
        title={tf('hintInstruction', 'Additional directives to guide generation.')}
      >
        {t('instruction')}
      </label>
      <textarea
        value={instruction}
        onChange={(e) => onInstructionChange(e.target.value)}
        placeholder={defaultInstructionFor(taskType)}
        className="w-full h-16 bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg p-2 text-xs text-zinc-900 dark:text-white placeholder-zinc-400 dark:placeholder-zinc-600 focus:outline-none resize-none"
      />
      {showStaleWarning ? (
        <p className="text-[10px] text-amber-500">
          {tf('warnInstructionStale', 'Ce texte a été écrit pour un autre mode audio — vérifie qu\'il convient toujours, ou vide le champ pour laisser le serveur choisir automatiquement.')}
        </p>
      ) : (
        <p className="text-[10px] text-zinc-400 dark:text-zinc-500">
          {tf('hintInstructionEmpty', "Laisser vide : l'instruction est choisie automatiquement selon le mode audio.")}
        </p>
      )}
    </div>
  );
};
