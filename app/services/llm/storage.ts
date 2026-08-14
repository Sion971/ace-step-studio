import type { OpenRouterConfig } from './types';

const PREFIX = 'acestep.llm.';
const KEYS = {
  useOpenRouter: PREFIX + 'useOpenRouter',
  openrouter: PREFIX + 'openrouter',
  recentModels: PREFIX + 'recentModels',
} as const;

export const DEFAULT_OR_CONFIG: OpenRouterConfig = {
  apiKey: '',
  // No hardcoded default — user picks from the live list returned by
  // OpenRouterClient.listModels() (https://openrouter.ai/api/v1/models).
  model: '',
  temperature: 0.9,
  topP: 1.0,
  topK: 0,
  minP: 0.0,
  frequencyPenalty: 0.0,
  presencePenalty: 0.0,
  repetitionPenalty: 1.0,
  maxTokens: 2000,
  seed: null,
  systemPromptGenerate: '',
  systemPromptFormat: '',
};

const RECENT_MODELS_LIMIT = 5;

export const llmStorage = {
  getUseOpenRouter(): boolean | null {
    const v = localStorage.getItem(KEYS.useOpenRouter);
    return v === null ? null : v === 'true';
  },

  setUseOpenRouter(v: boolean): void {
    localStorage.setItem(KEYS.useOpenRouter, String(v));
  },

  getOpenRouter(): OpenRouterConfig {
    const raw = localStorage.getItem(KEYS.openrouter);
    if (!raw) return { ...DEFAULT_OR_CONFIG };
    try {
      return { ...DEFAULT_OR_CONFIG, ...JSON.parse(raw) };
    } catch {
      return { ...DEFAULT_OR_CONFIG };
    }
  },

  setOpenRouter(patch: Partial<OpenRouterConfig>): void {
    const merged = { ...this.getOpenRouter(), ...patch };
    localStorage.setItem(KEYS.openrouter, JSON.stringify(merged));
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
