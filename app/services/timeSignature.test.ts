import { describe, expect, it } from 'vitest';
import { formatTimeSignature } from './timeSignature';

describe('formatTimeSignature', () => {
  it('writes the number the engine uses as the full time signature', () => {
    expect(['2', '3', '4', '6'].map(formatTimeSignature)).toEqual(['2/4', '3/4', '4/4', '6/8']);
  });
  it('accepts a number and keeps what is already complete', () => {
    expect(formatTimeSignature(4)).toBe('4/4');
    expect(formatTimeSignature('4/4')).toBe('4/4');
    expect(formatTimeSignature('7/8')).toBe('7/8');
  });
  it('leaves "N/A", an empty value and an unknown text alone', () => {
    expect(formatTimeSignature('N/A')).toBe('N/A');
    expect(formatTimeSignature('')).toBe('');
    expect(formatTimeSignature(undefined)).toBe('');
    expect(formatTimeSignature(null)).toBe('');
    expect(formatTimeSignature(' 4 ')).toBe('4/4');
    expect(formatTimeSignature('5')).toBe('5');
  });
});
