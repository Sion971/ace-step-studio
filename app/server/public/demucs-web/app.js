/**
 * Demucs Web - Stem Extraction for SunoAce
 */
// Runtime local — voir vendor/onnxruntime/. Il venait de jsdelivr, ce qui
// rendait la separation de pistes inutilisable hors ligne alors que le modele,
// lui, est deja sur le disque.
import * as ort from '/vendor/onnxruntime/ort.all.min.mjs';

// Sans ce chemin, le runtime irait chercher ses .wasm sur le CDN — la
// dependance reseau reviendrait par la porte de service.
// Chemin ABSOLU : un chemin relatif serait resolu depuis l'emplacement de
// ort.all.min.mjs, deja dans /vendor/onnxruntime/ — d'ou un /vendor/vendor/.
ort.env.wasm.wasmPaths = '/vendor/onnxruntime/';
// Douze threads = onze workers qui rechargent le meme module en rafale,
// ce qui declenche des blocages intermittents (NS_ERROR_BLOCKED_BY_POLICY)
// probablement lies a l'isolement cross-origin. Sur une machine deja
// tendue en RAM face a ACE-Step, moins de threads est de toute facon
// preferable a l'inference la plus rapide possible.
ort.env.wasm.numThreads = 4;
import { DemucsProcessor, CONSTANTS } from './src/index.js';
// Import direct depuis constants.js (pas via le relais src/index.js, dont
// le contenu exact des reexports n'est pas verifie ici) — evite tout
// risque de casser un fichier non vu pour ajouter un seul nouvel export.
import { MODEL_FLAVORS } from './src/constants.js';
// Conversion audio -> MIDI (basic-pitch de Spotify) : desormais cote
// SERVEUR, dans un venv Python isole (voir app/server/src/routes/midi.ts
// et setup-basic-pitch-venv.sh). L'ancienne tentative navigateur via
// TensorFlow.js (import BasicPitch/tf/Midi ici meme) est abandonnee —
// WebGL echouait a compiler ses shaders sur cette machine, forcant un
// repli CPU en JavaScript pur (53 minutes pour 19 secondes de musique).
// L'inference native cote serveur convertit le meme stem en moins de
// 20 secondes. Voir TROUBLESHOOTING #28-29 pour l'historique complet.

// TRACKS et DEFAULT_MODEL_URL retires de cette destructuration — remplaces
// partout par MODEL_FLAVORS (constants.js), qui couvre desormais aussi la
// variante 6 pistes. LOCAL_MODEL_URL egalement retire, remplace par
// flavor.localUrl dans loadFlavor().
const { SAMPLE_RATE, TRAINING_SAMPLES } = CONSTANTS;

let processor = null;
let audioContext = null;
let audioBuffer = null;
let isProcessing = false;
let currentFlavorId = 'htdemucs';

// Encode un stem stereo (Float32Array 44100 Hz) en WAV PCM 16 bits — format
// que la route serveur /api/midi/convert accepte en televersement multipart.
// Remplace toMonoDownsampled + convertStemToMidi (execution navigateur,
// abandonnee) : plus besoin de decimer/aplatir en mono cote client, le
// serveur recoit le stem complet et gere le reechantillonnage lui-meme.
function encodeWavStereo(left, right, sampleRate) {
    const numSamples = left.length;
    const blockAlign = 4; // 2 canaux x 2 octets
    const dataSize = numSamples * blockAlign;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    const writeString = (offset, str) => {
        for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 2, true); // stereo
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true); // bits par echantillon
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);

    let offset = 44;
    for (let i = 0; i < numSamples; i++) {
        const l = Math.max(-1, Math.min(1, left[i]));
        const r = Math.max(-1, Math.min(1, right[i]));
        view.setInt16(offset, l < 0 ? l * 0x8000 : l * 0x7fff, true);
        offset += 2;
        view.setInt16(offset, r < 0 ? r * 0x8000 : r * 0x7fff, true);
        offset += 2;
    }

    return new Blob([buffer], { type: 'audio/wav' });
}

