import React, { useState, useCallback, useMemo } from 'react';
import { FolderOpen, Play, Square } from 'lucide-react';
import { trainingApi } from '../../services/api';
import { Section, FieldRow, ParamSlider } from './TrainingUIComponents';

type PipelineStepKey = 'upload' | 'edit' | 'save' | 'preprocess' | 'train' | 'export';

interface TrainingMetricPoint {
  step: number;
  loss: number;
}

interface TrainingMetricsContainer {
  data?: [number, number][];
}

interface TrainTabProps {
  token: string | null;
  t: (key: string) => string;
  markStep: (step: PipelineStepKey) => void;
}

export const TrainTab: React.FC<TrainTabProps> = ({ token, t, markStep }) => {
  const [trainingParams, setTrainingParams] = useState({
    tensorDir: './datasets/preprocessed_tensors',
    rank: 64,
    alpha: 128,
    dropout: 0.1,
    learningRate: 0.0003,
    epochs: 1000,
    batchSize: 1,
    gradientAccumulation: 1,
    saveEvery: 200,
    shift: 3.0,
    seed: 42,
    outputDir: './lora_output',
    resumeCheckpoint: '',
  });

  const [isTraining, setIsTraining] = useState(false);
  const [trainingProgress, setTrainingProgress] = useState('');
  const [trainingLog, setTrainingLog] = useState('');
  const [trainingMetrics, setTrainingMetrics] = useState<unknown>(null);
  const [trainingDatasetInfo, setTrainingDatasetInfo] = useState('');

  const handleLoadTensors = useCallback(async () => {
    if (!token) return;
    try {
      const result = await trainingApi.loadTensors(trainingParams.tensorDir, token);
      setTrainingDatasetInfo(result.status);
    } catch (error) {
      setTrainingDatasetInfo(`${t('error') || "Erreur"}: ${error instanceof Error ? error.message : (t('failed') || "Échec")}`);
    }
  }, [token, trainingParams.tensorDir, t]);

  const handleStartTraining = useCallback(async () => {
    if (!token) return;
    setIsTraining(true);
    setTrainingProgress(t('startingTraining') || "Démarrage de l'entraînement...");
    setTrainingLog('');
    setTrainingMetrics(null);
    try {
      const result = await trainingApi.startTraining({
        ...trainingParams,
        resumeCheckpoint: trainingParams.resumeCheckpoint || null,
      }, token);
      setTrainingProgress(result.progress as string);
      setTrainingLog(result.log as string);
      setTrainingMetrics(result.metrics);
      markStep('train');
    } catch (error) {
      setTrainingProgress(`${t('error') || "Erreur"}: ${error instanceof Error ? error.message : (t('failed') || "Échec")}`);
    } finally {
      setIsTraining(false);
    }
  }, [token, trainingParams, t, markStep]);

  const handleStopTraining = useCallback(async () => {
    if (!token) return;
    try {
      const result = await trainingApi.stopTraining(token);
      setTrainingProgress(result.status as string);
      setIsTraining(false);
    } catch (error) {
      console.error('Failed to stop training:', error);
    }
  }, [token]);

  // Graphique SVG de Loss avec typage strict
  const lossChartSvg = useMemo(() => {
    if (!trainingMetrics) return null;
    let points: TrainingMetricPoint[] = [];

    if (typeof trainingMetrics === 'object' && trainingMetrics !== null) {
      const mContainer = trainingMetrics as TrainingMetricsContainer;
      if (Array.isArray(mContainer.data)) {
        points = mContainer.data
          .map((row) => ({ step: Number(row[0]) || 0, loss: Number(row[1]) || 0 }))
          .filter((p) => p.loss > 0);
      } else if (Array.isArray(trainingMetrics)) {
        points = (trainingMetrics as Array<Record<string, unknown>>)
          .map((item, i) => ({
            step: Number(item.step ?? item.x ?? i),
            loss: Number(item.loss ?? item.y ?? 0),
          }))
          .filter((p) => p.loss > 0);
      }
    }

    if (points.length < 2) return null;

    const width = 280;
    const height = 100;
    const pad = 4;
    const minStep = Math.min(...points.map((p) => p.step));
    const maxStep = Math.max(...points.map((p) => p.step));
    const minLoss = Math.min(...points.map((p) => p.loss));
    const maxLoss = Math.max(...points.map((p) => p.loss));
    const rangeStep = maxStep - minStep || 1;
    const rangeLoss = maxLoss - minLoss || 1;

    const polyPoints = points
      .map((p) => {
        const x = pad + ((p.step - minStep) / rangeStep) * (width - 2 * pad);
        const y = pad + (1 - (p.loss - minLoss) / rangeLoss) * (height - 2 * pad);
        return `${x},${y}`;
      })
      .join(' ');

    return (
      <svg width={width} height={height} className="w-full" viewBox={`0 0 ${width} ${height}`}>
        <polyline points={polyPoints} fill="none" stroke="rgb(236 72 153)" strokeWidth="1.5" strokeLinejoin="round" />
        <text x={pad} y={height - 2} fontSize="8" fill="rgb(113 113 122)" fontFamily="monospace">{minStep}</text>
        <text x={width - pad} y={height - 2} fontSize="8" fill="rgb(113 113 122)" fontFamily="monospace" textAnchor="end">{maxStep}</text>
        <text x={pad} y={10} fontSize="8" fill="rgb(113 113 122)" fontFamily="monospace">{minLoss.toFixed(4)}</text>
      </svg>
    );
  }, [trainingMetrics]);

  return (
    <>
      <Section title={t('preprocessedDataset') || "Jeu de données prétraité"}>
        <div className="flex gap-2">
          <input 
            type="text" 
            value={trainingParams.tensorDir} 
            onChange={e => setTrainingParams(p => ({ ...p, tensorDir: e.target.value }))} 
            className="flex-1 bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-3 py-1.5 text-sm text-zinc-900 dark:text-zinc-200" 
          />
          <button 
            onClick={handleLoadTensors} 
            className="px-3 py-1.5 bg-blue-500/20 hover:bg-blue-500/30 text-blue-400 rounded-lg text-xs font-medium flex items-center gap-1.5"
          >
            <FolderOpen size={14} />
            {t('load') || 'Charger'}
          </button>
        </div>
        {trainingDatasetInfo && <p className="text-xs text-zinc-400 mt-1.5 break-words whitespace-pre-wrap">{trainingDatasetInfo}</p>}
      </Section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Section title={t('loraSettings') || "Paramètres LoRA"}>
          <div className="space-y-2">
            <ParamSlider label={`${t('loraRank') || "Rang LoRA"} (r)`} value={trainingParams.rank} min={4} max={256} step={4} onChange={v => setTrainingParams(p => ({ ...p, rank: v }))} />
            <ParamSlider label={`${t('loraAlpha') || "Alpha LoRA"} (a)`} value={trainingParams.alpha} min={4} max={512} step={4} onChange={v => setTrainingParams(p => ({ ...p, alpha: v }))} />
            <ParamSlider label={`${t('dropout') || "Abandon (Dropout)"}`} value={trainingParams.dropout} min={0} max={0.5} step={0.05} onChange={v => setTrainingParams(p => ({ ...p, dropout: v }))} />
            <FieldRow label={t('seed') || "Graine (Seed)"}>
              <input type="number" value={trainingParams.seed} onChange={e => setTrainingParams(p => ({ ...p, seed: parseInt(e.target.value) || 42 }))} className="w-24 bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-3 py-1.5 text-sm text-zinc-900 dark:text-zinc-200" />
            </FieldRow>
            <FieldRow label={t('shift') || "Décalage (Shift)"}>
              <input type="number" value={trainingParams.shift} onChange={e => setTrainingParams(p => ({ ...p, shift: parseFloat(e.target.value) || 3.0 }))} step={0.5} min={1.0} max={5.0} className="w-24 bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-3 py-1.5 text-sm text-zinc-900 dark:text-zinc-200" />
            </FieldRow>
          </div>
        </Section>

        <Section title={t('trainingParameters') || "Paramètres d'entraînement"}>
          <div className="space-y-2">
            <FieldRow label={t('learningRate') || "Taux d'apprentissage"}>
              <input type="number" value={trainingParams.learningRate} onChange={e => setTrainingParams(p => ({ ...p, learningRate: parseFloat(e.target.value) || 0.0003 }))} step={0.0001} className="w-28 bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-3 py-1.5 text-sm text-zinc-900 dark:text-zinc-200" />
            </FieldRow>
            <ParamSlider label={t('maxEpochs') || "Époques max"} value={trainingParams.epochs} min={1} max={4000} step={1} onChange={v => setTrainingParams(p => ({ ...p, epochs: v }))} />
            <ParamSlider label={t('batchSize') || "Taille de lot"} value={trainingParams.batchSize} min={1} max={8} step={1} onChange={v => setTrainingParams(p => ({ ...p, batchSize: v }))} />
            <ParamSlider label={t('gradientAccumulation') || "Accumulation de gradient"} value={trainingParams.gradientAccumulation} min={1} max={16} step={1} onChange={v => setTrainingParams(p => ({ ...p, gradientAccumulation: v }))} />
            <ParamSlider label={`${t('saveEvery') || "Sauvegarder tous les"} (${t('epochs') || "époques"})`} value={trainingParams.saveEvery} min={50} max={1000} step={50} onChange={v => setTrainingParams(p => ({ ...p, saveEvery: v }))} />
          </div>
        </Section>
      </div>

      <Section title={t('outputDirectory') || "Dossier de sortie"}>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
          <FieldRow label={t('outputDirectory') || "Dossier de sortie"}>
            <input type="text" value={trainingParams.outputDir} onChange={e => setTrainingParams(p => ({ ...p, outputDir: e.target.value }))} className="flex-1 bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-3 py-1.5 text-sm text-zinc-900 dark:text-zinc-200" />
          </FieldRow>
          <FieldRow label={t('resumeCheckpoint') || "Reprendre le point de contrôle"}>
            <input type="text" value={trainingParams.resumeCheckpoint} onChange={e => setTrainingParams(p => ({ ...p, resumeCheckpoint: e.target.value }))} className="flex-1 bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-3 py-1.5 text-sm text-zinc-900 dark:text-zinc-200" placeholder="./lora_output/checkpoints/epoch_200" />
          </FieldRow>
        </div>
      </Section>

      <div className="flex gap-2">
        {!isTraining ? (
          <button onClick={handleStartTraining} className="flex-1 py-2.5 bg-gradient-to-r from-pink-500 to-purple-600 hover:from-pink-600 hover:to-purple-700 text-white rounded-lg text-sm font-medium flex items-center justify-center gap-2">
            <Play size={16} />
            {t('startTraining') || "Lancer l'entraînement"}
          </button>
        ) : (
          <button onClick={handleStopTraining} className="flex-1 py-2.5 bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded-lg text-sm font-medium flex items-center justify-center gap-2">
            <Square size={16} />
            {t('stopTraining') || "Arrêter l'entraînement"}
          </button>
        )}
      </div>

      {(trainingProgress || trainingLog || lossChartSvg) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {(trainingProgress || trainingLog) && (
            <Section title={t('trainingProgress') || "Progression de l'entraînement"}>
              {trainingProgress && <p className="text-xs text-zinc-300 mb-2 break-words">{trainingProgress}</p>}
              {trainingLog && (
                <pre className="text-[10px] text-zinc-400 bg-black/20 rounded-lg p-2 max-h-40 overflow-y-auto whitespace-pre-wrap">{trainingLog}</pre>
              )}
            </Section>
          )}
          {lossChartSvg && (
            <Section title={t('trainingLoss') || "Perte d'entraînement"}>
              <div className="bg-black/20 rounded-lg p-2">{lossChartSvg}</div>
            </Section>
          )}
        </div>
      )}
    </>
  );
};
