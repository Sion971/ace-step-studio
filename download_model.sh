#!/usr/bin/env bash
# =============================================================================
#  ACE-Step Studio — telechargement de modeles (Linux, x86_64 et aarch64)
#
#  Equivalent de download_model.bat. Utilise le .venv deja en place (voir
#  install.sh) — aucune logique specifique a l'architecture n'est necessaire
#  ici, huggingface_hub ne fait que telecharger des fichiers.
#
#  Usage : ./download_model.sh
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ ! -d ".venv" ]; then
    echo "ERREUR : L'environnement virtuel (.venv) n'a pas ete trouve !"
    echo "Veuillez d'abord executer ./install.sh"
    exit 1
fi

export HF_HOME="$SCRIPT_DIR/models"
export HUGGINGFACE_HUB_CACHE="$SCRIPT_DIR/models"
export HF_HUB_ENABLE_HF_TRANSFER=1
mkdir -p "$HF_HOME"

source "$SCRIPT_DIR/.venv/bin/activate"

echo "========================================"
echo "   ACE-Step Studio - Telechargement de modeles"
echo "========================================"
echo ""
echo "Selectionnez le modele a telecharger :"
echo ""
echo "  1. XL Turbo - 18.8 Go, rapide, 8 etapes"
echo "  2. XL SFT - 18.8 Go, meilleure qualite, 50 etapes"
echo "  3. XL Turbo BF16 - 7.5 Go, compact, moins de VRAM"
echo "  4. Telecharger les trois"
echo ""
read -p "Entrez un numero (1-4) : " MODEL_CHOICE

download_turbo() {
    echo ""
    echo "Telechargement de ACE-Step XL Turbo..."
    python -m huggingface_hub.commands.huggingface_cli download ACE-Step/acestep-v15-xl-turbo \
        --local-dir "ACE-Step-1.5/checkpoints/acestep-v15-xl-turbo"
}

download_sft() {
    echo ""
    echo "Telechargement de ACE-Step XL SFT..."
    python -m huggingface_hub.commands.huggingface_cli download ACE-Step/acestep-v15-xl-sft \
        --local-dir "ACE-Step-1.5/checkpoints/acestep-v15-xl-sft"
}

download_bf16() {
    echo ""
    echo "Telechargement de ACE-Step XL Turbo BF16..."
    python -m huggingface_hub.commands.huggingface_cli download marcorez8/acestep-v15-xl-turbo-bf16 \
        --local-dir "ACE-Step-1.5/checkpoints/acestep-v15-xl-turbo-bf16"
}

case "$MODEL_CHOICE" in
    1) download_turbo ;;
    2) download_sft ;;
    3) download_bf16 ;;
    4)
        echo ""
        echo "Telechargement des trois modeles..."
        echo ""
        echo "[1/3] XL Turbo..."
        download_turbo
        echo ""
        echo "[2/3] XL SFT..."
        download_sft
        echo ""
        echo "[3/3] XL Turbo BF16..."
        download_bf16
        ;;
    *)
        echo "Choix invalide !"
        exit 1
        ;;
esac

echo ""
echo "========================================"
echo "   Telechargement termine !"
echo "========================================"
