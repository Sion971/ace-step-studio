// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { en } from '../i18n/en';
import type { TranslationKey } from '../i18n/translations';
import {
  HUB_ERROR_KEYS,
  LoraHubApiError,
  canUse,
  createLoraHubApi,
  errorMessage,
  formatBytes,
  modelName,
  progressPercent,
  readStudioContext,
  reasonMessage,
  reasonsToShow,
  recommendedParts,
  scaleFor,
  verdictLabel,
  verdictTone,
  type CompatibilityDto,
  type ReasonDto,
} from './loraHub';

const t = (key: TranslationKey) => en[key];
const nbsp = '\u00a0';
const compat = (over: Partial<CompatibilityDto> = {}): CompatibilityDto => ({ verdict: 'compatible', required: null, active: null, vramGb: null, reasons: [], ...over });
const reason = (code: ReasonDto['code'], severity: ReasonDto['severity'], params: ReasonDto['params'] = {}): ReasonDto => ({ code, severity, params });

describe('formatBytes', () => {
  it('writes sizes the way the Hub shows them, with a space that cannot be split', () => {
    expect(formatBytes(88_130_248)).toBe(`88.1${nbsp}MB`);
    expect(formatBytes(301_400_000)).toBe(`301${nbsp}MB`);
    expect(formatBytes(1_500_000_000)).toBe(`1.5${nbsp}GB`);
    expect(formatBytes(999)).toBe(`999${nbsp}B`);
    expect(formatBytes(0)).toBe(`0${nbsp}B`);
    expect(formatBytes(12_000)).toBe(`12.0${nbsp}kB`);
  });
  it('writes nothing for what is not a size', () => {
    for (const bad of [null, undefined, NaN, -1, Infinity]) expect(formatBytes(bad as number)).toBe('');
  });
});

describe('progressPercent', () => {
  it('is a whole percentage kept inside 0 to 100', () => {
    expect(progressPercent({ bytesDone: 37_000_000, bytesTotal: 88_130_248 })).toBe(41);
    expect(progressPercent({ bytesDone: 0, bytesTotal: 100 })).toBe(0);
    expect(progressPercent({ bytesDone: 100, bytesTotal: 100 })).toBe(100);
    expect(progressPercent({ bytesDone: 500, bytesTotal: 100 })).toBe(100);
    expect(progressPercent({ bytesDone: -5, bytesTotal: 100 })).toBe(0);
  });
  it('is null while the total is not known', () => {
    for (const bytesTotal of [null, 0, -1]) expect(progressPercent({ bytesDone: 10, bytesTotal })).toBeNull();
  });
});

describe('names, tones, labels', () => {
  it('names a model the way the Studio does', () => {
    expect(modelName({ family: 'turbo', size: '2B' })).toBe('Turbo (2B)');
    expect(modelName({ family: 'base', size: '2B' })).toBe('Base (2B)');
    expect(modelName({ family: 'turbo', size: 'XL' })).toBe('XL Turbo');
    expect(modelName({ family: 'sft', size: 'XL' })).toBe('XL SFT');
    expect(modelName({ family: null, size: 'XL' })).toBe('XL');
    expect(modelName({ family: null, size: '2B' })).toBe('2B');
    expect(modelName({ family: 'turbo', size: null })).toBe('Turbo');
    expect(modelName({ family: 'other', size: 'XL' })).toBe('XL');
    expect(modelName({ family: null, size: null })).toBe('');
    expect(modelName(null)).toBe('');
  });
  it('gives each verdict its own tone and label', () => {
    expect(['compatible', 'warning', 'incompatible', 'unknown'].map((v) => verdictTone(v as never))).toEqual(['good', 'warn', 'bad', 'neutral']);
    expect(verdictLabel('incompatible', t)).toBe('Not compatible');
    expect(verdictLabel('unknown', t)).toBe('Unknown');
  });
});

