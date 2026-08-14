import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { X, Loader2, Sparkles, Save, RefreshCw, Upload, Search } from 'lucide-react';
import { useI18n } from '../context/I18nContext';
import { pollinationsStorage } from '../services/pollinations/storage';
import { getPollinationsModels } from '../services/pollinations/client';
import type { PolModelInfo } from '../services/pollinations/types';
import { songsApi } from '../services/api';
import type { Song } from '../types';

/**
 * Manual cover regeneration modal.
 *
 * Layout follows the convention used by image-generation tools (Civitai,
 * Krea, Midjourney web): controls on the LEFT (model + prompt + actions),
 * a large square preview + history strip on the RIGHT. On narrow screens
 * the two columns stack vertically.
 *
 * Pollinations knobs that are NOT in this modal (width/height, seed mode,
 * enhance/nologo/safe, API key) come from the persisted
 * pollinationsStorage.getConfig() — the user already configured those in
 * the main PollinationsPanel (auto-pipeline). This modal is just a quick
 * way to iterate on a single cover for an already-generated track.
 *
 * On Save the picked blob is uploaded to /api/songs/:id/regen-cover which
 * writes the file under the same `${userId}/covers/${songId}.{ext}` path
 * the auto-pipeline uses, so playback / downloads / sidebar all see the
 * new cover with no extra plumbing.
 */
interface Props {
  song: Song;
  token: string;
  onClose: () => void;
  /** Called after successful save with the new cover URL so App.tsx can
   *  update the local songs[] without a full refresh. */
  onCoverSaved: (songId: string, coverUrl: string) => void;
}

interface PreviewItem {
  /** blob: URL for <img src> */
  url: string;
  /** raw blob — used by the save endpoint upload */
  blob: Blob;
  prompt: string;
  model: string;
  /** Pollinations seed used for this generation — surfaced as a small caption
   *  so the user can re-roll knowing what changed. */
  seed: number;
}

const POL_BASE = 'https://gen.pollinations.ai/image';

