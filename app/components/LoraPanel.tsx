/* ============================================================================
 * LoraPanel.tsx — panneau de contrôle des adaptateurs LoRA
 *
 * Extrait de CreatePanel.tsx (étape 1 du découpage).
 * Gère 6 de ses 7 états en interne ; seul `loraLoaded` remonte au parent,
 * qui en a besoin pour deux choses :
 *   - l'inclure dans les paramètres de génération
 *   - désactiver `thinking` et `useAdg` quand un LoRA est actif
 *
 * Le déchargement automatique au changement de modèle est géré ici : le
 * composant surveille la prop `selectedModel`.
 * ==========================================================================*/

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Sliders, ChevronDown } from 'lucide-react';
import { generateApi } from '../../services/api';
import { EditableSlider } from '../EditableSlider';

interface LoraPanelProps {
  token: string | null;
  t: (key: string) => string;
  /** Modèle actif — un changement déclenche le déchargement du LoRA. */
  selectedModel: string;
  /** État remonté au parent (paramètres de génération + arbitrages). */
  loraLoaded: boolean;
  onLoadedChange: (loaded: boolean) => void;
}

export const LoraPanel: React.FC<LoraPanelProps> = ({
  token,
  t,
  selectedModel,
  loraLoaded,
  onLoadedChange,
}) => {
  /* -- État local --------------------------------------------------------- */
  const [showPanel, setShowPanel] = useState(false);
  const [loraPath, setLoraPath] = useState('./lora_output/final/adapter');
  const [loraEnabled, setLoraEnabled] = useState(true);
  const [loraScale, setLoraScale] = useState(1.0);
  const [loraError, setLoraError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const previousModelRef = useRef(selectedModel);

  /* -- Handlers API -------------------------------------------------------- */

  const handleUnload = useCallback(async () => {
    if (!token) return;
    setIsLoading(true);
    setLoraError(null);
    try {
      const result = await generateApi.unloadLora(token);
      onLoadedChange(false);
      console.log('LoRA unloaded:', result?.message);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to unload LoRA';
      setLoraError(message);
      console.error('Unload error:', err);
    } finally {
      setIsLoading(false);
    }
  }, [token, onLoadedChange]);

  const handleToggle = useCallback(async () => {
    if (!token) {
      setLoraError('Please sign in to use LoRA');
      return;
    }
    if (!loraPath.trim()) {
      setLoraError('Please enter a LoRA path');
      return;
    }

    if (loraLoaded) {
      await handleUnload();
      return;
    }

    setIsLoading(true);
    setLoraError(null);
    try {
      const result = await generateApi.loadLora({ lora_path: loraPath }, token);
      onLoadedChange(true);
      console.log('LoRA loaded:', result?.message);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'LoRA operation failed';
      setLoraError(message);
      console.error('LoRA error:', err);
    } finally {
      setIsLoading(false);
    }
  }, [token, loraPath, loraLoaded, handleUnload, onLoadedChange]);

  const handleScaleChange = useCallback(async (newScale: number) => {
    setLoraScale(newScale);
    if (!token || !loraLoaded) return;
    try {
      await generateApi.setLoraScale({ scale: newScale }, token);
    } catch (err) {
      console.error('Failed to set LoRA scale:', err);
    }
  }, [token, loraLoaded]);

  const handleEnabledToggle = useCallback(async () => {
    if (!token || !loraLoaded) return;
    const newEnabled = !loraEnabled;
    setLoraEnabled(newEnabled);
    try {
      await generateApi.toggleLora({ enabled: newEnabled }, token);
    } catch (err) {
      console.error('Failed to toggle LoRA:', err);
      setLoraEnabled(!newEnabled); // annulation en cas d'échec
    }
  }, [token, loraLoaded, loraEnabled]);

  /* -- Déchargement automatique au changement de modèle -------------------- */
  useEffect(() => {
    if (previousModelRef.current !== selectedModel && loraLoaded) {
      void handleUnload();
    }
    previousModelRef.current = selectedModel;
  }, [selectedModel, loraLoaded, handleUnload]);

  /* -- Rendu --------------------------------------------------------------- */
  return (
    <>
      <button
        type="button"
        onClick={() => setShowPanel(!showPanel)}
        className="w-full flex items-center justify-between px-4 py-3 bg-white dark:bg-suno-card rounded-xl border border-zinc-200 dark:border-white/5 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-white/5 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Sliders size={16} className="text-zinc-500" />
          <span>LoRA</span>
        </div>
        <ChevronDown size={16} className={`text-zinc-500 transition-transform ${showPanel ? 'rotate-180' : ''}`} />
      </button>

      {showPanel && (
        <div className="bg-white dark:bg-suno-card rounded-xl border border-zinc-200 dark:border-white/5 p-4 space-y-4">

          {/* Chemin de l'adaptateur */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{t('loraPath')}</label>
            <input
              type="text"
              value={loraPath}
              onChange={(e) => setLoraPath(e.target.value)}
              placeholder={t('loraPathPlaceholder')}
              className="w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-3 py-2 text-xs text-zinc-900 dark:text-white placeholder-zinc-400 dark:placeholder-zinc-600 focus:outline-none focus:border-pink-500 dark:focus:border-pink-500 transition-colors"
            />
          </div>

          {/* Chargement / déchargement */}
          <div className="space-y-2">
            <div className="flex items-center justify-between py-2 border-t border-zinc-100 dark:border-white/5">
              <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${loraLoaded ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`}></div>
                <span className={`text-xs font-medium ${loraLoaded ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                  {loraLoaded ? t('loraLoaded') : t('loraUnloaded')}
                </span>
              </div>
              <button
                type="button"
                onClick={handleToggle}
                disabled={!loraPath.trim() || isLoading}
                className={`px-4 py-2 rounded-lg text-xs font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
                  loraLoaded
                    ? 'bg-gradient-to-r from-green-500 to-emerald-600 text-white shadow-lg shadow-green-500/20 hover:from-green-600 hover:to-emerald-700'
                    : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-700'
                }`}
              >
                {isLoading ? '...' : (loraLoaded ? t('loraUnload') : t('loraLoad'))}
              </button>
            </div>
            {loraError && (
              <div className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 px-2 py-1 rounded">
                {loraError}
              </div>
            )}
          </div>

          {/* Activation sans déchargement */}
          <div className={`flex items-center justify-between py-2 border-t border-zinc-100 dark:border-white/5 ${!loraLoaded ? 'opacity-40 pointer-events-none' : ''}`}>
            <label className="flex items-center gap-2 text-xs font-medium text-zinc-600 dark:text-zinc-400 cursor-pointer">
              <input
                type="checkbox"
                checked={loraEnabled}
                onChange={handleEnabledToggle}
                disabled={!loraLoaded}
                className="accent-pink-600"
              />
              {t('useLora') || 'Use LoRA'}
            </label>
          </div>

          {/* Intensité */}
          <div className={!loraLoaded || !loraEnabled ? 'opacity-40 pointer-events-none' : ''}>
            <EditableSlider
              label={t('loraScale')}
              value={loraScale}
              min={0}
              max={1}
              step={0.05}
              onChange={handleScaleChange}
              formatDisplay={(val) => val.toFixed(2)}
              helpText={t('loraScaleDescription')}
            />
          </div>
        </div>
      )}
    </>
  );
};
