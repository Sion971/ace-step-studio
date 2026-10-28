#!/usr/bin/env bash
# =============================================================================
#  ACE-Step Studio — raccourci de lancement (Linux)
#
#  Cree le lanceur « ACE-Step Studio » dans le menu des applications et sur le
#  bureau, avec l'icone app/docs/Ace-Step UI.ico. Il demarre launch-ace-step.sh
#  (le Studio se ferme avec sa page : --quit-on-close), sans fenetre de terminal.
#  Une seconde entree du menu, « ACE-Step Studio (avec terminal) », fait la meme
#  chose dans une fenetre de terminal qui montre les journaux du serveur, comme
#  le raccourci Windows.
#
#  Usage :  ./create-shortcut.sh [options]
#
#    --no-desktop   Ne cree pas le raccourci sur le bureau (menu seulement).
#    --no-menu      Ne cree pas l'entree du menu (bureau seulement).
#    --remove       Supprime le lanceur, l'icone et les raccourcis crees ici.
#    --help         Affiche cette aide.
#
#  Appele par install.sh en fin d'installation ; on peut le relancer a tout
#  moment (il remplace ses propres fichiers, sans rien dupliquer). Si le depot
#  est deplace, le relancer pour mettre les chemins a jour.
# =============================================================================
set -e

WANT_DESKTOP=true
WANT_MENU=true
REMOVE=false
while [[ $# -gt 0 ]]; do
    case "$1" in
        --no-desktop) WANT_DESKTOP=false; shift ;;
        --no-menu)    WANT_MENU=false; shift ;;
        --remove)     REMOVE=true; shift ;;
        --help|-h)    sed -n '2,21p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'; exit 0 ;;
        *) echo "Option inconnue : $1 (voir --help)"; exit 1 ;;
    esac
done

STUDIO_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
ICO="$STUDIO_DIR/app/docs/Ace-Step UI.ico"
LAUNCHER="$STUDIO_DIR/launch-ace-step.sh"

DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
APPS_DIR="$DATA_HOME/applications"
ICON_DIR="$DATA_HOME/icons/hicolor/256x256/apps"
ICON_PNG="$ICON_DIR/ace-step-studio.png"
DESKTOP_FILE_NAME="ace-step-studio.desktop"
TERMINAL_FILE_NAME="ace-step-studio-terminal.desktop"

# Dossier du bureau : suit la langue de la session (Desktop, Bureau...).
DESKTOP_DIR=""
if command -v xdg-user-dir >/dev/null 2>&1; then
    DESKTOP_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || true)"
fi
[ -n "$DESKTOP_DIR" ] && [ "$DESKTOP_DIR" != "$HOME" ] || DESKTOP_DIR=""
if [ -z "$DESKTOP_DIR" ]; then
    for d in "$HOME/Desktop" "$HOME/Bureau"; do
        [ -d "$d" ] && { DESKTOP_DIR="$d"; break; }
    done
fi

refresh_caches() {
    command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true
    command -v gtk-update-icon-cache >/dev/null 2>&1 && \
        gtk-update-icon-cache -q -t "$DATA_HOME/icons/hicolor" >/dev/null 2>&1 || true
}

if $REMOVE; then
    rm -f "$APPS_DIR/$DESKTOP_FILE_NAME" "$APPS_DIR/$TERMINAL_FILE_NAME" "$ICON_PNG"
    [ -n "$DESKTOP_DIR" ] && rm -f "$DESKTOP_DIR/$DESKTOP_FILE_NAME"
    refresh_caches
    echo "Raccourci ACE-Step Studio supprime (menu, bureau, icone)."
    exit 0
fi

if [ ! -f "$LAUNCHER" ]; then
    echo "ERREUR : $LAUNCHER est introuvable."
    exit 1
fi
chmod +x "$LAUNCHER" "$STUDIO_DIR/run.sh" 2>/dev/null || true

