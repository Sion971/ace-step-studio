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

try:
    import pytorch_wavelets
except ImportError:
    print("  pytorch_wavelets n'est pas installe — rien a corriger.")
    sys.exit(0)

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
    print(f"  ATTENTION : ligne attendue absente de {coeffs_path} — le fichier a peut-etre change de forme, correctif ignore.")
    print(f"  Verification manuelle recommandee.")
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
