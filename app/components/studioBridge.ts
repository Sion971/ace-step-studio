// Bridge between the Studio tab and the audio editor (AudioMass) shown in an iframe.
// The editor is served by the same server (/editor), so the page can reach its window directly (same origin).

export interface EditorWindow extends Window {
  PKAudioEditor?: {
    multitrack?: unknown;
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
export function addTrackToEditor(frame: HTMLIFrameElement | null, file: File): boolean {
  const api = getEditorApi(frame);
  if (!api) return false;
  api.fireEvent('RequestAddTrackFile', file);
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
