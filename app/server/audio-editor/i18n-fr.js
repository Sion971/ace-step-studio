/*
 * Traduction française de l'interface d'AudioMass (ACE-Step Studio).
 *
 * Les textes d'AudioMass sont écrits en dur dans ses scripts : plutôt que de les modifier (ce qui compliquerait chaque
 * mise à jour du programme), ce fichier remplace à l'écran les textes anglais par leur version française, y compris
 * ceux des fenêtres et des messages créés plus tard. Un texte absent du dictionnaire reste en anglais.
 *
 * Langue : paramètre ?lang=fr de l'adresse, sinon la langue de l'application (localStorage "language", même origine),
 * sinon celle du navigateur (l'application la suit tant qu'aucune langue n'a été choisie à la main).
 * Un changement de langue dans l'application est suivi sans recharger l'éditeur (événement "storage").
 */
(function (w, d) {
'use strict';

var FR = {
	/* ---- Fenêtres d'analyse et mixeur ---- */
	'AudioMass - Audio Editor': 'AudioMass - Éditeur audio',
	'AudioMass - Frequency Analysis': 'AudioMass - Analyse de fréquences',
	'AudioMass - Spectrum Analyzer': 'AudioMass - Analyseur de spectre',
	'AudioMass - Multitrack Mixer': 'AudioMass - Mixeur multipiste',
	'FREQUENCY ANALYSER': 'ANALYSEUR DE FRÉQUENCES',
	'SPECTRUM ANALYSER': 'ANALYSEUR DE SPECTRE',
	'MULTITRACK MIXER': 'MIXEUR MULTIPISTE',
	'OPEN MULTITRACK': 'OUVRIR LE MULTIPISTE',
	'DOCK': 'ANCRER',
	'UNDOCK': 'DÉSANCRER',
	'level': 'niveau',

	/* ---- Menus ---- */
	'File': 'Fichier',
	'Export / Download': 'Exporter / Télécharger',
	'Load from Computer': 'Charger depuis l\'ordinateur',
	'Load Sample File': 'Charger un fichier exemple',
	'Load From URL': 'Charger depuis une URL',
	'New Recording': 'Nouvel enregistrement',
	'Save Draft Locally': 'Enregistrer un brouillon local',
	'Open Local Drafts': 'Ouvrir les brouillons locaux',
	'Edit': 'Édition',
	'Undo': 'Annuler',
	'Redo': 'Rétablir',
	'Play': 'Lecture',
	'Space': 'Espace',
	'Stop': 'Arrêt',
	'Select All': 'Tout sélectionner',
	'Deselect All': 'Tout désélectionner',
	'Channel Info/Flip': 'Infos du canal / Inversion',
	'Seamless Loop': 'Boucle parfaite',
	'Seamless Loop...': 'Boucle parfaite...',
	'Zero Cross Selection': 'Sélection aux passages par zéro',
	'Zero Cross Selection Off': 'Sélection aux passages par zéro désactivée',
	'Effects': 'Effets',
	'Gain': 'Gain',
	'Fade In': 'Fondu en entrée',
	'Fade Out': 'Fondu en sortie',
	'Noise Reduction (Voice)': 'Réduction de bruit (voix)',
	'Paragraphic EQ': 'Égaliseur paragraphique',
	'Compressor': 'Compresseur',
	'Normalize': 'Normaliser',
	'Graphic EQ': 'Égaliseur graphique',
	'Graphic EQ (20 bands)': 'Égaliseur graphique (20 bandes)',
	'Hard Limiter': 'Limiteur strict',
	'Delay': 'Délai',
	'Distortion': 'Distorsion',
	'Reverb': 'Réverbération',
	'Audio Repair': 'Réparation audio',
	'Speed Up / Slow Down (pitch)': 'Accélérer / Ralentir (hauteur)',
	'Speed / Playback Rate': 'Vitesse / Taux de lecture',
	'Reverse': 'Inverser le sens',
	'Invert': 'Inverser la polarité',
	'Remove Silence': 'Supprimer les silences',
	'View': 'Affichage',
	'Follow Cursor': 'Suivre le curseur',
	'Peak Separators': 'Séparateurs de crêtes',
	'Timeline': 'Chronologie',
	'Frequency Analyser': 'Analyseur de fréquences',
	'Spectrum Analyser': 'Analyseur de spectre',
	'Multitrack Mixer': 'Mixeur multipiste',
	'Tempo Tools': 'Outils de tempo',
	'ID3 Tags': 'Tags ID3',
	'Center to Cursor': 'Centrer sur le curseur',
	'Reset Zoom': 'Réinitialiser le zoom',
	'Select Visible View': 'Sélectionner la zone visible',
	'Help': 'Aide',
	'Store Offline Version': 'Enregistrer la version hors ligne',
	'Update Offline Version': 'Mettre à jour la version hors ligne',
	'About': 'À propos',
	'About AudioMass': 'À propos d\'AudioMass',
	'See Welcome Message': 'Afficher le message d\'accueil',
	'SourceCode on Github': 'Code source sur GitHub',
	'MultiTrack': 'Multipiste',
	'Beta': 'Bêta',

	/* ---- Barre d'outils ---- */
	'Stop Playback (Space)': 'Arrêter la lecture (Espace)',
	'Play (Space)': 'Lecture (Espace)',
	'Pause (Shift+Space)': 'Pause (Maj+Espace)',
	'Toggle Loop (L)': 'Activer / désactiver la boucle (L)',
	'Seek (left arrow)': 'Reculer (flèche gauche)',
	'Seek (right arrow)': 'Avancer (flèche droite)',
	'Seek Start (Shift + left arrow)': 'Aller au début (Maj + flèche gauche)',
	'Seek End (Shift + right arrow)': 'Aller à la fin (Maj + flèche droite)',
	'Record (R)': 'Enregistrer (R)',
	'Copy Selection (Shift + C)': 'Copier la sélection (Maj + C)',
	'Paste Selection (Shift + V)': 'Coller la sélection (Maj + V)',
	'Cut Selection (Shift + X)': 'Couper la sélection (Maj + X)',
	'Insert Silence (Shift + N)': 'Insérer du silence (Maj + N)',
	'Selection:': 'Sélection :',
	'Start:': 'Début :',
	'End:': 'Fin :',
	'Duration:': 'Durée :',
	'Clear Selection (Q key)': 'Effacer la sélection (touche Q)',
	'BEAT': 'TEMPS',
	'Toggle Beat Markers': 'Afficher / masquer les repères de temps',
	'SNAP': 'ALIGN.',
	'Snap to Beat Markers': 'Aligner sur les repères de temps',
	'Time Signature': 'Signature rythmique',
	'Drag n drop an Audio File in this window, or click': 'Glissez-déposez un fichier audio dans cette fenêtre, ou cliquez',
	'Drag and Drop Audio Files in this window, or click': 'Glissez-déposez des fichiers audio dans cette fenêtre, ou cliquez',
	'here to use a sample': 'ici pour utiliser un exemple',
	'Add Channel': 'Ajouter un canal',
	'Channels': 'Canaux',
	'Clear Mute': 'Annuler tous les muets',
	'Clear Solo': 'Annuler tous les solos',
	'Mute': 'Muet',
	'Solo': 'Solo',
	'Volume': 'Volume',
	'Pan L/R': 'Pan G/D',
	'Rec Trigger': 'Déclencheur d\'enreg.',
	'Delete Channel': 'Supprimer le canal',
	'Zoom In Horiz (+)': 'Zoom avant horizontal (+)',
	'Zoom Out Horiz (-)': 'Zoom arrière horizontal (-)',
	'Reset Zoom (0)': 'Réinitialiser le zoom (0)',
	'Reset Zoom [0]': 'Réinitialiser le zoom [0]',
	'[R] Reset Zoom (0)': '[R] Réinitialiser le zoom (0)',
	'Center to Cursor [Tab]': 'Centrer sur le curseur [Tab]',
	'Zoom In Vertically': 'Zoom avant vertical',
	'Zoom Out Vertically': 'Zoom arrière vertical',
	'Please Wait...': 'Veuillez patienter...',
	'cancel': 'annuler',
	'Cancel': 'Annuler',
	'CANCEL': 'ANNULER',
	'OK': 'OK',
	'Save': 'Enregistrer',
	'Apply': 'Appliquer',
	'Preview': 'Aperçu',
	'Presets': 'Réglages',
	'Reset': 'Réinitialiser',
	'Custom': 'Personnalisé',
	'Update': 'Mettre à jour',
	'Delete': 'Supprimer',
	'Copy': 'Copier',
	'Paste': 'Coller',
	'Mono': 'Mono',
	'Stereo': 'Stéréo',

	/* ---- Accueil ---- */
	'Welcome to AudioMass': 'Bienvenue dans AudioMass',
	'AudioMass is a free, open source, web-based Audio and Waveform Editor.': 'AudioMass est un éditeur audio et de formes d\'onde libre, gratuit et fonctionnant dans le navigateur.',
	'It runs entirely in the browser with no backend and no plugins required!': 'Il tourne entièrement dans le navigateur, sans serveur ni module externe !',
	'Tips:': 'Astuces :',
	'Please keep in mind that most key shortcuts rely on the': 'Gardez à l\'esprit que la plupart des raccourcis clavier reposent sur la combinaison',
	'Shift +': 'Maj +',
	'key': 'touche',
	'combo. (eg Shift+Z for undo, Shift+C copy, Shift+X cut... etc )': '(par ex. Maj+Z pour annuler, Maj+C pour copier, Maj+X pour couper, etc.)',
	'You can load any type of audio your browser supports and perform operations such as fade in, cut, trim, change the volume, and apply a plethora of audio effects.': 'Vous pouvez charger tout type d\'audio pris en charge par votre navigateur et effectuer des opérations comme un fondu, une coupe, un rognage, un changement de volume, ou appliquer une multitude d\'effets audio.',
	'Check out the codebase on': 'Le code source est disponible sur',
	'I hope you enjoy the little music pieces. I wrote them a long time ago :)': 'J\'espère que vous apprécierez les petits morceaux de musique, écrits il y a longtemps :)',
	'(Optimized for desktop - sorry)': '(Optimisé pour ordinateur - désolé)',

	/* ---- Fichier : fenêtres ---- */
	'Load audio from remote url': 'Charger un audio depuis une URL distante',
	'Insert url': 'Saisir l\'URL',
	'Please insert url': 'Veuillez saisir une URL',
	'Load Asset': 'Charger le fichier',
	'Invalid URL entered': 'URL saisie invalide',
	'Devices:': 'Périphériques :',
	'Time': 'Durée',
	'Waveform': 'Forme d\'onde',
	'START RECORDING': 'ENREGISTRER',
	'PAUSE': 'PAUSE',
	'OPEN RECORDING': 'OUVRIR L\'ENREGISTREMENT',
	'Open Recording': 'Ouvrir l\'enregistrement',
	'APPEND TO EXISTING': 'AJOUTER À L\'EXISTANT',
	'FINISH RECORDING': 'TERMINER L\'ENREGISTREMENT',
	'STAND BY...': 'PATIENTEZ...',
	'Save Local Draft of...': 'Enregistrer un brouillon local de...',
	'Please choose source...': 'Choisissez la source...',
	'Whole Track': 'Piste entière',
	'Whole track': 'Piste entière',
	'Selection': 'Sélection',
	'"Copy" clipboard/buffer': 'Presse-papiers « Copier »',
	'Draft Name': 'Nom du brouillon',
	'(optional) filename': '(facultatif) nom du fichier',
	'Local Drafts': 'Brouillons locaux',
	'No drafts found...': 'Aucun brouillon trouvé...',
	'Channel Info': 'Infos du canal',
	'Make Mono': 'Convertir en mono',
	'Left Channel': 'Canal gauche',
	'Right Channel': 'Canal droit',
	'Flip Channels': 'Inverser les canaux',
	'Make Stereo': 'Convertir en stéréo',
	'Apply Changes': 'Appliquer les modifications',
	'Applied Channel Change:': 'Changement de canal appliqué :',
	'Preview Loop': 'Aperçu de la boucle',
	'Crossfade': 'Fondu enchaîné',
	'Repeat loop': 'Répéter la boucle',
	'Trim edge silence': 'Rogner le silence des bords',
	'Snap to zero crossing': 'Aligner sur les passages par zéro',
	'Open in New Editor': 'Ouvrir dans un nouvel éditeur',
	'Opened Seamless Loop': 'Boucle parfaite ouverte',
	'Export': 'Exporter',
	'File Name': 'Nom du fichier',
	'Format': 'Format',
	'(44100hz)': '(44100 Hz)',
	'wav (44100hz)': 'wav (44100 Hz)',
	'session file (.amss)': 'fichier de session (.amss)',
	'Flac: Compression Level': 'Flac : niveau de compression',
	'16-bit': '16 bits',
	'24-bit': '24 bits',
	'32-bit float': '32 bits flottant',
	'TPDF dither': 'Dither TPDF',
	'Export whole file': 'Exporter le fichier entier',
	'Export Selection Only': 'Exporter la sélection uniquement',
	'mp3 filename': 'nom du fichier mp3',
	'Nothing to export': 'Rien à exporter',
	'Open or append': 'Ouvrir ou ajouter',
	'Append file to existing track?': 'Ajouter le fichier à la piste existante ?',
	'Open Audio': 'Ouvrir l\'audio',
	'Record Audio': 'Enregistrer l\'audio',
	'OPEN NEW': 'OUVRIR UN NOUVEAU',
	'ADD IN EXISTING': 'AJOUTER À L\'EXISTANT',
	'Open in new window, or in the current one?': 'Ouvrir dans une nouvelle fenêtre ou dans la fenêtre actuelle ?',
	'Open in new window?': 'Ouvrir dans une nouvelle fenêtre ?',
	'Open in Existing?': 'Ouvrir dans l\'existant ?',
	'OPEN IN NEW': 'OUVRIR DANS UN NOUVEAU',
	'OPEN IN NEW WINDOW': 'OUVRIR DANS UNE NOUVELLE FENÊTRE',
	'Open Offline Version?': 'Ouvrir la version hors ligne ?',
	'Downloading newer version': 'Téléchargement de la version plus récente',
	'Would you like to refresh the page to load the newer version?': 'Voulez-vous recharger la page pour charger la version plus récente ?',
	'This will open a new window that will try to store a local version in your browser': 'Une nouvelle fenêtre va s\'ouvrir et tenter d\'enregistrer une version locale dans votre navigateur',
	'Succesfully Stored': 'Enregistré avec succès',
	'Oops! Something is not right': 'Oups ! Quelque chose ne va pas',

	/* ---- Effets : fenêtres ---- */
	'Apply Gain to selected range': 'Gain sur la plage sélectionnée',
	'Toggle Bypass': 'Activer / désactiver le contournement',
	'Gain percentage': 'Gain en pourcentage',
	'Apply Gain': 'Appliquer le gain',
	'Silence': 'Silence',
	'Save or Modify preset': 'Enregistrer ou modifier le préréglage',
	'type': 'type',
	'gain': 'gain',
	'freq': 'fréq.',
	'Apply EQ': 'Appliquer l\'égaliseur',
	'Old Telephone': 'Vieux téléphone',
	'AM Radio': 'Radio AM',
	'Megaphone': 'Mégaphone',
	'Underwater': 'Sous l\'eau',
	'Lo-Fi / Vintage': 'Lo-fi / Vintage',
	'Bass Boost': 'Renfort des basses',
	'Vocal Presence': 'Présence vocale',
	'Loudness (Smile)': 'Loudness (sourire)',
	'Air / Brilliance': 'Air / Brillance',
	'De-Rumble': 'Anti-grondement',
	'Podcast Voice': 'Voix de podcast',
	'De-Esser': 'Dé-esseur',
	'Drum Punch': 'Punch de batterie',
	'Acoustic Sparkle': 'Éclat acoustique',
	'Apply Compression to selected range': 'Compression de la plage sélectionnée',
	'Threshold': 'Seuil',
	'Knee': 'Coude',
	'Ratio': 'Ratio',
	'Attack': 'Attaque',
	'Release': 'Relâchement',
	'Makeup': 'Compensation',
	'Reduction': 'Réduction',
	'Vocal — Lead': 'Voix — principale',
	'Vocal — Broadcast': 'Voix — diffusion',
	'Drum Bus Glue': 'Cohésion du bus batterie',
	'Snare Punch': 'Punch de caisse claire',
	'Kick Tighten': 'Grosse caisse resserrée',
	'Bass Even-Out': 'Basse régulière',
	'Acoustic Smooth': 'Acoustique lissée',
	'Master Glue': 'Cohésion du master',
	'Heavy Crush': 'Écrasement fort',
	'Brickwall Limit': 'Limitation brickwall',
	'Classic 3:1': 'Classique 3:1',
	'Light Touch': 'Touche légère',
	'Classic': 'Classique',
	'Dashed Distortion': 'Distorsion hachée',
	'Mode': 'Mode',
	'Peak': 'Crête',
	'RMS': 'RMS',
	'LUFS': 'LUFS',
	'Normalize L/R Equally': 'Normaliser G/D de façon égale',
	'Normalize to': 'Normaliser à',
	'Target': 'Cible',
	'Custom LUFS': 'LUFS personnalisé',
	'Peak ceiling': 'Plafond de crête',
	'Analysis': 'Analyse',
	'Measuring...': 'Mesure en cours...',
	'Club / DJ Master (-8 LUFS)': 'Club / master DJ (-8 LUFS)',
	'Broadcast EBU R128 (-23 LUFS)': 'Diffusion EBU R128 (-23 LUFS)',
	'Broadcast ATSC A/85 (-24 LUFS)': 'Diffusion ATSC A/85 (-24 LUFS)',
	'Podcast (-16 LUFS)': 'Podcast (-16 LUFS)',
	'Treble Boost': 'Renfort des aigus',
	'Vocal Clarity': 'Clarté vocale',
	'Podcast': 'Podcast',
	'Warm': 'Chaud',
	'Bright': 'Brillant',
	'V-Shape': 'En V',
	'Loudness': 'Loudness',
	'Hip Hop': 'Hip-hop',
	'Acoustic': 'Acoustique',
	'Rumble Cut': 'Coupe anti-grondement',
	'Telephone': 'Téléphone',
	'Old Radio': 'Vieille radio',
	'Lo Fi': 'Lo-fi',
	'De-Hiss': 'Anti-souffle',
	'Air': 'Air',
	'Hard Limiting': 'Limitation stricte',
	'Limit to': 'Limiter à',
	'Ratio between lows and highs': 'Rapport graves / aigus',
	'Look Ahead (ms)': 'Anticipation (ms)',
	'Apply Delay to selected range': 'Délai sur la plage sélectionnée',
	'Delay Time': 'Temps de délai',
	'Feedback': 'Rétroaction',
	'Wet': 'Signal traité',
	'Spacey': 'Spatial',
	'Apply Distortion to selected range': 'Distorsion de la plage sélectionnée',
	'Apply Reverb to selected range': 'Réverbération de la plage sélectionnée',
	'Decay': 'Déclin',
	'Small Room': 'Petite pièce',
	'Medium Room': 'Pièce moyenne',
	'Large Hall': 'Grande salle',
	'Cathedral': 'Cathédrale',
	'Plate': 'Plaque',
	'Vocal Booth': 'Cabine vocale',
	'Drum Chamber': 'Chambre de batterie',
	'Ambient Wash': 'Nappe ambiante',
	'Tight Slap': 'Slap serré',
	'Cave': 'Grotte',
	'Click Reduction': 'Réduction des clics',
	'Hum Reduction': 'Réduction du bourdonnement',
	'Edit Repair': 'Réparation de montage',
	'Sensitivity': 'Sensibilité',
	'Low': 'Faible',
	'Medium': 'Moyenne',
	'High': 'Élevée',
	'Removes short transient clicks': 'Supprime les clics transitoires courts',
	'(vinyl pops, mouth clicks) by detecting': '(craquements de vinyle, bruits de bouche) en détectant',
	'energy spikes and interpolating across them.': 'les pics d\'énergie et en interpolant à travers.',
	'Mains frequency': 'Fréquence du secteur',
	'50 Hz': '50 Hz',
	'60 Hz': '60 Hz',
	'Auto-detect': 'Détection auto',
	'Notches out the mains hum and seven': 'Filtre le bourdonnement du secteur et ses sept',
	'harmonics. Auto-detect scans the selection': 'harmoniques. La détection auto analyse la sélection',
	'and locks to the actual hum frequency.': 'et se cale sur la fréquence réelle du bourdonnement.',
	'Smooths DC-offset splices between joined': 'Lisse les raccords à décalage continu entre des',
	'audio of similar energy. Use after pasting': 'audios d\'énergie similaire. À utiliser après avoir collé',
	'from another source. Not for note onsets.': 'depuis une autre source. Pas pour les attaques de notes.',
	'Audio Repair is not available in multitrack': 'La réparation audio n\'est pas disponible en multipiste',
	'Edit Repair: smoothed': 'Réparation de montage : lissé',
	'Hum Notch': 'Filtre anti-bourdonnement',
	'Hz hum': 'Hz de bourdonnement',
	'Notched': 'Filtré',
	'Pitch / Speed Profile': 'Profil de hauteur / vitesse',
	'Playback Rate': 'Taux de lecture',
	'AUTOMATE': 'AUTOMATISER',
	'Apply Profile': 'Appliquer le profil',
	'Slightly slower': 'Un peu plus lent',
	'Slightly faster': 'Un peu plus rapide',
	'Doppler Pass': 'Passage Doppler',
	'Accelerate': 'Accélération',
	'Engine Rev': 'Montée de moteur',
	'Car Approaching': 'Voiture qui approche',
	'Car Driving Away': 'Voiture qui s\'éloigne',
	'Change Speed': 'Changer la vitesse',
	'Apply Rate': 'Appliquer le taux',
	'A lot slower': 'Beaucoup plus lent',
	'Blazing Fast': 'Ultra rapide',
	'Stretch ratio must be positive': 'Le rapport d\'étirement doit être positif',
	'Could not apply Speed': 'Impossible d\'appliquer la vitesse',
	'Could not download noise Reduction script': 'Impossible de télécharger le script de réduction de bruit',
	'Please wait, applying FX': 'Veuillez patienter, application de l\'effet',
	'Selection too short': 'Sélection trop courte',
	'Apply Fade In (fx)': 'Appliquer le fondu en entrée (fx)',
	'Applied Fade In (fx)': 'Fondu en entrée appliqué (fx)',
	'Apply Fade Out (fx)': 'Appliquer le fondu en sortie (fx)',
	'Applied Fade Out (fx)': 'Fondu en sortie appliqué (fx)',
	'Apply Noise RNN (fx)': 'Appliquer la réduction de bruit RNN (fx)',
	'Applied Noise RNN (fx)': 'Réduction de bruit RNN appliquée (fx)',
	'Apply Compressor (fx)': 'Appliquer le compresseur (fx)',
	'Applied Compressor (fx)': 'Compresseur appliqué (fx)',
	'Apply Delay (fx)': 'Appliquer le délai (fx)',
	'Applied Delay (fx)': 'Délai appliqué (fx)',
	'Apply Distortion (fx)': 'Appliquer la distorsion (fx)',
	'Applied Distortion (fx)': 'Distorsion appliquée (fx)',
	'Apply Gain (fx)': 'Appliquer le gain (fx)',
	'Applied Gain (fx)': 'Gain appliqué (fx)',
	'Apply Hard Limit (fx)': 'Appliquer le limiteur strict (fx)',
	'Applied Hard Limit (fx)': 'Limiteur strict appliqué (fx)',
	'Apply Parametric EQ (fx)': 'Appliquer l\'égaliseur paramétrique (fx)',
	'Applied Parametric EQ (fx)': 'Égaliseur paramétrique appliqué (fx)',
	'Apply Rate (fx)': 'Appliquer le taux (fx)',
	'Applied Rate (fx)': 'Taux appliqué (fx)',
	'Apply Reverb (fx)': 'Appliquer la réverbération (fx)',
	'Applied Reverb (fx)': 'Réverbération appliquée (fx)',
	'Apply Speed (fx)': 'Appliquer la vitesse (fx)',
	'Applied Speed (fx)': 'Vitesse appliquée (fx)',
	'Applied Normalize': 'Normalisation appliquée',
	'Applied LUFS Normalize': 'Normalisation LUFS appliquée',
	'Applied LUFS Normalize (ceiling limited)': 'Normalisation LUFS appliquée (plafond limité)',
	'Applied RMS Normalize': 'Normalisation RMS appliquée',
	'Applied Reverse': 'Inversion du sens appliquée',
	'Applied Invert': 'Inversion de polarité appliquée',
	'Applied :: Remove Silence': 'Appliqué :: Suppression des silences',
	'Applied': 'Appliqué',
	'Normalize LUFS': 'Normalisation LUFS',
	'Normalize RMS': 'Normalisation RMS',
	'LUFS Normalize': 'Normalisation LUFS',
	'RMS Normalize': 'Normalisation RMS',
	'Hard Limit': 'Limiteur strict',
	'Parametric EQ': 'Égaliseur paramétrique',
	'Rate': 'Taux',
	'Speed': 'Vitesse',

	/* ---- Affichage : fenêtres ---- */
	'Tempo & Rhythm Tools': 'Outils de tempo et de rythme',
	'Tempo Estimation': 'Estimation du tempo',
	'Tempo Tap': 'Tempo au tapotement',
	'Metronome': 'Métronome',
	'Selected Clip': 'Clip sélectionné',
	'Region Only': 'Région uniquement',
	'Selection Only': 'Sélection uniquement',
	'Tempo': 'Tempo',
	'Beats': 'Temps',
	'Confidence': 'Confiance',
	'Estimate': 'Estimer',
	'Runs in the background when you click Estimate.': 'Fonctionne en arrière-plan quand vous cliquez sur Estimer.',
	'Accentuate metronome click': 'Accentuer le clic du métronome',
	'Analyzing audio in the background. This can take a while.': 'Analyse de l\'audio en arrière-plan. Cela peut prendre un moment.',
	'Analyzing audio. This can take a while on long files.': 'Analyse de l\'audio. Cela peut être long sur les fichiers longs.',
	'Preparing audio for background analysis...': 'Préparation de l\'audio pour l\'analyse en arrière-plan...',
	'Loading tempo detector...': 'Chargement du détecteur de tempo...',
	'Could not estimate tempo.': 'Impossible d\'estimer le tempo.',
	'Could not load tempo detector.': 'Impossible de charger le détecteur de tempo.',
	'Could not prepare audio for tempo analysis.': 'Impossible de préparer l\'audio pour l\'analyse du tempo.',
	'Could not start tempo analysis.': 'Impossible de démarrer l\'analyse du tempo.',
	'Nothing to estimate': 'Rien à estimer',
	'Average BPM': 'BPM moyen',
	'Nearest BPM': 'BPM le plus proche',
	'Estimated': 'Estimé',
	'First Beat': 'Premier temps',
	'Timing Taps': 'Tapotements mesurés',
	'Play Both': 'Lire les deux',
	'Play Track': 'Lire la piste',
	'Stop Track': 'Arrêter la piste',
	'Tap in this area, or hit [SPACE] rhythmically, to measure BPM.': 'Tapotez dans cette zone, ou appuyez sur [ESPACE] en rythme, pour mesurer le BPM.',
	'Are you sure? This will discard the current recording.': 'Êtes-vous sûr ? Cela supprimera l\'enregistrement en cours.',
	'no microphone permissions found!': 'aucune autorisation de microphone trouvée !',
	'ID3 Tag Editor': 'Éditeur de tags ID3',
	'Choose Audio File': 'Choisir un fichier audio',
	'Choose an MP3 file to view/edit audio tags.': 'Choisissez un fichier MP3 pour voir ou modifier ses tags.',
	'DOWNLOAD COPY': 'TÉLÉCHARGER UNE COPIE',
	'Album': 'Album',
	'Artist': 'Artiste',
	'Title': 'Titre',
	'Track': 'Piste',
	'Year': 'Année',
	'Genre': 'Genre',
	'Comment': 'Commentaire',
	'Lyrics': 'Paroles',
	'Change Cover': 'Changer la pochette',
	'Remove Image': 'Retirer l\'image',
	'Only MP3 files can be edited here. These tags are view-only.': 'Seuls les fichiers MP3 peuvent être modifiés ici. Ces tags sont en lecture seule.',
	'Choose an MP3 file inside this window first': 'Choisissez d\'abord un fichier MP3 dans cette fenêtre',
	'Reading metadata...': 'Lecture des métadonnées...',
	'Unsupported audio file.': 'Fichier audio non pris en charge.',
	'Frequency Analysis': 'Analyse de fréquences',
	'Volume Graph': 'Graphique du volume',
	'Select LUFS to measure integrated loudness.': 'Sélectionnez LUFS pour mesurer le volume intégré.',
	'Could not analyze audio.': 'Impossible d\'analyser l\'audio.',
	'Load audio first': 'Chargez d\'abord un audio',
	'Make a selection first': 'Faites d\'abord une sélection',
	'Currently unsupported on mobile': 'Non pris en charge sur mobile pour le moment',
	'unsupported on mobile': 'non pris en charge sur mobile',
	'Please allow pop-ups for AudioMass!': 'Veuillez autoriser les fenêtres contextuelles pour AudioMass !',
	'Loop': 'Boucle',
	'Insert silence at beginning': 'Insérer du silence au début',
	'Silence in seconds': 'Silence en secondes',
	'Insert Silence': 'Insérer du silence',
	'Inserted Silence': 'Silence inséré',

	/* ---- Préréglages personnalisés ---- */
	'Preset Name': 'Nom du préréglage',
	'My Preset': 'Mon préréglage',
	'Name is too short...': 'Le nom est trop court...',
	'Save As New': 'Enregistrer comme nouveau',
	'Successfully deleted preset!': 'Préréglage supprimé !',
	'Successfully saved preset!': 'Préréglage enregistré !',
	'Successfully updated preset!': 'Préréglage mis à jour !',

	/* ---- Multipiste ---- */
	'Add New Channel Here': 'Ajouter un nouveau canal ici',
	'Add Silence': 'Ajouter du silence',
	'Add Tracks': 'Ajouter des pistes',
	'Added': 'Ajouté',
	'Add Clip': 'Ajout de clip',
	'Arm Channel': 'Armer le canal',
	'Arm a channel to record': 'Armez un canal pour enregistrer',
	'Audio': 'Audio',
	'Canceled Loading': 'Chargement annulé',
	'Channel': 'Canal',
	'Channel removed': 'Canal supprimé',
	'Copied clip': 'Clip copié',
	'Copy Clip': 'Copier le clip',
	'Could not decode audio': 'Impossible de décoder l\'audio',
	'Could not load all samples': 'Impossible de charger tous les exemples',
	'Could not load audio': 'Impossible de charger l\'audio',
	'Could not load session': 'Impossible de charger la session',
	'Could not save session': 'Impossible d\'enregistrer la session',
	'Crossfade Clip': 'Fondu enchaîné du clip',
	'Delete Clip': 'Supprimer le clip',
	'Duplicate Clip': 'Dupliquer le clip',
	'Duplicated clip': 'Clip dupliqué',
	'Fade Clip': 'Fondu du clip',
	'Load Multitrack Sample': 'Charger un exemple multipiste',
	'Loaded clip in editor': 'Clip chargé dans l\'éditeur',
	'Loaded session': 'Session chargée',
	'Master Volume': 'Volume général',
	'Move Channel Down': 'Descendre le canal',
	'Move Channel Up': 'Monter le canal',
	'Move Clip': 'Déplacer le clip',
	'Move marker inside selected clip': 'Déplacer le repère dans le clip sélectionné',
	'Mute Channel': 'Couper le canal',
	'No overlap on this channel': 'Pas de chevauchement sur ce canal',
	'No recording device found': 'Aucun périphérique d\'enregistrement trouvé',
	'Nothing to save': 'Rien à enregistrer',
	'Open Clip': 'Ouvrir le clip',
	'Open in Editor': 'Ouvrir dans l\'éditeur',
	'Open this clip in the editor for channel info': 'Ouvrez ce clip dans l\'éditeur pour voir les infos du canal',
	'Open this clip in the editor for that effect': 'Ouvrez ce clip dans l\'éditeur pour cet effet',
	'Pan Channel': 'Panoramique du canal',
	'Paste Clip': 'Coller le clip',
	'Pasted clip': 'Clip collé',
	'Record Clip': 'Enregistrer le clip',
	'Recorded clip': 'Clip enregistré',
	'Recorded Audio': 'Audio enregistré',
	'Recording': 'Enregistrement',
	'Remove Channel': 'Supprimer le canal',
	'Remove Crossfade': 'Supprimer le fondu enchaîné',
	'Removed Crossfade': 'Fondu enchaîné supprimé',
	'Rename Channel': 'Renommer le canal',
	'Rename Clip': 'Renommer le clip',
	'Rendering failed:': 'Échec du rendu :',
	'Reorder Channel': 'Réorganiser le canal',
	'Resize Channel': 'Redimensionner le canal',
	'Sample File': 'Fichier exemple',
	'sample tracks': 'pistes d\'exemple',
	'Saved session': 'Session enregistrée',
	'Select a waveform box first': 'Sélectionnez d\'abord un clip',
	'Solo Channel': 'Solo du canal',
	'Split Clip': 'Diviser le clip',
	'Split Here': 'Diviser ici',
	'Trim Clip': 'Rogner le clip',
	'Turn Crossfade Off': 'Désactiver le fondu enchaîné',
	'Turn Crossfade On': 'Activer le fondu enchaîné',
	'Volume Channel': 'Volume du canal',
	'Copied range': 'Plage copiée',
	'Paste to': 'Coller vers',
	'Peak at': 'Crête à',
	'Cut ::': 'Couper ::',
	'Delete ::': 'Supprimer ::',
	'Loaded Successfully': 'Chargé avec succès',

	/* ---- Repères ---- */
	'Add Marker': 'Ajouter un repère',
	'Add Marker Here': 'Ajouter un repère ici',
	'Clear Markers': 'Effacer les repères',
	'Delete Marker': 'Supprimer le repère',
	'Load Markers': 'Charger des repères',
	'Marker': 'Repère',
	'Move Marker': 'Déplacer le repère',
	'Play From Here': 'Lire à partir d\'ici',
	'Rename Marker': 'Renommer le repère',

	/* ---- Divers : erreurs, stockage, glisser-déposer ---- */
	'Could not load this draft - it may be corrupted or too long for this browser.': 'Impossible de charger ce brouillon : il est peut-être corrompu ou trop long pour ce navigateur.',
	'Could not open local storage': 'Impossible d\'ouvrir le stockage local',
	'Unsupported audio file type': 'Type de fichier audio non pris en charge',
	'Could not resample recording': 'Impossible de rééchantillonner l\'enregistrement',
	'Unable to open database.': 'Impossible d\'ouvrir la base de données.',
	'error fetching data': 'erreur de lecture des données',
	'error storing data': 'erreur d\'enregistrement des données',
	'data stored': 'données enregistrées',
	'Could not analyze audio': 'Impossible d\'analyser l\'audio',
	'Drag n drop Files!': 'Glissez-déposez des fichiers !',
	'File API not supported': 'API de fichiers non prise en charge',
	'File too large': 'Fichier trop volumineux',
	'File not found.': 'Fichier introuvable.',
	'Couldnot read File': 'Impossible de lire le fichier',
	'File couldnot be uploaded': 'Le fichier n\'a pas pu être envoyé',
	'File coulnot be opened': 'Le fichier n\'a pas pu être ouvert'
};

/* Texte de menu et infobulle composés par le programme (nom d'action de l'historique, durées, etc.). */
var ACTIONS = {
	'Add Clip': 'ajout de clip', 'Delete Clip': 'suppression de clip', 'Move Clip': 'déplacement de clip',
	'Split Clip': 'division de clip', 'Trim Clip': 'rognage de clip', 'Paste Clip': 'collage de clip',
	'Duplicate Clip': 'duplication de clip', 'Fade Clip': 'fondu de clip', 'Crossfade Clip': 'fondu enchaîné de clip',
	'Rename Clip': 'renommage de clip', 'Rename Channel': 'renommage de canal', 'Remove Channel': 'suppression de canal',
	'Add Channel': 'ajout de canal', 'Reorder Channel': 'réorganisation de canal', 'Resize Channel': 'redimensionnement de canal'
};

var RULES = [
	[/^(Undo|Redo) (.+)$/, function (m) {
		var verb = m[1] === 'Undo' ? 'Annuler' : 'Rétablir';
		var a = ACTIONS[m[2]];
		return a ? verb + ' ' + a : verb + ' ' + (FR[m[2]] ? FR[m[2]].toLowerCase() : m[2]);
	}],
	[/^Loop ([\d.,]+)s$/, function (m) { return 'Boucle ' + m[1] + ' s'; }],
	[/^Shft\+(.+)$/, function (m) { return 'Maj+' + m[1]; }],
	[/^Shift\+(.+)$/, function (m) { return 'Maj+' + m[1]; }],
	[/^Rendering failed: (.*)$/, function (m) { return 'Échec du rendu : ' + m[1]; }],
	[/^Edit Custom Preset "(.*)"$/, function (m) { return 'Modifier le préréglage personnalisé « ' + m[1] + ' »'; }],
	[/^Save Custom Preset for filter "(.*)"$/, function (m) { return 'Enregistrer un préréglage personnalisé pour le filtre « ' + m[1] + ' »'; }],
	[/^Insert silence at current cursor \((.*)\)$/, function (m) { return 'Insérer du silence au curseur (' + m[1] + ')'; }]
];

var lang = 'en';
var title0 = null;
var originals = new WeakMap();      // nœud texte -> texte d'origine
var attrOriginals = new WeakMap();  // élément -> { attribut: valeur d'origine }
var ATTRS = ['title', 'placeholder', 'alt', 'aria-label'];
var observer = null;

function norm (s) { return s.replace(/[\s ]+/g, ' ').trim(); }

/* Traduit un texte ; renvoie null quand il n'y a rien à changer. */
function translate (text) {
	var lead = text.match(/^[\s ]*/)[0];
	var trail = text.match(/[\s ]*$/)[0];
	var core = norm (text);
	if (!core || !/[A-Za-z]{2}/.test (core)) return null;
	var mark = '';
	if (/ ?[✔✓]$/.test (core)) { mark = ' ✔'; core = core.replace (/ ?[✔✓]$/, ''); }
	var out = Object.prototype.hasOwnProperty.call (FR, core) ? FR[core] : null;
	if (out === null) {
		for (var i = 0; i < RULES.length; i++) {
			var m = core.match (RULES[i][0]);
			if (m) { out = RULES[i][1] (m); break; }
		}
	}
	if (out === null || out === core) return null;
	return lead + out + mark + trail;
}

function isUserText (node) {
	/* Noms de clips : ce sont des données de l'utilisateur, jamais traduites (le Studio les relit pour retrouver un morceau). */
	var el = node.parentNode;
	return !!(el && el.closest && el.closest ('.pk_mt_clip'));
}

function setText (node) {
	if (isUserText (node)) return;
	var cur = node.nodeValue;
	var orig = originals.has (node) ? originals.get (node) : null;
	if (orig !== null && translate (orig) === cur) return;   // déjà traduit
	var t = translate (cur);
	if (t === null) return;
	originals.set (node, cur);
	node.nodeValue = t;
}

function setAttrs (el) {
	for (var i = 0; i < ATTRS.length; i++) {
		var a = ATTRS[i];
		if (!el.hasAttribute (a)) continue;
		var cur = el.getAttribute (a);
		var store = attrOriginals.get (el) || {};
		if (store[a] !== undefined && translate (store[a]) === cur) continue;
		var t = translate (cur);
		if (t === null) continue;
		store[a] = cur;
		attrOriginals.set (el, store);
		el.setAttribute (a, t);
	}
	/* Boutons : leur valeur est un libellé ; les champs de saisie gardent ce que l'utilisateur écrit. */
	if (el.tagName === 'INPUT' && (el.type === 'button' || el.type === 'submit') && el.value) {
		var v = translate (el.value);
		if (v !== null) el.value = v;
	}
}

function walk (root) {
	if (!root) return;
	if (root.nodeType === 3) { setText (root); return; }
	if (root.nodeType !== 1) return;
	var tag = root.tagName;
	if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEXTAREA' || tag === 'CANVAS') return;
	setAttrs (root);
	var w2 = d.createTreeWalker (root, 1 | 4, {
		acceptNode: function (n) {
			if (n.nodeType === 1) {
				var t = n.tagName;
				return (t === 'SCRIPT' || t === 'STYLE' || t === 'TEXTAREA' || t === 'CANVAS') ? 2 : 1;
			}
			return 1;
		}
	});
	var n;
	while ((n = w2.nextNode ())) {
		if (n.nodeType === 3) setText (n); else setAttrs (n);
	}
}

/* Retour à l'anglais : on remet les textes d'origine. */
function restore (root) {
	var w2 = d.createTreeWalker (root, 1 | 4);
	var n;
	while ((n = w2.nextNode ())) {
		if (n.nodeType === 3) {
			if (originals.has (n)) { n.nodeValue = originals.get (n); originals.delete (n); }
		} else {
			var store = attrOriginals.get (n);
			if (store) { for (var a in store) n.setAttribute (a, store[a]); attrOriginals.delete (n); }
		}
	}
}

function startObserver () {
	if (observer || !w.MutationObserver) return;
	observer = new MutationObserver (function (list) {
		if (lang !== 'fr') return;
		for (var i = 0; i < list.length; i++) {
			var r = list[i];
			if (r.type === 'childList') {
				for (var j = 0; j < r.addedNodes.length; j++) walk (r.addedNodes[j]);
			} else if (r.type === 'characterData') {
				setText (r.target);
			} else if (r.type === 'attributes') {
				setAttrs (r.target);
			}
		}
	});
	observer.observe (d.documentElement, {
		childList: true, subtree: true, characterData: true,
		attributes: true, attributeFilter: ATTRS
	});
}

/* Quelques libellés d'AudioMass sont dessinés par la feuille de style (content:"...") : on les remplace par une feuille à part. */
var cssNode = null;
function setCss (on) {
	if (on && !cssNode) {
		cssNode = d.createElement ('style');
		cssNode.id = 'pk-i18n-fr-css';
		cssNode.textContent = '.icon-clearsel:before{content:"désélectionner"}' +
			'@media only screen and (max-width:864px){.icon-clearsel:before{content:"désél."}}';
		d.head.appendChild (cssNode);
	} else if (!on && cssNode) {
		cssNode.parentNode && cssNode.parentNode.removeChild (cssNode);
		cssNode = null;
	}
}

function setLang (l) {
	var next = l === 'fr' ? 'fr' : 'en';
	if (next === lang) return;
	lang = next;
	if (lang === 'fr') {
		d.documentElement.lang = 'fr';
		setCss (true);
		if (title0 === null) title0 = d.title;
		var tt = translate (title0); if (tt) d.title = tt;
		startObserver ();
		walk (d.body || d.documentElement);
	} else {
		d.documentElement.lang = 'en';
		setCss (false);
		if (title0 !== null) d.title = title0;
		restore (d.body || d.documentElement);
	}
}

function wanted () {
	var m = /[?&]lang=([a-z]{2})/.exec (w.location.search);
	if (m) return m[1];
	var saved = null;
	try { saved = w.localStorage.getItem ('language'); } catch (e) { /* storage unavailable */ }
	if (saved) return saved;
	// The application only writes "language" once the language is picked by hand; until then it follows the browser's (French browser = French app).
	return /^fr/i.test (w.navigator && w.navigator.language || '') ? 'fr' : 'en';
}

w.PKAudioEditorI18n = { setLang: setLang, translate: translate, get lang () { return lang; } };

setLang (wanted ());
w.addEventListener ('storage', function (e) {
	if (e.key === 'language' || e.key === null) setLang (wanted ());
});
d.addEventListener ('DOMContentLoaded', function () { if (lang === 'fr') walk (d.body); });

})(window, document);
