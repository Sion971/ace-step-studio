#!/usr/bin/env bash
# =============================================================================
#  ACE-Step Studio — installation (portage Linux)
#
#  Installe le venv Python, PyTorch, les dépendances ACE-Step et le frontend.
#  Une réinstallation complète doit reproduire un environnement fonctionnel
#  sans intervention manuelle — voir TROUBLESHOOTING.md pour les pièges connus.
# =============================================================================

set -e

echo "========================================"
echo "   ACE-Step Studio - Install (Linux)"
echo "========================================"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

export TEMP="$SCRIPT_DIR/temp"
export TMP="$SCRIPT_DIR/temp"

# === 0. Dépendances système ==================================================
# FFmpeg et libsndfile sont testés séparément : sur une machine où FFmpeg est
# déjà présent, la branche unique d'origine sautait aussi libsndfile1.
echo "[1/12] Dépendances système..."

MISSING_PKGS=""
command -v ffmpeg &> /dev/null || MISSING_PKGS="$MISSING_PKGS ffmpeg"
ldconfig -p 2>/dev/null | grep -q libsndfile || MISSING_PKGS="$MISSING_PKGS libsndfile1"

if [ -n "$MISSING_PKGS" ]; then
    echo "Installation via apt :$MISSING_PKGS"
    sudo apt update && sudo apt install -y $MISSING_PKGS
else
    echo "FFmpeg et libsndfile déjà présents."
fi

# torchcodec choisit sa bibliothèque selon la version de FFmpeg installée
# (libtorchcodec_core4 à 8). Un FFmpeg bundlé dans le projet créerait un
# conflit avec les .so du système : on laisse volontairement apt gérer.
if command -v ffmpeg &> /dev/null; then
    echo "FFmpeg : $(ffmpeg -version 2>/dev/null | head -1 | cut -d' ' -f3)"
fi

# === 1. Arborescence =========================================================
echo "[2/12] Création des répertoires de travail..."
mkdir -p downloads temp models cache output
mkdir -p app/data app/server/public/audio

# Les datasets et sorties LoRA vivent sous ACE-Step-1.5/, jamais à la racine :
# run.sh exporte DATASETS_DIR="$SCRIPT_DIR/ACE-Step-1.5/datasets" et le moteur
# résout ses chemins relatifs depuis ACE-Step-1.5/. Créer datasets/ à la racine
# produisait deux dossiers homonymes et des « fichier introuvable » trompeurs.
mkdir -p ACE-Step-1.5/datasets/uploads
mkdir -p ACE-Step-1.5/datasets/preprocessed_tensors
mkdir -p ACE-Step-1.5/lora_output

export HF_HOME="$SCRIPT_DIR/models"
export MODELSCOPE_CACHE="$SCRIPT_DIR/models"

# === 2. Sélection GPU / CUDA =================================================
echo ""
echo "Sélectionnez votre GPU :"
echo "  1. NVIDIA GTX 10xx (Pascal) -> CUDA 11.8"
echo "  2. NVIDIA RTX 20xx / 30xx   -> CUDA 12.6"
echo "  3. NVIDIA RTX 40xx / 50xx   -> CUDA 12.8"
echo "  4. CPU uniquement (pas de GPU)"
echo ""
read -p "Entrez votre choix (1-4) : " GPU_CHOICE

case "$GPU_CHOICE" in
  1) CUDA_VERSION="cu118"; CUDA_NAME="CUDA 11.8" ;;
  2) CUDA_VERSION="cu126"; CUDA_NAME="CUDA 12.6" ;;
  3) CUDA_VERSION="cu128"; CUDA_NAME="CUDA 12.8" ;;
  4) CUDA_VERSION="cpu";   CUDA_NAME="CPU only" ;;
  *) echo "Choix invalide !"; exit 1 ;;
esac

echo "Option sélectionnée : $CUDA_NAME"
echo ""

# === 2b. Detection reelle de la capacite de calcul (pour flash-attn) ========
# Le menu ci-dessus regroupe Turing (RTX 20xx, capacite 7.5) et Ampere
# (RTX 30xx, capacite 8.0+) dans le MEME choix (option 2) — un choix grossier
# suffisant pour l'index CUDA de PyTorch, mais pas assez precis pour savoir
# si flash-attn fonctionnera reellement : son noyau CUDA officiel exige
# capacite >= 8.0 (Ampere et plus recent). En dessous, SDPA reste pleinement
# fonctionnel (repli automatique sur son propre noyau, plus lent mais
# correct) — voir requirements.txt d'ACE-Step-1.5, qui liste flash-attn sans
# aucune condition de generation.
FLASH_ATTN_OK=false
if [ "$CUDA_VERSION" != "cpu" ] && command -v nvidia-smi &> /dev/null; then
    COMPUTE_CAP=$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null | head -1 | tr -d '[:space:]')
    if [ -n "$COMPUTE_CAP" ] && awk "BEGIN {exit !($COMPUTE_CAP >= 8.0)}" 2>/dev/null; then
        FLASH_ATTN_OK=true
        echo "GPU detecte : capacite de calcul $COMPUTE_CAP — flash-attn sera installe."
    elif [ -n "$COMPUTE_CAP" ]; then
        echo "GPU detecte : capacite de calcul $COMPUTE_CAP — flash-attn ignore (exige >= 8.0)."
        echo "  SDPA continuera de fonctionner normalement, juste sans cette acceleration."
    fi
