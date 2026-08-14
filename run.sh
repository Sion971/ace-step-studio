#!/usr/bin/env bash
# =============================================================================
#  ACE-Step Studio — lanceur (portage Linux)
#
#  Usage :  ./run.sh [options]
#
#    --no-lm         Démarre sans le modèle de langue local (5Hz LM 0.6B).
#                    Libère ~1 Go de VRAM. Recommandé pour l'entraînement LoRA
#                    et la génération pure DiT. La génération perd l'expansion
#                    de prompt et les métadonnées automatiques (compensable
#                    avec une clé OpenRouter dans les réglages).
#
#    --gradio-only   Lance uniquement le moteur ACE-Step (UI Gradio, port 8001),
#                    sans Express ni frontend React. Utile pour la préparation
#                    de dataset : l'étiquetage et la sauvegarde ne fonctionnent
#                    que dans Gradio (voir TROUBLESHOOTING.md).
#
#    --no-browser    N'ouvre pas automatiquement le navigateur.
#
#    --port <n>      Port du serveur web (défaut : 3001).
#
#    --help          Affiche cette aide.
# =============================================================================

set -e

# --- Analyse des arguments ---------------------------------------------------
NO_LM=false
GRADIO_ONLY=false
NO_BROWSER=false
WEB_PORT=3001

show_help() {
    sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'
    exit 0
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --no-lm)       NO_LM=true; shift ;;
        --gradio-only) GRADIO_ONLY=true; shift ;;
        --no-browser)  NO_BROWSER=true; shift ;;
        --port)        WEB_PORT="$2"; shift 2 ;;
        --help|-h)     show_help ;;
        *)
            echo "Option inconnue : $1"
            echo "Utilisez --help pour la liste des options."
            exit 1
            ;;
    esac
done

# --- Arrêt propre (Ctrl+C) ---------------------------------------------------
cleanup() {
    echo -e "\n[ACE-Step Studio] Arrêt des services en cours..."
    pkill -P $$ || true
    exit 0
}
trap cleanup SIGINT SIGTERM

# === 1. Chemins de base ======================================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

export PATH="$SCRIPT_DIR/.venv/bin:$PATH"

# NE PAS ajouter $SCRIPT_DIR/.venv/lib à LD_LIBRARY_PATH : ce dossier ne
# contient aucun .so, et le placer en tête de la liste de recherche fait
# passer le libnppicc système (CUDA 12.0) devant celui que PyTorch fournit
# dans site-packages/nvidia/ — torchcodec échoue alors au chargement.
# Voir TROUBLESHOOTING.md, section « Could not load libtorchcodec ».

echo "========================================"
if $GRADIO_ONLY; then
    echo "   ACE-Step Studio — Gradio seul"
else
    echo "   ACE-Step Studio (Single Terminal)"
fi
$NO_LM && echo "   Mode sans LM local"
echo "========================================"

# === 2. Vérifications des prérequis ==========================================
if [ ! -d ".venv" ]; then
    echo "ERREUR : L'environnement virtuel (.venv) n'a pas été trouvé !"
    echo "Veuillez d'abord exécuter ./install.sh"
    exit 1
fi

if [ ! -d "ACE-Step-1.5" ]; then
    echo "ERREUR : Le répertoire ACE-Step-1.5 est introuvable !"
    exit 1
fi

if ! $GRADIO_ONLY && ! command -v node &> /dev/null; then
    echo "ERREUR : Node.js n'est pas installé ou n'est pas dans le PATH !"
    exit 1
fi

# === 3. Environnement virtuel ================================================
source "$SCRIPT_DIR/.venv/bin/activate"

# === 4. Stockage et cache ====================================================
export TEMP="$SCRIPT_DIR/temp"
export TMP="$SCRIPT_DIR/temp"
mkdir -p "$TEMP"

export HF_HOME="$SCRIPT_DIR/models"
export HUGGINGFACE_HUB_CACHE="$SCRIPT_DIR/models"
export HF_HUB_ENABLE_HF_TRANSFER=1
mkdir -p "$HF_HOME"

export TORCH_HOME="$SCRIPT_DIR/models/torch"
mkdir -p "$TORCH_HOME"

export XDG_CACHE_HOME="$SCRIPT_DIR/cache"
mkdir -p "$XDG_CACHE_HOME"

export PYTHONIOENCODING=utf-8
export PYTHONUNBUFFERED=1

