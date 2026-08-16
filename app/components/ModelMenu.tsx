import React, { useState, useEffect, useRef, useMemo } from 'react';
import { ChevronDown } from 'lucide-react';
import { useI18n } from '../context/I18nContext';
import { getModelDisplayName, MODEL_INFO } from '../utils/modelNames';

export interface FetchedModel {
  name: string;
  is_active: boolean;
  is_preloaded: boolean;
}

export interface ModelLoadingState {
  state: string;
  model: string;
  connected?: boolean;
  activeModel?: string;
  backendDown?: boolean;
}

interface ModelMenuProps {
  /** Modèle actuellement sélectionné dans l'UI. */
  selectedModel: string;
  /** Le parent en a besoin : turboActive, auto-ajustement des paramètres, génération. */
  setSelectedModel: (id: string) => void;
  /** Alimenté par le polling du parent (état du pipeline Gradio). */
  modelLoadingState: ModelLoadingState;
  /** Liste renvoyée par /api/generate/models. */
  fetchedModels: FetchedModel[];
  /** Le parent la remplit aussi au démarrage — le setter reste partagé. */
  setFetchedModels: (models: FetchedModel[]) => void;
  /** Affiché par le panneau LM du parent pendant un téléchargement ou une bascule. */
  setModelSwitchStatus: (status: string | null) => void;
  token: string | null;
  lmModel: string;
  lmBackend: string;
  /** Remis à false après une bascule réussie, pour resynchroniser depuis le serveur. */
  lmEditingRef: React.MutableRefObject<boolean>;
}

/** Ordre d'affichage préféré ; sert aussi de repli si le backend est injoignable. */
const FIXED_ORDER = [
  'acestep-v15-xl-turbo',
  'acestep-v15-xl-sft',
  'marcorez8/acestep-v15-xl-turbo-bf16',
  'acestep-v15-xl-merge-sft-turbo',
];

/**
 * En-tête du panneau Créer : voyant d'état du pipeline et menu de sélection
 * du modèle DiT (téléchargement à la demande, bascule côté Gradio).
 */
