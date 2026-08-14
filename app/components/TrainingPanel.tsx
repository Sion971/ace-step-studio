import React, { useState, useCallback } from 'react';
import {
  Database, Play, Save, Download, Upload, Edit3, ChevronRight, Zap, Music2,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useI18n } from '../context/I18nContext';

import { ModelConfigSection } from './training/ModelConfigSection';
import { DatasetTab } from './training/DatasetTab';
import { TrainTab } from './training/TrainTab';
import { ExportTab } from './training/ExportTab';

type TrainingTab = 'dataset' | 'train' | 'export';

const PIPELINE_STEPS = [
  { key: 'upload', label: 'Upload', icon: Upload },
  { key: 'edit', label: 'Edit', icon: Edit3 },
  { key: 'save', label: 'Save', icon: Save },
  { key: 'preprocess', label: 'Preprocess', icon: Zap },
  { key: 'train', label: 'Train', icon: Play },
  { key: 'export', label: 'Export', icon: Download },
] as const;

type PipelineStepKey = typeof PIPELINE_STEPS[number]['key'];

export const TrainingPanel: React.FC = () => {
  const { token } = useAuth();
  const { t } = useI18n();

  const [activeTab, setActiveTab] = useState<TrainingTab>('dataset');
  const [completedSteps, setCompletedSteps] = useState<Set<PipelineStepKey>>(new Set());

  const markStep = useCallback((step: PipelineStepKey) => {
    setCompletedSteps(prev => new Set([...prev, step]));
  }, []);

  const tabs: { id: TrainingTab; label: string; icon: React.ReactNode }[] = [
    { id: 'dataset', label: t('datasetBuilder'), icon: <Database size={16} /> },
    { id: 'train', label: t('trainLora'), icon: <Music2 size={16} /> },
    { id: 'export', label: 'Export', icon: <Download size={16} /> },
  ];

  return (
    <div className="h-full w-full flex flex-col bg-zinc-50 dark:bg-suno-panel overflow-hidden">
      {/* Header */}
      <div className="px-4 pt-4 pb-2 flex-shrink-0">
        <h2 className="text-lg font-bold text-zinc-900 dark:text-white">{t('loraTraining')}</h2>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">{t('trainingDescription')}</p>
      </div>

      {/* Pipeline Steps Tracker */}
      <div className="flex items-center gap-0.5 px-4 pb-2 flex-shrink-0 overflow-x-auto scrollbar-hide">
        {PIPELINE_STEPS.map((step, i) => {
          const Icon = step.icon;
          const done = completedSteps.has(step.key);
          return (
            <React.Fragment key={step.key}>
              {i > 0 && <ChevronRight size={10} className="text-zinc-600 flex-shrink-0" />}
              <div className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] flex-shrink-0 ${done ? 'bg-green-500/15 text-green-400' : 'bg-white/5 text-zinc-500'}`}>
                <Icon size={10} />
                {step.label}
              </div>
            </React.Fragment>
          );
        })}
      </div>

      {/* Tab Navigation */}
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

      {/* Tab Content & Active Views */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 scrollbar-hide max-w-6xl mx-auto w-full">
        {/* Configuration du modèle (Toujours accessible au sommet) */}
        <ModelConfigSection token={token} t={t} />

        {/* Panneaux dédiés */}
        {activeTab === 'dataset' && <DatasetTab token={token} t={t} markStep={markStep} />}
        {activeTab === 'train' && <TrainTab token={token} t={t} markStep={markStep} />}
        {activeTab === 'export' && <ExportTab token={token} t={t} markStep={markStep} />}
      </div>
    </div>
  );
};
