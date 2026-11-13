import React, { useEffect, useRef, useState } from 'react';
import { X, Video, Loader2, Sparkles, Image as ImageIcon } from 'lucide-react';
import { useI18n } from '../context/I18nContext';
import { Song } from '../types';
import { fillTemplate } from '../utils/fillTemplate';
import { MASTERING_PRESETS, type MasteringPresetId } from '../services/masteringPresets';
import { audioDuration, composeCoverStill, renderSimpleVideo, shiftLrc, type StillBackground } from '../services/simpleVideo';

/**
 * Video Studio: the song's cover and its synchronised lyrics, made into an MP4 by ffmpeg on the server.
 *
 * The browser draws one still picture (shown here as the preview); the server loops it under the song, burns the lyrics
 * in as subtitles (line by line or karaoke), can add a slow zoom and a waveform, and brings the sound to the loudness of
 * YouTube and the other platforms. No effect and no frame drawn in the browser: a whole song takes a few tens of seconds.
 * Anything more elaborate belongs in a video editor.
 */
interface VideoGeneratorModalProps {
  isOpen: boolean;
  onClose: () => void;
  song: Song | null;
  /** Opens the cover window (AI or uploaded cover saved to the song); the new cover comes back through `song`. */
  onGenerateCover?: (song: Song) => void;
}

type AspectRatio = '16:9' | '9:16' | '1:1';
type LyricsMode = 'none' | 'line' | 'karaoke';
/** The sound of the video: as it is, brought to -14 LUFS, or mastered with a preset of the Mastering window then brought to -14 LUFS. */
type SoundMode = 'asis' | 'normalized' | Exclude<MasteringPresetId, 'off'>;

const RESOLUTIONS: Record<AspectRatio, { width: number; height: number; label: string }> = {
  '16:9': { width: 1920, height: 1080, label: '1920×1080' },
  '9:16': { width: 1080, height: 1920, label: '1080×1920' },
  '1:1': { width: 1080, height: 1080, label: '1080×1080' },
};

// Song objects carry the audio URL as `audioUrl` or `audio_url` depending on where they come from.
const resolveAudioUrl = (song: any): string => (song?.audioUrl || song?.audio_url || song?.audio || '').trim();

/** The first two sung lines of an LRC, for the preview. */
const firstLines = (lrc: string | undefined): string[] =>
  (lrc || '').split(/\r?\n/).map(l => l.replace(/^(\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\])+/, '').trim())
    .filter(l => l && !/^\[[^\]]*\]$/.test(l)).slice(0, 2);

const fileSafe = (name: string) => (name || 'video').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'video';

