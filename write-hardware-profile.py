#!/usr/bin/env python3
"""Ecrit hardware_profile.env : modele par defaut selon la VRAM (equivalent Windows du bloc de install.sh).

Lu par run.bat (variables HW_*) et par le serveur (download-tracker). Fichier propre a la machine,
ignore par git. Sans argument. Detecte tout seul : nvidia-smi (GPU 0), cuda_version.txt (ecrit par
install.bat : "cpu" = mode processeur), PyTorch (VRAM telle que la voit le moteur).

Memes regles que install.sh :
  - palier ACE-Step : seuils exacts de acestep/gpu_config.py::get_gpu_tier ;
  - modele : XL Turbo BF16 si la VRAM NOMINALE (arrondie, d'apres nvidia-smi) est >= 8 Go,
    sinon le DiT 2B turbo ; aucun modele de langage aux paliers 1 et 2 ;
  - mode processeur : delai de generation porte a 3600 s.
"""
import os
import re
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
# Sous Windows le Studio utilise le depot complet ; le prefixe fait partie du nom (voir run.bat).
XL_MODEL = "marcorez8/acestep-v15-xl-turbo-bf16"
SMALL_MODEL = "acestep-v15-turbo"


def smi(fields):
    exe = shutil.which("nvidia-smi")
    if not exe:
        return None
    try:
        out = subprocess.run(
            [exe, "--query-gpu=" + fields, "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=20,
        )
    except Exception:
        return None
    if out.returncode != 0:
        return None
    lines = [l for l in out.stdout.splitlines() if l.strip()]
    if not lines:
        return None
    return [p.strip() for p in lines[0].split(",")]


def ace_tier(mib):
    g = mib / 1024.0
    if g <= 4: return "1"
    if g <= 6: return "2"
    if g <= 8: return "3"
    if g <= 12: return "4"
    if g < 15.5: return "5"
    if g < 20: return "6a"
    if g <= 24: return "6b"
    return "unlimited"


def vram_class(mib):
    return int(mib / 1024.0 + 0.5)


def recommended_lm(tier):
    return {"1": "aucun", "2": "aucun", "3": "0.6B", "4": "0.6B",
            "5": "1.7B", "6a": "1.7B", "6b": "1.7B"}.get(tier, "4B")


def read_cuda_version():
    try:
        with open(os.path.join(ROOT, "cuda_version.txt"), encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return ""


def torch_vram_mib():
    try:
        import torch
        if torch.cuda.is_available():
            return int(torch.cuda.get_device_properties(0).total_memory // (1024 * 1024))
    except Exception:
        pass
    return None


def main():
    cuda = read_cuda_version()
    info = smi("name,memory.total,compute_cap")
    name = ""
    smi_mib = 0
    cc = ""
    if info and len(info) >= 2:
        # Le profil est lu par run.bat : jeu de caracteres restreint, aucune metacaractere cmd.
        name = re.sub(r"[^A-Za-z0-9 ._+-]", "", info[0]).strip()
        try:
            smi_mib = int(float(info[1]))
        except ValueError:
            smi_mib = 0
        cc = info[2] if len(info) > 2 else ""

    if cuda:
        cpu_mode = cuda == "cpu"
    else:
        cpu_mode = torch_vram_mib() is None

    torch_mib = None
    if cpu_mode:
        vram_mib = 0
    else:
        vram_mib = smi_mib
        torch_mib = torch_vram_mib()
        if vram_mib == 0 and torch_mib:
            vram_mib = torch_mib
    tier = ace_tier(torch_mib if torch_mib else vram_mib)
    cls = vram_class(vram_mib)
    model = XL_MODEL if cls >= 8 else SMALL_MODEL
    init_llm = "false" if tier in ("1", "2") else "true"

    lines = [
        "# Profil materiel - genere par install.bat ou run.bat. Ne pas editer : relancer install.bat.",
        "# Pour imposer un autre modele : definir DEFAULT_MODEL dans l'environnement ou dans ACE-Step-1.5\\.env.",
        "HW_GPU_NAME=" + (name or "aucun GPU NVIDIA"),
        "HW_MODE=" + ("cpu" if cpu_mode else "gpu"),
        "HW_GENERATION_TIMEOUT=" + ("3600" if cpu_mode else ""),
        "HW_VRAM_MIB=" + str(vram_mib),
        "HW_VRAM_TORCH_MIB=" + (str(torch_mib) if torch_mib else ""),
        "HW_VRAM_CLASS_GB=" + str(cls),
        "HW_COMPUTE_CAP=" + cc,
        "HW_ACE_TIER=" + tier,
        "HW_DEFAULT_MODEL=" + model,
        "HW_INIT_LLM=" + init_llm,
        "HW_ACE_RECOMMENDED_LM=" + recommended_lm(tier),
    ]
    # Les cles vides sont omises : run.bat lit le fichier avec "for /f", qui ne definit pas la valeur
    # d'une cle sans contenu (et laisserait un texte parasite a la place).
    lines = [l for l in lines if l.startswith("#") or not l.endswith("=")]
    with open(os.path.join(ROOT, "hardware_profile.env"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")

    if cpu_mode:
        print("  Profil materiel : mode processeur, palier ACE-Step %s." % tier)
    else:
        print("  Profil materiel : %s, %d Go de VRAM, palier ACE-Step %s." % (name or "GPU", cls, tier))
    print("  Modele par defaut : %s, modele de langage : %s." % (model, "active" if init_llm == "true" else "desactive"))
    if cpu_mode:
        print("  Delai de generation porte a 3600 s (le processeur est environ 15 fois plus lent que l'audio produit).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
