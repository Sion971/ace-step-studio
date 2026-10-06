// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  INITIAL_GATE,
  SETUP_KEYS,
  buildRows,
  diskView,
  formatBytes,
  formatDuration,
  formatEta,
  hardwareFacts,
  nextGate,
  screenMode,
  shouldKeepPolling,
  type ComponentDto,
  type PipelineStatusDto,
} from './setup-view';
import { en } from '../i18n/en';
import { fr } from '../i18n/fr';
import { ja } from '../i18n/ja';
import { ko } from '../i18n/ko';
import { ru } from '../i18n/ru';
import { zh } from '../i18n/zh';

const component = (over: Partial<ComponentDto> = {}): ComponentDto => ({ id: 'main', kind: 'main', state: 'pending', ...over });
const status = (state: string, phase: any, components: ComponentDto[] = [component()], extra: any = {}): PipelineStatusDto => ({
  state,
  download: { phase, components, elapsedMs: 0, disk: { neededBytes: 0, low: false }, ...extra },
});

describe('when the screen starts showing (nextGate)', () => {
  it('latches when the engine started by the Studio is downloading', () => {
    expect(nextGate(INITIAL_GATE, status('starting', 'downloading')).latched).toBe(true);
    expect(nextGate(INITIAL_GATE, status('loading_model', 'downloading')).latched).toBe(true);
  });

  it('never latches on an ordinary restart, models being on disk', () => {
    expect(nextGate(INITIAL_GATE, status('starting', 'loading', [component({ state: 'done' })]))).toBe(INITIAL_GATE);
    expect(nextGate(INITIAL_GATE, status('ready', 'ready', [component({ state: 'done' })]))).toBe(INITIAL_GATE);
  });

  it('never latches for an engine the Studio does not run (state stopped)', () => {
    expect(nextGate(INITIAL_GATE, status('stopped', 'downloading'))).toBe(INITIAL_GATE);
  });

  it('latches when the engine failed while models were still missing', () => {
    const failed = status('error', 'error', [component({ state: 'failed', error: 'No space left on device' })]);
    expect(nextGate(INITIAL_GATE, failed).latched).toBe(true);
    const crashedBeforeDownloading = status('error', 'error', [component({ state: 'pending' })]);
    expect(nextGate(INITIAL_GATE, crashedBeforeDownloading).latched).toBe(true);
  });

  it('does not latch on a crash of an engine whose models are all present', () => {
    expect(nextGate(INITIAL_GATE, status('error', 'error', [component({ state: 'done' })]))).toBe(INITIAL_GATE);
  });

  it('ignores a server that does not report downloads yet, and the first fetch not having happened', () => {
    expect(nextGate(INITIAL_GATE, null)).toBe(INITIAL_GATE);
    expect(nextGate(INITIAL_GATE, { state: 'starting' })).toBe(INITIAL_GATE);
  });

  it('stays latched whatever comes next', () => {
    const latched = { ...INITIAL_GATE, latched: true };
    expect(nextGate(latched, status('ready', 'ready'))).toBe(latched);
  });
});

describe('what the screen shows (screenMode)', () => {
  const latched = { ...INITIAL_GATE, latched: true };

  it('shows nothing until it latched', () => {
    expect(screenMode(INITIAL_GATE, status('starting', 'downloading'))).toBeNull();
  });

  it('follows the phase once latched, and stays during loading until the engine is ready', () => {
    expect(screenMode(latched, status('starting', 'downloading'))).toBe('downloading');
    expect(screenMode(latched, status('loading_model', 'loading'))).toBe('loading');
    expect(screenMode(latched, status('error', 'error'))).toBe('error');
    expect(screenMode(latched, status('ready', 'ready'))).toBe('ready');
  });

  it('treats the engine saying it is ready as ready', () => {
    expect(screenMode(latched, status('ready', 'loading'))).toBe('ready');
  });

  it('hides after the user dismissed it, and after the ready message was shown', () => {
    expect(screenMode({ ...latched, dismissed: true }, status('starting', 'downloading'))).toBeNull();
    expect(screenMode({ ...latched, finished: true }, status('ready', 'ready'))).toBeNull();
  });
});

describe('polling (shouldKeepPolling)', () => {
  it('continues only while the screen is, or is about to be, useful', () => {
    expect(shouldKeepPolling({ latched: true, dismissed: false, finished: false })).toBe(true);
    expect(shouldKeepPolling({ latched: false, dismissed: false, finished: false })).toBe(false);
    expect(shouldKeepPolling({ latched: true, dismissed: true, finished: false })).toBe(false);
    expect(shouldKeepPolling({ latched: true, dismissed: false, finished: true })).toBe(false);
  });
});

describe('formatting', () => {
  it('uses decimal units and each language\'s own conventions', () => {
    expect(formatBytes(4_790_000_000, 'en')).toBe('4.79 GB');
    expect(formatBytes(4_790_000_000, 'fr')).toBe('4,79 Go');
    expect(formatBytes(4_790_000_000, 'ru')).toBe('4,79 ГБ');
    expect(formatBytes(337_400_000, 'fr')).toBe('337 Mo');
    expect(formatBytes(67_100_000, 'en')).toBe('67.1 MB');
    expect(formatBytes(12_000, 'fr')).toBe('12 Ko');
  });

  it('copes with nonsense', () => {
    expect(formatBytes(-5, 'en')).toBe('0 KB');
    expect(formatBytes(Number.NaN, 'en')).toBe('0 KB');
  });

  it('formats durations as m:ss, then h:mm:ss', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(5_000)).toBe('0:05');
    expect(formatDuration(121_000)).toBe('2:01');
    expect(formatDuration(3_600_000)).toBe('1:00:00');
    expect(formatDuration(25 * 60_000 + 56_000)).toBe('25:56');
    expect(formatDuration(-1)).toBe('0:00');
  });

  it('labels the remaining time as an estimate, and omits it when unknown', () => {
    expect(formatEta(277_000)).toBe('≈ 4:37');
    expect(formatEta(undefined)).toBeUndefined();
    expect(formatEta(Number.NaN)).toBeUndefined();
  });
});