// DOM elements
const dropZone = document.getElementById('dropZone');
const modelFlavorSelect = document.getElementById('modelFlavorSelect');
const fileInput = document.getElementById('fileInput');
const processBtn = document.getElementById('processBtn');
const progressFill = document.getElementById('progressFill');
const status = document.getElementById('status');
const results = document.getElementById('results');
const trackList = document.getElementById('trackList');
const backendBadge = document.getElementById('backendBadge');
const audioFileName = document.getElementById('audioFileName');
const statusDetail = document.getElementById('statusDetail');
const statsRow = document.getElementById('statsRow');
const statElapsed = document.getElementById('statElapsed');
const statSegment = document.getElementById('statSegment');
const statSpeed = document.getElementById('statSpeed');
const statETA = document.getElementById('statETA');

let processStartTime = null;

function log(phase, message) {
    const now = new Date();
    const timeStr = now.toLocaleTimeString('en-US', { hour12: false });
    const logLine = document.createElement('div');
    logLine.className = 'text-zinc-400 py-1 border-b border-zinc-800/50 last:border-0';
    logLine.innerHTML = `<span class="text-emerald-400">[${timeStr}]</span> <span class="text-teal-400">[${phase}]</span> ${message}`;
    statusDetail.appendChild(logLine);
    statusDetail.scrollTop = statusDetail.scrollHeight;
    console.log(`[${phase}] ${message}`);
}

function formatTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '--:--';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Cree le processeur et charge le modele pour la variante donnee (voir
// MODEL_FLAVORS dans constants.js) — factorise depuis l'ancien contenu de
// init(), pour que le changement de selecteur puisse reutiliser exactement
// la meme logique local-d'abord/distant-en-repli, plutot que la dupliquer.
async function loadFlavor(flavorId) {
    const flavor = MODEL_FLAVORS[flavorId];
    if (!flavor) {
        console.error('[demucs] variante de modele inconnue :', flavorId);
        return;
    }

    // Libere explicitement l'ancienne session avant d'en creer une
    // nouvelle — sans ca, onnxruntime-web (backend WASM) retient les
    // ressources natives de CHAQUE InferenceSession creee, y compris
    // celles dont plus aucune reference JS n'existe (le ramasse-miettes
    // classique de JavaScript ne recupere pas la memoire WASM sous-
    // jacente). Concretement : passer du 4 pistes (~180 Mo) au 6 pistes
    // (~258 Mo) sans cette ligne les CUMULE en memoire plutot que de
    // remplacer l'un par l'autre — potentiellement LA vraie cause des
    // echecs "Aborted()" constates en pratique, pas necessairement une
    // limite materielle. Voir microsoft/onnxruntime#13391. Entoure d'un
    // try/catch : release() n'existe que dans les versions recentes
    // d'onnxruntime-web, prudence sur la version embarquee exacte ici.
    if (processor && processor.session && typeof processor.session.release === 'function') {
        try {
            log('model', 'Liberation de la session precedente...');
            await processor.session.release();
        } catch (releaseErr) {
            console.warn('[demucs] echec de la liberation de session (non bloquant) :', releaseErr);
        }
    }

    // Teste en conditions reelles (machine a 16 Go de RAM, deja chargee) :
    // la variante 6 pistes echoue au chargement WASM avec "Aborted()"
    // (manque de memoire fatal dans le runtime Emscripten), identiquement
    // a 258 Mo comme 136 Mo, et a 1 comme 4 threads — ni la taille du
    // fichier ni le nombre de threads n'etaient le facteur limitant. Reglage
    // uniforme a 4 threads restaure, coherent avec ce qui fonctionne deja
    // pour le modele 4 pistes. La fonctionnalite 6 pistes reste disponible
    // dans le menu (utile sur une machine avec davantage de RAM), avec son
    // libelle "experimental" deja explicite sur ce risque.

    processor = new DemucsProcessor({
        ort,
        tracks: flavor.tracks,
        onProgress: ({ progress, currentSegment, totalSegments }) => {
            progressFill.style.width = (5 + progress * 90) + '%';

            const elapsed = (Date.now() - processStartTime) / 1000;
            statElapsed.textContent = formatTime(elapsed);
            statSegment.textContent = `${currentSegment}/${totalSegments}`;

            if (currentSegment > 0 && audioBuffer) {
                const processedDuration = (currentSegment / totalSegments) * audioBuffer.duration;
                const speed = processedDuration / elapsed;
                statSpeed.textContent = speed.toFixed(2) + 'x';

                const remainingSegments = totalSegments - currentSegment;
                const avgTimePerSegment = elapsed / currentSegment;
                const eta = remainingSegments * avgTimePerSegment;
                statETA.textContent = formatTime(eta);
            }
        },
        onLog: log,
        onDownloadProgress: (loaded, total, sourceUrl) => {
            const percent = ((loaded / total) * 100).toFixed(1);
            const loadedMB = (loaded / 1024 / 1024).toFixed(1);
            const totalMB = (total / 1024 / 1024).toFixed(1);
            const isLocal = String(sourceUrl || '').startsWith(location.origin);
            status.textContent = (isLocal ? 'Lecture du modele local' : 'Telechargement du modele')
              + ` ... ${loadedMB}MB / ${totalMB}MB (${percent}%)`;
            progressFill.style.width = (loaded / total * 100) + '%';
        }
    });

    status.textContent = 'Loading AI model...';

    try {
        // Local d'abord : le modele pese jusqu'a 258 Mo (variante 6 pistes)
        // et etait retelecharge a chaque session. Le distant ne sert plus
        // que si le fichier local est absent — pour la variante 6 pistes,
        // c'est le cas par defaut (telechargement a la demande uniquement,
        // jamais pre-depose a l'installation, choix delibere vu sa taille
        // et son statut experimental). Voir fetch-assets.sh.
        try {
            status.textContent = 'Chargement du modele local...';
            await processor.loadModel(flavor.localUrl);
        } catch (localErr) {
            // Ce catch attrape TOUTE erreur de loadModel, pas seulement un
            // fichier absent : runtime ONNX non initialise, memoire, fichier
            // corrompu... Le message d'origine etait donc trompeur.
            console.error('[demucs] echec du modele local :', localErr);
            status.textContent = 'Modele local KO (' + (localErr?.message || localErr) + ') — telechargement...';
            await processor.loadModel(flavor.remoteUrl);
        }
        currentFlavorId = flavorId;
        status.textContent = 'Ready - Select an audio file';
        progressFill.style.width = '0%';
    } catch (e) {
        status.textContent = 'Failed to load model: ' + e.message;
        console.error('Failed to load model:', e);
    }
}

async function init() {
    let backend = 'wasm';

    if ('gpu' in navigator) {
        try {
            const gpuAdapter = await navigator.gpu.requestAdapter();
            if (gpuAdapter) {
                backend = 'webgpu';
            }
        } catch (e) {
            console.log('WebGPU not available:', e);
        }
    }

    // Ne PAS reecrire numThreads ici : la valeur voulue (4, voir le
    // commentaire en tete de fichier) etait ecrasee par cette ligne,
    // qui s'execute apres le reglage initial et remettait le nombre de
    // threads au maximum (navigator.hardwareConcurrency).

    if (backend === 'webgpu') {
        ort.env.webgpu = ort.env.webgpu || {};
        ort.env.webgpu.powerPreference = 'high-performance';
        backendBadge.textContent = 'WebGPU (GPU)';
        backendBadge.className = 'badge badge-gpu';
    } else {
        const threads = navigator.hardwareConcurrency || 4;
        backendBadge.textContent = `WASM (${threads} threads)`;
        backendBadge.className = 'badge badge-cpu';
    }

    await loadFlavor(currentFlavorId);

    audioContext = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: SAMPLE_RATE
    });

    // Check for audio URL parameter and auto-start
    const urlParams = new URLSearchParams(window.location.search);
    const audioUrl = urlParams.get('audioUrl');
    if (audioUrl) {
        await loadAudioFromUrl(audioUrl);
    }
}

