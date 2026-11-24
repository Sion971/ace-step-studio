// The library window of the Create panel: the imported audios and the created songs, each one to listen to and to
// use as the reference or the source. Taken out of CreatePanel.tsx as is; the panel keeps the list of imports and
// what happens to the one chosen (upload, delete, transcription, the audio fields).
import React, { useMemo, useRef, useState } from 'react';
import { Music2, Pause, Play, RefreshCw, Trash2, Upload } from 'lucide-react';
import type { Song } from '../types';
import { useI18n } from '../context/I18nContext';

export interface ReferenceTrack {
  id: string;
  filename: string;
  storage_key: string;
  duration: number | null;
  file_size_bytes: number | null;
  tags: string[] | null;
  created_at: string;
  audio_url: string;
}

export type LibraryTab = 'uploads' | 'created';

interface AudioLibraryModalProps {
  target: 'reference' | 'source';
  initialTab: LibraryTab;
  tracks: ReferenceTrack[];
  isLoading: boolean;
  /** The user's songs, for the "Created" tab (those still being made are left out). */
  createdSongs: Song[];
  userId?: string;
  isUploading: boolean;
  isTranscribing: boolean;
  uploadError: string | null;
  onUpload: (file: File) => void;
  onCancelTranscription: () => void;
  onDelete: (trackId: string) => Promise<void> | void;
  onUse: (track: { audio_url: string; title?: string }) => void;
  /** An import played here had no length recorded: here it is, in seconds. */
  onDurationKnown: (trackId: string, seconds: number) => void;
  onClose: () => void;
}

const formatTime = (time: number) => {
  if (!Number.isFinite(time) || time <= 0) return '0:00';
  const minutes = Math.floor(time / 60);
  const seconds = Math.floor(time % 60);
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
};