export const CoverRegenModal: React.FC<Props> = ({ song, token, onClose, onCoverSaved }) => {
  const { t } = useI18n();
  const cfg = pollinationsStorage.getConfig();

  // Prompt prefill — derive a short visual hint from the song's caption / style.
  // The user can override completely; we only seed something useful so that
  // hitting "Generate" right away produces a reasonable image.
  const initialPrompt = useMemo(() => {
    const caption = (song.style || '').trim();
    const bits: string[] = ['square album cover artwork'];
    if (caption) bits.push(caption);
    bits.push('no text, no watermark');
    return bits.join(', ');
  }, [song.style]);

  const [prompt, setPrompt] = useState(initialPrompt);
  const [model, setModel] = useState<string>(cfg.model || '');
  const [models, setModels] = useState<PolModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);

  // Custom-dropdown state — we ditched the native <select> because option
  // styling is unreliable across browsers (white pop-out on dark theme,
  // truncated descriptions). Pattern is borrowed from PollinationsPanel.tsx.
  const [modelQuery, setModelQuery] = useState('');
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>('');

  // Generation history. Keep latest first; cap at 6 to bound memory (each
  // blob URL pins a 200-600KB Blob until revoked).
  const [history, setHistory] = useState<PreviewItem[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);

  // Mirror history into a ref so the unmount cleanup effect (deps=[]) reads
  // the latest list, not the initial [] frozen at mount time. Without this
  // the cleanup `history.forEach(revoke)` runs against an empty closure-
  // captured array and every blob created during the modal session leaks.
  const historyRef = useRef<PreviewItem[]>([]);
  useEffect(() => { historyRef.current = history; }, [history]);

  // AbortController so we can cancel an in-flight Pollinations call when the
  // modal closes mid-generation; otherwise the bytes still come back and
  // setState fires on an unmounted tree (warning + memory leak).
  const abortRef = useRef<AbortController | null>(null);

  // Hidden <input type=file> for the "Upload from disk" path. We trigger
  // its click programmatically from the styled button so the UI stays clean.
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Load model list on mount. /image/models is cached for 1h inside the
  // client module so this is essentially free if the user already opened
  // PollinationsPanel earlier in the session.
  useEffect(() => {
    let alive = true;
    setModelsLoading(true);
    getPollinationsModels(cfg.apiKey)
      .then(list => { if (alive) setModels(list); })
      .catch(() => { if (alive) setModels([]); })
      .finally(() => { if (alive) setModelsLoading(false); });
    return () => { alive = false; };
  }, [cfg.apiKey]);

  // Revoke object URLs on unmount to free Blob memory. We read from
  // historyRef so the cleanup sees the latest list (deps=[] would otherwise
  // capture the initial empty array — see the ref-mirror effect above).
  // We do not revoke on every history mutation — the <img> still references
  // the URL while a previous generation is selected.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      historyRef.current.forEach(h => URL.revokeObjectURL(h.url));
    };
  }, []);

  // ESC closes the modal — common modal UX. We don't trap focus or block
  // background scrolling beyond what the backdrop overlay already does.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Click-outside closes the model picker. Same pattern as PollinationsPanel.
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

  const handleGenerate = useCallback(async () => {
    setError('');
    if (!prompt.trim()) {
      setError(t('coverRegen.errEmptyPrompt') || 'Prompt is empty');
      return;
    }
    if (!model.trim()) {
      setError(t('coverRegen.errPickModel') || 'Pick a model first');
      return;
    }

    setGenerating(true);

    // Each Generate click uses a fresh random seed — that is what gives the
    // "Try again" feeling. The persisted seedMode='song' is intentionally
    // ignored here: the user is iterating, not reproducing.
    const seed = Math.floor(Math.random() * 0x7fffffff);

    // Build URL — same shape as app/server/src/services/pollinations.ts uses
    // (gen.pollinations.ai/image/{encoded-prompt}?model=…). Keeps behaviour
    // consistent with the auto-pipeline.
    const params = new URLSearchParams();
    params.set('model', model);
    params.set('width', String(cfg.width));
    params.set('height', String(cfg.height));
    params.set('seed', String(seed));
    if (cfg.nologo) params.set('nologo', 'true');
    if (cfg.enhance) params.set('enhance', 'true');
    if (cfg.safe) params.set('safe', 'true');
    const url = `${POL_BASE}/${encodeURIComponent(prompt)}?${params.toString()}`;

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const headers: Record<string, string> = { Accept: 'image/jpeg,image/png,image/*' };
      if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
      const res = await fetch(url, { headers, signal: ac.signal });
      if (!res.ok) {
        // 402 = Pollinations tier-gating: chosen model requires Flower/Nectar
        // (paid), our token is Seed or Anonymous. Surface a concrete hint
        // instead of the raw HTTP status — the user has no way to know that
        // 402 means "switch model" otherwise.
        if (res.status === 402) {
          throw new Error(
            t('coverRegen.errPaymentRequired') ||
            `Model "${model}" requires a paid Pollinations tier. Try flux or sana, or upgrade your token at auth.pollinations.ai.`
          );
        }
        if (res.status === 401 || res.status === 403) {
          throw new Error(
            t('coverRegen.errKeyInvalid') ||
            'Pollinations API key invalid or unauthorized for this model.'
          );
        }
        if (res.status === 429) {
          throw new Error(
            t('coverRegen.errRateLimited') ||
            'Rate limit hit. Wait a few seconds and try again.'
          );
        }
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (!ct.startsWith('image/')) {
        throw new Error(`Non-image response: ${ct || 'unknown'}`);
      }
      const blob = await res.blob();
      if (blob.size < 256) {
        // Same lower-bound check as the server-side helper; tiny payloads
        // are almost always a placeholder error tile.
        throw new Error('Tiny response — model likely refused the prompt');
      }
      const objectUrl = URL.createObjectURL(blob);

      setHistory(prev => {
        const next = [{ url: objectUrl, blob, prompt, model, seed }, ...prev];
        // Cap at 6 — revoke evicted blobs to free Blob memory.
        const evicted = next.slice(6);
        evicted.forEach(e => URL.revokeObjectURL(e.url));
        return next.slice(0, 6);
      });
      setSelectedIdx(0);
      // Persist the model used as a recent so the dropdown surfaces it next time.
      pollinationsStorage.pushRecentModel(model);
    } catch (e: any) {
      if (e?.name === 'AbortError') return; // benign — user closed/regenerated
      console.warn('[cover-regen] generation failed:', e);
      setError(e?.message || String(e));
    } finally {
      setGenerating(false);
    }
  }, [prompt, model, cfg.apiKey, cfg.width, cfg.height, cfg.nologo, cfg.enhance, cfg.safe, t]);

  // Pick a local file and add it to the history so the existing preview /
  // save flow handles it. We accept image/* here instead of a strict
  // jpeg+png+webp whitelist because browsers' file pickers are inconsistent
  // about MIME — the backend's coverUpload.fileFilter does the strict check
  // and will reject anything else with a 400.
  const handleUploadFile = useCallback((file: File) => {
    setError('');
    if (!file.type.startsWith('image/')) {
      setError(t('coverRegen.errNotImage') || 'File is not an image');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      // Backend cap is 10MB — fail fast in the UI.
      setError(t('coverRegen.errTooLarge') || 'File too large (max 10MB)');
      return;
    }
    const url = URL.createObjectURL(file);
    setHistory(prev => {
      const next = [{
        url,
        blob: file,
        prompt: `[uploaded] ${file.name}`,
        model: 'upload',
        // Synthetic seed for display only — no Pollinations seed exists for uploads.
        seed: 0,
      }, ...prev];
      const evicted = next.slice(6);
      evicted.forEach(e => URL.revokeObjectURL(e.url));
      return next.slice(0, 6);
    });
    setSelectedIdx(0);
  }, [t]);

  const handleSave = useCallback(async () => {
    if (!history[selectedIdx]) return;
    setSaving(true);
    setError('');
    try {
      const item = history[selectedIdx];
      const { coverUrl } = await songsApi.regenCover(song.id, item.blob, token);
      onCoverSaved(song.id, coverUrl);
      onClose();
    } catch (e: any) {
      console.warn('[cover-regen] save failed:', e);
      setError(e?.message || String(e));
    } finally {
      setSaving(false);
    }
  }, [history, selectedIdx, song.id, token, onCoverSaved, onClose]);

  const current = history[selectedIdx];

  // Recent + remaining models, dedup. Filtered by query when picker is open.
  const filteredModels = useMemo(() => {
    const recent = pollinationsStorage.getRecentModels();
    const seen = new Set<string>();
    const ordered: PolModelInfo[] = [];
    for (const id of recent) {
      const m = models.find(x => x.id === id);
      if (m && !seen.has(m.id)) { seen.add(m.id); ordered.push(m); }
    }
    for (const m of models) {
      if (!seen.has(m.id)) { seen.add(m.id); ordered.push(m); }
    }
    const q = modelQuery.toLowerCase().trim();
    if (!q) return ordered;
    return ordered.filter(m =>
      m.id.toLowerCase().includes(q) ||
      (m.description || '').toLowerCase().includes(q)
    );
  }, [models, modelQuery]);

  // Resolved label for the selected model (with description) when the
  // dropdown is closed and we want to show the current selection.
  const selectedModelLabel = useMemo(() => {
    const m = models.find(x => x.id === model);
    if (!m) return model;
    return m.description ? `${m.id} — ${m.description}` : m.id;
  }, [models, model]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-4xl bg-white dark:bg-zinc-900 rounded-xl shadow-2xl border border-zinc-200 dark:border-white/5 flex flex-col max-h-[90vh] overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200 dark:border-white/5 flex-shrink-0">
          <div className="flex items-center gap-2">
            <Sparkles size={16} className="text-pink-500" />
            <h2 className="text-sm font-semibold">
              {t('coverRegen.title') || 'Regenerate cover'}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-zinc-100 dark:hover:bg-white/5"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body — two-column layout on md+, stacked on mobile */}
        <div className="flex-1 overflow-y-auto md:overflow-hidden md:flex md:flex-row">
          {/* LEFT — settings column. Fixed width on desktop, full-width on mobile. */}
          <div className="md:w-80 md:flex-shrink-0 md:border-r md:border-zinc-200 md:dark:border-white/5 p-4 space-y-3 md:overflow-y-auto md:custom-scrollbar">
            {/* Model picker — custom dropdown so the option list inherits
                our dark theme and doesn't truncate descriptions. */}
            <div ref={pickerRef} className="relative">
              <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                {t('coverRegen.model') || 'Model'}
              </label>
              <div className="relative mt-1">
                <Search
                  size={12}
                  className="absolute left-2 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none"
                />
                <input
                  type="text"
                  value={modelPickerOpen ? modelQuery : selectedModelLabel}
                  onChange={e => { setModelQuery(e.target.value); setModelPickerOpen(true); }}
                  onFocus={() => { setModelPickerOpen(true); setModelQuery(''); }}
                  onKeyDown={e => {
                    if (e.key === 'Escape') {
                      setModelPickerOpen(false);
                      setModelQuery('');
                      (e.target as HTMLInputElement).blur();
                    }
                  }}
                  placeholder={modelsLoading
                    ? (t('coverRegen.modelsLoading') || 'Loading models…')
                    : (t('coverRegen.modelsPick') || 'Pick a model…')}
                  disabled={modelsLoading}
                  className={`w-full bg-white dark:bg-black/40 border rounded pl-7 pr-2 py-1.5 text-xs truncate
                    ${!model ? 'border-amber-500/60' : 'border-zinc-200 dark:border-white/10'}
                    focus:outline-none focus:border-pink-500/60`}
                />
              </div>
              {modelPickerOpen && (
                <div className="absolute z-10 mt-1 w-full max-h-72 overflow-y-auto custom-scrollbar border border-zinc-200 dark:border-white/10 rounded bg-white dark:bg-zinc-900 shadow-lg">
                  {filteredModels.length === 0 && (
                    <div className="px-2 py-2 text-[11px] text-zinc-500">
                      {modelsLoading
                        ? (t('coverRegen.modelsLoading') || 'Loading models…')
                        : (t('coverRegen.modelsPick') || 'No models found')}
                    </div>
                  )}
                  {filteredModels.map(m => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => {
                        setModel(m.id);
                        setModelPickerOpen(false);
                        setModelQuery('');
                      }}
                      className={`w-full text-left px-2 py-1.5 text-xs hover:bg-zinc-100 dark:hover:bg-white/5
                        ${m.id === model ? 'bg-pink-50 dark:bg-pink-500/10' : ''}`}
                    >
                      <div className={`font-medium truncate ${m.id === model ? 'text-pink-600 dark:text-pink-400' : ''}`}>
                        {m.id}
                      </div>
                      {m.description && (
                        <div className="text-[10px] text-zinc-500 truncate">{m.description}</div>
                      )}
                    </button>
                  ))}
                </div>
              )}
              {!cfg.apiKey && (
                <p className="text-[10px] text-zinc-500 mt-1">
                  {t('coverRegen.noKeyHint') ||
                    'Anonymous tier — slower, may include watermark. Set API key in the Pollinations panel.'}
                </p>
              )}
            </div>

            {/* Prompt — taller textarea on desktop since we have the room */}
            <div>
              <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                {t('coverRegen.prompt') || 'Prompt'}
              </label>
              <textarea
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                rows={6}
                className="w-full mt-1 bg-white dark:bg-black/40 border border-zinc-200 dark:border-white/10 rounded px-2 py-1.5 text-xs resize-none focus:outline-none focus:border-pink-500/60"
                placeholder={t('coverRegen.promptPlaceholder') || 'Describe the cover image…'}
              />
            </div>

            {/* Action buttons. Generate is the primary CTA, Upload is an
                alternate path that bypasses Pollinations entirely. */}
            <button
              type="button"
              onClick={handleGenerate}
              disabled={generating || saving || !model || !prompt.trim()}
              className="w-full px-3 py-2 text-xs font-medium bg-pink-600 hover:bg-pink-700 disabled:bg-zinc-400 dark:disabled:bg-zinc-700 disabled:cursor-not-allowed text-white rounded transition-colors flex items-center justify-center gap-2"
            >
              {generating
                ? (<><Loader2 size={12} className="animate-spin" />{t('coverRegen.generating') || 'Generating…'}</>)
                : history.length > 0
                  ? (<><RefreshCw size={12} />{t('coverRegen.tryAgain') || 'Try again'}</>)
                  : (<><Sparkles size={12} />{t('coverRegen.generate') || 'Generate'}</>)
              }
            </button>

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={generating || saving}
              title={t('coverRegen.uploadTooltip') || 'Upload your own image (JPEG/PNG/WEBP, max 10MB)'}
              className="w-full px-3 py-2 text-xs font-medium bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed text-zinc-700 dark:text-zinc-200 border border-zinc-200 dark:border-white/10 rounded transition-colors flex items-center justify-center gap-1.5"
            >
              <Upload size={12} />
              {t('coverRegen.upload') || 'Upload'}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={e => {
                const file = e.target.files?.[0];
                // Reset value so picking the same file twice still fires onChange.
                e.target.value = '';
                if (file) handleUploadFile(file);
              }}
            />

            {error && (
              <p className="text-xs text-red-500 px-1">{error}</p>
            )}
          </div>

          {/* RIGHT — preview column. Big square preview that scales to fill
              the available space, with a history strip pinned at the bottom. */}
          <div className="flex-1 p-4 flex flex-col gap-3 md:overflow-hidden bg-zinc-50/50 dark:bg-black/20">
            {/* Big preview — flex-1 + min-h-0 lets it actually shrink to fit
                the modal height instead of overflowing on small viewports. */}
            <div className="flex-1 min-h-0 flex items-center justify-center">
              {current ? (
                <div className="relative aspect-square h-full max-h-full max-w-full bg-zinc-100 dark:bg-black/40 rounded-lg overflow-hidden border border-zinc-200 dark:border-white/5 shadow-sm">
                  <img
                    src={current.url}
                    alt="Generated cover"
                    className="w-full h-full object-cover"
                  />
                  {/* Generating-overlay so iterating ("Try again") doesn't make
                      the user stare at a blank canvas while keeping context. */}
                  {generating && (
                    <div className="absolute inset-0 bg-black/40 flex items-center justify-center backdrop-blur-[2px]">
                      <Loader2 size={32} className="animate-spin text-white" />
                    </div>
                  )}
                </div>
              ) : (
                <div className="aspect-square h-full max-h-full max-w-full rounded-lg border border-dashed border-zinc-300 dark:border-white/10 flex flex-col items-center justify-center text-xs text-zinc-500 gap-2 p-6 text-center">
                  {generating ? (
                    <>
                      <Loader2 size={32} className="animate-spin text-pink-500" />
                      <span>{t('coverRegen.generating') || 'Generating…'}</span>
                    </>
                  ) : (
                    <>
                      <Sparkles size={32} className="text-zinc-400" />
                      <span>{t('coverRegen.noPreviewYet') || 'Press Generate or Upload to start'}</span>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Caption + history strip — only rendered when we have something */}
            {current && (
              <div className="flex-shrink-0 space-y-2">
                <p className="text-[10px] text-zinc-500 text-center truncate">
                  {current.model}
                  {current.seed > 0 ? ` · seed ${current.seed}` : ''}
                </p>
                {history.length > 1 && (
                  <div className="grid grid-cols-6 gap-1.5">
                    {history.map((h, i) => (
                      <button
                        key={h.url}
                        type="button"
                        onClick={() => setSelectedIdx(i)}
                        className={`aspect-square rounded overflow-hidden border-2 transition-colors
                          ${i === selectedIdx
                            ? 'border-pink-500'
                            : 'border-transparent hover:border-zinc-300 dark:hover:border-white/10'}`}
                      >
                        <img src={h.url} alt={`Variant ${i + 1}`} className="w-full h-full object-cover" />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Footer — Save action only enabled when there's something to save */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-zinc-200 dark:border-white/5 flex-shrink-0">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="px-3 py-1.5 text-xs rounded border border-zinc-200 dark:border-white/10 hover:bg-zinc-100 dark:hover:bg-white/5 disabled:opacity-50"
          >
            {t('coverRegen.cancel') || 'Cancel'}
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!current || saving || generating}
            className="px-3 py-1.5 text-xs rounded bg-pink-600 hover:bg-pink-700 disabled:bg-zinc-400 dark:disabled:bg-zinc-700 disabled:cursor-not-allowed text-white flex items-center gap-1.5 transition-colors"
          >
            {saving
              ? (<><Loader2 size={12} className="animate-spin" />{t('coverRegen.saving') || 'Saving…'}</>)
              : (<><Save size={12} />{t('coverRegen.saveAsCover') || 'Save as cover'}</>)
            }
          </button>
        </div>
      </div>
    </div>
  );
};
