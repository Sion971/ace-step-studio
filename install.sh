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
echo ""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

export TEMP="$SCRIPT_DIR/temp"
export TMP="$SCRIPT_DIR/temp"

# === 0. Dépendances système ==================================================
# FFmpeg et libsndfile sont testés séparément : sur une machine où FFmpeg est
# déjà présent, la branche unique d'origine sautait aussi libsndfile1.
echo "[1/14] Dépendances système..."

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
echo "[2/14] Création des répertoires de travail..."
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
# Xet est le mecanisme de transfert actif par defaut depuis
# huggingface_hub>=0.32.0 (confirme officiellement) — ce reglage
# accelere les telechargements/televersements en saturant la bande
# passante et les coeurs CPU disponibles, quelle que soit la version
# de huggingface_hub installee (0.36.x ou 1.x).
export HF_XET_HIGH_PERFORMANCE=1

# Version CUDA maximale prise en charge par le pilote NVIDIA. Sert a PRESELECTIONNER la pile et
# a controler le plancher de pilote. Deux sources, la seconde ne dependant pas de la mise en forme :
#   1. l'en-tete de nvidia-smi. Son libelle a CHANGE : « CUDA Version: 13.0 » est devenu
#      « CUDA UMD Version: 13.4 » sur les pilotes recents (serie 615 : « KMD Version » aussi) ;
#   2. a defaut, deduite du NUMERO de pilote (nvidia-smi --query-gpu=driver_version), avec la table
#      des pilotes minimaux publiee par NVIDIA. Plus recent que la table : « au moins 13.2 ».
hw_cuda_from_driver() {
    awk -v v="$1" 'BEGIN {
        split(v, a, "."); m = a[1] + 0
        if (m >= 595) print "13.2"
        else if (m >= 590) print "13.1"
        else if (m >= 580) print "13.0"
        else if (m >= 575) print "12.9"
        else if (m >= 570) print "12.8"
        else if (m >= 560) print "12.6"
        else if (m >= 555) print "12.5"
        else if (m >= 550) print "12.4"
        else if (m >= 545) print "12.3"
        else if (m >= 535) print "12.2"
        else if (m >= 530) print "12.1"
        else if (m >= 525) print "12.0"
        else if (m >= 520) print "11.8"
        else if (m >= 470) print "11.4"
        else if (m > 0) print "11.0"
    }'
}
DRIVER_CUDA=""
DRIVER_CUDA_NOTE=""
if command -v nvidia-smi &> /dev/null; then
    DRIVER_CUDA=$(nvidia-smi 2>/dev/null | sed -n 's/.*CUDA[A-Za-z ]*Version: *\([0-9][0-9]*\.[0-9][0-9]*\).*/\1/p' | head -1)
    if [ -z "$DRIVER_CUDA" ]; then
        DRIVER_VERSION=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -1 | tr -d '[:space:]')
        DRIVER_CUDA=$(hw_cuda_from_driver "$DRIVER_VERSION")
        if [ -n "$DRIVER_CUDA" ]; then
            DRIVER_CUDA_NOTE=" (déduit du numéro de pilote $DRIVER_VERSION)"
        fi
    fi
fi

# === Detection du materiel (lecture seule) ===================================
# Rien n'est installe ici. Sert a SUGGERER une option du menu, a conseiller une mise a jour
# du pilote, et a regler les modeles par defaut selon la VRAM (hardware_profile.env, ecrit
# en fin d'installation et lu par run.sh). GPU 0 uniquement, comme le moteur.
HW_GPU_NAME=""; HW_VRAM_MIB=""; HW_COMPUTE_CAP=""
if command -v nvidia-smi &> /dev/null; then
    # Le nom est ecrit dans hardware_profile.env, que run.sh EXECUTE (source) : jeu de
    # caracteres restreint, donc aucune metacaractere shell possible.
    HW_GPU_NAME=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1 | sed 's/^ *//;s/ *$//' | tr -cd '[:alnum:] ._+()/-')
    HW_VRAM_MIB=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1 | tr -d '[:space:]')
    HW_COMPUTE_CAP=$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null | head -1 | tr -d '[:space:]')
fi

# Famille du menu : CUDA 13.x couvre toutes les cartes a partir de Turing (capacite 7.5) ;
# en dessous (Pascal 6.x, Volta 7.0, Maxwell 5.x) : pile CUDA 12.6, derniere a les couvrir.
hw_suggest_option() {
    awk -v c="$1" 'BEGIN {
        if (c == "") exit
        if (c >= 7.5) print 1
        else print 2
    }'
}

# Palier ACE-Step 1.5 : MEMES seuils que acestep/gpu_config.py::get_gpu_tier (VRAM en Gio).
# ATTENTION a la source du nombre : ACE-Step lit torch.cuda.get_device_properties(0).total_memory,
# environ 4 % de MOINS que le memory.total de nvidia-smi (7,609 contre 7,960 Gio sur une RTX 5060).
# Avant l'installation de PyTorch on n'a que nvidia-smi (estimation) ; le profil ecrit en fin
# d'installation utilise la mesure de PyTorch.
hw_ace_tier() {
    awk -v m="$1" 'BEGIN {
        g = m / 1024
        if (g <= 4) t = "1"
        else if (g <= 6) t = "2"
        else if (g <= 8) t = "3"
        else if (g <= 12) t = "4"
        else if (g < 15.5) t = "5"
        else if (g < 20) t = "6a"
        else if (g <= 24) t = "6b"
        else t = "unlimited"
        print t
    }'
}

