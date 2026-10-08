/* ============================================================================
 * LoraCatalogModal.tsx — catalogue de LoRA : installer en un clic, ou depuis un lien Hugging Face
 *
 * Ouverte depuis LoraPanel. Tout ce qui est decide (compatibilite, verification des poids, epingle du commit et du
 * sha256) l'est cote serveur (/api/lora-hub) ; ici on l'affiche, dans la langue de l'utilisateur, a partir des CODES
 * que le serveur renvoie. Aucune phrase du serveur n'est montree quand un code est connu.
 *
 * Le modele charge et la VRAM viennent de readStudioContext (services/loraHub.ts), qui applique la regle deja utilisee
 * par CreatePanel : le modele n'est cru que si le moteur est connecte ET pret. Sinon la compatibilite est « inconnue »,
 * et on le dit une fois en haut plutot que sur chaque carte.
 * ==========================================================================*/

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, Download, Library, Link2, Loader2, ShieldCheck, TriangleAlert, X } from 'lucide-react';
import { useI18n } from '../context/I18nContext';
import { getModelDisplayName } from '../utils/modelNames';
import { fillTemplate } from '../utils/fillTemplate';
import {
  canUse,
  createLoraHubApi,
  errorMessage,
  formatBytes,
  modelName,
  progressPercent,
  readStudioContext,
  reasonsToShow,
  recommendedParts,
  verdictLabel,
  verdictTone,
  type CardDto,
  type CatalogEntryDto,
  type CompatibilityDto,
  type InstalledLoraDto,
  type JobDto,
  type StudioContext,
  type Tone,
} from '../services/loraHub';

type HubApi = ReturnType<typeof createLoraHubApi>;
const defaultApi = createLoraHubApi();

interface Props {
  token: string | null;
  onClose: () => void;
  /** The user wants to use an installed LoRA: the panel selects it and sets its recommended scale. */
  onUse: (installed: InstalledLoraDto) => void;
  /** Something was installed: the panel refreshes its list of LoRA. */
  onInstalled?: () => void;
  /** Injected by the tests. */
  api?: HubApi;
  readContext?: () => Promise<StudioContext>;
  pollMs?: number;
}

/** One install as the screen follows it: starting, running (job), or failed. */
interface InstallView {
  starting: boolean;
  job: JobDto | null;
  error: { code: string; message: string } | null;
}

const TONE_CLASS: Record<Tone, string> = {
  good: 'bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-400',
  warn: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400',
  bad: 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-400',
  neutral: 'bg-zinc-100 text-zinc-600 dark:bg-white/10 dark:text-zinc-400',
};

const isRunning = (view: InstallView | undefined) => !!view && (view.starting || (view.job !== null && view.job.state !== 'done' && view.job.state !== 'failed'));