# --- Icone : les bureaux Linux lisent mal un .ico, on en tire un PNG ---------
ICON_VALUE=""
if [ -f "$ICO" ]; then
    mkdir -p "$ICON_DIR"
    PY="$STUDIO_DIR/.venv/bin/python"
    [ -x "$PY" ] || PY="$(command -v python3 || true)"
    if [ -n "$PY" ] && "$PY" - "$ICO" "$ICON_PNG" >/dev/null 2>&1 <<'PYEOF'
import sys
from PIL import Image
im = Image.open(sys.argv[1])
try:  # un .ico peut contenir plusieurs tailles : on prend la plus grande
    best = max(im.ico.sizes())
    im.size = best
except Exception:
    pass
im.convert("RGBA").resize((256, 256), Image.LANCZOS).save(sys.argv[2], "PNG")
PYEOF
    then
        ICON_VALUE="$ICON_PNG"
    elif command -v convert >/dev/null 2>&1 && convert "${ICO}[0]" -resize 256x256 "$ICON_PNG" >/dev/null 2>&1; then
        ICON_VALUE="$ICON_PNG"
    else
        ICON_VALUE="$ICO"
        echo "Note : conversion de l'icone impossible, le .ico est utilise tel quel."
    fi
else
    echo "Note : $ICO est introuvable, le raccourci n'aura pas d'icone personnalisee."
fi

# --- Fichier .desktop --------------------------------------------------------
# Les chemins avec espaces se citent dans Exec= (specification freedesktop) ; les caracteres " ` $ \ y exigent un
# echappement double, trop fragile : on prefere le dire.
case "$LAUNCHER$STUDIO_DIR" in
    *\"*|*\`*|*\$*|*\\*)
        echo "ERREUR : le chemin du Studio contient un des caracteres \" \` \$ \\ ; deplacez le dossier."
        exit 1 ;;
esac
q() { printf '"%s"' "$1"; }
# build_entry [nom] [Terminal=true|false] : le raccourci normal n'ouvre que la page web ; la variante « avec terminal » ouvre
# une fenetre de terminal qui affiche les journaux (elle se ferme avec la page, comme sans terminal).
build_entry() {
    local name="${1:-ACE-Step Studio}" terminal="${2:-false}"
    cat <<DESKTOP
[Desktop Entry]
Type=Application
Version=1.0
Name=$name
Comment=Generation musicale par IA, en local
Exec=$(q "$LAUNCHER")
Path=$STUDIO_DIR
${ICON_VALUE:+Icon=$ICON_VALUE}
Terminal=$terminal
Categories=AudioVideo;Audio;
StartupNotify=false
DESKTOP
}

if $WANT_MENU; then
    mkdir -p "$APPS_DIR"
    build_entry > "$APPS_DIR/$DESKTOP_FILE_NAME"
    chmod +x "$APPS_DIR/$DESKTOP_FILE_NAME"
    echo "Menu des applications : $APPS_DIR/$DESKTOP_FILE_NAME"
    build_entry "ACE-Step Studio (avec terminal)" true > "$APPS_DIR/$TERMINAL_FILE_NAME"
    chmod +x "$APPS_DIR/$TERMINAL_FILE_NAME"
    echo "Avec terminal         : $APPS_DIR/$TERMINAL_FILE_NAME"
fi

if $WANT_DESKTOP; then
    if [ -n "$DESKTOP_DIR" ] && [ -d "$DESKTOP_DIR" ]; then
        build_entry > "$DESKTOP_DIR/$DESKTOP_FILE_NAME"
        chmod +x "$DESKTOP_DIR/$DESKTOP_FILE_NAME"
        # GNOME demande sinon « Autoriser le lancement » au premier double-clic.
        command -v gio >/dev/null 2>&1 && gio set "$DESKTOP_DIR/$DESKTOP_FILE_NAME" metadata::trusted true >/dev/null 2>&1 || true
        echo "Bureau                : $DESKTOP_DIR/$DESKTOP_FILE_NAME"
    else
        echo "Note : dossier du bureau introuvable, raccourci du bureau non cree."
    fi
fi

refresh_caches
echo "Raccourci ACE-Step Studio pret."