export const VideoGeneratorModal: React.FC<VideoGeneratorModalProps> = ({ isOpen, onClose, song, onGenerateCover }) => {
  const { t } = useI18n();

  const [aspect, setAspect] = useState<AspectRatio>('16:9');
  const [background, setBackground] = useState<StillBackground>('blurred');
  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  const [showTitle, setShowTitle] = useState(true);
  const [lyricsMode, setLyricsMode] = useState<LyricsMode>('karaoke');
  const [nextLine, setNextLine] = useState(true);
  const [highlight, setHighlight] = useState('#ec4899');
  const [offset, setOffset] = useState(0);
  const [zoom, setZoom] = useState(false);
  const [waveform, setWaveform] = useState(false);
  const [sound, setSound] = useState<SoundMode>('normalized');

  const [preview, setPreview] = useState<string | null>(null);
  const [seconds, setSeconds] = useState<number | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const hasLrc = Boolean(song?.lrcContent && song.lrcContent.trim());
  const coverUrl = song?.coverUrl || '';

  // A new song: its title and artist, its own cover, lyrics on when it has synchronised lyrics.
  useEffect(() => {
    if (!song) return;
    setTitle(song.title || '');
    setArtist(song.creator || '');
    setLyricsMode(song.lrcContent && song.lrcContent.trim() ? 'karaoke' : 'none');
    setOffset(0);
    setNote(null);
  }, [song?.id]);

  // The preview is the still the video will use (lyrics and waveform are added by ffmpeg).
  useEffect(() => {
    if (!isOpen || !song) return;
    let alive = true;
    const timer = setTimeout(async () => {
      const { width, height } = RESOLUTIONS[aspect];
      try {
        const still = await composeCoverStill({ coverUrl, title, artist, width, height, background, showTitle });
        if (alive) setPreview(still);
      } catch {
        if (alive) setPreview(null);
      }
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [isOpen, song?.id, coverUrl, title, artist, aspect, background, showTitle]);

  // Closing the window stops a video being made.
  useEffect(() => { if (!isOpen) abortRef.current?.abort(); }, [isOpen]);

  if (!isOpen || !song) return null;

  const busy = seconds !== null;
  const { width, height } = RESOLUTIONS[aspect];
  const sample = firstLines(song.lrcContent);
  // Lyric size and bottom margin as in lrcToAss, in % of the picture width / height.
  const portraitish = height > width;
  // An ASS font size is the height of the whole line, about 0.8 of a CSS font size.
  const lyricPx = (Math.min(width, height) * (portraitish ? 0.052 : 0.06) / width) * 100 * 0.8;
  const marginPct = (portraitish ? 0.16 : 0.09) * 100;

  const makeVideo = async () => {
    if (busy) return;
    const audioUrl = resolveAudioUrl(song);
    if (!audioUrl) { setNote({ ok: false, text: t('videoNoAudioUrl') }); return; }
    setNote(null);
    setSeconds(0);
    const started = Date.now();
    const tick = setInterval(() => setSeconds(Math.round((Date.now() - started) / 1000)), 1000);
    const abort = new AbortController();
    abortRef.current = abort;
    try {
      const { width, height } = RESOLUTIONS[aspect];
      const duration = await audioDuration(audioUrl);
      if (!duration) throw new Error(fillTemplate(t('videoAudioEmpty'), { url: audioUrl }));
      const still = await composeCoverStill({ coverUrl, title, artist, width, height, background, showTitle });
      const lrc = lyricsMode !== 'none' && hasLrc ? shiftLrc(song.lrcContent!, offset) : null;
      const { blob, lyricsBurned } = await renderSimpleVideo({
        still, audioUrl, lrc, width, height, duration,
        lyricsStyle: lyricsMode === 'karaoke' ? 'karaoke' : 'line',
        nextLine, zoom, waveform, highlight,
        normalize: sound !== 'asis',
        mastering: MASTERING_PRESETS.find(p => p.id === sound)?.settings,
      }, abort.signal);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.style.display = 'none';
      a.href = url;
      a.download = `${fileSafe(title || song.title)}.mp4`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
      const notes = [fillTemplate(t('quickVideoDone'), { seconds: Math.round((Date.now() - started) / 1000) })];
      if (lrc && !lyricsBurned) notes.push(t('quickVideoNoLibass'));
      setNote({ ok: true, text: notes.join(' ') });
    } catch (e) {
      if (abort.signal.aborted) setNote(null);
      else setNote({ ok: false, text: `${t('quickVideoFailed')} ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      clearInterval(tick);
      abortRef.current = null;
      setSeconds(null);
    }
  };

  const chip = (active: boolean) =>
    `py-1.5 px-2 rounded text-[11px] font-bold transition-colors ${active ? 'bg-pink-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'}`;
  const check = 'flex items-center gap-1.5 cursor-pointer text-[11px] text-zinc-300';
  const section = 'text-[10px] font-bold uppercase tracking-wider text-zinc-500';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-md p-0 md:p-4 animate-in fade-in duration-200">
      <div className="bg-zinc-950 border border-zinc-800 md:rounded-2xl w-full max-w-5xl h-full md:h-[90vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
          <div className="flex items-center gap-2 min-w-0">
            <Video size={18} className="text-pink-500 shrink-0" />
            <h2 className="font-bold text-white truncate">{t('videoStudio')}</h2>
            <span className="text-xs text-zinc-500 truncate">— {song.title}</span>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 min-h-0 flex flex-col md:flex-row">
          {/* Preview */}
          <div className="md:flex-1 min-w-0 min-h-0 h-[40vh] md:h-auto bg-black p-4">
            {/* The preview fits the free space whatever the format: the box is sized from the space (a size container), never
                from the picture, so the settings column keeps its width. */}
            <div className="w-full h-full flex items-center justify-center" style={{ containerType: 'size' }}>
              {preview ? (
                // The lyrics drawn over the still like ffmpeg will (same sizes and places as server/src/services/simple-video.ts).
                <div className="relative" style={{ containerType: 'inline-size', width: `min(100cqw, ${(100 * width) / height}cqh)`, aspectRatio: `${width} / ${height}` }}>
                  <img src={preview} alt="" className="absolute inset-0 w-full h-full object-contain rounded shadow-2xl" />
                  {lyricsMode !== 'none' && sample.length > 0 && (
                    <div className="absolute text-center leading-tight pointer-events-none" style={{ bottom: `${marginPct}%`, left: `${(6000 / width)}%`, right: `${(6000 / width)}%`, fontFamily: 'Arial, Helvetica, sans-serif' }}>
                      <div className="font-bold" style={{ fontSize: `${lyricPx}cqw`, textShadow: '0 0 0.12em #000, 0 0 0.12em #000' }}>
                        {lyricsMode === 'karaoke'
                          ? <><span style={{ color: highlight }}>{sample[0].slice(0, Math.ceil(sample[0].length * 0.45))}</span><span className="text-white">{sample[0].slice(Math.ceil(sample[0].length * 0.45))}</span></>
                          : <span className="text-white">{sample[0]}</span>}
                      </div>
                      {nextLine && sample[1] && (
                        <div className="text-white/60" style={{ fontSize: `${lyricPx * 0.72}cqw`, marginTop: '0.3em', textShadow: '0 0 0.1em #000' }}>{sample[1]}</div>
                      )}
                    </div>
                  )}
                  {waveform && (
                    <div className="absolute inset-x-0 bottom-[1.5%] h-[10%] pointer-events-none flex items-center gap-[0.4%] opacity-60">
                      {Array.from({ length: 60 }, (_, i) => (
                        <div key={i} className="flex-1 bg-white rounded-full" style={{ height: `${18 + 60 * Math.abs(Math.sin(i * 0.7) * Math.cos(i * 0.23))}%` }} />
                      ))}
                    </div>
                  )}
                </div>
              ) : <ImageIcon size={40} className="text-zinc-700" />}
            </div>
          </div>

          {/* Settings */}
          <div className="md:w-80 md:shrink-0 border-t md:border-t-0 md:border-l border-zinc-800 overflow-y-auto p-4 space-y-4">
            <p className="text-[11px] text-zinc-500 leading-snug">{t('quickVideoHint')}</p>

            <div className="space-y-1.5">
              <div className={section}>{t('videoCover')}</div>
              {/* The cover window imports an image or makes one with the AI, and saves it to the song: the preview follows. */}
              {onGenerateCover && (
                <button className={`${chip(false)} w-full flex items-center justify-center gap-1.5`} onClick={() => onGenerateCover(song)}>
                  <Sparkles size={12} />{t('videoCoverGenerate')}
                </button>
              )}
            </div>

            <div className="space-y-1.5">
              <div className={section}>{t('aspectRatio')}</div>
              <div className="grid grid-cols-3 gap-1">
                {(Object.keys(RESOLUTIONS) as AspectRatio[]).map(r => (
                  <button key={r} className={chip(aspect === r)} onClick={() => setAspect(r)} title={RESOLUTIONS[r].label}>{r}</button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <div className={section}>{t('videoBackground')}</div>
              <div className="grid grid-cols-2 gap-1">
                <button className={chip(background === 'blurred')} onClick={() => setBackground('blurred')}>{t('quickVideoBgBlurred')}</button>
                <button className={chip(background === 'full')} onClick={() => setBackground('full')}>{t('quickVideoBgFull')}</button>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className={check}><input type="checkbox" className="accent-pink-500" checked={showTitle} onChange={e => setShowTitle(e.target.checked)} />{t('quickVideoShowTitle')}</label>
              {showTitle && (
                <div className="space-y-1">
                  <input value={title} onChange={e => setTitle(e.target.value)} placeholder={t('title')}
                    className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-xs text-white focus:outline-none focus:border-pink-600" />
                  <input value={artist} onChange={e => setArtist(e.target.value)} placeholder={t('artist')}
                    className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-xs text-white focus:outline-none focus:border-pink-600" />
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              <div className={section}>{t('lyricsOverlay')}</div>
              <div className="grid grid-cols-3 gap-1">
                <button className={chip(lyricsMode === 'none')} onClick={() => setLyricsMode('none')}>{t('videoLyricsNone')}</button>
                <button className={chip(lyricsMode === 'line')} disabled={!hasLrc} onClick={() => setLyricsMode('line')}>{t('lyricsStyleLines')}</button>
                <button className={chip(lyricsMode === 'karaoke')} disabled={!hasLrc} onClick={() => setLyricsMode('karaoke')}>{t('lyricsStyleKaraoke')}</button>
              </div>
              {!hasLrc && <p className="text-[10px] text-amber-400/80 leading-snug">{t('quickVideoNoLrc')}</p>}
              {lyricsMode !== 'none' && (
                <div className="space-y-1.5">
                  <label className={check}><input type="checkbox" className="accent-pink-500" checked={nextLine} onChange={e => setNextLine(e.target.checked)} />{t('quickVideoNextLine')}</label>
                  {lyricsMode === 'karaoke' && (
                    <label className={check}>
                      <input type="color" value={highlight} onChange={e => setHighlight(e.target.value)} className="w-6 h-5 bg-transparent border-0 p-0 cursor-pointer" />
                      {t('videoHighlight')}
                    </label>
                  )}
                  <label className={`${check} justify-between`}>
                    <span>{t('lyricsOffset')} : {offset > 0 ? '+' : ''}{offset.toFixed(1)} s</span>
                    <input type="range" min={-5} max={5} step={0.1} value={offset} onChange={e => setOffset(Number(e.target.value))} className="w-32 accent-pink-500" />
                  </label>
                  <p className="text-[10px] text-zinc-500 leading-snug">{t('videoOffsetHint')}</p>
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              <div className={section}>{t('videoOptions')}</div>
              <label className={check}><input type="checkbox" className="accent-pink-500" checked={zoom} onChange={e => setZoom(e.target.checked)} />{t('quickVideoZoom')}</label>
              <label className={check}><input type="checkbox" className="accent-pink-500" checked={waveform} onChange={e => setWaveform(e.target.checked)} />{t('quickVideoWaveform')}</label>
            </div>

            <div className="space-y-1.5">
              <div className={section}>{t('videoSound')}</div>
              <div className="grid grid-cols-2 gap-1">
                <button className={chip(sound === 'asis')} onClick={() => setSound('asis')}>{t('videoSoundAsIs')}</button>
                <button className={chip(sound === 'normalized')} onClick={() => setSound('normalized')}>{t('videoSoundNormalized')}</button>
              </div>
              <div className="text-[10px] text-zinc-500">{t('videoSoundMastered')}</div>
              <div className="grid grid-cols-4 gap-1">
                {MASTERING_PRESETS.filter(p => p.id !== 'off').map(p => (
                  <button key={p.id} className={chip(sound === p.id)} onClick={() => setSound(p.id as SoundMode)}>{t(p.labelKey)}</button>
                ))}
              </div>
              <p className="text-[10px] text-zinc-500 leading-snug">{t('videoSoundHint')}</p>
            </div>
          </div>
        </div>

        <div className="border-t border-zinc-800 p-3 flex flex-col md:flex-row md:items-center gap-2">
          <div className={`flex-1 text-[11px] leading-snug ${note ? (note.ok ? 'text-emerald-400' : 'text-red-400') : 'text-zinc-500'}`}>
            {note ? note.text : busy ? fillTemplate(t('quickVideoRendering'), { seconds }) : ''}
          </div>
          {busy && (
            <button onClick={() => abortRef.current?.abort()} className="px-4 py-2 rounded-lg text-xs font-bold bg-zinc-800 text-zinc-300 hover:bg-zinc-700">
              {t('cancel')}
            </button>
          )}
          <button onClick={makeVideo} disabled={busy}
            className="px-5 py-2 rounded-lg text-sm font-bold bg-pink-600 text-white hover:bg-pink-500 disabled:opacity-60 flex items-center justify-center gap-2">
            {busy ? <Loader2 size={16} className="animate-spin" /> : <Video size={16} />}
            {t('renderVideo')}
          </button>
        </div>
      </div>
    </div>
  );
};
