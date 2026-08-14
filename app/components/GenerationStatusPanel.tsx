import React, { useEffect, useState } from 'react';
import { Loader2, Check, X, Copy, RefreshCw } from 'lucide-react';
import type { GenStage, ErrorCode } from '../services/llm/types';
import { useI18n } from '../context/I18nContext';
import type { TranslationKey } from '../i18n/translations';

/** Typed map from ErrorCode → TranslationKey so template-literal lookup stays type-safe. */
const ERROR_KEYS: Record<ErrorCode, TranslationKey> = {
  KEY_MISSING: 'aiGenerate.error.KEY_MISSING',
  KEY_INVALID: 'aiGenerate.error.KEY_INVALID',
  RATE_LIMITED: 'aiGenerate.error.RATE_LIMITED',
  INSUFFICIENT_FUNDS: 'aiGenerate.error.INSUFFICIENT_FUNDS',
  MODEL_UNAVAILABLE: 'aiGenerate.error.MODEL_UNAVAILABLE',
  SCHEMA_UNSUPPORTED: 'aiGenerate.error.SCHEMA_UNSUPPORTED',
  SCHEMA_NONCOMPLIANT: 'aiGenerate.error.SCHEMA_NONCOMPLIANT',
  INVALID_JSON: 'aiGenerate.error.INVALID_JSON',
  TIMEOUT: 'aiGenerate.error.TIMEOUT',
  NETWORK: 'aiGenerate.error.NETWORK',
  UNKNOWN: 'aiGenerate.error.UNKNOWN',
};

interface Props {
  state: GenStage;
  onCancel: () => void;
  onRetry: () => void;
  onDismiss: () => void;
}

