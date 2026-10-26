import { describe, expect, it } from 'vitest';
import { uploadToSong } from './uploadSong';

const track = { id: 't1', filename: 'Dieu est Esprit.mp3', audio_url: '/audio/a.mp3', duration: 142 };

describe('uploadToSong', () => {
  it('is a plain upload without an analysis', () => {
    const s = uploadToSong(track);
    expect(s).toMatchObject({ id: 'upload_t1', title: 'Dieu est Esprit', style: 'Upload', lyrics: '', duration: '2:22' });
    expect(s.bpm).toBeUndefined();
  });
  it('carries what the analysis found into the details', () => {
    const s = uploadToSong({ ...track, analysis: { available: true, status: '', caption: 'R&B pop', lyrics: 'la', bpm: 96, duration: 150, keyScale: 'A major', language: 'en', timeSignature: '4/4' } });
    expect(s).toMatchObject({ style: 'R&B pop', lyrics: 'la', bpm: 96, keyScale: 'A major', timeSignature: '4' });
  });
  it('takes the analyzed length when the audio has none yet', () => {
    const s = uploadToSong({ ...track, duration: null, analysis: { available: true, status: '', caption: '', lyrics: '', bpm: null, duration: 142.4, keyScale: '', language: '', timeSignature: '' } });
    expect(s.duration).toBe('2:22');
  });
  it('ignores an analysis that found nothing', () => {
    expect(uploadToSong({ ...track, analysis: { available: false, status: 'x', caption: '', lyrics: '', bpm: null, duration: null, keyScale: '', language: '', timeSignature: '' } }).style).toBe('Upload');
  });
});