# VRAM « nominale » en Go, celle du constructeur : 7,96 Gio -> 8.
hw_vram_class() { awk -v m="$1" 'BEGIN { printf "%d", m / 1024 + 0.5 }'; }

# Modele DiT par defaut. XL BF16 : VRAM min annoncee par le Studio = 8 Go. En dessous,
# le DiT 2B turbo (min annoncee 6 Go ; pris en charge des 4 Go par ACE-Step, INT8 + deport CPU).
hw_default_model() {
    if [ "${1:-0}" -ge 8 ]; then echo "acestep-v15-xl-turbo-bf16"; else echo "acestep-v15-turbo"; fi
}
# ACE-Step ne propose aucun LM aux paliers 1 et 2 (<= 6 Gio).
hw_init_llm() { case "$1" in 1|2) echo "false" ;; *) echo "true" ;; esac; }
hw_recommended_lm() { case "$1" in 1|2) echo "aucun" ;; 3|4) echo "0.6B" ;; 5|6a|6b) echo "1.7B" ;; *) echo "4B" ;; esac; }

# === 2. Sélection GPU / CUDA =================================================
echo ""
HW_SUGGESTED_OPTION=""
if [ -n "$HW_GPU_NAME" ]; then
    HW_SUGGESTED_OPTION=$(hw_suggest_option "$HW_COMPUTE_CAP")
    echo "GPU détecté : $HW_GPU_NAME — $(hw_vram_class "${HW_VRAM_MIB:-0}") Go de VRAM (palier ACE-Step $(hw_ace_tier "${HW_VRAM_MIB:-0}")), capacité de calcul $HW_COMPUTE_CAP"
    if [ -n "$DRIVER_CUDA" ]; then
        echo "Pilote NVIDIA : prend en charge CUDA $DRIVER_CUDA au maximum${DRIVER_CUDA_NOTE}"
    fi
    if [ -n "$HW_SUGGESTED_OPTION" ]; then
        echo "Option suggérée : $HW_SUGGESTED_OPTION (Entrée pour l'accepter)"
    fi
else
    echo "Aucun GPU NVIDIA détecté (nvidia-smi absent ou muet)."
    echo "Si vous avez une carte NVIDIA, installez d'abord son pilote propriétaire, puis relancez ce script."
fi
echo ""
echo "Sélectionnez votre GPU :"
echo "  1. NVIDIA RTX 20xx ou plus récente (Turing, Ampere, Ada, Blackwell) -> CUDA 13.0 ou 12.8"
echo "  2. NVIDIA GTX 10xx (Pascal) ou Volta                              -> CUDA 12.6 (anciennes cartes)"
echo "  3. CPU uniquement (pas de GPU)"
echo "  4. AMD GPU (ROCm)"
echo ""
read -p "Entrez votre choix (1-4)${HW_SUGGESTED_OPTION:+ [suggestion : $HW_SUGGESTED_OPTION]} : " GPU_CHOICE
GPU_CHOICE="${GPU_CHOICE:-$HW_SUGGESTED_OPTION}"

case "$GPU_CHOICE" in
  1)
    # Une RTX 50xx n'est reconnue qu'a partir du pilote 570 (CUDA 12.8) : en dessous, AUCUNE
    # pile ne fonctionne. Le dire avant d'installer plusieurs Go de paquets.
    if [ -n "$HW_COMPUTE_CAP" ] && [ -n "$DRIVER_CUDA" ] && awk "BEGIN {exit !($HW_COMPUTE_CAP >= 10.0 && $DRIVER_CUDA < 12.8)}" 2>/dev/null; then
        echo ""
        echo "ERREUR : votre pilote NVIDIA ne gère que CUDA $DRIVER_CUDA."
        echo "  Une RTX 50xx exige un pilote 570 ou plus (CUDA 12.8) ; 580 ou plus pour la pile CUDA 13.0."
        echo "  Mettez à jour le pilote (gestionnaire de pilotes de votre distribution), puis relancez ce script."
        read -p "Continuer malgré tout ? [o/N] " -n 1 -r
        echo
        [[ $REPLY =~ ^[Oo]$ ]] || exit 1
    fi
    # Pile CUDA : la plus recente que le pilote permet. La detection ne fait que PRESELECTIONNER.
    #   CUDA 13.0 + PyTorch 2.14.1 : defaut de PyTorch ; exige un pilote NVIDIA 580 ou plus.
    #   CUDA 12.8 + PyTorch 2.11.0 : pour les pilotes plus anciens (derniere pile cu128).
    # CUDA 13.2 n'est pas propose : classe experimental par PyTorch, et torchaudio (derniere
    # version 2.11.0) / torchcodec en cu132 ne sont pas verifies.
    if [ -n "$DRIVER_CUDA" ] && awk "BEGIN {exit !($DRIVER_CUDA >= 13.0)}" 2>/dev/null; then
        ST_DEFAULT=1
    else
        ST_DEFAULT=2
    fi
    echo ""
    echo "Pile CUDA :"
    echo "  1. CUDA 13.0 — PyTorch 2.14.1  (la plus récente et stable ; exige un pilote NVIDIA 580 ou plus)"
    echo "  2. CUDA 12.8 — PyTorch 2.11.0  (pour les pilotes plus anciens)"
    if [ -n "$DRIVER_CUDA" ]; then
        echo "  Pilote détecté : CUDA $DRIVER_CUDA — suggestion : option $ST_DEFAULT."
        if [ "$ST_DEFAULT" = 2 ]; then
            echo "  (La pile CUDA 13.0 demande un pilote NVIDIA 580 ou plus.)"
        fi
    else
        echo "  Pilote NVIDIA non détecté (nvidia-smi) — suggestion prudente : option 2."
    fi
    read -p "Votre choix [$ST_DEFAULT] : " ST_CHOICE
    case "${ST_CHOICE:-$ST_DEFAULT}" in
      1) CUDA_VERSION="cu130"; CUDA_NAME="CUDA 13.0" ;;
      2) CUDA_VERSION="cu128"; CUDA_NAME="CUDA 12.8" ;;
      *) echo "Choix invalide !"; exit 1 ;;
    esac
    ;;
  2)
    # Pascal (6.x), Volta (7.0), Maxwell (5.x) : CUDA 13.x ne les prend plus en charge. CUDA 12.6
    # est la derniere pile a les couvrir ; PyTorch 2.14 est la derniere serie a la publier.
    # (cu118 a disparu : l'index PyTorch s'arrete a torch 2.7.1.)
    CUDA_VERSION="cu126"; CUDA_NAME="CUDA 12.6 (anciennes cartes)" ;;
  3) CUDA_VERSION="cpu";   CUDA_NAME="CPU only" ;;
  4)
    # ROCm : pas reimplemente ici, redirection vers le script dedie
    # d'ACE-Step-1.5, deja autonome (son propre venv_rocm, son propre
    # lancement direct du pipeline sans passer par notre serveur Node) —
    # meme principe que install.bat sous Windows (redirection vers
    # start_gradio_ui_rocm.bat plutot que reimplementation : l'architecture
    # de roue est specifique a chaque GPU exact, et un bug du resolveur pip
    # documente cote AMD rend une gestion generique peu fiable).
    echo ""
    echo "Le support AMD/ROCm n'est pas gere par ce script."
    echo "Utilisez le lanceur dedie d'ACE-Step-1.5 a la place :"
    echo "  cd ACE-Step-1.5 && ./start_gradio_ui_rocm.sh"
    echo "Voir les instructions completes en tete de ce fichier."
    exit 0
    ;;
  *) echo "Choix invalide !"; exit 1 ;;
