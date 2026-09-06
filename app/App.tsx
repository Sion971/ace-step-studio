import React, { useState, useEffect, useRef, useCallback } from 'react';

// Vue affichée au lancement, quand aucune route n'est demandée.
// `true` : le profil de l'utilisateur. `false` : le panneau Créer.
const OPEN_ON_PROFILE = true;
import { Sidebar } from './components/Sidebar';
import { CreatePanel } from './components/CreatePanel'; // <-- Ajout des accolades {}
import { SongList } from './components/SongList';
import { RightSidebar } from './components/RightSidebar';
import { Player } from './components/Player';
import { LibraryView } from './components/LibraryView';
import { CreatePlaylistModal, AddToPlaylistModal } from './components/PlaylistModals';
import { VideoGeneratorModal } from './components/VideoGeneratorModal';
import { CoverRegenModal } from './components/CoverRegenModal';
import { UsernameModal } from './components/UsernameModal';
import { UserProfile } from './components/UserProfile';
import { SettingsModal } from './components/SettingsModal';
import { SongProfile } from './components/SongProfile';
import { Song, GenerationParams, View, Playlist } from './types';
// Resizable panel hook
function useResizablePanel(key: string, defaultWidth: number, min: number, max: number, direction: 'left' | 'right' = 'left') {
  const [width, setWidth] = React.useState(() => {
    const saved = localStorage.getItem(`panel-${key}`);
    return saved ? Number(saved) : defaultWidth;
  });

  const onMouseDown = React.useCallback((e: React.MouseEvent) => {
    const startX = e.clientX;
    const startW = width;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMouseMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      const newW = Math.min(max, Math.max(min, startW + (direction === 'left' ? delta : -delta)));
      setWidth(newW);
    };
    const onMouseUp = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      const finalW = Math.min(max, Math.max(min, startW + (direction === 'left' ? delta : -delta)));
      localStorage.setItem(`panel-${key}`, String(finalW));
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [width, key, min, max, direction]);

  const handle = (
    <div
      onMouseDown={onMouseDown}
      className="hidden md:flex w-[5px] flex-shrink-0 items-center justify-center cursor-col-resize group z-20 relative bg-zinc-200/50 dark:bg-zinc-800 hover:bg-pink-500/30 transition-colors"
    >
      <div className="w-[3px] h-10 rounded-full bg-zinc-400/30 dark:bg-zinc-600/50 group-hover:bg-pink-500 transition-colors" />
    </div>
  );

  return { width, handle };
}
import { generateApi, songsApi, playlistsApi, getAudioUrl, getCoverUrl } from './services/api';
import { useAuth } from './context/AuthContext';
import { useResponsive } from './context/ResponsiveContext';
import { I18nProvider, useI18n } from './context/I18nContext';
import { List, GraduationCap } from 'lucide-react';
import { PlaylistDetail } from './components/PlaylistDetail';
import { Toast, ToastType } from './components/Toast';
import { SearchPage } from './components/SearchPage';
import { TrainingPanel } from './components/TrainingPanel';
import { ToolsPanel } from './components/ToolsPanel';
import { NewsPage } from './components/NewsPage';
import { ConfirmDialog } from './components/ConfirmDialog';


