// services/simple-video.ts
//
// "Cover + lyrics" video: one still picture (made by the browser: the cover, blurred behind and sharp in front, with the
// title) looped by ffmpeg under the song, with the synchronised lyrics burnt in as ASS subtitles. ffmpeg draws the text
// itself (libass), so nothing is drawn frame by frame in the browser and nothing is sent but one picture: a few tens of
// seconds for a whole song instead of several minutes.

export type SimpleLyricsStyle = 'line' | 'karaoke';

export interface AssOptions {
  width: number;
  height: number;
  style: SimpleLyricsStyle;
  /** Show the next line, smaller and dimmed, under the one being sung. */
  nextLine: boolean;
  /** Length of the song in seconds (the last line ends there at the latest). */
  duration?: number;
  /** Colour of the sung part in karaoke, "#rrggbb". */
  highlight?: string;
}

export interface LrcEntry { time: number; text: string }

/** A line stays on screen at most this long when the next one is far (an instrumental break). */
export const MAX_HOLD_S = 10;
const MIN_HOLD_S = 0.8;

const TIME_RE = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

/** The sung lines of an LRC text, in time order; [Verse] / [Chorus] tags and empty lines are left out. */
export function parseLrcEntries(lrc: string): LrcEntry[] {
  const out: LrcEntry[] = [];
  for (const raw of (lrc || '').split(/\r?\n/)) {
    const stamps: number[] = [];
    let rest = raw;
    TIME_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let lastEnd = 0;
    while ((m = TIME_RE.exec(raw)) && m.index === lastEnd) {
      const frac = m[3] ? Number(m[3]) / 10 ** m[3].length : 0;
      stamps.push(Number(m[1]) * 60 + Number(m[2]) + frac);
      lastEnd = TIME_RE.lastIndex;
    }
    rest = raw.slice(lastEnd).trim();
    if (!stamps.length || !rest || /^\[[^\]]*\]$/.test(rest)) continue;
    for (const time of stamps) out.push({ time, text: rest });
  }
  return out.sort((a, b) => a.time - b.time);
}

const assTime = (t: number): string => {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};

/** "#rrggbb" to ASS "&H00BBGGRR" (with an alpha byte, 00 = opaque). */
export function assColor(hex: string, alpha = 0): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const rgb = m ? m[1] : 'ffffff';
  const a = Math.max(0, Math.min(255, Math.round(alpha))).toString(16).padStart(2, '0');
  return `&H${a}${rgb.slice(4, 6)}${rgb.slice(2, 4)}${rgb.slice(0, 2)}`.toUpperCase();
}

/** Braces and backslashes would be read as ASS override tags. */
const escapeAss = (text: string): string => text.replace(/[{}]/g, '').replace(/\\/g, '/');

/** Karaoke tags: each word lights up in turn over the time the line is sung (word length decides its share). */
function karaokeText(text: string, seconds: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  const weights = words.map((w) => Math.max(2, w.length));
  const total = weights.reduce((a, b) => a + b, 0);
  const cs = Math.max(words.length, Math.round(seconds * 100));
  let used = 0;
  return words.map((w, i) => {
    const d = i === words.length - 1 ? cs - used : Math.round((cs * weights[i]) / total);
    used += d;
    return `{\\kf${Math.max(1, d)}}${escapeAss(w)}`;
  }).join(' ');
}

