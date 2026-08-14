import React, { useState, useCallback } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { trainingApi } from '../../services/api';
import { Section, FieldRow } from './TrainingUIComponents';

type PipelineStepKey = 'upload' | 'edit' | 'save' | 'preprocess' | 'train' | 'export';

interface ExportTabProps {
  token: string | null;
  t: (key: string) => string;
  markStep: (step: PipelineStepKey) => void;
}

export const ExportTab: React.FC<ExportTabProps> = ({ token, t, markStep }) => {
  const [exportPath, setExportPath] = useState('./lora_output/final_lora');
  const [exportOutputDir, setExportOutputDir] = useState('./lora_output');
  const [exportStatus, setExportStatus] = useState('');
  const [exporting, setExporting] = useState(false);

  const handleExportLora = useCallback(async () => {
    if (!token) return;
    setExporting(true);
    setExportStatus(t('exporting') || 'Exportation en cours...');
    try {
      const result = await trainingApi.exportLora({ exportPath, loraOutputDir: exportOutputDir }, token);
      setExportStatus(result.status as string);
      markStep('export');
    } catch (error) {
      setExportStatus(`${t('error')}: ${error instanceof Error ? error.message : 'Failed'}`);
    } finally {
      setExporting(false);
    }
  }, [token, exportPath, exportOutputDir, t, markStep]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
      <Section title={t('exportLora')}>
        <div className="space-y-2">
          <FieldRow label={t('exportPath') || 'Chemin d\'exportation'}>
            <input type="text" value={exportPath} onChange={e => setExportPath(e.target.value)} className="flex-1 bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-3 py-1.5 text-sm text-zinc-900 dark:text-zinc-200" />
          </FieldRow>
          <FieldRow label={t('loraOutputDir') || 'Dossier de sortie LoRA'}>
            <input type="text" value={exportOutputDir} onChange={e => setExportOutputDir(e.target.value)} className="flex-1 bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-3 py-1.5 text-sm text-zinc-900 dark:text-zinc-200" />
          </FieldRow>
        </div>
        <button onClick={handleExportLora} disabled={exporting} className="w-full mt-3 py-2.5 bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-600 hover:to-emerald-700 text-white rounded-lg text-sm font-medium flex items-center justify-center gap-2 disabled:opacity-50">
          {exporting ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
          {t('exportLora')}
        </button>
        {exportStatus && <p className="text-xs text-zinc-400 mt-2 break-words">{exportStatus}</p>}
      </Section>

      <Section title={t('loadLoraForInference')}>
        <p className="text-xs text-zinc-500">
          {t('loadLoraHint')}
        </p>
      </Section>
    </div>
  );
};