esac

echo "Option sélectionnée : $CUDA_NAME"
echo ""

# === 2a. Pilote NVIDIA : plancher de chaque pile ==============================
# PyTorch ne voit pas le GPU si le pilote est plus ancien que la pile (torch.cuda.is_available()
# renvoie False) : autant le dire avant d'installer. Planchers (NVIDIA, « CUDA minor version
# compatibility ») : CUDA 13.x -> pilote >= 580 ; CUDA 12.x -> pilote >= 525.
HW_DRIVER_NEEDED=""
case "$CUDA_VERSION" in
    cu130)       HW_DRIVER_NEEDED="13.0"; HW_DRIVER_SERIES="580" ;;
    cu126|cu128) HW_DRIVER_NEEDED="12.0"; HW_DRIVER_SERIES="525" ;;
esac
if [ -n "$HW_DRIVER_NEEDED" ]; then
    if [ -z "$DRIVER_CUDA" ]; then
        echo "ATTENTION : version CUDA du pilote illisible (nvidia-smi) — vérification ignorée."
    elif awk "BEGIN {exit !($DRIVER_CUDA >= $HW_DRIVER_NEEDED)}" 2>/dev/null; then
        echo "Pilote NVIDIA : CUDA $DRIVER_CUDA — compatible avec la pile $CUDA_VERSION."
    else
        echo "ERREUR : votre pilote NVIDIA ne gère que CUDA $DRIVER_CUDA."
        echo "  La pile $CUDA_NAME exige un pilote de la série $HW_DRIVER_SERIES ou plus récente :"
        echo "  PyTorch ne verrait pas votre GPU. Mettez à jour le pilote (gestionnaire de pilotes de"
        echo "  votre distribution), puis relancez ce script."
        read -p "Continuer malgré tout ? [o/N] " -n 1 -r
        echo
        [[ $REPLY =~ ^[Oo]$ ]] || exit 1
    fi
    echo ""
fi

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
        # flash-attn attend un format entier ("120"), pas la notation
        # decimale de nvidia-smi ("12.0") — sinon sa propre variable
        # d'environnement (voir plus bas) ne serait jamais reconnue.
        FLASH_ATTN_ARCH="${COMPUTE_CAP/./}"
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

echo "[3/14] Environnement virtuel Python 3.12.3..."
if [ -d ".venv" ]; then
    echo "Suppression de l'ancien venv pour un reset propre..."
    rm -rf .venv
fi

uv venv --python 3.12.3 .venv
source .venv/bin/activate

# === 4. Outils de build ======================================================
echo "[4/14] Outils de build (hatchling, cmake, ninja)..."
uv pip install hatchling editables cmake "ninja>=1.13.0" setuptools wheel

