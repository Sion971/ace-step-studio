import React, { useState, useCallback, useEffect } from 'react';
import { Settings, ChevronRight, RefreshCw, Cpu, Loader2 } from 'lucide-react';
import { trainingApi } from '../../services/api';
import { Section, FieldRow } from './TrainingUIComponents';

const DEVICES = ['auto', 'cuda', 'mps', 'xpu', 'cpu'];
const BACKENDS = ['pt', 'vllm', 'mlx'];

interface ModelConfigSectionProps {
  token: string | null;
  t: (key: string) => string;
}

export const ModelConfigSection: React.FC<ModelConfigSectionProps> = ({ token, t }) => {
  const [showModelConfig, setShowModelConfig] = useState(false);
  const [modelCheckpoints, setModelCheckpoints] = useState<string[]>([]);
  const [modelConfigs, setModelConfigs] = useState<string[]>([]);
  const [selectedCheckpoint, setSelectedCheckpoint] = useState('');
  const [selectedConfig, setSelectedConfig] = useState('');
  const [selectedDevice, setSelectedDevice] = useState('auto');
  const [selectedBackend, setSelectedBackend] = useState('pt');
  const [initLlm, setInitLlm] = useState(false);
  const [lmModelPath, setLmModelPath] = useState('');
  const [useFlashAttention, setUseFlashAttention] = useState(false);
  const [offloadToCpu, setOffloadToCpu] = useState(false);
  const [offloadDitToCpu, setOffloadDitToCpu] = useState(false);
  const [compileModel, setCompileModel] = useState(false);
  const [quantization, setQuantization] = useState(false);
  const [modelInitStatus, setModelInitStatus] = useState('');
  const [modelInitializing, setModelInitializing] = useState(false);

  const fetchCheckpoints = useCallback(async () => {
    if (!token) return;
    try {
      const result = await trainingApi.getCheckpoints(token);
      setModelCheckpoints(result.checkpoints);
      setModelConfigs(result.configs);
      if (result.checkpoints.length > 0 && !selectedCheckpoint) {
        setSelectedCheckpoint(result.checkpoints[0]);
      }
      if (result.configs.length > 0 && !selectedConfig) {
        setSelectedConfig(result.configs[0]);
      }
    } catch (err) {
      console.error('Failed to load checkpoints:', err);
    }
  }, [token, selectedCheckpoint, selectedConfig]);

  useEffect(() => {
    fetchCheckpoints();
  }, [fetchCheckpoints]);

  const handleInitModel = useCallback(async () => {
    if (!token) return;
    setModelInitializing(true);
    setModelInitStatus(t('initializingModel'));
    try {
      const result = await trainingApi.initModel({
        checkpoint: selectedCheckpoint,
        configPath: selectedConfig,
        device: selectedDevice,
        initLlm,
        lmModelPath,
        backend: selectedBackend,
        useFlashAttention,
        offloadToCpu,
        offloadDitToCpu,
        compileModel,
        quantization,
      }, token);
      setModelInitStatus(result.status || result.error || '');
    } catch (error) {
      const msg = error instanceof Error ? error.message : (t('failed') || 'Échec');
      setModelInitStatus(msg.includes('501') ? (t('useGradioUiToInit') || 'Utiliser l\'interface Gradio pour initialiser le modèle') : msg);
    } finally {
      setModelInitializing(false);
    }
  }, [token, selectedCheckpoint, selectedConfig, selectedDevice, initLlm, lmModelPath, selectedBackend, useFlashAttention, offloadToCpu, offloadDitToCpu, compileModel, quantization, t]);

  return (
    <Section title={
      <button onClick={() => setShowModelConfig(!showModelConfig)} className="flex items-center gap-1.5 w-full text-left">
        <Settings size={12} />
        <span>{t('modelConfiguration')}</span>
        <ChevronRight size={12} className={`ml-auto transition-transform ${showModelConfig ? 'rotate-90' : ''}`} />
      </button>
    }>
      {showModelConfig && (
        <div className="space-y-2 mt-2">
          <div className="flex gap-2 items-center">
            <FieldRow label="Checkpoint">
              <select value={selectedCheckpoint} onChange={e => setSelectedCheckpoint(e.target.value)} className="flex-1 bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-2 py-1 text-xs text-zinc-900 dark:text-zinc-200">
                {modelCheckpoints.map(c => <option key={c} value={c}>{c}</option>)}
                {modelCheckpoints.length === 0 && <option value="">{t('noCheckpointsFound')}</option>}
              </select>
            </FieldRow>
            <button onClick={fetchCheckpoints} className="p-1.5 bg-white/5 hover:bg-white/10 rounded-lg text-zinc-400">
              <RefreshCw size={12} />
            </button>
          </div>
          <FieldRow label="Config">
            <select value={selectedConfig} onChange={e => setSelectedConfig(e.target.value)} className="flex-1 bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-2 py-1 text-xs text-zinc-900 dark:text-zinc-200">
              {modelConfigs.map(c => <option key={c} value={c}>{c}</option>)}
              {modelConfigs.length === 0 && <option value="">{t('noConfigsFound')}</option>}
            </select>
          </FieldRow>
          <div className="grid grid-cols-2 gap-2">
            <FieldRow label="Device">
              <select value={selectedDevice} onChange={e => setSelectedDevice(e.target.value)} className="flex-1 bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-2 py-1 text-xs text-zinc-900 dark:text-zinc-200">
                {DEVICES.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </FieldRow>
            <FieldRow label="Backend">
              <select value={selectedBackend} onChange={e => setSelectedBackend(e.target.value)} className="flex-1 bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-2 py-1 text-xs text-zinc-900 dark:text-zinc-200">
                {BACKENDS.map(b => <option key={b} value={b}>{b}</option>)}
              </select>
            </FieldRow>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <label className="flex items-center gap-1.5 text-[10px] text-zinc-400">
              <input type="checkbox" checked={initLlm} onChange={e => setInitLlm(e.target.checked)} className="w-3 h-3 accent-pink-500" />
              Init LLM
            </label>
            <label className="flex items-center gap-1.5 text-[10px] text-zinc-400">
              <input type="checkbox" checked={useFlashAttention} onChange={e => setUseFlashAttention(e.target.checked)} className="w-3 h-3 accent-pink-500" />
              Flash Attention
            </label>
            <label className="flex items-center gap-1.5 text-[10px] text-zinc-400">
              <input type="checkbox" checked={offloadToCpu} onChange={e => setOffloadToCpu(e.target.checked)} className="w-3 h-3 accent-pink-500" />
              Offload CPU
            </label>
            <label className="flex items-center gap-1.5 text-[10px] text-zinc-400">
              <input type="checkbox" checked={offloadDitToCpu} onChange={e => setOffloadDitToCpu(e.target.checked)} className="w-3 h-3 accent-pink-500" />
              Offload DiT CPU
            </label>
            <label className="flex items-center gap-1.5 text-[10px] text-zinc-400">
              <input type="checkbox" checked={compileModel} onChange={e => setCompileModel(e.target.checked)} className="w-3 h-3 accent-pink-500" />
              Compile
            </label>
            <label className="flex items-center gap-1.5 text-[10px] text-zinc-400">
              <input type="checkbox" checked={quantization} onChange={e => setQuantization(e.target.checked)} className="w-3 h-3 accent-pink-500" />
              Quantization
            </label>
          </div>
          {initLlm && (
            <FieldRow label={t('lmModel') || 'Modèle LM'}>
              <input type="text" value={lmModelPath} onChange={e => setLmModelPath(e.target.value)} placeholder={t('lmModelPath') || 'Chemin du modèle LM'} className="flex-1 bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-2 py-1 text-xs text-zinc-900 dark:text-zinc-200" />
          </FieldRow>
          )}
          <button onClick={handleInitModel} disabled={modelInitializing} className="w-full py-1.5 bg-blue-500/20 hover:bg-blue-500/30 text-blue-400 rounded-lg text-xs font-medium flex items-center justify-center gap-1.5 disabled:opacity-50">
            {modelInitializing ? <Loader2 size={12} className="animate-spin" /> : <Cpu size={12} />}
            {t('initializeService')}
          </button>
          {modelInitStatus && <p className="text-[10px] text-zinc-400 break-words">{modelInitStatus}</p>}
        </div>
      )}
    </Section>
  );
};
