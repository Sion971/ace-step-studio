import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Eye, EyeOff, ChevronDown, ChevronRight, RotateCcw, Loader2, RefreshCw } from 'lucide-react';
import { llmStorage, DEFAULT_OR_CONFIG } from '../services/llm/storage';
import { getModelList, refreshModelList, testApiKey } from '../services/llm/openrouter';
import { DEFAULT_GENERATE_PROMPT, DEFAULT_FORMAT_PROMPT } from '../services/llm/prompts';
import { EditableSlider } from './EditableSlider';
import { useI18n } from '../context/I18nContext';
import type { OpenRouterConfig } from '../services/llm/types';

export const LmProviderPanel: React.FC = () => {
  const { t } = useI18n();
  const [cfg, setCfg] = useState<OpenRouterConfig>(() => llmStorage.getOpenRouter());
  const [showKey, setShowKey] = useState(false);
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');
  const [testError, setTestError] = useState<string>('');
  const [models, setModels] = useState<any[]>([]);
  const [modelQuery, setModelQuery] = useState('');
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(false);
  // Filter chips on top of the model list. 'all' = no filter, 'free' = only
  // models with prompt+completion price = 0, 'paid' = everything else.
  const [modelFilter, setModelFilter] = useState<'all' | 'free' | 'paid'>('all');
  const [showSysPromptGen, setShowSysPromptGen] = useState(false);
  const [showSysPromptFmt, setShowSysPromptFmt] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  // Persist on cfg change
  useEffect(() => { llmStorage.setOpenRouter(cfg); }, [cfg]);

  // Load models lazily when key is present (uses the 1h in-memory cache)
  const reloadModels = (force = false) => {
    if (!cfg.apiKey) { setModels([]); return; }
    setModelsLoading(true);
    (force ? refreshModelList(cfg.apiKey) : getModelList(cfg.apiKey))
      .then(setModels)
      .catch(() => setModels([]))
      .finally(() => setModelsLoading(false));
  };
  useEffect(() => {
    reloadModels(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.apiKey]);

  // Click-outside to close picker
  useEffect(() => {
    if (!modelPickerOpen) return;
    const onClick = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setModelPickerOpen(false);
        setModelQuery('');
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [modelPickerOpen]);

  const recent = llmStorage.getRecentModels();

  // Helper used both for filtering and display badge — keep the predicate in
  // one place so we never get a card showing "FREE" while being filtered out
  // of the free chip (or vice versa).
  const isFreeTier = (m: any): boolean => {
    if (!m?.pricing) return false;
    const promptCost = parseFloat(m.pricing.prompt || '0');
    const completionCost = parseFloat(m.pricing.completion || '0');
    return Number.isFinite(promptCost) && Number.isFinite(completionCost) &&
           promptCost === 0 && completionCost === 0;
  };

  // Sorted full list: free models first (alphabetical inside each bucket),
  // then paid sorted by output price ascending. The user explicitly asked
  // for free vs paid sorting + 'show all models' (the previous .slice(0, 50)
  // hid roughly 250 OpenRouter models).
  const sortedModels = useMemo(() => {
    const arr = [...models];
    arr.sort((a, b) => {
      const aFree = isFreeTier(a) ? 0 : 1;
      const bFree = isFreeTier(b) ? 0 : 1;
      if (aFree !== bFree) return aFree - bFree;
      if (aFree === 0) {
        // Both free → alphabetical by name/id
        return (a.name || a.id || '').localeCompare(b.name || b.id || '');
      }
      // Both paid → cheapest output first; if equal, by name
      const aPrice = parseFloat(a.pricing?.completion || '0');
      const bPrice = parseFloat(b.pricing?.completion || '0');
      if (aPrice !== bPrice) return aPrice - bPrice;
      return (a.name || a.id || '').localeCompare(b.name || b.id || '');
    });
    return arr;
  }, [models]);

  // After-filter list shown in the dropdown. NO arbitrary slice — show
  // all matches and rely on the scrollable container.
  const filteredModels = useMemo(() => {
    const q = modelQuery.toLowerCase().trim();
    return sortedModels.filter(m => {
      if (modelFilter === 'free' && !isFreeTier(m)) return false;
      if (modelFilter === 'paid' && isFreeTier(m)) return false;
      if (!q) return true;
      return (
        (m.id || '').toLowerCase().includes(q) ||
        (m.name || '').toLowerCase().includes(q)
      );
    });
  }, [sortedModels, modelQuery, modelFilter]);

  // Counts for the chip labels — let the user see at a glance how many
  // free vs paid models are available with their current key/tier.
  const freeCount = useMemo(() => sortedModels.filter(isFreeTier).length, [sortedModels]);
  const paidCount = sortedModels.length - freeCount;

  const recentModels = useMemo(
    () => recent.map(id => models.find(m => m.id === id)).filter((m): m is any => Boolean(m)),
    [recent, models]
  );

  const maskedKey = cfg.apiKey ? '••••••' + cfg.apiKey.slice(-4) : '';

  const onTestKey = async () => {
    if (!cfg.apiKey) return;
    setTestStatus('testing');
    setTestError('');
    try {
      await testApiKey(cfg.apiKey, cfg.model || undefined);
      setTestStatus('ok');
    } catch (e: any) {
      setTestStatus('fail');
      setTestError(e?.code || e?.message || 'failed');
    }
  };

  const selectModel = (id: string) => {
    setCfg(c => ({ ...c, model: id }));
    llmStorage.pushRecentModel(id);
    setModelQuery('');
    setModelPickerOpen(false);
  };

  const formatPrice = (s: string | undefined) => {
    if (!s) return '?';
    const n = parseFloat(s);
    if (!Number.isFinite(n)) return '?';
    return `$${(n * 1e6).toFixed(2)}/M`;
  };

  // Detect interesting traits to surface as visual badges on each card.
  // Keeps the picker scannable: at a glance you see whether a model is free,
  // a reasoning model, multimodal, or a high-end frontier model.
  const hasReasoning = (m: any): boolean => {
    const params: unknown[] = m?.supported_parameters || [];
    return params.some(p =>
      typeof p === 'string' && (p === 'reasoning' || p === 'include_reasoning')
    );
  };
  const hasVision = (m: any): boolean => {
    const inputs: unknown[] = m?.architecture?.input_modalities || [];
    if (inputs.some(i => typeof i === 'string' && i === 'image')) return true;
    // Older /v1/models payloads expose `architecture.modality` like
    // 'text+image->text'. Fall back to substring match for those.
    const modality = m?.architecture?.modality;
    return typeof modality === 'string' && modality.includes('image');
  };
  // Frontier ≈ premium pricing tier. OpenRouter doesn't expose a "frontier"
  // flag — we approximate: output ≥ $10/M tokens. Captures Claude Opus,
  // GPT-4 Turbo / GPT-5 family, Gemini 2.5 Pro etc. and excludes mid-tier
  // models like Llama / DeepSeek / Mistral that sit at $0.15-2/M.
  const isFrontier = (m: any): boolean => {
    if (isFreeTier(m)) return false;
    const completion = parseFloat(m?.pricing?.completion || '0');
    return Number.isFinite(completion) && completion >= 10e-6; // ≥ $10 per 1M tokens
  };

  // Compact trait badges — kept tight (text-[8px], px-1) so they don't
  // dominate the row. Order: FREE / FRONTIER / THINK / VISION.
  const Badge: React.FC<{ tone: 'green' | 'amber' | 'purple' | 'sky'; title?: string; children: React.ReactNode }> = ({ tone, title, children }) => {
    const toneClass = {
      green:  'bg-green-500/15 text-green-700 dark:text-green-300 ring-green-500/30',
      amber:  'bg-amber-500/15 text-amber-700 dark:text-amber-300 ring-amber-500/30',
      purple: 'bg-purple-500/15 text-purple-700 dark:text-purple-300 ring-purple-500/30',
      sky:    'bg-sky-500/15 text-sky-700 dark:text-sky-300 ring-sky-500/30',
    }[tone];
    return (
      <span title={title} className={`text-[8px] font-semibold uppercase tracking-wide px-1 py-0 rounded ring-1 ring-inset ${toneClass}`}>
        {children}
      </span>
    );
  };
  const renderBadges = (m: any) => (
    <>
      {isFreeTier(m)    && <Badge tone="green">FREE</Badge>}
      {isFrontier(m)    && <Badge tone="amber" title="Frontier-tier pricing">FRONTIER</Badge>}
      {hasReasoning(m)  && <Badge tone="purple" title="Reasoning model">THINK</Badge>}
      {hasVision(m)     && <Badge tone="sky" title="Multimodal — accepts images">VISION</Badge>}
    </>
  );

  // Strip noisy "(free)" / ":free" markers OpenRouter appends to model
  // display names — we already show the FREE badge so the duplication
  // adds visual clutter to every row.
  const cleanName = (m: any): string => {
    const s = (m?.name || m?.id || '') as string;
    return s.replace(/\s*\(free\)\s*$/i, '').replace(/:free$/i, '').trim();
  };

  // Effective values for textareas (default text rendered as initial value)
  const valueGen = cfg.systemPromptGenerate || DEFAULT_GENERATE_PROMPT;
  const valueFmt = cfg.systemPromptFormat || DEFAULT_FORMAT_PROMPT;

  return (
    <div className="space-y-3 p-3 bg-zinc-50 dark:bg-black/20 rounded-lg border border-zinc-200 dark:border-white/5">
      {/* API Key */}
      <div>
        <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
          {t('lmProvider.apiKey') || 'OpenRouter API Key'}
        </label>
        <div className="flex gap-1 mt-1">
          <div className="flex-1 relative">
            <input
              type={showKey ? 'text' : 'password'}
              value={cfg.apiKey}
              onChange={e => { setCfg(c => ({ ...c, apiKey: e.target.value })); setTestStatus('idle'); }}
              placeholder={cfg.apiKey ? maskedKey : 'sk-or-...'}
              className="w-full bg-white dark:bg-black/40 border border-zinc-200 dark:border-white/10 rounded px-2 py-1 text-xs pr-7"
            />
            <button
              type="button"
              onClick={() => setShowKey(!showKey)}
              className="absolute right-1 top-1/2 -translate-y-1/2 p-1 text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
              aria-label={showKey ? 'Hide' : 'Show'}
            >
              {showKey ? <EyeOff size={12} /> : <Eye size={12} />}
            </button>
          </div>
          <button
            type="button"
            onClick={onTestKey}
            disabled={!cfg.apiKey || testStatus === 'testing'}
            className="px-2 py-1 text-xs bg-pink-600 hover:bg-pink-700 disabled:bg-zinc-400 dark:disabled:bg-zinc-700 disabled:cursor-not-allowed text-white rounded transition-colors flex items-center gap-1"
          >
            {testStatus === 'testing' && <Loader2 size={10} className="animate-spin" />}
            {t('lmProvider.testKey') || 'Test'}
          </button>
          {testStatus === 'ok' && <span className="text-green-500 text-xs px-1 self-center">✓</span>}
          {testStatus === 'fail' && (
            <span className="text-red-500 text-xs px-1 self-center" title={testError}>✗</span>
          )}
        </div>
        <p className="text-[10px] text-zinc-500 mt-1">
          Stored in your browser&apos;s localStorage. Get a key at openrouter.ai/keys.
        </p>
      </div>

      {/* Model picker */}
      <div ref={pickerRef}>
        <div className="flex items-center justify-between">
          <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
            {t('lmProvider.modelPicker.search') || 'Model'}
          </label>
          <button
            type="button"
            onClick={() => reloadModels(true)}
            disabled={!cfg.apiKey || modelsLoading}
            title="Refresh model list (bypasses 1h cache)"
            className="flex items-center gap-1 text-[10px] text-zinc-500 hover:text-pink-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <RefreshCw size={10} className={modelsLoading ? 'animate-spin' : ''} />
            {modelsLoading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
        <input
          value={modelPickerOpen ? modelQuery : cfg.model}
          onChange={e => { setModelQuery(e.target.value); setModelPickerOpen(true); }}
          onFocus={() => setModelPickerOpen(true)}
          onKeyDown={e => {
            if (e.key === 'Enter' && modelQuery.trim()) {
              e.preventDefault();
              selectModel(modelQuery.trim());
            }
            if (e.key === 'Escape') {
              setModelPickerOpen(false);
              setModelQuery('');
            }
          }}
          placeholder={modelsLoading ? 'Loading…' : 'Pick a model from the list…'}
          className={`w-full mt-1 bg-white dark:bg-black/40 border rounded px-2 py-1 text-xs ${!cfg.model ? 'border-amber-500/60' : 'border-zinc-200 dark:border-white/10'}`}
        />
        {!cfg.model && cfg.apiKey && !modelsLoading && (
          <p className="text-[10px] text-amber-600 dark:text-amber-500 mt-1">
            Pick a model — the list is fetched live from openrouter.ai/api/v1/models.
          </p>
        )}
        {modelPickerOpen && (
          <div className="mt-1 max-h-72 overflow-y-auto border border-zinc-200 dark:border-white/10 rounded bg-white dark:bg-zinc-900">
            {/* Filter chips — sticky during scroll. Compact form: count
                lives inside the chip in muted parens, not on a second line.
                Right-side counter shows current filter result count. */}
            <div className="sticky top-0 z-10 flex items-center gap-1.5 px-2 py-1 bg-zinc-50/95 dark:bg-zinc-800/95 backdrop-blur-sm border-b border-zinc-200 dark:border-white/10">
              {([
                ['all',  t('lmProvider.modelPicker.filterAll')  || 'All',  sortedModels.length],
                ['free', t('lmProvider.modelPicker.filterFree') || 'Free', freeCount],
                ['paid', t('lmProvider.modelPicker.filterPaid') || 'Paid', paidCount],
              ] as const).map(([key, label, count]) => {
                const active = modelFilter === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setModelFilter(key)}
                    className={`text-[10px] leading-none px-2 py-1 rounded-full transition-colors ${
                      active
                        ? 'bg-pink-600 text-white'
                        : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200/70 dark:hover:bg-white/5'
                    }`}
                  >
                    {label}
                    <span className={`ml-1 ${active ? 'text-white/70' : 'text-zinc-500'}`}>
                      {count}
                    </span>
                  </button>
                );
              })}
              <span className="ml-auto text-[10px] text-zinc-500 tabular-nums">
                {filteredModels.length}
              </span>
            </div>
            {recentModels.length > 0 && (
              <>
                <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-zinc-500 bg-zinc-50 dark:bg-zinc-800">
                  {t('lmProvider.modelPicker.recentlyUsed') || 'Recently used'}
                </div>
                {recentModels.map(m => (
                  <button
                    key={`recent-${m.id}`}
                    onClick={() => selectModel(m.id)}
                    type="button"
                    className="w-full text-left px-2 py-1.5 text-xs hover:bg-zinc-100 dark:hover:bg-white/5 border-b border-zinc-100 dark:border-white/5 last:border-b-0"
                  >
                    <div className="font-medium flex items-center gap-1 min-w-0">
                      <span className="truncate">{cleanName(m)}</span>
                      <span className="flex items-center gap-1 flex-shrink-0">{renderBadges(m)}</span>
                    </div>
                    <div className="text-[10px] text-zinc-500 truncate">
                      {isFreeTier(m)
                        ? <>ctx {m.context_length || '—'}</>
                        : <>ctx {m.context_length || '—'} · in {formatPrice(m.pricing?.prompt)} · out {formatPrice(m.pricing?.completion)}</>
                      }
                    </div>
                  </button>
                ))}
              </>
            )}
            {filteredModels.length > 0 && (
              <>
                <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-zinc-500 bg-zinc-50 dark:bg-zinc-800">
                  {modelQuery ? 'Search results' : 'All models'}
                </div>
                {filteredModels.map(m => (
                  <button
                    key={m.id}
                    onClick={() => selectModel(m.id)}
                    type="button"
                    className="w-full text-left px-2 py-1.5 text-xs hover:bg-zinc-100 dark:hover:bg-white/5 border-b border-zinc-100 dark:border-white/5 last:border-b-0"
                  >
                    <div className="font-medium flex items-center gap-1 min-w-0">
                      <span className="truncate">{cleanName(m)}</span>
                      <span className="flex items-center gap-1 flex-shrink-0">{renderBadges(m)}</span>
                    </div>
                    <div className="text-[10px] text-zinc-500 truncate">
                      {isFreeTier(m)
                        ? <>ctx {m.context_length || '—'}</>
                        : <>ctx {m.context_length || '—'} · in {formatPrice(m.pricing?.prompt)} · out {formatPrice(m.pricing?.completion)}</>
                      }
                    </div>
                  </button>
                ))}
              </>
            )}
            {filteredModels.length === 0 && recentModels.length === 0 && (
              <div className="px-2 py-1 text-[10px] text-zinc-500">
                {modelsLoading ? 'Loading…' : (cfg.apiKey ? 'No models found' : 'Enter API key to load models')}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Sliders */}
      <EditableSlider
        label={t('lmProvider.temperature') || 'Temperature'}
        value={cfg.temperature}
        min={0}
        max={2}
        step={0.05}
        onChange={v => setCfg(c => ({ ...c, temperature: v }))}
        autoLabel=""
      />
      <EditableSlider
        label={t('lmProvider.topP') || 'Top P'}
        value={cfg.topP}
        min={0}
        max={1}
        step={0.01}
        onChange={v => setCfg(c => ({ ...c, topP: v }))}
        autoLabel=""
      />
      <EditableSlider
        label={t('lmProvider.topK') || 'Top K'}
        value={cfg.topK}
        min={0}
        max={200}
        step={1}
        onChange={v => setCfg(c => ({ ...c, topK: v }))}
        autoLabel="off"
      />
      <EditableSlider
        label={t('lmProvider.minP') || 'Min P'}
        value={cfg.minP}
        min={0}
        max={1}
        step={0.01}
        onChange={v => setCfg(c => ({ ...c, minP: v }))}
        autoLabel="off"
      />
      <EditableSlider
        label={t('lmProvider.frequencyPenalty') || 'Frequency penalty'}
        value={cfg.frequencyPenalty}
        min={-2}
        max={2}
        step={0.05}
        onChange={v => setCfg(c => ({ ...c, frequencyPenalty: v }))}
        autoLabel=""
      />
      <EditableSlider
        label={t('lmProvider.presencePenalty') || 'Presence penalty'}
        value={cfg.presencePenalty}
        min={-2}
        max={2}
        step={0.05}
        onChange={v => setCfg(c => ({ ...c, presencePenalty: v }))}
        autoLabel=""
      />
      <EditableSlider
        label={t('lmProvider.repetitionPenalty') || 'Repetition penalty'}
        value={cfg.repetitionPenalty}
        min={0}
        max={2}
        step={0.05}
        onChange={v => setCfg(c => ({ ...c, repetitionPenalty: v }))}
        autoLabel=""
      />

      {/* Max tokens */}
      <div>
        <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
          {t('lmProvider.maxTokens') || 'Max tokens'}
        </label>
        <input
          type="number"
          value={cfg.maxTokens}
          min={1}
          max={32000}
          onChange={e => {
            const raw = e.target.value;
            if (raw === '') {
              setCfg(c => ({ ...c, maxTokens: 1 }));
              return;
            }
            const n = parseInt(raw, 10);
            if (Number.isFinite(n)) {
              setCfg(c => ({ ...c, maxTokens: Math.max(1, Math.min(32000, n)) }));
            }
            // else: keep previous value
          }}
          className="w-full mt-1 bg-white dark:bg-black/40 border border-zinc-200 dark:border-white/10 rounded px-2 py-1 text-xs"
        />
      </div>

      {/* Seed */}
      <div>
        <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
          {t('lmProvider.seed') || 'Seed'}
        </label>
        <input
          type="number"
          value={cfg.seed === null ? '' : cfg.seed}
          onChange={e => {
            const raw = e.target.value;
            if (raw === '') {
              setCfg(c => ({ ...c, seed: null }));
            } else {
              const n = parseInt(raw, 10);
              if (Number.isFinite(n)) {
                setCfg(c => ({ ...c, seed: n }));
              }
              // else: keep previous value (don't update)
            }
          }}
          placeholder="random"
          className="w-full mt-1 bg-white dark:bg-black/40 border border-zinc-200 dark:border-white/10 rounded px-2 py-1 text-xs"
        />
      </div>

      {/* System prompt — Generate */}
      <div>
        <button
          type="button"
          onClick={() => setShowSysPromptGen(!showSysPromptGen)}
          className="flex items-center gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white transition-colors"
        >
          {showSysPromptGen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {t('lmProvider.systemPromptGenerate') || 'System prompt — Generate'}
          {cfg.systemPromptGenerate && <span className="text-[10px] text-pink-500 ml-1">(custom)</span>}
        </button>
        {showSysPromptGen && (
          <div className="mt-1 space-y-1">
            <textarea
              value={valueGen}
              onChange={e => setCfg(c => ({ ...c, systemPromptGenerate: e.target.value }))}
              rows={20}
              className="w-full bg-white dark:bg-black/40 border border-zinc-200 dark:border-white/10 rounded px-2 py-1 text-[11px] font-mono whitespace-pre"
              spellCheck={false}
            />
            <div className="flex justify-between items-center">
              <p className="text-[10px] text-zinc-500">
                {cfg.systemPromptGenerate
                  ? 'Custom prompt — overrides the default.'
                  : 'Showing the default prompt. Edit to override.'}
              </p>
              {cfg.systemPromptGenerate && (
                <button
                  type="button"
                  onClick={() => setCfg(c => ({ ...c, systemPromptGenerate: '' }))}
                  className="flex items-center gap-1 text-[10px] text-zinc-500 hover:text-pink-500 transition-colors"
                >
                  <RotateCcw size={10} /> Reset to default
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* System prompt — Format */}
      <div>
        <button
          type="button"
          onClick={() => setShowSysPromptFmt(!showSysPromptFmt)}
          className="flex items-center gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white transition-colors"
        >
          {showSysPromptFmt ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {t('lmProvider.systemPromptFormat') || 'System prompt — Format'}
          {cfg.systemPromptFormat && <span className="text-[10px] text-pink-500 ml-1">(custom)</span>}
        </button>
        {showSysPromptFmt && (
          <div className="mt-1 space-y-1">
            <textarea
              value={valueFmt}
              onChange={e => setCfg(c => ({ ...c, systemPromptFormat: e.target.value }))}
              rows={20}
              className="w-full bg-white dark:bg-black/40 border border-zinc-200 dark:border-white/10 rounded px-2 py-1 text-[11px] font-mono whitespace-pre"
              spellCheck={false}
            />
            <div className="flex justify-between items-center">
              <p className="text-[10px] text-zinc-500">
                {cfg.systemPromptFormat
                  ? 'Custom prompt — overrides the default.'
                  : 'Showing the default prompt. Edit to override.'}
              </p>
              {cfg.systemPromptFormat && (
                <button
                  type="button"
                  onClick={() => setCfg(c => ({ ...c, systemPromptFormat: '' }))}
                  className="flex items-center gap-1 text-[10px] text-zinc-500 hover:text-pink-500 transition-colors"
                >
                  <RotateCcw size={10} /> Reset to default
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
