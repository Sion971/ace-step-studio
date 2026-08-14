import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  Square, FolderOpen, Loader2,
  AlertCircle, CheckCircle2, ArrowRightLeft, GitMerge, Layers,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useI18n } from '../context/I18nContext';

type ToolTab = 'bf16' | 'merge' | 'bake';

interface AnalyzeResult {
  sourceType: string;
  displayName: string;
  safetensorCount: number;
  supportCount: number;
  totalSizeMb: number;
  hasIndex?: boolean;
}

interface ToolStatus {
  status: 'idle' | 'running' | 'done' | 'error';
  error?: string;
  lastEvent?: Record<string, unknown>;
  events?: Array<Record<string, unknown>>;
  totalEvents?: number;
  elapsed?: number;
}

// ── Shared Section component (defined before usage) ──────────────────

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="bg-white/[0.02] border border-white/5 rounded-xl p-3">
    <h3 className="text-xs font-semibold text-zinc-300 mb-2">{title}</h3>
    {children}
  </div>
);

// ── Shared helpers ───────────────────────────────────────────────────

function useAuthHeaders() {
  const { token } = useAuth();
  const headersRef = useRef({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });
  useEffect(() => {
    headersRef.current = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  }, [token]);
  return headersRef;
}

interface ModelEntry {
  name: string;
  path: string;
  sizeMb: number;
  safetensorCount: number;
  isBf16: boolean;
}

function useModelList() {
  const headersRef = useAuthHeaders();
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [checkpointsDir, setCheckpointsDir] = useState('');
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/tools/models', { headers: headersRef.current });
      if (res.ok) {
        const data = await res.json();
        setModels(data.models || []);
        setCheckpointsDir(data.checkpointsDir || '');
      }
    } catch {} finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return { models, checkpointsDir, loading, refresh };
}

function formatEventLog(e: Record<string, unknown>): string | null {
  switch (e.event) {
    case 'tensor_progress': return null; // skip, shown in progress bar
    case 'file_start': return `Converting: ${e.file} (${e.file_idx}/${e.total_files})`;
    case 'file_done': return `Done: ${e.file} (${e.tensors} tensors)`;
    case 'status': return String(e.message);
    case 'done': return `Complete! ${e.source_size_mb ?? ''}MB → ${e.output_size_mb ?? ''}MB ${e.savings_pct ? `(${e.savings_pct}% saved)` : ''}`.trim();
    case 'analyze': return `Source: ${e.display_name} | ${e.safetensor_count ?? e.files_a ?? ''} safetensors`;
    case 'error': return `Error: ${e.message}`;
    default: return JSON.stringify(e);
  }
}

/** Shared polling hook for tool processes */
function useToolPolling(endpoint: string) {
  const headersRef = useAuthHeaders();
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [status, setStatus] = useState<ToolStatus>({ status: 'idle' });
  const [log, setLog] = useState<string[]>([]);
  const logEndRef = useRef<HTMLSpanElement>(null);
  const startPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(endpoint, { headers: headersRef.current });
        if (!res.ok) return;
        const data: ToolStatus = await res.json();
        setStatus(data);

        if (data.events && data.events.length > 0) {
          const newLines = data.events
            .map(formatEventLog)
            .filter((l): l is string => l !== null);
          if (newLines.length > 0) {
            setLog(prev => [...prev, ...newLines].slice(-200));
          }
        }

        if (data.status === 'done' || data.status === 'error') {
          if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
        }
      } catch {
        // Connection lost — will retry on next interval
      }
    }, 500);
  }, [endpoint]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  const reset = useCallback(() => {
    setStatus({ status: 'idle' });
    setLog([]);
  }, []);

  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [log]);

  return { status, log, logEndRef, startPolling, stopPolling, reset, setStatus, setLog };
}

// ── Progress display component ───────────────────────────────────────