describe('rows', () => {
  it('describes a first launch: base files, the music model, the language model', () => {
    const rows = buildRows(
      [
        component({ id: 'main', kind: 'main', state: 'done', expectedBytes: 1_540_000_000, seconds: 121 }),
        component({ id: 'acestep-v15-turbo', kind: 'dit', state: 'downloading', expectedBytes: 4_790_000_000, bytesDone: 67_100_000, bytesTotal: 4_790_000_000, elapsedMs: 100_000 }),
        component({ id: 'acestep-5Hz-lm-0.6B', kind: 'lm', state: 'pending', expectedBytes: 1_200_000_000, approx: true }),
      ],
      'en',
    );
    expect(rows[0]).toMatchObject({ labelKey: 'setup.component.main', modelName: undefined, stateKey: 'setup.state.done', sizeText: '1.54 GB', elapsedText: '2:01' });
    expect(rows[1]).toMatchObject({
      labelKey: 'setup.component.dit', modelName: 'acestep-v15-turbo', stateKey: 'setup.state.downloading',
      sizeText: '4.79 GB', progressText: '67.1 MB / 4.79 GB', elapsedText: '1:40',
    });
    expect(rows[2]).toMatchObject({ labelKey: 'setup.component.lm', stateKey: 'setup.state.pending', sizeText: '≈ 1.20 GB' });
    expect(rows[2].progressText).toBeUndefined();
  });

  it('shows counters only while downloading, exactly as received', () => {
    const [row] = buildRows([component({ kind: 'dit', id: 'm', state: 'downloading', bytesDone: 0, bytesTotal: 1_000_000_000 })], 'en');
    expect(row.progressText).toBe('0 KB / 1.00 GB');
    const [done] = buildRows([component({ kind: 'dit', id: 'm', state: 'done', bytesDone: 1, bytesTotal: 2 })], 'en');
    expect(done.progressText).toBeUndefined();
  });

  it('carries the reason of a failure, and tolerates an unknown size or kind', () => {
    const [row] = buildRows([component({ id: 'x', kind: 'weird' as any, state: 'failed', error: 'network down' })], 'en');
    expect(row).toMatchObject({ labelKey: 'setup.component.other', state: 'failed', error: 'network down' });
    expect(row.sizeText).toBeUndefined();
  });
});

describe('hardware and disk', () => {
  it('lists what the profile knows, in the user\'s language', () => {
    const facts = hardwareFacts({ gpuName: 'NVIDIA GeForce GTX 1050', vramGiB: 1.95, mode: 'gpu', tier: 1 }, 'fr');
    expect(facts).toEqual([
      { labelKey: 'setup.hw.gpu', value: 'NVIDIA GeForce GTX 1050' },
      { labelKey: 'setup.hw.memory', value: '1,95 Gio' },
      { labelKey: 'setup.hw.mode', valueKey: 'setup.mode.gpu' },
    ]);
  });

  it('describes the CPU mode, which has no graphics memory', () => {
    expect(hardwareFacts({ mode: 'cpu', gpuName: 'NVIDIA GeForce GTX 1050' }, 'en')).toEqual([
      { labelKey: 'setup.hw.gpu', value: 'NVIDIA GeForce GTX 1050' },
      { labelKey: 'setup.hw.mode', valueKey: 'setup.mode.cpu' },
    ]);
  });

  it('shows nothing without a profile', () => {
    expect(hardwareFacts(undefined, 'en')).toEqual([]);
    expect(hardwareFacts({}, 'en')).toEqual([]);
  });

  it('prepares the disk warning', () => {
    expect(diskView({ freeBytes: 5e9, neededBytes: 6_330_000_000, low: true }, 'fr')).toEqual({ low: true, freeText: '5,00 Go', neededText: '≈ 6,33 Go' });
    expect(diskView({ neededBytes: 1e9, low: false }, 'en').freeText).toBeUndefined();
  });
});

describe('translations of the screen', () => {
  const languages = { en, fr, ja, ko, ru, zh } as Record<string, Record<string, string>>;

  for (const [name, table] of Object.entries(languages)) {
    it(`${name} has every key the screen uses, none empty`, () => {
      for (const key of SETUP_KEYS) {
        expect(typeof table[key], `${name}: ${key}`).toBe('string');
        expect(table[key].trim().length, `${name}: ${key}`).toBeGreaterThan(0);
      }
    });

    it(`${name} has no stray setup.* key`, () => {
      const present = Object.keys(table).filter((k) => k.startsWith('setup.')).sort();
      expect(present).toEqual([...SETUP_KEYS].sort());
    });
  }

  it('does not leave an untranslated copy of the English text in another language', () => {
    // Legitimately identical: "GPU" everywhere, and "Mode" is the same word in French.
    const sameWord: Record<string, string[]> = { fr: ['setup.mode.gpu', 'setup.hw.mode'], ja: ['setup.mode.gpu'], ko: ['setup.mode.gpu'], ru: ['setup.mode.gpu'], zh: ['setup.mode.gpu'] };
    for (const name of ['fr', 'ja', 'ko', 'ru', 'zh']) {
      const identical = SETUP_KEYS.filter((k) => languages[name][k] === en[k as keyof typeof en] && !sameWord[name].includes(k));
      expect(identical, `${name} copies the English text`).toEqual([]);
    }
  });
});
