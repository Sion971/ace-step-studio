import React from 'react';
import { Loader2 } from 'lucide-react';
import { LmProviderPanel } from './LmProviderPanel';

interface LmSettingsProps {
  useOpenRouter: boolean;

  lmBackend: 'pt' | 'vllm';
  onLmBackendChange: (value: 'pt' | 'vllm') => void;
  lmModel: string;
  onLmModelChange: (value: string) => void;
  /** Marque une edition manuelle en cours — evite qu'un poll serveur ne
   *  reecrase la selection avant que l'utilisateur ait clique "Appliquer".
   *  Mutee directement (pas de setter), comme dans le code d'origine. */
  lmEditingRef: React.MutableRefObject<boolean>;

  modelSwitchStatus: string;
  onApply: () => void;

  thinking: boolean;
  onThinkingChange: (value: boolean) => void;
  loraLoaded: boolean;
  /** Determine si la bascule Reflexion s'affiche du tout (LM local charge,
   *  ou OpenRouter actif). */
  activeLmModel: string;

  t: (key: string) => string;
  tf: (key: string, fallback: string) => string;
}

/**
 * Derniere etape de la cartographie CreatePanel (anciennement "LmSettings",
 * estime a ~400 lignes) : selecteur de moteur/modele LM local, bouton
 * d'application (redemarre le pipeline), bascule Reflexion/Raisonnement.
 *
 * L'estimation d'origine incluait ce qui a ete absorbe par
 * LmParametersPanel (temperature, CFG, top-K/top-P, prompt negatif) lors
 * d'une session precedente — le perimetre reel restant est plus petit
 * (~86 lignes), pas de quoi forcer Pollinations.ai ou Shift dedans, qui
 * n'ont rien a voir avec le LM malgre leur proximite dans le fichier
 * d'origine.
 *
 * Reordonnancement delibere par rapport au code d'origine (confirme avec
 * l'utilisateur avant extraction) : la bascule Reflexion, auparavant
 * separee du reste par les sections Pollinations et Graine (SeedSettings),
 * est desormais regroupee ici avec le reste des controles LM — change
 * l'ordre visuel de ces sections dans l'onglet Creer.
 *
 * La logique metier du bouton Appliquer (appel reseau /api/generate/
 * switch-model, gestion d'erreur) reste dans CreatePanel, transmise ici
 * comme un simple callback — coherent avec tous les sous-panneaux
 * precedents : composant presentationnel, etat et effets de bord ailleurs.
 */
export const LmSettings: React.FC<LmSettingsProps> = ({
  useOpenRouter,
  lmBackend,
  onLmBackendChange,
  lmModel,
  onLmModelChange,
  lmEditingRef,
  modelSwitchStatus,
  onApply,
  thinking,
  onThinkingChange,
  loraLoaded,
  activeLmModel,
  t,
  tf,
}) => {
  return (
    <>
      {/* Local LM controls — hidden entirely when OpenRouter is active */}
      {!useOpenRouter && (
        <>
          {/* LM Backend */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{tf('lmBackendLabel', 'LM Backend')}</label>
            <select
              value={lmBackend}
              onChange={e => { onLmBackendChange(e.target.value as 'pt' | 'vllm'); lmEditingRef.current = true; }}
              className="w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-2 py-1.5 text-xs text-zinc-900 dark:text-white focus:outline-none cursor-pointer [&>option]:bg-white [&>option]:dark:bg-zinc-800 [&>option]:text-zinc-900 [&>option]:dark:text-white"
            >
              <option value="vllm">{tf('lmBackendVllm', 'VLLM (~9.2 GB VRAM)')}</option>
              <option value="pt">{tf('lmBackendPt', 'PT (~1.6 GB VRAM)')}</option>
            </select>
            <p className="text-[10px] text-zinc-500">{tf('lmBackendHint', 'vLLM uses CUDA graphs for faster LLM inference')}</p>
          </div>

          {/* LM Model */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{t('lmModelLabel')}</label>
            <select
              value={lmModel}
              onChange={(e) => { onLmModelChange(e.target.value); lmEditingRef.current = true; }}
              className="w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-2 py-1.5 text-xs text-zinc-900 dark:text-white focus:outline-none cursor-pointer [&>option]:bg-white [&>option]:dark:bg-zinc-800 [&>option]:text-zinc-900 [&>option]:dark:text-white"
            >
              <option value="acestep-5Hz-lm-0.6B">{t('lmModel06B')}</option>
              <option value="acestep-5Hz-lm-1.7B">{t('lmModel17B')}</option>
              <option value="acestep-5Hz-lm-4B">{t('lmModel4B')}</option>
            </select>
            <p className="text-[10px] text-zinc-500">{t('lmModelHint')}</p>
          </div>
        </>
      )}

      {/* Apply LM Settings button — only relevant when controlling local LM */}
      {!useOpenRouter && (
        <button
          type="button"
          disabled={!!modelSwitchStatus || !lmModel}
          onClick={onApply}
          className={`w-full py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center justify-center gap-2 ${modelSwitchStatus ? 'bg-purple-800 text-purple-300 cursor-wait' : 'bg-purple-600 hover:bg-purple-700 text-white'}`}
        >
          {modelSwitchStatus ? (
            <><Loader2 size={12} className="animate-spin" /> {modelSwitchStatus}</>
          ) : (
            tf('applyLmSettings', 'Apply LM Settings (restart pipeline)')
          )}
        </button>
      )}

      {/* OpenRouter provider config — shown when toggle is ON. Deplace
          apres le bouton Appliquer (etaient auparavant intervertis) :
          les deux conditions sont mutuellement exclusives
          (useOpenRouter / !useOpenRouter), donc jamais visibles en meme
          temps — ce reordonnancement ne change rien a l'affichage. */}
      {useOpenRouter && <LmProviderPanel />}

      {/* Thinking / Reasoning Toggle —
            • Local LM mode: enables chain-of-thought caption/lyrics generation.
            • OpenRouter mode: forwards reasoning hint to OR model (honored by reasoning models like Claude extended-thinking, GPT-5, DeepSeek-R1; ignored by others).
      */}
      {(useOpenRouter || activeLmModel !== '') && (
        <div className="flex items-center justify-between py-2 border-t border-zinc-100 dark:border-white/5">
          <span className={`text-xs font-medium ${loraLoaded ? 'text-zinc-400 dark:text-zinc-600' : 'text-zinc-600 dark:text-zinc-400'}`} title={useOpenRouter ? 'Forwards reasoning hint to OpenRouter (honored by reasoning-capable models, ignored by others).' : (tf('hintThinkingCot', 'Lets the lyric model reason about structure and metadata. Slightly slower.'))}>
            {t('thinkingCot')}
          </span>
          <button
            onClick={() => !loraLoaded && onThinkingChange(!thinking)}
            disabled={loraLoaded}
            className={`w-10 h-5 rounded-full flex items-center transition-colors duration-200 px-0.5 border border-zinc-200 dark:border-white/5 ${thinking ? 'bg-pink-600' : 'bg-zinc-300 dark:bg-black/40'} ${loraLoaded ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
          >
            <div className={`w-4 h-4 rounded-full bg-white transform transition-transform duration-200 shadow-sm ${thinking ? 'translate-x-5' : 'translate-x-0'}`} />
          </button>
        </div>
      )}
    </>
  );
};
