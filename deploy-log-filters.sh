#!/usr/bin/env bash
# Deploie les filtres de messages (studio_log_filters.py + studio_log_filters.pth) dans le
# site-packages de l'environnement virtuel. Un .pth est execute au demarrage de chaque
# interpreteur ; un sitecustomize.py ne l'est pas sur Debian / Ubuntu / Linux Mint, ou
# /usr/lib/python3.x/sitecustomize.py passe avant celui du .venv (voir la docstring de
# studio_log_filters.py).
#
# Usage : ./deploy-log-filters.sh [python]   (defaut : .venv/bin/python)
# Appele par install.sh, et par run.sh a chaque lancement (une modification du fichier du
# depot, ou une installation anterieure, est ainsi reprise sans reinstaller).
set -e
cd "$(dirname "${BASH_SOURCE[0]}")"
PY="${1:-.venv/bin/python}"
[ -f studio_log_filters.py ] && [ -x "$PY" ] || exit 1
SP=$("$PY" -c "import site; print(site.getsitepackages()[0])")
[ -d "$SP" ] || exit 1
cmp -s studio_log_filters.py "$SP/studio_log_filters.py" || cp -f studio_log_filters.py "$SP/studio_log_filters.py"
[ "$(cat "$SP/studio_log_filters.pth" 2>/dev/null)" = "import studio_log_filters" ] \
    || printf 'import studio_log_filters\n' > "$SP/studio_log_filters.pth"
# Les installeurs precedents deposaient ce meme code sous le nom sitecustomize.py (jamais charge sur
# Ubuntu / Mint) : on ne retire que ce fichier-la.
if grep -q "avant meme le code d'ACE-Step-1.5" "$SP/sitecustomize.py" 2>/dev/null; then
    rm -f "$SP/sitecustomize.py"
fi