function AppContent() {
  // i18n
  const { t } = useI18n();

  // Responsive
  const { isMobile, isDesktop } = useResponsive();

  // Auth
  const { user, token, isAuthenticated, isLoading: authLoading, setupUser, logout } = useAuth();
  const leftPanel = useResizablePanel('create', 420, 320, 600);
  const rightPanel = useResizablePanel('details', 400, 320, 600, 'right');
  const [showUsernameModal, setShowUsernameModal] = useState(false);
  // Track multiple concurrent generation jobs
  const activeJobsRef = useRef<Map<string, { tempId: string; pollInterval: ReturnType<typeof setInterval> }>>(new Map());
  const [activeJobCount, setActiveJobCount] = useState(0);

  // FIFO drain barrier — handlers awaiting it block until the active-jobs
  // queue is empty. Used by CreatePanel to chain LLM pre-flight calls behind
  // the previous track's full completion (LLM + audio + cover) — that's the
  // user's "queue" mental model: gen N+1 starts only after gen N is done.
  const queueDrainResolversRef = useRef<Array<() => void>>([]);
  const waitForJobsToDrain = useCallback((): Promise<void> => {
    if (activeJobsRef.current.size === 0) return Promise.resolve();
    return new Promise((resolve) => {
      queueDrainResolversRef.current.push(resolve);
    });
  }, []);
  const drainQueueWaiters = useCallback(() => {
    if (activeJobsRef.current.size !== 0) return;
    const waiters = queueDrainResolversRef.current;
    queueDrainResolversRef.current = [];
    waiters.forEach((r) => r());
  }, []);

  // "Pending click" counter — bumped synchronously the moment the user
  // clicks Создать, so the button shows N/10 instantly even before the LLM
  // pre-flight completes. Decremented when the click hands off to a real
  // active job (beginPollingJob has registered it in activeJobsRef).
  const [pendingClickCount, setPendingClickCount] = useState(0);
  const incrementPendingClicks = useCallback((n = 1) => setPendingClickCount(c => c + n), []);

  // Pre-flight AbortController registry, keyed by the placeholder card's
  // tempId. CreatePanel registers a controller right before it starts the
  // OpenRouter pre-flight call; the cancel buttons (single + cancel-all)
  // pull from here to actually abort the in-flight HTTP request, otherwise
  // the user's only escape is reloading the page (the Promise chain that
  // park clicks via `waitForJobsToDrain` doesn't have an abort path of
  // its own — see handoff "Open issue #1").
  const preflightAbortersRef = useRef<Map<string, AbortController>>(new Map());
  const registerPreflightAbort = useCallback((tempId: string, ac: AbortController) => {
    preflightAbortersRef.current.set(tempId, ac);
  }, []);
  const unregisterPreflightAbort = useCallback((tempId: string) => {
    preflightAbortersRef.current.delete(tempId);
  }, []);
  const decrementPendingClicks = useCallback((n = 1) => setPendingClickCount(c => Math.max(0, c - n)), []);

  // Instant temp-song factory — called from CreatePanel at click time so the
  // user sees a card in the list IMMEDIATELY, then it's promoted with real
  // data when LLM pre-flight + POST complete. Returns the tempId so the
  // caller can stash it on the eventual `onGenerate` payload (`_tempId`).
const createTempSongForClick = useCallback((descriptionPreview: string, ditModel?: string): string => {
    const tempId = `temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const tempSong: Song = {
      id: tempId,
      title: descriptionPreview.slice(0, 60) || (t('generating') || 'Generating…'),
      lyrics: '',
      style: '',
      coverUrl: getCoverUrl(tempId),
      duration: '--:--',
      createdAt: new Date(),
      isGenerating: true,
      // Renseigné dès la création : sans lui la carte affiche « Unknown »
      // alors que l'utilisateur est connu côté client.
      creator: user?.username,
      // Le modèle est connu de CreatePanel au moment du clic ; sans lui la
      // carte affiche le repli « XL » de getModelDisplayName.
      ditModel,
      // Use the i18n key — SongList renders via t(song.stage) || song.stage.
      stage: 'stageWaitingInQueue',
      tags: ['queued'],
      isPublic: true,
    };
    setSongs(prev => [tempSong, ...prev]);
    return tempId;
  }, [t, user]);

  // Update placeholder fields as LLM streams data, e.g. style/lyrics.
  const updateTempSongForClick = useCallback((tempId: string, patch: Partial<Song>) => {
    setSongs(prev => prev.map(s => s.id === tempId ? { ...s, ...patch } : s));
  }, []);

  // Failure path — drop the placeholder so the user doesn't see a stuck "Queued…"
  // BUT only if the card is still a placeholder (no `jobId` yet). Once App.tsx
  // handleGenerate has POSTed and beginPollingJob set jobId on the song, the
  // card represents a real running backend job — wiping it would leave the
  // user with audio gen running invisibly. Skip in that case.
  const removeTempSongForClick = useCallback((tempId: string) => {
    setSongs(prev => prev.filter(s => {
      if (s.id !== tempId) return true;
      // Promoted to active job → keep
      if (s.jobId) return true;
      return false;
    }));
  }, []);

  // Theme State
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    const stored = localStorage.getItem('theme');
    if (stored === 'dark' || stored === 'light') return stored;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });

  // Navigation State - default to create view
  const [currentView, setCurrentView] = useState<View>('create');

  // Content State
  const [songs, setSongs] = useState<Song[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  // Separation par type (voir migration_playlists_kind.sql) : `kind` absent
  // = ligne anterieure a la migration, toujours traitee comme 'playlist',
  // jamais comme 'workspace' par defaut. Recalcule a chaque rendu — les
  // tableaux sont petits (playlists d'un seul utilisateur), pas besoin de
  // useMemo ici.
  const regularPlaylists = playlists.filter(p => p.kind !== 'workspace');
  const workspaces = playlists.filter(p => p.kind === 'workspace');
  const [likedSongIds, setLikedSongIds] = useState<Set<string>>(new Set());
  const [referenceTracks, setReferenceTracks] = useState<ReferenceTrack[]>([]);
  const [playQueue, setPlayQueue] = useState<Song[]>([]);
  const [queueIndex, setQueueIndex] = useState(-1);

  // Selection State
  const [currentSong, setCurrentSong] = useState<Song | null>(null);
  const [selectedSong, setSelectedSong] = useState<Song | null>(null);
  const [selectedPlaylist, setSelectedPlaylist] = useState<Playlist | null>(null);

  // Player State
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(() => {
    const stored = localStorage.getItem('volume');
    return stored ? parseFloat(stored) : 0.8;
  });
  const [playbackRate, setPlaybackRate] = useState(1.0);
  const [isShuffle, setIsShuffle] = useState(false);
  const [repeatMode, setRepeatMode] = useState<'none' | 'all' | 'one'>('all');

  // UI State
  const [isGenerating, setIsGenerating] = useState(false);
  const [showRightSidebar, setShowRightSidebar] = useState(false);
  // Espace de travail actif dans l'onglet Creer (voir handleSelectWorkspace).
  // null = aucun filtre, la liste affiche tout comme avant.
  const [activeWorkspaceFilter, setActiveWorkspaceFilter] = useState<Playlist | null>(null);
  // Identifiants reellement charges pour cet espace — separes de
  // activeWorkspaceFilter car GET /playlists (liste) ne renvoie qu'un
  // COUNT, jamais les chansons elles-memes (verifie dans playlists.ts
  // cote serveur). Il faut un appel a GET /playlists/:id au moment du
  // clic pour obtenir la vraie liste, d'ou cet etat asynchrone distinct.
  const [activeWorkspaceSongIds, setActiveWorkspaceSongIds] = useState<Set<string> | null>(null);
  // Union des chansons appartenant a N'IMPORTE QUEL espace de travail —
  // permet a la vue par defaut ("Mon espace de travail", virtuel, aucune
  // ligne en base — voir session du 25/08/2026) d'exclure tout ce qui est
  // deja range dans un espace nomme. Rafraichie au chargement et apres
  // chaque ajout/suppression d'une chanson dans un espace.
  const [songsInAnyWorkspace, setSongsInAnyWorkspace] = useState<Set<string>>(new Set());

  const refreshWorkspaceSongIds = useCallback(async () => {
    if (!token) return;
    try {
      const res = await playlistsApi.getWorkspaceSongIds(token);
      setSongsInAnyWorkspace(new Set(res.songIds));
    } catch (e) {
      console.error('Failed to refresh workspace song ids:', e);
    }
  }, [token]);

  useEffect(() => {
    refreshWorkspaceSongIds();
  }, [refreshWorkspaceSongIds]);
  // Sur quel onglet LibraryView doit s'ouvrir au prochain rendu — permet a
  // App.tsx de "viser" un onglet precis avant de naviguer vers 'library'
  // (ex: revenir sur "Espaces de travail" plutot que retomber sur "Tous").
  // LibraryView est demonte/remonte a chaque changement de currentView (le
  // switch/case ne fait pas que masquer/afficher), donc initialiser son
  // useState local depuis cette prop fonctionne de facon fiable.
  const [libraryInitialTab, setLibraryInitialTab] = useState<'all' | 'workspaces' | 'playlists' | 'liked' | 'uploads'>('all');
  const [showLeftSidebar, setShowLeftSidebar] = useState(true);
  const [pendingAudioSelection, setPendingAudioSelection] = useState<{ target: 'reference' | 'source'; url: string; title?: string } | null>(null);

  // Mobile UI Toggle
  const [mobileShowList, setMobileShowList] = useState(false);

  // Modals
  const [isCreatePlaylistModalOpen, setIsCreatePlaylistModalOpen] = useState(false);
  // Quel type creer au prochain passage dans createPlaylist() — le MEME
  // modal sert aux deux flux (playlist classique / espace de travail),
  // seul ce marqueur change selon le bouton qui a ouvert le modal.
  const [creatingPlaylistKind, setCreatingPlaylistKind] = useState<'playlist' | 'workspace'>('playlist');
  // Quelle liste montrer dans AddToPlaylistModal — reutilise le MEME modal
  // pour les deux, distingue seulement le contenu affiche et le type cree
  // si l'utilisateur clique "creer une nouvelle" depuis l'interieur.
  const [addingToKind, setAddingToKind] = useState<'playlist' | 'workspace'>('playlist');
  const [isAddToPlaylistModalOpen, setIsAddToPlaylistModalOpen] = useState(false);
  const [songToAddToPlaylist, setSongToAddToPlaylist] = useState<Song | null>(null);

  // Video Modal
  const [isVideoModalOpen, setIsVideoModalOpen] = useState(false);
  const [songForVideo, setSongForVideo] = useState<Song | null>(null);

  // Cover regen modal — manual Pollinations / upload entry from SongList row
  // and RightSidebar. Updates songs.cover_url via /api/songs/:id/regen-cover.
  const [songForCoverRegen, setSongForCoverRegen] = useState<Song | null>(null);

  // Settings Modal
  const [showSettingsModal, setShowSettingsModal] = useState(false);

  // Profile View
  const [viewingUsername, setViewingUsername] = useState<string | null>(null);

  // Song View
  const [viewingSongId, setViewingSongId] = useState<string | null>(null);

  // Playlist View
  const [viewingPlaylistId, setViewingPlaylistId] = useState<string | null>(null);

  // Reuse State
  const [reuseData, setReuseData] = useState<{ song: Song, timestamp: number } | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const selectedSongRef = useRef<Song | null>(null);
  const currentSongIdRef = useRef<string | null>(null);
  const pendingSeekRef = useRef<number | null>(null);
  const playNextRef = useRef<() => void>(() => {});

  // Mobile Details Modal State
  const [showMobileDetails, setShowMobileDetails] = useState(false);

  // Toast State
  const [toast, setToast] = useState<{ message: string; type: ToastType; isVisible: boolean }>({
    message: '',
    type: 'success',
    isVisible: false,
  });

  // Confirm Dialog State
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string;
    message: string;
    onConfirm: () => void;
  } | null>(null);

  interface ReferenceTrack {
    id: string;
    filename: string;
    storage_key: string;
    duration: number | null;
    file_size_bytes: number | null;
    tags: string[] | null;
    created_at: string;
    audio_url: string;
  }

  const showToast = (message: string, type: ToastType = 'success') => {
    setToast({ message, type, isVisible: true });
  };

  const closeToast = () => {
    setToast(prev => ({ ...prev, isVisible: false }));
  };

  // Show username modal if not authenticated and not loading
  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      setShowUsernameModal(true);
    }
  }, [authLoading, isAuthenticated]);

  // Load Playlists
  useEffect(() => {
    if (token) {
      playlistsApi.getMyPlaylists(token)
        .then(res => setPlaylists(res.playlists))
        .catch(err => console.error('Failed to load playlists', err));
    } else {
      setPlaylists([]);
    }
  }, [token]);

  // Keep selectedSongRef in sync for use in callbacks without stale closures
  useEffect(() => { selectedSongRef.current = selectedSong; }, [selectedSong]);

  // Cleanup active jobs on unmount
  useEffect(() => {
    return () => {
      // Clear all polling intervals when component unmounts
      activeJobsRef.current.forEach(({ pollInterval }) => {
        clearInterval(pollInterval);
      });
      activeJobsRef.current.clear();
    };
  }, []);

  const handleShowDetails = (song: Song) => {
    setSelectedSong(song);
    setShowMobileDetails(true);
  };

  // Reuse Handler
  const handleReuse = (song: Song) => {
    setReuseData({ song, timestamp: Date.now() });
    setCurrentView('create');
    setMobileShowList(false);
  };

  // Song Update Handler
  const handleSongUpdate = (updatedSong: Song) => {
    setSongs(prev => prev.map(s => s.id === updatedSong.id ? updatedSong : s));
    if (currentSong?.id === updatedSong.id) {
      setCurrentSong(updatedSong);
    }
    if (selectedSong?.id === updatedSong.id) {
      setSelectedSong(updatedSong);
    }
  };

  // Navigate to Profile Handler
  const handleNavigateToProfile = (username: string) => {
    setViewingUsername(username);
    setCurrentView('profile');
    window.history.pushState({}, '', `/@${username}`);
  };

  // Back from Profile Handler
  const handleBackFromProfile = () => {
    setViewingUsername(null);
    setCurrentView('create');
    window.history.pushState({}, '', '/');
  };

  // Navigate to Song Handler
  const handleNavigateToSong = (songId: string) => {
    setViewingSongId(songId);
    setCurrentView('song');
    window.history.pushState({}, '', `/song/${songId}`);
  };

  // Back from Song Handler
  const handleBackFromSong = () => {
    setViewingSongId(null);
    setCurrentView('create');
    window.history.pushState({}, '', '/');
  };

  // Theme Effect
  useEffect(() => {
    localStorage.setItem('theme', theme);
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [theme]);

  const toggleTheme = () => {
    setTheme(prev => prev === 'dark' ? 'light' : 'dark');
  };

  // URL Routing Effect
  useEffect(() => {
    const handleUrlChange = () => {
      const path = window.location.pathname;
      const params = new URLSearchParams(window.location.search);

      // Handle ?song= query parameter
      const songParam = params.get('song');
      if (songParam) {
        setViewingSongId(songParam);
        setCurrentView('song');
        window.history.replaceState({}, '', `/song/${songParam}`);
        return;
      }

      if (path === '/create' || path === '/') {
        setCurrentView('create');
        setMobileShowList(false);
      } else if (path === '/library') {
        setCurrentView('library');
      } else if (path.startsWith('/@')) {
        const username = path.substring(2);
        if (username) {
          setViewingUsername(username);
          setCurrentView('profile');
        }
      } else if (path.startsWith('/song/')) {
        const songId = path.substring(6);
        if (songId) {
          setViewingSongId(songId);
          setCurrentView('song');
        }
      } else if (path.startsWith('/playlist/')) {
        const playlistId = path.substring(10);
        if (playlistId) {
          setViewingPlaylistId(playlistId);
          setCurrentView('playlist');
        }
      } else if (path === '/search') {
        setCurrentView('search');
      } else if (path === '/news') {
        setCurrentView('news');
      }
    };

    handleUrlChange();

    window.addEventListener('popstate', handleUrlChange);
    return () => window.removeEventListener('popstate', handleUrlChange);
  }, []);

  // Ouverture par défaut sur le profil de l'utilisateur.
  //
  // Ne s'applique QU'À la racine (`/`) : toute autre route a été demandée
  // explicitement — lien partagé, rechargement sur /library — et doit être
  // respectée. Attend la fin du chargement de l'auth, sinon le nom
  // d'utilisateur n'est pas encore connu et la redirection viserait `/@`.
  // Le drapeau évite de ramener l'utilisateur au profil s'il navigue ailleurs
  // pendant que l'auth se résout.
  const landedOnProfileRef = useRef(false);
  useEffect(() => {
    if (!OPEN_ON_PROFILE) return;
    if (landedOnProfileRef.current) return;
    if (authLoading) return;
    if (window.location.pathname !== '/') return;
    if (!user?.username) return;   // non connecté : on reste sur Créer
    landedOnProfileRef.current = true;
    setViewingUsername(user.username);
    setCurrentView('profile');
    window.history.replaceState({}, '', `/@${user.username}`);
  }, [authLoading, user]);

  // Load Songs Effect
  useEffect(() => {
    if (!isAuthenticated || !token) return;

    const loadSongs = async () => {
      try {
        const mapSong = (s: any): Song => ({
          id: s.id,
          title: s.title,
          lyrics: s.lyrics,
          style: s.style,
          // Prefer the real cover saved by the audio-gen pipeline (Pollinations).
          // Fallback vers une pochette generee localement pour les
          // chansons sans cover_url (voir getCoverUrl dans services/api.ts).
          coverUrl: s.cover_url || s.coverUrl || getCoverUrl(s.id),
          duration: s.duration && s.duration > 0 ? `${Math.floor(s.duration / 60)}:${String(Math.floor(s.duration % 60)).padStart(2, '0')}` : '0:00',
          createdAt: new Date(s.created_at || s.createdAt),
          tags: s.tags || [],
          audioUrl: getAudioUrl(s.audio_url, s.id),
          isPublic: s.is_public,
          likeCount: s.like_count || 0,
          viewCount: s.view_count || 0,
          userId: s.user_id,
          creator: s.creator,
          ditModel: s.dit_model,
          lmModel: s.lm_model,
          lmBackend: s.lm_backend,
          generationTime: s.generation_time,
          lrcContent: s.lrc_content,
          openrouterModel: s.openrouter_model,
          bpm: s.bpm || (s as any).bpm || 0,
          keyScale: s.key_scale || (s as any).keyScale || '',
          timeSignature: s.time_signature || (s as any).timeSignature || '',
          generationParams: (() => {
            try {
              if (!s.generation_params) return undefined;
              return typeof s.generation_params === 'string' ? JSON.parse(s.generation_params) : s.generation_params;
            } catch {
              return undefined;
            }
          })(),
        });

        // Load my songs (always works)
        const mySongsRes = await songsApi.getMySongs(token);
        const mySongs = mySongsRes.songs.map(mapSong);

        // Load liked songs (may fail — don't block)
        let likedSongs: Song[] = [];
        try {
          const likedSongsRes = await songsApi.getLikedSongs(token);
          likedSongs = (likedSongsRes.songs || []).map(mapSong);
        } catch {}

        const songsMap = new Map<string, Song>();
        // Liked first, then my songs overwrite — my songs have full data (lrc, bpm, etc)
        [...likedSongs, ...mySongs].forEach(s => songsMap.set(s.id, s));

        setSongs(prev => {
          const generatingSongs = prev.filter(s => s.isGenerating);
          const loadedSongs = Array.from(songsMap.values());
          return [...generatingSongs, ...loadedSongs];
        });

        const likedIds = new Set(likedSongs.map(s => s.id));
        setLikedSongIds(likedIds);

      } catch (error) {
        console.error('Failed to load songs:', error);
      }
    };

    loadSongs();
  }, [isAuthenticated, token]);

  const loadReferenceTracks = useCallback(async () => {
    if (!isAuthenticated || !token) return;
    try {
      const response = await fetch('/api/reference-tracks', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!response.ok) return;
      const data = await response.json();
      setReferenceTracks(data.tracks || []);
    } catch (error) {
      console.error('Failed to load reference tracks:', error);
    }
  }, [isAuthenticated, token]);

  // Load reference tracks for Library
  useEffect(() => {
    loadReferenceTracks();
  }, [loadReferenceTracks]);

  useEffect(() => {
    if (currentView === 'library') {
      loadReferenceTracks();
    }
  }, [currentView, loadReferenceTracks]);

  // Player Logic
  const getActiveQueue = (song?: Song) => {
    if (playQueue.length > 0) return playQueue;
    if (song && songs.some(s => s.id === song.id)) return songs;
    return songs;
  };

  const playNext = useCallback(() => {
    if (!currentSong) return;
    const queue = getActiveQueue(currentSong);
    if (queue.length === 0) return;

    const currentIndex = queueIndex >= 0 && queue[queueIndex]?.id === currentSong.id
      ? queueIndex
      : queue.findIndex(s => s.id === currentSong.id);
    if (currentIndex === -1) return;

    if (repeatMode === 'one') {
      if (audioRef.current) {
        audioRef.current.currentTime = 0;
        audioRef.current.play();
      }
      return;
    }

    // Find next playable song (has audioUrl and not generating)
    const queueLen = queue.length;
    for (let i = 1; i <= queueLen; i++) {
      let nextIndex;
      if (isShuffle) {
        nextIndex = Math.floor(Math.random() * queueLen);
        if (queueLen > 1 && nextIndex === currentIndex) continue;
      } else {
        nextIndex = currentIndex + i;
        // In 'none' repeat mode, stop at end of queue
        if (repeatMode === 'none' && nextIndex >= queueLen) {
          setIsPlaying(false);
          return;
        }
        nextIndex = nextIndex % queueLen;
      }

      const candidate = queue[nextIndex];
      if (candidate.audioUrl && !candidate.isGenerating) {
        setQueueIndex(nextIndex);
        setCurrentSong(candidate);
        setIsPlaying(true);
        return;
      }
    }

    // No playable songs found
    setIsPlaying(false);
  }, [currentSong, queueIndex, isShuffle, repeatMode, playQueue, songs]);

  const playPrevious = useCallback(() => {
    if (!currentSong) return;
    const queue = getActiveQueue(currentSong);
    if (queue.length === 0) return;

    const currentIndex = queueIndex >= 0 && queue[queueIndex]?.id === currentSong.id
      ? queueIndex
      : queue.findIndex(s => s.id === currentSong.id);
    if (currentIndex === -1) return;

    if (currentTime > 3) {
      if (audioRef.current) audioRef.current.currentTime = 0;
      return;
    }

    // Find previous playable song (has audioUrl and not generating)
    const queueLen = queue.length;
    for (let i = 1; i <= queueLen; i++) {
      let prevIndex;
      if (isShuffle) {
        prevIndex = Math.floor(Math.random() * queueLen);
        if (queueLen > 1 && prevIndex === currentIndex) continue;
      } else {
        prevIndex = currentIndex - i;
        // In 'none' repeat mode, stop at beginning of queue
        if (repeatMode === 'none' && prevIndex < 0) {
          if (audioRef.current) audioRef.current.currentTime = 0;
          return;
        }
        prevIndex = (prevIndex + queueLen) % queueLen;
      }

      const candidate = queue[prevIndex];
      if (candidate.audioUrl && !candidate.isGenerating) {
        setQueueIndex(prevIndex);
        setCurrentSong(candidate);
        setIsPlaying(true);
        return;
      }
    }

    // No playable songs found
    setIsPlaying(false);
  }, [currentSong, queueIndex, currentTime, isShuffle, repeatMode, playQueue, songs]);

  useEffect(() => {
    playNextRef.current = playNext;
  }, [playNext]);

  // Audio Setup
  useEffect(() => {
    audioRef.current = new Audio();
    audioRef.current.crossOrigin = "anonymous";
    const audio = audioRef.current;
    audio.volume = volume;

    const onTimeUpdate = () => setCurrentTime(audio.currentTime);
    const applyPendingSeek = () => {
      if (pendingSeekRef.current === null) return;
      if (audio.seekable.length === 0) return;
      const target = pendingSeekRef.current;
      const safeTarget = Number.isFinite(audio.duration)
        ? Math.min(Math.max(target, 0), audio.duration)
        : Math.max(target, 0);
      audio.currentTime = safeTarget;
      setCurrentTime(safeTarget);
      pendingSeekRef.current = null;
    };

    const onLoadedMetadata = () => {
      setDuration(audio.duration);
      applyPendingSeek();
    };

    const onCanPlay = () => {
      applyPendingSeek();
    };

    const onProgress = () => {
      applyPendingSeek();
    };

    const onEnded = () => {
      playNextRef.current();
    };

    const onError = (e: Event) => {
      if (audio.error && audio.error.code !== 1) {
        console.error("Audio playback error:", audio.error);
        if (audio.error.code === 4) {
          showToast(t('songNotAvailable'), 'error');
        } else {
          showToast(t('unableToPlay'), 'error');
        }
      }
      setIsPlaying(false);
    };

    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('loadedmetadata', onLoadedMetadata);
    audio.addEventListener('canplay', onCanPlay);
    audio.addEventListener('progress', onProgress);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onError);

    return () => {
      audio.pause();
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('loadedmetadata', onLoadedMetadata);
      audio.removeEventListener('canplay', onCanPlay);
      audio.removeEventListener('progress', onProgress);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onError);
    };
  }, []);

  // Handle Playback State
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !currentSong?.audioUrl) return;

    const playAudio = async () => {
      try {
        await audio.play();
      } catch (err) {
        if (err instanceof Error && err.name !== 'AbortError') {
          console.error("Playback failed:", err);
          if (err.name === 'NotSupportedError') {
            showToast(t('songNotAvailable'), 'error');
          }
          setIsPlaying(false);
        }
      }
    };

    if (currentSongIdRef.current !== currentSong.id) {
      currentSongIdRef.current = currentSong.id;
      audio.src = currentSong.audioUrl;
      audio.load();
      if (isPlaying) playAudio();
    } else {
      if (isPlaying) playAudio();
      else audio.pause();
    }
  }, [currentSong, isPlaying]);

  // Handle Volume
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = volume;
    }
    localStorage.setItem('volume', String(volume));
  }, [volume]);

  // Handle Playback Rate
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.playbackRate = playbackRate;
    }
  }, [playbackRate]);

  // Spacebar play/pause
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target as HTMLElement)?.isContentEditable) return;
      e.preventDefault();
      if (currentSong) {
        if (currentSong.audioUrl) {
          setIsPlaying(prev => !prev);
        }
      } else {
        // No song selected — play first available
        const available = songs.filter(s => s.audioUrl && !s.isGenerating);
        if (available.length > 0) {
          playSong(available[0], available);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentSong, songs]);

  // Helper to cleanup a job and check if all jobs are done
  const cleanupJob = useCallback((jobId: string, tempId: string) => {
    const jobData = activeJobsRef.current.get(jobId);
    if (jobData) {
      clearInterval(jobData.pollInterval);
      activeJobsRef.current.delete(jobId);
    }

    // Remove temp song
    setSongs(prev => prev.filter(s => s.id !== tempId));

    // Update active job count
    setActiveJobCount(activeJobsRef.current.size);

    // If no more active jobs, set isGenerating to false
    if (activeJobsRef.current.size === 0) {
      setIsGenerating(false);
    }
    drainQueueWaiters();
  }, []);

  // Cancel a single generation. The `id` may be either:
  //  - a backend jobId (track is past pre-flight, audio gen is running) → POST /cancel
  //  - a pre-flight tempId (still in OpenRouter LLM call, no jobId yet)  → abort the
  //    registered AbortController, drop the placeholder card, release slot
  //
  // We unify both paths under one handler because the SongList row only knows
  // `song.id` (= tempId) and `song.jobId`; a pre-flight card has tempId but
  // no jobId, so the cancel button passes whatever it has and we figure it
  // out here.
  const cancelGeneration = useCallback(async (id: string) => {
    if (!token) return;

    // First check: is this a pre-flight tempId? If so, abort and bail —
    // there's no backend job yet to call /cancel on.
    const preflightAc = preflightAbortersRef.current.get(id);
    if (preflightAc) {
      preflightAc.abort();
      preflightAbortersRef.current.delete(id);
      // Mark the placeholder as cancelled so the user can hit Reset (X)
      // to remove it. Same pattern as the audio-cancel branch below.
      setSongs(prev => prev.map(s =>
        s.id === id ? { ...s, isGenerating: false, stage: 'cancelled' } : s
      ));
      // Release the slot the click claimed; without this the N/10 badge
      // stays inflated.
      decrementPendingClicks(1);
      // Wake any other parked pre-flight in the FIFO chain so it can take
      // its turn. The chain itself doesn't re-enter `waitForJobsToDrain`
      // for the same click, but other queued clicks may be waiting.
      drainQueueWaiters();
      return;
    }

    // Otherwise treat as a backend jobId.
    try {
      await fetch(`/api/generate/cancel/${id}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch { /* ignore */ }

    // Stop polling but keep the card (user can click "Reset" next).
    // Remove the job from activeJobsRef so waitForJobsToDrain can resolve;
    // without this, the cancelled job sits there forever blocking every
    // subsequent click's pre-flight from starting.
    const jobData = activeJobsRef.current.get(id);
    if (jobData) {
      clearInterval(jobData.pollInterval);
      activeJobsRef.current.delete(id);
      setActiveJobCount(activeJobsRef.current.size);
      if (activeJobsRef.current.size === 0) setIsGenerating(false);
      drainQueueWaiters();
      // Mark song as cancelled (not generating, show reset option)
      setSongs(prev => prev.map(s =>
        s.id === jobData.tempId ? { ...s, isGenerating: false, stage: 'cancelled' } : s
      ));
    }
  }, [token, drainQueueWaiters, decrementPendingClicks]);

  // Reset a single job — hard cancel (interrupt Gradio GPU + remove card).
  // `id` may be either a backend jobId or a pre-flight tempId (placeholder
  // that was already cancelled at pre-flight time and now sits with stage
  // 'cancelled'). Pre-flight reset is just card removal — there's no GPU
  // job to interrupt.
  const resetSingleJob = useCallback(async (id: string) => {
    if (!token) return;

    const jobData = activeJobsRef.current.get(id);

    // Pre-flight tempId path — no Gradio call, just drop the card.
    if (!jobData) {
      // Defensive: if the placeholder still has an aborter (user clicks
      // Reset on a card that was never cancelled), abort it now.
      const ac = preflightAbortersRef.current.get(id);
      if (ac) {
        ac.abort();
        preflightAbortersRef.current.delete(id);
      }
      setSongs(prev => prev.filter(s => s.id !== id));
      drainQueueWaiters();
      return;
    }

    // Real-job path — send cancel to Gradio to interrupt diffusion
    try {
      await fetch('/api/generate/reset', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch { /* ignore */ }

    activeJobsRef.current.delete(id);
    setSongs(prev => prev.filter(s => s.id !== jobData.tempId));
    setActiveJobCount(activeJobsRef.current.size);
    if (activeJobsRef.current.size === 0) {
      setIsGenerating(false);
    }
    // Wake parked pre-flight clicks — without this the FIFO chain hangs
    // forever and the next click never fires its LLM.
    drainQueueWaiters();
  }, [token, drainQueueWaiters]);

  // Cancel all generation jobs
  const cancelAllGenerations = useCallback(async () => {
    if (!token) return;
    try {
      await fetch('/api/generate/cancel-all', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch { /* ignore */ }

    // Abort every in-flight pre-flight LLM call. Without this, an
    // OpenRouter request that's already 15 s into its 60 s response
    // would still complete after Cancel-all, fire `onGenerate`, and spawn
    // a new audio job — i.e. cancel-all wouldn't actually cancel.
    preflightAbortersRef.current.forEach(ac => ac.abort());
    preflightAbortersRef.current.clear();

    // Clean up all active jobs
    activeJobsRef.current.forEach(({ tempId, pollInterval }) => {
      clearInterval(pollInterval);
    });
    const tempIds = new Set([...activeJobsRef.current.values()].map(j => j.tempId));
    activeJobsRef.current.clear();
    // Drop both active-job placeholders AND any pre-flight cards still in
    // the songs[] (they have isGenerating=true but no jobId yet — match by
    // `isGenerating && !jobId` so we don't accidentally remove songs that
    // legitimately just finished).
    setSongs(prev => prev.filter(s => !tempIds.has(s.id) && !(s.isGenerating && !s.jobId)));
    setActiveJobCount(0);
    setIsGenerating(false);
    // Wake up any pre-flight clicks that were waiting for this drained queue.
    // Without this, after cancel-all the FIFO chain stays parked forever and
    // the next click hangs on waitForJobsToDrain → no LLM ever fires.
    drainQueueWaiters();
    // Reset the visual click-pending counter too — same reasoning.
    setPendingClickCount(0);
  }, [token, drainQueueWaiters]);

  // Hard reset — cancel + interrupt GPU generation
  const resetGeneration = useCallback(async () => {
    if (!token) return;
    try {
      await fetch('/api/generate/reset', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch { /* ignore */ }

    // Abort every in-flight pre-flight LLM call (same reason as in
    // cancelAllGenerations — without this, the OR request keeps running
    // and would spawn a new audio job after Reset-all).
    preflightAbortersRef.current.forEach(ac => ac.abort());
    preflightAbortersRef.current.clear();

    // Clean up all active jobs
    activeJobsRef.current.forEach(({ tempId, pollInterval }) => {
      clearInterval(pollInterval);
    });
    const tempIds = new Set([...activeJobsRef.current.values()].map(j => j.tempId));
    activeJobsRef.current.clear();
    // Drop active-job placeholders AND any pre-flight cards (no jobId yet).
    setSongs(prev => prev.filter(s => !tempIds.has(s.id) && !(s.isGenerating && !s.jobId)));
    setActiveJobCount(0);
    setIsGenerating(false);
    // Mirror cancelAllGenerations: wake parked pre-flight clicks and reset the
    // visual click-pending counter. Without this, after Reset-all the FIFO
    // chain stays parked forever and the next click hangs on
    // waitForJobsToDrain → no LLM ever fires; the N/10 badge also gets stuck
    // showing whatever pendingClickCount was at the moment of reset.
    drainQueueWaiters();
    setPendingClickCount(0);
  }, [token, drainQueueWaiters]);

  // Refresh songs list (called when any job completes successfully)
  const refreshSongsList = useCallback(async () => {
    if (!token) return;
    try {
      const response = await songsApi.getMySongs(token);
      const loadedSongs: Song[] = response.songs.map(s => ({
        id: s.id,
        title: s.title,
        lyrics: s.lyrics,
        style: s.style,
        // Prefer real cover saved by Pollinations integration.
        coverUrl: (s as any).cover_url || (s as any).coverUrl || getCoverUrl(s.id),
        duration: s.duration && s.duration > 0 ? `${Math.floor(s.duration / 60)}:${String(Math.floor(s.duration % 60)).padStart(2, '0')}` : '0:00',
        createdAt: new Date(s.created_at),
        tags: s.tags || [],
        audioUrl: getAudioUrl(s.audio_url, s.id),
        isPublic: s.is_public,
        likeCount: s.like_count || 0,
        viewCount: s.view_count || 0,
        userId: s.user_id,
        creator: s.creator,
        ditModel: s.dit_model || s.ditModel,
        lmModel: s.lm_model || s.lmModel,
        lmBackend: s.lm_backend || s.lmBackend,
        generationTime: s.generation_time || s.generationTime,
        lrcContent: s.lrc_content || s.lrcContent,
        openrouterModel: s.openrouter_model || s.openrouterModel,
        bpm: s.bpm || (s as any).bpm || 0,
        keyScale: s.key_scale || (s as any).keyScale || '',
        timeSignature: s.time_signature || (s as any).timeSignature || '',
        generationParams: (() => {
          try {
            if (!s.generation_params) return undefined;
            return typeof s.generation_params === 'string' ? JSON.parse(s.generation_params) : s.generation_params;
          } catch {
            return undefined;
          }
        })(),
      }));

      // Preserve any generating songs that aren't in the loaded list
      setSongs(prev => {
        // Keep only generating songs that aren't in the loaded list
        const stillGenerating = prev.filter(s => s.isGenerating && !loadedSongs.some(l => l.id === s.id));
        const mergedSongs = [...stillGenerating, ...loadedSongs];
        // Sort by creation date, newest first. Defensif : un objet chanson
        // construit ailleurs (ex. PlaylistDetail.tsx avant correctif) peut
        // avoir createdAt manquant/invalide — on le traite comme "le plus
        // ancien" plutot que de planter tout le rendu (voir le crash
        // "createdAt is undefined" en passant de Playlist a Creer).
        const time = (s: Song) => {
          const t = s.createdAt?.getTime?.();
          return Number.isFinite(t) ? t! : 0;
        };
        return mergedSongs.sort((a, b) => time(b) - time(a));
      });

      // If the current selection was a temp/generating song, replace it with newest real song
      const current = selectedSongRef.current;
      if (current?.isGenerating || (current && !loadedSongs.some(s => s.id === current.id))) {
        setSelectedSong(loadedSongs[0] ?? null);
      }
    } catch (error) {
      console.error('Failed to refresh songs:', error);
    }
  }, [token]);

  const beginPollingJob = useCallback((jobId: string, tempId: string) => {
    if (!token) return;
    if (activeJobsRef.current.has(jobId)) return;

    const pollInterval = setInterval(async () => {
      try {
        const status = await generateApi.getStatus(jobId, token);
        const normalizedProgress = Number.isFinite(Number(status.progress))
          ? (Number(status.progress) > 1 ? Number(status.progress) / 100 : Number(status.progress))
          : undefined;

        setSongs(prev => {
          const song = prev.find(s => s.id === tempId);
          if (!song) return prev;
          const newQueuePos = status.status === 'queued' ? status.queuePosition : undefined;
          const newProgress = normalizedProgress ?? song.progress;
          const newStage = status.stage ?? song.stage;
          // Skip update if nothing changed to avoid unnecessary re-renders
          if (newProgress === song.progress && newStage === song.stage && newQueuePos === song.queuePosition) {
            return prev;
          }
          return prev.map(s => {
            if (s.id !== tempId) return s;
            return { ...s, queuePosition: newQueuePos, progress: newProgress, stage: newStage };
          });
        });

        if (status.status === 'succeeded' && status.result) {
          cleanupJob(jobId, tempId);
          await refreshSongsList();

          if (window.innerWidth < 768) {
            setMobileShowList(true);
          }
        } else if (status.status === 'failed') {
          cleanupJob(jobId, tempId);
          console.error(`Job ${jobId} failed:`, status.error);
          const err = status.error || 'Unknown error';
          if (err.includes('VRAM') || err.includes('Insufficient free')) {
            showToast(t('vramError') || 'Not enough GPU VRAM. Reduce duration, batch size, or switch to a lighter model.', 'error');
          } else {
            showToast(`${t('generationFailed')}: ${err}`, 'error');
          }
        }
      } catch (pollError) {
        console.error(`Polling error for job ${jobId}:`, pollError);
        cleanupJob(jobId, tempId);
      }
    }, 2000);

    activeJobsRef.current.set(jobId, { tempId, pollInterval });
    setActiveJobCount(activeJobsRef.current.size);
    // No client-side timeout — backend reports status='failed' if something goes wrong.
    // Long generations (XL SFT 50 steps, batch, covers) can take 15+ minutes legitimately.
  }, [token, cleanupJob, refreshSongsList]);

  const buildTempSongFromParams = (params: GenerationParams, tempId: string, createdAt?: string) => ({
    id: tempId,
    title: params.title || t('generating') || 'Generating...',
    lyrics: '',
    style: params.style || params.songDescription || '',
    coverUrl: getCoverUrl(tempId),
    duration: '--:--',
    createdAt: createdAt ? new Date(createdAt) : new Date(),
    isGenerating: true,
    tags: params.customMode ? ['custom'] : ['simple'],
    isPublic: true,
  });

  // Handlers
  const handleGenerate = async (params: GenerationParams) => {
    if (!isAuthenticated || !token) {
      // CreatePanel pre-allocated a placeholder card + bumped pendingClickCount
      // before calling onGenerate. If we bail here without cleanup, the card
      // sticks around as a ghost (no jobId, never promoted) and the N/10 badge
      // stays inflated by 1 until reload.
      if (params._tempId) {
        setSongs(prev => prev.filter(s => s.id !== params._tempId));
      }
      decrementPendingClicks(1);
      setShowUsernameModal(true);
      return;
    }

    setIsGenerating(true);
    setCurrentView('create');
    setMobileShowList(false);

    // If CreatePanel already created an instant placeholder card via
    // createTempSongForClick (so the user sees something AT click time, not
    // after the 20s LLM pre-flight), reuse that card. Otherwise create one
    // here as before.
    const preCreatedId = params._tempId;
    const tempId = preCreatedId || `temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    if (preCreatedId) {
      // On ne peut PAS lire `songs` (fermeture figee au dernier rendu) pour
      // retrouver la carte que CreatePanel vient de creer juste avant cet
      // appel, dans le meme tick synchrone : React n'a pas encore applique
      // cette mise a jour a la fermeture exterieure au moment ou ce code
      // s'execute (confirme par diagnostic : preCreatedId existe mais
      // songs.find(...) le rate). Le gestionnaire fonctionnel de setSongs,
      // lui, recoit toujours l'etat le plus a jour — on y derive donc la
      // chanson promue, et on appelle setSelectedSong depuis l'interieur.
      setSongs(prev => {
        const next = prev.map(s => s.id === tempId ? {
          ...s,
          title: params.title || s.title,
          style: params.style || s.style,
          tags: params.customMode ? ['custom'] : ['simple'],
          stage: 'stageStartingTrack',
        } : s);
        const promoted = next.find(s => s.id === tempId);
        if (promoted) setSelectedSong(promoted);
        return next;
      });
      setShowRightSidebar(true);
    } else {
      const tempSong: Song = {
        id: tempId,
        title: params.title || t('generating') || 'Generating...',
        lyrics: '',
        style: params.style,
        coverUrl: getCoverUrl(tempId),
        duration: '--:--',
        createdAt: new Date(),
        isGenerating: true,
        tags: params.customMode ? ['custom'] : ['simple'],
        isPublic: true
      };
      setSongs(prev => [tempSong, ...prev]);
      setSelectedSong(tempSong);
      setShowRightSidebar(true);
    }

    try {
      // Simple mode: LLM generates caption + lyrics + metadata from description
      let enrichedParams = { ...params };
      if (!params.customMode && params.songDescription && token) {
        try {
          // Use the i18n KEY here (SongList does t(song.stage)) so the label
          // tracks language switches mid-generation. Storing the resolved
          // string would freeze the label in the locale active at click time.
          setSongs(prev => prev.map(s => s.id === tempId ? { ...s, stage: 'writingLyricsAndStyle' } : s));
          const sample = await generateApi.createSample({
            query: params.songDescription,
            instrumental: params.instrumental,
            vocalLanguage: params.vocalLanguage,
          }, token);
          if (sample.caption) {
            enrichedParams = {
              ...enrichedParams,
              customMode: true,
              style: sample.caption,
              lyrics: sample.lyrics || '',
              instrumental: sample.instrumental,
              vocalLanguage: sample.vocalLanguage || params.vocalLanguage,
              bpm: sample.bpm > 0 ? sample.bpm : undefined,
              duration: sample.duration > 0 ? sample.duration : undefined,
              keyScale: sample.keyScale || undefined,
              timeSignature: sample.timeSignature || undefined,
              thinking: true,
              isFormatCaption: true,
            };
            setSongs(prev => prev.map(s => s.id === tempId ? { ...s, title: String(sample.caption || '').slice(0, 50) || s.title, style: String(sample.caption || '') } : s));
          }
        } catch (err) {
          // create_sample failed — block generation, remove temp song.
          // Release the pending-click slot so the N/10 badge doesn't stick.
          console.error('[Simple] create_sample failed:', err);
          setSongs(prev => prev.filter(s => s.id !== tempId));
          showToast('LLM not available — model may be loading or Gradio restarting. Wait and try again.', 'error');
          setIsGenerating(false);
          decrementPendingClicks(1);
          return;
        }
      }

      const job = await generateApi.startGeneration({
        customMode: enrichedParams.customMode,
        songDescription: enrichedParams.songDescription,
        lyrics: enrichedParams.lyrics,
        style: enrichedParams.style,
        title: enrichedParams.title,
        instrumental: enrichedParams.instrumental,
        vocalLanguage: enrichedParams.vocalLanguage,
        duration: enrichedParams.duration && enrichedParams.duration > 0 ? enrichedParams.duration : undefined,
        bpm: enrichedParams.bpm,
        keyScale: enrichedParams.keyScale,
        timeSignature: enrichedParams.timeSignature,
        inferenceSteps: params.inferenceSteps,
        guidanceScale: params.guidanceScale,
        batchSize: params.batchSize,
        randomSeed: params.randomSeed,
        seed: params.seed,
        thinking: enrichedParams.thinking ?? params.thinking,
        enhance: params.enhance,
        audioFormat: params.audioFormat,
        inferMethod: params.inferMethod,
        shift: params.shift,
        lmTemperature: params.lmTemperature,
        lmCfgScale: params.lmCfgScale,
        lmTopK: params.lmTopK,
        lmTopP: params.lmTopP,
        lmNegativePrompt: params.lmNegativePrompt,
        lmBackend: params.lmBackend,
        lmModel: params.lmModel,
        referenceAudioUrl: params.referenceAudioUrl,
        sourceAudioUrl: params.sourceAudioUrl,
        referenceAudioTitle: params.referenceAudioTitle,
        sourceAudioTitle: params.sourceAudioTitle,
        audioCodes: params.audioCodes,
        repaintingStart: params.repaintingStart,
        repaintingEnd: params.repaintingEnd,
        instruction: params.instruction,
        audioCoverStrength: params.audioCoverStrength,
        taskType: params.taskType,
        useAdg: params.useAdg,
        cfgIntervalStart: params.cfgIntervalStart,
        cfgIntervalEnd: params.cfgIntervalEnd,
        customTimesteps: params.customTimesteps,
        useCotMetas: params.useCotMetas,
        useCotCaption: params.useCotCaption,
        useCotLanguage: params.useCotLanguage,
        autogen: params.autogen,
        constrainedDecodingDebug: params.constrainedDecodingDebug,
        allowLmBatch: params.allowLmBatch,
        getScores: params.getScores,
        getLrc: params.getLrc,
        scoreScale: params.scoreScale,
        lmBatchChunkSize: params.lmBatchChunkSize,
        trackName: params.trackName,
        completeTrackClasses: params.completeTrackClasses,
        isFormatCaption: enrichedParams.isFormatCaption ?? params.isFormatCaption,
        coverNoiseStrength: params.coverNoiseStrength,
        samplerMode: params.samplerMode as 'euler' | 'heun',
        schedulerType: params.schedulerType,
        velocityNormThreshold: params.velocityNormThreshold,
        velocityEmaFactor: params.velocityEmaFactor,
        mp3Bitrate: params.mp3Bitrate,
        mp3SampleRate: params.mp3SampleRate,
        enableNormalization: params.enableNormalization,
        normalizationDb: params.normalizationDb,
        fadeInDuration: params.fadeInDuration,
        fadeOutDuration: params.fadeOutDuration,
        latentShift: params.latentShift,
        latentRescale: params.latentRescale,
        repaintMode: params.repaintMode,
        repaintStrength: params.repaintStrength,
        ditModel: params.ditModel,
        // Fields the CreatePanel customPayload IIFE builds — must be mirrored
        // explicitly here because `generateApi.startGeneration` whitelists the
        // payload and any field not listed is silently dropped.
        prompt: params.prompt,
        dcwEnabled: params.dcwEnabled,
        dcwMode: params.dcwMode,
        dcwScaler: params.dcwScaler,
        dcwHighScaler: params.dcwHighScaler,
        dcwWavelet: params.dcwWavelet,
        retakeSeed: params.retakeSeed,
        retakeVariance: params.retakeVariance,
        flowEditMorph: params.flowEditMorph,
        flowEditSourceCaption: params.flowEditSourceCaption,
        flowEditSourceLyrics: params.flowEditSourceLyrics,
        flowEditNMin: params.flowEditNMin,
        flowEditNMax: params.flowEditNMax,
        flowEditNAvg: params.flowEditNAvg,
        loraLoaded: params.loraLoaded,
        // OpenRouter — model id used for the AI lyric/caption run (persisted on song row).
        openrouterModel: params.openrouterModel,
        // Pollinations.ai cover-gen config — opaque blob mirrored to backend.
        pollinations: params.pollinations,
        // Pre-created placeholder card id (instant feedback at click time).
        _tempId: params._tempId,
      }, token);

      // Store jobId on the temp song so cancel button works
      setSongs(prev => prev.map(s => s.id === tempId ? { ...s, jobId: job.jobId } : s));

      beginPollingJob(job.jobId, tempId);
      // Hand off the click counter to the active counter — keeps the UI badge
      // continuous instead of blinking 1→0→1 between pre-flight and polling.
      decrementPendingClicks(1);

    } catch (e) {
      console.error('Generation error:', e);
      setSongs(prev => prev.filter(s => s.id !== tempId));
      // Failure path: release the pending click slot so the badge accurately
      // reflects "nothing in flight" instead of being stuck.
      decrementPendingClicks(1);

      // Only set isGenerating to false if no other jobs are running
      if (activeJobsRef.current.size === 0) {
        setIsGenerating(false);
      }
      showToast(t('generationFailed'), 'error');
    }
  };

  // Resume active jobs on refresh so progress keeps updating
  useEffect(() => {
    if (!isAuthenticated || !token) return;

    const resumeJobs = async () => {
      try {
        const history = await generateApi.getHistory(token);
        const jobs = Array.isArray(history.jobs) ? history.jobs : [];

        const activeStatuses = new Set(['pending', 'queued', 'running']);
        const jobsToResume = jobs.filter((job: any) => activeStatuses.has(job.status));

        if (jobsToResume.length === 0) return;

        setSongs(prev => {
          const existingIds = new Set(prev.map(s => s.id));
          const next = [...prev];

          for (const job of jobsToResume) {
            const jobId = job.id || job.jobId;
            if (!jobId) continue;
            const tempId = `job_${jobId}`;
            if (existingIds.has(tempId)) continue;

            const params = (() => {
              try {
                if (!job.params) return {};
                return typeof job.params === 'string' ? JSON.parse(job.params) : job.params;
              } catch {
                return {};
              }
            })();

            next.unshift(buildTempSongFromParams(params, tempId, job.created_at));
            existingIds.add(tempId);
          }
          return next;
        });

        for (const job of jobsToResume) {
          const jobId = job.id || job.jobId;
          if (!jobId) continue;
          const tempId = `job_${jobId}`;
          beginPollingJob(jobId, tempId);
        }
      } catch (error) {
        console.error('Failed to resume jobs:', error);
      }
    };

    resumeJobs();
  }, [isAuthenticated, token, beginPollingJob]);

  const togglePlay = () => {
    const song = currentSong || selectedSong;
    if (!song) return;
    if (!song.audioUrl) {
      showToast(t('songNotAvailable'), 'error');
      return;
    }
    // If no currentSong yet, start playing the selected song
    if (!currentSong && song) {
      playSong(song);
      return;
    }
    setIsPlaying(!isPlaying);
  };

  const playFirst = () => {
    const available = songs.filter(s => s.audioUrl && !s.isGenerating);
    if (available.length > 0) {
      playSong(available[0], available);
    }
  };

  const playSong = (song: Song, list?: Song[]) => {
    const nextQueue = list && list.length > 0
      ? list
      : (playQueue.length > 0 && playQueue.some(s => s.id === song.id))
          ? playQueue
          : (songs.some(s => s.id === song.id) ? songs : [song]);
    const nextIndex = nextQueue.findIndex(s => s.id === song.id);
    setPlayQueue(nextQueue);
    setQueueIndex(nextIndex);

    if (currentSong?.id !== song.id) {
      const updatedSong = { ...song, viewCount: (song.viewCount || 0) + 1 };
      setCurrentSong(updatedSong);
      setSelectedSong(updatedSong);
      setIsPlaying(true);
      setSongs(prev => prev.map(s => s.id === song.id ? updatedSong : s));
      songsApi.trackPlay(song.id, token).catch(err => console.error('Failed to track play:', err));
    } else {
      togglePlay();
    }
    if (currentSong?.id === song.id) {
      setSelectedSong(song);
    }
    setShowRightSidebar(true);
  };

  const handleSeek = (time: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    if (Number.isNaN(audio.duration) || audio.readyState < 1 || audio.seekable.length === 0) {
      pendingSeekRef.current = time;
      return;
    }
    audio.currentTime = time;
    setCurrentTime(time);
  };

  const toggleLike = async (songId: string) => {
    if (!token) return;

    const isLiked = likedSongIds.has(songId);

    // Optimistic update
    setLikedSongIds(prev => {
      const next = new Set(prev);
      if (isLiked) next.delete(songId);
      else next.add(songId);
      return next;
    });

    setSongs(prev => prev.map(s => {
      if (s.id === songId) {
        const newCount = (s.likeCount || 0) + (isLiked ? -1 : 1);
        return { ...s, likeCount: Math.max(0, newCount) };
      }
      return s;
    }));

    if (selectedSong?.id === songId) {
      setSelectedSong(prev => prev ? {
        ...prev,
        likeCount: Math.max(0, (prev.likeCount || 0) + (isLiked ? -1 : 1))
      } : null);
    }

    // Persist to database
    try {
      await songsApi.toggleLike(songId, token);
    } catch (error) {
      console.error('Failed to toggle like:', error);
      // Revert on error
      setLikedSongIds(prev => {
        const next = new Set(prev);
        if (isLiked) next.add(songId);
        else next.delete(songId);
        return next;
      });
    }
  };

  const handleDeleteSong = (song: Song) => {
    handleDeleteSongs([song]);
  };

  const handleDeleteSongs = (songsToDelete: Song[]) => {
    if (!token || songsToDelete.length === 0) return;

    const isSingle = songsToDelete.length === 1;
    const title = isSingle ? t('confirmDeleteTitle') : t('confirmDeleteManyTitle');
    const message = isSingle
      ? t('deleteSongConfirm').replace('{title}', songsToDelete[0].title)
      : t('deleteSongsConfirm').replace('{count}', String(songsToDelete.length));

    setConfirmDialog({
      title,
      message,
      onConfirm: async () => {
        setConfirmDialog(null);

        const idsToDelete = new Set(songsToDelete.map(song => song.id));
        const succeeded: string[] = [];
        const failed: string[] = [];

        for (const song of songsToDelete) {
          try {
            await songsApi.deleteSong(song.id, token!);
            succeeded.push(song.id);
          } catch (error) {
            console.error('Failed to delete song:', error);
            failed.push(song.id);
          }
        }

        if (succeeded.length > 0) {
          setSongs(prev => prev.filter(s => !idsToDelete.has(s.id) || failed.includes(s.id)));

          setLikedSongIds(prev => {
            const next = new Set(prev);
            succeeded.forEach(id => next.delete(id));
            return next;
          });

          if (selectedSong?.id && succeeded.includes(selectedSong.id)) {
            setSelectedSong(null);
          }

          if (currentSong?.id && succeeded.includes(currentSong.id)) {
            setCurrentSong(null);
            setIsPlaying(false);
            if (audioRef.current) {
              audioRef.current.pause();
              audioRef.current.src = '';
            }
          }

          setPlayQueue(prev => prev.filter(s => !idsToDelete.has(s.id) || failed.includes(s.id)));
        }

        if (failed.length > 0) {
          showToast(t('songsDeletedPartial').replace('{succeeded}', String(succeeded.length)).replace('{total}', String(songsToDelete.length)), 'error');
        } else if (isSingle) {
          showToast(t('songDeleted'));
        } else {
          showToast(t('songsDeletedSuccess'));
        }
      },
    });
  };

  const handleDeleteReferenceTrack = (trackId: string) => {
    if (!token) return;

    setConfirmDialog({
      title: t('delete'),
      message: t('deleteUploadConfirm'),
      onConfirm: async () => {
        setConfirmDialog(null);
        try {
          const response = await fetch(`/api/reference-tracks/${trackId}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token!}` }
          });
          if (!response.ok) {
            throw new Error('Failed to delete upload');
          }
          setReferenceTracks(prev => prev.filter(track => track.id !== trackId));
          showToast(t('songDeleted'));
        } catch (error) {
          console.error('Failed to delete upload:', error);
          showToast(t('failedToDeleteSong'), 'error');
        }
      },
    });
  };

  const createPlaylist = async (name: string, description: string) => {
    if (!token) return;
    try {
      const res = await playlistsApi.create(name, description, true, token, creatingPlaylistKind);
      setPlaylists(prev => [res.playlist, ...prev]);

      if (songToAddToPlaylist) {
        // Meme exclusivite que addSongToPlaylist — voir son commentaire.
        if (creatingPlaylistKind === 'workspace') {
          await playlistsApi.removeSongFromAllWorkspaces(songToAddToPlaylist.id, token);
        }
        await playlistsApi.addSong(res.playlist.id, songToAddToPlaylist.id, token);
        setSongToAddToPlaylist(null);
        playlistsApi.getMyPlaylists(token).then(r => setPlaylists(r.playlists)).catch(() => {});
        // Meme oubli que addSongToPlaylist avait eu la fois precedente :
        // creer un NOUVEL espace "a la volee" (plutot que d'en choisir un
        // deja existant) est un chemin de code distinct, qui n'appelait
        // jamais refreshWorkspaceSongIds — la chanson restait visible a
        // tort dans "Mon espace de travail" jusqu'a rechargement complet.
        if (creatingPlaylistKind === 'workspace') {
          refreshWorkspaceSongIds();
          if (activeWorkspaceFilter) {
            refreshActiveWorkspaceSongIds(activeWorkspaceFilter.id);
          }
        }
      }
      showToast(creatingPlaylistKind === 'workspace' ? t('workspaceCreated') : t('playlistCreated'));
    } catch (error) {
      console.error('Create playlist error:', error);
      showToast(t('failedToCreatePlaylist'), 'error');
    }
  };

  const openAddToPlaylistModal = (song: Song) => {
    setSongToAddToPlaylist(song);
    setAddingToKind('playlist');
    setIsAddToPlaylistModalOpen(true);
  };

  const openAddToWorkspaceModal = (song: Song) => {
    setSongToAddToPlaylist(song);
    setAddingToKind('workspace');
    setIsAddToPlaylistModalOpen(true);
  };

  const addSongToPlaylist = async (playlistId: string) => {
    if (!songToAddToPlaylist || !token) return;
    try {
      // Exclusivite d'appartenance pour les espaces de travail : retire
      // d'abord le morceau de TOUT espace ou il se trouvait deja, sinon
      // l'ajout se contentait de dupliquer sa presence dans les deux — le
      // morceau devient visible dans deux espaces a la fois au lieu d'un
      // vrai deplacement. Les playlists classiques restent many-to-many,
      // pas de retrait pour elles.
      if (addingToKind === 'workspace') {
        await playlistsApi.removeSongFromAllWorkspaces(songToAddToPlaylist.id, token);
      }
      await playlistsApi.addSong(playlistId, songToAddToPlaylist.id, token);
      setSongToAddToPlaylist(null);
      showToast(t('songAddedToPlaylist'));
      playlistsApi.getMyPlaylists(token).then(r => setPlaylists(r.playlists)).catch(() => {});
      // Rafraichit l'union des chansons "dans un espace" — sans ca, une
      // chanson qu'on vient de ranger dans un espace resterait visible
      // dans "Mon espace de travail" jusqu'au prochain rechargement complet.
      if (addingToKind === 'workspace') {
        refreshWorkspaceSongIds();
        // Si on est DEJA a l'interieur d'un espace au moment du
        // deplacement (activeWorkspaceFilter non nul), son contenu affiche
        // peut avoir change — soit le morceau vient d'en partir, soit (cas
        // rare) on l'a re-ajoute au meme espace. Toujours sur, jamais nuisible.
        if (activeWorkspaceFilter) {
          refreshActiveWorkspaceSongIds(activeWorkspaceFilter.id);
        }
      }
    } catch (error) {
      console.error('Add song error:', error);
      showToast(t('failedToAddSong'), 'error');
    }
  };

  const handleNavigateToPlaylist = (playlistId: string) => {
    setViewingPlaylistId(playlistId);
    setCurrentView('playlist');
    window.history.pushState({}, '', `/playlist/${playlistId}`);
  };

  // Clic sur une carte "Espace de travail" (onglet Bibliotheque) : bascule
  // vers l'onglet Creer, filtre la liste sur les chansons de cet espace, et
  // le fil d'Ariane de SongList affiche son vrai nom. Distinct de
  // handleNavigateToPlaylist : les cartes "Playlist" classiques continuent
  // d'ouvrir la page PlaylistDetail separee, comportement inchange.
  //
  // La liste des chansons n'est PAS disponible sur l'objet `workspace` recu
  // (issu de GET /playlists, qui ne renvoie qu'un COUNT) — il faut refaire
  // l'appel GET /playlists/:id ici, au moment du clic, exactement comme le
  // fait PlaylistDetail.tsx.
  // Recharge les identifiants de l'espace ACTUELLEMENT affiche (distinct de
  // refreshWorkspaceSongIds, qui couvre l'union de TOUS les espaces pour la
  // vue par defaut). Factorise depuis handleSelectWorkspace pour etre
  // reutilisable apres qu'un morceau ait bouge pendant qu'on est deja a
  // l'interieur d'un espace — sans ca, deplacer un morceau hors de l'espace
  // affiche le laissait visible a tort jusqu'a un nouveau clic sur la carte.
  const refreshActiveWorkspaceSongIds = useCallback(async (workspaceId: string) => {
    if (!token) return;
    try {
      const res = await playlistsApi.getPlaylist(workspaceId, token);
      setActiveWorkspaceSongIds(new Set((res.songs || []).map((s: any) => s.id)));
    } catch (e) {
      console.error('Failed to refresh active workspace songs:', e);
    }
  }, [token]);

  const handleSelectWorkspace = async (workspace: Playlist) => {
    setActiveWorkspaceFilter(workspace);
    setActiveWorkspaceSongIds(null); // vide pendant le chargement
    setCurrentView('create');
    setMobileShowList(false);
    refreshActiveWorkspaceSongIds(workspace.id);
  };

  // Retour vers la bibliotheque pour choisir un AUTRE espace — avant ce
  // correctif, on se contentait d'effacer le filtre en restant dans l'onglet
  // Creer, ce qui ne permettait pas de re-selectionner un espace different.
  const handleBackToWorkspaces = () => {
    setActiveWorkspaceFilter(null);
    setActiveWorkspaceSongIds(null);
    setLibraryInitialTab('workspaces');
    setCurrentView('library');
  };

  // Distinct de handleBackToWorkspaces : reste dans l'onglet Creer, efface
  // juste le filtre pour retomber sur "Mon espace de travail". Le seul
  // retour possible auparavant demandait un aller-retour complet par
  // Bibliotheque > Tous les titres > Creer.
  const handleClearWorkspaceFilter = () => {
    setActiveWorkspaceFilter(null);
    setActiveWorkspaceSongIds(null);
  };

  // Renommage de l'espace de travail actuellement affiche. Jamais appelable
  // sur "Mon espace de travail" (virtuel — voir SongList.tsx, le bouton
  // d'edition n'apparait que si activeWorkspaceFilter est un vrai espace).
  const handleRenameWorkspace = async (newName: string) => {
    if (!activeWorkspaceFilter || !token) return;
    try {
      const res = await playlistsApi.update(activeWorkspaceFilter.id, { name: newName }, token);
      // Met a jour l'espace actif (affichage immediat dans le fil d'Ariane)
      // ET la liste globale (pour que la grille de la Bibliotheque reflete
      // le nouveau nom sans necessiter un rechargement).
      setActiveWorkspaceFilter(res.playlist);
      setPlaylists(prev => prev.map(p => p.id === res.playlist.id ? res.playlist : p));
    } catch (error) {
      console.error('Failed to rename workspace:', error);
      showToast(t('failedToRenameWorkspace'), 'error');
    }
  };

  const handleUseAsReference = (song: Song) => {
    if (!song.audioUrl) return;
    // Meme correctif que handleCoverSong ci-dessous : mode explicite plutot
    // que de deriver taskType du mode deja actif au moment du clic.
    setPendingAudioSelection({ target: 'reference', url: song.audioUrl, title: song.title, mode: 'inspiration' });
    setCurrentView('create');
    setMobileShowList(false);
  };

  const handleCoverSong = (song: Song) => {
    if (!song.audioUrl) return;
    // mode: 'cover' explicite — sans lui, CreatePanel derivait taskType du
    // mode DEJA actif au moment du clic (ex: Inspiration), pas de
    // l'intention reelle de "Reprendre la chanson (Cover)". L'audio se
    // chargeait bien, mais la section Cover ne s'affichait jamais quand on
    // declenchait l'action depuis un autre mode que Cover.
    setPendingAudioSelection({ target: 'source', url: song.audioUrl, title: song.title, mode: 'cover' });
    setCurrentView('create');
    setMobileShowList(false);
  };

  const handleUseUploadAsReference = (track: { audio_url: string; filename: string }) => {
    setPendingAudioSelection({
      target: 'reference',
      url: track.audio_url,
      title: track.filename.replace(/\.[^/.]+$/, ''),
    });
    setCurrentView('create');
    setMobileShowList(false);
  };

  const handleCoverUpload = (track: { audio_url: string; filename: string }) => {
    setPendingAudioSelection({
      target: 'source',
      url: track.audio_url,
      title: track.filename.replace(/\.[^/.]+$/, ''),
    });
    setCurrentView('create');
    setMobileShowList(false);
  };

  const handleBackFromPlaylist = () => {
    setViewingPlaylistId(null);
    // Atterrit sur l'onglet Playlists plutot que "Tous" — sert aussi bien le
    // bouton retour manuel que la suppression (les deux appellent onBack,
    // donc cette meme fonction), repondant a la demande d'une redirection
    // plus logique apres suppression d'une playlist.
    setLibraryInitialTab('playlists');
    setCurrentView('library');
    window.history.pushState({}, '', '/library');
  };

  // Retire une playlist supprimee de l'etat local — sans ceci, la carte
  // restait visible dans la grille apres suppression (App.tsx n'etait
  // jamais prevenu), et un clic dessus tentait de rouvrir un id qui
  // n'existe plus cote serveur (404 "Playlist not found"), necessitant un
  // rechargement complet pour purger l'entree fantome.
  const handlePlaylistDeleted = (deletedId: string) => {
    setPlaylists(prev => prev.filter(p => p.id !== deletedId));
    // Si l'espace supprime contenait des chansons, elles doivent redevenir
    // visibles dans "Mon espace de travail" — meme logique que le retrait
    // d'une chanson unique (voir onSongRemovedFromPlaylist).
    refreshWorkspaceSongIds();
  };

  const openVideoGenerator = (song: Song) => {
    if (isPlaying) {
      setIsPlaying(false);
      if (audioRef.current) audioRef.current.pause();
    }
    setSongForVideo(song);
    setIsVideoModalOpen(true);
  };

  const openCoverRegen = (song: Song) => {
    // Don't pause playback here — cover regen is non-destructive and the
    // modal is small enough that the user may want to keep listening.
    setSongForCoverRegen(song);
  };

  // Apply the new cover URL to local state without a full /api/songs reload
  // (the backend already wrote songs.cover_url; we just need the UI to
  // reflect it). Cache-bust by appending a timestamp so <img> re-fetches.
  const applyCoverUpdate = useCallback((songId: string, coverUrl: string) => {
    const bust = `${coverUrl}${coverUrl.includes('?') ? '&' : '?'}t=${Date.now()}`;
    setSongs(prev => prev.map(s => s.id === songId ? { ...s, coverUrl: bust } : s));
    setSelectedSong(prev => prev?.id === songId ? { ...prev, coverUrl: bust } : prev);
  }, []);

  // Handle username setup
  const handleUsernameSubmit = async (username: string) => {
    await setupUser(username);
    setShowUsernameModal(false);
  };

  // Render Layout Logic
  const renderContent = () => {
    switch (currentView) {
      case 'library': {
        const allSongs = user ? songs.filter(s => s.userId === user.id) : [];
        return (
          <LibraryView
            allSongs={allSongs}
            likedSongs={songs.filter(s => likedSongIds.has(s.id))}
            playlists={regularPlaylists}
            workspaces={workspaces}
            initialTab={libraryInitialTab}
            referenceTracks={referenceTracks}
            onPlaySong={playSong}
            onCreatePlaylist={() => {
              setSongToAddToPlaylist(null);
              setCreatingPlaylistKind('playlist');
              setIsCreatePlaylistModalOpen(true);
            }}
            onCreateWorkspace={() => {
              setSongToAddToPlaylist(null);
              setCreatingPlaylistKind('workspace');
              setIsCreatePlaylistModalOpen(true);
            }}
            onSelectPlaylist={(p) => handleNavigateToPlaylist(p.id)}
            onSelectWorkspace={handleSelectWorkspace}
            onAddToPlaylist={openAddToPlaylistModal}
            onAddToWorkspace={openAddToWorkspaceModal}
            onCoverSong={handleCoverSong}
            onUseAsReference={handleUseAsReference}
            onOpenVideo={openVideoGenerator}
            onReusePrompt={handleReuse}
            onDeleteSong={handleDeleteSong}
            onDeleteReferenceTrack={handleDeleteReferenceTrack}
          />
        );
      }

      case 'profile':
        if (!viewingUsername) return null;
        return (
          <UserProfile
            username={viewingUsername}
            onBack={handleBackFromProfile}
            onPlaySong={playSong}
            onNavigateToProfile={handleNavigateToProfile}
            onNavigateToPlaylist={handleNavigateToPlaylist}
            currentSong={currentSong}
            isPlaying={isPlaying}
            likedSongIds={likedSongIds}
            onToggleLike={toggleLike}
          />
        );

      case 'playlist':
        if (!viewingPlaylistId) return null;
        return (
          <PlaylistDetail
            playlistId={viewingPlaylistId}
            onBack={handleBackFromPlaylist}
            onPlaylistDeleted={handlePlaylistDeleted}
            onSongRemovedFromPlaylist={refreshWorkspaceSongIds}
            onPlaySong={playSong}
            onSelect={(s) => {
              setSelectedSong(s);
              setShowRightSidebar(true);
            }}
            onNavigateToProfile={handleNavigateToProfile}
          />
        );

      case 'song':
        if (!viewingSongId) return null;
        return (
          <SongProfile
            songId={viewingSongId}
            onBack={handleBackFromSong}
            onPlay={playSong}
            onNavigateToProfile={handleNavigateToProfile}
            currentSong={currentSong}
            isPlaying={isPlaying}
            likedSongIds={likedSongIds}
            onToggleLike={toggleLike}
          />
        );

      case 'search':
        return (
          <SearchPage
            onPlaySong={playSong}
            currentSong={currentSong}
            isPlaying={isPlaying}
            onNavigateToProfile={handleNavigateToProfile}
            onNavigateToSong={handleNavigateToSong}
            onNavigateToPlaylist={handleNavigateToPlaylist}
          />
        );

      case 'training':
        return <TrainingPanel />;

      case 'tools':
        return <ToolsPanel />;

      case 'news':
        return <NewsPage />;

      case 'create':
      default:
        // Filtre par espace de travail actif (voir handleSelectWorkspace) :
        // s'appuie sur activeWorkspaceSongIds, charge par appel API separe.
        //
        // Sans espace explicitement selectionne, "Mon espace de travail"
        // (virtuel — aucune ligne en base, voir session du 25/08/2026)
        // exclut tout ce qui appartient DEJA a un espace nomme : une
        // chanson rangee ailleurs ne doit pas rester visible aussi dans la
        // vue par defaut.
        const displayedSongs = activeWorkspaceFilter
          ? songs.filter(s => activeWorkspaceSongIds?.has(s.id))
          : songs.filter(s => !songsInAnyWorkspace.has(s.id));
        return (
          <div className="flex h-full overflow-hidden relative w-full">
            {/* Create Panel */}
            <div
              className={`
                ${mobileShowList ? 'hidden md:block' : 'w-full'}
                md:block flex-shrink-0 h-full bg-zinc-50 dark:bg-suno-panel relative z-10 transition-colors duration-300
              `}
              style={{ width: window.innerWidth >= 768 ? leftPanel.width : undefined }}
            >
              <CreatePanel
                onGenerate={handleGenerate}
                isGenerating={isGenerating}
                activeJobCount={activeJobCount + pendingClickCount}
                initialData={reuseData}
                createdSongs={songs}
                pendingAudioSelection={pendingAudioSelection}
                onAudioSelectionApplied={() => setPendingAudioSelection(null)}
                onSongCreated={(song: any) => {
                  // Le backend renvoie la ligne brute en snake_case — sans
                  // cette conversion, la chanson reste techniquement dans
                  // songs[] mais s'affiche mal (audioUrl/coverUrl/createdAt
                  // absents), invisible jusqu'a un rechargement complet qui
                  // repasse par le VRAI chemin de recuperation (mapSong,
                  // ci-dessus dans ce fichier). Champs specifiques a la
                  // generation IA (ditModel, lmModel, etc.) volontairement
                  // absents ici : une chanson enregistree au micro n'en a
                  // jamais.
                  setSongs(prev => [{
                    id: song.id,
                    title: song.title,
                    lyrics: song.lyrics,
                    style: song.style,
                    coverUrl: song.cover_url || song.coverUrl || getCoverUrl(song.id),
                    duration: song.duration && song.duration > 0
                      ? `${Math.floor(song.duration / 60)}:${String(Math.floor(song.duration % 60)).padStart(2, '0')}`
                      : '0:00',
                    createdAt: new Date(song.created_at || song.createdAt),
                    tags: song.tags || [],
                    audioUrl: getAudioUrl(song.audio_url, song.id),
                    isPublic: song.is_public,
                    likeCount: song.like_count || 0,
                    viewCount: song.view_count || 0,
                    userId: song.user_id,
                    creator: song.creator,
                  } as Song, ...prev]);
                  refreshWorkspaceSongIds();
                }}
                waitForJobsToDrain={waitForJobsToDrain}
                incrementPendingClicks={incrementPendingClicks}
                decrementPendingClicks={decrementPendingClicks}
                createTempSongForClick={createTempSongForClick}
                updateTempSongForClick={updateTempSongForClick}
                removeTempSongForClick={removeTempSongForClick}
                registerPreflightAbort={registerPreflightAbort}
                unregisterPreflightAbort={unregisterPreflightAbort}
              />
            </div>
            {leftPanel.handle}

            {/* Song List */}
            <div className={`
              ${!mobileShowList ? 'hidden md:flex' : 'flex'}
              flex-1 flex-col h-full overflow-hidden bg-white dark:bg-suno-DEFAULT transition-colors duration-300
            `}>
              <SongList
                songs={displayedSongs}
                currentSong={currentSong}
                selectedSong={selectedSong}
                likedSongIds={likedSongIds}
                isPlaying={isPlaying}
                referenceTracks={referenceTracks}
                activeWorkspaceName={activeWorkspaceFilter?.name}
                onBackToWorkspaces={handleBackToWorkspaces}
                onClearWorkspaceFilter={handleClearWorkspaceFilter}
                onRenameWorkspace={handleRenameWorkspace}
                onPlay={playSong}
                onSelect={(s) => {
                  setSelectedSong(s);
                  setShowRightSidebar(true);
                }}
                onToggleLike={toggleLike}
                onAddToPlaylist={openAddToPlaylistModal}
                onAddToWorkspace={openAddToWorkspaceModal}
                onOpenVideo={openVideoGenerator}
                onOpenCoverRegen={openCoverRegen}
                onShowDetails={handleShowDetails}
                onNavigateToProfile={handleNavigateToProfile}
                onReusePrompt={handleReuse}
                onDelete={handleDeleteSong}
                onDeleteMany={handleDeleteSongs}
                onUseAsReference={handleUseAsReference}
                onCoverSong={handleCoverSong}
                onUseUploadAsReference={handleUseUploadAsReference}
                onCoverUpload={handleCoverUpload}
                onSongUpdate={handleSongUpdate}
                onCancelJob={cancelGeneration}
                onResetJob={resetSingleJob}
                onCancelAll={cancelAllGenerations}
                onResetAll={resetGeneration}
                activeJobCount={activeJobCount}
              />
            </div>

            {/* Right Sidebar */}
            {showRightSidebar && selectedSong && (
              <>
              {rightPanel.handle}
              <div
                className="hidden xl:block flex-shrink-0 h-full bg-zinc-50 dark:bg-suno-panel relative z-10 transition-colors duration-300"
                style={{ width: rightPanel.width }}
              >
                <RightSidebar
                  song={selectedSong}
                  onClose={() => setShowRightSidebar(false)}
                  onOpenVideo={() => selectedSong && openVideoGenerator(selectedSong)}
                  onOpenCoverRegen={() => selectedSong && openCoverRegen(selectedSong)}
                  onReuse={handleReuse}
                  onSongUpdate={handleSongUpdate}
                  onNavigateToProfile={handleNavigateToProfile}
                  onNavigateToSong={handleNavigateToSong}
                  isLiked={selectedSong ? likedSongIds.has(selectedSong.id) : false}
                  onToggleLike={toggleLike}
                  onDelete={handleDeleteSong}
                  onPlay={playSong}
                  isPlaying={isPlaying}
                  currentSong={currentSong}
                />
              </div>
              </>
            )}

            {/* Mobile Toggle Button */}
            <div className="md:hidden absolute top-4 right-4 z-50">
              <button
                onClick={() => setMobileShowList(!mobileShowList)}
                className="bg-zinc-800 text-white px-4 py-2 rounded-full shadow-lg border border-white/10 flex items-center gap-2 text-sm font-bold"
              >
                {mobileShowList ? t('createSong') : t('viewList')}
                <List size={16} />
              </button>
            </div>
          </div>
        );
    }
  };

  return (
    <div className="flex flex-col h-screen bg-white dark:bg-suno-DEFAULT text-zinc-900 dark:text-white font-sans antialiased selection:bg-pink-500/30 transition-colors duration-300">
      {authLoading && (
        <div className="bg-zinc-800 text-zinc-300 text-xs text-center py-1.5 flex items-center justify-center gap-2 flex-shrink-0">
          <div className="w-3 h-3 border-2 border-pink-500 border-t-transparent rounded-full animate-spin" />
          {t('connectingToServer') || 'Connecting to server...'}
        </div>
      )}
      <div className="flex-1 flex overflow-hidden">
        <Sidebar
          currentView={currentView}
          onNavigateHome={() => {
            if (user?.username) {
              handleNavigateToProfile(user.username);
            } else {
              setCurrentView('create');
            }
          }}
          onNavigate={(v) => {
            setCurrentView(v);
            if (v === 'create') {
              setMobileShowList(false);
              window.history.pushState({}, '', '/');
            } else if (v === 'library') {
              window.history.pushState({}, '', '/library');
            } else if (v === 'search') {
              window.history.pushState({}, '', '/search');
            } else if (v === 'news') {
              window.history.pushState({}, '', '/news');
            }
            if (isMobile) setShowLeftSidebar(false);
          }}
          theme={theme}
          onToggleTheme={toggleTheme}
          user={user}
          onLogin={() => setShowUsernameModal(true)}
          onLogout={logout}
          onOpenSettings={() => setShowSettingsModal(true)}
          isOpen={showLeftSidebar}
          onToggle={() => setShowLeftSidebar(!showLeftSidebar)}
        />

        <main className="flex-1 flex overflow-hidden relative">
          {renderContent()}
        </main>
      </div>

      {(currentSong || selectedSong) && <Player
        currentSong={currentSong || selectedSong}
        isPlaying={isPlaying}
        onTogglePlay={togglePlay}
        currentTime={currentTime}
        duration={duration}
        onSeek={handleSeek}
        onNext={playNext}
        onPrevious={playPrevious}
        volume={volume}
        onVolumeChange={setVolume}
        playbackRate={playbackRate}
        onPlaybackRateChange={setPlaybackRate}
        audioRef={audioRef}
        isShuffle={isShuffle}
        onToggleShuffle={() => setIsShuffle(!isShuffle)}
        repeatMode={repeatMode}
        onToggleRepeat={() => setRepeatMode(prev => prev === 'none' ? 'all' : prev === 'all' ? 'one' : 'none')}
        isLiked={currentSong ? likedSongIds.has(currentSong.id) : false}
        onToggleLike={() => currentSong && toggleLike(currentSong.id)}
        onNavigateToSong={handleNavigateToSong}
        onOpenVideo={() => currentSong && openVideoGenerator(currentSong)}
        onReusePrompt={() => currentSong && handleReuse(currentSong)}
        onAddToPlaylist={() => currentSong && openAddToPlaylistModal(currentSong)}
        onDelete={() => currentSong && handleDeleteSong(currentSong)}
        onPlayFirst={playFirst}
      />}

      <CreatePlaylistModal
        isOpen={isCreatePlaylistModalOpen}
        onClose={() => setIsCreatePlaylistModalOpen(false)}
        onCreate={createPlaylist}
      />
      <AddToPlaylistModal
        isOpen={isAddToPlaylistModalOpen}
        onClose={() => setIsAddToPlaylistModalOpen(false)}
        playlists={addingToKind === 'workspace' ? workspaces : regularPlaylists}
        onSelect={addSongToPlaylist}
        onCreateNew={() => {
          setIsAddToPlaylistModalOpen(false);
          setCreatingPlaylistKind(addingToKind);
          setIsCreatePlaylistModalOpen(true);
        }}
      />
      <Toast
        message={toast.message}
        type={toast.type}
        isVisible={toast.isVisible}
        onClose={closeToast}
        duration={toast.type === 'error' ? 8000 : 3000}
      />
      <VideoGeneratorModal
        isOpen={isVideoModalOpen}
        onClose={() => setIsVideoModalOpen(false)}
        song={songForVideo}
      />
      {/* Cover regen modal — only mounted while a song is selected for regen.
          Unmounting on close revokes blob URLs (see CoverRegenModal cleanup
          effect) so generated previews don't leak across modal opens. */}
      {songForCoverRegen && token && (
        <CoverRegenModal
          song={songForCoverRegen}
          token={token}
          onClose={() => setSongForCoverRegen(null)}
          onCoverSaved={applyCoverUpdate}
        />
      )}
      <UsernameModal
        isOpen={showUsernameModal}
        onSubmit={handleUsernameSubmit}
      />
      <SettingsModal
        isOpen={showSettingsModal}
        onClose={() => setShowSettingsModal(false)}
        theme={theme}
        onToggleTheme={toggleTheme}
        onNavigateToProfile={handleNavigateToProfile}
      />

      {/* Mobile Details Modal */}
      {showMobileDetails && selectedSong && (
        <div className="fixed inset-0 z-[60] flex justify-end xl:hidden">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-in fade-in"
            onClick={() => setShowMobileDetails(false)}
          />
          <div className="relative w-full max-w-md h-full bg-zinc-50 dark:bg-suno-panel shadow-2xl animate-in slide-in-from-right duration-300 border-l border-white/10">
            <RightSidebar
              song={selectedSong}
              onClose={() => setShowMobileDetails(false)}
              onOpenVideo={() => selectedSong && openVideoGenerator(selectedSong)}
              onOpenCoverRegen={() => selectedSong && openCoverRegen(selectedSong)}
              onReuse={handleReuse}
              onSongUpdate={handleSongUpdate}
              onNavigateToProfile={handleNavigateToProfile}
              onNavigateToSong={handleNavigateToSong}
              isLiked={selectedSong ? likedSongIds.has(selectedSong.id) : false}
              onToggleLike={toggleLike}
              onDelete={handleDeleteSong}
              onPlay={playSong}
              isPlaying={isPlaying}
              currentSong={currentSong}
            />
          </div>
        </div>
      )}

      <ConfirmDialog
        isOpen={confirmDialog !== null}
        title={confirmDialog?.title ?? ''}
        message={confirmDialog?.message ?? ''}
        onConfirm={() => confirmDialog?.onConfirm()}
        onCancel={() => setConfirmDialog(null)}
      />
    </div>
  );
}

export default function App() {
  return (
    <I18nProvider>
      <AppContent />
    </I18nProvider>
  );
}
