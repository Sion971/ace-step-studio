// services/lora-hub.ts
//
// Installs a LoRA published on Hugging Face into ACE-Step-1.5/lora_output/<name>/, in the layout that GET /api/lora/available already lists
// (adapter_config.json + adapter_model.safetensors). Once installed, it shows up in the LoRA menu by itself.
//
// What published ACE-Step LoRAs look like, which is why this does not simply "download a repository":
//  - the weights file has several names (adapter_model.safetensors, deep_house-v1.safetensors, vocal_instrument_merge_adapter_model.safetensors...)
//    and many model cards tell the user to rename it by hand; a repository can hold several of them;
//  - each LoRA is tied to a base model (Turbo 2B, base 2B, XL) and a wrong pairing gives noise, or does not fit in 8 GB;
//  - the license, the trigger word and the recommended scale live in free text.
//
// Rules, whatever the source (a catalog entry or a link pasted by the user):
//  - only files that the Hub's own file list reports are ever downloaded: a name typed by the user is checked against that list, never used as a path;
//  - only .safetensors weights (a format that cannot run code) and adapter_config.json are installed; .bin / .pt / .ckpt are refused;
//  - the files are fetched at the commit the API reported, so that what was listed is what is received;
//  - the install is atomic: a hidden temporary folder, size and sha256 checked, then ONE rename. Nothing half-installed ever shows up in the menu;
//  - the weights are never guessed: with several candidates, the caller must choose;
//  - the Hub's `cardData` is free text written by the author: only short plain strings are kept from it, as provenance.
//
// Network access is injectable (fetch, endpoint), so the whole flow is tested against a fake Hub. HF_ENDPOINT and HF_TOKEN are honored like
// huggingface_hub does; the token is only ever sent to the Hub's own origin.

import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { modelLabel, normalizeSha, plain, plainList } from './lora-text.js';
import { parseSidecar, pickSidecar, type SidecarInfo } from './lora-sidecar.js';

export const DEFAULT_ENDPOINT = 'https://huggingface.co';
const DEFAULT_MAX_WEIGHTS_BYTES = 4 * 1024 ** 3;
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_SIDECAR_BYTES = 256 * 1024;
const MAX_API_BYTES = 8 * 1024 * 1024;
const API_TIMEOUT_MS = 20_000;
const DEFAULT_STALL_MS = 60_000;
const JOB_TTL_MS = 10 * 60_000;
const MAX_ACTIVE_JOBS = 2;
const RESERVED_NAMES = new Set(['checkpoints', 'runs']); // the folders GET /api/lora/available skips
const NOT_A_USER = new Set(['datasets', 'spaces', 'models', 'docs', 'api', 'blog', 'papers', 'collections', 'organizations']);
const UNSAFE_FORMATS = /\.(bin|pt|pth|ckpt|pkl|pickle)$/i;

export class LoraHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'LoraHubError';
  }
}

export interface RepoRef {
  repo: string; // "owner/name"
  revision?: string;
}

export interface HubFile {
  name: string;
  size: number | null;
  sha256: string | null;
}

export interface AdapterInfo {
  peftType: string | null;
  rank: number | null;
  alpha: number | null;
  targetModules: string[];
  baseModel: string | null;
}

export interface LoraCard {
  repo: string;
  /** The commit the files are read at. */
  revision: string;
  license: string | null;
  baseModel: string[];
  tags: string[];
  gated: boolean;
  weights: HubFile[];
  selected: HubFile | null;
  /** True when several weights files exist and none was chosen: the caller must pick one. */
  needsChoice: boolean;
  /** Null while a choice is pending (the config depends on the folder of the chosen weights). */
  adapter: AdapterInfo | null;
  /** What the author published in <weights>.metadata.json (trigger word, recommended settings, required base model...), or null. */
  sidecar: SidecarInfo | null;
  suggestedName: string;
  /** Folder name if a LoRA with the suggested name is already installed. */
  alreadyInstalled: string | null;
  warnings: string[];
}

export type JobState = 'downloading' | 'verifying' | 'installing' | 'done' | 'failed';

