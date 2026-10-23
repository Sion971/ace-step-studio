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
