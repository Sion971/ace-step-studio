// services/setup-view.ts
//
// The pure logic behind the first-launch screen (components/SetupScreen.tsx): when to show it, and how to turn what the
// server reports (/api/pipeline/status, built by the server's download-tracker.ts) into rows and figures.
//
// Why the screen shows components and elapsed time, not a smooth byte bar (measured on huggingface_hub 0.36.2 + hf_xet,
// a 337 MB file): the partial file on disk stays at 0 bytes until the download ends, and the byte counts arrive in bursts
// (nothing for 17 s, then 64 MiB, then the rest at once). The counters are shown as they come; the screen says they move
// in jumps. The remaining time is an estimate and is always labelled as one.

import type { Language } from '../i18n/translations';

// ----------------------------------------------------------------------------------------- server data --
export type ComponentState = 'pending' | 'downloading' | 'done' | 'failed';
export type ComponentKind = 'main' | 'dit' | 'lm' | 'other';
export type Phase = 'downloading' | 'loading' | 'ready' | 'error';

export interface ComponentDto {
  id: string;
  kind: ComponentKind;
  state: ComponentState;
  expectedBytes?: number;
  approx?: boolean;
  bytesDone?: number;
  bytesTotal?: number;
  elapsedMs?: number;
  seconds?: number;
  error?: string;
}

export interface HardwareProfileDto {
  gpuName?: string;
  vramGiB?: number;
  tier?: number;
  mode?: 'gpu' | 'cpu';
}

export interface DownloadDto {
  phase: Phase;
  components: ComponentDto[];
  elapsedMs: number;
  etaMs?: number;
  disk: { freeBytes?: number; neededBytes: number; low: boolean };
  profile?: HardwareProfileDto;
  error?: string;
}

export interface PipelineStatusDto {
  state: string;
  message?: string;
  download?: DownloadDto;
}

// ----------------------------------------------------------------------------------------- visibility --
export type ScreenMode = 'downloading' | 'loading' | 'error' | 'ready';

export interface ScreenGate {
  /** A download was seen in this session: the screen stays until the engine is ready. */
  latched: boolean;
  /** The user chose "continue without waiting" (kept for the browser session). */
  dismissed: boolean;
  /** The "ready" message has been shown long enough. */
  finished: boolean;
}

export const INITIAL_GATE: ScreenGate = { latched: false, dismissed: false, finished: false };

/** States in which the Studio itself is running the engine. Anything else (stopped = not managed, or not started yet) never
 * shows the screen: someone who runs the engine themselves has no use for it. */
const ENGINE_RUNNING = new Set(['starting', 'loading_model', 'restarting', 'error']);

/**
 * Starts showing the screen when the engine, started by the Studio, is downloading — or when it failed while models are
 * still missing (a crash before or during the first download: without this the user would see nothing but a light).
 * An ordinary restart (models already on disk) never latches: the sidebar light is enough there, and so is a crash of an
 * engine whose models are all present.
 */
export function nextGate(gate: ScreenGate, status: PipelineStatusDto | null): ScreenGate {
  if (gate.latched || !status?.download || !ENGINE_RUNNING.has(status.state)) return gate;
  const { phase, components } = status.download;
  const downloading = phase === 'downloading';
  const failedWhileMissing = phase === 'error' && components.some((c) => c.state !== 'done');
  return downloading || failedWhileMissing ? { ...gate, latched: true } : gate;
}

/**
 * Keep asking the server only while the screen is, or is about to be, useful. Before it latched, the first answer decides:
 * models already on disk, or an engine the Studio does not run, means there is nothing to show and nothing coming.
 */
export function shouldKeepPolling(gate: ScreenGate): boolean {
  return gate.latched && !gate.dismissed && !gate.finished;
}

/** The mode to display, or null when the screen must stay hidden. */
export function screenMode(gate: ScreenGate, status: PipelineStatusDto | null): ScreenMode | null {
  if (gate.dismissed || gate.finished || !gate.latched || !status?.download) return null;
  const { phase } = status.download;
  if (phase === 'ready' || status.state === 'ready') return 'ready';
  return phase;
}

// ------------------------------------------------------------------------------------------ formatting --
const LOCALES: Record<Language, string> = { en: 'en', fr: 'fr', ja: 'ja', ko: 'ko', ru: 'ru', zh: 'zh' };
const BYTE_UNITS: Record<Language, [string, string, string]> = {
  en: ['GB', 'MB', 'KB'],
  fr: ['Go', 'Mo', 'Ko'],
  ja: ['GB', 'MB', 'KB'],
  ko: ['GB', 'MB', 'KB'],
  ru: ['ГБ', 'МБ', 'КБ'],
  zh: ['GB', 'MB', 'KB'],
};
const GIB_UNIT: Record<Language, string> = { en: 'GiB', fr: 'Gio', ja: 'GiB', ko: 'GiB', ru: 'ГиБ', zh: 'GiB' };

