// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { audioKeyFromUrl, songVocalLanguage } from './song-fields.js';

describe('audioKeyFromUrl', () => {
  it('turns the stored URL into the storage key', () => {
    expect(audioKeyFromUrl('/audio/user1/song.flac')).toBe('user1/song.flac');
    expect(audioKeyFromUrl('s3://bucket-key/song.mp3')).toBe('bucket-key/song.mp3');
  });

  it('refuses anything else, and a path going up', () => {
    expect(audioKeyFromUrl('https://example.com/a.mp3')).toBeNull();
    expect(audioKeyFromUrl('/audio/../etc/passwd')).toBeNull();
    expect(audioKeyFromUrl(null)).toBeNull();
  });
});

describe('songVocalLanguage', () => {
  it('reads the language from the saved parameters, text or object', () => {
    expect(songVocalLanguage('{"vocalLanguage":"fr"}')).toBe('fr');
    expect(songVocalLanguage({ vocal_language: 'en' })).toBe('en');
    expect(songVocalLanguage('not json')).toBeNull();
    expect(songVocalLanguage(null)).toBeNull();
  });
});
