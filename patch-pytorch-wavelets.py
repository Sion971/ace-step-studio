#!/usr/bin/env python3
"""
patch-pytorch-wavelets.py

Corrige pytorch_wavelets/dtcwt/coeffs.py, qui utilise encore
`from pkg_resources import resource_stream` pour charger ses coefficients
de filtres (qshift, biort, level1). Depuis setuptools 82 (8 fevrier 2026),
pkg_resources n'est plus fourni par defaut — meme piege que basic-pitch/
resampy, mais ici dans l'environnement PRINCIPAL (torch/transformers/
ACE-Step), ou retrograder setuptools globalement serait bien plus risque
que pour un venv isole. Correctif chirurgical du fichier lui-meme a la
place : remplace l'import par un equivalent importlib.resources natif a
Python 3.9+, sans toucher a la version de setuptools.

Idempotent — sans danger a relancer, verifie l'etat actuel avant toute
modification. Fonctionne sur Linux et Windows : appele avec le python du
venv concerne, localise le fichier depuis ce python lui-meme plutot qu'un
chemin code en dur.

Usage :
    <venv>/bin/python patch-pytorch-wavelets.py       (Linux)
    <venv>\\Scripts\\python.exe patch-pytorch-wavelets.py  (Windows)
"""

import sys

# Deux cas bien distincts, a ne pas confondre :
# 1. pytorch_wavelets vraiment absent (paquet jamais installe) — rien a
#    corriger, message informatif normal.
# 2. pytorch_wavelets installe mais son IMPORT echoue pour une AUTRE
#    raison (incompatibilite avec une version plus recente de torch,
#    dependance interne cassee, etc.) — la trace complete est essentielle
#    pour diagnostiquer, jamais a masquer derriere un message generique.
# Confirme en pratique : le paquet apparaissait bien installe avec succes
# a l'etape precedente d'install.sh (pytorch-wavelets==1.3.0 dans le
# journal), pourtant ce script rapportait "non installe" — parce que
# l'ancien except ImportError, trop large, capturait silencieusement une
# erreur venant d'une dependance INTERNE au module, pas de son absence
# reelle. Import isole du reste, pour distinguer precisement les deux cas.
try:
    import pytorch_wavelets
except ModuleNotFoundError as e:
    if e.name == 'pytorch_wavelets':
        print("  pytorch_wavelets n'est pas installe — rien a corriger.")
        sys.exit(0)
    else:
        print(f"  ATTENTION : pytorch_wavelets est installe mais son import echoue")
        print(f"  a cause d'une dependance manquante : {e.name}")
        print(f"  Trace complete : {e}")
        sys.exit(1)
except Exception as e:
    print(f"  ATTENTION : pytorch_wavelets est installe mais son import echoue")
    print(f"  pour une raison inattendue (pas juste une absence) :")
    print(f"  {type(e).__name__}: {e}")
    sys.exit(1)

from pathlib import Path

coeffs_path = Path(pytorch_wavelets.__file__).parent / "dtcwt" / "coeffs.py"

if not coeffs_path.exists():
    print(f"  ATTENTION : {coeffs_path} introuvable — structure inattendue, correctif ignore.")
    sys.exit(0)

content = coeffs_path.read_text(encoding="utf-8")

OLD_IMPORT = "from pkg_resources import resource_stream"
NEW_CODE = (
    "import importlib.resources as _importlib_resources\n\n"
    "def resource_stream(package, resource):\n"
    "    return _importlib_resources.files(package).joinpath(resource).open(\"rb\")"
)

if NEW_CODE.splitlines()[0] in content:
    print("  [OK] pytorch_wavelets deja corrige.")
    sys.exit(0)

if OLD_IMPORT not in content:
    # L'ancienne ligne problematique est absente, mais pas exactement sous
    # la forme attendue par la verification ci-dessus — confirme en
    # pratique : une session anterieure avait deja applique ce meme
    # correctif, avec un nom de variable legerement different
    # ("resources" plutot que "_importlib_resources"), invisible a la
    # verification stricte precedente. Ce qui compte reellement, c'est
    # l'absence de pkg_resources, pas le nom exact choisi pour la
    # variable de remplacement — l'import a deja ete teste plus haut et a
    # reussi, donc le fichier fonctionne deja correctement quelle que
    # soit la forme exacte du correctif en place.
    print(f"  [OK] pytorch_wavelets deja corrige (forme differente de la reference, mais l'import fonctionne).")
    sys.exit(0)

new_content = content.replace(OLD_IMPORT, NEW_CODE)
coeffs_path.write_text(new_content, encoding="utf-8")
print(f"  [OK] pytorch_wavelets corrige : {coeffs_path}")

# Verification immediate — recharger le module pour confirmer que le
# correctif fonctionne reellement (le module appelle resource_stream a son
# propre chargement pour precharger ses coefficients), pas juste que le
# texte du fichier a change.
import importlib
try:
    import pytorch_wavelets.dtcwt.coeffs as coeffs_module
    importlib.reload(coeffs_module)
    print("  [OK] Verification reussie — le module se recharge sans erreur.")
except Exception as e:
    print(f"  ATTENTION : le correctif est en place mais la verification a echoue : {e}")
