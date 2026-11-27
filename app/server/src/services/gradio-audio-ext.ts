/**
 * File extension for an audio file returned by the engine.
 *
 * The engine names its files after the format it really wrote. When the MP3 export fails it keeps the WAV
 * it had already made (engine fix from upstream #1313), so the requested format is only a fallback for a
 * name without a known extension: a WAV saved as ".mp3" would carry the wrong type.
 */
const KNOWN_EXTENSIONS = ['flac', 'wav', 'mp3', 'opus', 'aac', 'ogg', 'm4a'];

export function gradioAudioExtension(origName: string, requestedFormat: string): string {
  const match = /\.([a-z0-9]+)$/i.exec((origName || '').split(/[?#]/)[0]);
  const ext = match ? match[1].toLowerCase() : '';
  return KNOWN_EXTENSIONS.includes(ext) ? `.${ext}` : `.${requestedFormat}`;
}
