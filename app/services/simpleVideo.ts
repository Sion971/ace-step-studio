// services/simpleVideo.ts
//
// "Cover + lyrics" video, made by ffmpeg on the server (see server/src/services/simple-video.ts). The browser only
// draws one still picture (the cover blurred behind, the cover itself in front, the title and the artist), then the
// server loops it under the song with the synchronised lyrics as subtitles.

export interface StillLayout {
  /** Centre and side of the sharp cover. */
  coverX: number;
  coverY: number;
  coverSize: number;
  /** Baselines of the title and of the artist. */
  titleY: number;
  artistY: number;
  titleSize: number;
  artistSize: number;
}

/** Where things go: the cover and the title in the upper part, the lower part kept for the lyrics. */
export function stillLayout(width: number, height: number): StillLayout {
  const portrait = height > width * 1.2;
  const square = !portrait && width < height * 1.2;
  const coverSize = Math.round(portrait ? width * 0.78 : square ? height * 0.46 : height * 0.44);
  const coverY = Math.round(portrait ? height * 0.30 : square ? height * 0.33 : height * 0.36);
  const below = coverY + coverSize / 2;
  const titleSize = Math.round(Math.min(width, height) * (portrait ? 0.06 : 0.055));
  const artistSize = Math.round(titleSize * 0.62);
  const titleY = Math.round(below + titleSize * 1.5);
  return { coverX: Math.round(width / 2), coverY, coverSize, titleY, artistY: Math.round(titleY + artistSize * 1.6), titleSize, artistSize };
}

const loadImage = (src: string): Promise<HTMLImageElement | null> => new Promise((resolve) => {
  if (!src) { resolve(null); return; }
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => resolve(img);
  img.onerror = () => resolve(null);
  img.src = src;
});

/** Shortens a text with "…" until it fits. */
function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxWidth) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

export interface StillOptions {
  coverUrl?: string | null;
  title: string;
  artist?: string;
  width: number;
  height: number;
  /** Colours of the background when there is no cover. */
  colors?: [string, string];
}

/** The still picture of the video, as a JPEG data URL. */
export async function composeCoverStill(o: StillOptions): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = o.width;
  canvas.height = o.height;
  const ctx = canvas.getContext('2d')!;
  const cover = await loadImage(o.coverUrl || '');
  const L = stillLayout(o.width, o.height);

  if (cover) {
    // The cover filling the frame, blurred and darkened.
    const scale = Math.max(o.width / cover.width, o.height / cover.height) * 1.1;
    const w = cover.width * scale;
    const h = cover.height * scale;
    ctx.filter = `blur(${Math.round(Math.min(o.width, o.height) * 0.035)}px) brightness(0.5) saturate(1.2)`;
    ctx.drawImage(cover, (o.width - w) / 2, (o.height - h) / 2, w, h);
    ctx.filter = 'none';
  } else {
    const [c0, c1] = o.colors || ['#2a0a3a', '#3b1d6e'];
    const g = ctx.createLinearGradient(0, 0, o.width, o.height);
    g.addColorStop(0, c0);
    g.addColorStop(1, c1);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, o.width, o.height);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, 0, o.width, o.height);
  }
  // Darker towards the bottom, where the lyrics go.
  const shade = ctx.createLinearGradient(0, o.height * 0.55, 0, o.height);
  shade.addColorStop(0, 'rgba(0,0,0,0)');
  shade.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, o.width, o.height);

  if (cover) {
    const s = L.coverSize;
    const x = L.coverX - s / 2;
    const y = L.coverY - s / 2;
    const r = Math.round(s * 0.04);
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = Math.round(s * 0.08);
    ctx.shadowOffsetY = Math.round(s * 0.02);
    ctx.beginPath();
    ctx.roundRect(x, y, s, s, r);
    ctx.fillStyle = '#000';
    ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, s, s, r);
    ctx.clip();
    // Square crop of the cover, centred.
    const side = Math.min(cover.width, cover.height);
    ctx.drawImage(cover, (cover.width - side) / 2, (cover.height - side) / 2, side, side, x, y, s, s);
    ctx.restore();
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.shadowColor = 'rgba(0,0,0,0.7)';
  ctx.shadowBlur = 8;
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${L.titleSize}px Inter, "Segoe UI", Arial, sans-serif`;
  ctx.fillText(fitText(ctx, o.title || '', o.width * 0.88), L.coverX, L.titleY);
  if (o.artist) {
    ctx.fillStyle = 'rgba(228,228,231,0.85)';
    ctx.font = `${L.artistSize}px Inter, "Segoe UI", Arial, sans-serif`;
    ctx.fillText(fitText(ctx, o.artist, o.width * 0.8), L.coverX, L.artistY);
  }
  return canvas.toDataURL('image/jpeg', 0.92);
}

/** The length of an audio file in seconds, read from its metadata (null when it cannot be read). */
export const audioDuration = (url: string, timeoutMs = 15000): Promise<number | null> => new Promise((resolve) => {
  const audio = new Audio();
  const done = (v: number | null) => { clearTimeout(timer); audio.src = ''; resolve(v); };
  const timer = setTimeout(() => done(null), timeoutMs);
  audio.preload = 'metadata';
  audio.onloadedmetadata = () => done(Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : null);
  audio.onerror = () => done(null);
  audio.src = url;
});

export interface SimpleVideoRequest {
  still: string;
  audioUrl: string;
  lrc: string | null;
  width: number;
  height: number;
  duration: number;
  lyricsStyle: 'line' | 'karaoke';
  nextLine: boolean;
  zoom: boolean;
  waveform: boolean;
  highlight?: string;
}

export class SimpleVideoError extends Error {}

/** Asks the server for the video; returns it with whether the lyrics could be burnt in. */
export async function renderSimpleVideo(req: SimpleVideoRequest, signal?: AbortSignal): Promise<{ blob: Blob; lyricsBurned: boolean }> {
  const res = await fetch('/api/render-video/simple', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...req, lrc: req.lrc || undefined, fps: 25 }),
    signal,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new SimpleVideoError(err.error || `HTTP ${res.status}`);
  }
  const blob = await res.blob();
  if (!blob.size) throw new SimpleVideoError('Empty video');
  return { blob, lyricsBurned: res.headers.get('X-Lyrics-Burned') === '1' };
}