export interface InstallJob {
  id: string;
  repo: string;
  name: string;
  state: JobState;
  bytesDone: number;
  bytesTotal: number | null;
  startedAt: number;
  finishedAt?: number;
  error?: { message: string; code: string };
  result?: { name: string; path: string };
}

export interface LoraHubOptions {
  loraDir: string;
  endpoint?: string;
  token?: string;
  fetchImpl?: typeof fetch;
  maxWeightsBytes?: number;
  stallMs?: number;
  now?: () => number;
  randomId?: () => string;
}

// ------------------------------------------------------------------------------------------------------------------ parsing --
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

const invalidSource = () => new LoraHubError('Enter a Hugging Face link or a "user/repository" name.', 400, 'invalid_source');

/** Accepts "owner/name" and the usual page links (…/tree/<rev>, …/blob/<rev>/…, …/resolve/<rev>/…) of the Hub. */
export function parseRepoRef(input: unknown, endpoint: string = DEFAULT_ENDPOINT): RepoRef {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw || raw.length > 300 || /[\u0000-\u001f\\]/.test(raw)) throw invalidSource();

  let segments: string[];
  if (/^https?:\/\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw invalidSource();
    }
    const allowed = new Set([new URL(endpoint).host, 'huggingface.co', 'www.huggingface.co']);
    if (!allowed.has(url.host)) throw new LoraHubError('Only Hugging Face links are accepted.', 400, 'invalid_source');
    try {
      segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    } catch {
      throw invalidSource();
    }
  } else {
    if (raw.startsWith('/') || /[?#:@]/.test(raw)) throw invalidSource(); // a leading "/" looks like a file path, not a link
    segments = raw.split('/').filter(Boolean);
    if (segments.length !== 2) throw invalidSource();
  }

  const [owner, name, kind, revision] = segments;
  if (!owner || !name || NOT_A_USER.has(owner.toLowerCase()) || !SEGMENT.test(owner) || !SEGMENT.test(name)) throw invalidSource();
  const ref: RepoRef = { repo: `${owner}/${name}` };
  if (kind !== undefined) {
    if (!['tree', 'blob', 'resolve'].includes(kind) || (revision !== undefined && !REVISION.test(revision))) throw invalidSource();
    if (revision) ref.revision = revision;
  }
  return ref;
}

/** A folder name that cannot escape lora_output/ and that GET /api/lora/available will list. */
export function sanitizeName(raw: unknown): string {
  const cleaned = String(raw ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // "é" is "e" + a combining accent: drop the accent, do not turn it into a separator
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.\-_]+/, '')
    .slice(0, 64)
    .replace(/[.\-_]+$/, '');
  if (!cleaned) throw new LoraHubError('The name must contain letters or digits.', 400, 'invalid_name');
  if (RESERVED_NAMES.has(cleaned.toLowerCase())) throw new LoraHubError(`"${cleaned}" is a reserved folder name. Choose another name.`, 400, 'reserved_name');
  return cleaned;
}

const safeRepoPath = (name: string) => name.length > 0 && !name.startsWith('/') && !name.includes('..') && !/[\u0000-\u001f\\]/.test(name);
const encodePath = (name: string) => name.split('/').map(encodeURIComponent).join('/');

// ---------------------------------------------------------------------------------------------------------------------- hub --
interface Resolved {
  card: LoraCard;
  commit: string;
  weightsUrl: string | null;
  configText: string | null;
}

export class LoraHub {
  private readonly loraDir: string;
  private readonly endpoint: string;
  private readonly origin: string;
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxWeightsBytes: number;
  private readonly stallMs: number;
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly jobs = new Map<string, InstallJob>();

  constructor(options: LoraHubOptions) {
    this.loraDir = options.loraDir;
    this.endpoint = (options.endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, '');
    this.origin = new URL(this.endpoint).origin;
    this.token = options.token || undefined;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxWeightsBytes = options.maxWeightsBytes ?? DEFAULT_MAX_WEIGHTS_BYTES;
    this.stallMs = options.stallMs ?? DEFAULT_STALL_MS;
    this.now = options.now ?? Date.now;
    this.randomId = options.randomId ?? (() => randomBytes(6).toString('hex'));
  }

  // ---------------------------------------------------------------------------------------------------------- inspect --
  async inspect(source: unknown, options: { file?: string } = {}): Promise<LoraCard> {
    return (await this.resolve(source, options)).card;
  }

