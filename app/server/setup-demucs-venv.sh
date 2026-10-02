#!/usr/bin/env bash
# setup-demucs-venv.sh
#
# Cree un environnement Python ISOLE pour Demucs (separation de stems),
# distinct du venv ACE-Step — evite tout conflit avec les versions figees
# de torch/torchaudio/numpy qu'ACE-Step exige (meme principe que
# setup-basic-pitch-venv.sh, voir ce fichier). Demucs a lui-meme besoin
# de torch/torchaudio, mais SANS les contraintes de version strictes
# d'ACE-Step — un venv separe laisse chacun utiliser ce qui lui convient.
#
# htdemucs_6s (6 stems : drums, bass, other, vocals, guitar, piano) est
# le meme modele que celui utilise par StemForge et par la version 2.0
# de timoncool/ACE-Step-Studio (via leur propre portage natif C++) —
# ici obtenu directement par le paquet Python demucs officiel, sans
# avoir besoin de reproduire leur infrastructure.
#
# A lancer UNE SEULE FOIS, depuis app/server/ :
#   cd app/server
#   chmod +x setup-demucs-venv.sh
#   ./setup-demucs-venv.sh

set -euo pipefail
cd "$(dirname "$0")"

VENV_DIR="demucs-venv"

if [ -d "$VENV_DIR" ]; then
  echo "Le dossier $VENV_DIR existe deja."
  read -p "Le supprimer et recommencer a zero ? [o/N] " -n 1 -r
  echo
  if [[ $REPLY =~ ^[Oo]$ ]]; then
    rm -rf "$VENV_DIR"
  else
    echo "Arret, rien touche. Supprime le dossier manuellement si tu veux reinstaller."
    exit 0
  fi
fi

echo "=== Creation du venv isole ($VENV_DIR) ==="
python3.11 -m venv "$VENV_DIR"

echo ""
echo "=== Installation de PyTorch (CPU) ==="
# CPU suffit ici : Demucs tourne correctement sur CPU pour un usage
# ponctuel (quelques dizaines de secondes par morceau), et ca evite tout
# conflit de version CUDA avec le venv ACE-Step principal, qui occupe
# deja le GPU pendant la generation. Un futur ajustement GPU reste
# possible si la vitesse s'avere un vrai probleme en pratique.
"$VENV_DIR/bin/pip" install --upgrade pip
"$VENV_DIR/bin/pip" install torch torchaudio --index-url https://download.pytorch.org/whl/cpu

echo ""
echo "=== Installation de Demucs ==="
"$VENV_DIR/bin/pip" install demucs

echo ""
echo "=== Verification ==="
"$VENV_DIR/bin/python3" -c "
import demucs.api
print('demucs importe correctement.')
print('Version :', __import__('demucs').__version__ if hasattr(__import__('demucs'), '__version__') else 'inconnue')
"

echo ""
echo "=== Pre-telechargement du modele 6-stems (htdemucs_6s) ==="
# Le premier appel reel telecharge automatiquement le modele si absent
# (confirme deja comme comportement normal pour Demucs, voir nos notes
# existantes) — le faire ici evite que le tout premier usage depuis
# l'interface soit anormalement long sans explication visible.
"$VENV_DIR/bin/python3" -c "
from demucs.pretrained import get_model
print('Telechargement du modele htdemucs_6s (peut prendre quelques minutes)...')
get_model('htdemucs_6s')
print('Modele pret.')
"

echo ""
echo "Installation terminee. Le serveur utilisera automatiquement :"
echo "  $VENV_DIR/bin/python3"
echo "(chemin par defaut dans config/index.ts — ajustable via la variable"
echo "d'environnement DEMUCS_PYTHON_PATH si besoin)."