export const GenerationStatusPanel: React.FC<Props> = ({ state, onCancel, onRetry, onDismiss }) => {
  const { t } = useI18n();
  const [tick, setTick] = useState(0);

  // Re-tick every 100ms while a run is active so elapsed timer updates
  useEffect(() => {
    const k = state.kind;
    if (k === 'connecting' || k === 'streaming' || k === 'parsing') {
      const id = setInterval(() => setTick(x => x + 1), 100);
      return () => clearInterval(id);
    }
    return undefined;
  }, [state.kind]);

  // Auto-dismiss success after 5s, cancelled after 1.5s
  useEffect(() => {
    if (state.kind === 'success') {
      const id = setTimeout(onDismiss, 5000);
      return () => clearTimeout(id);
    }
    if (state.kind === 'cancelled') {
      const id = setTimeout(onDismiss, 1500);
      return () => clearTimeout(id);
    }
    return undefined;
  }, [state.kind, onDismiss]);

  if (state.kind === 'idle') return null;

  const elapsedSec = (() => {
    if ('startedAt' in state) {
      return ((Date.now() - state.startedAt) / 1000).toFixed(1);
    }
    if ('finishedAt' in state) {
      return null;
    }
    return null;
  })();

  if (state.kind === 'connecting') {
    return (
      <div className="flex items-center gap-2 p-2 bg-zinc-100 dark:bg-zinc-800/50 rounded-lg text-xs">
        <Loader2 size={14} className="animate-spin text-pink-500" />
        <span>{t('aiGenerate.status.connecting') || 'Connecting to OpenRouter…'}</span>
        {elapsedSec && <span className="ml-2 text-zinc-500">{elapsedSec}s</span>}
        <button
          onClick={onCancel}
          className="ml-auto px-2 py-0.5 text-zinc-500 hover:text-red-500 transition-colors"
        >
          {t('aiGenerate.cancel') || 'Cancel'}
        </button>
      </div>
    );
  }

  if (state.kind === 'streaming') {
    const kb = (state.bytesReceived / 1024).toFixed(1);
    return (
      <div className="p-2 bg-zinc-100 dark:bg-zinc-800/50 rounded-lg text-xs space-y-2">
        <div className="flex items-center gap-2">
          <Loader2 size={14} className="animate-spin text-pink-500" />
          <span>{t('aiGenerate.status.streaming') || 'Generating song…'}</span>
          <span className="text-zinc-500">· {elapsedSec}s · {kb} KB</span>
          <button
            onClick={onCancel}
            className="ml-auto px-2 py-0.5 text-zinc-500 hover:text-red-500 transition-colors"
          >
            {t('aiGenerate.cancel') || 'Cancel'}
          </button>
        </div>
        <div className="h-1 rounded-full bg-zinc-200 dark:bg-white/10 overflow-hidden">
          <div className="h-full w-1/3 bg-gradient-to-r from-pink-500 to-purple-500 animate-pulse" />
        </div>
        <details className="group">
          <summary className="cursor-pointer text-[10px] text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
            {t('aiGenerate.preview.toggle') || 'Raw preview'}
          </summary>
          <pre className="mt-1 max-h-40 overflow-y-auto bg-black/40 text-zinc-300 p-2 rounded text-[10px] font-mono whitespace-pre-wrap break-all">
            {state.rawPreview || ''}
          </pre>
        </details>
      </div>
    );
  }

  if (state.kind === 'parsing') {
    return (
      <div className="flex items-center gap-2 p-2 bg-zinc-100 dark:bg-zinc-800/50 rounded-lg text-xs">
        <Loader2 size={14} className="animate-spin text-pink-500" />
        <span>{t('aiGenerate.status.parsing') || 'Validating response…'}</span>
      </div>
    );
  }

  if (state.kind === 'success') {
    const u = state.usage;
    const costStr = typeof u.costUsd === 'number'
      ? ` · $${u.costUsd.toFixed(4)}`
      : '';
    return (
      <div className="flex items-center gap-2 p-2 bg-green-50 dark:bg-green-900/30 rounded-lg text-xs border border-green-200 dark:border-green-800">
        <Check size={14} className="text-green-600 dark:text-green-400" />
        <span className="text-green-700 dark:text-green-300">
          {t('aiGenerate.status.success') || 'Done'} · {t('aiGenerate.usage.tokens') || 'Tokens'}: {u.promptTokens} in / {u.completionTokens} out{costStr}
        </span>
      </div>
    );
  }

  if (state.kind === 'cancelled') {
    return (
      <div className="flex items-center gap-2 p-2 bg-zinc-100 dark:bg-zinc-800/50 rounded-lg text-xs">
        <X size={14} className="text-zinc-500" />
        <span>{t('aiGenerate.status.cancelled') || 'Cancelled'}</span>
      </div>
    );
  }

  if (state.kind === 'error') {
    const copyDetails = () => {
      const payload = `OpenRouter error\ncode: ${state.code}\nmessage: ${state.message}\nfinishedAt: ${new Date(state.finishedAt).toISOString()}`;
      try { navigator.clipboard.writeText(payload); } catch { /* no-op */ }
    };
    const errorMessage = t(ERROR_KEYS[state.code]) || state.message || 'Generation failed';
    return (
      <div className="p-2 bg-red-50 dark:bg-red-900/30 rounded-lg text-xs space-y-1.5 border border-red-200 dark:border-red-800">
        <div className="flex items-start gap-2">
          <X size={14} className="text-red-600 dark:text-red-400 mt-0.5" />
          <span className="text-red-700 dark:text-red-300 flex-1">{errorMessage}</span>
          <button
            onClick={onDismiss}
            className="text-red-500 hover:text-red-700 dark:hover:text-red-300 px-1"
            aria-label="dismiss"
          >×</button>
        </div>
        <div className="flex gap-2 pl-6">
          <button
            onClick={onRetry}
            className="flex items-center gap-1 px-2 py-0.5 bg-zinc-200 dark:bg-white/10 text-zinc-700 dark:text-zinc-200 rounded text-[10px] hover:bg-zinc-300 dark:hover:bg-white/20 transition-colors"
          >
            <RefreshCw size={10} /> {t('aiGenerate.retry') || 'Retry'}
          </button>
          <button
            onClick={copyDetails}
            className="flex items-center gap-1 px-2 py-0.5 bg-zinc-200 dark:bg-white/10 text-zinc-700 dark:text-zinc-200 rounded text-[10px] hover:bg-zinc-300 dark:hover:bg-white/20 transition-colors"
          >
            <Copy size={10} /> {t('aiGenerate.copyDetails') || 'Copy details'}
          </button>
        </div>
      </div>
    );
  }

  return null;
};