  private async resolve(source: unknown, options: { file?: string }): Promise<Resolved> {
    const ref = parseRepoRef(source, this.endpoint);
    let url = `${this.endpoint}/api/models/${ref.repo}?blobs=true`;
    if (ref.revision) url += `&revision=${encodeURIComponent(ref.revision)}`;
    const info = (await this.getJson(url, MAX_API_BYTES)) as Record<string, any>;
    if (!info || typeof info !== 'object' || !Array.isArray(info.siblings)) {
      throw new LoraHubError('Hugging Face answered with something unexpected for this repository.', 502, 'unexpected_response');
    }

    const commit = typeof info.sha === 'string' && /^[0-9a-f]{7,64}$/i.test(info.sha) ? info.sha : ref.revision ?? 'main';
    const files: HubFile[] = [];
    for (const s of info.siblings) {
      if (!s || typeof s.rfilename !== 'string' || !safeRepoPath(s.rfilename)) continue;
      const size = Number(s.lfs?.size ?? s.size);
      files.push({ name: s.rfilename, size: Number.isFinite(size) && size >= 0 ? size : null, sha256: normalizeSha(s.lfs?.sha256 ?? s.lfs?.oid) });
    }

    const weights = files.filter((f) => /\.safetensors$/i.test(f.name));
    if (weights.length === 0) {
      const unsafe = files.some((f) => UNSAFE_FORMATS.test(f.name));
      throw new LoraHubError(
        unsafe
          ? 'This repository only has .bin / .pt / .ckpt weights. Only .safetensors is installed, because those other formats can run code when loaded.'
          : 'This repository has no .safetensors weights file.',
        422,
        unsafe ? 'unsupported_format' : 'no_weights',
      );
    }

    // Never guess: an explicit choice must be one of the listed files; otherwise exactly one candidate, or the standard name, or a question.
    let selected: HubFile | null = null;
    if (options.file !== undefined) {
      selected = weights.find((w) => w.name === options.file) ?? null;
      if (!selected) throw new LoraHubError('That file is not one of the .safetensors files of this repository.', 400, 'unknown_file', { files: weights.map((w) => w.name) });
    } else if (weights.length === 1) {
      selected = weights[0];
    } else {
      const standard = weights.filter((w) => path.posix.basename(w.name) === 'adapter_model.safetensors');
      if (standard.length === 1) selected = standard[0];
    }

    const warnings: string[] = [];
    let adapter: AdapterInfo | null = null;
    let sidecar: SidecarInfo | null = null;
    let configText: string | null = null;
    let weightsUrl: string | null = null;

    if (selected) {
      const dir = path.posix.dirname(selected.name);
      const configName = [dir === '.' ? 'adapter_config.json' : `${dir}/adapter_config.json`, 'adapter_config.json'].find((n) => files.some((f) => f.name === n));
      if (!configName) {
        throw new LoraHubError('This repository has no adapter_config.json, so it is not a PEFT LoRA that the Studio can load.', 422, 'no_adapter_config');
      }
      weightsUrl = this.resolveUrl(ref.repo, commit, selected.name);
      configText = await this.getText(this.resolveUrl(ref.repo, commit, configName), MAX_CONFIG_BYTES);
      adapter = this.parseAdapterConfig(configText, warnings);
      if (selected.size === null) warnings.push('The size of the weights file is not published.');
      if (selected.sha256 === null) warnings.push('No checksum is published for the weights file: its size is checked, its content cannot be.');
      if (selected.size !== null && selected.size > this.maxWeightsBytes) {
        throw new LoraHubError(`The weights file is ${(selected.size / 1024 ** 3).toFixed(1)} GB, above the ${(this.maxWeightsBytes / 1024 ** 3).toFixed(0)} GB limit.`, 413, 'too_large');
      }
      sidecar = await this.readSidecar(ref.repo, commit, files, selected, warnings);
    }

    const card = info.cardData && typeof info.cardData === 'object' ? info.cardData : {};
    // What the author left out of the repository's own metadata is looked for elsewhere, in this order: the license: tag, then the metadata file.
    const tags = plainList(info.tags, 60, 60).filter((t) => !/^region:/i.test(t)).slice(0, 30);
    const licenseTag = tags.find((t) => /^license:/i.test(t));
    const license = plain(card.license, 64) ?? (licenseTag ? plain(licenseTag.slice('license:'.length), 64) : null) ?? sidecar?.license ?? null;
    const declaredBase = plainList(card.base_model, 5, 120);
    const baseModel = declaredBase.length > 0 ? declaredBase : [sidecar?.baseModelRequired ?? sidecar?.baseModel].filter((b): b is string => Boolean(b));
    const suggestedName = sanitizeName(ref.repo.split('/')[1]);
    return {
      commit,
      weightsUrl,
      configText,
      card: {
        repo: ref.repo,
        revision: commit,
        license,
        baseModel,
        tags,
        gated: Boolean(info.gated),
        weights,
        selected,
        needsChoice: selected === null,
        adapter,
        sidecar,
        suggestedName,
        alreadyInstalled: existsSync(path.join(this.loraDir, suggestedName)) ? suggestedName : null,
        warnings,
      },
    };
  }

