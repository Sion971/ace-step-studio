import React, { useState, useCallback, useRef, useMemo } from 'react';
import { Upload, FileAudio, X, Search, Loader2, FolderOpen, Wand2, Volume2, Edit3, Save, Zap } from 'lucide-react';
import { trainingApi, getTrainingAudioUrl, TrainingSample, DatasetSettings } from '../../services/api';
import { Section, FieldRow } from './TrainingUIComponents';

type PipelineStepKey = 'upload' | 'edit' | 'save' | 'preprocess' | 'train' | 'export';

interface DataframeRow {
  [key: string]: unknown;
}

const LANGUAGES = [
  { value: 'instrumental', label: 'Instrumental' },
  { value: 'en', label: 'English' },
  { value: 'zh', label: 'Chinese' },
  { value: 'ja', label: 'Japanese' },
  { value: 'ko', label: 'Korean' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'ru', label: 'Russian' },
  { value: 'unknown', label: 'Unknown' },
];

const TIME_SIGS = ['', '2', '3', '4', '6', 'N/A'];

/**
 * Extrait proprement une chaîne de caractères de n'importe quel type de retour Gradio ou API,
 * évitant ainsi le crash React Error #31 (objet avec clés {value, __type__}).
 */
const safeString = (val: unknown): string => {
  if (val === null || val === undefined) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  if (typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    if ('value' in obj) {
      return safeString(obj.value);
    }
    if ('label' in obj) {
      return safeString(obj.label);
    }
    try {
      return JSON.stringify(val);
    } catch {
      return String(val);
    }
  }
  return String(val);
};

interface DatasetTabProps {
  token: string | null;
  t: (key: string) => string;
  markStep: (step: PipelineStepKey) => void;
}