describe('reasons', () => {
  it('writes each reason as a sentence, from the codes and values the server sends', () => {
    expect(reasonMessage(reason('size_mismatch', 'blocking', { required: '2B', active: '2B', activeModel: 'acestep-v15-turbo' }), t)).toBe('Made for the 2B model, but the loaded model is Turbo (2B): it cannot be loaded.');
    expect(reasonMessage(reason('family_mismatch', 'warning', { required: 'turbo', active: 'base' }), t)).toBe('Made for Turbo, but the loaded model is Base: it loads, but the results will differ.');
    expect(reasonMessage(reason('vram_low', 'warning', { needed: 12, vramGb: 8 }), t)).toBe('It calls for a model that wants 12 GB of GPU memory; this GPU has 8 GB.');
    expect(reasonMessage(reason('comparison_incomplete', 'info'), t)).toBe(en.loraHubReasonIncomplete);
    expect(reasonMessage(reason('requirement_unknown', 'info'), t)).toBe(en.loraHubReasonRequirement);
    expect(reasonMessage(reason('active_model_unknown', 'info'), t)).toBe(en.loraHubReasonNoActive);
  });

  it('names the loaded model once: an XL model already says its size', () => {
    const text = reasonMessage(reason('size_mismatch', 'blocking', { required: '2B', active: 'XL', activeModel: 'acestep-v15-xl-turbo' }), t);
    expect(text).toBe('Made for the 2B model, but the loaded model is XL Turbo: it cannot be loaded.');
    expect(text).not.toMatch(/XL Turbo \(XL\)/);
    expect(reasonMessage(reason('size_mismatch', 'blocking', { required: '2B', active: 'XL' }), t)).toContain('loaded model is XL:');
  });

  it('writes the names of the sources that disagree in the user\'s language, and keeps one it does not know', () => {
    expect(reasonMessage(reason('conflicting_info', 'warning', { sources: 'metadata file, adapter config' }), t)).toBe('The sources disagree about the model it needs (metadata file, adapter config).');
    const fr = (key: TranslationKey) => ({ loraHubReasonConflict: 'Les sources se contredisent ({{sources}}).', loraHubSrcMetadata: 'fichier de métadonnées', loraHubSrcAdapter: 'configuration de l’adaptateur' } as Record<string, string>)[key];
    expect(reasonMessage(reason('conflicting_info', 'warning', { sources: 'metadata file, adapter config, something new' }), fr as never)).toBe('Les sources se contredisent (fichier de métadonnées, configuration de l’adaptateur, something new).');
  });

  it('orders them blocking first, then warnings, then information, each keeping its own severity', () => {
    const shown = reasonsToShow(
      compat({ reasons: [reason('comparison_incomplete', 'info'), reason('vram_low', 'warning', { needed: 12, vramGb: 8 }), reason('size_mismatch', 'blocking', { required: 'XL', active: '2B' })] }),
      t,
    );
    expect(shown.map((r) => r.severity)).toEqual(['blocking', 'warning', 'info']);
    expect(shown[0].text).toContain('cannot be loaded');
  });

  it('shows nothing for a reason it does not know', () => {
    expect(reasonsToShow(compat({ reasons: [reason('something_new' as never, 'info')] }), t)).toEqual([]);
  });
});

