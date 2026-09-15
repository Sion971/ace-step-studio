#!/usr/bin/env bash
# cleanup-app-obsolete-scripts.sh
#
# Supprime les scripts de demarrage obsoletes dans app/ — vestiges d'un
# echafaudage anterieur ("ACE-Step UI" generique, pas "ACE-Step Studio"),
# remplaces depuis par run.sh/run.bat a la racine du depot. Confirmes
# inutiles par Sion971. A lancer depuis la racine du depot.

set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d .git ]; then
  echo "Pas de depot git ici — verifie que tu es bien a la racine du projet." >&2
  exit 1
fi

TO_DELETE=(
  "app/setup.bat"
  "app/setup.sh"
  "app/start.bat"
  "app/start.sh"
  "app/start-all.bat"
  "app/start-all.sh"
  "app/stop-all.sh"
)

echo "=== Fichiers qui seront supprimes ==="
for f in "${TO_DELETE[@]}"; do
  if [ -e "$f" ]; then
    echo "  [OK] $f (existe, sera supprime)"
  else
    echo "  [absent] $f (deja absent, ignore)"
  fi
done
echo ""
read -p "Confirmer la suppression ? [o/N] " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Oo]$ ]]; then
  echo "Arret, rien touche."
  exit 0
fi

for f in "${TO_DELETE[@]}"; do
  if [ -e "$f" ]; then
    rm -f "$f"
    echo "Supprime : $f"
  fi
done

echo ""
echo "=== Termine ==="
echo "git status pour verifier, puis git add -A + commit si ces fichiers"
echo "etaient suivis par Git."