const Badge: React.FC<{ tone: Tone; title?: string; testId?: string; children: React.ReactNode }> = ({ tone, title, testId, children }) => (
  <span data-testid={testId} title={title} className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap ${TONE_CLASS[tone]}`}>
    {children}
  </span>
);

export const LoraCatalogModal: React.FC<Props> = ({ token, onClose, onUse, onInstalled, api = defaultApi, readContext = readStudioContext, pollMs = 700 }) => {
  const { t } = useI18n();
  const closeRef = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);
  // The parent (LoraPanel) is rendered at every keystroke of CreatePanel and hands over new functions each time. They are read through
  // a reference, so that they do not restart the progress timer below at every render (which would never let it fire).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onInstalledRef = useRef(onInstalled);
  onInstalledRef.current = onInstalled;
  // Same for what is injected (the tests give inline functions; the application gives constants): a new identity must not reload the catalog.
  const apiRef = useRef(api);
  apiRef.current = api;
  const readContextRef = useRef(readContext);
  readContextRef.current = readContext;

  const [context, setContext] = useState<StudioContext | null>(null);
  const [catalog, setCatalog] = useState<{ entries: CatalogEntryDto[]; problems: string[] } | null>(null);
  const [catalogState, setCatalogState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [installs, setInstalls] = useState<Record<string, InstallView>>({});
  const [copied, setCopied] = useState<string | null>(null);

  // the install from a link
  const [source, setSource] = useState('');
  const [linkState, setLinkState] = useState<'idle' | 'checking' | 'ready' | 'error'>('idle');
  const [linkCard, setLinkCard] = useState<CardDto | null>(null);
  const [linkCompat, setLinkCompat] = useState<CompatibilityDto | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [chosenFile, setChosenFile] = useState<string | null>(null);
  const [linkInstalled, setLinkInstalled] = useState<InstalledLoraDto | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /* -- Fermeture : Echap, et focus sur le bouton Fermer a l'ouverture --------------------------------------------- */
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /* -- Catalogue : le contexte (modele charge, VRAM) puis la liste ------------------------------------------------- */
  const loadCatalog = useCallback(
    async (ctx: StudioContext) => {
      try {
        const result = await apiRef.current.catalog(token, ctx);
        if (!mounted.current) return;
        setCatalog(result);
        setCatalogState('ready');
      } catch {
        if (mounted.current) setCatalogState('error');
      }
    },
    [token],
  );

  const start = useCallback(async () => {
    setCatalogState('loading');
    const ctx = await readContextRef.current().catch((): StudioContext => ({}));
    if (!mounted.current) return;
    setContext(ctx);
    await loadCatalog(ctx);
  }, [loadCatalog]);

  useEffect(() => {
    void start();
  }, [start]);

  /* -- Suivi des installations : une relance par changement d'etat, jamais deux requetes en meme temps ------------ */
  useEffect(() => {
    const active = Object.entries(installs).filter(([, view]) => view.job && isRunning(view));
    if (active.length === 0) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const updates: Record<string, InstallView> = {};
      let finished = false;
      for (const [key, view] of active) {
        try {
          const { job } = await apiRef.current.job(token, (view.job as JobDto).id);
          updates[key] = { starting: false, job, error: job.state === 'failed' && job.error ? job.error : null };
          if (job.state === 'done') finished = true;
        } catch (error) {
          const e = error as { code?: string; message?: string };
          updates[key] = { starting: false, job: view.job, error: { code: e.code ?? 'unknown', message: e.message ?? '' } };
        }
      }
      if (cancelled || !mounted.current) return;
      setInstalls((current) => ({ ...current, ...updates }));
      if (finished) {
        onInstalledRef.current?.();
        if (updates.link?.job?.state === 'done' && updates.link.job.result) {
          const name = updates.link.job.result.name;
          apiRef.current.installed(token).then(({ installed }) => mounted.current && setLinkInstalled(installed.find((i) => i.name === name) ?? null)).catch(() => undefined);
        }
        if (context) void loadCatalog(context);
      }
    }, pollMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [installs, token, pollMs, context, loadCatalog]);

  /* -- Actions ---------------------------------------------------------------------------------------------------- */
  const begin = async (key: string, run: () => Promise<{ job: JobDto }>) => {
    setInstalls((current) => ({ ...current, [key]: { starting: true, job: null, error: null } }));
    try {
      const { job } = await run();
      if (mounted.current) setInstalls((current) => ({ ...current, [key]: { starting: false, job, error: null } }));
    } catch (error) {
      const e = error as { code?: string; message?: string };
      if (mounted.current) setInstalls((current) => ({ ...current, [key]: { starting: false, job: null, error: { code: e.code ?? 'unknown', message: e.message ?? '' } } }));
    }
  };

  const installEntry = (entry: CatalogEntryDto) => begin(`entry:${entry.id}`, () => apiRef.current.installFromCatalog(token, entry.id));

  const inspectLink = async (file?: string) => {
    if (!source.trim()) return;
    setLinkState('checking');
    setLinkError(null);
    setLinkInstalled(null);
    setInstalls((current) => ({ ...current, link: { starting: false, job: null, error: null } }));
    try {
      const { card, compatibility } = await apiRef.current.inspect(token, source.trim(), context ?? {}, file);
      if (!mounted.current) return;
      setLinkCard(card);
      setLinkCompat(compatibility);
      setChosenFile(card.selected?.name ?? file ?? null);
      setLinkState('ready');
    } catch (error) {
      if (!mounted.current) return;
      setLinkCard(null);
      setLinkCompat(null);
      setLinkError(errorMessage(error as { code?: string; message?: string }, t));
      setLinkState('error');
    }
  };

  const installLink = () => begin('link', () => apiRef.current.install(token, source.trim(), chosenFile ?? undefined));

  const copy = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      setTimeout(() => mounted.current && setCopied((current) => (current === id ? null : current)), 1500);
    } catch {
      /* no clipboard (insecure context): the word is on screen and can be selected */
    }
  };

  const use = (installed: InstalledLoraDto) => {
    onUse(installed);
    onClose();
  };

  /* -- Morceaux de rendu ------------------------------------------------------------------------------------------ */
  const triggerRow = (word: string, id: string) => (
    <div className="flex flex-wrap items-center gap-2 text-[11px]">
      <span className="text-zinc-500">{t('loraHubTrigger')}</span>
      <code data-testid={`hub-trigger-${id}`} className="rounded bg-zinc-100 dark:bg-white/10 px-1.5 py-0.5 font-mono text-zinc-800 dark:text-zinc-200 select-all">{word}</code>
      <button
        type="button"
        onClick={() => void copy(word, id)}
        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-zinc-500 hover:text-zinc-800 dark:hover:text-white hover:bg-zinc-100 dark:hover:bg-white/10 transition-colors"
      >
        {copied === id ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
        {copied === id ? t('loraHubCopied') : t('loraHubCopy')}
      </button>
    </div>
  );

  /** The reasons worth a line on a card: "the loaded model is not known" is said once, at the top, not on every card. */
  const cardReasons = (compat: CompatibilityDto) => reasonsToShow({ ...compat, reasons: compat.reasons.filter((r) => r.code !== 'active_model_unknown') }, t);

  const compatBlock = (compat: CompatibilityDto, id: string) => {
    const reasons = cardReasons(compat);
    return (
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={verdictTone(compat.verdict)} testId={`hub-verdict-${id}`}>
            {verdictLabel(compat.verdict, t)}
          </Badge>
          {compat.required && modelName(compat.required) && <span className="text-[11px] text-zinc-500">{fillTemplate(t('loraHubNeeds'), { model: modelName(compat.required) })}</span>}
        </div>
        {reasons.length > 0 && (
          <ul className="space-y-0.5">
            {reasons.map((reason, index) => (
              <li
                key={index}
                data-severity={reason.severity}
                className={`text-[11px] leading-snug ${reason.severity === 'blocking' ? 'text-red-600 dark:text-red-400' : reason.severity === 'warning' ? 'text-amber-700 dark:text-amber-500' : 'text-zinc-500 dark:text-zinc-400'}`}
              >
                {reason.text}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  };

  const progressBlock = (job: JobDto) => {
    const percent = progressPercent(job);
    const label = job.state === 'downloading' ? t('loraHubDownloading') : job.state === 'verifying' ? t('loraHubVerifying') : t('loraHubInstalling');
    return (
      <div className="space-y-1" data-testid="hub-progress">
        <div className="flex items-center justify-between text-[11px] text-zinc-500">
          <span className="inline-flex items-center gap-1">
            <Loader2 size={12} className="animate-spin" />
            {label}
          </span>
          {job.bytesTotal ? <span className="tabular-nums">{fillTemplate(t('loraHubProgress'), { done: formatBytes(job.bytesDone), total: formatBytes(job.bytesTotal) })}</span> : null}
        </div>
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent ?? undefined}
          className="h-1.5 rounded-full bg-zinc-200 dark:bg-white/10 overflow-hidden"
        >
          <div className="h-full rounded-full bg-pink-500 transition-all duration-300" style={{ width: `${percent ?? 4}%` }} />
        </div>
      </div>
    );
  };

  const entryCard = (entry: CatalogEntryDto) => {
    const view = installs[`entry:${entry.id}`];
    const running = isRunning(view);
    const justInstalled = view?.job?.state === 'done';
    const installed = entry.installed;
    const usable = canUse(entry);
    const recommended = recommendedParts(entry.recommended, t);
    return (
      <div key={entry.id} data-testid={`hub-entry-${entry.id}`} className="rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-black/20 p-3 space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-0.5">
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-white break-words">{entry.name}</h3>
            <p className="text-[11px] text-zinc-500 break-words">
              {[entry.author ? fillTemplate(t('loraHubBy'), { author: entry.author }) : '', formatBytes(entry.sizeBytes), entry.genre ?? ''].filter(Boolean).join(' · ')}
            </p>
          </div>
          <div className="shrink-0 flex flex-col items-end gap-1.5">
            {installed || justInstalled ? (
              <>
                <Badge tone="good" testId={`hub-installed-${entry.id}`}>
                  <Check size={11} />
                  {t('loraHubInstalled')}
                </Badge>
                <button
                  type="button"
                  data-testid={`hub-use-${entry.id}`}
                  onClick={() => installed && use(installed)}
                  disabled={!usable || !installed}
                  title={!usable && installed ? reasonsToShow(entry.compatibility, t)[0]?.text : undefined}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-pink-500 text-white hover:bg-pink-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {t('loraHubUse')}
                </button>
              </>
            ) : (
              <button
                type="button"
                data-testid={`hub-install-${entry.id}`}
                onClick={() => void installEntry(entry)}
                disabled={running}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-pink-500 text-white hover:bg-pink-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {running ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                {view?.error ? t('loraHubRetry') : t('loraHubInstall')}
              </button>
            )}
          </div>
        </div>

        {entry.description && <p className="text-xs text-zinc-600 dark:text-zinc-400 leading-snug line-clamp-2">{entry.description}</p>}

        {entry.tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {entry.tags.slice(0, 5).map((tag) => (
              <span key={tag} className="rounded bg-zinc-200/70 dark:bg-white/5 px-1.5 py-0.5 text-[10px] text-zinc-600 dark:text-zinc-400">
                {tag}
              </span>
            ))}
          </div>
        )}

        {compatBlock(entry.compatibility, entry.id)}

        {entry.triggerWord && triggerRow(entry.triggerWord, entry.id)}
        {recommended.length > 0 && (
          <p className="text-[11px] text-zinc-500">
            <span className="font-medium">{t('loraHubRecommended')} — </span>
            {recommended.join(' · ')}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500">
          {entry.verified ? (
            <span className="inline-flex items-center gap-1 text-green-600 dark:text-green-400" title={entry.verified.note ?? undefined}>
              <ShieldCheck size={12} />
              {fillTemplate(t('loraHubVerified'), { date: entry.verified.date })}
            </span>
          ) : (
            <span>{t('loraHubUnverified')}</span>
          )}
          <span className={entry.license ? '' : 'text-amber-600 dark:text-amber-500'}>{entry.license ? fillTemplate(t('loraHubLicense'), { license: entry.license }) : t('loraHubLicenseUnknown')}</span>
        </div>

        {running && view?.job && progressBlock(view.job)}
        {running && !view?.job && (
          <div className="flex items-center gap-1 text-[11px] text-zinc-500">
            <Loader2 size={12} className="animate-spin" />
            {t('loraHubInstalling')}
          </div>
        )}
        {view?.error && !running && (
          <div role="alert" data-testid={`hub-error-${entry.id}`} className="flex items-start gap-1.5 text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 px-2 py-1.5 rounded">
            <TriangleAlert size={13} className="mt-0.5 shrink-0" />
            <span>{errorMessage(view.error, t)}</span>
          </div>
        )}
      </div>
    );
  };

  const linkView = installs.link;
  const linkRunning = isRunning(linkView);
  const linkDone = linkView?.job?.state === 'done';

  const linkSection = (
    <section className="rounded-xl border border-zinc-200 dark:border-white/10 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <Link2 size={14} className="text-zinc-500" />
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-white">{t('loraHubLinkTitle')}</h3>
      </div>
      <p className="text-[11px] text-zinc-500 leading-snug">{t('loraHubLinkHint')}</p>
      <div className="flex gap-2">
        <input
          type="text"
          value={source}
          onChange={(e) => {
            setSource(e.target.value);
            if (linkState !== 'idle') {
              setLinkState('idle');
              setLinkCard(null);
              setLinkError(null);
            }
          }}
          onKeyDown={(e) => e.key === 'Enter' && void inspectLink()}
          placeholder={t('loraHubLinkPlaceholder')}
          aria-label={t('loraHubLinkTitle')}
          spellCheck={false}
          className="min-w-0 flex-1 bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-3 py-2 text-xs text-zinc-900 dark:text-white font-mono focus:outline-none focus:border-pink-500"
        />
        <button
          type="button"
          onClick={() => void inspectLink()}
          disabled={!source.trim() || linkState === 'checking'}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
        >
          {linkState === 'checking' ? <Loader2 size={13} className="animate-spin" /> : null}
          {linkState === 'checking' ? t('loraHubLinkChecking') : t('loraHubLinkCheck')}
        </button>
      </div>

      {linkError && (
        <div role="alert" data-testid="hub-link-error" className="flex items-start gap-1.5 text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 px-2 py-1.5 rounded">
          <TriangleAlert size={13} className="mt-0.5 shrink-0" />
          <span>{linkError}</span>
        </div>
      )}

      {linkCard && linkState === 'ready' && (
        <div data-testid="hub-link-card" className="rounded-lg bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 p-3 space-y-2">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h4 className="text-sm font-semibold text-zinc-900 dark:text-white break-words">{linkCard.sidecar?.name ?? linkCard.repo}</h4>
              <p className="text-[11px] text-zinc-500 break-words">
                {[linkCard.repo, formatBytes(linkCard.selected?.size), linkCard.adapter?.rank != null ? fillTemplate(t('loraHubAdapter'), { rank: linkCard.adapter.rank }) : ''].filter(Boolean).join(' · ')}
              </p>
            </div>
            <div className="shrink-0 flex flex-col items-end gap-1.5">
              {linkDone ? (
                <>
                  <Badge tone="good">
                    <Check size={11} />
                    {t('loraHubInstalled')}
                  </Badge>
                  <button
                    type="button"
                    data-testid="hub-use-link"
                    onClick={() => linkInstalled && use(linkInstalled)}
                    disabled={!linkInstalled || linkCompat?.verdict === 'incompatible'}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-pink-500 text-white hover:bg-pink-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {t('loraHubUse')}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  data-testid="hub-install-link"
                  onClick={() => void installLink()}
                  disabled={linkRunning || linkCard.needsChoice}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-pink-500 text-white hover:bg-pink-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {linkRunning ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                  {linkView?.error ? t('loraHubRetry') : t('loraHubInstall')}
                </button>
              )}
            </div>
          </div>

          {linkCard.needsChoice && (
            <fieldset className="space-y-1">
              <legend className="text-[11px] text-zinc-600 dark:text-zinc-400 mb-1">{t('loraHubChooseFile')}</legend>
              {linkCard.weights.map((weights) => (
                <label key={weights.name} className="flex items-center gap-2 text-xs text-zinc-700 dark:text-zinc-300 cursor-pointer">
                  <input type="radio" name="hub-weights" checked={chosenFile === weights.name} onChange={() => { setChosenFile(weights.name); void inspectLink(weights.name); }} className="accent-pink-600" />
                  <span className="font-mono break-all">{weights.name}</span>
                  <span className="text-zinc-500 whitespace-nowrap">{formatBytes(weights.size)}</span>
                </label>
              ))}
            </fieldset>
          )}

          {linkCompat && !linkCard.needsChoice && compatBlock(linkCompat, 'link')}
          {linkCard.sidecar?.triggerWord && triggerRow(linkCard.sidecar.triggerWord, 'link')}
          <div className="text-[11px] text-zinc-500">{linkCard.license ? fillTemplate(t('loraHubLicense'), { license: linkCard.license }) : t('loraHubLicenseUnknown')}</div>

          {linkCard.warnings.length > 0 && (
            <div className="text-[11px] text-amber-700 dark:text-amber-500 space-y-0.5">
              <div className="font-medium">{t('loraHubNotes')}</div>
              {linkCard.warnings.map((warning, index) => (
                <div key={index}>{warning}</div>
              ))}
            </div>
          )}

          {linkRunning && linkView?.job && progressBlock(linkView.job)}
          {linkView?.error && !linkRunning && (
            <div role="alert" data-testid="hub-link-install-error" className="flex items-start gap-1.5 text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 px-2 py-1.5 rounded">
              <TriangleAlert size={13} className="mt-0.5 shrink-0" />
              <span>{errorMessage(linkView.error, t)}</span>
            </div>
          )}
        </div>
      )}
    </section>
  );

  /* -- Rendu ------------------------------------------------------------------------------------------------------ */
  const loadedModel = context?.activeModel ? getModelDisplayName(context.activeModel) : null;

  // In document.body, not where the panel is: the create page's left column is its own stacking context, so a z-50 inside it stays under the handle
  // that resizes the two columns (z-20 in the root context), which then crossed the window. A portal takes it out of every stacking context.
  return createPortal(
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="lora-hub-title"
        data-testid="lora-catalog"
        className="bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl border border-zinc-200 dark:border-white/10 w-full max-w-2xl max-h-[88vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-100 dark:border-white/5 shrink-0">
          <div className="flex items-center gap-2">
            <Library size={18} className="text-pink-500" />
            <h2 id="lora-hub-title" className="text-sm font-semibold text-zinc-900 dark:text-white">
              {t('loraHubTitle')}
            </h2>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label={t('loraHubClose')}
            className="p-1.5 text-zinc-400 hover:text-zinc-700 dark:hover:text-white rounded-lg hover:bg-zinc-100 dark:hover:bg-white/5 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        <div className="overflow-y-auto p-5 space-y-4">
          {context && (
            <p data-testid="hub-context" className="text-[11px] text-zinc-500 leading-snug">
              {loadedModel
                ? [fillTemplate(t('loraHubContextModel'), { model: loadedModel }), context.vramGb ? fillTemplate(t('loraHubContextVram'), { gb: context.vramGb }) : ''].filter(Boolean).join(' · ')
                : t('loraHubContextUnknown')}
            </p>
          )}

          {catalogState === 'loading' && (
            <div className="flex items-center gap-2 text-xs text-zinc-500">
              <Loader2 size={14} className="animate-spin" />
              {t('loraHubLoading')}
            </div>
          )}
          {catalogState === 'error' && (
            <div role="alert" className="flex items-center justify-between gap-3 text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 px-3 py-2 rounded-lg">
              <span>{t('loraHubLoadFailed')}</span>
              <button type="button" onClick={() => void start()} className="font-semibold underline whitespace-nowrap">
                {t('loraHubRetry')}
              </button>
            </div>
          )}
          {catalogState === 'ready' && catalog && (
            <>
              {catalog.entries.length === 0 && <p className="text-xs text-zinc-500">{t('loraHubEmpty')}</p>}
              <div className="space-y-3">{catalog.entries.map(entryCard)}</div>
              {catalog.problems.length > 0 && <p className="text-[11px] text-amber-600 dark:text-amber-500">{fillTemplate(t('loraHubIgnored'), { count: catalog.problems.length })}</p>}
            </>
          )}

          {linkSection}
        </div>
      </div>
    </div>,
    document.body,
  );
};
