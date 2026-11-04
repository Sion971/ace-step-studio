import { describe, expect, it } from 'vitest';
import { cleanText } from './cleanText';

describe('cleanText', () => {
  it('trims ordinary spaces', () => {
    expect(cleanText('  la la  ')).toBe('la la');
  });

  it('treats invisible characters as empty', () => {
    for (const c of ['​', '‌', '‍', '⁠', '﻿', '­']) {
      expect(cleanText(c)).toBe('');
      expect(cleanText(` ${c}\n${c} `)).toBe('');
    }
  });

  it('keeps visible text and the text around invisible marks', () => {
    expect(cleanText('​Hello​ world﻿')).toBe('Hello world');
    expect(cleanText('[Verse 1]')).toBe('[Verse 1]');
  });
});