  /** The <weights>.metadata.json some authors publish. Best effort: whatever goes wrong here becomes a warning, never a refusal. */
  private async readSidecar(repo: string, commit: string, files: HubFile[], selected: HubFile, warnings: string[]): Promise<SidecarInfo | null> {
    const pick = pickSidecar(files.map((f) => f.name), selected.name);
    if (!pick.name) {
      if (pick.ambiguous) warnings.push('Several metadata files were found and none matches the weights file: they were ignored.');
      return null;
    }
    const listedSize = files.find((f) => f.name === pick.name)?.size;
    if (typeof listedSize === 'number' && listedSize > MAX_SIDECAR_BYTES) {
      warnings.push('The metadata file is too large: it was ignored.');
      return null;
    }
    let text: string;
    try {
      text = await this.getText(this.resolveUrl(repo, commit, pick.name), MAX_SIDECAR_BYTES);
    } catch {
      warnings.push('The metadata file could not be read: it was ignored.');
      return null;
    }
    const parsed = parseSidecar(text);
    if (!parsed) {
      warnings.push('The metadata file is not a JSON object: it was ignored.');
      return null;
    }
    warnings.push(...parsed.warnings);
    // It is the author's word, and it can be stale: it is checked against what the Hub itself reports.
    if (parsed.info.sha256 && selected.sha256 && parsed.info.sha256 !== selected.sha256) {
      warnings.push("The metadata file's checksum differs from the Hub's: it may describe another version of the weights.");
    }
    if (parsed.info.weightsFile && path.posix.basename(parsed.info.weightsFile) !== path.posix.basename(selected.name)) {
      warnings.push('The metadata file describes another weights file than the one selected.');
    }
    return parsed.info;
  }

