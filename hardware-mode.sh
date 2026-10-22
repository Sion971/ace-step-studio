#!/usr/bin/env bash
# =============================================================================
#  Choix « normal » ou « flux » pour une carte NVIDIA de 4 a 8 Go (Linux).
#
#  Source par install.sh et run.sh. Les cartes de 3 Go ou moins passent toutes seules en mode flux et les cartes de plus de 8 Go
#  restent en mode normal : seul l'entre-deux (plus de 3 Go, 8 Go au plus, Turing ou plus recente pour le calcul bf16) a le choix.
#
#  Le choix est ecrit dans hardware_profile.env (cle HW_MODE_PREF) avec les reglages du mode flux pour une telle carte, que run.sh
#  transmet au moteur (ACESTEP_STREAM_COMPUTE, ACESTEP_STREAM_RESIDENT, ACESTEP_STREAM_RESERVE_GB, ACESTEP_LM_CUDA_GRAPH). Une
#  valeur deja definie dans l'environnement ou dans ACE-Step-1.5/.env l'emporte toujours.
# =============================================================================

HW_MODE_KEYS='HW_MODE|HW_MODE_PREF|HW_STREAM_COMPUTE|HW_STREAM_RESIDENT|HW_STREAM_RESERVE_GB|HW_LM_CUDA_GRAPH'

# 0 si la carte decrite par les variables HW_* (profil deja lu) a le choix, 1 sinon.
hw_mode_choice_possible() {
    [ "${HW_MODE:-}" = "cpu" ] && return 1
    local ref="${HW_VRAM_TORCH_MIB:-}"
    [ -n "$ref" ] || ref="${HW_VRAM_MIB:-0}"
    [ "$ref" -gt 3072 ] 2>/dev/null || return 1
    [ "${HW_VRAM_CLASS_GB:-99}" -le 8 ] 2>/dev/null || return 1
    awk "BEGIN {exit !(${HW_COMPUTE_CAP:-0} + 0 >= 7.5)}" 2>/dev/null || return 1
    return 0
}

# hw_write_mode_pref normal|stream [fichier] : reecrit HW_MODE et les reglages associes dans le profil.
hw_write_mode_pref() {
    local pref="$1" file="${2:-${SCRIPT_DIR:-.}/hardware_profile.env}"
    [ -f "$file" ] || return 1
    grep -v -E "^(${HW_MODE_KEYS})=" "$file" > "$file.tmp" || true
    if [ "$pref" = "stream" ]; then
        {
            echo 'HW_MODE="stream"'
            echo 'HW_MODE_PREF="stream"'
            echo 'HW_STREAM_COMPUTE="bfloat16"'
            echo 'HW_STREAM_RESIDENT="auto"'
            echo 'HW_STREAM_RESERVE_GB="1.5"'
            echo 'HW_LM_CUDA_GRAPH="1"'
        } >> "$file.tmp"
    else
        {
            echo 'HW_MODE="gpu"'
            echo 'HW_MODE_PREF="normal"'
        } >> "$file.tmp"
    fi
    mv "$file.tmp" "$file"
}

# Le texte qui presente les deux modes.
hw_mode_choice_text() {
    cat <<'TXT'

Mode de génération pour cette carte (4 à 8 Go) :
  1. Normal
       Le modèle est compressé (int8) et chargé sur la carte à chaque génération, puis déchargé.
       Mesuré sur une RTX 5060 8 Go, modèle XL Turbo, morceau de 3 minutes : environ 3 à 7 s de calcul du DiT, plus 4 à 6 s
       de chargement / déchargement. Aucun réglage. Les morceaux longs peuvent manquer de mémoire carte pendant le LRC.
  2. Flux
       Le moteur reste sur le processeur et fait passer le modèle par la carte, bloc par bloc ; les blocs qui tiennent restent
       sur la carte. Pas de compression : calcul en bf16, comme le modèle publié. Mesuré sur la même carte, même durée : environ
       9 s pour le DiT XL. Demande environ 10 Go de RAM libre en plus (32 Go de RAM conseillés). LoRA possible. Les pochettes IA
       exigent 6 Go de carte ou plus.
  Les deux modes se changent plus tard sans réinstaller : ./run.sh --mode normal  ou  ./run.sh --mode flux
TXT
}