# === 5. PyTorch ==============================================================
# Deux piles selon le choix de GPU : cu130 -> torch 2.14.1 ; les autres -> torch 2.11.0.
# PyTorch ne publie plus de roues CUDA 12.8 a partir de la 2.12, et la 2.14 est la derniere
# serie a publier des roues CUDA 12.x : la 2.11 est donc la derniere pile cu128. La pile
# cu130 est le defaut de PyTorch (valide sur RTX 5060 8 Go : generation, chargement de LoRA,
# Cover, DCW ; entrainement complet non valide). Sur cu130, torchaudio reste epingle a
# 2.11.0 (sa derniere version ; la roue +cu130 existe), comme sur les autres piles.
if [ "$CUDA_VERSION" = "cu130" ]; then PYTORCH_VERSION="2.14.1"; else PYTORCH_VERSION="2.11.0"; fi
echo "[5/14] PyTorch $PYTORCH_VERSION ($CUDA_NAME)..."
# Base unique Linux : torch 2.11.0. L'ancienne base torch 2.10.0 +
# torchao 0.16 a ete retiree : sa roue flash-attn precompilee
# (torch2.10) n'existe pas dans la release v0.9.4 (404), d'ou une
# compilation longue a chaque installation. La combinaison
# huggingface-hub<1.0 (voir plus bas) +
# torchao dans la serie 0.17.x + diffusers==0.40.0 fonctionne
# desormais correctement, quantification comprise — confirme en
# pratique sur 8 Go de VRAM, generation complete reussie sans erreur.
# Aucune restriction de VRAM minimale n'est necessaire avec ces
# versions precises.
#
# torchvision/torchcodec volontairement NON epingles (voir l'incident
# deja rencontre cote Windows avec un pin explicite devenu incompatible)
# — le resolveur de pip choisit la version compagnon correcte de
# torch==2.11.0. torchaudio EST epingle, a l'inverse, deliberement : le
# projet est en fin de vie a partir de torch 2.11 (torchaudio 2.11.0 est
# la DERNIERE version jamais publiee, ABI stable, fonctionnelle avec
# toutes les versions futures sans nouvelle publication necessaire).
#
# Installation via pip CLASSIQUE, pas uv, pour ce paquet precis — uv
# echouait de facon reproductible avec "The wheel is invalid: Invalid
# Wheel-Version in WHEEL file: None" sur nvidia-nccl-cu12, une roue NVIDIA
# tierce dont le format semble declencher un bug de validation cote uv.
# Garde AVANT telechargement : l'index PyTorch propose-t-il torch $PYTORCH_VERSION pour cette
# pile ? Sans elle, une pile dont les roues ont disparu de l'index (cu118 s'arrete a torch
# 2.7.1) echoue au milieu d'un resolveur pip cryptique. Silencieuse si curl est absent ou
# si l'index est injoignable : pip dira alors lui-meme ce qui ne va pas.
if [ "$CUDA_VERSION" != "cpu" ] && command -v curl &> /dev/null; then
    PT_INDEX_HTML=$(curl -s --max-time 25 "https://download.pytorch.org/whl/$CUDA_VERSION/torch/" 2>/dev/null || true)
    if [ -n "$PT_INDEX_HTML" ] && ! echo "$PT_INDEX_HTML" | grep -Eq "torch-${PYTORCH_VERSION}(\+|%2[Bb])${CUDA_VERSION}-cp312-cp312-manylinux[^\"< ]*x86_64\.whl"; then
        PT_LATEST=$(echo "$PT_INDEX_HTML" | grep -Eo "torch-[0-9.]+(\+|%2[Bb])${CUDA_VERSION}-cp312-cp312-manylinux[^\"< ]*x86_64\.whl" | sed -E 's/^torch-([0-9.]+)(\+|%2[Bb]).*/\1/' | sort -uV | tail -1)
        echo "ERREUR : l'index PyTorch ne propose pas torch $PYTORCH_VERSION pour $CUDA_VERSION (Python 3.12, Linux x86_64)."
        echo "  Dernière version disponible pour cette pile : ${PT_LATEST:-aucune}."
        echo "  Choisissez une autre pile, ou ouvrez un ticket : cette pile n'est plus installable telle quelle."
        exit 1
    fi
fi
uv pip install --upgrade pip
if [ "$CUDA_VERSION" = "cpu" ]; then
    .venv/bin/python -m pip install \
        torch==2.11.0 \
        torchvision \
        torchaudio==2.11.0 \
        torchcodec \
        --index-url https://download.pytorch.org/whl/cpu
elif [ "$CUDA_VERSION" = "cu130" ]; then
    .venv/bin/python -m pip install \
        torch==2.14.1 \
        torchvision \
        torchaudio==2.11.0 \
        torchcodec \
        --index-url https://download.pytorch.org/whl/cu130
else
    .venv/bin/python -m pip install \
        torch==2.11.0 \
        torchvision \
        torchaudio==2.11.0 \
        torchcodec \
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
# Pile cu130 : torchcodec 0.17.0+cu130 charge sa bibliotheque, lit ET ecrit l'audio SANS ce
# paquet (verifie sur RTX 5060, nvidia-npp-cu12 desinstalle : torchaudio.load d'un MP3 stereo
# 48 kHz, puis torchaudio.save en wav, flac et mp3). C'est de plus un paquet CUDA 12,
# depareille avec la pile 13.0. Les autres piles le gardent : voir TROUBLESHOOTING.md §1.
if [ "$CUDA_VERSION" != "cpu" ] && [ "$CUDA_VERSION" != "cu130" ]; then
    echo "[5b/14] NVIDIA NPP (requis par torchcodec)..."
    uv pip install nvidia-npp-cu12
fi

