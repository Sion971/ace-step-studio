// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/pool.js', () => ({ pool: { query: vi.fn() } }));
import { withCorrectedLyrics } from './track-analysis.js';
import { compactWords, expandWords, withWhisperLyrics, type AudioAnalysis } from './audio-analysis.js';

const base: AudioAnalysis = {
  available: true, status: 'ok', caption: 'gospel', lyrics: 'Merci seigneur pour chaque gras\nPour chaque faveur', bpm: 92,
  duration: 60, keyScale: 'G major', language: 'fr', timeSignature: '4', lyricsSource: 'whisper',
  lrc: '[00:10.00]Merci seigneur pour chaque gras\n[00:14.00]Pour chaque faveur',
};

/** Words heard one every 0.4 s from `start`. */
const say = (line: string, start: number) => line.split(/\s+/).map((word, i) => ({ start: start + i * 0.4, end: start + i * 0.4 + 0.3, word: ` ${word}` }));

describe('lyrics corrected in the analysis window, kept with the import', () => {
  const heard = [...say('Merci seigneur pour chaque gras', 10), ...say('Pour chaque faveur', 14)];

  it('keeps the corrected text and times the LRC from the words heard, tags included', () => {
    const corrected = '[Chorus]\nMerci Seigneur pour chaque grâce\nPour chaque faveur';
    const r = withCorrectedLyrics(base, corrected, heard);
    expect(r.retimed).toBe(true);
    expect(r.analysis.lyrics).toBe(corrected);
    expect(r.analysis.lyricsEdited).toBe(true);
    expect(r.analysis.lrc).toBe('[00:10.00][Chorus]\n[00:10.00]Merci Seigneur pour chaque grâce\n[00:14.00]Pour chaque faveur');
  });

  it('keeps the previous timing when too few corrected words were heard (a different text)', () => {
    const r = withCorrectedLyrics(base, 'Un tout autre texte qui ne fut jamais chanté ici', heard);
    expect(r.retimed).toBe(false);
    expect(r.analysis.lrc).toBe(base.lrc);
    expect(r.analysis.lyrics).toBe('Un tout autre texte qui ne fut jamais chanté ici');
  });

  it('without heard words, keeps the text and the previous timing', () => {
    const r = withCorrectedLyrics(base, 'Merci Seigneur', []);
    expect(r).toMatchObject({ retimed: false, analysis: { lyrics: 'Merci Seigneur', lrc: base.lrc } });
  });

  it("the analysis keeps Whisper's words, compact, so a correction needs no second Whisper run", async () => {
    const a = await withWhisperLyrics({ ...base, lyricsSource: undefined, lrc: undefined }, {
      readAudio: async () => ({ buffer: Buffer.from('x'), name: 'a.mp3' }),
      transcribe: async () => ({ text: 'Merci seigneur', language: 'fr', lrc: '[00:10.00]Merci seigneur', words: [{ start: 10.123, word: ' Merci' }, { start: 10.5, word: ' seigneur' }] }),
    });
    expect(a.words).toEqual([[10.12, ' Merci'], [10.5, ' seigneur']]);
    expect(expandWords(a.words!)).toEqual([{ start: 10.12, end: 10.12, word: ' Merci' }, { start: 10.5, end: 10.5, word: ' seigneur' }]);
    expect(compactWords([{ start: 1.2345, word: 'a' }])).toEqual([[1.23, 'a']]);
  });
});
