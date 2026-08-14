// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { pollinationsStorage, DEFAULT_POL_CONFIG } from './storage';

describe('pollinationsStorage', () => {
  beforeEach(() => localStorage.clear());

  describe('usePollinations toggle', () => {
    it('returns null when unset (caller decides default)', () => {
      expect(pollinationsStorage.getUsePollinations()).toBe(null);
    });

    it('persists true', () => {
      pollinationsStorage.setUsePollinations(true);
      expect(pollinationsStorage.getUsePollinations()).toBe(true);
    });

    it('persists false', () => {
      pollinationsStorage.setUsePollinations(false);
      expect(pollinationsStorage.getUsePollinations()).toBe(false);
    });
  });

  describe('config', () => {
    it('returns DEFAULT_POL_CONFIG when unset', () => {
      expect(pollinationsStorage.getConfig()).toEqual(DEFAULT_POL_CONFIG);
    });

    it('default has expected values', () => {
      expect(DEFAULT_POL_CONFIG.apiKey).toBe('');
      expect(DEFAULT_POL_CONFIG.model).toBe('');
      expect(DEFAULT_POL_CONFIG.width).toBe(1024);
      expect(DEFAULT_POL_CONFIG.height).toBe(1024);
      expect(DEFAULT_POL_CONFIG.seedMode).toBe('song');
      expect(DEFAULT_POL_CONFIG.enhance).toBe(true);
      expect(DEFAULT_POL_CONFIG.nologo).toBe(true);
      expect(DEFAULT_POL_CONFIG.safe).toBe(true);
    });

    it('merges partial updates', () => {
      pollinationsStorage.setConfig({ apiKey: 'sk_test', model: 'flux' });
      const cfg = pollinationsStorage.getConfig();
      expect(cfg.apiKey).toBe('sk_test');
      expect(cfg.model).toBe('flux');
      expect(cfg.width).toBe(DEFAULT_POL_CONFIG.width);
      expect(cfg.enhance).toBe(DEFAULT_POL_CONFIG.enhance);
    });

    it('returns DEFAULT on corrupted storage', () => {
      localStorage.setItem('acestep.pollinations.config', '{not valid json');
      expect(pollinationsStorage.getConfig()).toEqual(DEFAULT_POL_CONFIG);
    });

    it('persists boolean toggles', () => {
      pollinationsStorage.setConfig({ enhance: false, nologo: false, safe: false });
      const cfg = pollinationsStorage.getConfig();
      expect(cfg.enhance).toBe(false);
      expect(cfg.nologo).toBe(false);
      expect(cfg.safe).toBe(false);
    });

    it('persists seedMode random', () => {
      pollinationsStorage.setConfig({ seedMode: 'random' });
      expect(pollinationsStorage.getConfig().seedMode).toBe('random');
    });
  });

  describe('recent models', () => {
    it('returns empty when unset', () => {
      expect(pollinationsStorage.getRecentModels()).toEqual([]);
    });

    it('caps at 5 most recent', () => {
      for (let i = 0; i < 7; i++) pollinationsStorage.pushRecentModel('m' + i);
      expect(pollinationsStorage.getRecentModels()).toEqual(['m6', 'm5', 'm4', 'm3', 'm2']);
    });

    it('deduplicates', () => {
      pollinationsStorage.pushRecentModel('a');
      pollinationsStorage.pushRecentModel('b');
      pollinationsStorage.pushRecentModel('a');
      expect(pollinationsStorage.getRecentModels()).toEqual(['a', 'b']);
    });

    it('returns [] on corrupted storage', () => {
      localStorage.setItem('acestep.pollinations.recentModels', '[malformed');
      expect(pollinationsStorage.getRecentModels()).toEqual([]);
    });
  });

  describe('namespace prefix', () => {
    it('all keys are prefixed acestep.pollinations.', () => {
      pollinationsStorage.setUsePollinations(true);
      pollinationsStorage.setConfig({ apiKey: 'k' });
      pollinationsStorage.pushRecentModel('m');
      const keys = Object.keys(localStorage);
      expect(keys.every(k => k.startsWith('acestep.pollinations.'))).toBe(true);
    });
  });
});