describe('errorMessage', () => {
  it('writes a known code in the user\'s language, whatever sentence the server added', () => {
    expect(errorMessage({ code: 'catalog_checksum_mismatch', message: 'English server sentence' }, t)).toBe(en.loraHubErrChanged);
    expect(errorMessage({ code: 'busy', message: 'x' }, t)).toBe(en.loraHubErrBusy);
    expect(errorMessage({ code: 'already_installing' }, t)).toBe(en.loraHubErrBusy);
    expect(errorMessage({ code: 'checksum_mismatch' }, t)).toBe(errorMessage({ code: 'size_mismatch' }, t));
    expect(errorMessage({ code: 'no_weights' }, t)).toBe(en.loraHubErrNotLora);
    expect(errorMessage({ code: 'unreachable' }, t)).toBe(en.loraHubErrNetwork);
  });
  it('falls back on the server\'s own sentence for a code it does not know, and on a generic one without it', () => {
    expect(errorMessage({ code: 'brand_new_code', message: 'Something specific happened.' }, t)).toBe('Something specific happened.');
    expect(errorMessage({ code: 'brand_new_code', message: 'Request failed' }, t)).toBe(en.loraHubErrGeneric);
    expect(errorMessage({}, t)).toBe(en.loraHubErrGeneric);
  });
  it('has a sentence for every code of the hub that the user can do something about', () => {
    // read from the server's own source, so that a code added there without a sentence here is noticed
    const source = readFileSync(path.resolve(__dirname, '../server/src/services/lora-hub.ts'), 'utf-8');
    const codes = new Set([...source.matchAll(/new LoraHubError\([\s\S]*?,\s*\d{3},\s*'([a-z_]+)'/g)].map((m) => m[1]));
    expect(codes.size).toBeGreaterThan(15); // guards the reading of the server file itself
    // the codes that are answered by the interface itself, or that only a developer can cause: they use the server's sentence
    const handledElsewhere = new Set(['choose_file', 'unknown_file', 'invalid_name', 'reserved_name', 'invalid_revision', 'invalid_checksum', 'install_failed', 'invalid_request']);
    const missing = [...codes].filter((code) => !HUB_ERROR_KEYS[code] && !handledElsewhere.has(code));
    expect(missing, 'a code of the hub has no sentence in the interface').toEqual([]);
  });
});

describe('what to do with an installed LoRA', () => {
  const rec = (scale: number | null) => ({ recommended: { scale, steps: null, guidance: null, shift: null } });
  it('sets the scale the author recommends, within what the slider can show', () => {
    expect(scaleFor(rec(0.8))).toBe(0.8);
    expect(scaleFor(rec(1))).toBe(1);
    expect(scaleFor(rec(1.5))).toBe(1);
    expect(scaleFor(rec(-1))).toBe(0);
    expect(scaleFor(rec(null))).toBeNull();
  });
  it('offers "Use" once installed, unless the loaded model cannot take it', () => {
    const installed = { name: 'x' } as never;
    expect(canUse({ installed: null, compatibility: compat() })).toBe(false);
    expect(canUse({ installed, compatibility: compat({ verdict: 'compatible' }) })).toBe(true);
    expect(canUse({ installed, compatibility: compat({ verdict: 'warning' }) })).toBe(true);
    expect(canUse({ installed, compatibility: compat({ verdict: 'unknown' }) })).toBe(true);
    expect(canUse({ installed, compatibility: compat({ verdict: 'incompatible' }) })).toBe(false);
  });
  it('lists only the settings the author recommends', () => {
    expect(recommendedParts({ scale: 1, steps: 8, guidance: 7, shift: 3 }, t)).toEqual(['Scale: 1', 'Steps: 8', 'Guidance: 7', 'Shift: 3']);
    expect(recommendedParts({ scale: 0.8, steps: 32, guidance: null, shift: null }, t)).toEqual(['Scale: 0.8', 'Steps: 32']);
    expect(recommendedParts({ scale: null, steps: null, guidance: null, shift: null }, t)).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------------------------- the client --
const respond = (status: number, body: unknown) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('the API client', () => {
  it('calls each route the way the server expects it', async () => {
    const fetchMock = vi.fn(async () => respond(200, { ok: true }));
    const api = createLoraHubApi(fetchMock as never);
    await api.catalog('tok', { activeModel: 'acestep-v15-turbo', vramGb: 8 });
    await api.catalog('tok', {});
    await api.installFromCatalog('tok', 'lo fi/1');
    await api.inspect('tok', 'user/repo', { activeModel: 'acestep-v15-turbo', vramGb: 8 }, 'a.safetensors');
    await api.inspect('tok', 'user/repo', {});
    await api.install('tok', 'user/repo', 'a.safetensors');
    await api.install('tok', 'user/repo');
    await api.job('tok', 'abc 1');
    await api.installed('tok');
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url, init]) => `${init.method} ${url}`)).toEqual([
      'GET /api/lora-hub/catalog?activeModel=acestep-v15-turbo&vramGb=8',
      'GET /api/lora-hub/catalog',
      'POST /api/lora-hub/catalog/lo%20fi%2F1/install',
      'POST /api/lora-hub/inspect',
      'POST /api/lora-hub/inspect',
      'POST /api/lora-hub/install',
      'POST /api/lora-hub/install',
      'GET /api/lora-hub/installs/abc%201',
      'GET /api/lora-hub/installed',
    ]);
    expect(JSON.parse(calls[3][1].body as string)).toEqual({ source: 'user/repo', file: 'a.safetensors', activeModel: 'acestep-v15-turbo', vramGb: 8 });
    expect(JSON.parse(calls[4][1].body as string)).toEqual({ source: 'user/repo' });
    expect(JSON.parse(calls[6][1].body as string)).toEqual({ source: 'user/repo' });
    expect((calls[0][1].headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('sends no Authorization header without a token', async () => {
    const fetchMock = vi.fn(async () => respond(200, {}));
    await createLoraHubApi(fetchMock as never).installed(null);
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers).not.toHaveProperty('Authorization');
  });

  it('keeps the code and the details of an error: the interface translates the code, and needs the list of files', async () => {
    const api = createLoraHubApi((async () => respond(409, { error: 'This repository has several .safetensors files: choose one.', code: 'choose_file', files: ['a.safetensors', 'b.safetensors'] })) as never);
    const error = await api.install('tok', 'user/repo').catch((e) => e);
    expect(error).toBeInstanceOf(LoraHubApiError);
    expect(error).toMatchObject({ status: 409, code: 'choose_file', message: 'This repository has several .safetensors files: choose one.', details: { files: ['a.safetensors', 'b.safetensors'] } });
  });

  it('copes with an error that is not what the server usually sends', async () => {
    expect(await createLoraHubApi((async () => respond(502, '<html>Bad gateway</html>')) as never).installed('t').catch((e) => e)).toMatchObject({ status: 502, code: 'unknown', message: 'Request failed' });
    expect(await createLoraHubApi((async () => respond(500, { error: 5, code: 7 })) as never).installed('t').catch((e) => e)).toMatchObject({ code: 'unknown', message: 'Request failed' });
    expect(await createLoraHubApi((async () => { throw new TypeError('Failed to fetch'); }) as never).installed('t').catch((e) => e)).toMatchObject({ status: 0, code: 'unreachable' });
  });
});

describe('readStudioContext', () => {
  const routes = (status: unknown, system: unknown) =>
    (async (url: string) => {
      const body = url.includes('model-status') ? status : system;
      return body === 'down' ? respond(502, {}) : body === 'throw' ? Promise.reject(new TypeError('x')) : respond(200, body);
    }) as never;

  it('gives the loaded model and the GPU memory when the engine is connected and ready', async () => {
    expect(await readStudioContext(routes({ state: 'ready', connected: true, activeModel: 'acestep-v15-turbo' }, { vram_total: 8 }))).toEqual({ activeModel: 'acestep-v15-turbo', vramGb: 8 });
    expect(await readStudioContext(routes({ state: 'ready', connected: true, activeModel: '  acestep-v15-xl-base ' }, { vram_total: 11.7 }))).toEqual({ activeModel: 'acestep-v15-xl-base', vramGb: 11.7 });
  });

  it('does not trust a model while the engine loads, unloads, failed, or is not connected: "the loaded model" is not one thing then', async () => {
    for (const state of ['loading', 'unloading', 'error', 'idle']) {
      expect((await readStudioContext(routes({ state, connected: true, activeModel: 'acestep-v15-turbo' }, { vram_total: 8 }))).activeModel, state).toBeUndefined();
    }
    expect((await readStudioContext(routes({ state: 'ready', connected: false, activeModel: 'acestep-v15-turbo' }, { vram_total: 8 }))).activeModel).toBeUndefined();
    expect((await readStudioContext(routes({ state: 'ready', connected: 'yes', activeModel: 'acestep-v15-turbo' }, { vram_total: 8 }))).activeModel).toBeUndefined();
    for (const activeModel of ['', '   ', null, 42]) expect((await readStudioContext(routes({ state: 'ready', connected: true, activeModel }, {}))).activeModel).toBeUndefined();
  });

  it('keeps the GPU memory even when the model is not known, and ignores a figure that cannot be one', async () => {
    expect(await readStudioContext(routes({ state: 'loading', connected: true, activeModel: 'x' }, { vram_total: 8 }))).toEqual({ vramGb: 8 });
    for (const vram_total of [0, -4, NaN, '8', null]) expect((await readStudioContext(routes({}, { vram_total }))).vramGb).toBeUndefined();
  });

  it('answers with nothing, rather than failing, when the server does not answer', async () => {
    expect(await readStudioContext(routes('down', 'down'))).toEqual({});
    expect(await readStudioContext(routes('throw', 'throw'))).toEqual({});
    expect(await readStudioContext(routes({ state: 'ready', connected: true, activeModel: 'acestep-v15-turbo' }, 'down'))).toEqual({ activeModel: 'acestep-v15-turbo' });
  });
});