/** The ASS subtitle file for the lyrics of the video. */
export function lrcToAss(lrc: string, o: AssOptions): string {
  const lines = parseLrcEntries(lrc);
  const fontSize = Math.round(Math.min(o.width, o.height) * (o.height > o.width ? 0.052 : 0.06));
  const nextSize = Math.round(fontSize * 0.72);
  const marginV = Math.round(o.height * (o.height > o.width ? 0.16 : 0.09));
  const outline = Math.max(2, Math.round(fontSize / 18));
  const highlight = assColor(o.highlight || '#ec4899');
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${o.width}`,
    `PlayResY: ${o.height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // Karaoke: the sung part takes the primary colour, the rest stays in the secondary one.
    `Style: Lyric,Arial,${fontSize},${o.style === 'karaoke' ? highlight : assColor('#ffffff')},${assColor('#ffffff')},${assColor('#000000', 40)},${assColor('#000000', 128)},1,0,0,0,100,100,0,0,1,${outline},${Math.round(outline / 2)},2,60,60,${marginV + (o.nextLine ? Math.round(nextSize * 1.5) : 0)},1`,
    `Style: Next,Arial,${nextSize},${assColor('#ffffff', 110)},${assColor('#ffffff', 110)},${assColor('#000000', 140)},${assColor('#000000', 200)},0,0,0,0,100,100,0,0,1,${Math.max(1, outline - 1)},0,2,60,60,${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  // Fixed places, so libass never stacks the two lines itself (it swapped them when both wrapped on two lines): the sung
  // line grows upwards from its baseline, the next line grows downwards just under it.
  const cx = Math.round(o.width / 2);
  const lyricBottom = o.height - marginV - (o.nextLine ? Math.round(nextSize * 1.3) : 0);
  const nextTop = lyricBottom + Math.round(nextSize * 0.3);
  const events: string[] = [];
  lines.forEach((line, i) => {
    const next = lines[i + 1];
    const limit = next ? next.time : o.duration && o.duration > line.time ? o.duration : line.time + MAX_HOLD_S;
    const end = Math.max(line.time + MIN_HOLD_S, Math.min(limit, line.time + MAX_HOLD_S));
    const text = o.style === 'karaoke' ? karaokeText(line.text, Math.min(end - line.time, MAX_HOLD_S) * 0.9) : escapeAss(line.text);
    events.push(`Dialogue: 0,${assTime(line.time)},${assTime(end)},Lyric,,0,0,0,,{\\an2\\pos(${cx},${lyricBottom})}${text}`);
    if (o.nextLine && next) {
      events.push(`Dialogue: 0,${assTime(line.time)},${assTime(end)},Next,,0,0,0,,{\\an8\\pos(${cx},${nextTop})}${escapeAss(next.text)}`);
    }
  });
  return [...header, ...events, ''].join('\n');
}

/** Loudness asked by YouTube and the other platforms (they turn louder songs down to about this). */
export const LOUDNESS = { I: -14, TP: -1, LRA: 11 } as const;

export interface LoudnessMeasure {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
}

/** The JSON block that ffmpeg's loudnorm filter prints at the end of a measuring pass, or null. */
export function parseLoudnorm(stderr: string): LoudnessMeasure | null {
  const start = stderr.lastIndexOf('{');
  const end = stderr.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    const o = JSON.parse(stderr.slice(start, end + 1));
    const keys: (keyof LoudnessMeasure)[] = ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset'];
    if (!keys.every((k) => typeof o[k] === 'string' && Number.isFinite(Number(o[k])))) return null;
    return o as LoudnessMeasure;
  } catch {
    return null;
  }
}

/**
 * Arguments of the measuring pass (audio only: a few seconds for a song). `mastering` is the chain of the Mastering window
 * (services/mastering.ts), measured after it like there.
 */
export function loudnessMeasureArgs(audioPath: string, mastering = ''): string[] {
  const prefix = mastering ? `${mastering},` : '';
  return ['-hide_banner', '-nostats', '-i', audioPath, '-vn', '-af', `${prefix}loudnorm=I=${LOUDNESS.I}:TP=${LOUDNESS.TP}:LRA=${LOUDNESS.LRA}:print_format=json`, '-f', 'null', '-'];
}

/**
 * The audio filter that brings the song to -14 LUFS with peaks under -1 dBTP. With a measure, one linear gain (the
 * song's dynamics are kept); without one, loudnorm's own single pass.
 */
export function loudnessFilter(m: LoudnessMeasure | null, mastering = ''): string {
  const base = `${mastering ? `${mastering},` : ''}loudnorm=I=${LOUDNESS.I}:TP=${LOUDNESS.TP}:LRA=${LOUDNESS.LRA}`;
  const measured = m
    ? `:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`
    : '';
  // After the mastering's saturation a limiter holds the -1 dBTP ceiling, as in the Mastering window.
  const limiter = mastering ? `,alimiter=limit=${Math.pow(10, LOUDNESS.TP / 20).toFixed(4)}:level=disabled` : '';
  return `${base}${measured},aresample=48000${limiter}`;
}

export interface SimpleVideoArgs {
  stillPath: string;
  audioPath: string | null;
  /** File name of the ASS subtitles, relative to the working directory of ffmpeg (avoids escaping a full path in the filter). */
  assFile: string | null;
  outputPath: string;
  width: number;
  height: number;
  fps: number;
  duration: number;
  zoom: boolean;
  waveform: boolean;
  encoder: 'nvenc' | 'x264';
  /** Audio filter (loudness), or null to copy the song's level as it is. */
  audioFilter?: string | null;
}

/** ffmpeg's arguments for the video: the still looped, an optional slow zoom and waveform, the lyrics, the song. */
export function buildSimpleVideoArgs(a: SimpleVideoArgs): string[] {
  // The still is read once a second and repeated by the fps filter, in YUV from the start: reading and converting the
  // JPEG for every frame took most of the render time.
  const args = ['-hide_banner', '-loglevel', 'error', '-loop', '1', '-framerate', '1', '-i', a.stillPath];
  if (a.audioPath) args.push('-i', a.audioPath);
  // BT.709 like every HD video, so the colours of the cover are not shifted on YouTube.
  const chain: string[] = [`[0:v]scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,fps=${a.fps}[base]`];
  let label = 'base';
  if (a.zoom) {
    // A push of 8 % over the whole song, centred: slow enough not to distract, enough to look alive.
    const frames = Math.max(1, Math.round(a.duration * a.fps));
    chain.push(`[${label}]scale=${a.width * 2}:${a.height * 2},zoompan=z='1+0.08*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${a.width}x${a.height}:fps=${a.fps}[zoomed]`);
    label = 'zoomed';
  }
  if (a.waveform && a.audioPath) {
    const h = Math.round(a.height * 0.1);
    chain.push(`[1:a]showwaves=s=${a.width}x${h}:mode=cline:draw=full:rate=${a.fps}:colors=white@0.6,format=yuva420p[wave]`);
    chain.push(`[${label}][wave]overlay=0:H-h-${Math.round(a.height * 0.015)}:shortest=1:format=yuv420[waved]`);
    label = 'waved';
  }
  if (a.assFile) {
    chain.push(`[${label}]ass=${a.assFile}[lyr]`);
    label = 'lyr';
  }
  chain.push(`[${label}]format=yuv420p[vout]`);
  args.push('-filter_complex', chain.join(';'), '-map', '[vout]');
  if (a.audioPath) {
    args.push('-map', '1:a');
    if (a.audioFilter) args.push('-af', a.audioFilter);
    args.push('-c:a', 'aac', '-b:a', '256k', '-ar', '48000');
  }
  // What YouTube recommends for an upload: H.264 High, B-frames, a keyframe every 2 s, BT.709, moov atom at the start.
  if (a.encoder === 'nvenc') args.push('-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '26');
  else args.push('-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage', '-crf', '22');
  args.push('-profile:v', 'high', '-bf', '2', '-g', String(a.fps * 2));
  args.push('-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv');
  args.push('-r', String(a.fps), '-t', a.duration.toFixed(2), '-movflags', '+faststart', '-y', a.outputPath);
  return args;
}