  private parseAdapterConfig(text: string, warnings: string[]): AdapterInfo {
    let config: Record<string, any>;
    try {
      config = JSON.parse(text);
    } catch {
      throw new LoraHubError('adapter_config.json is not valid JSON.', 422, 'invalid_adapter_config');
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new LoraHubError('adapter_config.json is not a JSON object.', 422, 'invalid_adapter_config');
    const peftType = typeof config.peft_type === 'string' ? config.peft_type.toUpperCase() : null;
    if (peftType && peftType !== 'LORA') {
      throw new LoraHubError(`This is a ${plain(peftType, 20)} adapter; the Studio loads LoRA adapters only.`, 422, 'unsupported_adapter');
    }
    if (!peftType) warnings.push('adapter_config.json does not say which kind of adapter this is (no peft_type).');
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    return {
      peftType,
      rank: num(config.r),
      alpha: num(config.lora_alpha),
      targetModules: plainList(config.target_modules, 12, 40),
      baseModel: modelLabel(config.base_model_name_or_path),
    };
  }

  // ---------------------------------------------------------------------------------------------------------- install --
  async startInstall(source: unknown, options: { file?: string; name?: string } = {}): Promise<InstallJob> {
    this.pruneJobs();
    if ([...this.jobs.values()].filter((j) => j.state !== 'done' && j.state !== 'failed').length >= MAX_ACTIVE_JOBS) {
      throw new LoraHubError('Two installs are already running. Wait for one to finish.', 429, 'busy');
    }
    const resolved = await this.resolve(source, { file: options.file });
    const { card } = resolved;
    if (card.needsChoice || !card.selected || !resolved.weightsUrl || resolved.configText === null) {
      throw new LoraHubError('This repository has several .safetensors files: choose one.', 409, 'choose_file', { files: card.weights.map((w) => w.name) });
    }
    const name = sanitizeName(options.name ?? card.suggestedName);
    if (existsSync(path.join(this.loraDir, name))) {
      throw new LoraHubError(`A LoRA named "${name}" is already installed. Choose another name.`, 409, 'already_installed');
    }
    if ([...this.jobs.values()].some((j) => j.name === name && j.state !== 'done' && j.state !== 'failed')) {
      throw new LoraHubError(`"${name}" is already being installed.`, 409, 'already_installing');
    }

    const job: InstallJob = { id: this.randomId(), repo: card.repo, name, state: 'downloading', bytesDone: 0, bytesTotal: card.selected.size, startedAt: this.now() };
    this.jobs.set(job.id, job);
    // run() records its own failures; this last net only makes sure that nothing can leave the job stuck, or escape as an unhandled rejection.
    void this.run(job, resolved).catch((error: unknown) => {
      job.state = 'failed';
      job.error = { message: `Install failed: ${error instanceof Error ? error.message : 'unknown error'}`, code: 'install_failed' };
      job.finishedAt = this.now();
    });
    return { ...job };
  }

  getJob(id: string): InstallJob | null {
    this.pruneJobs();
    const job = this.jobs.get(id);
    return job ? { ...job } : null;
  }

  private pruneJobs(): void {
    const limit = this.now() - JOB_TTL_MS;
    for (const [id, job] of this.jobs) if (job.finishedAt !== undefined && job.finishedAt < limit) this.jobs.delete(id);
  }

  private async run(job: InstallJob, resolved: Resolved): Promise<void> {
    const { card, commit } = resolved;
    const selected = card.selected as HubFile;
    const tmp = path.join(this.loraDir, `.hub-tmp-${job.id}`);
    const target = path.join(this.loraDir, job.name);
    try {
      mkdirSync(tmp, { recursive: true });
      const partial = path.join(tmp, 'adapter_model.safetensors.part');
      const { sha256, bytes } = await this.download(resolved.weightsUrl as string, partial, selected, (done) => {
        job.bytesDone = done;
      });

      job.state = 'verifying';
      if (selected.size !== null && bytes !== selected.size) {
        throw new LoraHubError(`The download is ${bytes} bytes, but ${selected.size} were expected.`, 502, 'size_mismatch');
      }
      if (selected.sha256 !== null && sha256 !== selected.sha256) {
        throw new LoraHubError('The downloaded file does not match the checksum published by Hugging Face. It was not installed.', 502, 'checksum_mismatch');
      }

      job.state = 'installing';
      renameSync(partial, path.join(tmp, 'adapter_model.safetensors'));
      writeFileSync(path.join(tmp, 'adapter_config.json'), resolved.configText as string);
      writeFileSync(
        path.join(tmp, 'lora_hub.json'),
        JSON.stringify(
          {
            schema: 1,
            source: 'huggingface',
            repo: card.repo,
            revision: commit,
            file: selected.name,
            sha256,
            size: bytes,
            checksumPublished: selected.sha256 !== null,
            license: card.license,
            baseModel: card.baseModel,
            tags: card.tags,
            adapter: card.adapter,
            sidecar: card.sidecar,
            installedAt: new Date(this.now()).toISOString(),
          },
          null,
          2,
        ),
      );
      if (existsSync(target)) throw new LoraHubError(`A LoRA named "${job.name}" appeared meanwhile.`, 409, 'already_installed');
      renameSync(tmp, target);
      job.result = { name: job.name, path: `./lora_output/${job.name}` };
      job.state = 'done';
    } catch (error) {
      this.discard(tmp);
      job.state = 'failed';
      job.error =
        error instanceof LoraHubError
          ? { message: error.message, code: error.code }
          : { message: `Install failed: ${error instanceof Error ? error.message : 'unknown error'}`, code: 'install_failed' };
    } finally {
      job.finishedAt = this.now();
    }
  }

  /** Removes a temporary folder. Cleaning up must never be the thing that fails: a job that cannot clean up is still a failed job. */
  private discard(folder: string): void {
    try {
      rmSync(folder, { recursive: true, force: true });
    } catch {
      /* nothing more can be done, and the folder is hidden and empty of anything that GET /api/lora/available lists */
    }
  }

  // ------------------------------------------------------------------------------------------------------------ http --
  private resolveUrl(repo: string, revision: string, file: string): string {
    return `${this.endpoint}/${repo}/resolve/${encodeURIComponent(revision)}/${encodePath(file)}`;
  }

  /** The token goes to the Hub's own origin only; a redirect to a CDN never carries it (fetch drops it across origins). */
  private headersFor(url: string): Record<string, string> {
    return this.token && new URL(url).origin === this.origin ? { Authorization: `Bearer ${this.token}` } : {};
  }

  private statusError(status: number): LoraHubError {
    if (status === 401 || status === 403) {
      return new LoraHubError('This repository is private or gated. Accept its terms on huggingface.co, then set HF_TOKEN (a read token) and restart the Studio.', 403, 'forbidden');
    }
    if (status === 404) return new LoraHubError('Repository or file not found on Hugging Face.', 404, 'not_found');
    if (status === 429) return new LoraHubError('Hugging Face is rate-limiting requests. Wait a minute and try again.', 429, 'rate_limited');
    return new LoraHubError(`Hugging Face answered HTTP ${status}.`, 502, 'hub_error');
  }

  private async get(url: string, signal: AbortSignal): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, { headers: this.headersFor(url), signal });
    } catch (error) {
      if (error instanceof LoraHubError) throw error;
      throw new LoraHubError(`Could not reach Hugging Face (${error instanceof Error ? error.message : 'network error'}). Check your connection.`, 502, 'network');
    }
    if (!response.ok) throw this.statusError(response.status);
    return response;
  }

  private async getText(url: string, maxBytes: number): Promise<string> {
    const response = await this.get(url, AbortSignal.timeout(API_TIMEOUT_MS));
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) throw new LoraHubError('A file that should be small is too large.', 502, 'too_large');
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw new LoraHubError('A file that should be small is too large.', 502, 'too_large');
    return text;
  }

  private async getJson(url: string, maxBytes: number): Promise<unknown> {
    const text = await this.getText(url, maxBytes);
    try {
      return JSON.parse(text);
    } catch {
      throw new LoraHubError('Hugging Face answered with something that is not JSON.', 502, 'unexpected_response');
    }
  }

  /** Streams to a file while counting and hashing; aborts on a stall or when the declared size / the cap is exceeded. */
  private async download(url: string, dest: string, expected: HubFile, onBytes: (done: number) => void): Promise<{ sha256: string; bytes: number }> {
    const controller = new AbortController();
    let stalled = false;
    let timer: NodeJS.Timeout | undefined;
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        stalled = true;
        controller.abort();
      }, this.stallMs);
    };
    const cap = expected.size !== null ? Math.min(expected.size, this.maxWeightsBytes) : this.maxWeightsBytes;
    const hash = createHash('sha256');
    let received = 0;
    try {
      arm();
      const response = await this.get(url, controller.signal);
      if (!response.body) throw new LoraHubError('Hugging Face sent an empty answer.', 502, 'hub_error');
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          received += chunk.length;
          if (received > cap) return callback(new LoraHubError('The download is larger than announced.', 502, 'size_mismatch'));
          hash.update(chunk);
          arm();
          onBytes(received);
          callback(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(response.body as unknown as WebReadableStream), counter, createWriteStream(dest, { flags: 'wx' }), { signal: controller.signal });
      return { sha256: hash.digest('hex'), bytes: received };
    } catch (error) {
      if (stalled) throw new LoraHubError(`The download stalled (no data for ${Math.round(this.stallMs / 1000)} s).`, 504, 'download_stalled');
      if (error instanceof LoraHubError) throw error;
      throw new LoraHubError(`The download failed (${error instanceof Error ? error.message : 'network error'}).`, 502, 'network');
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