# PyTorch >= 2.9 lit PYTORCH_ALLOC_CONF ; l'ancien nom reste pour compatibilité.
export PYTORCH_ALLOC_CONF=expandable_segments:True
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True

# === 5. Configuration du pipeline ACE-Step ===================================
export PYTHON_PATH="$SCRIPT_DIR/.venv/bin/python"
export ACESTEP_PATH="$SCRIPT_DIR/ACE-Step-1.5"
export DEFAULT_MODEL="${DEFAULT_MODEL:-acestep-v15-base}"
export MANAGE_PIPELINE="true"
export PORT="$WEB_PORT"

# Chemins datasets — TOUS sous ACE-Step-1.5/, jamais à la racine du Studio.
export DATASETS_DIR="$SCRIPT_DIR/ACE-Step-1.5/datasets"
export DATASETS_UPLOADS_DIR="$DATASETS_DIR/uploads"
export PREPROCESSED_TENSORS_DIR="$DATASETS_DIR/preprocessed_tensors"
export TENSOR_DIR="$PREPROCESSED_TENSORS_DIR"

export GRADIO_ALLOWED_PATHS="$DATASETS_DIR,$SCRIPT_DIR/ACE-Step-1.5"

mkdir -p "$PREPROCESSED_TENSORS_DIR" "$DATASETS_UPLOADS_DIR"

# === 6. Fichier .env du moteur ===============================================
# Chargé AVANT les options de ligne de commande : celles-ci doivent gagner.
if [ -f "$SCRIPT_DIR/ACE-Step-1.5/.env" ]; then
    echo "Chargement de la configuration depuis ACE-Step-1.5/.env..."
    set -a
    source "$SCRIPT_DIR/ACE-Step-1.5/.env"
    set +a
fi

# --- Options de ligne de commande (priorité sur le .env) ---
if $NO_LM; then
    # INIT_LLM est lu par le serveur Express, qui construit la ligne de
    # commande du pipeline. ACESTEP_INIT_LLM ne sert qu'en lancement direct.
    export INIT_LLM="false"
    export ACESTEP_INIT_LLM="false"
fi

$NO_BROWSER && export NO_AUTO_BROWSER="true"

if [ -f "cuda_version.txt" ]; then
    echo "Configuration GPU/CUDA : $(cat cuda_version.txt)"
fi

# === 7. Mode Gradio seul =====================================================
if $GRADIO_ONLY; then
    INIT_LLM_ARG="true"
    $NO_LM && INIT_LLM_ARG="false"

    echo ""
    echo "========================================"
    echo "   UI Gradio : http://127.0.0.1:8001"
    echo "   Ctrl+C pour arrêter"
    echo "========================================"
    echo ""

    cd "$SCRIPT_DIR/ACE-Step-1.5"
    exec "$PYTHON_PATH" -u -m acestep.acestep_v15_pipeline \
        --config_path "$DEFAULT_MODEL" \
        --port 8001 \
        --init_service true \
        --init_llm "$INIT_LLM_ARG" \
        --enable-api \
        --offload_to_cpu true
fi

# === 8. Dépendances npm ======================================================
if [ ! -d "app/node_modules" ]; then
    echo "Installation des dépendances npm (frontend)..."
    (cd app && npm install)
fi

if [ ! -d "app/server/node_modules" ]; then
    echo "Installation des dépendances npm (serveur)..."
    (cd app/server && npm install)
fi

# === 9. Compilation du frontend ==============================================
if [ ! -d "app/dist" ]; then
    echo "Compilation du frontend..."
    (cd app && npx vite build)
fi

# === 10. Répertoires de sortie ===============================================
mkdir -p app/data app/server/public/audio

echo ""
echo "========================================"
echo "   Mode Terminal Unique (Linux)"
echo "   Express + Pipeline + Frontend"
echo "   UI : http://localhost:$WEB_PORT"
echo "   Appuyez sur Ctrl+C pour tout arrêter"
echo "========================================"
echo ""

# === 11. Démarrage du serveur Express ========================================
TSX_BIN="$SCRIPT_DIR/app/server/node_modules/.bin/tsx"
if [ -f "$TSX_BIN" ]; then
    exec "$TSX_BIN" "$SCRIPT_DIR/app/server/src/index.ts"
else
    exec npx --prefix "$SCRIPT_DIR/app/server" tsx "$SCRIPT_DIR/app/server/src/index.ts"
fi
