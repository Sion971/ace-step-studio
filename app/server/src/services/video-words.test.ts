// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let trackAnalysis: unknown = null;
let training = false;
vi.mock('../db/pool.js', () => ({
  pool: { query: vi.fn(async (sql: string) => sql.includes('reference_tracks')
    ? { rows: trackAnalysis ? [{ analysis: JSON.stringify(trackAnalysis) }] : [] }
    : { rows: [{ generation_params: JSON.stringify({ vocalLanguage: 'fr' }) }] }) },
}));
vi.mock('./training-runner.js', () => ({ trainingRunner: { isRunning: () => training } }));
vi.mock('./whisper.js', () => ({ transcribeWordsWithWhisper: vi.fn(async () => null) }));
import { findHeardWords, wordsCacheFile } from './video-words.js';

let dir = '';
let audio = '';
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'words-'));
  audio = path.join(dir, 'song.flac');
  writeFileSync(audio, 'x');
  trackAnalysis = null;
  training = false;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const heard = { language: 'fr', words: [{ start: 10.2, end: 10.5, word: ' Merci' }] };

describe('words heard for the karaoke', () => {
  it('an import uses the words its analysis kept, without Whisper', async () => {
    trackAnalysis = { words: [[10.2, ' Merci']] };
    const transcribe = vi.fn();
    const r = await findHeardWords('/audio/reference-tracks/u/1.mp3', audio, { whisper: true, transcribe });
    expect(r.source).toBe('analysis');
    expect(r.words[0]).toMatchObject({ start: 10.2, word: ' Merci' });
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('a song is heard once by Whisper (in its language), then the kept words are reused', async () => {
    const transcribe = vi.fn(async () => heard);
    const first = await findHeardWords('/audio/u/s.flac', audio, { whisper: true, transcribe });
    expect(first.source).toBe('whisper');
    expect(transcribe).toHaveBeenCalledWith(expect.any(Buffer), 'song.flac', 'fr', undefined);
    expect(JSON.parse(readFileSync(wordsCacheFile(audio), 'utf8')).words).toEqual([[10.2, ' Merci']]);
    const second = await findHeardWords('/audio/u/s.flac', audio, { whisper: true, transcribe });
    expect(second.source).toBe('cache');
    expect(transcribe).toHaveBeenCalledTimes(1);
  });

  it('no Whisper run while a LoRA training uses the card, or when nothing was heard', async () => {
    training = true;
    const transcribe = vi.fn(async () => heard);
    expect((await findHeardWords('/audio/u/s.flac', audio, { whisper: true, transcribe })).source).toBe('none');
    expect(transcribe).not.toHaveBeenCalled();
    training = false;
    const silent = vi.fn(async () => ({ language: '', words: [] }));
    expect((await findHeardWords('/audio/u/s.flac', audio, { whisper: true, transcribe: silent })).source).toBe('none');
    expect(existsSync(wordsCacheFile(audio))).toBe(false);
  });
});