async function loadAudioFromUrl(url) {
    try {
        status.textContent = 'Loading audio...';
        const fileName = decodeURIComponent(url.split('/').pop() || 'audio.mp3');
        audioFileName.textContent = fileName;

        // Force fresh fetch to avoid 304 Not Modified with empty body
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const arrayBuffer = await response.arrayBuffer();
        audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

        const duration = audioBuffer.duration.toFixed(1);
        status.textContent = `Loaded: ${duration}s - Choisis un modele puis clique sur Extract Stems`;
        processBtn.disabled = false;

        // Ancien auto-demarrage retire : avec le choix entre 4 et 6 pistes
        // desormais possible, il ne laissait aucun temps pour changer le
        // modele avant que l'extraction ne parte deja avec le repli par
        // defaut. Un clic explicite est desormais toujours necessaire.
    } catch (e) {
        status.textContent = 'Failed to load audio: ' + e.message;
        console.error('Failed to load audio from URL:', e);
    }
}

// Drag and drop handlers
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('border-emerald-500', 'bg-emerald-500/5');
});
dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('border-emerald-500', 'bg-emerald-500/5');
});
dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('border-emerald-500', 'bg-emerald-500/5');
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('audio/')) {
        handleFile(file);
    }
});
fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) handleFile(file);
});

// Changement de variante de modele — desactive pendant un traitement en
// cours pour eviter un echange de modele en plein calcul (voir l'attribut
// disabled correspondant sur processBtn dans startProcessing()).
if (modelFlavorSelect) {
    modelFlavorSelect.addEventListener('change', async (e) => {
        const flavorId = e.target.value;
        if (flavorId === currentFlavorId || isProcessing) return;
        modelFlavorSelect.disabled = true;
        processBtn.disabled = true;
        await loadFlavor(flavorId);
        modelFlavorSelect.disabled = false;
        processBtn.disabled = !audioBuffer;
    });
}

async function handleFile(file) {
    audioFileName.textContent = file.name;
    status.textContent = 'Reading audio...';

    try {
        const arrayBuffer = await file.arrayBuffer();
        audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
        const duration = audioBuffer.duration.toFixed(1);
        status.textContent = `Loaded: ${duration}s - Ready to extract`;
        processBtn.disabled = false;
    } catch (e) {
        status.textContent = 'Failed to read audio: ' + e.message;
        console.error('Failed to decode audio:', e);
    }
}

processBtn.addEventListener('click', startProcessing);

async function startProcessing() {
    if (!audioBuffer || !processor || isProcessing) return;

    isProcessing = true;
    processBtn.disabled = true;
    processBtn.textContent = 'Processing...';
    results.classList.remove('visible');
    processStartTime = Date.now();
    statusDetail.innerHTML = '';
    statusDetail.classList.add('visible');
    statsRow.classList.add('visible');

    try {
        log('Init', 'Starting stem extraction...');
        status.textContent = 'Preparing audio...';
        progressFill.style.width = '2%';

        let leftChannel = audioBuffer.getChannelData(0);
        let rightChannel = audioBuffer.numberOfChannels > 1
            ? audioBuffer.getChannelData(1)
            : leftChannel;

        if (audioBuffer.sampleRate !== SAMPLE_RATE) {
            log('Resample', `${audioBuffer.sampleRate}Hz → ${SAMPLE_RATE}Hz`);
            const ratio = SAMPLE_RATE / audioBuffer.sampleRate;
            const newLength = Math.floor(leftChannel.length * ratio);
            const newLeft = new Float32Array(newLength);
            const newRight = new Float32Array(newLength);

            for (let i = 0; i < newLength; i++) {
                const srcIdx = i / ratio;
                const idx0 = Math.floor(srcIdx);
                const idx1 = Math.min(idx0 + 1, leftChannel.length - 1);
                const frac = srcIdx - idx0;
                newLeft[i] = leftChannel[idx0] * (1 - frac) + leftChannel[idx1] * frac;
                newRight[i] = rightChannel[idx0] * (1 - frac) + rightChannel[idx1] * frac;
            }

            leftChannel = newLeft;
            rightChannel = newRight;
        }

        status.textContent = 'Extracting stems...';
        const separatedTracks = await processor.separate(leftChannel, rightChannel);
        displayResults(separatedTracks);

        const totalTime = ((Date.now() - processStartTime) / 1000).toFixed(1);
        const speedRatio = (audioBuffer.duration / parseFloat(totalTime)).toFixed(2);

        log('Done', `Completed in ${totalTime}s (${speedRatio}x realtime)`);
        status.textContent = `Complete! Extracted ${Object.keys(separatedTracks).length} stems in ${totalTime}s`;
        progressFill.style.width = '100%';

    } catch (e) {
        status.textContent = 'Processing failed: ' + e.message;
        console.error('Processing failed:', e);
    }

    isProcessing = false;
    processBtn.disabled = false;
    processBtn.textContent = 'Extract Stems';
}

