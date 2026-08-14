#!/usr/bin/env bash
set -e

# Pointer vers les .so et executables logés dans le .venv
export LD_LIBRARY_PATH="/home/studio/ACE-Step-Studio-master/.venv/lib:$LD_LIBRARY_PATH"
export PATH="/home/studio/ACE-Step-Studio-master/.venv/bin:$PATH"

# === Gestion propre de l'arrêt (Ctrl+C) ===
cleanup() {
    echo -e "\n[ACE-Step Studio] Arrêt des services en cours..."
    pkill -P $$ || true
    exit 0
}
trap cleanup SIGINT SIGTERM

echo "========================================"
echo "   ACE-Step Studio (Single Terminal)"
echo "========================================"

# === 1. Chemins de base ===
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# === 2. Vérifications des prérequis ===
if [ ! -d ".venv" ]; then
    echo "ERREUR : L'environnement virtuel (.venv) n'a pas été trouvé !"
    echo "Veuillez d'abord exécuter ./install.sh"
    exit 1
fi

if ! command -v node &> /dev/null; then
    echo "ERREUR : Node.js n'est pas installé ou n'est pas dans le PATH !"
    exit 1
fi

if [ ! -d "ACE-Step-1.5" ]; then
    echo "ERREUR : Le répertoire ACE-Step-1.5 est introuvable !"
    exit 1
fi

# === 3. Activation de l'environnement virtuel uv ===
source "$SCRIPT_DIR/.venv/bin/activate"

# === 4. Variables d'environnement de stockage et de cache ===
export TEMP="$SCRIPT_DIR/temp"
export TMP="$SCRIPT_DIR/temp"
mkdir -p "$TEMP"

export HF_HOME="$SCRIPT_DIR/models"
export TRANSFORMERS_CACHE="$SCRIPT_DIR/models"
export HUGGINGFACE_HUB_CACHE="$SCRIPT_DIR/models"
export HF_HUB_ENABLE_HF_TRANSFER=1
mkdir -p "$HF_HOME"

# Sub-dossier PyTorch cache
export TORCH_HOME="$SCRIPT_DIR/models/torch"
mkdir -p "$TORCH_HOME"

export XDG_CACHE_HOME="$SCRIPT_DIR/cache"
mkdir -p "$XDG_CACHE_HOME"

if [ -x "$SCRIPT_DIR/ffmpeg/ffmpeg" ]; then
    export PATH="$SCRIPT_DIR/ffmpeg:$PATH"
fi

export PYTHONIOENCODING=utf-8
export PYTHONUNBUFFERED=1
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True

# === 5. Configuration globale du Pipeline ACE-Step ===
export PYTHON_PATH="$SCRIPT_DIR/.venv/bin/python"
# Racine du Studio
export ACESTEP_PATH="$SCRIPT_DIR/ACE-Step-1.5"
export DEFAULT_MODEL="marcorez8/acestep-v15-xl-turbo-bf16"
export MANAGE_PIPELINE="true"

# Réalignement complet de la racine de l'application
# export DATASETS_DIR="$SCRIPT_DIR/datasets"
# export DATASETS_UPLOADS_DIR="$SCRIPT_DIR/datasets/uploads"
# export GRADIO_ALLOWED_PATHS="$SCRIPT_DIR/dataset"

# === 6. Chargement du fichier .env du moteur ACE-Step 1.5 ===
if [ -f "$SCRIPT_DIR/ACE-Step-1.5/.env" ]; then
    echo "Chargement de la configuration depuis ACE-Step-1.5/.env..."
    set -a
    source "$SCRIPT_DIR/ACE-Step-1.5/.env"
    set +a
fi

if [ -f "cuda_version.txt" ]; then
    CUDA_VERSION=$(cat cuda_version.txt)
    echo "Configuration GPU/CUDA : $CUDA_VERSION"
fi

# === 7. Vérification des dépendances npm ===
if [ ! -d "app/node_modules" ]; then
    echo "Installation des dépendances npm pour l'application frontend..."
    cd app
    npm install
    cd "$SCRIPT_DIR"
fi

if [ ! -d "app/server/node_modules" ]; then
    echo "Installation des dépendances npm pour le serveur backend..."
    cd app/server
    npm install
    cd "$SCRIPT_DIR"
fi

# === 8. Compilation du Frontend si nécessaire ===
if [ ! -d "app/dist" ]; then
    echo "Compilation du frontend..."
    cd app
    npx vite build
    cd "$SCRIPT_DIR"
fi

 # === 9. Préparation des répertoires de sortie ===
mkdir -p app/data
mkdir -p app/server/public/audio

echo ""
echo "========================================"
echo "   Mode Terminal Unique (Linux)"
echo "   Express + Pipeline + Frontend"
echo "   UI : http://localhost:3001"
echo "   Appuyez sur Ctrl+C pour tout arrêter"
echo "========================================"
echo ""

# === 10. Démarrage du serveur Express ===
TSX_BIN="$SCRIPT_DIR/app/server/node_modules/.bin/tsx"
if [ -f "$TSX_BIN" ]; then
    "$TSX_BIN" "$SCRIPT_DIR/app/server/src/index.ts"
else
    npx --prefix "$SCRIPT_DIR/app/server" tsx "$SCRIPT_DIR/app/server/src/index.ts"
fi
