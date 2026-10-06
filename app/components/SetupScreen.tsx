import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock, Cpu, HardDrive, Loader2 } from 'lucide-react';
import { useI18n } from '../context/I18nContext';
import type { TranslationKey } from '../i18n/translations';
import {
  INITIAL_GATE,
  buildRows,
  diskView,
  formatDuration,
  formatEta,
  hardwareFacts,
  nextGate,
  screenMode,
  shouldKeepPolling,
  type PipelineStatusDto,
  type RowView,
  type ScreenGate,
  type ScreenMode,
} from '../services/setup-view';

const POLL_MS = 2000;
const RETRY_MS = 4000;
/** How long "Ready" stays on screen before the Studio takes over. */
export const READY_HOLD_MS = 1800;
export const DISMISS_STORAGE_KEY = 'setup-screen-dismissed';

function readDismissed(): boolean {
  try {
    return sessionStorage.getItem(DISMISS_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function RowIcon({ state }: { state: RowView['state'] }) {
  if (state === 'done') return <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-emerald-400" aria-hidden="true" />;
  if (state === 'failed') return <AlertTriangle className="h-4 w-4 flex-shrink-0 text-red-400" aria-hidden="true" />;
  if (state === 'downloading') return <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin text-pink-400" aria-hidden="true" />;
  return <Clock className="h-4 w-4 flex-shrink-0 text-zinc-500" aria-hidden="true" />;
}

function HeaderIcon({ mode }: { mode: ScreenMode }) {
  if (mode === 'ready') return <CheckCircle2 className="h-8 w-8 text-emerald-400" aria-hidden="true" />;
  if (mode === 'error') return <AlertTriangle className="h-8 w-8 text-red-400" aria-hidden="true" />;
  return <Loader2 className="h-8 w-8 animate-spin text-pink-400" aria-hidden="true" />;
}

/**
 * First-launch screen. It appears only when the engine, started by the Studio, has to download models (or failed
 * while some were missing), stays until the engine is ready, and can be set aside with "Continue without waiting".
 * An ordinary start, with the models already on disk, never shows it: the sidebar light is enough there.
 */
export function SetupScreen() {
  const { t, language } = useI18n();
  const [status, setStatus] = useState<PipelineStatusDto | null>(null);
  const [gate, setGate] = useState<ScreenGate>(() => ({ ...INITIAL_GATE, dismissed: readDismissed() }));
  const gateRef = useRef(gate);
  gateRef.current = gate;

  // Ask the server for the engine's status, as long as the screen is, or may become, useful.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      // A poll planned before the screen was set aside or finished must not fire once more.
      if (cancelled || gateRef.current.dismissed || gateRef.current.finished) return;
      let delay = POLL_MS;
      let keepGoing = true;
      try {
        const response = await fetch('/api/pipeline/status');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const next = (await response.json()) as PipelineStatusDto;
        if (cancelled) return;
        setStatus(next);
        const updated = nextGate(gateRef.current, next);
        if (updated !== gateRef.current) {
          gateRef.current = updated;
          setGate(updated);
        }
        keepGoing = shouldKeepPolling(updated);
      } catch {
        delay = RETRY_MS; // the server may be restarting: try again, quietly
        keepGoing = !gateRef.current.dismissed && !gateRef.current.finished;
      }
      if (!cancelled && keepGoing) timer = setTimeout(tick, delay);
    };

    if (!gateRef.current.dismissed) void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const mode = screenMode(gate, status);

  // Once ready, leave the success message up for a moment, then hand over to the Studio.
  useEffect(() => {
    if (mode !== 'ready') return;
    const timer = setTimeout(() => setGate((g) => ({ ...g, finished: true })), READY_HOLD_MS);
    return () => clearTimeout(timer);
  }, [mode]);

  if (!mode || !status?.download) return null;

  const download = status.download;
  const rows = buildRows(download.components, language);
  const facts = hardwareFacts(download.profile, language);
  const disk = diskView(download.disk, language);
  const eta = formatEta(download.etaMs);

  const dismiss = () => {
    try {
      sessionStorage.setItem(DISMISS_STORAGE_KEY, '1');
    } catch {
      /* private mode: the screen simply stays dismissed for this page */
    }
    setGate((g) => ({ ...g, dismissed: true }));
  };

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-start justify-center overflow-y-auto bg-zinc-950 p-4 text-white sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="setup-title"
      data-testid="setup-screen"
    >
      <div className="my-auto w-full max-w-2xl rounded-2xl border border-white/10 bg-zinc-900 p-6 shadow-2xl">
        <div className="flex items-start gap-4" role="status" aria-live="polite">
          <HeaderIcon mode={mode} />
          <div className="min-w-0">
            <h1 id="setup-title" className="text-xl font-semibold">
              {t(`setup.title.${mode}` as TranslationKey)}
            </h1>
            <p className="mt-1 text-sm text-zinc-400">{t(`setup.subtitle.${mode}` as TranslationKey)}</p>
          </div>
        </div>

        {mode === 'downloading' && <div className="mt-4 h-1 animate-pulse rounded bg-pink-500/60" aria-hidden="true" />}

        {facts.length > 0 && (
          <section className="mt-6" data-testid="setup-hardware">
            <h2 className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
              <Cpu className="h-3.5 w-3.5" aria-hidden="true" />
              {t('setup.hardware')}
            </h2>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              {facts.map((fact) => (
                <React.Fragment key={fact.labelKey}>
                  <dt className="text-zinc-500">{t(fact.labelKey)}</dt>
                  <dd className="min-w-0 truncate text-zinc-200">{fact.valueKey ? t(fact.valueKey) : fact.value}</dd>
                </React.Fragment>
              ))}
            </dl>
          </section>
        )}

        <section className="mt-6">
          <h2 className="text-xs font-medium uppercase tracking-wide text-zinc-500">{t('setup.models')}</h2>
          <ul className="mt-2 divide-y divide-white/5 rounded-xl border border-white/5" data-testid="setup-rows">
            {rows.map((row) => (
              <li key={row.id} className="flex items-start gap-3 px-3 py-2.5" data-state={row.state}>
                <div className="mt-0.5">
                  <RowIcon state={row.state} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-zinc-100">
                    {t(row.labelKey)}
                    {row.modelName && <span className="ml-2 font-mono text-xs text-zinc-500">{row.modelName}</span>}
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-zinc-500">
                    <span className={row.state === 'failed' ? 'text-red-400' : row.state === 'done' ? 'text-emerald-400' : undefined}>
                      {t(row.stateKey)}
                    </span>
                    {row.sizeText && <span>{row.sizeText}</span>}
                    {row.progressText && <span className="tabular-nums text-zinc-300">{row.progressText}</span>}
                    {row.elapsedText && <span className="tabular-nums">{row.elapsedText}</span>}
                  </div>
                  {row.error && <div className="mt-1 break-words text-xs text-red-400">{row.error}</div>}
                </div>
              </li>
            ))}
          </ul>
        </section>

        {mode === 'downloading' && (
          <section className="mt-4 grid grid-cols-2 gap-4 text-sm" data-testid="setup-times">
            <div>
              <div className="text-xs text-zinc-500">{t('setup.elapsed')}</div>
              <div className="tabular-nums text-zinc-100">{formatDuration(download.elapsedMs)}</div>
            </div>
            <div>
              <div className="text-xs text-zinc-500">{t('setup.eta')}</div>
              <div className="tabular-nums text-zinc-100">{eta ?? <span className="text-zinc-500">{t('setup.eta.unknown')}</span>}</div>
            </div>
          </section>
        )}

        {disk.low && (
          <div className="mt-4 flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200" role="alert" data-testid="setup-disk-warning">
            <HardDrive className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
            <div>
              <div>{t('setup.disk.low')}</div>
              <div className="mt-0.5 text-xs text-amber-300/80">
                {disk.freeText && `${t('setup.disk.free')} : ${disk.freeText} · `}
                {t('setup.disk.needed')} : {disk.neededText}
              </div>
            </div>
          </div>
        )}

        {mode === 'error' && download.error && (
          <pre className="mt-4 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-black/40 p-3 text-xs text-red-300" data-testid="setup-error">
            {download.error}
          </pre>
        )}

        {mode === 'downloading' && <p className="mt-4 text-xs text-zinc-500">{t('setup.burstNote')}</p>}

        {mode !== 'ready' && (
          <div className="mt-6 border-t border-white/5 pt-4">
            <button
              type="button"
              onClick={dismiss}
              className="rounded-lg bg-white/10 px-4 py-2 text-sm text-zinc-100 transition-colors hover:bg-white/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-pink-400"
            >
              {t('setup.continue')}
            </button>
            <p className="mt-2 text-xs text-zinc-500">{t('setup.continue.hint')}</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default SetupScreen;
