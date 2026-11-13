// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { assColor, buildSimpleVideoArgs, loudnessFilter, loudnessMeasureArgs, lrcToAss, MAX_HOLD_S, parseLoudnorm, parseLrcEntries } from './simple-video.js';

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
    expect(a.slice(0, 9)).toEqual(['-hide_banner', '-loglevel', 'error', '-loop', '1', '-framerate', '1', '-i', 'still.png']);
    // The still is read once a second and repeated at the video frame rate.
    expect(a[a.indexOf('-filter_complex') + 1]).toBe('[0:v]scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,fps=25[base];[base]ass=lyrics.ass[lyr];[lyr]format=yuv420p[vout]');
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
    expect(a[a.indexOf('-filter_complex') + 1]).toBe('[0:v]scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,fps=25[base];[base]format=yuv420p[vout]');
  });
});

describe('lrcToAss places', () => {
  it('pins the sung line above and the next line under it, so long lines never swap', () => {
    const ass = lrcToAss('[00:01.00]Qu’importent les douleurs présentes et les combats de demain\n[00:05.00]Tu vois chacune de mes larmes, Tu entends mes soupirs', { width: 1080, height: 1920, style: 'karaoke', nextLine: true, duration: 10 });
    const first = ass.split('\n').filter((l) => l.startsWith('Dialogue: 0,0:00:01.00'));
    const lyric = /Lyric,,0,0,0,,\{\\an2\\pos\((\d+),(\d+)\)\}/.exec(first[0])!;
    const next = /Next,,0,0,0,,\{\\an8\\pos\((\d+),(\d+)\)\}/.exec(first[1])!;
    expect(lyric[1]).toBe('540');
    expect(Number(next[2])).toBeGreaterThan(Number(lyric[2]));
  });
});

describe('loudness for YouTube', () => {
  const stderr = `[Parsed_loudnorm_0 @ 0x1] \n{\n\t"input_i" : "-8.73",\n\t"input_tp" : "0.41",\n\t"input_lra" : "5.20",\n\t"input_thresh" : "-18.90",\n\t"output_i" : "-14.02",\n\t"output_tp" : "-1.00",\n\t"output_lra" : "4.80",\n\t"output_thresh" : "-24.10",\n\t"normalization_type" : "dynamic",\n\t"target_offset" : "0.02"\n}\n`;

  it('reads the measure ffmpeg prints, and nothing from other output', () => {
    expect(parseLoudnorm(stderr)?.input_i).toBe('-8.73');
    expect(parseLoudnorm('no json here')).toBeNull();
    expect(parseLoudnorm('{"input_i": "x"}')).toBeNull();
  });

  it('applies one linear gain from the measure, at 48 kHz', () => {
    const f = loudnessFilter(parseLoudnorm(stderr));
    expect(f).toMatch(/^loudnorm=I=-14:TP=-1:LRA=11:measured_I=-8.73:.*linear=true,aresample=48000$/);
    expect(loudnessFilter(null)).toBe('loudnorm=I=-14:TP=-1:LRA=11,aresample=48000');
  });

  it('masters first, measures after the mastering, and limits the peaks', () => {
    expect(loudnessMeasureArgs('a.flac', 'highpass=f=25')).toContain('highpass=f=25,loudnorm=I=-14:TP=-1:LRA=11:print_format=json');
    const f = loudnessFilter(parseLoudnorm(stderr), 'highpass=f=25');
    expect(f.startsWith('highpass=f=25,loudnorm=')).toBe(true);
    expect(f).toMatch(/alimiter=limit=0\.8913:level=disabled$/);
  });

  it('passes the audio filter and the YouTube settings to ffmpeg', () => {
    const a = buildSimpleVideoArgs({ stillPath: 's.jpg', audioPath: 'a.flac', assFile: null, outputPath: 'o.mp4', width: 1920, height: 1080, fps: 25, duration: 10, zoom: false, waveform: false, encoder: 'x264', audioFilter: 'loudnorm=I=-14' });
    expect(a[a.indexOf('-af') + 1]).toBe('loudnorm=I=-14');
    expect(a.join(' ')).toContain('-c:a aac -b:a 256k -ar 48000');
    expect(a.join(' ')).toContain('-profile:v high -bf 2 -g 50');
    expect(a.join(' ')).toContain('-colorspace bt709');
  });
});

describe('lyrics above the waveform', () => {
  const lrc = '[00:01.00]Tu ne m’as pas livré à l’ennemi qui voulait me briser\n[00:05.00]Mais Tu as mis mes pieds au large, fidèle à Ta promesse.\n[00:09.00]Fin';
  const pos = (ass: string, style: string) => ass.split('\n').filter((l) => l.startsWith('Dialogue: 0,0:00:01.00') && l.includes(`${style},,`))
    .map((l) => Number(/\\pos\(\d+,(\d+)\)/.exec(l)![1]))[0];

  it('moves both lines up when a wrapped next line would run into the waveform', () => {
    const plain = lrcToAss(lrc, { width: 1080, height: 1080, style: 'karaoke', nextLine: true, duration: 12 });
    const waved = lrcToAss(lrc, { width: 1080, height: 1080, style: 'karaoke', nextLine: true, duration: 12, waveform: true });
    expect(pos(waved, 'Lyric')).toBeLessThan(pos(plain, 'Lyric'));
    // The next line (two lines of 47 px at 1.2) ends above the top of the waveform (1080 - 13.5 %).
    expect(pos(waved, 'Next') + 2 * Math.round(1080 * 0.06 * 0.72) * 1.2).toBeLessThanOrEqual(1080 - 1080 * 0.135 + 1);
  });

  it('keeps the usual place when there is room', () => {
    const short = '[00:01.00]Il est mon salut\n[00:05.00]Mon Roc\n[00:09.00]Fin';
    // 9:16 has a wide bottom margin: a short next line stays where it always was, waveform or not.
    const a = lrcToAss(short, { width: 1080, height: 1920, style: 'line', nextLine: true, duration: 12 });
    const b = lrcToAss(short, { width: 1080, height: 1920, style: 'line', nextLine: true, duration: 12, waveform: true });
    expect(pos(b, 'Lyric')).toBe(pos(a, 'Lyric'));
    expect(pos(a, 'Lyric')).toBe(1920 - Math.round(1920 * 0.16) - Math.round(Math.round(Math.round(1080 * 0.052) * 0.72) * 1.3));
  });
});