# === 6. Dépendances Python d'ACE-Step ========================================
echo "[6/14] Dépendances ACE-Step..."

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
FLASH_ATTN_PREBUILT_DONE=false
if [ "$FLASH_ATTN_OK" = true ] && [ "$CUDA_VERSION" = "cu128" ] && [ "$FLASH_ATTN_ARCH" -ge 120 ]; then
    # Blackwell/sm_120 + cu128 : une roue precompilee existe (projet
    # communautaire actif, mjun0812/flash-attention-prebuild-wheels),
    # evitant entierement la compilation depuis les sources (plusieurs
    # minutes, et le risque de nvcc trop ancien documente plus bas).
    # Specifique a Python 3.12 (cp312) — correspond a notre venv, voir
    # Etape 3 plus haut. Si indisponible ou echoue pour une raison
    # quelconque, repli silencieux sur la compilation habituelle
    # ci-dessous (FLASH_ATTN_PREBUILT_DONE reste false).
    echo "  Blackwell detecte — tentative de roue flash-attn precompilee..."
    FLASH_WHEEL_URL="https://github.com/mjun0812/flash-attention-prebuild-wheels/releases/download/v0.9.4/flash_attn-2.8.3+cu128torch2.11-cp312-cp312-linux_x86_64.whl"
    if uv pip install "$FLASH_WHEEL_URL"; then
        echo "  OK — flash-attn installe via roue precompilee (pas de compilation)."
        FLASH_ATTN_PREBUILT_DONE=true
    else
        echo "  ATTENTION : roue precompilee indisponible ou incompatible — repli sur la compilation."
    fi
fi

if [ "$FLASH_ATTN_OK" = true ] && [ "$CUDA_VERSION" = "cu130" ]; then
    # Pile CUDA 13.0 : roue precompilee torch 2.14 / cu130 / cp312 (release v0.10.0 du meme
    # projet que la roue cu128 ci-dessus). Meme repli : si elle est indisponible ou echoue,
    # compilation depuis les sources ci-dessous.
    echo "  Pile CUDA 13.0 — tentative de roue flash-attn precompilee (torch 2.14)..."
    FLASH_WHEEL_URL="https://github.com/mjun0812/flash-attention-prebuild-wheels/releases/download/v0.10.0/flash_attn-2.8.3+cu130torch2.14-cp312-cp312-linux_x86_64.whl"
    if uv pip install "$FLASH_WHEEL_URL"; then
        echo "  OK — flash-attn installe via roue precompilee (pas de compilation)."
        FLASH_ATTN_PREBUILT_DONE=true
    else
        echo "  ATTENTION : roue precompilee indisponible ou incompatible — repli sur la compilation."
    fi
fi

# Roue precompilee : verification FONCTIONNELLE sur le GPU reel. Une roue qui ne contient pas
# l'architecture de la carte s'importe sans erreur puis echoue au premier vrai appel
# (« no kernel image is available for execution on the device »). cuobjdump n'est pas toujours
# installe ; un appel reel, si. Echec : flash-attn est retire, SDPA prend le relais.
if [ "$FLASH_ATTN_PREBUILT_DONE" = true ]; then
    if .venv/bin/python - <<'PYTEST' > /dev/null 2>&1
import torch
from flash_attn import flash_attn_func
q = torch.randn(1, 128, 8, 64, device="cuda", dtype=torch.bfloat16)
flash_attn_func(q, q, q)
torch.cuda.synchronize()
PYTEST
    then
        echo "  OK — flash-attn s'execute sur ce GPU (test fonctionnel)."
    else
        echo "  ATTENTION : la roue precompilee ne s'execute pas sur ce GPU (architecture absente ?)."
        echo "  flash-attn est retire ; SDPA prendra le relais (fonctionnel, juste sans cette acceleration)."
        uv pip uninstall flash-attn || true
        FLASH_ATTN_PREBUILT_DONE=false
        FLASH_ATTN_OK=false
    fi
fi

if [ "$FLASH_ATTN_OK" = true ] && [ "$FLASH_ATTN_PREBUILT_DONE" = false ]; then
    # Verification du compilateur systeme AVANT toute tentative — vecu en
    # pratique (RTX 5060, 3 tentatives) : un nvcc trop ancien "reussit"
    # silencieusement en ignorant l'architecture demandee des qu'aucune
    # cible n'est fixee explicitement, produisant un binaire qui s'importe
    # sans erreur mais echoue a l'usage reel avec "no kernel image is
    # available for execution on the device". Avec une cible explicite
    # (voir FLASH_ATTN_CUDA_ARCHS plus bas), il echoue franchement avec
    # "nvcc fatal : Unsupported gpu architecture" — plus clair, mais deux
    # heures de compilation perdues avant de le decouvrir si on ne
    # verifie pas en amont. Verification volontairement restreinte au cas
    # Blackwell/sm_120 (>= CUDA 12.8) — seul cas reellement observe et
    # confirme, pas une matrice de compatibilite generale devinee.
    NVCC_VERSION=""
    command -v nvcc &> /dev/null && NVCC_VERSION=$(nvcc --version 2>/dev/null | grep -oP 'release \K[0-9]+\.[0-9]+')
    if [ -z "$NVCC_VERSION" ]; then
        echo "  ATTENTION : nvcc introuvable — flash-attn ignore, SDPA prendra le relais."
        FLASH_ATTN_OK=false
    elif [ "$FLASH_ATTN_ARCH" -ge 120 ] && ! awk "BEGIN {exit !($NVCC_VERSION >= 12.8)}" 2>/dev/null; then
        echo "  ATTENTION : nvcc $NVCC_VERSION trop ancien pour sm_$FLASH_ATTN_ARCH (Blackwell exige >= 12.8)."
        echo "  flash-attn ignore, SDPA prendra le relais (fonctionnel, juste sans cette acceleration)."
        echo "  Pour installer un compilateur a jour (boite a outils SEULE, sans toucher au pilote) :"
        echo "    wget https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2404/x86_64/cuda-keyring_1.1-1_all.deb"
        echo "    sudo dpkg -i cuda-keyring_1.1-1_all.deb && sudo apt update"
        echo "    sudo apt install -y cuda-toolkit-12-8"
        echo "    export PATH=\"/usr/local/cuda-12.8/bin:\$PATH\"  # puis relance install.sh"
        FLASH_ATTN_OK=false
    else
        echo "  nvcc $NVCC_VERSION detecte — compatible avec sm_$FLASH_ATTN_ARCH."
    fi
