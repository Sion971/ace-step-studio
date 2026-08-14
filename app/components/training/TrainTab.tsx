/* ============================================================================
 * TrainTab.tsx — onglet « Entraîner le LoRA »
 *
 * Stratégie A : l'entraînement est délégué au CLI Side-Step (`train.py fixed`)
 * lancé par Express, plus au serveur Gradio.
 *
 * Conséquence sur le flux :
 *   AVANT  POST /start bloquant → timeout HTTP passé quelques minutes
 *   APRÈS  POST /start rend la main tout de suite, puis polling sur /status
 *
 * Prérequis : api.ts doit exposer trainingStatus() et restartPipeline()
 * (voir les instructions en bas de training-routes.ts).
 * ==========================================================================*/

import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { FolderOpen, Play, Square, RotateCw, Copy, Check } from 'lucide-react';
import { trainingApi } from '../../services/api';
import { Section, FieldRow, ParamSlider } from './TrainingUIComponents';

/* ----------------------------------------------------------------------------
 * 1. TYPES
 * -------------------------------------------------------------------------*/

type PipelineStepKey = 'upload' | 'edit' | 'save' | 'preprocess' | 'train' | 'export';

type TrainingState = 'idle' | 'starting' | 'running' | 'completed' | 'error' | 'stopped';

interface TrainingStatus {
  state: TrainingState;
  message: string;
  pid: number | null;
  epoch: number;
  totalEpochs: number;
  loss: number | null;
  bestLoss: number | null;
  lastEpochSec: number | null;
  etaSec: number | null;
  lastCheckpoint: string | null;
  trainableParams: number | null;
  elapsedSec: number | null;
  metrics: { epoch: number; loss: number }[];
  log: string;
  lastError: string | null;
  outputPath: string | null;
}

interface TrainTabProps {
  token: string | null;
  t: (key: string) => string;
  markStep: (step: PipelineStepKey) => void;
}

/* ----------------------------------------------------------------------------
 * 2. CONSTANTES
 * -------------------------------------------------------------------------*/

const POLL_INTERVAL_MS = 1500;

const MODEL_VARIANTS = ['base', 'sft', 'turbo', 'xl_base', 'xl_sft', 'xl_turbo'];
const OPTIMIZERS = ['adamw8bit', 'adamw', 'adafactor', 'prodigy'];
const PRECISIONS = ['bf16', 'fp16', 'fp32', 'auto'];

const ACTIVE_STATES: TrainingState[] = ['starting', 'running'];

const INPUT_CLASS =
  'bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 ' +
  'rounded-lg px-3 py-1.5 text-sm text-zinc-900 dark:text-zinc-200';

/* ----------------------------------------------------------------------------
 * 3. HELPERS
 * -------------------------------------------------------------------------*/

