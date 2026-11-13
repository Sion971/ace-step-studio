import { describe, expect, it } from 'vitest';
import { uploadToSong } from './uploadSong';

const base = { id: 't1', filename: 'Mon chant.flac', audio_url: '/audio/u/t1.flac', duration: 180 };
const analysis = { available: true, status: '', caption: 'gospel', lyrics: 'Dieu est esprit', bpm: 90, duration: 180, keyScale: '', language: 'fr', timeSignature: '4', lyricsSource: 'whisper' as const };

describe('an imported audio shown as a song', () => {
  it('carries the lyrics Whisper heard with their times, for the Video Studio and the player', () => {
    const song = uploadToSong({ ...base, analysis: { ...analysis, lrc: '[00:12.30]Dieu est esprit' } });
    expect(song.lrcContent).toBe('[00:12.30]Dieu est esprit');
  });

  it('has no synchronised lyrics when it was analysed without them', () => {
    expect(uploadToSong({ ...base, analysis }).lrcContent).toBeUndefined();
    expect(uploadToSong(base).lrcContent).toBeUndefined();
  });
});
