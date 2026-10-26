# Studio sous Windows : liste de vérification

À dérouler une fois sur le PC Windows, après `git pull` puis `run.bat`. Tout ce qui est coché a été vérifié sous Linux (Chromium) ; rien de ceci n'a encore été essayé sous Windows ni dans Firefox. Noter pour chaque ligne : OK, ou ce qui s'est passé (capture, message du terminal).

## 0. Avant de commencer
- [ ] `run.bat` démarre sans erreur et l'application s'ouvre.
- [ ] Le dossier `ffmpeg\` contient `ffmpeg.exe` et des `avcodec-*.dll` (installé par `install.bat`). Le serveur appelle `ffmpeg` par le PATH, que `run.bat` complète avec ce dossier.
- [ ] Dans une fenêtre `cmd` ouverte par `run.bat` (ou en ajoutant `ffmpeg\` au PATH) : `ffmpeg -encoders | findstr /i "flac libmp3lame"` affiche les deux. Sans eux, l'export FLAC / MP3 échoue.

## 1. Onglet Studio et éditeur
- [ ] L'onglet Studio s'ouvre, l'éditeur s'affiche (pas d'écran blanc).
- [ ] Un clic sur un morceau l'ajoute en piste ; deux morceaux ajoutés coup sur coup vont sur deux pistes différentes.
- [ ] Lecture : le son sort, les spectres bougent, le curseur master est visible avec 6 pistes (la mixette tient dans la largeur).
- [ ] Changer d'onglet (Studio → Créer → Studio) : le travail est toujours là et le son s'arrête.
- [ ] Fermer l'onglet du navigateur avec du travail non sauvegardé : le navigateur prévient.

## 2. Tempo
- [ ] Premier morceau ajouté à l'éditeur vide : BPM et signature du morceau affichés (pas 120 et 4/4).
- [ ] Deuxième morceau d'un autre tempo, case « Caler sur le tempo du projet » cochée : la piste arrive nommée « Titre (N BPM) », la note « X → N BPM » s'affiche, la durée de la piste a changé, la hauteur non.
- [ ] Même chose case décochée : le morceau arrive tel quel.
- [ ] Avec ffmpeg bloqué : le morceau est quand même calé (le repli Python fait l'étirement : le morceau doit alors arriver calé ; le terminal écrit `ffmpeg could not stretch ... using the engine's Python`).
- [ ] Un morceau sans tempo connu ou à plus du double / moins de la moitié : ajouté tel quel, sans erreur.

## 3. Export vers la bibliothèque
- [ ] FLAC : le morceau apparaît dans la liste, se lit, et son fichier est un `.flac` (dossier des fichiers audio du serveur, `song-uploads\<utilisateur>\`).
- [ ] MP3 : idem avec un `.mp3`.
- [ ] WAV : idem avec un `.wav`.
- [ ] « Plage sélectionnée uniquement » exporte bien la plage.
- [ ] Un mix de plus de 5 minutes passe (limite à 200 Mo).
- [ ] Si Windows bloque `ffmpeg.exe` (Smart App Control, fenêtre « une partie de cette application a été bloquée ») : l'export FLAC / MP3 doit quand même aboutir, le terminal affichant `[audio] ffmpeg could not convert ... using the engine's Python`.
- [ ] Si ça échoue : le message d'erreur et la ligne `Upload song audio: conversion failed` du terminal.

## 4. Projets et sauvegarde automatique
- [ ] Enregistrer un projet, le fermer (vider l'éditeur), le rouvrir : pistes, volumes, tempo retrouvés.
- [ ] Le dossier des projets est créé (`studio-projects\` à côté de la base de données, ou `STUDIO_PROJECTS_DIR`) et le fichier `.amss` est environ moitié moins gros qu'avant (audio en 16 bits).
- [ ] Supprimer un projet de la liste.
- [ ] Sauvegarde automatique : modifier l'éditeur, attendre environ 30 s, recharger la page (F5) : le bandeau « Restaurer » propose le travail, et le restaure.

## 4 bis. Outils sans ffmpeg (si Windows le bloque)
- [ ] Normalisation / mastering (Outils) : le fichier normalisé est produit, avec les niveaux avant / après ; le terminal écrit `[loudnorm] ffmpeg failed ... using the engine's Python instead`.
- [ ] Instrument avec « Mixer avec l'original » : le mix est créé (`[Mix] ... made with the engine's Python instead`).
- [ ] Rendu vidéo : **attendu en échec** tant que ffmpeg est bloqué (seul outil sans repli).

## 5. Instrument (Lego)
- [ ] « Ajouter un instrument » sur un morceau de l'éditeur, avec un modèle Base : la piste générée arrive seule dans l'éditeur.

## 6. Navigateurs
- [ ] Refaire les sections 1 à 4 dans Firefox (jamais essayé).
- [ ] Refaire la section 1 dans Edge.

## Test automatique, à lancer à la main si besoin
```
pip install playwright
playwright install chromium
python app\e2e\studio_editor_e2e.py
```
Doit finir par « All good ». Le même test tourne sur GitHub à chaque envoi (`.github/workflows/ci.yml`), mais sous Linux.
