// Bridge between the Studio tab and the audio editor (AudioMass) shown in an iframe.
// The editor is served by the same server (/editor), so the page can reach its window directly (same origin).

export interface EditorWindow extends Window {
  PKAudioEditor?: {
    multitrack?: { GetRegion?: () => { start: number; end: number } | null };
    fireEvent: (name: string, ...args: unknown[]) => unknown;
  };
}

/** The editor's API once it has started and its multitrack module is up, otherwise null. */
export function getEditorApi(frame: HTMLIFrameElement | null): NonNullable<EditorWindow['PKAudioEditor']> | null {
  try {
    const w = frame?.contentWindow as EditorWindow | null | undefined;
    const api = w?.PKAudioEditor;
    return api && api.multitrack ? api : null;
  } catch {
    return null; // not same-origin (never expected) : treated as "not ready"
  }
}

/** Waits for the editor to be ready (it starts a moment after the iframe's load event). */
export function waitForEditor(frame: HTMLIFrameElement | null, timeoutMs = 15000, stepMs = 150): Promise<NonNullable<EditorWindow['PKAudioEditor']> | null> {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const api = getEditorApi(frame);
      if (api) return resolve(api);
      if (Date.now() - started >= timeoutMs) return resolve(null);
      setTimeout(tick, stepMs);
    };
    tick();
  });
}

/** A file name the editor can show: the title without characters a file name cannot have, plus the audio extension of the URL. */
export function editorFileName(title: string, url: string): string {
  const clean = (title || 'Audio').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'Audio';
  const ext = /\.(mp3|flac|wav|ogg|m4a|aac|opus)(?:$|\?)/i.exec(url)?.[1]?.toLowerCase() ?? 'mp3';
  return `${clean}.${ext}`;
}

/** Puts an audio file on a new track of the editor. Returns false if the editor is not ready. */
export function addTrackToEditor(frame: HTMLIFrameElement | null, file: File, startSeconds = 0): boolean {
  const api = getEditorApi(frame);
  if (!api) return false;
  api.fireEvent('RequestAddTrackFile', file, startSeconds);
  return true;
}

/** Names of the clips currently in the editor's timeline, or null when it cannot be read. */
export function listEditorClipNames(frame: HTMLIFrameElement | null): string[] | null {
  try {
    const doc = frame?.contentDocument;
    if (!doc || !getEditorApi(frame)) return null;
    return Array.from(doc.querySelectorAll('.pk_mt_clip')).map((el) => {
      const last = el.lastElementChild;
      return (last ? last.textContent : el.textContent)?.trim() ?? '';
    });
  } catch {
    return null;
  }
}

export interface EditorEntry {
  id: string;
  name: string;
  addedAt: number;
  seen: boolean;
}

/**
 * Keeps the "already in the editor" marks truthful: an entry is confirmed once its clip shows up in the
 * timeline, removed when a confirmed clip is gone (track deleted), and given up if it never showed up.
 * The same song added twice is matched clip by clip.
 */
export function syncEditorEntries(entries: EditorEntry[], clipNames: string[], now: number, graceMs = 20000): EditorEntry[] {
  const remaining = [...clipNames];
  const out: EditorEntry[] = [];
  for (const e of entries) {
    const idx = remaining.indexOf(e.name);
    if (idx >= 0) {
      remaining.splice(idx, 1);
      out.push(e.seen ? e : { ...e, seen: true });
    } else if (!e.seen && now - e.addedAt < graceMs) {
      out.push(e);
    }
  }
  return out;
}

/** "3:07" or "0:22" -> seconds ; 0 when unreadable. */
export function durationToSeconds(text: string | undefined): number {
  const m = /^(\d+):(\d{1,2})$/.exec((text || '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

/** The time range selected in the editor ({start, end} in seconds), or null when nothing is selected. */
export function getEditorRegion(frame: HTMLIFrameElement | null): { start: number; end: number } | null {
  try {
    const r = getEditorApi(frame)?.multitrack?.GetRegion?.();
    return r && r.end > r.start ? { start: r.start, end: r.end } : null;
  } catch {
    return null;
  }
}

interface PcmSource {
  numberOfChannels: number;
  sampleRate: number;
  length: number;
  getChannelData: (channel: number) => Float32Array;
}

/** 16-bit PCM WAV of the part [startSec, endSec] of a decoded audio buffer. */
export function encodeWavSlice(buf: PcmSource, startSec: number, endSec: number): ArrayBuffer {
  const from = Math.max(0, Math.min(buf.length, Math.round(startSec * buf.sampleRate)));
  const to = Math.max(from, Math.min(buf.length, Math.round(endSec * buf.sampleRate)));
  const frames = to - from;
  const channels = Math.max(1, Math.min(2, buf.numberOfChannels));
  const out = new ArrayBuffer(44 + frames * channels * 2);
  const v = new DataView(out);
  const str = (o: number, t: string) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + frames * channels * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, channels, true);
  v.setUint32(24, buf.sampleRate, true); v.setUint32(28, buf.sampleRate * channels * 2, true);
  v.setUint16(32, channels * 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, frames * channels * 2, true);
  const data = Array.from({ length: channels }, (_, c) => buf.getChannelData(c));
  let o = 44;
  for (let i = from; i < to; i++) {
    for (let c = 0; c < channels; c++) {
      const x = Math.max(-1, Math.min(1, data[c][i]));
      v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true);
      o += 2;
    }
  }
  return out;
}

/** Cuts the part [startSec, endSec] out of an audio file, as a WAV blob. */
export async function trimAudioToWav(blob: Blob, startSec: number, endSec: number): Promise<Blob> {
  const Ctx = (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext;
  if (!Ctx) throw new Error('no AudioContext');
  const ctx = new Ctx();
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    return new Blob([encodeWavSlice(decoded, startSec, endSec)], { type: 'audio/wav' });
  } finally {
    ctx.close().catch(() => {});
  }
}
