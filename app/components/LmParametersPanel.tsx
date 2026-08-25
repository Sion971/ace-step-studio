import React from 'react';
import { Music2, ChevronDown } from 'lucide-react';
import { EditableSlider } from './EditableSlider';

interface LmParametersPanelProps {
  /** Le panneau entier ne s'affiche que si un LM local est réellement
   *  chargé — OpenRouter et l'API distante n'ont pas ces réglages. */
  useOpenRouter: boolean;
  activeLmModel: string;

  showLmParams: boolean;
  onToggleShowLmParams: () => void;

  lmTemperature: number;
  onLmTemperatureChange: (value: number) => void;
  lmCfgScale: number;
  onLmCfgScaleChange: (value: number) => void;
  lmTopK: number;
  onLmTopKChange: (value: number) => void;
  lmTopP: number;
  onLmTopPChange: (value: number) => void;
  lmNegativePrompt: string;
  onLmNegativePromptChange: (value: string) => void;

  t: (key: string) => string;
  tf: (key: string, fallback: string) => string;
}

/**
 * Paramètres d'échantillonnage du modèle de langue local (paroles/légende) :
 * bouton repliable, puis température, échelle CFG, top-K/top-P, prompt
 * négatif.
 *
 * Composant présentationnel : les six états restent dans CreatePanel, qui
 * les lit à la construction de la charge utile et lors de la restauration
 * de paramètres.
 */
export const LmParametersPanel: React.FC<LmParametersPanelProps> = ({
  useOpenRouter,
  activeLmModel,
  showLmParams,
  onToggleShowLmParams,
  lmTemperature,
  onLmTemperatureChange,
  lmCfgScale,
  onLmCfgScaleChange,
  lmTopK,
  onLmTopKChange,
  lmTopP,
  onLmTopPChange,
  lmNegativePrompt,
  onLmNegativePromptChange,
  t,
  tf,
}) => {
  if (useOpenRouter || activeLmModel === '') return null;

  return (
    <>
      <button
        onClick={onToggleShowLmParams}
        className="w-full flex items-center justify-between px-4 py-3 bg-white/60 dark:bg-black/20 rounded-xl border border-zinc-200/70 dark:border-white/10 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-white/5 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Music2 size={16} className="text-zinc-500" />
          <div className="flex flex-col items-start">
            <span title={tf('hintLmParameters', 'Controls the 5Hz lyric/caption model sampling behavior.')}>{t('lmParameters')}</span>
            <span className="text-[11px] text-zinc-400 dark:text-zinc-500 font-normal">{t('controlLyricGeneration')}</span>
          </div>
        </div>
        <ChevronDown size={16} className={`text-zinc-500 transition-transform ${showLmParams ? 'rotate-180' : ''}`} />
      </button>

      {showLmParams && (
        <div className="bg-white dark:bg-suno-card rounded-xl border border-zinc-200 dark:border-white/5 p-4 space-y-4">
          {/* LM Temperature */}
          <EditableSlider
            label={t('lmTemperature')}
            value={lmTemperature}
            min={0}
            max={2}
            step={0.1}
            onChange={onLmTemperatureChange}
            formatDisplay={(val) => val.toFixed(2)}
            helpText={t('higherMoreRandom')}
            title={tf('hintLmTemperature', 'Higher temperature = more random word choices.')}
          />

          {/* LM CFG Scale */}
          <EditableSlider
            label={t('lmCfgScale')}
            value={lmCfgScale}
            min={1}
            max={3}
            step={0.1}
            onChange={onLmCfgScaleChange}
            formatDisplay={(val) => val.toFixed(1)}
            helpText={t('noCfgScale')}
            title={tf('hintLmCfgScale', 'How strongly the lyric model follows the prompt.')}
          />

          {/* LM Top-K & Top-P */}
          <div className="grid grid-cols-2 gap-3">
            <EditableSlider
              label={t('topK')}
              value={lmTopK}
              min={0}
              max={100}
              step={1}
              onChange={onLmTopKChange}
              title={tf('hintTopK', 'Restricts choices to the K most likely tokens. 0 disables.')}
            />
            <EditableSlider
              label={t('topP')}
              value={lmTopP}
              min={0}
              max={1}
              step={0.01}
              onChange={onLmTopPChange}
              formatDisplay={(val) => val.toFixed(2)}
              title={tf('hintTopP', 'Samples from the smallest set whose total probability is P.')}
            />
          </div>

          {/* LM Negative Prompt */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400" title={tf('hintLmNegativePrompt', 'Words or ideas to steer the lyric model away from.')}>{t('lmNegativePrompt')}</label>
            <textarea
              value={lmNegativePrompt}
              onChange={(e) => onLmNegativePromptChange(e.target.value)}
              placeholder={t('thingsToAvoid')}
              className="w-full h-16 bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg p-2 text-xs text-zinc-900 dark:text-white focus:outline-none resize-none"
            />
            <p className="text-[10px] text-zinc-500">{t('useWhenCfgScaleGreater')}</p>
          </div>
        </div>
      )}
    </>
  );
};
