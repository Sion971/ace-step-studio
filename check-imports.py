#!/usr/bin/env python3
"""Controle d'import des modules natifs d'un environnement (utilise par install.bat sous Windows).

Usage : python check-imports.py <main|basicpitch|demucs>

Sous Windows, Smart App Control peut refuser temporairement le chargement d'un fichier natif
non signe (TROUBLESHOOTING.md, section 46). Ce script tente d'importer les modules qui en
dependent, les affiche tous (pas seulement le premier refuse) et sort avec le code 1 si l'un
d'eux echoue, pour que l'installateur reessaie plus tard. Messages en ASCII.
"""
import importlib
import sys

# (module, optionnel). Un module optionnel absent (ModuleNotFoundError) est ignore.
MODULES = {
    "main": [
        ("torch", False), ("torchaudio", False), ("regex", False), ("numba", False),
        ("soundfile", False), ("safetensors", False), ("tokenizers", False),
        ("transformers", False), ("peft", False), ("lightning", False),
        ("scipy", False), ("diffusers", False), ("gradio", False), ("flash_attn", True),
    ],
    "basicpitch": [
        ("numpy", False), ("scipy", False), ("numba", False), ("resampy", False),
        ("onnxruntime", False), ("basic_pitch.inference", False),
    ],
    "demucs": [
        ("torch", False), ("numpy", False), ("sphn", False), ("lameenc", False),
        ("demucs.api", False),
    ],
    # Auto-test (Linux) : ne depend d'aucun paquet tiers.
    "selftest": [("json", False), ("os", False), ("not_installed_optional", True)],
}


def main(argv):
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    if len(argv) != 2 or argv[1] not in MODULES:
        print("Usage : check-imports.py <main|basicpitch|demucs>")
        return 2
    name = argv[1]
    bad = []
    for module, optional in MODULES[name]:
        try:
            importlib.import_module(module)
        except ModuleNotFoundError as e:
            if optional and e.name == module:
                continue
            bad.append((module, e))
        except BaseException as e:  # ImportError, OSError ("DLL load failed"), etc.
            bad.append((module, e))
    if not bad:
        print(f"  [{name}] tous les modules se chargent.")
        return 0
    for module, err in bad:
        # Message de l'exception ET de sa cause (ex. numba : "failed to import" cache le vrai message
        # "DLL load failed ... stratégie de contrôle d'application").
        parts, e = [], err
        while e is not None and len(parts) < 4:
            lines = str(e).strip().splitlines()
            parts.append(lines[-1] if lines else type(e).__name__)
            e = e.__cause__ or e.__context__
        text = " | ".join(parts)
        low = text.lower()
        sac = "4551" in low or ("application" in low and ("contr" in low or "control" in low))
        tag = "Smart App Control" if sac else "autre erreur"
        print(f"  [{name}] REFUSE ({tag}) : {module} - {type(err).__name__}: {text[:260]}")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