fi

if [ "$FLASH_ATTN_OK" = true ] && [ "$FLASH_ATTN_PREBUILT_DONE" = false ]; then
    echo "  Installation de flash-attn (peut prendre plusieurs minutes)..."
    # psutil : dependance de BUILD de flash-attn (utilisee par son propre
    # setup.py, probablement pour dimensionner la parallelisation de la
    # compilation), jamais declaree comme telle par le paquet lui-meme.
    # Absente sur une installation vraiment neuve — confirme en pratique
    # via un clonage complet independant, ou aucune autre dependance ne
    # l'avait encore installee de facon transitoire comme sur les machines
    # deja utilisees tout au long du developpement. Sans elle :
    # "ModuleNotFoundError: No module named 'psutil'" en plein milieu de la
    # compilation, avec le message d'aide de uv lui-meme suggerant cette
    # meme installation prealable.
    uv pip install psutil
    # Purge du cache AVANT toute chose : un cache issu d'une compilation
    # anterieure (avant le correctif ci-dessous) contient un binaire cible
    # sur le mauvais jeu d'architectures — uv le reutiliserait sinon
    # silencieusement, sans jamais reconstruire.
    uv cache clean flash-attn 2>/dev/null || true
    # FLASH_ATTN_CUDA_ARCHS (PAS TORCH_CUDA_ARCH_LIST, qui n'est jamais lue
    # par ce paquet — confirme dans son propre setup.py) est OBLIGATOIRE
    # ici : sans elle, la compilation depuis les sources cible le defaut
    # propre a cette version de flash-attn, qui peut ne pas inclure
    # l'architecture reellement presente (observe sur Blackwell/RTX 50xx,
    # sm_120 absent du binaire compile malgre une compilation "reussie" —
    # verifie objectivement via cuobjdump --list-elf). Resultat sans ce
    # correctif : "CUDA error: no kernel image is available for execution
    # on the device" au premier VRAI appel, jamais a l'import. Format
    # entier attendu ("120"), pas la notation decimale de nvidia-smi
    # ("12.0") — voir FLASH_ATTN_ARCH plus haut.
    FLASH_ATTN_CUDA_ARCHS="$FLASH_ATTN_ARCH" uv pip install flash-attn==2.8.3.post1 --no-build-isolation
fi

if [ "$FLASH_ATTN_OK" = true ]; then
    # Verification OBJECTIVE — importer le module reussit meme quand le
    # binaire cible la mauvaise architecture (observe en pratique : import
    # sans erreur, mais "CUDA error: no kernel image is available for
    # execution on the device" au premier vrai appel, en cours de
    # generation). On inspecte directement le binaire installe plutot que
    # de faire confiance au simple succes de la commande d'installation —
    # s'applique aussi bien a la roue precompilee qu'a la compilation.
    FLASH_ATTN_SO=$(find .venv/lib -iname "flash_attn_2_cuda*.so" 2>/dev/null | head -1)
    if [ -n "$FLASH_ATTN_SO" ] && command -v cuobjdump &> /dev/null; then
        if cuobjdump --list-elf "$FLASH_ATTN_SO" 2>/dev/null | grep -q "sm_${FLASH_ATTN_ARCH}"; then
            echo "  OK — flash-attn configure pour sm_${FLASH_ATTN_ARCH} (confirme via cuobjdump)."
        else
            echo "  ATTENTION : sm_${FLASH_ATTN_ARCH} absent du binaire flash-attn."
            echo "  L'import fonctionnera, mais la generation echouera avec :"
            echo "  \"CUDA error: no kernel image is available for execution on the device\"."
            echo "  Voir TROUBLESHOOTING.md."
        fi
    fi
fi

# torch, torchaudio et torchcodec sont déjà installés plus haut depuis l'index
# PyTorch : ils sont volontairement absents de cette liste. diffusers est
# EGALEMENT absent d'ici — installe separement juste en dessous avec
# --no-deps (voir ce commentaire pour le pourquoi).
uv pip install "transformers>=4.51.0,<4.58.0" "huggingface-hub<1.0" gradio==6.2.0 matplotlib \
    scipy soundfile loguru einops accelerate fastapi diskcache "uvicorn[standard]" \
    numba vector-quantize-pytorch "torchao>=0.17.0,<0.18.0" toml peft modelscope \
    tensorboard typer-slim hf_transfer hf_xet lightning lycoris-lora safetensors \
    xxhash "pytorch-wavelets>=1.3.0" "pywavelets>=1.9.0" "bitsandbytes>=0.50.0"

