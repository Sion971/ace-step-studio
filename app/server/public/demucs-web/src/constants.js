/**
 * Constants for Demucs model
 */
export const CONSTANTS = {
  SAMPLE_RATE: 44100,
  FFT_SIZE: 4096,
  HOP_SIZE: 1024,
  TRAINING_SAMPLES: 343980,
  MODEL_SPEC_BINS: 2048,
  MODEL_SPEC_FRAMES: 336,
  SEGMENT_OVERLAP: 0.25,
  TRACKS: ['drums', 'bass', 'other', 'vocals'],

  // Default model URL (Hugging Face Hub)
  DEFAULT_MODEL_URL: 'https://huggingface.co/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx'
};

// Deux variantes de modele disponibles — choix laisse a l'utilisateur plutot
// qu'un remplacement pur et simple du 4 pistes existant : Meta decrit
// eux-memes htdemucs_6s comme experimental, la piste piano en particulier
// souffrant de "beaucoup de fuites et d'artefacts" (leurs mots). TRACKS et
// DEFAULT_MODEL_URL ci-dessus restent inchanges (= la variante 4 pistes),
// pour ne rien casser ailleurs dans le code qui les importe directement.
//
// localUrl suit exactement la convention deja en place pour le modele 4
// pistes (LOCAL_MODEL_URL dans app.js) — prealablement depose sur le
// disque, jamais telecharge automatiquement a l'installation pour celui-ci
// specifiquement (258 Mo, choix delibere : uniquement a la demande, la
// premiere fois que l'utilisateur choisit cette option).
export const MODEL_FLAVORS = {
  htdemucs: {
    id: 'htdemucs',
    tracks: ['drums', 'bass', 'other', 'vocals'],
    localUrl: '../models/htdemucs_embedded.onnx',
    remoteUrl: 'https://huggingface.co/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx',
    label: '4 pistes (standard)',
    sizeLabel: '~173 Mo',
  },
  htdemucs_6s: {
    id: 'htdemucs_6s',
    tracks: ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano'],
    localUrl: '../models/htdemucs_6s.onnx',
    // Variante fp32 complete (258 Mo), pas la fp16 (136 Mo) : test reel
    // concluant que la taille du fichier n'etait pas le facteur limitant
    // (echec identique "Aborted()" WASM aux deux tailles, et a 1 comme 4
    // threads — la documentation du modele l'annoncait deja : "same
    // runtime memory / latency"). Autant garder la meilleure qualite
    // disponible pour les machines qui ont assez de memoire, plutot que
    // sacrifier la qualite sans benefice reel. Echoue en pratique sur
    // machine a 16 Go de RAM deja chargee (11 Go utilises, swap actif) —
    // devrait fonctionner sur une machine avec davantage de marge.
    remoteUrl: 'https://huggingface.co/StemSplitio/htdemucs-6s-onnx/resolve/main/htdemucs_6s.onnx',
    label: '6 pistes — guitare + piano (experimental)',
    sizeLabel: '~258 Mo',
  }
};

