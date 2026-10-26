// services/uploadSong.ts
//
// An imported audio shown as a song (list, player, details panel). When it has been analyzed, the analysis fills what the details show.
import type { Song } from '../types';
import type { AudioAnalysis } from './audioAnalysis';
import { timeSignatureValue } from './audioAnalysis';

export interface UploadTrackLike {
  id: string;
  filename: string;
  audio_url: string;
  duration?: number | null;
  analysis?: AudioAnalysis | null;
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export function uploadToSong(track: UploadTrackLike, createdAt: Date = new Date()): Song {
  const a = track.analysis && track.analysis.available ? track.analysis : null;
  const seconds = track.duration || (a?.duration ? Math.round(a.duration) : 0);
  return {
    id: `upload_${track.id}`,
    title: track.filename.replace(/\.[^/.]+$/, ''),
    lyrics: a?.lyrics || '',
    style: a?.caption || 'Upload',
    coverUrl: '',
    duration: seconds ? mmss(seconds) : '--:--',
    createdAt,
    tags: [],
    audioUrl: track.audio_url,
    isPublic: false,
    bpm: a?.bpm || undefined,
    keyScale: a?.keyScale || undefined,
    timeSignature: a ? timeSignatureValue(a.timeSignature) || undefined : undefined,
  };
}