function number(value: number, language: Language, digits: number): string {
  return value.toLocaleString(LOCALES[language], { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Decimal units, as Hugging Face and the download script display them. */
export function formatBytes(bytes: number, language: Language): string {
  const [gb, mb, kb] = BYTE_UNITS[language];
  if (!Number.isFinite(bytes) || bytes < 0) return `0 ${kb}`;
  if (bytes >= 1e9) return `${number(bytes / 1e9, language, 2)} ${gb}`;
  if (bytes >= 1e6) return `${number(bytes / 1e6, language, bytes >= 1e8 ? 0 : 1)} ${mb}`;
  return `${number(bytes / 1e3, language, 0)} ${kb}`;
}

/** `m:ss`, or `h:mm:ss` from one hour. */
export function formatDuration(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** The remaining time is always an estimate: it is displayed with a leading "≈". */
export function formatEta(etaMs: number | undefined): string | undefined {
  return etaMs === undefined || !Number.isFinite(etaMs) ? undefined : `≈ ${formatDuration(etaMs)}`;
}

// ---------------------------------------------------------------------------------------------- rows --
export type ComponentLabelKey = 'setup.component.main' | 'setup.component.dit' | 'setup.component.lm' | 'setup.component.other';
export type StateLabelKey = 'setup.state.pending' | 'setup.state.downloading' | 'setup.state.done' | 'setup.state.failed';

export interface RowView {
  id: string;
  labelKey: ComponentLabelKey;
  /** The model folder name, shown after the label (not for the base files). */
  modelName?: string;
  state: ComponentState;
  stateKey: StateLabelKey;
  sizeText?: string;
  /** Bytes reported by Hugging Face so far, exactly as received ("1.2 GB / 4.79 GB"). */
  progressText?: string;
  elapsedText?: string;
  error?: string;
}

const LABEL_KEYS: Record<ComponentKind, ComponentLabelKey> = {
  main: 'setup.component.main',
  dit: 'setup.component.dit',
  lm: 'setup.component.lm',
  other: 'setup.component.other',
};
const STATE_KEYS: Record<ComponentState, StateLabelKey> = {
  pending: 'setup.state.pending',
  downloading: 'setup.state.downloading',
  done: 'setup.state.done',
  failed: 'setup.state.failed',
};

export function buildRows(components: ComponentDto[], language: Language): RowView[] {
  return components.map((c) => {
    const row: RowView = {
      id: c.id,
      labelKey: LABEL_KEYS[c.kind] ?? LABEL_KEYS.other,
      modelName: c.kind === 'main' ? undefined : c.id,
      state: c.state,
      stateKey: STATE_KEYS[c.state],
    };
    if (c.expectedBytes) row.sizeText = `${c.approx ? '≈ ' : ''}${formatBytes(c.expectedBytes, language)}`;
    if (c.state === 'downloading') {
      if (c.bytesTotal && c.bytesTotal > 0) row.progressText = `${formatBytes(c.bytesDone ?? 0, language)} / ${formatBytes(c.bytesTotal, language)}`;
      if (c.elapsedMs !== undefined) row.elapsedText = formatDuration(c.elapsedMs);
    } else if (c.state === 'done' && c.seconds !== undefined) {
      row.elapsedText = formatDuration(c.seconds * 1000);
    }
    if (c.state === 'failed') row.error = c.error;
    return row;
  });
}

// ---------------------------------------------------------------------------------- hardware and disk --
export type HardwareLabelKey = 'setup.hw.gpu' | 'setup.hw.memory' | 'setup.hw.mode';

export interface HardwareFact {
  labelKey: HardwareLabelKey;
  /** Either a literal value (card name, memory) or the key of a translated value. */
  value?: string;
  valueKey?: 'setup.mode.gpu' | 'setup.mode.cpu';
}

export function hardwareFacts(profile: HardwareProfileDto | undefined, language: Language): HardwareFact[] {
  if (!profile) return [];
  const facts: HardwareFact[] = [];
  if (profile.gpuName) facts.push({ labelKey: 'setup.hw.gpu', value: profile.gpuName });
  if (profile.vramGiB && profile.vramGiB > 0) facts.push({ labelKey: 'setup.hw.memory', value: `${number(profile.vramGiB, language, 2)} ${GIB_UNIT[language]}` });
  if (profile.mode) facts.push({ labelKey: 'setup.hw.mode', valueKey: profile.mode === 'cpu' ? 'setup.mode.cpu' : 'setup.mode.gpu' });
  return facts;
}

export interface DiskView {
  low: boolean;
  freeText?: string;
  neededText: string;
}

export function diskView(disk: DownloadDto['disk'], language: Language): DiskView {
  return {
    low: disk.low,
    freeText: disk.freeBytes === undefined ? undefined : formatBytes(disk.freeBytes, language),
    neededText: `≈ ${formatBytes(disk.neededBytes, language)}`,
  };
}

/** Every translation key the screen uses (checked against the six language files by the tests). */
export const SETUP_KEYS = [
  'setup.title.downloading', 'setup.subtitle.downloading', 'setup.title.loading', 'setup.subtitle.loading',
  'setup.title.ready', 'setup.subtitle.ready', 'setup.title.error', 'setup.subtitle.error',
  'setup.hardware', 'setup.hw.gpu', 'setup.hw.memory', 'setup.hw.mode', 'setup.mode.gpu', 'setup.mode.cpu',
  'setup.models', 'setup.component.main', 'setup.component.dit', 'setup.component.lm', 'setup.component.other',
  'setup.state.pending', 'setup.state.downloading', 'setup.state.done', 'setup.state.failed',
  'setup.elapsed', 'setup.eta', 'setup.eta.unknown', 'setup.burstNote',
  'setup.disk.low', 'setup.disk.free', 'setup.disk.needed', 'setup.continue', 'setup.continue.hint',
] as const;
