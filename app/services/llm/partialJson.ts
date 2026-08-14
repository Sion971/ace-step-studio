import { parse, Allow } from 'partial-json';
import type { SongDraft } from './types';

const SONG_FIELDS: (keyof SongDraft)[] = [
  'title', 'caption', 'lyrics', 'tags', 'bpm', 'keyScale', 'timeSignature', 'durationSec', 'coverPrompt',
];

const STRING_FIELDS: (keyof SongDraft)[] = [
  'title', 'caption', 'lyrics', 'keyScale', 'timeSignature', 'coverPrompt',
];

export interface PartialResult {
  closed: Partial<SongDraft>;
  openStringField?: { name: keyof SongDraft; valueSoFar: string };
}

/**
 * String-aware bracket counter: returns true only when the "tags": [ array
 * is properly closed in `raw`, ignoring `]` characters inside string literals.
 */
function tagsArrayIsClosed(raw: string): boolean {
  const idx = raw.search(/"tags"\s*:\s*\[/);
  if (idx === -1) return false;
  let i = raw.indexOf('[', idx);
  if (i === -1) return false;
  i++; // past [
  let depth = 1;
  let inStr = false;
  let escape = false;
  while (i < raw.length) {
    const c = raw[i];
    if (inStr) {
      if (escape) { escape = false; }
      else if (c === '\\') { escape = true; }
      else if (c === '"') { inStr = false; }
    } else {
      if (c === '"') inStr = true;
      else if (c === '[') depth++;
      else if (c === ']') {
        depth--;
        if (depth === 0) return true;
      }
    }
    i++;
  }
  return false;
}

/**
 * Unescape a partial JSON string body, withholding incomplete escape sequences
 * at the end of the buffer (so the caller can append the next chunk and try again).
 */
function unescapeJsonStringPartial(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch !== '\\') { out += ch; i++; continue; }
    if (i === s.length - 1) break; // lone trailing backslash — hold
    const n = s[i + 1];
    switch (n) {
      case 'n': out += '\n'; i += 2; break;
      case 't': out += '\t'; i += 2; break;
      case 'r': out += '\r'; i += 2; break;
      case '"': out += '"'; i += 2; break;
      case '\\': out += '\\'; i += 2; break;
      case '/': out += '/'; i += 2; break;
      case 'b': out += '\b'; i += 2; break;
      case 'f': out += '\f'; i += 2; break;
      case 'u': {
        if (i + 6 > s.length) return out; // half-unicode — hold
        const hex = s.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return out;
        const code = parseInt(hex, 16);
        if (code >= 0xD800 && code <= 0xDBFF) {
          // High surrogate — need the low surrogate too
          const next = s.slice(i + 6, i + 12);
          if (!/^\\u[0-9a-fA-F]{4}$/.test(next)) return out; // withhold until next chunk
          const low = parseInt(next.slice(2), 16);
          if (low < 0xDC00 || low > 0xDFFF) {
            // Malformed surrogate pair — emit replacement char, skip both escape sequences
            out += '\uFFFD';
            i += 12;
            break;
          }
          out += String.fromCodePoint(0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00));
          i += 12;
        } else {
          out += String.fromCodePoint(code);
          i += 6;
        }
        break;
      }
      default:
        out += n; i += 2; break;
    }
  }
  return out;
}

/**
 * Find the last unclosed `"<key>": "...` in the raw JSON, if any.
 * Returns the field name and its value-so-far (JSON-unescaped, half-escapes withheld).
 */
function findOpenStringField(raw: string): { name: keyof SongDraft; valueSoFar: string } | undefined {
  let i = 0;
  let inStr = false;
  let escape = false;
  let strStart = -1;
  let pendingKey: string | null = null;

  while (i < raw.length) {
    const c = raw[i];
    if (inStr) {
      if (escape) { escape = false; i++; continue; }
      if (c === '\\') { escape = true; i++; continue; }
      if (c === '"') {
        const value = raw.slice(strStart + 1, i);
        if (pendingKey === null) {
          // this string was a key
          pendingKey = value;
        } else {
          // this string was a value for pendingKey — both consumed
          pendingKey = null;
        }
        inStr = false;
      }
    } else {
      if (c === '"') { inStr = true; strStart = i; }
      else if (c === ',' || c === '{') { pendingKey = null; }
    }
    i++;
  }

  // If we ended inside a string AND we have a pending key, this is an open value
  if (inStr && pendingKey !== null) {
    const valueRaw = raw.slice(strStart + 1);
    const name = pendingKey as keyof SongDraft;
    if (SONG_FIELDS.includes(name) && STRING_FIELDS.includes(name)) {
      return { name, valueSoFar: unescapeJsonStringPartial(valueRaw) };
    }
  }
  return undefined;
}

/**
 * Heuristically check if a string field's closing `"` actually appears in the source.
 * partial-json closes strings automatically when truncated; we only want to commit
 * to `closed` when the source already has the closing quote.
 */
function stringFieldIsClosed(raw: string, fieldName: keyof SongDraft): boolean {
  // Look for `"<field>": "..."` with a closing quote and a comma/brace after.
  const re = new RegExp(`"${fieldName}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
  return re.test(raw);
}

export function extractPartial(raw: string): PartialResult {
  const closed: Partial<SongDraft> = {};
  if (!raw.trim()) return { closed };

  let parsed: any;
  try { parsed = parse(raw, Allow.ALL); } catch { parsed = null; }

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const f of SONG_FIELDS) {
      if (!(f in parsed)) continue;
      const v = parsed[f];
      if (f === 'tags') {
        // Tags is closed only when fully parsed AND the closing `]` is in the source.
        if (Array.isArray(v) && tagsArrayIsClosed(raw)) {
          (closed as any)[f] = v;
        }
      } else if (f === 'bpm' || f === 'durationSec') {
        // Numbers: only commit if a non-digit terminator follows in source.
        if (typeof v === 'number' && new RegExp(`"${f}"\\s*:\\s*-?\\d+(\\.\\d+)?\\s*[,}]`).test(raw)) {
          (closed as any)[f] = v;
        }
      } else if (STRING_FIELDS.includes(f) && typeof v === 'string') {
        if (stringFieldIsClosed(raw, f)) {
          (closed as any)[f] = v;
        }
      }
    }
  }

  const openStringField = findOpenStringField(raw);

  // Suppress openStringField if its name is already in closed
  if (openStringField && (openStringField.name in closed)) {
    return { closed };
  }
  return { closed, openStringField };
}
