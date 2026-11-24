// services/local-audio.ts
//
// The file on this machine behind an audio URL of the Studio ("/audio/…", or the same path on the Studio's own address), or null for
// anything else: another site, or a path that would leave the audio folder ("/audio/../…"). These files are served to anyone who has the
// URL, so reading one here gives nothing more than the URL already does.

import path from 'node:path';

export function localAudioFile(audioUrl: unknown, audioDir: string): string | null {
  if (typeof audioUrl !== 'string' || !audioUrl) return null;
  let pathname = audioUrl;
  if (/^https?:\/\//i.test(audioUrl)) {
    try { pathname = new URL(audioUrl).pathname; } catch { return null; }
  }
  if (!pathname.startsWith('/audio/')) return null;
  let rel: string;
  try { rel = decodeURIComponent(pathname.slice('/audio/'.length)); } catch { return null; }
  const root = path.resolve(audioDir);
  const file = path.resolve(root, rel);
  return file.startsWith(root + path.sep) ? file : null;
}
