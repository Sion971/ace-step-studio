#!/usr/bin/env bash
# setup-basic-pitch-venv.sh
#
# Cree un environnement Python ISOLE pour basic-pitch (Spotify), distinct
# du venv ACE-Step — evite tout conflit avec les versions figees de
# torch/torchaudio/numpy qu'ACE-Step exige. Moteur ONNX choisi
# deliberement : plus leger qu'une installation TensorFlow complete, et
# l'inference CPU pour un modele de cette taille reste rapide (contraste
# avec la tentative navigateur/WebGL/TensorFlow.js abandonnee, qui
# souffrait d'un repli CPU en JavaScript, pas natif).
#
# A lancer UNE SEULE FOIS, depuis app/server/ :
#   cd app/server
#   chmod +x setup-basic-pitch-venv.sh
#   ./setup-basic-pitch-venv.sh

set -euo pipefail
cd "$(dirname "$0")"

VENV_DIR="basic-pitch-venv"

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
echo "=== Installation de basic-pitch (moteur ONNX) ==="
"$VENV_DIR/bin/pip" install --upgrade pip
"$VENV_DIR/bin/pip" install "basic-pitch[onnx]==0.4.0"

echo ""
echo "=== Verification ==="
"$VENV_DIR/bin/python3" -c "
from basic_pitch.inference import predict
from basic_pitch import ICASSP_2022_MODEL_PATH
print('basic-pitch importe correctement.')
print('Modele :', ICASSP_2022_MODEL_PATH)
"

echo ""
echo "Installation terminee. Le serveur utilisera automatiquement :"
echo "  $VENV_DIR/bin/python3"
echo "(chemin par defaut dans config/index.ts — ajustable via la variable"
echo "d'environnement BASIC_PITCH_PYTHON_PATH si besoin)."