export const DatasetTab: React.FC<DatasetTabProps> = ({ token, t, markStep }) => {
  // Upload state
  const [queuedFiles, setQueuedFiles] = useState<File[]>([]);
  const [uploadDatasetName, setUploadDatasetName] = useState('my_lora_dataset');
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Scan dir state
  const [scanDir, setScanDir] = useState('');
  const [scanning, setScanning] = useState(false);
  const [scanStatus, setScanStatus] = useState('');

  // Dataset state
  const [datasetPath, setDatasetPath] = useState('./datasets/my_lora_dataset.json');
  const [datasetLoaded, setDatasetLoaded] = useState(false);
  const [datasetLoading, setDatasetLoading] = useState(false);
  const [sampleCount, setSampleCount] = useState(0);
  const [currentSampleIdx, setCurrentSampleIdx] = useState(0);
  const [currentSample, setCurrentSample] = useState<TrainingSample | null>(null);
  const [datasetSettings, setDatasetSettings] = useState<DatasetSettings>({
    datasetName: 'my_lora_dataset',
    customTag: '',
    tagPosition: 'replace',
    allInstrumental: true,
    genreRatio: 0,
  });
  const [datasetStatus, setDatasetStatus] = useState('');

  // Table state
  const [dataframeHeaders, setDataframeHeaders] = useState<string[]>([]);
  const [dataframeRows, setDataframeRows] = useState<DataframeRow[]>([]);

  // Auto-label state
  const [autoLabeling, setAutoLabeling] = useState(false);
  const [autoLabelStatus, setAutoLabelStatus] = useState('');
  const [skipMetas, setSkipMetas] = useState(false);
  const [formatLyrics, setFormatLyrics] = useState(false);
  const [transcribeLyrics, setTranscribeLyrics] = useState(false);
  const [onlyUnlabeled, setOnlyUnlabeled] = useState(false);

  // Editing sample state
  const [editCaption, setEditCaption] = useState('');
  const [editGenre, setEditGenre] = useState('');
  const [editPromptOverride, setEditPromptOverride] = useState('Use Global Ratio');
  const [editLyrics, setEditLyrics] = useState('');
  const [editBpm, setEditBpm] = useState(120);
  const [editKey, setEditKey] = useState('');
  const [editTimeSig, setEditTimeSig] = useState('');
  const [editDuration, setEditDuration] = useState(0);
  const [editLanguage, setEditLanguage] = useState('instrumental');
  const [editInstrumental, setEditInstrumental] = useState(true);
  const [editRawLyrics, setEditRawLyrics] = useState('');

  // Save state
  const [savePath, setSavePath] = useState('./datasets/my_lora_dataset.json');
  const [saveStatus, setSaveStatus] = useState('');
  const [editSaveStatus, setEditSaveStatus] = useState('');
  const [saving, setSaving] = useState(false);

  // Preprocess state
  const [preprocessDatasetPath, setPreprocessDatasetPath] = useState('./datasets/my_lora_dataset.json');
  const [preprocessDatasetLoading, setPreprocessDatasetLoading] = useState(false);
  const [preprocessDatasetStatus, setPreprocessDatasetStatus] = useState('');
  const [preprocessOutputDir, setPreprocessOutputDir] = useState('./datasets/preprocessed_tensors');
  const [preprocessing, setPreprocessing] = useState(false);
  const [preprocessStatus, setPreprocessStatus] = useState('');

  const audioPreviewUrl = useMemo(() => {
    if (!currentSample?.audio) return undefined;
    return getTrainingAudioUrl(currentSample.audio, token ?? undefined);
  }, [currentSample?.audio, token]);

  const populateSampleFields = (sample?: TrainingSample | null) => {
    if (!sample) return;
    setEditCaption(safeString(sample.caption));
    setEditGenre(safeString(sample.genre));
    setEditPromptOverride(safeString(sample.promptOverride || 'Use Global Ratio'));
    setEditLyrics(safeString(sample.lyrics));
    setEditBpm(typeof sample.bpm === 'number' ? sample.bpm : (parseInt(safeString(sample.bpm)) || 120));
    setEditKey(safeString(sample.key));
    setEditTimeSig(safeString(sample.timeSignature));
    setEditDuration(typeof sample.duration === 'number' ? sample.duration : (parseFloat(safeString(sample.duration)) || 0));
    setEditLanguage(safeString(sample.language || 'instrumental'));
    setEditInstrumental(Boolean(sample.instrumental));
    setEditRawLyrics(safeString(sample.rawLyrics));
  };

  const sanitizeSettings = (settings?: Partial<DatasetSettings>): DatasetSettings => {
    return {
      datasetName: typeof settings?.datasetName === 'string' ? settings.datasetName : safeString(settings?.datasetName) || 'my_lora_dataset',
      customTag: typeof settings?.customTag === 'string' ? settings.customTag : safeString(settings?.customTag),
      tagPosition: ['prepend', 'append', 'replace'].includes(settings?.tagPosition as string)
        ? (settings?.tagPosition as DatasetSettings['tagPosition'])
        : 'replace',
      allInstrumental: Boolean(settings?.allInstrumental ?? true),
      genreRatio: typeof settings?.genreRatio === 'number' && !isNaN(settings.genreRatio) ? settings.genreRatio : 0,
    };
  };

  const parseDataframe = (df: unknown) => {
    if (!df || typeof df !== 'object') return;
    const dfObj = df as { headers?: string[]; data?: unknown[][] };
    if (dfObj.headers && Array.isArray(dfObj.data)) {
      setDataframeHeaders(dfObj.headers);
      setDataframeRows(dfObj.data.map(row => {
        const obj: DataframeRow = {};
        dfObj.headers!.forEach((h, i) => {
          const cell = row[i];
          if (cell && typeof cell === 'object' && 'value' in (cell as Record<string, unknown>)) {
            obj[h] = (cell as Record<string, unknown>).value;
          } else {
            obj[h] = cell;
          }
        });
        return obj;
      }));
    }
  };

  const handleFormatLyricsToggle = (e: React.ChangeEvent<HTMLInputElement>) => {
    const checked = e.target.checked;
    setFormatLyrics(checked);
    if (checked) setTranscribeLyrics(false);
  };

  const handleTranscribeLyricsToggle = (e: React.ChangeEvent<HTMLInputElement>) => {
    const checked = e.target.checked;
    setTranscribeLyrics(checked);
    if (checked) setFormatLyrics(false);
  };

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const files = Array.from(e.dataTransfer.files).filter((f: File) => {
      const ext = f.name.toLowerCase().split('.').pop();
      return ['wav', 'mp3', 'flac', 'ogg', 'opus'].includes(ext || '');
    });
    if (files.length > 0) setQueuedFiles(prev => [...prev, ...files]);
  }, []);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      setQueuedFiles(prev => [...prev, ...Array.from(e.target.files!)]);
    }
    e.target.value = '';
  }, []);

  const handleUploadAndBuild = useCallback(async () => {
    if (!token || queuedFiles.length === 0) return;
    setUploading(true);
    setUploadStatus(t('uploadingFiles') || 'Envoi des fichiers en cours...');
    try {
      await trainingApi.uploadAudio(queuedFiles, uploadDatasetName, token);
      setUploadStatus(`${queuedFiles.length} ${t('filesUploadedBuilding') || 'fichiers envoyés. Création du jeu de données...'}`);
      const result = await trainingApi.buildDataset({
        datasetName: uploadDatasetName,
        customTag: datasetSettings.customTag,
        tagPosition: datasetSettings.tagPosition,
        allInstrumental: datasetSettings.allInstrumental,
      }, token);
      setDatasetLoaded(true);
      setSampleCount(result.sampleCount || 0);
      setCurrentSampleIdx(0);
      if (result.sample) {
        setCurrentSample(result.sample);
        populateSampleFields(result.sample);
      }
      if (result.settings) setDatasetSettings(sanitizeSettings(result.settings));
      if (result.dataframe) parseDataframe(result.dataframe);
      const dp = result.datasetPath || `./datasets/${uploadDatasetName || 'my_lora_dataset'}.json`;
      setDatasetPath(dp);
      setSavePath(dp);
      setDatasetStatus(safeString(result.status));
      setQueuedFiles([]);
      markStep('upload');
      setUploadStatus('');
    } catch (error) {
      setUploadStatus(`Error: ${error instanceof Error ? error.message : safeString(error)}`);
    } finally {
      setUploading(false);
    }
  }, [token, queuedFiles, uploadDatasetName, datasetSettings, markStep]);

  const handleScanDirectory = useCallback(async () => {
    if (!token || !scanDir) return;
    setScanning(true);
    setScanStatus('Scanning...');
    try {
      const result = await trainingApi.scanDirectory({
        audioDir: scanDir,
        datasetName: datasetSettings.datasetName,
        customTag: datasetSettings.customTag,
        tagPosition: datasetSettings.tagPosition,
        allInstrumental: datasetSettings.allInstrumental,
      }, token);
      setScanStatus(safeString(result.status));
      setSampleCount(result.sampleCount || 0);
      if (result.dataframe) parseDataframe(result.dataframe);
    // Le scan n'affiche qu'un tableau : on enchaîne sur buildDataset pour
      // écrire réellement le JSON, comme le fait le parcours d'import.
      const built = await trainingApi.buildDataset({
        datasetName: datasetSettings.datasetName || 'my_lora_dataset',
        customTag: datasetSettings.customTag,
        tagPosition: datasetSettings.tagPosition,
        allInstrumental: datasetSettings.allInstrumental,
        sourceDir: result.audioDir,
      }, token);
      setDatasetLoaded(true);
      setSampleCount(built.sampleCount || 0);
      setCurrentSampleIdx(0);
      if (built.sample) {
        setCurrentSample(built.sample);
        populateSampleFields(built.sample);
      }
      if (built.settings) setDatasetSettings(sanitizeSettings(built.settings));
      if (built.dataframe) parseDataframe(built.dataframe);
      const dp = built.datasetPath || `./datasets/${datasetSettings.datasetName || 'my_lora_dataset'}.json`;
      setDatasetPath(dp);
      setSavePath(dp);
      setScanStatus(safeString(built.status));
      markStep('upload');
    } catch (error) {
      setScanStatus(`Error: ${error instanceof Error ? error.message : safeString(error)}`);
    } finally {
      setScanning(false);
    }
  }, [token, scanDir, datasetSettings]);

  const handleLoadDataset = useCallback(async () => {
    if (!token || !datasetPath) return;
    setDatasetLoading(true);
    setDatasetStatus(t('loadingDataset'));
    try {
      const result = await trainingApi.loadDataset(datasetPath, token);
      setDatasetLoaded(true);
      setSampleCount(result.sampleCount || 0);
      setCurrentSampleIdx(0);
      if (result.sample) {
        setCurrentSample(result.sample);
        populateSampleFields(result.sample);
      } else {
        setCurrentSample(null);
      }
      if (result.settings) setDatasetSettings(sanitizeSettings(result.settings));
      parseDataframe(result.dataframe);
      setDatasetStatus(safeString(result.status));
      setSavePath(datasetPath);
      markStep('upload');
    } catch (error) {
      setDatasetStatus(`${t('error')}: ${error instanceof Error ? error.message : safeString(error)}`);
    } finally {
      setDatasetLoading(false);
    }
  }, [token, datasetPath, t, markStep]);

  const handleAutoLabel = useCallback(async () => {
    if (!token) return;
    setAutoLabeling(true);
    setAutoLabelStatus(t('autoLabeling'));
    try {
      const result = await trainingApi.autoLabel({ skipMetas, formatLyrics, transcribeLyrics, onlyUnlabeled }, token);
      if (result.dataframe) parseDataframe(result.dataframe);
      
      const statusMsg = safeString(result.status) || safeString(result.hint) || 'Auto-label completed';
      setAutoLabelStatus(statusMsg);

      if (sampleCount > 0) {
        const sample = await trainingApi.getSamplePreview(currentSampleIdx, token);
        if (sample) {
          setCurrentSample(sample);
          populateSampleFields(sample);
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : safeString(error);
      setAutoLabelStatus(msg.includes('501') ? 'Auto-label requires model loaded in Gradio UI' : msg);
    } finally {
      setAutoLabeling(false);
    }
  }, [token, skipMetas, formatLyrics, transcribeLyrics, onlyUnlabeled, sampleCount, currentSampleIdx, t]);

  const handleSampleNavigate = useCallback(async (idx: number) => {
    if (!token || idx < 0 || idx >= sampleCount) return;
    setCurrentSampleIdx(idx);
    try {
      const sample = await trainingApi.getSamplePreview(idx, token);
      if (sample) {
        setCurrentSample(sample);
        populateSampleFields(sample);
      }
    } catch (error) {
      console.error('Failed to load sample:', error);
    }
  }, [token, sampleCount]);

  const handleSaveSample = useCallback(async () => {
    if (!token) return;
    setSaving(true);
    try {
      const result = await trainingApi.saveSample({
        sampleIdx: currentSampleIdx,
        caption: editCaption,
        genre: editGenre,
        promptOverride: editPromptOverride,
        lyrics: editLyrics,
        bpm: editBpm,
        key: editKey,
        timeSignature: editTimeSig,
        language: editLanguage,
        instrumental: editInstrumental,
      }, token);
      if (result.dataframe) parseDataframe(result.dataframe);
      setEditSaveStatus(safeString(result.status));
      markStep('edit');
    } catch (error) {
      setEditSaveStatus(`${t('error')}: ${error instanceof Error ? error.message : safeString(error)}`);
    } finally {
      setSaving(false);
    }
  }, [token, currentSampleIdx, editCaption, editGenre, editPromptOverride, editLyrics, editBpm, editKey, editTimeSig, editLanguage, editInstrumental, t, markStep]);

  const handleUpdateSettings = useCallback(async () => {
    if (!token) return;
    try {
      await trainingApi.updateSettings({
        customTag: datasetSettings.customTag,
        tagPosition: datasetSettings.tagPosition,
        allInstrumental: datasetSettings.allInstrumental,
        genreRatio: datasetSettings.genreRatio,
      }, token);
      setDatasetStatus('Settings updated');
    } catch (error) {
      setDatasetStatus(`${t('error')}: ${error instanceof Error ? error.message : safeString(error)}`);
    }
  }, [token, datasetSettings, t]);

  const handleSaveDataset = useCallback(async () => {
    if (!token) return;
    setSaving(true);
    setSaveStatus(t('savingDataset'));
    const safeName = datasetSettings.datasetName?.trim() || 'my_lora_dataset';
    try {
      const result = await trainingApi.saveDataset({
        savePath: savePath || `./datasets/${safeName}.json`,
        datasetName: safeName,
        customTag: datasetSettings.customTag,
        tagPosition: datasetSettings.tagPosition,
        allInstrumental: datasetSettings.allInstrumental,
        genreRatio: datasetSettings.genreRatio,
      }, token);
      setSaveStatus(safeString(result.status));
      if (result.path) setSavePath(result.path);
      markStep('save');
    } catch (error) {
      setSaveStatus(`${t('error')}: ${error instanceof Error ? error.message : safeString(error)}`);
    } finally {
      setSaving(false);
    }
  }, [token, savePath, datasetSettings, t, markStep]);

  const handleLoadDatasetForPreprocess = useCallback(async () => {
    if (!token) return;
    setPreprocessDatasetLoading(true);
    setPreprocessDatasetStatus(t('loadingForPreprocess') || 'Chargement du jeu de données pour le prétraitement...');
    try {
      const result = await trainingApi.loadDataset(preprocessDatasetPath, token);
      setPreprocessDatasetStatus(safeString(result.status) || `${result.sampleCount || 0} ${t('samplesLoaded') || 'échantillons chargés'}`);
      if (result.sampleCount) setSampleCount(result.sampleCount);
      if (result.dataframe) parseDataframe(result.dataframe);
    } catch (error) {
      setPreprocessDatasetStatus(`Error: ${error instanceof Error ? error.message : safeString(error)}`);
    } finally {
      setPreprocessDatasetLoading(false);
    }
  }, [token, preprocessDatasetPath]);

  const handlePreprocess = useCallback(async () => {
    if (!token) return;
    setPreprocessing(true);
    setPreprocessStatus(t('preprocessing') || 'Prétraitement en cours...');
    try {
      const result = await trainingApi.preprocess({
        datasetPath: preprocessDatasetPath || savePath || datasetPath,
        outputDir: preprocessOutputDir,
      }, token);
      setPreprocessStatus(safeString(result.message || result.status));
      markStep('preprocess');
    } catch (error) {
      setPreprocessStatus(`Error: ${error instanceof Error ? error.message : safeString(error)}`);
    } finally {
      setPreprocessing(false);
    }
  }, [token, preprocessDatasetPath, savePath, datasetPath, preprocessOutputDir, markStep]);

  return (
    <>
      {/* Drop Zone */}
      <Section title={t('uploadAudio')}>
        <div
          onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className={`border-2 border-dashed rounded-xl p-4 text-center cursor-pointer transition-all ${isDragOver ? 'border-pink-500 bg-pink-500/10' : 'border-white/10 hover:border-white/20 hover:bg-white/[0.02]'}`}
        >
          <Upload size={24} className={`mx-auto mb-2 ${isDragOver ? 'text-pink-400' : 'text-zinc-500'}`} />
          <p className="text-xs text-zinc-400">{t('dropAudioFiles')}</p>
          <p className="text-[10px] text-zinc-600 mt-1">.wav, .mp3, .flac, .ogg, .opus</p>
          <input ref={fileInputRef} type="file" multiple accept=".wav,.mp3,.flac,.ogg,.opus" onClick={(e) => e.stopPropagation()} onChange={handleFileSelect} className="hidden" />
        </div>
        {queuedFiles.length > 0 && (
          <div className="mt-2 space-y-1 max-h-32 overflow-y-auto">
            {queuedFiles.map((f, i) => (
              <div key={`${f.name}-${i}`} className="flex items-center gap-2 bg-white/5 rounded-lg px-2 py-1">
                <FileAudio size={12} className="text-zinc-400 flex-shrink-0" />
                <span className="text-[11px] text-zinc-300 truncate flex-1">{f.name}</span>
                <span className="text-[10px] text-zinc-500">{(f.size / 1024 / 1024).toFixed(1)}MB</span>
                <button onClick={() => setQueuedFiles(prev => prev.filter((_, idx) => idx !== i))} className="text-zinc-500 hover:text-red-400"><X size={12} /></button>
              </div>
            ))}
          </div>
        )}
        {queuedFiles.length > 0 && (
          <div className="mt-2 space-y-2">
            <FieldRow label={t('datasetName')}>
              <input type="text" value={uploadDatasetName} onChange={e => setUploadDatasetName(e.target.value)} className="flex-1 bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-3 py-1.5 text-sm text-zinc-900 dark:text-zinc-200" placeholder="my_lora_dataset" />
            </FieldRow>
            <button onClick={handleUploadAndBuild} disabled={uploading || !uploadDatasetName.trim()} className="w-full py-2 bg-gradient-to-r from-pink-500 to-purple-600 hover:from-pink-600 hover:to-purple-700 text-white rounded-lg text-xs font-medium flex items-center justify-center gap-2 disabled:opacity-50">
              {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
              {t('uploadAndCreate') || 'Envoyer & Créer le jeu de données'} ({queuedFiles.length} {t('files') || 'fichiers'})
            </button>
          </div>
        )}
        {uploadStatus && <p className="text-xs text-zinc-400 mt-1.5 break-words">{uploadStatus}</p>}
      </Section>

      {/* Scan Dir + Load Dataset */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Section title={t('scanDirectory')}>
          <div className="flex gap-2">
            <input type="text" value={scanDir} onChange={e => setScanDir(e.target.value)} className="flex-1 bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-3 py-1.5 text-sm text-zinc-900 dark:text-zinc-200" placeholder="./path/to/audio/folder" />
            <button onClick={handleScanDirectory} disabled={scanning || !scanDir} className="px-3 py-1.5 bg-white/5 hover:bg-white/10 text-zinc-300 rounded-lg text-xs font-medium flex items-center gap-1.5 disabled:opacity-50">
              {scanning ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
              {t('scan')}
            </button>
          </div>
          {scanStatus && <p className="text-xs text-zinc-400 mt-1.5 break-words">{scanStatus}</p>}
        </Section>

        <Section title={t('loadExistingDataset')}>
          <div className="flex gap-2">
            <input type="text" value={datasetPath} onChange={e => setDatasetPath(e.target.value)} className="flex-1 bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-3 py-1.5 text-sm text-zinc-900 dark:text-zinc-200" placeholder="./datasets/my_dataset.json" />
            <button onClick={handleLoadDataset} disabled={datasetLoading} className="px-3 py-1.5 bg-pink-500/20 hover:bg-pink-500/30 text-pink-400 rounded-lg text-xs font-medium flex items-center gap-1.5 disabled:opacity-50">
              {datasetLoading ? <Loader2 size={14} className="animate-spin" /> : <FolderOpen size={14} />}
              {t('loadDataset')}
            </button>
          </div>
          {datasetStatus && <p className="text-xs text-zinc-400 mt-1.5 break-words">{datasetStatus}</p>}
        </Section>
      </div>

      {/* Dataframe Table */}
      {dataframeRows.length > 0 && (
        <Section title={`Dataset (${dataframeRows.length} samples)`}>
          <div className="overflow-x-auto max-h-48 overflow-y-auto rounded-lg border border-white/5">
            <table className="w-full text-[10px]">
              <thead>
                <tr className="bg-white/5 sticky top-0">
                  <th className="text-left px-2 py-1 text-zinc-400 font-medium">#</th>
                  {dataframeHeaders.slice(0, 6).map(h => (
                    <th key={h} className="text-left px-2 py-1 text-zinc-400 font-medium truncate max-w-[80px]">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {dataframeRows.map((row, i) => (
                  <tr key={i} onClick={() => handleSampleNavigate(i)} className={`cursor-pointer transition-colors ${i === currentSampleIdx ? 'bg-pink-500/10 text-pink-300' : 'hover:bg-white/5 text-zinc-300'}`}>
                    <td className="px-2 py-0.5 text-zinc-500">{i + 1}</td>
                    {dataframeHeaders.slice(0, 6).map(h => (
                      <td key={h} className="px-2 py-0.5 truncate max-w-[80px]">
                        {typeof row[h] === 'object' && row[h] !== null
                          ? JSON.stringify(row[h])
                          : safeString(row[h])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {/* Dataset Settings + Auto-label + Sample Editor + Save/Preprocess */}
      {datasetLoaded && (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <Section title={t('datasetSettings')}>
              <div className="space-y-2">
                <FieldRow label={t('datasetName')}>
                  <input
                    type="text"
                    value={typeof datasetSettings.datasetName === 'string' ? datasetSettings.datasetName : ''}
                    onChange={e => {
                      const val = e.target.value;
                      setDatasetSettings(s => ({ ...s, datasetName: val }));
                    }}
                    className="flex-1 bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-3 py-1.5 text-sm text-zinc-900 dark:text-zinc-200"
                  />
                </FieldRow>
                <FieldRow label={t('customActivationTag')}>
                  <input
                    type="text"
                    value={typeof datasetSettings.customTag === 'string' ? datasetSettings.customTag : ''}
                    onChange={e => {
                      const val = e.target.value;
                      setDatasetSettings(s => ({ ...s, customTag: val }));
                    }}
                    className="flex-1 bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-3 py-1.5 text-sm text-zinc-900 dark:text-zinc-200"
                    placeholder="e.g. my_style"
                  />
                </FieldRow>
                <FieldRow label={t('tagPosition')}>
                  <select
                    value={typeof datasetSettings.tagPosition === 'string' ? datasetSettings.tagPosition : 'replace'}
                    onChange={e => {
                      const val = e.target.value as DatasetSettings['tagPosition'];
                      setDatasetSettings(s => ({ ...s, tagPosition: val }));
                    }}
                    className="flex-1 bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-3 py-1.5 text-sm text-zinc-900 dark:text-zinc-200"
                  >
                    <option value="prepend">{t('tagPrepend')}</option>
                    <option value="append">{t('tagAppend')}</option>
                    <option value="replace">{t('tagReplace')}</option>
                  </select>
                </FieldRow>
                <FieldRow label={t('allInstrumental')}>
                  <input type="checkbox" checked={datasetSettings.allInstrumental} onChange={e => setDatasetSettings(s => ({ ...s, allInstrumental: e.target.checked }))} className="w-4 h-4 accent-pink-500" />
                </FieldRow>
                <FieldRow label={`${t('genreRatio')} (${datasetSettings.genreRatio}%)`}>
                  <input type="range" min={0} max={100} value={datasetSettings.genreRatio} onChange={e => setDatasetSettings(s => ({ ...s, genreRatio: parseInt(e.target.value) || 0 }))} className="flex-1 accent-pink-500" />
                </FieldRow>
                <p className="text-[10px] text-zinc-500">{t('genreRatioHint')}</p>
                <button onClick={handleUpdateSettings} className="w-full py-1.5 bg-white/5 hover:bg-white/10 text-zinc-300 rounded-lg text-xs font-medium">
                  {t('applySettings')}
                </button>
              </div>
            </Section>

            <Section title={t('autoLabelWithAI')}>
              <p className="text-[10px] text-zinc-500 mb-2">{t('autoLabelDescription')}</p>
              <div className="flex flex-wrap gap-x-4 gap-y-1 mb-2">
                <label className="flex items-center gap-1.5 text-[10px] text-zinc-400">
                  <input type="checkbox" checked={skipMetas} onChange={e => setSkipMetas(e.target.checked)} className="w-3 h-3 accent-pink-500" />
                  {t('skipMetas')}
                </label>
                <label className="flex items-center gap-1.5 text-[10px] text-zinc-400">
                  <input type="checkbox" checked={formatLyrics} onChange={handleFormatLyricsToggle} className="w-3 h-3 accent-pink-500" />
                 {t('formatLyrics')}
                </label>
                <label className="flex items-center gap-1.5 text-[10px] text-zinc-400">
                  <input type="checkbox" checked={transcribeLyrics} onChange={handleTranscribeLyricsToggle} className="w-3 h-3 accent-pink-500" />
                  {t('transcribeLyrics')}
                </label>
                <label className="flex items-center gap-1.5 text-[10px] text-zinc-400">
                  <input type="checkbox" checked={onlyUnlabeled} onChange={e => setOnlyUnlabeled(e.target.checked)} className="w-3 h-3 accent-pink-500" />
                  {t('onlyUnlabeled')}
                </label>
              </div>
              <button onClick={handleAutoLabel} disabled={autoLabeling} className="w-full py-1.5 bg-purple-500/20 hover:bg-purple-500/30 text-purple-400 rounded-lg text-xs font-medium flex items-center justify-center gap-1.5 disabled:opacity-50">
                {autoLabeling ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
                {t('autoLabelAll')}
              </button>
              {autoLabelStatus && <p className="text-xs text-zinc-400 mt-1.5 break-words">{autoLabelStatus}</p>}
            </Section>
          </div>

          <Section title={`${t('editSample')} (${currentSampleIdx + 1}/${sampleCount})`}>
            <div className="flex items-center gap-2 mb-2">
              <button onClick={() => handleSampleNavigate(currentSampleIdx - 1)} disabled={currentSampleIdx <= 0} className="px-2 py-1 bg-white/5 hover:bg-white/10 text-zinc-300 rounded text-xs disabled:opacity-30">Prev</button>
              <input type="number" min={1} max={sampleCount} value={currentSampleIdx + 1} onChange={e => { const v = parseInt(e.target.value) - 1; if (v >= 0 && v < sampleCount) handleSampleNavigate(v); }} className="w-16 bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded px-2 py-1 text-xs text-center text-zinc-900 dark:text-zinc-200" />
              <button onClick={() => handleSampleNavigate(currentSampleIdx + 1)} disabled={currentSampleIdx >= sampleCount - 1} className="px-2 py-1 bg-white/5 hover:bg-white/10 text-zinc-300 rounded text-xs disabled:opacity-30">Next</button>
              <span className="text-[10px] text-zinc-500 ml-auto truncate max-w-[100px]">{currentSample?.filename || ''}</span>
            </div>

            {audioPreviewUrl && (
              <div className="mb-2 flex items-center gap-2 bg-white/5 rounded-lg px-2 py-1.5">
                <Volume2 size={14} className="text-pink-400 flex-shrink-0" />
                <audio 
                  key={audioPreviewUrl}
                  controls 
                  src={audioPreviewUrl} 
                  className="w-full h-7 [&::-webkit-media-controls-panel]:bg-transparent" 
                  preload="metadata" 
                />
              </div>
            )}

            <div className="space-y-2">
              <FieldRow label={t('caption')}>
                <input type="text" value={editCaption} onChange={e => setEditCaption(e.target.value)} className="flex-1 bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-3 py-1.5 text-sm text-zinc-900 dark:text-zinc-200" placeholder={t('musicDescription')} />
              </FieldRow>
              <FieldRow label={t('genre')}>
                <input type="text" value={editGenre} onChange={e => setEditGenre(e.target.value)} className="flex-1 bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-3 py-1.5 text-sm text-zinc-900 dark:text-zinc-200" />
              </FieldRow>
              <FieldRow label={t('promptOverride')}>
                <select value={editPromptOverride} onChange={e => setEditPromptOverride(e.target.value)} className="flex-1 bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-3 py-1.5 text-sm text-zinc-900 dark:text-zinc-200">
                  <option value="Use Global Ratio">{t('useGlobalRatio')}</option>
                  <option value="Caption">{t('caption')}</option>
                  <option value="Genre">{t('genre')}</option>
                </select>
              </FieldRow>
              <div>
                <label className="text-[11px] text-zinc-500 mb-0.5 block">Lyrics ({t('editableUsedForTraining')})</label>
                <textarea value={editLyrics} onChange={e => setEditLyrics(e.target.value)} rows={3} className="w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-3 py-1.5 text-sm text-zinc-900 dark:text-zinc-200 resize-none" />
              </div>
              {editRawLyrics && (
                <div>
                  <label className="text-[11px] text-zinc-500 mb-0.5 block">Raw Lyrics (read-only)</label>
                  <textarea value={editRawLyrics} readOnly rows={3} className="w-full bg-zinc-100 dark:bg-black/10 border border-zinc-200 dark:border-white/10 rounded-lg px-3 py-1.5 text-sm text-zinc-500 dark:text-zinc-400 resize-none opacity-60" />
                </div>
              )}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[11px] text-zinc-500 mb-0.5 block">BPM</label>
                  <input type="number" value={editBpm} onChange={e => setEditBpm(parseInt(e.target.value) || 0)} className="w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-3 py-1.5 text-sm text-zinc-900 dark:text-zinc-200" />
                </div>
                <div>
                  <label className="text-[11px] text-zinc-500 mb-0.5 block">Key</label>
                  <input type="text" value={editKey} onChange={e => setEditKey(e.target.value)} className="w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-3 py-1.5 text-sm text-zinc-900 dark:text-zinc-200" placeholder="e.g. C major" />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="text-[11px] text-zinc-500 mb-0.5 block">Time Sig</label>
                  <select value={editTimeSig} onChange={e => setEditTimeSig(e.target.value)} className="w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-3 py-1.5 text-sm text-zinc-900 dark:text-zinc-200">
                    {TIME_SIGS.map(ts => <option key={ts} value={ts}>{ts || 'Auto'}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-[11px] text-zinc-500 mb-0.5 block">Duration</label>
                  <input type="number" value={editDuration} readOnly className="w-full bg-zinc-100 dark:bg-black/10 border border-zinc-200 dark:border-white/10 rounded-lg px-3 py-1.5 text-sm text-zinc-500 dark:text-zinc-400 opacity-60" />
                </div>
                <div>
                  <label className="text-[11px] text-zinc-500 mb-0.5 block">Language</label>
                  <select value={editLanguage} onChange={e => setEditLanguage(e.target.value)} className="w-full bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-3 py-1.5 text-sm text-zinc-900 dark:text-zinc-200">
                    {LANGUAGES.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}
                  </select>
                </div>
              </div>
              <FieldRow label={t('allInstrumental')}>
                <input type="checkbox" checked={editInstrumental} onChange={e => setEditInstrumental(e.target.checked)} className="w-4 h-4 accent-pink-500" />
              </FieldRow>
              <button onClick={handleSaveSample} disabled={saving} className="w-full py-1.5 bg-pink-500/20 hover:bg-pink-500/30 text-pink-400 rounded-lg text-xs font-medium flex items-center justify-center gap-1.5 disabled:opacity-50">
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Edit3 size={14} />}
                {t('saveSample')}
              </button>
              {editSaveStatus && <p className="text-xs text-zinc-400 mt-1.5 break-words">{editSaveStatus}</p>}
            </div>
          </Section>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <Section title={t('saveDataset')}>
              <FieldRow label={t('savePath')}>
                <input type="text" value={savePath} onChange={e => setSavePath(e.target.value)} className="flex-1 bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-3 py-1.5 text-sm text-zinc-900 dark:text-zinc-200" />
              </FieldRow>
              <button onClick={handleSaveDataset} disabled={saving} className="w-full mt-2 py-2 bg-green-500/20 hover:bg-green-500/30 text-green-400 rounded-lg text-xs font-medium flex items-center justify-center gap-1.5 disabled:opacity-50">
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                {t('saveDataset')}
              </button>
              {saveStatus && <p className="text-xs text-zinc-400 mt-1.5 break-words">{saveStatus}</p>}
            </Section>

            <Section title={t('preprocessToTensors')}>
              <p className="text-[10px] text-zinc-500 mb-2">{t('preprocessDescription')}</p>
              <div className="mb-3 p-2 bg-white/[0.02] border border-white/5 rounded-lg space-y-2">
                <label className="text-[10px] text-zinc-500 font-medium">{t('loadExistingDatasetForPreprocess')}</label>
                <div className="flex gap-2">
                  <input type="text" value={preprocessDatasetPath} onChange={e => setPreprocessDatasetPath(e.target.value)} placeholder="./datasets/my_lora_dataset.json" className="flex-1 bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-3 py-1.5 text-sm text-zinc-900 dark:text-zinc-200" />
                  <button onClick={handleLoadDatasetForPreprocess} disabled={preprocessDatasetLoading} className="px-3 py-1.5 bg-blue-500/20 hover:bg-blue-500/30 text-blue-400 rounded-lg text-xs font-medium flex items-center gap-1.5 disabled:opacity-50">
                    {preprocessDatasetLoading ? <Loader2 size={14} className="animate-spin" /> : <FolderOpen size={14} />}
                    Load
                  </button>
                </div>
                {preprocessDatasetStatus && <p className="text-[10px] text-zinc-400 break-words">{preprocessDatasetStatus}</p>}
              </div>
              <FieldRow label={t('outputDir')}>
                <input type="text" value={preprocessOutputDir} onChange={e => setPreprocessOutputDir(e.target.value)} className="flex-1 bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-3 py-1.5 text-sm text-zinc-900 dark:text-zinc-200" />
              </FieldRow>
              <button onClick={handlePreprocess} disabled={preprocessing} className="w-full mt-2 py-2 bg-purple-500/20 hover:bg-purple-500/30 text-purple-400 rounded-lg text-xs font-medium flex items-center justify-center gap-1.5 disabled:opacity-50">
                {preprocessing ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
                {preprocessing ? (t('preprocessing') || 'Prétraitement...') : (t('preprocess') || 'Prétraiter')}
              </button>
              {preprocessStatus && <p className="text-xs text-zinc-400 mt-1.5 break-words">{preprocessStatus}</p>}
            </Section>
          </div>
        </>
      )}
    </>
  );
};
