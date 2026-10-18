#!/usr/bin/env bash
# launch-ace-step.sh
#
# Intermediaire entre le raccourci bureau (.desktop) et run.sh — evite
# toute logique complexe dans le champ Exec= du fichier .desktop, dont les
# regles d'analyse sont distinctes de celles d'un vrai shell.
#
# Deux corrections par rapport a un appel direct de run.sh depuis le
# .desktop :
#
# 1. "bash -i" (shell interactif) charge .bashrc — un lancement via
#    .desktop tourne dans un environnement plus minimal qu'un terminal
#    ouvert normalement, et ne le charge pas par defaut. Volontairement
#    "-i" et non "-l" (shell de connexion) : ce dernier lit
#    .bash_profile/.profile, PAS forcement .bashrc, ou vit generalement
#    la configuration nvm/PATH personnalise — confirme en pratique par un
#    Node.js 18 systeme charge a la place du Node 22 attendu, cassant le
#    chargement de better-sqlite3 (compile pour une version differente).
#    "-i" reproduit exactement ce qu'un terminal ouvert normalement ferait.
#
# 2. La pause finale : la plupart des emulateurs de terminal ferment la
#    fenetre des que la commande se termine, succes ou echec — sans elle,
#    un message d'erreur eventuel s'affiche et disparait trop vite pour
#    etre lu.

# Le dossier du Studio est celui de CE script (le raccourci peut pointer vers un lien symbolique : readlink -f le suit), pas un
# chemin ecrit en dur : le depot marche ou qu'il soit clone, pour n'importe quel utilisateur.
STUDIO_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
export STUDIO_DIR

# --quit-on-close : fermer la page web arrete le serveur et le moteur (sans cela, depuis un raccourci sans terminal, rien ne
# permettait de les arreter). La pause finale ne sert que s'il y a eu une erreur : un arret normal ferme la fenetre.
exec bash -i -c '
"$STUDIO_DIR/run.sh" --quit-on-close
status=$?
if [ "$status" -ne 0 ]; then
    echo ""
    read -p "Appuyez sur Entree pour fermer..."
fi
exit "$status"
'
