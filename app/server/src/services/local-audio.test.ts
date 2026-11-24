// @vitest-environment node
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { localAudioFile } from './local-audio.js';

const DIR = path.resolve('/srv/studio/public/audio');

describe('localAudioFile', () => {
  it('finds the file behind a Studio audio URL, relative or on the Studio address', () => {
    expect(localAudioFile('/audio/reference-tracks/u1/1.mp3', DIR)).toBe(path.join(DIR, 'reference-tracks/u1/1.mp3'));
    expect(localAudioFile('http://localhost:3001/audio/songs/a%20b.flac', DIR)).toBe(path.join(DIR, 'songs/a b.flac'));
  });

  it('refuses what is not an audio file of the Studio', () => {
    for (const url of ['/audio/../db.sqlite', '/audio/%2e%2e/secret', '/other/x.mp3', 'https://example.com/x.mp3', '', null, 42, '/audio/'])
      expect(localAudioFile(url, DIR), String(url)).toBeNull();
  });
});
