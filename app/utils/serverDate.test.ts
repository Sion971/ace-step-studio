import { describe, expect, it } from 'vitest';
import { parseServerDate } from './serverDate';

describe('parseServerDate', () => {
  it('reads a SQLite timestamp (no zone) as UTC, whatever the time zone of the browser', () => {
    expect(parseServerDate('2026-10-19 02:15:00').toISOString()).toBe('2026-10-19T02:15:00.000Z');
  });

  it('keeps fractional seconds and the "T" form', () => {
    expect(parseServerDate('2026-10-19T02:15:00.250').toISOString()).toBe('2026-10-19T02:15:00.250Z');
  });

  it('leaves a string that already has a zone alone', () => {
    expect(parseServerDate('2026-10-19T02:15:00Z').toISOString()).toBe('2026-10-19T02:15:00.000Z');
    expect(parseServerDate('2026-10-18T22:15:00-04:00').toISOString()).toBe('2026-10-19T02:15:00.000Z');
  });

  it('accepts a Date, a number and a date without time', () => {
    const d = new Date(1700000000000);
    expect(parseServerDate(d)).toBe(d);
    expect(parseServerDate(1700000000000).getTime()).toBe(1700000000000);
    expect(parseServerDate('2026-10-19').toISOString()).toBe('2026-10-19T00:00:00.000Z');
  });

  it('still gives an invalid date for nothing, as new Date(undefined) did', () => {
    expect(Number.isNaN(parseServerDate(undefined).getTime())).toBe(true);
  });

  it('a song just created by the server sorts after a card made now in the browser', () => {
    const now = Date.now();
    const sql = new Date(now).toISOString().slice(0, 19).replace('T', ' ');
    const fromServer = parseServerDate(sql).getTime();
    expect(Math.abs(fromServer - now)).toBeLessThan(1500);
  });
});
