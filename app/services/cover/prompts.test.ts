import { describe, it, expect } from 'vitest';
import { buildCoverPrompt, lyricsImagery } from './prompts';

const base = { title: 'X', caption: '', topic: '', language: 'en', instrumental: false };

describe('buildCoverPrompt', () => {
  it('always gives the model a mood, even with nothing else', () => {
    expect(buildCoverPrompt(base)).toBe('landscape, still life, abstract shapes, atmospheric, cinematic lighting, highly detailed');
  });

  it('leaves the title out — it would be drawn as lettering', () => {
    const out = buildCoverPrompt({ ...base, title: 'Звёздная пыль', caption: 'synthwave' });
    expect(out).not.toContain('Звёздная пыль');
  });

  it('puts what the user typed first, then the caption', () => {
    const out = buildCoverPrompt({ ...base, caption: 'synthwave, 80s, neon', topic: 'cyberpunk skyline' });
    expect(out.startsWith('cyberpunk skyline, synthwave, 80s, neon, ')).toBe(true);
  });

  it('does not repeat the caption when it is the brief itself', () => {
    const out = buildCoverPrompt({ ...base, caption: 'rock', topic: 'rock' });
    expect(out.match(/rock/g)).toHaveLength(1);
  });

  it('cuts the long paragraph written by the language model at a clause, not in the middle of a word', () => {
    const caption =
      'The track begins with an introspective solo piano playing arpeggiated chords, setting a melancholic mood for the clear male lead vocal sung in French. The arrangement builds into an anthemic chorus.';
    const out = buildCoverPrompt({ ...base, caption, topic: 'r&b, easy to sing, joy' });
    expect(out).toBe('r&b, easy to sing, joy, The track begins with an introspective solo piano playing arpeggiated chords, landscape, still life, abstract shapes, atmospheric, cinematic lighting, highly detailed');
    expect(out).not.toContain('setting');
  });

  it('cuts at a space when there is no clause to cut at', () => {
    const out = buildCoverPrompt({ ...base, caption: 'word '.repeat(60) });
    expect(out.startsWith('word word')).toBe(true);
    expect(out).not.toMatch(/wor,|wo,|w,/);
  });

  it('writes no negative clause: the model runs without guidance and would draw the words', () => {
    const out = buildCoverPrompt({ ...base, caption: 'rock', instrumental: true });
    expect(out).not.toMatch(/\bno text\b|\bno logo\b|watermark|typography/i);
  });

  it('asks for scenery, for every song, and never writes the word "people" (it would draw some)', () => {
    for (const instrumental of [true, false]) {
      const out = buildCoverPrompt({ ...base, caption: 'rock', instrumental });
      expect(out).toContain('landscape, still life, abstract shapes');
      expect(out).not.toMatch(/people|persons?\b/i);
    }
  });

  it('drops the vocal descriptors of the caption: "female vocals" makes the model draw a face', () => {
    const out = buildCoverPrompt({ ...base, caption: 'pop, dance, Female vocals, 120 bpm' });
    expect(out).toContain('pop, dance, 120 bpm');
    expect(out).not.toMatch(/vocal|female/i);
    expect(buildCoverPrompt({ ...base, caption: 'clear male lead vocal sung in French, folk' })).not.toMatch(/male|vocal|sung/i);
  });

  it('keeps the caption words that merely contain a vocal word', () => {
    expect(buildCoverPrompt({ ...base, caption: 'vocal jazz trio, ambient' })).toContain('jazz trio, ambient');
  });

  it('leaves the scenery out when the user asks for a person themselves', () => {
    const out = buildCoverPrompt({ ...base, topic: 'portrait of a woman in the rain' });
    expect(out.startsWith('portrait of a woman in the rain, ')).toBe(true);
    expect(out).not.toContain('landscape');
  });

  it('turns a multi-line caption (the vocal gender is appended on a new line) into one line', () => {
    const out = buildCoverPrompt({ ...base, caption: 'pop, dance\nsynthwave' });
    expect(out).toContain('pop, dance, synthwave');
    expect(out).not.toContain('\n');
  });

  it('trims and bounds what the user typed, so the style hint added by the server is not pushed out', () => {
    const out = buildCoverPrompt({ ...base, caption: '  rock  ', topic: 'x'.repeat(500) });
    expect(out).toContain(', rock, ');
    expect(out.length).toBeLessThan(330);
  });

  it('has no double commas', () => {
    expect(buildCoverPrompt({ ...base, caption: ' ' })).not.toMatch(/,\s*,/);
  });

  describe('with lyrics', () => {
    const lyrics = [
      '[Verse 1]',
      'Midnight rain on the window glass',
      'Streetlights drowning in the harbor',
      '',
      '[Chorus]',
      'Burning lanterns over the silver sea',
      'Burning lanterns over the silver sea',
      'Carry me home, (oh oh) carry me home',
    ].join('\n');
    const caption = 'The track begins with an introspective solo piano playing arpeggiated chords, slow tempo';

    it('shows the chorus, not the first verse, once, without tags or ad-libs', () => {
      expect(lyricsImagery(lyrics)).toBe('Burning lanterns over the silver sea, Carry me home, carry me home');
    });

    it('falls back to the first section when there is no chorus', () => {
      expect(lyricsImagery('[Verse]\nSnow falls on the empty pier\n[Bridge]\nSomething else')).toBe('Snow falls on the empty pier');
    });

    it('also reads lyrics that have no tags at all', () => {
      expect(lyricsImagery('Snow falls on the empty pier\nThe ferry never came')).toBe('Snow falls on the empty pier, The ferry never came');
    });

    it('drops the words that draw a face', () => {
      expect(lyricsImagery('[Chorus]\nOh baby, the girl by the sea\nCherie ma chérie')).not.toMatch(/baby|girl|chérie/i);
    });

    it('returns nothing for an instrumental marker or empty lyrics', () => {
      expect(lyricsImagery('[Instrumental]')).toBe('');
      expect(lyricsImagery('')).toBe('');
    });

    it('builds the picture from the lyrics and no longer from the sound of the song', () => {
      const out = buildCoverPrompt({ ...base, caption, lyrics });
      expect(out).toContain('Burning lanterns over the silver sea');
      expect(out).not.toMatch(/piano|arpeggiated|chords/i);
      expect(out).toContain('landscape, still life, abstract shapes');
    });

    it('keeps the scenery clause inside the 240 characters the server keeps', () => {
      const out = buildCoverPrompt({ ...base, caption, topic: 'r&b, easy to sing, joy and a long extra sentence about it', lyrics });
      expect(out.indexOf('abstract shapes') + 'abstract shapes'.length).toBeLessThanOrEqual(240);
    });

    it('ignores the lyrics of an instrumental, and lyrics too short to say anything', () => {
      const instrumental = buildCoverPrompt({ ...base, caption: 'ambient piano', lyrics, instrumental: true });
      expect(instrumental).toContain('ambient piano');
      expect(instrumental).not.toContain('lanterns');
      expect(buildCoverPrompt({ ...base, caption: 'ambient piano', lyrics: '[Verse]\nla la' })).toContain('ambient piano');
    });
  });
});