const ProgressSection: React.FC<{
  title: string;
  status: ToolStatus;
  log: string[];
  logEndRef: React.RefObject<HTMLSpanElement | null>;
  barColor: string;
  spinnerColor: string;
  doneText: string;
  runningText: string;
}> = ({ title, status, log, logEndRef, barColor, spinnerColor, doneText, runningText }) => {
  const isRunning = status.status === 'running';
  const isDone = status.status === 'done';
  const isError = status.status === 'error';

  const lastEvt = status.lastEvent;
  const progressText = lastEvt?.event === 'tensor_progress'
    ? `${lastEvt.file}: ${lastEvt.current}/${lastEvt.total} tensors (file ${lastEvt.file_idx}/${lastEvt.total_files})`
    : isDone && lastEvt?.event === 'done'
    ? `${lastEvt.source_size_mb ?? ''}MB → ${lastEvt.output_size_mb ?? ''}MB ${lastEvt.savings_pct ? `(${lastEvt.savings_pct}% saved)` : ''}`.trim()
    : isError ? (status.error || 'Error') : runningText;
  const progressPct = lastEvt?.event === 'tensor_progress' && lastEvt.total
    ? Math.round((Number(lastEvt.current) / Number(lastEvt.total)) * 100)
    : isDone ? 100 : 0;

  return (
    <Section title={title}>
      <div className="mb-2">
        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] text-zinc-400">{progressText}</span>
          <span className="text-[10px] text-zinc-500">{progressPct}%</span>
        </div>
        <div className="w-full h-1.5 bg-black/20 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-300 ${isDone ? 'bg-green-500' : isError ? 'bg-red-500' : barColor}`}
            style={{ width: `${progressPct}%` }}
          />
        </div>
      </div>

      <div className="flex items-center gap-2 mb-2">
        {isRunning && <Loader2 size={14} className={`animate-spin ${spinnerColor}`} />}
        {isDone && <CheckCircle2 size={14} className="text-green-400" />}
        {isError && <AlertCircle size={14} className="text-red-400" />}
        <span className={`text-xs ${isDone ? 'text-green-400' : isError ? 'text-red-400' : 'text-zinc-300'}`}>
          {isDone ? doneText : isError ? (status.error || 'Error') : runningText}
        </span>
        {status.elapsed && (
          <span className="text-[10px] text-zinc-500 ml-auto">
            {Math.round(status.elapsed / 1000)}s
          </span>
        )}
      </div>

      {log.length > 0 && (
        <pre className="text-[10px] text-zinc-400 bg-black/20 rounded-lg p-2 max-h-32 overflow-y-auto whitespace-pre-wrap">
          {log.join('\n')}
          <span ref={logEndRef} />
        </pre>
      )}
    </Section>
  );
};

// ── BF16 Converter Tool ──────────────────────────────────────────────