# diffusers==0.40.0 installe avec --no-deps, DELIBEREMENT : ses propres
# metadonnees exigent huggingface-hub>=1.23.0,<2.0 (confirme directement
# par le refus explicite d'uv, "No solution found when resolving
# dependencies", des que diffusers est inclus dans une resolution
# combinee avec huggingface-hub<1.0 ci-dessus — impossible a satisfaire
# simultanement selon les regles strictes du resolveur). En pratique
# cependant, diffusers 0.40.0 fonctionne correctement avec
# huggingface-hub 0.36.x pour l'usage d'ACE-Step-1.5 (generation
# complete reussie, XL Turbo BF16) — la partie de son code qui
# necessiterait reellement huggingface-hub>=1.23.0 n'est simplement
# jamais exercee par ce pipeline. --no-deps permet d'obtenir le code de
# diffusers 0.40.0 sans que sa propre contrainte, plus stricte que ce
# qui est reellement necessaire ici, ne bloque toute la resolution.
# Ses AUTRES dependances (Pillow, safetensors, accelerate, filelock,
# numpy, regex...) sont deja couvertes par les lignes ci-dessus et par
# torch/transformers, installes avant ce point.
# Meme principe deja utilise dans ce script pour nano-vllm et ace-step
# lui-meme (voir plus haut / plus bas) — compromis de dependances
# assume : a re-verifier si diffusers ou huggingface-hub evoluent.
uv pip install "diffusers==0.40.0" --no-deps

if [ -d "ACE-Step-1.5" ]; then
    uv pip install -e ACE-Step-1.5/ --no-deps
fi

echo "[7/14] Correctif pytorch_wavelets (pkg_resources)..."
# pytorch_wavelets (dependance de DCW, voir DCW.md) utilise encore
# "from pkg_resources import resource_stream" pour charger ses coefficients
# de filtres. Depuis setuptools 82 (8 fevrier 2026), pkg_resources n'est
# plus fourni par defaut, et l'import echoue silencieusement — DCW se
# desactive alors proprement (voir ACE-Step-1.5, pas de plantage), mais
# sans l'acceleration attendue. Meme piege que basic-pitch/resampy, mais
# ici dans l'environnement PRINCIPAL (torch/transformers/ACE-Step) : y
# retrograder setuptools globalement serait bien plus risque que pour un
# venv isole. Correctif chirurgical du fichier lui-meme a la place —
# remplace l'import par un equivalent importlib.resources natif a
# Python 3.9+, sans toucher a la version de setuptools. Idempotent.
if [ -f "patch-pytorch-wavelets.py" ]; then
    .venv/bin/python patch-pytorch-wavelets.py
else
    echo "  ATTENTION : patch-pytorch-wavelets.py introuvable, correctif ignore."
    echo "  DCW restera desactive (repli automatique, pas de plantage)."
fi

# sitecustomize.py — filtre un FutureWarning generique de diffusers
# (AutoencoderOobleck caste directement via .to() plutot que via
# torch_dtype= a from_pretrained()), sans consequence reelle dans notre
# cas (liste des modules a risque vide : []), mais visible a chaque
# lancement. Mecanisme standard Python (module site), charge
# automatiquement au demarrage de l'interpreteur avant meme le code
# d'ACE-Step-1.5 — evite de toucher au code amont pour autant.
if [ -f "sitecustomize.py" ]; then
    SITE_PACKAGES=$(.venv/bin/python -c "import site; print(site.getsitepackages()[0])")
    cp sitecustomize.py "$SITE_PACKAGES/sitecustomize.py"
    echo "  [OK] sitecustomize.py deploye : $SITE_PACKAGES/sitecustomize.py"
else
    echo "  ATTENTION : sitecustomize.py introuvable, avertissement diffusers non filtre."
fi


# === 7. Vérification torchcodec ==============================================
# Test précoce : mieux vaut échouer ici qu'au premier fichier audio généré.
echo "[8/14] Vérification de torchcodec..."
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
echo "[9/14] Vérification de Node.js..."
if ! command -v node &> /dev/null; then
    echo "ERREUR: Node.js n'est pas installé. Veuillez installer Node.js 22 LTS."
    exit 1
fi
echo "  Node.js $(node -v)"

# === 9. npm & build frontend =================================================
echo "[10/14] Dépendances npm (frontend et serveur)..."
(cd app && npm install)
(cd app/server && npm install)

echo "[11/14] Compilation du frontend..."
(cd app && npx vite build)

echo "[12/14] Migration base de données (séparation Playlists/Espaces de travail)..."
# La colonne 'kind' est desormais ajoutee directement dans
# app/server/src/db/migrate.ts, qui s'execute automatiquement et de facon
# fiable a CHAQUE demarrage de run.sh — plus besoin de ce script separe.
# Ancienne approche (run-migration-kind.mjs, appele ici une seule fois
# pendant l'installation) genait un vrai probleme sur une installation
# neuve : ce script s'executait AVANT que la base existe, abandonnant
# poliment sans jamais ajouter la colonne, puisque rien ne le rappelait
# ensuite — confirme en pratique par une erreur "no such column: p.kind"
# au moment de creer une playlist. La base de migrate.ts, elle, tourne a
# chaque lancement, jamais seulement a l'installation : plus robuste par
# construction face a ce genre de probleme de timing.
echo "  Geree automatiquement au demarrage de run.sh — rien a faire ici."

echo "[13/14] Environnement basic-pitch (conversion audio -> MIDI)..."
# Venv Python ISOLE, distinct de .venv (ACE-Step) — evite tout conflit avec
# ses versions figees de torch/torchaudio/numpy. basic-pitch exige
# tensorflow<2.15.1 (meme avec l'extra [onnx]), sans roue compatible Python
# 3.12 : necessite specifiquement Python 3.11, via le PPA deadsnakes.
#
# Idempotent : sans-op si python3.11 et le venv sont deja en place.
if ! command -v python3.11 &> /dev/null; then
    echo "  Python 3.11 introuvable — ajout du PPA deadsnakes..."
    sudo add-apt-repository -y ppa:deadsnakes/ppa
    # "|| true" delibere : contrairement a l'etape 1 (ou apt update est
    # chaine avec && install, ce qui evite le declenchement de set -e sur
    # son propre echec), celui-ci etait isole sur sa propre ligne — si
    # UN SEUL depot tiers du systeme echoue (observe en pratique : un
    # depot Spotify non signe, sans aucun rapport avec ce projet), apt
    # update renvoie un code d'erreur global meme quand deadsnakes
    # lui-meme s'est correctement mis a jour, et set -e arretait alors le
    # script entier, silencieusement, sans le moindre message d'erreur —
    # exactement le symptome observe (arret net juste apres cette ligne).
    sudo apt update || true
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


