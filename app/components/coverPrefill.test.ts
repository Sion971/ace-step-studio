// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { coverMetaFromSong, coverSongFromImport, isDurationLockedBySource } from './coverPrefill';
import { en } from '../i18n/en';
import { fr } from '../i18n/fr';
import { ja } from '../i18n/ja';
import { ko } from '../i18n/ko';
import { ru } from '../i18n/ru';
import { zh } from '../i18n/zh';

describe('coverMetaFromSong', () => {
  it('carries the lyrics, tempo, key, time signature and language of a generated song', () => {
    const meta = coverMetaFromSong({
      title: 'Je suis la voix',
      lyrics: '[Verse]\nJe suis la voix',
      bpm: 92.4, keyScale: 'D minor', timeSignature: '4',
      generationParams: { vocalLanguage: 'fr', style: 'chanson' },
    });
    expect(meta).toEqual({ title: 'Je suis la voix', lyrics: '[Verse]\nJe suis la voix', instrumental: false, bpm: 92, keyScale: 'D minor', timeSignature: '4', language: 'fr' });
  });

  it('falls back on the generation parameters and reads 4/4 as 4', () => {
    const meta = coverMetaFromSong({ lyrics: '', generationParams: { lyrics: 'la la', bpm: 120, keyScale: 'C major', timeSignature: '3/4' } });
    expect(meta).toMatchObject({ lyrics: 'la la', bpm: 120, keyScale: 'C major', timeSignature: '3' });
  });

  it('keeps an instrumental instrumental and leaves the lyrics alone', () => {
    expect(coverMetaFromSong({ lyrics: '[Instrumental]' })).toEqual({ instrumental: true });
    expect(coverMetaFromSong({ lyrics: '', generationParams: { instrumental: true } })).toEqual({ instrumental: true });
  });

  it('gives nothing for an import without analysis, so the panel keeps what is there', () => {
    expect(coverMetaFromSong({ lyrics: '  ', bpm: 0, generationParams: { vocalLanguage: 'unknown' } })).toEqual({});
  });
});

describe('coverSongFromImport', () => {
  it('takes an analysed import\'s lyrics, tempo, key, time signature and language', () => {
    const song = coverSongFromImport({
      id: 't1', filename: 'Je chanterai Tes merveilles.mp3', audio_url: '/audio/ref/t1.mp3',
      analysis: { available: true, status: 'ok', caption: 'pop rock', lyrics: '[Chorus]\nI will sing', bpm: 83, duration: 160,
        keyScale: 'E major', language: 'en', timeSignature: '4' },
    });
    expect(song.audioUrl).toBe('/audio/ref/t1.mp3');
    expect(coverMetaFromSong(song)).toEqual({ title: 'Je chanterai Tes merveilles', lyrics: '[Chorus]\nI will sing', instrumental: false, bpm: 83, keyScale: 'E major', timeSignature: '4', language: 'en' });
  });

  it('gives nothing for an import not analysed', () => {
    expect(coverMetaFromSong(coverSongFromImport({ id: 't2', filename: 'x.wav', audio_url: '/audio/ref/t2.wav' }))).toEqual({ title: 'x' });
  });
});

describe('isDurationLockedBySource', () => {
  it('locks the tasks whose length is the source length, once a source is loaded', () => {
    for (const task of ['cover', 'repaint', 'lego', 'extract']) expect(isDurationLockedBySource(task, true)).toBe(true);
    expect(isDurationLockedBySource('cover', false)).toBe(false);
    expect(isDurationLockedBySource('text2music', true)).toBe(false);
  });
});

describe('source-duration texts', () => {
  const languages: Record<string, Record<string, string>> = { en, fr, ja, ko, ru, zh };
  for (const [name, table] of Object.entries(languages)) {
    it(`${name} has them`, () => {
      for (const key of ['durationFromSource', 'durationFromSourcePending', 'tempoFollowsSource']) expect(table[key], `${name}.${key}`).toBeTruthy();
      expect(table.durationFromSource).toContain('{{time}}');
    });
  }
});
