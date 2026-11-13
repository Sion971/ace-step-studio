// services/song-fields.ts
//
// Small readings of the fields of a song row.

/** The storage key of a song stored by this Studio ("/audio/<user>/<id>.flac" -> "<user>/<id>.flac"), or null. */
export function audioKeyFromUrl(audioUrl: string | null | undefined): string | null {
  if (!audioUrl) return null;
  if (audioUrl.startsWith('s3://')) return audioUrl.slice('s3://'.length);
  const m = audioUrl.match(/^\/audio\/(.+)$/);
  return m && !m[1].split('/').includes('..') ? m[1] : null;
}

/** The sung language saved with the song ("fr", "en"...), or null. */
export function songVocalLanguage(generationParams: unknown): string | null {
  let params: any = generationParams;
  if (typeof params === 'string') {
    try { params = JSON.parse(params); } catch { return null; }
  }
  const lang = params?.vocalLanguage ?? params?.vocal_language;
  return typeof lang === 'string' && lang.trim() ? lang.trim() : null;
}
