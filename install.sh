#!/usr/bin/env bash
set -e

echo "========================================"
echo "   ACE-Step Studio - Install (Linux)"
echo "   (Optimisé SoundFile - FFmpeg Global)"
echo "========================================"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

export TEMP="$SCRIPT_DIR/temp"
export TMP="$SCRIPT_DIR/temp"

# === 0. Installation globale des dépendances système (FFmpeg & libsndfile) ===
echo "[0/8] Vérification et installation de FFmpeg (global)..."
if ! command -v ffmpeg &> /dev/null; then
    echo "FFmpeg non détecté. Installation via apt..."
    sudo apt update && sudo apt install -y ffmpeg libsndfile1
else
    echo "FFmpeg est déjà installé globalement au niveau système."
fi

# === 1. Création de l'arborescence des répertoires ===
echo "[1/8] Création des répertoires de travail..."
mkdir -p downloads temp models cache output lora_output datasets
mkdir -p app/data app/server/public/audio

# Redirection des téléchargements automatiques vers le dossier models
export HF_HOME="$SCRIPT_DIR/models"
export MODELSCOPE_CACHE="$SCRIPT_DIR/models"

# === 2. Sélection GPU / CUDA ===
echo ""
echo "Sélectionnez votre GPU :"
echo "  1. NVIDIA GTX 10xx (Pascal) -> CUDA 11.8"
echo "  2. NVIDIA RTX 20xx / 30xx   -> CUDA 12.6"
echo "  3. NVIDIA RTX 40xx / 50xx   -> CUDA 12.8"
echo "  4. CPU uniquement (pas de GPU)"
echo ""
read -p "Entrez votre choix (1-4) : " GPU_CHOICE

case "$GPU_CHOICE" in
  1)
    CUDA_VERSION="cu118"
    CUDA_NAME="CUDA 11.8"
    ;;
  2)
    CUDA_VERSION="cu126"
    CUDA_NAME="CUDA 12.6"
    ;;
  3)
    CUDA_VERSION="cu128"
    CUDA_NAME="CUDA 12.8"
    ;;
  4)
    CUDA_VERSION="cpu"
    CUDA_NAME="CPU only"
    ;;
  *)
    echo "Choix invalide !"
    exit 1
    ;;
esac

echo "Option sélectionnée : $CUDA_NAME"
echo ""

# === 3. Installation de 'uv' & Création de l'environnement venv ===
if ! command -v uv &> /dev/null; then
    echo "['uv' non détecté. Installation de uv...]"
    curl -LsSf https://astral.sh/uv/install.sh | sh
    source "$HOME/.local/bin/env" 2>/dev/null || true
fi

echo "[2/8] Configuration de l'environnement virtuel Python 3.12.3 avec 'uv'..."
if [ -d ".venv" ]; then
    echo "Suppression de l'ancien venv pour un reset propre..."
    rm -rf .venv
fi

uv venv --python 3.12.3 .venv
source .venv/bin/activate

# === 4. Installation des outils de build C++/Python ===
echo "[3/8] Installation des outils de build (hatchling, cmake, ninja)..."
uv pip install hatchling editables cmake "ninja>=1.13.0" setuptools wheel

# === 5. Installation de PyTorch ===
echo "[4/8] Installation de PyTorch 2.10.0 ($CUDA_NAME)..."
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

# === 6. Dépendances Python d'ACE-Step ===
echo "[5/8] Installation des dépendances ACE-Step..."

# Installation du paquet local nano-vllm
if [ -d "ACE-Step-1.5/acestep/third_parts/nano-vllm" ]; then
    uv pip install -e ACE-Step-1.5/acestep/third_parts/nano-vllm/
fi

# Triton pour Linux (torch.compile / CUDA graphs)
if [ "$CUDA_VERSION" != "cpu" ]; then
    uv pip install "triton>=3.0.0"
fi

# Dépendances système globales (sans torchcodec)
uv pip install "transformers>=4.51.0,<4.58.0" diffusers gradio==6.2.0 matplotlib scipy soundfile loguru einops accelerate fastapi diskcache "uvicorn[standard]" numba vector-quantize-pytorch "torchao>=0.16.0,<0.17.0" toml peft modelscope tensorboard typer-slim hf_transfer hf_xet lightning lycoris-lora safetensors xxhash "pytorch-wavelets>=1.3.0" "pywavelets>=1.9.0" "bitsandbytes>=0.50.0"

# Installation du package ACE-Step-1.5
if [ -d "ACE-Step-1.5" ]; then
    uv pip install -e ACE-Step-1.5/ --no-deps
fi

# === 7. Vérification de Node.js LTS ===
echo "[6/8] Vérification de Node.js..."
if ! command -v node &> /dev/null; then
    echo "ERREUR: Node.js n'est pas installé. Veuillez installer Node.js 22 LTS."
    exit 1
fi

# === 8. Dépendances npm & Build Frontend ===
echo "[7/8] Installation des dépendances npm frontend et serveur..."
cd app
npm install
cd server
npm install
cd "$SCRIPT_DIR/app"

echo "[8/8] Compilation du frontend..."
npx vite build
cd "$SCRIPT_DIR"

# Sauvegarde de la configuration GPU
echo "$CUDA_VERSION" > cuda_version.txt

echo ""
echo "========================================"
echo "   Installation terminée avec succès !"
echo "   (FFmpeg global + SoundFile configuré)"
echo
echo "   Pour démarrer : ./run.sh"
echo "   Les modèles se téléchargent automatiquement au premier lancement."
echo "========================================"