fi
echo ""

# === 3. uv & environnement virtuel ===========================================
if ! command -v uv &> /dev/null; then
    echo "['uv' non détecté. Installation de uv...]"
    curl -LsSf https://astral.sh/uv/install.sh | sh
    source "$HOME/.local/bin/env" 2>/dev/null || true
fi

echo "[3/12] Environnement virtuel Python 3.12.3..."
if [ -d ".venv" ]; then
    echo "Suppression de l'ancien venv pour un reset propre..."
    rm -rf .venv
fi

uv venv --python 3.12.3 .venv
source .venv/bin/activate

# === 4. Outils de build ======================================================
echo "[4/12] Outils de build (hatchling, cmake, ninja)..."
uv pip install hatchling editables cmake "ninja>=1.13.0" setuptools wheel

# === 5. PyTorch ==============================================================
echo "[5/12] PyTorch 2.10.0 ($CUDA_NAME)..."
if [ "$CUDA_VERSION" = "cpu" ]; then
    uv pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cpu
else
    uv pip install \
        torch==2.10.0+$CUDA_VERSION \
        torchvision==0.25.0+$CUDA_VERSION \
        torchaudio==2.10.0+$CUDA_VERSION \
        torchcodec==0.10.0+$CUDA_VERSION \
        --index-url https://download.pytorch.org/whl/$CUDA_VERSION
fi

# === 5b. NVIDIA NPP — requis par torchcodec ==================================
# torchcodec lie libnppicc (NVIDIA Performance Primitives) mais ne le déclare
# pas comme dépendance, et PyTorch ne l'installe pas non plus. Sans ce paquet,
# le chargement retombe sur le NPP du système (CUDA 12.0 sur Ubuntu 24.04),
# trop ancien, et torchaudio.save() échoue avec :
#   « undefined symbol: nppiNV12ToRGB_8u_ColorTwist32f_P2C3R_Ctx »
# La génération audio produit alors le son mais ne peut plus écrire de fichier.
# ATTENTION : --index-url ci-dessus REMPLACE PyPI. Ce paquet doit donc être
# installé dans un appel séparé, sans index-url, pour être trouvé sur PyPI.
if [ "$CUDA_VERSION" != "cpu" ]; then
    echo "[5b/12] NVIDIA NPP (requis par torchcodec)..."
    uv pip install nvidia-npp-cu12
fi

# === 6. Dépendances Python d'ACE-Step ========================================
echo "[6/12] Dépendances ACE-Step..."

if [ -d "ACE-Step-1.5/acestep/third_parts/nano-vllm" ]; then
    uv pip install -e ACE-Step-1.5/acestep/third_parts/nano-vllm/
fi

if [ "$CUDA_VERSION" != "cpu" ]; then
    uv pip install "triton>=3.0.0"
fi

# flash-attn : seulement si le GPU le supporte reellement (voir detection
# plus haut). --no-build-isolation est necessaire ici — flash-attn compile
# son extension CUDA contre le torch DEJA installe, l'isolation de build
# par defaut l'empecherait de le voir. Peut prendre plusieurs minutes
# (compilation depuis les sources si aucune roue precompilee ne correspond
# exactement a cette version de torch/CUDA/Python).
if [ "$FLASH_ATTN_OK" = true ]; then
    echo "  Installation de flash-attn (peut prendre plusieurs minutes)..."
    uv pip install flash-attn==2.8.3.post1 --no-build-isolation
fi

# torch, torchaudio et torchcodec sont déjà installés plus haut depuis l'index
# PyTorch : ils sont volontairement absents de cette liste.
uv pip install "transformers>=4.51.0,<4.58.0" diffusers gradio==6.2.0 matplotlib \
    scipy soundfile loguru einops accelerate fastapi diskcache "uvicorn[standard]" \
    numba vector-quantize-pytorch "torchao>=0.16.0,<0.17.0" toml peft modelscope \
    tensorboard typer-slim hf_transfer hf_xet lightning lycoris-lora safetensors \
    xxhash "pytorch-wavelets>=1.3.0" "pywavelets>=1.9.0" "bitsandbytes>=0.50.0"

if [ -d "ACE-Step-1.5" ]; then
    uv pip install -e ACE-Step-1.5/ --no-deps
fi

# === 7. Vérification torchcodec ==============================================
# Test précoce : mieux vaut échouer ici qu'au premier fichier audio généré.
echo "[7/12] Vérification de torchcodec..."
if [ "$CUDA_VERSION" != "cpu" ]; then
    if .venv/bin/python -c "import torchcodec" 2>/dev/null; then
        echo "  OK — torchcodec se charge correctement."
    else
        echo "  ATTENTION : torchcodec ne se charge pas."
        echo "  L'installation continue, mais l'écriture des fichiers audio"
        echo "  échouera. Voir TROUBLESHOOTING.md (section libtorchcodec)."
    fi
