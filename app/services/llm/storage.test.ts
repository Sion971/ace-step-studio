// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { llmStorage, DEFAULT_OR_CONFIG } from './storage';

describe('llmStorage', () => {
  beforeEach(() => localStorage.clear());

  describe('useOpenRouter toggle', () => {
    it('returns null when unset (caller falls back to server signal)', () => {
      expect(llmStorage.getUseOpenRouter()).toBe(null);
    });

    it('persists true', () => {
      llmStorage.setUseOpenRouter(true);
      expect(llmStorage.getUseOpenRouter()).toBe(true);
    });

    it('persists false', () => {
      llmStorage.setUseOpenRouter(false);
      expect(llmStorage.getUseOpenRouter()).toBe(false);
    });
  });

  describe('OpenRouter config', () => {
    it('returns DEFAULT_OR_CONFIG when unset', () => {
      const cfg = llmStorage.getOpenRouter();
      expect(cfg).toEqual(DEFAULT_OR_CONFIG);
    });

    it('default config has expected values', () => {
      expect(DEFAULT_OR_CONFIG.apiKey).toBe('');
      expect(DEFAULT_OR_CONFIG.temperature).toBe(0.9);
      expect(DEFAULT_OR_CONFIG.maxTokens).toBe(2000);
      expect(DEFAULT_OR_CONFIG.topP).toBe(1.0);
      expect(DEFAULT_OR_CONFIG.topK).toBe(0);
      expect(DEFAULT_OR_CONFIG.minP).toBe(0.0);
      expect(DEFAULT_OR_CONFIG.frequencyPenalty).toBe(0.0);
      expect(DEFAULT_OR_CONFIG.presencePenalty).toBe(0.0);
      expect(DEFAULT_OR_CONFIG.repetitionPenalty).toBe(1.0);
      expect(DEFAULT_OR_CONFIG.seed).toBe(null);
      expect(DEFAULT_OR_CONFIG.systemPromptGenerate).toBe('');
      expect(DEFAULT_OR_CONFIG.systemPromptFormat).toBe('');
      expect(DEFAULT_OR_CONFIG.model).toBe(''); // user picks from live OpenRouter list — no hardcoded default
    });

    it('merges partial updates without losing other fields', () => {
      llmStorage.setOpenRouter({ apiKey: 'sk-or-test', temperature: 1.2 });
      const cfg = llmStorage.getOpenRouter();
      expect(cfg.apiKey).toBe('sk-or-test');
      expect(cfg.temperature).toBe(1.2);
      expect(cfg.maxTokens).toBe(DEFAULT_OR_CONFIG.maxTokens); // unchanged
      expect(cfg.systemPromptGenerate).toBe(DEFAULT_OR_CONFIG.systemPromptGenerate); // unchanged
      expect(cfg.systemPromptFormat).toBe(DEFAULT_OR_CONFIG.systemPromptFormat); // unchanged
    });

    it('preserves null seed across updates', () => {
      llmStorage.setOpenRouter({ apiKey: 'sk-or-test' });
      expect(llmStorage.getOpenRouter().seed).toBe(null);
    });

    it('persists explicit seed', () => {
      llmStorage.setOpenRouter({ seed: 42 });
      expect(llmStorage.getOpenRouter().seed).toBe(42);
    });

    it('returns DEFAULT on corrupted storage', () => {
      localStorage.setItem('acestep.llm.openrouter', '{not valid json');
      expect(llmStorage.getOpenRouter()).toEqual(DEFAULT_OR_CONFIG);
    });

    it('partial update of one prompt field does not clobber the other', () => {
      llmStorage.setOpenRouter({ systemPromptGenerate: 'my generate override' });
      const cfg = llmStorage.getOpenRouter();
      expect(cfg.systemPromptGenerate).toBe('my generate override');
      expect(cfg.systemPromptFormat).toBe(''); // still default
    });

    it('reset to default is represented as empty string', () => {
      llmStorage.setOpenRouter({ systemPromptGenerate: 'custom' });
      llmStorage.setOpenRouter({ systemPromptGenerate: '' });
      expect(llmStorage.getOpenRouter().systemPromptGenerate).toBe('');
    });
  });

  describe('recent models', () => {
    it('returns empty list when unset', () => {
      expect(llmStorage.getRecentModels()).toEqual([]);
    });

    it('caps at 5, most-recent first, no duplicates', () => {
      for (let i = 0; i < 7; i++) llmStorage.pushRecentModel('model-' + i);
      expect(llmStorage.getRecentModels()).toEqual(['model-6','model-5','model-4','model-3','model-2']);
    });

    it('deduplicates: re-pushing existing model moves it to front', () => {
      llmStorage.pushRecentModel('a');
      llmStorage.pushRecentModel('b');
      llmStorage.pushRecentModel('c');
      llmStorage.pushRecentModel('a'); // re-push
      expect(llmStorage.getRecentModels()).toEqual(['a', 'c', 'b']);
    });

    it('returns [] on corrupted storage', () => {
      localStorage.setItem('acestep.llm.recentModels', '[malformed');
      expect(llmStorage.getRecentModels()).toEqual([]);
    });
  });

  describe('namespace prefix', () => {
    it('all keys are prefixed acestep.llm.', () => {
      llmStorage.setUseOpenRouter(true);
      llmStorage.setOpenRouter({ apiKey: 'k' });
      llmStorage.pushRecentModel('m');
      const keys = Object.keys(localStorage).sort();
      expect(keys.every(k => k.startsWith('acestep.llm.'))).toBe(true);
    });
  });
});
