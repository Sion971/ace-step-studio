import type { PollinationsConfig } from './types';

const PREFIX = 'acestep.pollinations.';
const KEYS = {
  usePollinations: PREFIX + 'usePollinations',
  config: PREFIX + 'config',
  recentModels: PREFIX + 'recentModels',
} as const;

export const DEFAULT_POL_CONFIG: PollinationsConfig = {
  apiKey: '',
  model: '',          // user picks from /image/models — current free tier returns ['sana']
  width: 1024,
  height: 1024,
  seedMode: 'song',   // reproducible covers per song.id
  enhance: true,      // expand short prompts via Pollinations LLM
  nologo: true,       // legacy param, only effective with auth
  safe: true,         // SFW filter on by default
};

const RECENT_MODELS_LIMIT = 5;

export const pollinationsStorage = {
  getUsePollinations(): boolean | null {
    const v = localStorage.getItem(KEYS.usePollinations);
    return v === null ? null : v === 'true';
  },

  setUsePollinations(v: boolean): void {
    localStorage.setItem(KEYS.usePollinations, String(v));
  },

  getConfig(): PollinationsConfig {
    const raw = localStorage.getItem(KEYS.config);
    if (!raw) return { ...DEFAULT_POL_CONFIG };
    try {
      return { ...DEFAULT_POL_CONFIG, ...JSON.parse(raw) };
    } catch {
      return { ...DEFAULT_POL_CONFIG };
    }
  },

  setConfig(patch: Partial<PollinationsConfig>): void {
    const merged = { ...this.getConfig(), ...patch };
    localStorage.setItem(KEYS.config, JSON.stringify(merged));
  },

  getRecentModels(): string[] {
    const raw = localStorage.getItem(KEYS.recentModels);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  },

  pushRecentModel(id: string): void {
    const list = this.getRecentModels().filter(x => x !== id);
    list.unshift(id);
    localStorage.setItem(
      KEYS.recentModels,
      JSON.stringify(list.slice(0, RECENT_MODELS_LIMIT))
    );
  },
};