echo "[14/14] Environnement Demucs (séparation de stems)..."
# Venv Python ISOLE pour Demucs, distinct de .venv (ACE-Step) ET de celui de
# basic-pitch — meme raison : eviter tout conflit avec les versions figees de
# torch/numpy qu'ACE-Step exige. Python 3.11 est deja garanti par l'etape 13.
#
# Delegue a app/server/setup-demucs-venv.sh (utilisable seul aussi) plutot que
# de dupliquer sa logique ici : une seule source de verite pour cette install.
#
# Idempotent : sans-op si l'environnement existant fonctionne deja. Comme pour
# basic-pitch, un echec n'arrete pas l'installation — le reste de
# l'application reste utilisable sans la separation de stems.
DEMUCS_VENV="app/server/demucs-venv"
if [ -x "$DEMUCS_VENV/bin/python3" ] && "$DEMUCS_VENV/bin/python3" -c "import demucs.api" 2>/dev/null; then
    echo "  OK — environnement Demucs déjà en place."
else
    # Absent ou casse : on repart de zero. Sans ca, le script de setup poserait
    # une question interactive ("le supprimer et recommencer ?") qui
    # bloquerait l'installateur.
    rm -rf "$DEMUCS_VENV"
    if bash app/server/setup-demucs-venv.sh; then
        echo "  OK — Demucs installé."
    else
        echo "  ATTENTION : l'installation de Demucs ne s'est pas terminée correctement."
        echo "  Vérifie ta connexion, puis relance : cd app/server && ./setup-demucs-venv.sh"
    fi
fi

echo "$CUDA_VERSION" > cuda_version.txt

# === Profil materiel : modeles par defaut selon la VRAM ======================
# Lu par run.sh. Fichier propre a la machine (ignore par git) : relancer install.sh pour le
# refaire. Sans GPU (option CPU), ACE-Step applique lui-meme les limites du palier 1.
# Palier : la mesure du MOTEUR. ACE-Step lit torch.cuda.get_device_properties(0).total_memory, plus
# petit que le memory.total de nvidia-smi (7,609 Gio contre 7,960 sur une RTX 5060, soit 4,4 %).
# PyTorch est installe a ce stade : on l'interroge ; nvidia-smi sert de repli. La CLASSE nominale
# (qui choisit le modele par defaut) reste calculee d'apres nvidia-smi : un ecart de 4 % ne doit pas
# faire passer une carte de 8 Go sous le seuil de 8 Go du Studio.
HW_PROFILE_TORCH_MIB=""
if [ "$CUDA_VERSION" = "cpu" ]; then
    HW_PROFILE_VRAM_MIB=0
else
    HW_PROFILE_VRAM_MIB="${HW_VRAM_MIB:-0}"
    HW_PROFILE_TORCH_MIB=$(.venv/bin/python -c "import torch; print(int(torch.cuda.get_device_properties(0).total_memory // (1024 * 1024)))" 2>/dev/null || true)
fi
if [ -n "$HW_PROFILE_TORCH_MIB" ] && [ "$HW_PROFILE_TORCH_MIB" -gt 0 ] 2>/dev/null; then
    HW_PROFILE_TIER=$(hw_ace_tier "$HW_PROFILE_TORCH_MIB")
else
    HW_PROFILE_TORCH_MIB=""
    HW_PROFILE_TIER=$(hw_ace_tier "$HW_PROFILE_VRAM_MIB")
fi
HW_PROFILE_CLASS=$(hw_vram_class "$HW_PROFILE_VRAM_MIB")
cat > hardware_profile.env <<EOF
# Profil matériel — généré par install.sh le $(date +%Y-%m-%d). Ne pas éditer : relancer install.sh.
# Pour imposer un autre modèle : définir DEFAULT_MODEL dans l'environnement ou dans ACE-Step-1.5/.env.
HW_GPU_NAME="${HW_GPU_NAME:-aucun GPU NVIDIA}"
HW_VRAM_MIB="$HW_PROFILE_VRAM_MIB"
HW_VRAM_TORCH_MIB="$HW_PROFILE_TORCH_MIB"
HW_VRAM_CLASS_GB="$HW_PROFILE_CLASS"
HW_COMPUTE_CAP="${HW_COMPUTE_CAP:-}"
HW_DRIVER_CUDA="${DRIVER_CUDA:-}"
HW_ACE_TIER="$HW_PROFILE_TIER"
HW_DEFAULT_MODEL="$(hw_default_model "$HW_PROFILE_CLASS")"
HW_INIT_LLM="$(hw_init_llm "$HW_PROFILE_TIER")"
# Informatif : taille de LM recommandée par ACE-Step pour ce palier. LM_MODEL n'est pas piloté ici.
HW_ACE_RECOMMENDED_LM="$(hw_recommended_lm "$HW_PROFILE_TIER")"
EOF
echo "Profil matériel : palier ACE-Step $HW_PROFILE_TIER — modèle par défaut : $(hw_default_model "$HW_PROFILE_CLASS")"

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
