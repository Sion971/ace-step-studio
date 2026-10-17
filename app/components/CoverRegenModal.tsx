import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { X, Loader2, Sparkles, Save, RefreshCw, Upload } from 'lucide-react';
import { useI18n } from '../context/I18nContext';
import { songsApi, CoverApiError } from '../services/api';
import { buildCoverPrompt } from '../services/cover/prompts';
import type { Song } from '../types';

/**
 * Manual cover regeneration modal.
 *
 * Layout follows the convention used by image-generation tools: controls on the LEFT (prompt + actions), a large square
 * preview + history strip on the RIGHT. On narrow screens the two columns stack vertically.
 *
 * "Generate" asks the server to draw the cover with the local image model (SDXL Turbo, GPU): the server returns the image
 * without saving it, so that the user can try again. "Upload" takes an image from disk instead — the only way on a machine
 * without a GPU. On Save the picked blob is uploaded to /api/songs/:id/regen-cover, which writes the file under the same
 * `${userId}/covers/${songId}.{ext}` path the auto-pipeline uses, so playback / downloads / sidebar all see the new cover
 * with no extra plumbing.
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
  /** 'ai' for a generated image, 'upload' for a file from disk */
  source: 'ai' | 'upload';
  /** Seed used for this generation — surfaced as a small caption so the user can re-roll knowing what changed. */
  seed: number;
}