export const AudioLibraryModal: React.FC<AudioLibraryModalProps> = ({
  target, initialTab, tracks, isLoading, createdSongs, userId, isUploading, isTranscribing, uploadError,
  onUpload, onCancelTranscription, onDelete, onUse, onDurationKnown, onClose,
}) => {
  const { t } = useI18n();
  const [libraryTab, setLibraryTab] = useState<LibraryTab>(initialTab);
  const [playingTrackId, setPlayingTrackId] = useState<string | null>(null);
  const [playingTrackSource, setPlayingTrackSource] = useState<LibraryTab | null>(null);
  const modalAudioRef = useRef<HTMLAudioElement>(null);
  const [modalTrackTime, setModalTrackTime] = useState(0);
  const [modalTrackDuration, setModalTrackDuration] = useState(0);

  const createdTrackOptions = useMemo(() => {
    return createdSongs
      .filter(song => !song.isGenerating)
      .filter(song => (userId ? song.userId === userId : true))
      .filter(song => Boolean(song.audioUrl))
      .map(song => ({
        id: song.id,
        title: song.title || 'Untitled',
        audio_url: song.audioUrl!,
        duration: song.duration,
      }));
  }, [createdSongs, userId]);

  const toggleModalTrack = (track: { id: string; audio_url: string; source: LibraryTab }) => {
    if (playingTrackId === track.id) {
      if (modalAudioRef.current) {
        modalAudioRef.current.pause();
      }
      setPlayingTrackId(null);
      setPlayingTrackSource(null);
    } else {
      setPlayingTrackId(track.id);
      setPlayingTrackSource(track.source);
      if (modalAudioRef.current) {
        modalAudioRef.current.src = track.audio_url;
        modalAudioRef.current.play().catch(() => undefined);
      }
    }
  };

  // Deleting the import being played stops it.
  const remove = async (trackId: string) => {
    await onDelete(trackId);
    if (playingTrackId === trackId && playingTrackSource === 'uploads') {
      setPlayingTrackId(null);
      setPlayingTrackSource(null);
      modalAudioRef.current?.pause();
    }
  };

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="relative w-[92%] max-w-lg rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-white/10 shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="p-5 pb-4">
          <div className="flex items-start justify-between">
            <div>
              <h3 className="text-xl font-semibold text-zinc-900 dark:text-white">
                {target === 'reference' ? t('referenceModalTitle') : t('coverModalTitle')}
              </h3>
              <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
                {target === 'reference'
                  ? t('referenceModalDescription')
                  : t('coverModalDescription')}
              </p>
            </div>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg hover:bg-zinc-100 dark:hover:bg-white/10 text-zinc-400 hover:text-zinc-900 dark:hover:text-white transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
              </svg>
            </button>
          </div>

          {/* Upload Button */}
          <button
            type="button"
            onClick={() => {
              const input = document.createElement('input');
              input.type = 'file';
              input.accept = '.mp3,.wav,.flac,.m4a,.mp4,audio/*';
              input.onchange = (e) => {
                const file = (e.target as HTMLInputElement).files?.[0];
                if (file) onUpload(file);
              };
              input.click();
            }}
            disabled={isUploading || isTranscribing}
            className="mt-4 w-full flex items-center justify-center gap-2 rounded-xl border border-dashed border-zinc-300 dark:border-white/20 bg-zinc-50 dark:bg-white/5 px-4 py-3 text-sm font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-white/10 hover:border-zinc-400 dark:hover:border-white/30 transition-all"
          >
            {isUploading ? (
              <>
                <RefreshCw size={16} className="animate-spin" />
                {t('uploadingAudio')}
              </>
            ) : isTranscribing ? (
              <>
                <RefreshCw size={16} className="animate-spin" />
                {t('transcribing')}
              </>
            ) : (
              <>
                <Upload size={16} />
                {t('uploadAudio')}
                <span className="text-xs text-zinc-400 ml-1">{t('audioFormats')}</span>
              </>
            )}
          </button>

          {uploadError && (
            <div className="mt-2 text-xs text-rose-500">{uploadError}</div>
          )}
          {isTranscribing && (
            <div className="mt-2 flex items-center justify-between text-xs text-zinc-400">
              <span>{t('transcribingWithWhisper')}</span>
              <button
                type="button"
                onClick={onCancelTranscription}
                className="text-zinc-600 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-white"
              >
                {t('cancel')}
              </button>
            </div>
          )}
        </div>

        {/* Library Section */}
        <div className="border-t border-zinc-100 dark:border-white/5">
          <div className="px-5 py-3 flex items-center gap-2">
            <div className="flex items-center gap-1 bg-zinc-200/60 dark:bg-white/10 rounded-full p-0.5">
              <button
                type="button"
                onClick={() => setLibraryTab('uploads')}
                className={`px-3 py-1 rounded-full text-xs font-semibold transition-colors ${
                  libraryTab === 'uploads'
                    ? 'bg-zinc-900 dark:bg-white text-white dark:text-zinc-900'
                    : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200'
                }`}
              >
                {t('uploaded')}
              </button>
              <button
                type="button"
                onClick={() => setLibraryTab('created')}
                className={`px-3 py-1 rounded-full text-xs font-semibold transition-colors ${
                  libraryTab === 'created'
                    ? 'bg-zinc-900 dark:bg-white text-white dark:text-zinc-900'
                    : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200'
                }`}
              >
                {t('createdTab')}
              </button>
            </div>
          </div>

          {/* Track List */}
          <div className="max-h-[280px] overflow-y-auto">
            {libraryTab === 'uploads' ? (
              isLoading ? (
                <div className="px-5 py-8 text-center">
                  <RefreshCw size={20} className="animate-spin mx-auto text-zinc-400" />
                  <p className="text-xs text-zinc-400 mt-2">{t('loadingTracks')}</p>
                </div>
              ) : tracks.length === 0 ? (
                <div className="px-5 py-8 text-center">
                  <Music2 size={24} className="mx-auto text-zinc-300 dark:text-zinc-600" />
                  <p className="text-sm text-zinc-400 mt-2">{t('noTracksYet')}</p>
                  <p className="text-xs text-zinc-400 mt-1">{t('uploadAudioFilesAsReferences')}</p>
                </div>
              ) : (
                <div className="divide-y divide-zinc-100 dark:divide-white/5">
                  {tracks.map((track) => (
                    <div
                      key={track.id}
                      className="px-5 py-3 flex items-center gap-3 hover:bg-zinc-50 dark:hover:bg-white/[0.02] transition-colors group"
                    >
                      {/* Play Button */}
                      <button
                        type="button"
                        onClick={() => toggleModalTrack({ id: track.id, audio_url: track.audio_url, source: 'uploads' })}
                        className="flex-shrink-0 w-9 h-9 rounded-full bg-zinc-100 dark:bg-white/10 text-zinc-600 dark:text-zinc-300 flex items-center justify-center hover:bg-zinc-200 dark:hover:bg-white/20 transition-colors"
                      >
                        {playingTrackId === track.id && playingTrackSource === 'uploads' ? (
                          <Pause size={14} fill="currentColor" />
                        ) : (
                          <Play size={14} fill="currentColor" className="ml-0.5" />
                        )}
                      </button>

                      {/* Track Info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200 truncate">
                            {track.filename.replace(/\.[^/.]+$/, '')}
                          </span>
                          {track.tags && track.tags.length > 0 && (
                            <div className="flex gap-1">
                              {track.tags.slice(0, 2).map((tag, i) => (
                                <span key={i} className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-zinc-200 dark:bg-white/10 text-zinc-600 dark:text-zinc-400">
                                  {tag}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                        {/* Progress bar with seek - show when this track is playing */}
                        {playingTrackId === track.id && playingTrackSource === 'uploads' ? (
                          <div className="flex items-center gap-2 mt-1.5">
                            <span className="text-[10px] text-zinc-400 tabular-nums w-8">
                              {formatTime(modalTrackTime)}
                            </span>
                            <div
                              className="flex-1 h-1.5 rounded-full bg-zinc-200 dark:bg-white/10 cursor-pointer group/seek"
                              onClick={(e) => {
                                if (modalAudioRef.current && modalTrackDuration > 0) {
                                  const rect = e.currentTarget.getBoundingClientRect();
                                  const percent = (e.clientX - rect.left) / rect.width;
                                  modalAudioRef.current.currentTime = percent * modalTrackDuration;
                                }
                              }}
                            >
                              <div
                                className="h-full bg-gradient-to-r from-pink-500 to-purple-500 rounded-full relative"
                                style={{ width: modalTrackDuration > 0 ? `${(modalTrackTime / modalTrackDuration) * 100}%` : '0%' }}
                              >
                                <div className="absolute right-0 top-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full bg-white shadow-md opacity-0 group-hover/seek:opacity-100 transition-opacity" />
                              </div>
                            </div>
                            <span className="text-[10px] text-zinc-400 tabular-nums w-8 text-right">
                              {formatTime(modalTrackDuration)}
                            </span>
                          </div>
                        ) : (
                          <div className="text-xs text-zinc-400 mt-0.5">
                            {track.duration ? formatTime(track.duration) : '--:--'}
                          </div>
                        )}
                      </div>

                      {/* Actions */}
                      <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          type="button"
                          onClick={() => onUse({ audio_url: track.audio_url, title: track.filename })}
                          className="px-3 py-1.5 rounded-lg bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 text-xs font-semibold hover:bg-zinc-800 dark:hover:bg-zinc-100 transition-colors"
                        >
                          {t('useTrack')}
                        </button>
                        <button
                          type="button"
                          onClick={() => void remove(track.id)}
                          className="p-1.5 rounded-lg hover:bg-zinc-200 dark:hover:bg-white/10 text-zinc-400 hover:text-rose-500 transition-colors"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )
            ) : createdTrackOptions.length === 0 ? (
              <div className="px-5 py-8 text-center">
                <Music2 size={24} className="mx-auto text-zinc-300 dark:text-zinc-600" />
                <p className="text-sm text-zinc-400 mt-2">{t('noCreatedSongsYet')}</p>
                <p className="text-xs text-zinc-400 mt-1">{t('generateSongsToReuse')}</p>
              </div>
            ) : (
              <div className="divide-y divide-zinc-100 dark:divide-white/5">
                {createdTrackOptions.map((track) => (
                  <div
                    key={track.id}
                    className="px-5 py-3 flex items-center gap-3 hover:bg-zinc-50 dark:hover:bg-white/[0.02] transition-colors group"
                  >
                    <button
                      type="button"
                      onClick={() => toggleModalTrack({ id: track.id, audio_url: track.audio_url, source: 'created' })}
                      className="flex-shrink-0 w-9 h-9 rounded-full bg-zinc-100 dark:bg-white/10 text-zinc-600 dark:text-zinc-300 flex items-center justify-center hover:bg-zinc-200 dark:hover:bg-white/20 transition-colors"
                    >
                      {playingTrackId === track.id && playingTrackSource === 'created' ? (
                        <Pause size={14} fill="currentColor" />
                      ) : (
                        <Play size={14} fill="currentColor" className="ml-0.5" />
                      )}
                    </button>

                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-zinc-800 dark:text-zinc-200 truncate">
                        {track.title}
                      </div>
                      {playingTrackId === track.id && playingTrackSource === 'created' ? (
                        <div className="flex items-center gap-2 mt-1.5">
                          <span className="text-[10px] text-zinc-400 tabular-nums w-8">
                            {formatTime(modalTrackTime)}
                          </span>
                          <div
                            className="flex-1 h-1.5 rounded-full bg-zinc-200 dark:bg-white/10 cursor-pointer group/seek"
                            onClick={(e) => {
                              if (modalAudioRef.current && modalTrackDuration > 0) {
                                const rect = e.currentTarget.getBoundingClientRect();
                                const percent = (e.clientX - rect.left) / rect.width;
                                modalAudioRef.current.currentTime = percent * modalTrackDuration;
                              }
                            }}
                          >
                            <div
                              className="h-full bg-gradient-to-r from-pink-500 to-purple-500 rounded-full relative"
                              style={{ width: modalTrackDuration > 0 ? `${(modalTrackTime / modalTrackDuration) * 100}%` : '0%' }}
                            >
                              <div className="absolute right-0 top-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full bg-white shadow-md opacity-0 group-hover/seek:opacity-100 transition-opacity" />
                            </div>
                          </div>
                          <span className="text-[10px] text-zinc-400 tabular-nums w-8 text-right">
                            {formatTime(modalTrackDuration)}
                          </span>
                        </div>
                      ) : (
                        <div className="text-xs text-zinc-400 mt-0.5">
                          {track.duration || '--:--'}
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        type="button"
                        onClick={() => onUse({ audio_url: track.audio_url, title: track.title })}
                        className="px-3 py-1.5 rounded-lg bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 text-xs font-semibold hover:bg-zinc-800 dark:hover:bg-zinc-100 transition-colors"
                      >
                        {t('useTrack')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Hidden audio element for modal playback */}
        <audio
          ref={modalAudioRef}
          onTimeUpdate={() => {
            if (modalAudioRef.current) {
              setModalTrackTime(modalAudioRef.current.currentTime);
            }
          }}
          onLoadedMetadata={() => {
            if (modalAudioRef.current) {
              setModalTrackDuration(modalAudioRef.current.duration);
              // An import listed without its length: the panel records it (the database and the list).
              const track = tracks.find(t => t.id === playingTrackId);
              if (playingTrackSource === 'uploads' && track && !track.duration) {
                onDurationKnown(track.id, Math.round(modalAudioRef.current.duration));
              }
            }
          }}
          onEnded={() => setPlayingTrackId(null)}
        />
      </div>
    </div>
  );
};