// Store track URLs for download all feature
let trackUrls = {};
let trackBuffers = {};

function displayResults(tracks) {
    trackList.innerHTML = '';
    trackUrls = {};
    trackBuffers = {};

    // 'other' recoit un symbole musical generique plutot que 🎹 — libere
    // pour la piste piano, qui en a l'usage semantique bien plus direct
    // (variante 6 pistes, voir MODEL_FLAVORS). 'guitar' utilise 🪕, faute
    // d'emoji distinct pour guitare electrique/acoustique face a 🎸 deja
    // pris par bass.
    const TRACK_CONFIG = {
        drums: { icon: '🥁', label: 'Drums' },
        bass: { icon: '🎸', label: 'Bass' },
        other: { icon: '🎵', label: 'Instrumental' },
        vocals: { icon: '🎤', label: 'Vocals' },
        guitar: { icon: '🪕', label: 'Guitar' },
        piano: { icon: '🎹', label: 'Piano' }
    };

    for (const [name, track] of Object.entries(tracks)) {
        const config = TRACK_CONFIG[name] || { icon: '🎵', label: name };
        const trackBuffer = audioContext.createBuffer(2, track.left.length, SAMPLE_RATE);
        trackBuffer.getChannelData(0).set(track.left);
        trackBuffer.getChannelData(1).set(track.right);

        const audioBlob = audioBufferToWav(trackBuffer);
        const audioUrl = URL.createObjectURL(audioBlob);
        const trackId = `track-${name}`;
        const fileName = config.label.toLowerCase();

        // Store for download all
        trackUrls[fileName] = audioUrl;
        trackBuffers[trackId] = { left: track.left, right: track.right, label: config.label };

        const trackDiv = document.createElement('div');
        trackDiv.className = 'track';
        trackDiv.innerHTML = `
            <div class="track-row">
                <div class="track-info">
                    <div class="track-icon ${name}">${config.icon}</div>
                    <div>
                        <div class="track-name">${config.label}</div>
                        <div class="track-duration">${formatTime(trackBuffer.duration)}</div>
                    </div>
                </div>

                <div class="track-player">
                    <button id="play-${trackId}" class="play-btn" onclick="togglePlay('${trackId}')">
                        <svg fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                    </button>

                    <div id="progress-bg-${trackId}" class="track-progress" onclick="seekTrack(event, '${trackId}')">
                        <div id="progress-${trackId}" class="track-progress-fill ${name}"></div>
                    </div>

                    <span id="time-${trackId}" class="track-time">0:00 / ${formatTime(trackBuffer.duration)}</span>
                </div>

                <a href="${audioUrl}" download="${fileName}.wav" class="download-btn">
                    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
                    </svg>
                    WAV
                </a>
                <button id="midi-btn-${trackId}" class="download-btn" onclick="convertToMidi('${trackId}')" title="Convertir ${config.label} en MIDI">
                    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2z"/>
                    </svg>
                    MIDI
                </button>
                <button id="edit-btn-${trackId}" class="download-btn" onclick="openInEditor('${trackId}')" title="Ouvrir ${config.label} dans l'editeur audio">
                    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
                    </svg>
                    Editer
                </button>
            </div>

            <audio id="audio-${trackId}" src="${audioUrl}" preload="metadata"></audio>
        `;

        trackList.appendChild(trackDiv);

        const audio = document.getElementById(`audio-${trackId}`);
        audio.addEventListener('timeupdate', () => updateProgress(trackId, audio));
        audio.addEventListener('ended', () => resetPlayer(trackId));
    }

    results.classList.add('visible');
}

