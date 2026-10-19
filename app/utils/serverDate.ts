/**
 * Dates sent by the server.
 *
 * SQLite's `datetime('now')` gives "2026-10-19 02:15:00": UTC time with neither a "Z" nor an offset. `new Date()` reads
 * such a string as LOCAL time, so a song created now showed up hours in the future (4 h ahead at UTC-4) and was sorted
 * above the card of a generation that had just been started in the browser (made with the real `new Date()`), which
 * ended up in the middle of the list instead of at the top.
 */
const SQL_UTC = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/;

export function parseServerDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const match = SQL_UTC.exec(value.trim());
    if (match) return new Date(`${match[1]}T${match[2]}Z`);
  }
  return new Date(value as string | number);
}
