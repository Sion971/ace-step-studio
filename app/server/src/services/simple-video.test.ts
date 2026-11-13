// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { assColor, buildSimpleVideoArgs, lrcToAss, MAX_HOLD_S, parseLrcEntries } from './simple-video.js';

const LRC = `[00:00.00][Intro]
[00:14.80]Dans la vallée sombre, je ne crains rien
[00:24.72](Soit ma lumière)
[00:28.55]Le Seigneur est mon guide
[01:10.00]Sa promesse m'entoure`;

const dialogues = (ass: string) => ass.split('\n').filter((l) => l.startsWith('Dialogue:'));

describe('parseLrcEntries', () => {
  it('keeps the sung lines in order and leaves out the section tags', () => {
    const lines = parseLrcEntries(LRC);
    expect(lines.map((l) => l.text)).toEqual(['Dans la vallée sombre, je ne crains rien', '(Soit ma lumière)', 'Le Seigneur est mon guide', "Sa promesse m'entoure"]);
    expect(lines[0].time).toBeCloseTo(14.8);
  });

  it('reads several times on one line and three-digit fractions', () => {
    const lines = parseLrcEntries('[01:02.500][02:00.25]Refrain');
    expect(lines.map((l) => l.time)).toEqual([62.5, 120.25]);
  });
});

describe('lrcToAss', () => {
  it('writes one subtitle per line, from its time to the next line', () => {
    const ass = lrcToAss(LRC, { width: 1920, height: 1080, style: 'line', nextLine: false, duration: 90 });
    expect(ass).toContain('PlayResX: 1920');
    const d = dialogues(ass);
    expect(d).toHaveLength(4);
    expect(d[0]).toContain('0:00:14.80,0:00:24.72,Lyric');
    expect(d[0]).toContain('Dans la vallée sombre, je ne crains rien');
  });

  it('does not keep a line on screen through a long instrumental break', () => {
    const d = dialogues(lrcToAss(LRC, { width: 1920, height: 1080, style: 'line', nextLine: false, duration: 90 }));
    // 28.55 -> next line at 70 s: the line goes after MAX_HOLD_S.
    expect(d[2]).toContain(`0:00:28.55,0:00:${(28.55 + MAX_HOLD_S).toFixed(2)}`);
    // The last line ends with the song at the latest.
    expect(d[3]).toContain('0:01:10.00,0:01:20.00');
  });

  it('lights the words in turn in karaoke, and shows the next line when asked', () => {
    const ass = lrcToAss(LRC, { width: 1080, height: 1920, style: 'karaoke', nextLine: true, duration: 90 });
    const d = dialogues(ass);
    expect(d[0]).toMatch(/\{\\kf\d+\}Dans \{\\kf\d+\}la /);
    expect(d.some((l) => l.includes(',Next,') && l.includes('(Soit ma lumière)'))).toBe(true);
  });

  it('cannot be broken by braces or backslashes in the lyrics', () => {
    const d = dialogues(lrcToAss('[00:01.00]a {b} c\\d', { width: 1920, height: 1080, style: 'line', nextLine: false }));
    expect(d[0].endsWith('a b c/d')).toBe(true);
  });

  it('writes colours the ASS way (alpha, blue, green, red)', () => {
    expect(assColor('#ec4899')).toBe('&H009948EC');
    expect(assColor('#000000', 128)).toBe('&H80000000');
  });
});

describe('buildSimpleVideoArgs', () => {
  const base = { stillPath: 'still.png', audioPath: 'audio.flac', assFile: 'lyrics.ass', outputPath: 'out.mp4', width: 1920, height: 1080, fps: 25, duration: 200, zoom: false, waveform: false, encoder: 'x264' as const };

  it('loops the still under the song with the lyrics and stops at the end of the song', () => {
    const a = buildSimpleVideoArgs(base);
    expect(a.slice(0, 9)).toEqual(['-hide_banner', '-loglevel', 'error', '-loop', '1', '-framerate', '25', '-i', 'still.png']);
    expect(a[a.indexOf('-filter_complex') + 1]).toBe('[0:v]ass=lyrics.ass[lyr];[lyr]format=yuv420p[vout]');
    expect(a).toContain('libx264');
    expect(a[a.indexOf('-t') + 1]).toBe('200.00');
  });

  it('adds the zoom and the waveform when asked, and uses NVENC when told', () => {
    const a = buildSimpleVideoArgs({ ...base, zoom: true, waveform: true, encoder: 'nvenc' });
    const graph = a[a.indexOf('-filter_complex') + 1];
    expect(graph).toContain('zoompan=');
    expect(graph).toContain('showwaves=');
    expect(graph.indexOf('zoompan')).toBeLessThan(graph.indexOf('ass='));
    expect(a).toContain('h264_nvenc');
  });

  it('makes a silent video without lyrics when there is neither', () => {
    const a = buildSimpleVideoArgs({ ...base, audioPath: null, assFile: null });
    expect(a).not.toContain('1:a');
    expect(a[a.indexOf('-filter_complex') + 1]).toBe('[0:v]format=yuv420p[vout]');
  });
});
