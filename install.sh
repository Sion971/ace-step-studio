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
echo "[0/9] Dépendances système..."

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
echo "[1/9] Création des répertoires de travail..."
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

# === 3. uv & environnement virtuel ===========================================
if ! command -v uv &> /dev/null; then
    echo "['uv' non détecté. Installation de uv...]"
    curl -LsSf https://astral.sh/uv/install.sh | sh
    source "$HOME/.local/bin/env" 2>/dev/null || true
fi

echo "[2/9] Environnement virtuel Python 3.12.3..."
if [ -d ".venv" ]; then
    echo "Suppression de l'ancien venv pour un reset propre..."
    rm -rf .venv
fi

uv venv --python 3.12.3 .venv
source .venv/bin/activate

# === 4. Outils de build ======================================================
echo "[3/9] Outils de build (hatchling, cmake, ninja)..."
uv pip install hatchling editables cmake "ninja>=1.13.0" setuptools wheel

# === 5. PyTorch ==============================================================
echo "[4/9] PyTorch 2.10.0 ($CUDA_NAME)..."
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
    echo "[4b/9] NVIDIA NPP (requis par torchcodec)..."
    uv pip install nvidia-npp-cu12
fi

# === 6. Dépendances Python d'ACE-Step ========================================
echo "[5/9] Dépendances ACE-Step..."

if [ -d "ACE-Step-1.5/acestep/third_parts/nano-vllm" ]; then
    uv pip install -e ACE-Step-1.5/acestep/third_parts/nano-vllm/
fi

if [ "$CUDA_VERSION" != "cpu" ]; then
    uv pip install "triton>=3.0.0"
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
echo "[6/9] Vérification de torchcodec..."
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
echo "[7/9] Vérification de Node.js..."
if ! command -v node &> /dev/null; then
    echo "ERREUR: Node.js n'est pas installé. Veuillez installer Node.js 22 LTS."
    exit 1
fi
echo "  Node.js $(node -v)"

# === 9. npm & build frontend =================================================
echo "[8/9] Dépendances npm (frontend et serveur)..."
(cd app && npm install)
(cd app/server && npm install)

echo "[9/9] Compilation du frontend..."
(cd app && npx vite build)

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