fi

# === 8. Node.js ==============================================================
echo "[8/12] Vérification de Node.js..."
if ! command -v node &> /dev/null; then
    echo "ERREUR: Node.js n'est pas installé. Veuillez installer Node.js 22 LTS."
    exit 1
fi
echo "  Node.js $(node -v)"

# === 9. npm & build frontend =================================================
echo "[9/12] Dépendances npm (frontend et serveur)..."
(cd app && npm install)
(cd app/server && npm install)

echo "[10/12] Compilation du frontend..."
(cd app && npx vite build)

echo "[11/12] Migration base de données (séparation Playlists/Espaces de travail)..."
# Colonne 'kind' sur la table playlists — voir app/server/run-migration-kind.mjs
# pour le detail complet. Idempotent (verifie lui-meme si la colonne existe
# deja) et cree sa propre sauvegarde avant toute modification : sans danger
# a relancer sur une reinstallation ou une base deja migree.
#
# Necessite better-sqlite3, installe juste au-dessus (npm install dans
# app/server) — doit donc rester APRES cette etape, jamais avant.
if [ -f "app/server/run-migration-kind.mjs" ]; then
    (cd app/server && node run-migration-kind.mjs)
else
    echo "  ATTENTION : app/server/run-migration-kind.mjs introuvable, migration ignorée."
    echo "  La separation Playlists/Espaces de travail pourrait ne pas fonctionner."
fi

echo "[12/12] Environnement basic-pitch (conversion audio -> MIDI)..."
# Venv Python ISOLE, distinct de .venv (ACE-Step) — evite tout conflit avec
# ses versions figees de torch/torchaudio/numpy. basic-pitch exige
# tensorflow<2.15.1 (meme avec l'extra [onnx]), sans roue compatible Python
# 3.12 : necessite specifiquement Python 3.11, via le PPA deadsnakes.
#
# Idempotent : sans-op si python3.11 et le venv sont deja en place.
if ! command -v python3.11 &> /dev/null; then
    echo "  Python 3.11 introuvable — ajout du PPA deadsnakes..."
    sudo add-apt-repository -y ppa:deadsnakes/ppa
    sudo apt update
    sudo apt install -y python3.11 python3.11-venv
fi

BASIC_PITCH_VENV="app/server/basic-pitch-venv"
if [ -d "$BASIC_PITCH_VENV" ]; then
    echo "  $BASIC_PITCH_VENV existe déjà, réinstallation propre..."
    rm -rf "$BASIC_PITCH_VENV"
fi

python3.11 -m venv "$BASIC_PITCH_VENV"
"$BASIC_PITCH_VENV/bin/pip" install --upgrade pip
# Version figee : sans elle, pip peut reculer vers d'anciennes versions de
# basic-pitch (observe jusqu'a 0.2.6) qui exigent un numpy anterieur a 1.24,
# sans roue precompilee pour Python 3.11/3.12, et echouent a la compilation
# depuis les sources. Voir TROUBLESHOOTING.md pour l'historique complet.
"$BASIC_PITCH_VENV/bin/pip" install "basic-pitch[onnx]==0.4.0"

if "$BASIC_PITCH_VENV/bin/python3" -c "from basic_pitch.inference import predict" 2>/dev/null; then
    echo "  OK — basic-pitch s'importe correctement."
else
    echo "  ATTENTION : basic-pitch ne s'importe pas correctement."
    echo "  La conversion MIDI ne fonctionnera pas. Voir TROUBLESHOOTING.md."
fi

# Verification AudioMass (pas d'installation — les fichiers, deja corriges
# avec les patches ?audioUrl=/?audioUrls=, sont directement suivis par git).
echo "  Vérification de l'éditeur audio (AudioMass)..."
AUDIOMASS_OK=true
for dir in "app/audiomass-editor/src" "app/server/audio-editor"; do
    if [ ! -f "$dir/app.js" ] || ! grep -q "audioUrls=" "$dir/app.js" 2>/dev/null; then
        echo "  ATTENTION : $dir/app.js absent ou sans le correctif audioUrls= attendu."
        AUDIOMASS_OK=false
    fi
done
if [ "$AUDIOMASS_OK" = true ]; then
    echo "  OK — éditeur audio correctement en place."
fi


echo "$CUDA_VERSION" > cuda_version.txt

echo ""
echo "========================================"
echo "   Installation terminée avec succès !"
echo ""
echo "   Démarrage        : ./run.sh"
echo "   Sans LM local    : ./run.sh --no-lm"
echo "   Gradio seul      : ./run.sh --gradio-only"
echo "   Options          : ./run.sh --help"
echo ""
echo "   Les modèles se téléchargent au premier lancement."
echo "========================================"