export const CoverRegenModal: React.FC<Props> = ({ song, token, onClose, onCoverSaved }) => {
  const { t } = useI18n();

  // Prompt prefill — a short visual hint derived from the song's caption / style. The user can override it completely;
  // we only seed something useful so that hitting "Generate" right away produces a reasonable image.
  const initialPrompt = useMemo(
    () => buildCoverPrompt({ title: song.title || '', caption: song.style || '', topic: '', language: 'en', instrumental: false }),
    [song.style, song.title],
  );

  const [prompt, setPrompt] = useState(initialPrompt);
  const [aiAvailable, setAiAvailable] = useState<boolean | null>(null);

  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>('');

  // Generation history. Keep latest first; cap at 6 to bound memory (each blob URL pins its Blob until revoked).
  const [history, setHistory] = useState<PreviewItem[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);

  // Mirror history into a ref so the unmount cleanup effect (deps=[]) reads the latest list, not the initial [] frozen at
  // mount time. Without this every blob created during the modal session leaks.
  const historyRef = useRef<PreviewItem[]>([]);
  useEffect(() => { historyRef.current = history; }, [history]);

  // AbortController so we can cancel an in-flight request when the modal closes mid-generation; otherwise the bytes
  // still come back and setState fires on an unmounted tree.
  const abortRef = useRef<AbortController | null>(null);

  // Hidden <input type=file> for the "Upload from disk" path.
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Can this machine make AI covers? Asked once; the answer only decides whether the Generate button is usable.
  useEffect(() => {
    let alive = true;
    songsApi.coverAiStatus(token)
      .then((s) => { if (alive) setAiAvailable(s.available); })
      .catch(() => { if (alive) setAiAvailable(null); });
    return () => { alive = false; };
  }, [token]);

  // Revoke object URLs on unmount to free Blob memory. We do not revoke on every history mutation — the <img> still
  // references the URL while a previous generation is selected.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      historyRef.current.forEach(h => URL.revokeObjectURL(h.url));
    };
  }, []);

  // ESC closes the modal — common modal UX.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const pushItem = useCallback((item: PreviewItem) => {
    setHistory(prev => {
      const next = [item, ...prev];
      // Cap at 6 — revoke evicted blobs to free Blob memory.
      next.slice(6).forEach(e => URL.revokeObjectURL(e.url));
      return next.slice(0, 6);
    });
    setSelectedIdx(0);
  }, []);

  const handleGenerate = useCallback(async () => {
    setError('');
    if (!prompt.trim()) {
      setError(t('coverRegen.errEmptyPrompt'));
      return;
    }
    setGenerating(true);

    // Each Generate click uses a fresh random seed — that is what gives the "Try again" feeling.
    const seed = Math.floor(Math.random() * 0x7fffffff);

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const { blob } = await songsApi.generateCover(prompt, token, seed, ac.signal);
      pushItem({ url: URL.createObjectURL(blob), blob, prompt, source: 'ai', seed });
    } catch (e: any) {
      if (e?.name === 'AbortError') return; // benign — user closed/regenerated
      console.warn('[cover-regen] generation failed:', e);
      if (e instanceof CoverApiError && e.code === 'AI_UNAVAILABLE') {
        setAiAvailable(false);
        setError(t('coverRegen.errUnavailable'));
      } else if (e instanceof CoverApiError && e.code === 'EMPTY_PROMPT') {
        setError(t('coverRegen.errEmptyPrompt'));
      } else {
        setError(t('coverRegen.errFailed'));
      }
    } finally {
      setGenerating(false);
    }
  }, [prompt, token, t, pushItem]);

  // Pick a local file and add it to the history so the existing preview / save flow handles it. We accept image/* here
  // instead of a strict whitelist because browsers' file pickers are inconsistent about MIME — the backend's
  // coverUpload.fileFilter does the strict check and will reject anything else with a 400.
  const handleUploadFile = useCallback((file: File) => {
    setError('');
    if (!file.type.startsWith('image/')) {
      setError(t('coverRegen.errNotImage'));
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      // Backend cap is 10MB — fail fast in the UI.
      setError(t('coverRegen.errTooLarge'));
      return;
    }
    pushItem({ url: URL.createObjectURL(file), blob: file, prompt: `[uploaded] ${file.name}`, source: 'upload', seed: 0 });
  }, [t, pushItem]);

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
  const canGenerate = aiAvailable !== false;

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
            <h2 className="text-sm font-semibold">{t('coverRegen.title')}</h2>
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
            {/* Prompt — taller textarea on desktop since we have the room */}
            <div>
              <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                {t('coverRegen.prompt')}
              </label>
              <textarea
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                rows={6}
                className="w-full mt-1 bg-white dark:bg-black/40 border border-zinc-200 dark:border-white/10 rounded px-2 py-1.5 text-xs resize-none focus:outline-none focus:border-pink-500/60"
                placeholder={t('coverRegen.promptPlaceholder')}
              />
              <p className="mt-1 text-[11px] leading-snug text-zinc-500" data-cover-note>
                {canGenerate ? t('coverRegen.localHint') : t('coverRegen.errUnavailable')}
              </p>
            </div>

            {/* Action buttons. Generate is the primary CTA, Upload an alternate path that needs no GPU. */}
            <button
              type="button"
              onClick={handleGenerate}
              disabled={generating || saving || !canGenerate || !prompt.trim()}
              className="w-full px-3 py-2 text-xs font-medium bg-pink-600 hover:bg-pink-700 disabled:bg-zinc-400 dark:disabled:bg-zinc-700 disabled:cursor-not-allowed text-white rounded transition-colors flex items-center justify-center gap-2"
              data-cover-generate
            >
              {generating
                ? (<><Loader2 size={12} className="animate-spin" />{t('coverRegen.generating')}</>)
                : history.some(h => h.source === 'ai')
                  ? (<><RefreshCw size={12} />{t('coverRegen.tryAgain')}</>)
                  : (<><Sparkles size={12} />{t('coverRegen.generate')}</>)
              }
            </button>

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={generating || saving}
              title={t('coverRegen.uploadTooltip')}
              className="w-full px-3 py-2 text-xs font-medium bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed text-zinc-700 dark:text-zinc-200 border border-zinc-200 dark:border-white/10 rounded transition-colors flex items-center justify-center gap-1.5"
            >
              <Upload size={12} />
              {t('coverRegen.upload')}
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

          {/* RIGHT — preview column. Big square preview that scales to fill the available space, with a history strip
              pinned at the bottom. */}
          <div className="flex-1 p-4 flex flex-col gap-3 md:overflow-hidden bg-zinc-50/50 dark:bg-black/20">
            {/* Big preview — flex-1 + min-h-0 lets it actually shrink to fit the modal height instead of overflowing on
                small viewports. */}
            <div className="flex-1 min-h-0 flex items-center justify-center">
              {current ? (
                <div className="relative aspect-square h-full max-h-full max-w-full bg-zinc-100 dark:bg-black/40 rounded-lg overflow-hidden border border-zinc-200 dark:border-white/5 shadow-sm">
                  <img
                    src={current.url}
                    alt="Generated cover"
                    className="w-full h-full object-cover"
                  />
                  {/* Generating-overlay so iterating ("Try again") doesn't make the user stare at a blank canvas. */}
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
                      <span>{t('coverRegen.generating')}</span>
                    </>
                  ) : (
                    <>
                      <Sparkles size={32} className="text-zinc-400" />
                      <span>{t('coverRegen.noPreviewYet')}</span>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Caption + history strip — only rendered when we have something */}
            {current && (
              <div className="flex-shrink-0 space-y-2">
                <p className="text-[10px] text-zinc-500 text-center truncate">
                  {current.source === 'ai' ? `SDXL Turbo · seed ${current.seed}` : 'upload'}
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
            {t('coverRegen.cancel')}
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!current || saving || generating}
            className="px-3 py-1.5 text-xs rounded bg-pink-600 hover:bg-pink-700 disabled:bg-zinc-400 dark:disabled:bg-zinc-700 disabled:cursor-not-allowed text-white flex items-center gap-1.5 transition-colors"
          >
            {saving
              ? (<><Loader2 size={12} className="animate-spin" />{t('coverRegen.saving')}</>)
              : (<><Save size={12} />{t('coverRegen.saveAsCover')}</>)
            }
          </button>
        </div>
      </div>
    </div>
  );
};