const BF16Tool: React.FC = () => {
  const headersRef = useAuthHeaders();
  const { t } = useI18n();
  const { models, checkpointsDir, refresh: refreshModels } = useModelList();

  const [selectedModel, setSelectedModel] = useState('');

  const { status, log, logEndRef, startPolling, stopPolling, reset, setStatus, setLog } =
    useToolPolling('/api/tools/bf16/status');

  // Filter: only non-bf16 models (candidates for conversion)
  const convertibleModels = models.filter(m => !m.isBf16);
  const selected = models.find(m => m.name === selectedModel);

  const handleStart = useCallback(async () => {
    if (!selected) return;
    reset();
    setStatus({ status: 'running' });
    setLog([`${t('bf16Title')} ${t('toolStarted')}`]);

    await fetch('/api/tools/bf16/reset', { method: 'POST', headers: headersRef.current }).catch(() => {});

    try {
      // Source = selected model path, output = same checkpoints dir (script creates -bf16 subfolder)
      const res = await fetch('/api/tools/bf16/start', {
        method: 'POST', headers: headersRef.current,
        body: JSON.stringify({ sourcePath: selected.path, outputDir: checkpointsDir }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to start');
      startPolling();
    } catch (e) {
      setStatus({ status: 'error', error: e instanceof Error ? e.message : 'Failed' });
    }
  }, [selected, checkpointsDir, startPolling, reset, setStatus, setLog]);

  const handleStop = useCallback(async () => {
    await fetch('/api/tools/bf16/stop', { method: 'POST', headers: headersRef.current }).catch(() => {});
    stopPolling();
    setStatus({ status: 'error', error: t('toolCancelled') });
    setLog(prev => [...prev, t('toolCancelled')]);
  }, [stopPolling, setStatus, setLog]);

  // Refresh model list when conversion finishes
  useEffect(() => {
    if (status.status === 'done') refreshModels();
  }, [status.status, refreshModels]);

  const isRunning = status.status === 'running';

  return (
    <div className="space-y-3">
      <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-3">
        <p className="text-xs text-blue-300">{t('bf16Description')}</p>
      </div>

      <Section title={t('bf16Source')}>
        <select
          value={selectedModel}
          onChange={e => setSelectedModel(e.target.value)}
          className="w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm text-zinc-900 dark:text-zinc-200 focus:outline-none focus:border-pink-500/50 [&>option]:bg-white [&>option]:dark:bg-zinc-800"
        >
          <option value="">{t('bf16SelectModel')}</option>
          {convertibleModels.map(m => (
            <option key={m.name} value={m.name}>
              {m.name} — {m.sizeMb} MB ({m.safetensorCount} files) → ~{Math.round(m.sizeMb / 2)} MB
            </option>
          ))}
        </select>
        {selected && (
          <p className="text-[10px] text-zinc-500 mt-1.5">
            {t('bf16OutputHint')} → {selected.name}-bf16
          </p>
        )}
        {convertibleModels.length === 0 && (
          <p className="text-[10px] text-zinc-500 mt-1.5">{t('bf16NoModels')}</p>
        )}
      </Section>

      <div className="flex gap-2">
        {!isRunning ? (
          <button onClick={handleStart} disabled={!selected}
            className="flex-1 py-2.5 bg-gradient-to-r from-blue-500 to-cyan-600 hover:from-blue-600 hover:to-cyan-700 text-white rounded-lg text-sm font-medium flex items-center justify-center gap-2 disabled:opacity-50">
            <ArrowRightLeft size={16} />
            {t('bf16Start')}
          </button>
        ) : (
          <button onClick={handleStop}
            className="flex-1 py-2.5 bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded-lg text-sm font-medium flex items-center justify-center gap-2">
            <Square size={16} />
            {t('bf16Stop')}
          </button>
        )}
      </div>

      {status.status !== 'idle' && (
        <ProgressSection
          title={t('bf16Progress')} status={status} log={log} logEndRef={logEndRef}
          barColor="bg-blue-500" spinnerColor="text-blue-400" doneText={t('bf16Done')} runningText={t('bf16Running')}
        />
      )}
    </div>
  );
};

// ── Merge Tool ───────────────────────────────────────────────────────

const MergeTool: React.FC = () => {
  const headersRef = useAuthHeaders();
  const { t } = useI18n();
  const { models, checkpointsDir, refresh: refreshModels } = useModelList();

  const [modelAName, setModelAName] = useState('');
  const [modelBName, setModelBName] = useState('');
  const [outputName, setOutputName] = useState('');
  const [alpha, setAlpha] = useState(0.5);
  const [method, setMethod] = useState('weighted_sum');

  const { status, log, logEndRef, startPolling, stopPolling, reset, setStatus, setLog } =
    useToolPolling('/api/tools/merge/status');

  const modelA = models.find(m => m.name === modelAName);
  const modelB = models.find(m => m.name === modelBName);

  // Auto-generate output name from selections
  const autoOutputName = modelAName && modelBName
    ? `${modelAName.replace(/\//g, '-')}-x-${modelBName.replace(/\//g, '-')}-a${alpha.toFixed(2)}`
    : '';
  const finalOutputName = outputName.trim() || autoOutputName;

  const handleStart = useCallback(async () => {
    if (!modelA || !modelB || !finalOutputName) return;
    reset();
    setStatus({ status: 'running' });
    setLog([`${t('mergeTitle')} ${t('toolStarted')}`]);

    const outputPath = `${checkpointsDir}/${finalOutputName}`;

    await fetch('/api/tools/merge/reset', { method: 'POST', headers: headersRef.current }).catch(() => {});

    try {
      const res = await fetch('/api/tools/merge/start', {
        method: 'POST', headers: headersRef.current,
        body: JSON.stringify({ modelA: modelA.path, modelB: modelB.path, outputDir: outputPath, alpha, method }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to start');
      startPolling();
    } catch (e) {
      setStatus({ status: 'error', error: e instanceof Error ? e.message : 'Failed' });
    }
  }, [modelA, modelB, finalOutputName, checkpointsDir, alpha, startPolling, reset, setStatus, setLog]);

  const handleStop = useCallback(async () => {
    await fetch('/api/tools/merge/stop', { method: 'POST', headers: headersRef.current }).catch(() => {});
    stopPolling();
    setStatus({ status: 'error', error: t('toolCancelled') });
    setLog(prev => [...prev, t('toolCancelled')]);
  }, [stopPolling, setStatus, setLog]);

  useEffect(() => {
    if (status.status === 'done') refreshModels();
  }, [status.status, refreshModels]);

  const isRunning = status.status === 'running';
  const selectClass = "w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm text-zinc-900 dark:text-zinc-200 focus:outline-none focus:border-pink-500/50 [&>option]:bg-white [&>option]:dark:bg-zinc-800";

  return (
    <div className="space-y-3">
      <div className="bg-purple-500/10 border border-purple-500/20 rounded-xl p-3">
        <p className="text-xs text-purple-300">{t('mergeDescription')}</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Section title={`${t('mergeModelA')} (base)`}>
          <select value={modelAName} onChange={e => setModelAName(e.target.value)} className={selectClass}>
            <option value="">{t('bf16SelectModel')}</option>
            {models.map(m => (
              <option key={m.name} value={m.name}>{m.name} — {m.sizeMb} MB</option>
            ))}
          </select>
        </Section>
        <Section title={`${t('mergeModelB')} (merge)`}>
          <select value={modelBName} onChange={e => setModelBName(e.target.value)} className={selectClass}>
            <option value="">{t('bf16SelectModel')}</option>
            {models.filter(m => m.name !== modelAName).map(m => (
              <option key={m.name} value={m.name}>{m.name} — {m.sizeMb} MB</option>
            ))}
          </select>
        </Section>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <Section title={t('mergeMethod')}>
          <select value={method} onChange={e => setMethod(e.target.value)} className={selectClass}>
            <option value="weighted_sum">{t('mergeMethodWeightedSum')}</option>
            <option value="add_difference">{t('mergeMethodAddDiff')}</option>
            <option value="multiply">{t('mergeMethodMultiply')}</option>
          </select>
          <p className="text-[10px] text-zinc-500 mt-1">
            {method === 'weighted_sum' && '(1-α)×A + α×B'}
            {method === 'add_difference' && 'A + α×(B-A)'}
            {method === 'multiply' && 'A × (B/A)^α'}
          </p>
        </Section>
        <Section title={`${t('mergeAlpha')} (${alpha.toFixed(2)})`}>
          <input type="range" min={0} max={1} step={0.05} value={alpha}
            onChange={e => setAlpha(parseFloat(e.target.value))}
            className="w-full accent-purple-500 h-1.5" />
          <div className="flex justify-between text-[10px] text-zinc-500 mt-0.5">
            <span>0 = {t('mergeModelA')}</span>
            <span>1 = {t('mergeModelB')}</span>
          </div>
        </Section>
        <Section title={`${t('mergeOutput')} (${t('optional')})`}>
          <input type="text" value={outputName} onChange={e => setOutputName(e.target.value)}
            placeholder={autoOutputName || 'my-merged-model'}
            className="w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-3 py-1.5 text-sm text-zinc-900 dark:text-zinc-200 focus:outline-none focus:border-pink-500/50" />
          {finalOutputName && (
            <p className="text-[10px] text-zinc-500 mt-1 truncate">→ checkpoints/{finalOutputName}</p>
          )}
        </Section>
      </div>

      <div className="flex gap-2">
        {!isRunning ? (
          <button onClick={handleStart} disabled={!modelA || !modelB}
            className="flex-1 py-2.5 bg-gradient-to-r from-purple-500 to-pink-600 hover:from-purple-600 hover:to-pink-700 text-white rounded-lg text-sm font-medium flex items-center justify-center gap-2 disabled:opacity-50">
            <GitMerge size={16} />
            {t('mergeStart')}
          </button>
        ) : (
          <button onClick={handleStop}
            className="flex-1 py-2.5 bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded-lg text-sm font-medium flex items-center justify-center gap-2">
            <Square size={16} />
            {t('mergeStop')}
          </button>
        )}
      </div>

      {status.status !== 'idle' && (
        <ProgressSection
          title={t('mergeProgress')} status={status} log={log} logEndRef={logEndRef}
          barColor="bg-purple-500" spinnerColor="text-purple-400" doneText={t('mergeDone')} runningText={t('mergeRunning')}
        />
      )}
    </div>
  );
};

// ── Bake LoRA Tool ───────────────────────────────────────────────────

interface LoraEntry { name: string; path: string; sizeMb: number }

const BakeLoRATool: React.FC = () => {
  const headersRef = useAuthHeaders();
  const { t } = useI18n();
  const { models, checkpointsDir, refresh: refreshModels } = useModelList();

  const [baseModelName, setBaseModelName] = useState('');
  const [loraName, setLoraName] = useState('');
  const [outputName, setOutputName] = useState('');
  const [strength, setStrength] = useState(1.0);
  const [loras, setLoras] = useState<LoraEntry[]>([]);

  const { status, log, logEndRef, startPolling, stopPolling, reset, setStatus, setLog } =
    useToolPolling('/api/tools/bake/status');

  // Fetch LoRAs
  useEffect(() => {
    fetch('/api/tools/loras', { headers: headersRef.current })
      .then(r => r.ok ? r.json() : { loras: [] })
      .then(d => setLoras(d.loras || []))
      .catch(() => {});
  }, []);

  const baseModel = models.find(m => m.name === baseModelName);
  const lora = loras.find(l => l.name === loraName);

  const autoOutputName = baseModelName && loraName
    ? `${baseModelName.replace(/\//g, '-')}-${loraName}-s${strength.toFixed(1)}`
    : '';
  const finalOutputName = outputName.trim() || autoOutputName;

  const handleStart = useCallback(async () => {
    if (!baseModel || !lora || !finalOutputName) return;
    reset();
    setStatus({ status: 'running' });
    setLog([`${t('bakeTitle')} ${t('toolStarted')}`]);

    const outputPath = `${checkpointsDir}/${finalOutputName}`;
    await fetch('/api/tools/bake/reset', { method: 'POST', headers: headersRef.current }).catch(() => {});

    try {
      const res = await fetch('/api/tools/bake/start', {
        method: 'POST', headers: headersRef.current,
        body: JSON.stringify({ basePath: baseModel.path, loraPath: lora.path, outputDir: outputPath, strength }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to start');
      startPolling();
    } catch (e) {
      setStatus({ status: 'error', error: e instanceof Error ? e.message : 'Failed' });
    }
  }, [baseModel, lora, finalOutputName, checkpointsDir, strength, startPolling, reset, setStatus, setLog]);

  const handleStop = useCallback(async () => {
    await fetch('/api/tools/bake/stop', { method: 'POST', headers: headersRef.current }).catch(() => {});
    stopPolling();
    setStatus({ status: 'error', error: t('toolCancelled') });
    setLog(prev => [...prev, t('toolCancelled')]);
  }, [stopPolling, setStatus, setLog]);

  useEffect(() => {
    if (status.status === 'done') refreshModels();
  }, [status.status, refreshModels]);

  const isRunning = status.status === 'running';
  const selectClass = "w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm text-zinc-900 dark:text-zinc-200 focus:outline-none focus:border-pink-500/50 [&>option]:bg-white [&>option]:dark:bg-zinc-800";

  return (
    <div className="space-y-3">
      <div className="bg-orange-500/10 border border-orange-500/20 rounded-xl p-3">
        <p className="text-xs text-orange-300">{t('bakeDescription')}</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Section title={t('bakeBaseModel')}>
          <select value={baseModelName} onChange={e => setBaseModelName(e.target.value)} className={selectClass}>
            <option value="">{t('bf16SelectModel')}</option>
            {models.map(m => (
              <option key={m.name} value={m.name}>{m.name} — {m.sizeMb} MB</option>
            ))}
          </select>
        </Section>
        <Section title={t('bakeLoraAdapter')}>
          <select value={loraName} onChange={e => setLoraName(e.target.value)} className={selectClass}>
            <option value="">{t('bakeSelectLora')}</option>
            {loras.map(l => (
              <option key={l.name} value={l.name}>{l.name} — {l.sizeMb} MB</option>
            ))}
          </select>
          {loras.length === 0 && (
            <p className="text-[10px] text-zinc-500 mt-1">{t('bakeNoLoras')}</p>
          )}
        </Section>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Section title={`${t('bakeStrength')} (${strength.toFixed(2)})`}>
          <input type="range" min={0} max={2} step={0.05} value={strength}
            onChange={e => setStrength(parseFloat(e.target.value))}
            className="w-full accent-orange-500 h-1.5" />
          <div className="flex justify-between text-[10px] text-zinc-500 mt-0.5">
            <span>0 = {t('bakeNoEffect')}</span>
            <span>1 = {t('bakeFull')}</span>
            <span>2 = {t('bakeDouble')}</span>
          </div>
        </Section>
        <Section title={`${t('mergeOutput')} (${t('optional')})`}>
          <input type="text" value={outputName} onChange={e => setOutputName(e.target.value)}
            placeholder={autoOutputName || 'my-baked-model'}
            className="w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-3 py-1.5 text-sm text-zinc-900 dark:text-zinc-200 focus:outline-none focus:border-pink-500/50" />
          {finalOutputName && (
            <p className="text-[10px] text-zinc-500 mt-1 truncate">→ checkpoints/{finalOutputName}</p>
          )}
        </Section>
      </div>

      <div className="flex gap-2">
        {!isRunning ? (
          <button onClick={handleStart} disabled={!baseModel || !lora}
            className="flex-1 py-2.5 bg-gradient-to-r from-orange-500 to-amber-600 hover:from-orange-600 hover:to-amber-700 text-white rounded-lg text-sm font-medium flex items-center justify-center gap-2 disabled:opacity-50">
            <Layers size={16} />
            {t('bakeStart')}
          </button>
        ) : (
          <button onClick={handleStop}
            className="flex-1 py-2.5 bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded-lg text-sm font-medium flex items-center justify-center gap-2">
            <Square size={16} />
            {t('bakeStop')}
          </button>
        )}
      </div>

      {status.status !== 'idle' && (
        <ProgressSection
          title={t('bakeProgress')} status={status} log={log} logEndRef={logEndRef}
          barColor="bg-orange-500" spinnerColor="text-orange-400" doneText={t('bakeDone')} runningText={t('bakeRunning')}
        />
      )}
    </div>
  );
};

// ── Main ToolsPanel ──────────────────────────────────────────────────

export const ToolsPanel: React.FC = () => {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<ToolTab>('bf16');

  const tabs: { id: ToolTab; label: string; icon: React.ReactNode }[] = [
    { id: 'bf16', label: t('bf16Title'), icon: <ArrowRightLeft size={14} /> },
    { id: 'merge', label: t('mergeTitle'), icon: <GitMerge size={14} /> },
    { id: 'bake', label: t('bakeTitle'), icon: <Layers size={14} /> },
  ];

  return (
    <div className="h-full w-full flex flex-col bg-zinc-50 dark:bg-suno-panel overflow-hidden">
      <div className="px-4 pt-4 pb-2 flex-shrink-0">
        <h2 className="text-lg font-bold text-zinc-900 dark:text-white">{t('tools')}</h2>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">{t('toolsDescription')}</p>
      </div>

      <div className="flex px-4 gap-1 flex-shrink-0">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${activeTab === tab.id ? 'bg-pink-500/20 text-pink-400 border border-pink-500/30' : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/5'}`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 scrollbar-hide max-w-6xl mx-auto w-full">
        {activeTab === 'bf16' && <BF16Tool />}
        {activeTab === 'merge' && <MergeTool />}
        {activeTab === 'bake' && <BakeLoRATool />}
      </div>
    </div>
  );
};
