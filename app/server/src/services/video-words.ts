// services/video-words.ts
//
// The words heard in a song, with their times, for the word-by-word karaoke of the Video Studio. In order:
//   1. an imported audio: the words its analysis kept (no Whisper run);
//   2. a song whose words were already heard for a video: the file "<audio>.words.json" next to it;
//   3. otherwise Whisper hears the song once (about half a minute), and its words are kept in that file for the next videos.
// No words (Whisper not installed, a training running, nothing sung...): the karaoke splits each line evenly, as before.
import { readFile, writeFile } from 'fs/promises';
import path from 'path';
import { pool } from '../db/pool.js';
import { compactWords, expandWords } from './audio-analysis.js';
import type { TimedWord } from './lyrics-structure.js';
import { songVocalLanguage } from './song-fields.js';
import { trainingRunner } from './training-runner.js';
import { transcribeWordsWithWhisper } from './whisper.js';

export type WordSource = 'analysis' | 'cache' | 'whisper' | 'none';

export const wordsCacheFile = (audioFile: string): string => `${audioFile}.words.json`;

/** "/audio/reference-tracks/u/1.mp3?t=2" gives "reference-tracks/u/1.mp3". */
export const storageKeyOf = (audioUrl: string): string => decodeURIComponent(audioUrl.split('?')[0]).replace(/^\/audio\//, '');

export async function findHeardWords(
  audioUrl: string,
  audioFile: string,
  opts: { whisper: boolean; signal?: AbortSignal; transcribe?: typeof transcribeWordsWithWhisper },
): Promise<{ words: TimedWord[]; source: WordSource }> {
  // 1. An import analysed with Whisper.
  try {
    const track = await pool.query('SELECT analysis FROM reference_tracks WHERE storage_key = $1', [storageKeyOf(audioUrl)]);
    const raw = track.rows[0]?.analysis;
    const analysis = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (Array.isArray(analysis?.words) && analysis.words.length) return { words: expandWords(analysis.words), source: 'analysis' };
  } catch { /* not an import, or no readable analysis */ }

  // 2. Heard before, for an earlier video.
  try {
    const cached = JSON.parse(await readFile(wordsCacheFile(audioFile), 'utf8'));
    if (Array.isArray(cached?.words) && cached.words.length) return { words: expandWords(cached.words), source: 'cache' };
  } catch { /* first video of this song */ }

  // 3. Whisper, once; not while a LoRA training uses the card.
  if (!opts.whisper || trainingRunner.isRunning()) return { words: [], source: 'none' };
  let language: string | null = null;
  try {
    const song = await pool.query('SELECT generation_params FROM songs WHERE audio_url LIKE $1 LIMIT 1', [`%${storageKeyOf(audioUrl)}`]);
    language = songVocalLanguage(song.rows[0]?.generation_params);
  } catch { /* unknown song: Whisper finds the language */ }
  try {
    const heard = await (opts.transcribe ?? transcribeWordsWithWhisper)(await readFile(audioFile), path.basename(audioFile), language, opts.signal);
    if (!heard?.words.length) return { words: [], source: 'none' };
    await writeFile(wordsCacheFile(audioFile), JSON.stringify({ language: heard.language, words: compactWords(heard.words) }), 'utf8').catch(() => {});
    return { words: heard.words, source: 'whisper' };
  } catch (error) {
    console.warn('[Render] simple: Whisper could not hear the words, karaoke by even split:', error instanceof Error ? error.message : error);
    return { words: [], source: 'none' };
  }
}