// Convertit un stem en MIDI via le serveur (route /api/midi/convert, basic-
// pitch dans son venv isole — voir encodeWavStereo ci-dessus). Progression
// moins fine qu'avec l'ancienne tentative navigateur (pas de rappel par
// image), mais sans objet : la conversion complete prend maintenant
// quelques secondes, pas assez long pour justifier une barre detaillee.
window.convertToMidi = async function(trackId) {
    const btn = document.getElementById(`midi-btn-${trackId}`);
    const buf = trackBuffers[trackId];
    if (!buf || !btn) return;
    const originalLabel = btn.innerHTML;
    btn.disabled = true;
    try {
        btn.innerHTML = '...';
        const wavBlob = encodeWavStereo(buf.left, buf.right, SAMPLE_RATE);
        const formData = new FormData();
        formData.append('audio', wavBlob, `${buf.label}.wav`);

        const response = await fetch('/api/midi/convert', {
            method: 'POST',
            body: formData,
        });

        const contentType = response.headers.get('Content-Type') || '';
        if (contentType.includes('application/json')) {
            const data = await response.json();
            if (data.warning) {
                // Pas une erreur : un stem tres calme peut legitimement ne
                // produire aucune note detectee (voir basic_pitch_convert.py).
                alert(data.warning);
                return;
            }
            throw new Error(data.error || 'Echec de la conversion MIDI.');
        }
        if (!response.ok) {
            throw new Error(`Le serveur a repondu ${response.status}.`);
        }

        const midiBlob = await response.blob();
        const midiUrl = URL.createObjectURL(midiBlob);
        const a = document.createElement('a');
        a.href = midiUrl;
        a.download = `${buf.label.toLowerCase()}.mid`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(midiUrl);
    } catch (err) {
        console.error('MIDI conversion failed:', err);
        alert(`Echec de la conversion MIDI : ${err.message || err}`);
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalLabel;
    }
};

// Ouvre un stem dans l'editeur audio AudioMass (page /editor, SEPAREE de
// cette page). Un stem n'existe qu'en memoire ici (trackBuffers) — jamais
// de fichier serveur, et une URL blob: creee dans CETTE page ne serait pas
// valide dans /editor. On encode en WAV (meme encodeWavStereo que pour le
// MIDI), on depose temporairement via /api/audio-editor/stage (purge
// automatique cote serveur apres quelques minutes), et on ouvre l'editeur
// avec cette vraie URL HTTP.
window.openInEditor = async function(trackId) {
    const btn = document.getElementById(`edit-btn-${trackId}`);
    const buf = trackBuffers[trackId];
    if (!buf || !btn) return;
    const originalLabel = btn.innerHTML;
    btn.disabled = true;
    try {
        btn.innerHTML = '...';
        const wavBlob = encodeWavStereo(buf.left, buf.right, SAMPLE_RATE);
        const formData = new FormData();
        formData.append('audio', wavBlob, `${buf.label}.wav`);

        const response = await fetch('/api/audio-editor/stage', {
            method: 'POST',
            body: formData,
        });
        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.error || `Le serveur a repondu ${response.status}.`);
        }

        window.open(`/editor?audioUrl=${encodeURIComponent(data.url)}`, '_blank');
    } catch (err) {
        console.error('Open in editor failed:', err);
        alert(`Echec de l'ouverture dans l'editeur : ${err.message || err}`);
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalLabel;
    }
};

// Ouvre les QUATRE stems ensemble dans l'editeur, comme pistes separees
// (mode multitrack — voir la mise a jour AudioMass et le correctif
// ?audioUrls= dans app/server/audio-editor/app.js). Depose chaque stem en
// parallele (Promise.all), puis construit une seule URL combinee — chaque
// URL de depot est encodee INDIVIDUELLEMENT avant d'etre jointe par des
// virgules, pour eviter toute ambiguite si l'une d'elles contenait deja
// une virgule.
window.openAllInEditor = async function() {
    const btn = document.getElementById('editAll-btn');
    const entries = Object.entries(trackBuffers);
    if (entries.length === 0 || !btn) return;
    const originalLabel = btn.innerHTML;
    btn.disabled = true;
    try {
        btn.innerHTML = '...';

        const staged = await Promise.all(entries.map(async ([trackId, buf]) => {
            const wavBlob = encodeWavStereo(buf.left, buf.right, SAMPLE_RATE);
            const formData = new FormData();
            formData.append('audio', wavBlob, `${buf.label}.wav`);

            const response = await fetch('/api/audio-editor/stage', {
                method: 'POST',
                body: formData,
            });
            const data = await response.json();
            if (!response.ok) {
                throw new Error(data.error || `Le serveur a repondu ${response.status} pour ${buf.label}.`);
            }
            return { url: data.url, label: buf.label };
        }));

        const audioUrls = staged.map((s) => encodeURIComponent(s.url)).join(',');
        const audioNames = staged.map((s) => encodeURIComponent(s.label)).join(',');

        window.open(`/editor?audioUrls=${audioUrls}&audioNames=${audioNames}`, '_blank');
    } catch (err) {
        console.error('Open all in editor failed:', err);
        alert(`Echec de l'ouverture dans l'editeur : ${err.message || err}`);
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalLabel;
    }
};

