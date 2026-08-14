import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Eye, EyeOff, Loader2, RefreshCw } from 'lucide-react';
import { pollinationsStorage, DEFAULT_POL_CONFIG } from '../services/pollinations/storage';
import {
  getPollinationsModels,
  refreshPollinationsModels,
  testPollinationsKey,
} from '../services/pollinations/client';
import type { PollinationsConfig, PolModelInfo } from '../services/pollinations/types';
import { useI18n } from '../context/I18nContext';

/**
 * Settings panel for the Pollinations.ai cover-generation provider.
 * Mirrors LmProviderPanel structure but slimmer — Pollinations exposes far
 * fewer knobs (no temperature/topK/system prompts; just model + dimensions
 * + a few flags).
 *
 * API key is optional — anonymous tier works (rate-limited). Token from
 * auth.pollinations.ai (pk_ or sk_ prefix) lifts to Seed tier.
 */
export const PollinationsPanel: React.FC = () => {
  const { t } = useI18n();
  const [cfg, setCfg] = useState<PollinationsConfig>(() => pollinationsStorage.getConfig());
  const [showKey, setShowKey] = useState(false);
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');
  const [testError, setTestError] = useState<string>('');
  const [models, setModels] = useState<PolModelInfo[]>([]);
  const [modelQuery, setModelQuery] = useState('');
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  // Persist on every cfg change
  useEffect(() => { pollinationsStorage.setConfig(cfg); }, [cfg]);

  const reloadModels = (force = false) => {
    setModelsLoading(true);
    (force ? refreshPollinationsModels(cfg.apiKey) : getPollinationsModels(cfg.apiKey))
      .then(setModels)
      .catch(() => setModels([]))
      .finally(() => setModelsLoading(false));
  };
  // Pollinations /models works without a key (anonymous tier), so we trigger
  // the load on mount and whenever the key changes (new key may unlock more).
  // Debounced 400ms so a typed key doesn't fire one /models per keystroke
  // (anonymous tier is rate-limited 1 req/15s — burst typing → 429 → empty list).
  useEffect(() => {
    const id = setTimeout(() => reloadModels(false), 400);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.apiKey]);

  // Click-outside to close the picker
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

  const recent = pollinationsStorage.getRecentModels();

  const filteredModels = useMemo(() => {
    const q = modelQuery.toLowerCase().trim();
    // No arbitrary slice — Pollinations now lists 30+ models with auth and the
    // hard cap was hiding everything past 'sana'. Container scrolls.
    return q
      ? models.filter(m => m.id.toLowerCase().includes(q) || (m.description || '').toLowerCase().includes(q))
      : models;
  }, [models, modelQuery]);

  const recentModels = useMemo(
    () => recent.map(id => models.find(m => m.id === id)).filter((m): m is PolModelInfo => Boolean(m)),
    [recent, models]
  );

  const maskedKey = cfg.apiKey ? '••••••' + cfg.apiKey.slice(-4) : '';

  const onTestKey = async () => {
    setTestStatus('testing');
    setTestError('');
    try {
      await testPollinationsKey(cfg.apiKey);
      setTestStatus('ok');
    } catch (e: any) {
      setTestStatus('fail');
      setTestError(e?.code || e?.message || 'failed');
    }
  };

  const selectModel = (id: string) => {
    setCfg(c => ({ ...c, model: id }));
    pollinationsStorage.pushRecentModel(id);
    setModelQuery('');
    setModelPickerOpen(false);
  };

  const clampInt = (raw: string, min: number, max: number, fallback: number): number => {
    // Empty input means user is mid-typing — keep the previous value instead
    // of snapping to `min` (which would lock width/height to 256 the moment
    // the user erases the field to retype a different number).
    if (raw === '') return fallback;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  };

  return (
    <div className="space-y-3 p-3 bg-zinc-50 dark:bg-black/20 rounded-lg border border-zinc-200 dark:border-white/5">
      {/* API Key */}
      <div>
        <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
          {t('pollinations.apiKey') || 'Pollinations API Key'}
          <span className="text-zinc-400 ml-1 font-normal">({t('pollinations.optional') || 'optional'})</span>
        </label>
        <div className="flex gap-1 mt-1">
          <div className="flex-1 relative">
            <input
              type={showKey ? 'text' : 'password'}
              value={cfg.apiKey}
              onChange={e => { setCfg(c => ({ ...c, apiKey: e.target.value })); setTestStatus('idle'); }}
              placeholder={cfg.apiKey ? maskedKey : 'sk_... or pk_... (optional)'}
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
            disabled={testStatus === 'testing'}
            className="px-2 py-1 text-xs bg-pink-600 hover:bg-pink-700 disabled:bg-zinc-400 dark:disabled:bg-zinc-700 disabled:cursor-not-allowed text-white rounded transition-colors flex items-center gap-1"
          >
            {testStatus === 'testing' && <Loader2 size={10} className="animate-spin" />}
            {t('pollinations.testKey') || 'Test'}
          </button>
          {testStatus === 'ok' && <span className="text-green-500 text-xs px-1 self-center">✓</span>}
          {testStatus === 'fail' && (
            <span className="text-red-500 text-xs px-1 self-center" title={testError}>✗</span>
          )}
        </div>
        <p className="text-[10px] text-zinc-500 mt-1">
          {t('pollinations.keyHint') ||
            'Anonymous tier works (1 req/15s). Get a free token at auth.pollinations.ai for higher rate + no watermark.'}
        </p>
      </div>

      {/* Model picker */}
      <div ref={pickerRef}>
        <div className="flex items-center justify-between">
          <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
            {t('pollinations.modelPicker.search') || 'Image model'}
          </label>
          <button
            type="button"
            onClick={() => reloadModels(true)}
            disabled={modelsLoading}
            title="Refresh model list (bypasses 1h cache)"
            className="flex items-center gap-1 text-[10px] text-zinc-500 hover:text-pink-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <RefreshCw size={10} className={modelsLoading ? 'animate-spin' : ''} />
            {modelsLoading ? (t('pollinations.modelPicker.refreshing') || 'Refreshing…') : (t('pollinations.modelPicker.refresh') || 'Refresh')}
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
          placeholder={modelsLoading ? (t('pollinations.modelPicker.loading') || 'Loading…') : (t('pollinations.modelPicker.placeholder') || 'Pick a model from the list…')}
          className={`w-full mt-1 bg-white dark:bg-black/40 border rounded px-2 py-1 text-xs ${!cfg.model ? 'border-amber-500/60' : 'border-zinc-200 dark:border-white/10'}`}
        />
        {!cfg.model && !modelsLoading && (
          <p className="text-[10px] text-amber-600 dark:text-amber-500 mt-1">
            {t('pollinations.modelPicker.pickHint') || 'Pick a model — list is fetched live from image.pollinations.ai/models.'}
          </p>
        )}
        {modelPickerOpen && (
          <div className="mt-1 max-h-64 overflow-y-auto border border-zinc-200 dark:border-white/10 rounded bg-white dark:bg-zinc-900">
            {recentModels.length > 0 && (
              <>
                <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-zinc-500 bg-zinc-50 dark:bg-zinc-800">
                  {t('pollinations.modelPicker.recentlyUsed') || 'Recently used'}
                </div>
                {recentModels.map(m => (
                  <button
                    key={`recent-${m.id}`}
                    onClick={() => selectModel(m.id)}
                    type="button"
                    className="w-full text-left px-2 py-1 text-xs hover:bg-zinc-100 dark:hover:bg-white/5"
                  >
                    <div className="font-medium truncate">{m.id}</div>
                    {m.description && (
                      <div className="text-[10px] text-zinc-500 truncate">{m.description}</div>
                    )}
                  </button>
                ))}
              </>
            )}
            {filteredModels.length > 0 && (
              <>
                <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-zinc-500 bg-zinc-50 dark:bg-zinc-800">
                  {modelQuery ? (t('pollinations.modelPicker.searchResults') || 'Search results') : (t('pollinations.modelPicker.allModels') || 'All models')}
                </div>
                {filteredModels.map(m => (
                  <button
                    key={m.id}
                    onClick={() => selectModel(m.id)}
                    type="button"
                    className="w-full text-left px-2 py-1 text-xs hover:bg-zinc-100 dark:hover:bg-white/5"
                  >
                    <div className="font-medium truncate">{m.id}</div>
                    {m.description && (
                      <div className="text-[10px] text-zinc-500 truncate">{m.description}</div>
                    )}
                  </button>
                ))}
              </>
            )}
            {filteredModels.length === 0 && recentModels.length === 0 && (
              <div className="px-2 py-1 text-[10px] text-zinc-500">
                {modelsLoading ? (t('pollinations.modelPicker.loading') || 'Loading…') : (t('pollinations.modelPicker.empty') || 'No models found')}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Width / Height */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
            {t('pollinations.width') || 'Width'}
          </label>
          <input
            type="number"
            value={cfg.width}
            min={256}
            max={2048}
            step={64}
            onChange={e => setCfg(c => ({ ...c, width: clampInt(e.target.value, 256, 2048, c.width) }))}
            className="w-full mt-1 bg-white dark:bg-black/40 border border-zinc-200 dark:border-white/10 rounded px-2 py-1 text-xs"
          />
        </div>
        <div>
          <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
            {t('pollinations.height') || 'Height'}
          </label>
          <input
            type="number"
            value={cfg.height}
            min={256}
            max={2048}
            step={64}
            onChange={e => setCfg(c => ({ ...c, height: clampInt(e.target.value, 256, 2048, c.height) }))}
            className="w-full mt-1 bg-white dark:bg-black/40 border border-zinc-200 dark:border-white/10 rounded px-2 py-1 text-xs"
          />
        </div>
      </div>
      <p className="text-[10px] text-zinc-500 -mt-1">
        {t('pollinations.dimsHint') ||
          'Square 1024×1024 recommended. Some free-tier models ignore size and return their native resolution (e.g. sana → 768×768).'}
      </p>

      {/* Seed mode */}
      <div>
        <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
          {t('pollinations.seedMode') || 'Seed'}
        </label>
        <div className="flex gap-1 mt-1">
          <button
            type="button"
            onClick={() => setCfg(c => ({ ...c, seedMode: 'song' }))}
            className={`flex-1 px-2 py-1 text-xs rounded border transition-colors ${cfg.seedMode === 'song'
              ? 'bg-pink-600 border-pink-600 text-white'
              : 'bg-white dark:bg-black/40 border-zinc-200 dark:border-white/10 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-white/5'}`}
          >
            {t('pollinations.seedSong') || 'From song id (reproducible)'}
          </button>
          <button
            type="button"
            onClick={() => setCfg(c => ({ ...c, seedMode: 'random' }))}
            className={`flex-1 px-2 py-1 text-xs rounded border transition-colors ${cfg.seedMode === 'random'
              ? 'bg-pink-600 border-pink-600 text-white'
              : 'bg-white dark:bg-black/40 border-zinc-200 dark:border-white/10 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-white/5'}`}
          >
            {t('pollinations.seedRandom') || 'Random'}
          </button>
        </div>
      </div>

      {/* Toggles: enhance / nologo / safe */}
      <div className="space-y-1.5">
        <Toggle
          label={t('pollinations.enhance') || 'Enhance prompt (Pollinations LLM expands short prompts)'}
          value={cfg.enhance}
          onChange={v => setCfg(c => ({ ...c, enhance: v }))}
        />
        <Toggle
          label={t('pollinations.nologo') || 'No watermark (only effective with valid token)'}
          value={cfg.nologo}
          onChange={v => setCfg(c => ({ ...c, nologo: v }))}
        />
        <Toggle
          label={t('pollinations.safe') || 'Safe / SFW filter'}
          value={cfg.safe}
          onChange={v => setCfg(c => ({ ...c, safe: v }))}
        />
      </div>

      {/* Reset to defaults — useful safety valve when sliders get weird */}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setCfg({ ...DEFAULT_POL_CONFIG, apiKey: cfg.apiKey, model: cfg.model })}
          className="text-[10px] text-zinc-500 hover:text-pink-500 transition-colors"
        >
          {t('pollinations.resetDefaults') || 'Reset to defaults'}
        </button>
      </div>
    </div>
  );
};

const Toggle: React.FC<{ label: string; value: boolean; onChange: (v: boolean) => void }> = ({ label, value, onChange }) => (
  <div className="flex items-center justify-between">
    <span className="text-[11px] text-zinc-600 dark:text-zinc-400 pr-2">{label}</span>
    <button
      type="button"
      onClick={() => onChange(!value)}
      className={`w-8 h-4 rounded-full flex items-center transition-colors duration-200 px-0.5 border border-zinc-200 dark:border-white/5 cursor-pointer flex-shrink-0 ${value ? 'bg-pink-600' : 'bg-zinc-300 dark:bg-black/40'}`}
      aria-pressed={value}
    >
      <div className={`w-3 h-3 rounded-full bg-white transform transition-transform duration-200 shadow-sm ${value ? 'translate-x-4' : 'translate-x-0'}`} />
    </button>
  </div>
);