const formatDuration = (sec: number | null): string => {
  if (sec == null || !Number.isFinite(sec)) return '--';
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m ${String(s).padStart(2, '0')}s`;
};

/* ----------------------------------------------------------------------------
 * 4. SOUS-COMPOSANT — courbe de loss
 * -------------------------------------------------------------------------*/

const LossChart: React.FC<{ points: { epoch: number; loss: number }[] }> = ({ points }) => {
  const svg = useMemo(() => {
    if (points.length < 2) return null;

    const width = 280;
    const height = 100;
    const pad = 6;

    const xs = points.map(p => p.epoch);
    const ys = points.map(p => p.loss);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const rangeX = maxX - minX || 1;
    const rangeY = maxY - minY || 1;

    const poly = points
      .map(p => {
        const x = pad + ((p.epoch - minX) / rangeX) * (width - 2 * pad);
        const y = pad + (1 - (p.loss - minY) / rangeY) * (height - 2 * pad);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');

    return { width, height, pad, poly, minX, maxX, minY, maxY };
  }, [points]);

  if (!svg) return null;

  return (
    <svg
      viewBox={`0 0 ${svg.width} ${svg.height}`}
      className="w-full"
      role="img"
      aria-label="Courbe de perte"
    >
      <polyline
        points={svg.poly}
        fill="none"
        stroke="rgb(236 72 153)"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <text x={svg.pad} y={svg.height - 2} fontSize="8" fill="rgb(113 113 122)" fontFamily="monospace">
        {svg.minX}
      </text>
      <text x={svg.width - svg.pad} y={svg.height - 2} fontSize="8" fill="rgb(113 113 122)"
            fontFamily="monospace" textAnchor="end">
        {svg.maxX}
      </text>
      <text x={svg.pad} y={10} fontSize="8" fill="rgb(113 113 122)" fontFamily="monospace">
        {svg.maxY.toFixed(3)}
      </text>
    </svg>
  );
};

/* ----------------------------------------------------------------------------
 * 5. COMPOSANT PRINCIPAL
 * -------------------------------------------------------------------------*/

export const TrainTab: React.FC<TrainTabProps> = ({ token, t, markStep }) => {

  /* -- 5.1 Paramètres ----------------------------------------------------- */
  const [params, setParams] = useState({
    // Données / modèle
    checkpointDir: './checkpoints',
    modelVariant: 'base',
    tensorDir: './datasets/preprocessed_tensors',
    outputDir: './lora_output',

    // Adaptateur
    adapterType: 'lora' as 'lora' | 'lokr',
    rank: 16,
    alpha: 32,
    dropout: 0.1,

    // Entraînement
    learningRate: 0.0001,
    batchSize: 1,
    gradientAccumulation: 4,
    epochs: 100,
    seed: 42,
    shift: 3.0,
    saveEvery: 10,
    resumeCheckpoint: '',

    // Mémoire
    precision: 'bf16',
    optimizerType: 'adamw8bit',
    gradientCheckpointing: true,
    offloadEncoder: true,
    numWorkers: 0,

    // Le serveur Gradio garde le DiT résident (~6,8 Go). Sur une carte 8 Go
    // l'entraînement ne passe pas sans l'arrêter.
    freeVram: true,
  });

  const set = useCallback(<K extends keyof typeof params>(key: K, value: typeof params[K]) => {
    setParams(p => ({ ...p, [key]: value }));
  }, []);

  /* -- 5.2 État runtime --------------------------------------------------- */
  const [status, setStatus] = useState<TrainingStatus | null>(null);
  const [tensorInfo, setTensorInfo] = useState('');
  const [actionError, setActionError] = useState('');
  const [pipelineStopped, setPipelineStopped] = useState(false);
  const [copied, setCopied] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);
  const markedRef = useRef(false);

  const isActive = status ? ACTIVE_STATES.includes(status.state) : false;

  /* -- 5.3 Polling -------------------------------------------------------- */
  /**
   * On interroge /status en continu tant qu'un entraînement tourne, et une fois
   * au montage : si l'utilisateur recharge la page pendant un entraînement, il
   * doit retrouver la progression en cours (l'état vit côté serveur).
   */
  useEffect(() => {
    if (!token) return;
    let cancelled = false;

    const timer = setInterval(async () => {
      try {
        const s = await trainingApi.trainingStatus(token);
        if (cancelled) return;
        setStatus(s);
        if (s.state === 'completed' && !markedRef.current) {
          markedRef.current = true;
          markStep('train');
        }
        if (ACTIVE_STATES.includes(s.state)) markedRef.current = false;
      } catch {
        /* erreur réseau ponctuelle : on retentera au prochain tick */
      }
    }, POLL_INTERVAL_MS);

    return () => { cancelled = true; clearInterval(timer); };
  }, [token, markStep]);

  /* -- 5.4 Actions -------------------------------------------------------- */

  const handleLoadTensors = useCallback(async () => {
    if (!token) return;
    try {
      const result = await trainingApi.loadTensors(params.tensorDir, token);
      setTensorInfo(result.status);
    } catch (error) {
      setTensorInfo(`${t('error') || 'Erreur'}: ${error instanceof Error ? error.message : ''}`);
    }
  }, [token, params.tensorDir, t]);

  const handleStart = useCallback(async () => {
    if (!token) return;
    setActionError('');
    try {
      const res = await trainingApi.startTraining({
        ...params,
        resumeCheckpoint: params.resumeCheckpoint.trim() || null,
      }, token);
      setPipelineStopped(Boolean(res.pipelineStopped));
      setStatus(s => (s ? { ...s, state: 'starting', message: 'Démarrage...' } : s));
      // Relance immédiate du polling
      const fresh = await trainingApi.trainingStatus(token);
      setStatus(fresh);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Échec du démarrage');
    }
  }, [token, params]);

  const handleStop = useCallback(async () => {
    if (!token) return;
    try {
      await trainingApi.stopTraining(token);
      const fresh = await trainingApi.trainingStatus(token);
      setStatus(fresh);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Échec de l'arrêt");
    }
  }, [token]);

  const handleRestartPipeline = useCallback(async () => {
    if (!token) return;
    try {
      await trainingApi.restartPipeline(token);
      setPipelineStopped(false);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Échec du redémarrage');
    }
  }, [token]);

  const handleCopyPath = useCallback(() => {
    if (!status?.outputPath) return;
    navigator.clipboard.writeText(status.outputPath).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [status?.outputPath]);

  /* -- 5.5 Rendu ---------------------------------------------------------- */

  const progressPct = status && status.totalEpochs > 0
    ? Math.min(100, Math.round((status.epoch / status.totalEpochs) * 100))
    : 0;

  return (
    <>
      {/* ---- Jeu de données prétraité ---- */}
      <Section title={t('preprocessedDataset') || 'Jeu de données prétraité'}>
        <div className="flex gap-2">
          <input
            type="text"
            value={params.tensorDir}
            onChange={e => set('tensorDir', e.target.value)}
            disabled={isActive}
            className={`flex-1 ${INPUT_CLASS} disabled:opacity-50`}
          />
          <button
            type="button"
            onClick={handleLoadTensors}
            disabled={isActive}
            className="px-3 py-1.5 bg-blue-500/20 hover:bg-blue-500/30 text-blue-500 dark:text-blue-400 rounded-lg text-xs font-medium flex items-center gap-1.5 disabled:opacity-50"
          >
            <FolderOpen size={14} />
            {t('load') || 'Charger'}
          </button>
        </div>
        {tensorInfo && (
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1.5 break-words whitespace-pre-wrap">
            {tensorInfo}
          </p>
        )}
      </Section>

      {/* ---- Modèle de base ---- */}
      <Section title={t('baseModel') || 'Modèle de base'}>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
          <FieldRow label={t('modelVariant') || 'Variante'}>
            <select
              value={params.modelVariant}
              onChange={e => set('modelVariant', e.target.value)}
              disabled={isActive}
              className={`flex-1 ${INPUT_CLASS} disabled:opacity-50`}
            >
              {MODEL_VARIANTS.map(v => <option key={v} value={v}>{v}</option>)}
            </select>
          </FieldRow>
          <FieldRow label={t('checkpointDir') || 'Dossier checkpoints'}>
            <input
              type="text"
              value={params.checkpointDir}
              onChange={e => set('checkpointDir', e.target.value)}
              disabled={isActive}
              className={`flex-1 ${INPUT_CLASS} disabled:opacity-50`}
            />
          </FieldRow>
        </div>
      </Section>

      {/* ---- Paramètres adaptateur & entraînement ---- */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Section title={t('loraSettings') || 'Paramètres de l\'adaptateur'}>
          <div className="space-y-2">
            <FieldRow label={t('adapterType') || 'Type'}>
              <select
                value={params.adapterType}
                onChange={e => set('adapterType', e.target.value as 'lora' | 'lokr')}
                disabled={isActive}
                className={`flex-1 ${INPUT_CLASS} disabled:opacity-50`}
              >
                <option value="lora">LoRA</option>
                <option value="lokr">LoKr</option>
              </select>
            </FieldRow>
            <ParamSlider
              label={`${t('loraRank') || 'Rang'} (r)`}
              value={params.rank} min={4} max={256} step={4}
              onChange={v => set('rank', v)}
            />
            <ParamSlider
              label={`${t('loraAlpha') || 'Alpha'} (a)`}
              value={params.alpha} min={4} max={512} step={4}
              onChange={v => set('alpha', v)}
            />
            <ParamSlider
              label={t('dropout') || 'Dropout'}
              value={params.dropout} min={0} max={0.5} step={0.05}
              onChange={v => set('dropout', v)}
            />
            <p className="text-[10px] text-zinc-500 leading-relaxed">
              {t('rankHint') ||
                'Rang faible (8–16) = moins de surapprentissage sur petit dataset. Alpha ≈ 2× le rang.'}
            </p>
          </div>
        </Section>

        <Section title={t('trainingParameters') || "Paramètres d'entraînement"}>
          <div className="space-y-2">
            <FieldRow label={t('learningRate') || "Taux d'apprentissage"}>
              <input
                type="number" step={0.00001}
                value={params.learningRate}
                onChange={e => set('learningRate', parseFloat(e.target.value) || 0.0001)}
                disabled={isActive}
                className={`w-28 ${INPUT_CLASS} disabled:opacity-50`}
              />
            </FieldRow>
            <ParamSlider
              label={t('maxEpochs') || 'Époques'}
              value={params.epochs} min={10} max={2000} step={10}
              onChange={v => set('epochs', v)}
            />
            <ParamSlider
              label={t('batchSize') || 'Taille de lot'}
              value={params.batchSize} min={1} max={8} step={1}
              onChange={v => set('batchSize', v)}
            />
            <ParamSlider
              label={t('gradientAccumulation') || 'Accumulation de gradient'}
              value={params.gradientAccumulation} min={1} max={16} step={1}
              onChange={v => set('gradientAccumulation', v)}
            />
            <ParamSlider
              label={t('saveEvery') || 'Sauvegarder toutes les N époques'}
              value={params.saveEvery} min={1} max={200} step={1}
              onChange={v => set('saveEvery', v)}
            />
            <div className="grid grid-cols-2 gap-2">
              <FieldRow label={t('seed') || 'Graine'}>
                <input
                  type="number"
                  value={params.seed}
                  onChange={e => set('seed', parseInt(e.target.value) || 42)}
                  disabled={isActive}
                  className={`w-20 ${INPUT_CLASS} disabled:opacity-50`}
                />
              </FieldRow>
              <FieldRow label={t('shift') || 'Shift'}>
                <input
                  type="number" step={0.5} min={1} max={5}
                  value={params.shift}
                  onChange={e => set('shift', parseFloat(e.target.value) || 3)}
                  disabled={isActive}
                  className={`w-20 ${INPUT_CLASS} disabled:opacity-50`}
                />
              </FieldRow>
            </div>
          </div>
        </Section>
      </div>

      {/* ---- Mémoire & performance ---- */}
      <Section title={t('memorySettings') || 'Mémoire et performance'}>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
          <FieldRow label={t('optimizer') || 'Optimiseur'}>
            <select
              value={params.optimizerType}
              onChange={e => set('optimizerType', e.target.value)}
              disabled={isActive}
              className={`flex-1 ${INPUT_CLASS} disabled:opacity-50`}
            >
              {OPTIMIZERS.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          </FieldRow>
          <FieldRow label={t('precision') || 'Précision'}>
            <select
              value={params.precision}
              onChange={e => set('precision', e.target.value)}
              disabled={isActive}
              className={`flex-1 ${INPUT_CLASS} disabled:opacity-50`}
            >
              {PRECISIONS.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </FieldRow>
        </div>

        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
          <label className="flex items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
            <input
              type="checkbox" checked={params.gradientCheckpointing}
              onChange={e => set('gradientCheckpointing', e.target.checked)}
              disabled={isActive}
              className="w-3 h-3 accent-pink-500"
            />
            {t('gradientCheckpointing') || 'Gradient checkpointing'}
          </label>
          <label className="flex items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
            <input
              type="checkbox" checked={params.offloadEncoder}
              onChange={e => set('offloadEncoder', e.target.checked)}
              disabled={isActive}
              className="w-3 h-3 accent-pink-500"
            />
            {t('offloadEncoder') || 'Offload encodeur'}
          </label>
          <label className="flex items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
            <input
              type="checkbox" checked={params.freeVram}
              onChange={e => set('freeVram', e.target.checked)}
              disabled={isActive}
              className="w-3 h-3 accent-pink-500"
            />
            {t('freeVram') || 'Libérer la VRAM (arrête le serveur pendant l\'entraînement)'}
          </label>
        </div>
        <p className="text-[10px] text-zinc-500 mt-1.5 leading-relaxed">
          {t('freeVramHint') ||
            'Le serveur de génération garde le modèle en VRAM. Sur une carte de 8 Go, l\'entraînement échoue si on ne l\'arrête pas.'}
        </p>
      </Section>

      {/* ---- Sortie ---- */}
      <Section title={t('outputDirectory') || 'Sortie'}>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
          <FieldRow label={t('outputDirectory') || 'Dossier de sortie'}>
            <input
              type="text"
              value={params.outputDir}
              onChange={e => set('outputDir', e.target.value)}
              disabled={isActive}
              className={`flex-1 ${INPUT_CLASS} disabled:opacity-50`}
            />
          </FieldRow>
          <FieldRow label={t('resumeCheckpoint') || 'Reprendre depuis'}>
            <input
              type="text"
              value={params.resumeCheckpoint}
              onChange={e => set('resumeCheckpoint', e.target.value)}
              disabled={isActive}
              className={`flex-1 ${INPUT_CLASS} disabled:opacity-50`}
              placeholder={t('optional') || '(facultatif)'}
            />
          </FieldRow>
        </div>
      </Section>

      {/* ---- Contrôles ---- */}
      <div className="flex gap-2">
        {!isActive ? (
          <button
            type="button"
            onClick={handleStart}
            className="flex-1 py-2.5 bg-gradient-to-r from-pink-500 to-purple-600 hover:from-pink-600 hover:to-purple-700 text-white rounded-lg text-sm font-medium flex items-center justify-center gap-2"
          >
            <Play size={16} />
            {t('startTraining') || "Lancer l'entraînement"}
          </button>
        ) : (
          <button
            type="button"
            onClick={handleStop}
            className="flex-1 py-2.5 bg-red-500/20 hover:bg-red-500/30 text-red-500 dark:text-red-400 rounded-lg text-sm font-medium flex items-center justify-center gap-2"
          >
            <Square size={16} />
            {t('stopTraining') || "Arrêter l'entraînement"}
          </button>
        )}

        {pipelineStopped && !isActive && (
          <button
            type="button"
            onClick={handleRestartPipeline}
            className="px-4 py-2.5 bg-blue-500/20 hover:bg-blue-500/30 text-blue-500 dark:text-blue-400 rounded-lg text-sm font-medium flex items-center gap-2"
          >
            <RotateCw size={16} />
            {t('restartPipeline') || 'Relancer le serveur'}
          </button>
        )}
      </div>

      {actionError && (
        <p className="text-xs text-red-500 dark:text-red-400 break-words">{actionError}</p>
      )}

      {/* ---- Progression ---- */}
      {status && status.state !== 'idle' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <Section title={t('trainingProgress') || 'Progression'}>
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-zinc-600 dark:text-zinc-300">{status.message}</span>
                <span className="font-mono text-zinc-500">
                  {status.epoch}/{status.totalEpochs || '?'}
                </span>
              </div>

              <div className="h-1.5 bg-zinc-200 dark:bg-white/10 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${
                    status.state === 'error' ? 'bg-red-500'
                      : status.state === 'completed' ? 'bg-green-500'
                      : 'bg-gradient-to-r from-pink-500 to-purple-600'
                  }`}
                  style={{ width: `${progressPct}%` }}
                />
              </div>

              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] font-mono">
                <div className="flex justify-between">
                  <span className="text-zinc-500">Loss</span>
                  <span className="text-zinc-700 dark:text-zinc-300">
                    {status.loss?.toFixed(4) ?? '--'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-500">Best</span>
                  <span className="text-green-600 dark:text-green-400">
                    {status.bestLoss?.toFixed(4) ?? '--'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-500">{t('elapsed') || 'Écoulé'}</span>
                  <span className="text-zinc-700 dark:text-zinc-300">
                    {formatDuration(status.elapsedSec)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-500">ETA</span>
                  <span className="text-zinc-700 dark:text-zinc-300">
                    {formatDuration(status.etaSec)}
                  </span>
                </div>
              </div>

              {status.outputPath && (
                <div className="flex items-center gap-2 p-2 bg-green-500/10 rounded-lg">
                  <code className="flex-1 text-[10px] text-green-700 dark:text-green-400 break-all">
                    {status.outputPath}
                  </code>
                  <button
                    type="button"
                    onClick={handleCopyPath}
                    className="p-1 text-green-600 dark:text-green-400 hover:bg-green-500/20 rounded"
                    aria-label={t('copyPath') || 'Copier le chemin'}
                  >
                    {copied ? <Check size={12} /> : <Copy size={12} />}
                  </button>
                </div>
              )}

              {status.lastError && (
                <pre className="text-[10px] text-red-500 dark:text-red-400 bg-red-500/5 rounded-lg p-2 max-h-24 overflow-y-auto whitespace-pre-wrap">
                  {status.lastError}
                </pre>
              )}
            </div>
          </Section>

          <Section title={t('trainingLoss') || 'Perte'}>
            {status.metrics.length >= 2 ? (
              <div className="bg-black/5 dark:bg-black/20 rounded-lg p-2">
                <LossChart points={status.metrics} />
              </div>
            ) : (
              <p className="text-[11px] text-zinc-500">
                {t('waitingForMetrics') || 'En attente des premières époques...'}
              </p>
            )}
          </Section>
        </div>
      )}

      {/* ---- Journal ---- */}
      {status?.log && (
        <Section title={t('trainingLog') || 'Journal'}>
          <pre
            ref={logRef}
            className="text-[10px] text-zinc-600 dark:text-zinc-400 bg-black/5 dark:bg-black/20 rounded-lg p-2 max-h-56 overflow-y-auto whitespace-pre-wrap"
          >
            {status.log}
          </pre>
        </Section>
      )}
    </>
  );
};
