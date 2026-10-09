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

IMPORTANT — le fichier est localise SANS importer pytorch_wavelets. Avant,
le script faisait « import pytorch_wavelets » pour trouver le fichier : or
c'est precisement cet import qui echoue quand pkg_resources manque
(setuptools 82 ou plus), si bien que le correctif ne pouvait jamais
s'appliquer dans le cas qu'il est cense traiter — constate sous Windows
(setuptools 84.0.0) : « pytorch_wavelets est installe mais son import
echoue a cause d'une dependance manquante : pkg_resources ». Reproduit
avec pytorch-wavelets 1.3.0 et setuptools 84.0.0. L'import n'est fait
qu'APRES le correctif, pour le verifier.

Usage :
    <venv>/bin/python patch-pytorch-wavelets.py       (Linux)
    <venv>\\Scripts\\python.exe patch-pytorch-wavelets.py  (Windows)
"""

import importlib
import importlib.util
import sys
from pathlib import Path

# find_spec sur un paquet de premier niveau n'execute AUCUN code du paquet :
# il ne fait que chercher ou il se trouve. C'est ce qui permet de le corriger
# alors que son import echoue.
spec = importlib.util.find_spec("pytorch_wavelets")
if spec is None or not spec.submodule_search_locations:
    print("  pytorch_wavelets n'est pas installe — rien a corriger.")
    sys.exit(0)

coeffs_path = Path(list(spec.submodule_search_locations)[0]) / "dtcwt" / "coeffs.py"

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


def verify():
    """Importe pytorch_wavelets (premier import de ce processus) et son module de coefficients."""
    try:
        importlib.import_module("pytorch_wavelets")
        importlib.import_module("pytorch_wavelets.dtcwt.coeffs")
    except ModuleNotFoundError as e:
        print("  ATTENTION : pytorch_wavelets est installe mais son import echoue")
        print(f"  a cause d'une dependance manquante : {e.name}")
        print(f"  Trace complete : {e}")
        return False
    except Exception as e:
        print("  ATTENTION : pytorch_wavelets est installe mais son import echoue")
        print("  pour une raison inattendue (pas juste une absence) :")
        print(f"  {type(e).__name__}: {e}")
        return False
    return True


if OLD_IMPORT not in content:
    # Soit deja corrige par ce script (NEW_CODE), soit corrige autrement par une
    # session anterieure (autre nom de variable). Ce qui compte : l'import marche.
    if verify():
        print("  [OK] pytorch_wavelets deja corrige.")
        sys.exit(0)
    sys.exit(1)

coeffs_path.write_text(content.replace(OLD_IMPORT, NEW_CODE), encoding="utf-8")
print(f"  [OK] pytorch_wavelets corrige : {coeffs_path}")

# Verification immediate : le module appelle resource_stream a son propre
# chargement pour precharger ses coefficients, donc un import reussi prouve que
# le correctif fonctionne, pas seulement que le texte du fichier a change.
if verify():
    print("  [OK] Verification reussie — le module s'importe sans erreur.")
    sys.exit(0)
sys.exit(1)