window.downloadAllStems = function() {
    const entries = Object.entries(trackUrls);
    let index = 0;

    function downloadNext() {
        if (index >= entries.length) return;
        const [name, url] = entries[index];
        const a = document.createElement('a');
        a.href = url;
        a.download = `${name}.wav`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        index++;
        setTimeout(downloadNext, 500);
    }

    downloadNext();
};

// Player functions (global scope for onclick handlers)
window.togglePlay = function(trackId) {
    const audio = document.getElementById(`audio-${trackId}`);
    const playBtn = document.getElementById(`play-${trackId}`);

    // Pause all other tracks
    document.querySelectorAll('audio').forEach(a => {
        if (a.id !== `audio-${trackId}` && !a.paused) {
            a.pause();
            const otherId = a.id.replace('audio-', '');
            resetPlayer(otherId);
        }
    });

    if (audio.paused) {
        audio.play();
        playBtn.innerHTML = `<svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M6 4h4v16H6zm8 0h4v16h-4z"/></svg>`;
    } else {
        audio.pause();
        playBtn.innerHTML = `<svg class="w-4 h-4 ml-0.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>`;
    }
};

window.seekTrack = function(event, trackId) {
    const audio = document.getElementById(`audio-${trackId}`);
    const progressBg = document.getElementById(`progress-bg-${trackId}`);
    const rect = progressBg.getBoundingClientRect();
    const percent = (event.clientX - rect.left) / rect.width;
    audio.currentTime = percent * audio.duration;
};

function updateProgress(trackId, audio) {
    const progress = document.getElementById(`progress-${trackId}`);
    const timeDisplay = document.getElementById(`time-${trackId}`);
    const percent = (audio.currentTime / audio.duration) * 100;
    progress.style.width = `${percent}%`;
    timeDisplay.textContent = `${formatTime(audio.currentTime)} / ${formatTime(audio.duration)}`;
}

function resetPlayer(trackId) {
    const playBtn = document.getElementById(`play-${trackId}`);
    const progress = document.getElementById(`progress-${trackId}`);
    playBtn.innerHTML = `<svg class="w-4 h-4 ml-0.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>`;
    progress.style.width = '0%';
}

function audioBufferToWav(buffer) {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const bitDepth = 16;
    const bytesPerSample = bitDepth / 8;
    const blockAlign = numChannels * bytesPerSample;
    const samples = buffer.length;
    const dataSize = samples * blockAlign;
    const bufferSize = 44 + dataSize;

    const arrayBuffer = new ArrayBuffer(bufferSize);
    const view = new DataView(arrayBuffer);

    const writeString = (offset, string) => {
        for (let i = 0; i < string.length; i++) {
            view.setUint8(offset + i, string.charCodeAt(i));
        }
    };

    writeString(0, 'RIFF');
    view.setUint32(4, bufferSize - 8, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitDepth, true);
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);

    const channels = [];
    for (let c = 0; c < numChannels; c++) {
        channels.push(buffer.getChannelData(c));
    }

    let offset = 44;
    for (let i = 0; i < samples; i++) {
        for (let c = 0; c < numChannels; c++) {
            const sample = Math.max(-1, Math.min(1, channels[c][i]));
            const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
            view.setInt16(offset, intSample, true);
            offset += 2;
        }
    }

    return new Blob([arrayBuffer], { type: 'audio/wav' });
}

init();