export const ModelMenu: React.FC<ModelMenuProps> = ({
  selectedModel,
  setSelectedModel,
  modelLoadingState,
  fetchedModels,
  setFetchedModels,
  setModelSwitchStatus,
  token,
  lmModel,
  lmBackend,
  lmEditingRef,
}) => {
  const { t } = useI18n();
  const [showModelMenu, setShowModelMenu] = useState(false);
  const modelMenuRef = useRef<HTMLDivElement>(null);

  const availableModels = useMemo(() => {
    if (fetchedModels.length > 0) {
      const ordered = FIXED_ORDER.filter(id => fetchedModels.some(m => m.name === id));
      // Modèles du serveur absents de l'ordre fixe (personnalisés, convertis, fusionnés)
      for (const m of fetchedModels) {
        if (!ordered.includes(m.name)) ordered.push(m.name);
      }
      return ordered.map(id => ({ id, name: id }));
    }
    return FIXED_ORDER.map(id => ({ id, name: id }));
  }, [fetchedModels]);

  // Fermeture au clic extérieur
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(event.target as Node)) {
        setShowModelMenu(false);
      }
    };

    if (showModelMenu) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showModelMenu]);

  const handleSelect = async (modelId: string) => {
    if (modelId === selectedModel) {
      setShowModelMenu(false);
      return;
    }
    const prevModel = selectedModel;
    setSelectedModel(modelId);
    localStorage.setItem('ace-model', modelId);
    setShowModelMenu(false);

    // Les réglages dépendant du modèle sont ajustés par un useEffect du parent

    if (modelId === prevModel || !token) return;

    const modelInfo = fetchedModels.find(m => m.name === modelId);

    // Téléchargement si le modèle n'est pas sur le disque
    if (modelInfo && !modelInfo.is_preloaded) {
      setModelSwitchStatus(`${t('downloadingModel') || 'Downloading'} ${getModelDisplayName(modelId)}...`);
      try {
        const dlRes = await fetch(`/api/generate/download-model?model=${encodeURIComponent(modelId)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const reader = dlRes.body?.getReader();
        if (reader) {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = new TextDecoder().decode(value);
            if (text.includes('"done"')) break;
            if (text.includes('"error"')) { setModelSwitchStatus(null); return; }
            const pctMatch = text.match(/(\d+)%/);
            if (pctMatch) setModelSwitchStatus(`⬇ ${pctMatch[1]}%`);
          }
        }
        setModelSwitchStatus(null);
        fetch('/api/generate/models').then(r => r.json()).then(d => {
          if (d.models) setFetchedModels(d.models);
        });
      } catch {
        setModelSwitchStatus(null);
        return;
      }
    }

    // Bascule de Gradio vers le nouveau modèle
    if (!modelInfo?.is_active) {
      setModelSwitchStatus(`${t('loadingModelStatus') || 'Loading'} ${getModelDisplayName(modelId)}...`);
      try {
        const switchRes = await fetch('/api/generate/switch-model', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ model: modelId, lmModel, lmBackend }),
        });
        const switchData = await switchRes.json();
        if (switchData.success) {
          lmEditingRef.current = false;
          fetch('/api/generate/models').then(r => r.json()).then(d => {
            if (d.models) setFetchedModels(d.models);
          });
        }
      } catch {
        // Silencieux : le polling du parent finira par refléter l'état réel
      }
      setModelSwitchStatus(null);
    }
  };

  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <div className={`w-2 h-2 rounded-full ${
          modelLoadingState.state === 'loading' || modelLoadingState.state === 'unloading' ? 'bg-orange-400 animate-pulse' :
          modelLoadingState.backendDown ? 'bg-red-500' :
          modelLoadingState.connected ? 'bg-green-500' :
          'bg-yellow-500 animate-pulse'
        }`}></div>
        <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
          {modelLoadingState.backendDown ? t('backendOff') || 'Backend off' :
           modelLoadingState.state === 'loading' ? t('modelLoading') || 'Loading model...' :
           modelLoadingState.state === 'unloading' ? t('modelUnloading') || 'Unloading...' :
           modelLoadingState.connected ? 'ACE-Step v1.5' :
           t('gradioStarting') || 'Gradio starting...'}
        </span>
      </div>

      <div className="relative" ref={modelMenuRef}>
        <button
          onClick={() => setShowModelMenu(!showModelMenu)}
          className="bg-zinc-200 dark:bg-black/40 border border-zinc-300 dark:border-white/5 rounded-md px-3 py-1.5 text-[11px] font-medium text-zinc-900 dark:text-white hover:bg-zinc-300 dark:hover:bg-black/50 transition-colors flex items-center gap-2 whitespace-nowrap"
          disabled={availableModels.length === 0}
        >
          {modelLoadingState.state === 'loading' ? (
            <><span className="w-1.5 h-1.5 rounded-full bg-orange-400 animate-pulse"></span> {getModelDisplayName(modelLoadingState.model)}...</>
          ) : modelLoadingState.state === 'unloading' ? (
            <><span className="w-1.5 h-1.5 rounded-full bg-orange-400 animate-pulse"></span> {t('modelUnloading') || 'Unloading...'}</>
          ) : (
            <><span className="w-1.5 h-1.5 rounded-full bg-green-500"></span> {getModelDisplayName(selectedModel)}</>
          )}
          <ChevronDown size={10} className="text-zinc-600 dark:text-zinc-400" />
        </button>

        {showModelMenu && availableModels.length > 0 && (
          <div className="absolute top-full right-0 mt-1 w-72 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-xl shadow-2xl z-50 overflow-hidden">
            <div className="max-h-96 overflow-y-auto custom-scrollbar">
              {availableModels.map(model => (
                <button
                  key={model.id}
                  onClick={() => handleSelect(model.id)}
                  className={`w-full px-4 py-3 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors border-b border-zinc-100 dark:border-zinc-800 last:border-b-0 ${
                    selectedModel === model.id ? 'bg-zinc-50 dark:bg-zinc-800/50' : ''
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-zinc-900 dark:text-white">
                        {getModelDisplayName(model.id)}
                      </span>
                      {modelLoadingState.model === model.id && modelLoadingState.state === 'loading' ? (
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400 animate-pulse">
                          {t('modelLoadingBadge') || 'loading...'}
                        </span>
                      ) : modelLoadingState.model === model.id && modelLoadingState.state === 'unloading' ? (
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 animate-pulse">
                          {t('modelUnloadingBadge') || 'unloading...'}
                        </span>
                      ) : fetchedModels.find(m => m.name === model.id)?.is_active ? (
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">
                          {t('modelInMemory') || 'in memory'}
                        </span>
                      ) : fetchedModels.find(m => m.name === model.id)?.is_preloaded ? (
                        <span className="px-1.5 py-0.5 rounded text-[9px] text-zinc-500 dark:text-zinc-500">
                          {t('modelDownloaded') || 'downloaded'}
                        </span>
                      ) : (
                        <span className="px-1.5 py-0.5 rounded text-[9px] text-zinc-600 dark:text-zinc-600">
                          {t('modelNotDownloaded') || 'not downloaded'}
                        </span>
                      )}
                    </div>
                    {selectedModel === model.id && (
                      <div className="w-4 h-4 rounded-full bg-pink-500 flex items-center justify-center">
                        <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                        </svg>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">
                      {MODEL_INFO[model.id]
                        ? `${MODEL_INFO[model.id].size} · ${MODEL_INFO[model.id].steps} ${t('steps') || 'steps'} · ${t(MODEL_INFO[model.id].descKey) || MODEL_INFO[model.id].descFallback}`
                        : model.id}
                    </p>
                    {(fetchedModels.find(m => m.name === model.id) as any)?.is_custom && (
                      <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400">
                        {t('modelCustom')}
                      </span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
