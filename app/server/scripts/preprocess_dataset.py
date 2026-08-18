#!/usr/bin/env python3
"""
preprocess_dataset.py — prétraitement d'un dataset LoRA en tenseurs (.pt)

Remplace le script d'origine, écrit pour ACE-Step 1.0 et devenu incompatible :
  - DatasetBuilder.load_from_dict()  -> n'existe plus (utiliser load_dataset)
  - acestep.pipeline_ace_step        -> module supprimé en 1.5

Ce script appelle directement DatasetBuilder.preprocess_to_tensors(), la même
méthode que le bouton "Preprocess" de l'UI Gradio. Aucune dépendance à Gradio.

Emplacement : app/server/scripts/preprocess_dataset.py
Exécution   : depuis ACE-Step-1.5/ (c'est le cwd que la route Express utilise)

    ../.venv/bin/python ../app/server/scripts/preprocess_dataset.py \
        --dataset ./datasets/my_lora_dataset.json \
        --output  ./datasets/preprocessed_tensors \
        --max-duration 300 \
        --offload \
        --json
"""

import argparse
import inspect
import json
import os
import sys


# ---------------------------------------------------------------------------
# 1. Résolution des chemins et des imports
# ---------------------------------------------------------------------------

def resolve_ace_root() -> str:
    """Racine d'ACE-Step-1.5 : variable d'env, sinon déduite de ce fichier."""
    env = os.environ.get("ACESTEP_PATH")
    if env and os.path.isdir(env):
        return os.path.abspath(env)
    # app/server/scripts/ -> remonter jusqu'à la racine du Studio
    here = os.path.dirname(os.path.abspath(__file__))
    studio_root = os.path.abspath(os.path.join(here, "..", "..", ".."))
    return os.path.join(studio_root, "ACE-Step-1.5")


def import_dependencies(ace_root: str):
    """Importe DatasetBuilder et AceStepHandler, en tolérant les deux
    arborescences (la classe a migré vers dataset_builder_modules/)."""
    if ace_root not in sys.path:
        sys.path.insert(0, ace_root)

    try:
        from acestep.training.dataset_builder import DatasetBuilder
    except ImportError:
        from acestep.training.dataset_builder_modules.builder import DatasetBuilder

    from acestep.handler import AceStepHandler
    return DatasetBuilder, AceStepHandler


# ---------------------------------------------------------------------------
# 2. Initialisation du modèle
# ---------------------------------------------------------------------------

def init_handler(AceStepHandler, args, ace_root: str):
    """
    Instancie et initialise AceStepHandler.

    L'API d'initialisation a changé plusieurs fois entre versions. Plutôt que
    de coder en dur une signature, on cherche la méthode d'init disponible et
    on ne lui passe que les arguments qu'elle accepte réellement.
    """
    handler = AceStepHandler()

    # `initialize_service` est le nom effectif dans ACE-Step 1.5 ; les autres
    # sont conservés pour les versions antérieures.
    candidates = ["initialize_service", "init_service", "initialize", "init_models", "init"]
    method = next(
        (getattr(handler, n) for n in candidates if hasattr(handler, n)),
        None,
    )
    if method is None:
        raise RuntimeError(
            "Aucune méthode d'initialisation trouvée sur AceStepHandler. "
            f"Méthodes publiques disponibles : "
            f"{[m for m in dir(handler) if not m.startswith('_')][:40]}"
        )

    wanted = {
        "project_root": ace_root,
        "checkpoint_path": args.checkpoint,
        "checkpoint_path": args.checkpoint,
        "checkpoint": args.checkpoint,
        "config_path": args.config,
        "config": args.config,
        "device": args.device,
        "offload_to_cpu": args.offload,
        "offload_dit_to_cpu": args.offload,
        "init_llm": False,
        "quantization": args.quantization,
    }

    try:
        accepted = set(inspect.signature(method).parameters)
    except (TypeError, ValueError):
        accepted = set()

    kwargs = {k: v for k, v in wanted.items() if k in accepted and v is not None}
    print(f"Initialisation du modèle via {method.__name__}({', '.join(kwargs)})",
          file=sys.stderr)
    method(**kwargs)
    return handler


# ---------------------------------------------------------------------------
# 3. Programme principal
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(
        description="Prétraite un dataset LoRA en tenseurs .pt")
    parser.add_argument("--dataset", required=True,
                        help="Chemin du JSON du dataset")
    parser.add_argument("--output", required=True,
                        help="Dossier de sortie des .pt")
    parser.add_argument("--mode", default="lora", choices=["lora", "lokr"])
    parser.add_argument("--max-duration", type=float, default=240.0,
                        help="Durée max en secondes (défaut 240 ; "
                             "au-delà, l'audio est tronqué)")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--checkpoint", default=None)
    parser.add_argument("--config", default=None)
    parser.add_argument("--offload", action="store_true",
                        help="Offload CPU : un seul modèle en VRAM à la fois")
    # Le handler attend une chaîne de mode, pas un booléen : `False` déclenche
    # « Unsupported quantization type ». Sans valeur, le modèle charge en
    # pleine précision — int8_weight_only est ce que le pipeline utilise sur
    # une carte 8 Go (voir les logs de démarrage).
    parser.add_argument(
        "--quantization",
        nargs="?",
        const="int8_weight_only",
        default=None,
        choices=["int8_weight_only", "fp8_weight_only", "w8a8_dynamic"],
        help="Mode de quantification torchao ; sans valeur : int8_weight_only",
    )
    parser.add_argument("--skip-existing", action="store_true")
    parser.add_argument("--json", action="store_true",
                        help="Émet une dernière ligne JSON (lue par Express)")
    args = parser.parse_args()

    def emit(payload: dict, code: int) -> int:
        if args.json:
            print(json.dumps(payload))
        elif payload.get("status") == "error":
            print(f"Erreur : {payload.get('message')}", file=sys.stderr)
        return code

    ace_root = resolve_ace_root()
    print(f"Racine ACE-Step : {ace_root}", file=sys.stderr)

    try:
        DatasetBuilder, AceStepHandler = import_dependencies(ace_root)
    except ImportError as e:
        return emit({"status": "error",
                     "message": f"Import impossible : {e}"}, 1)

    # --- Chargement du dataset -------------------------------------------
    print(f"Chargement du dataset : {args.dataset}", file=sys.stderr)
    builder = DatasetBuilder()
    try:
        builder.load_dataset(args.dataset)
    except Exception as e:
        return emit({"status": "error",
                     "message": f"Chargement échoué : {e}"}, 1)

    total = len(builder.samples)
    labeled = (builder.get_labeled_count()
               if hasattr(builder, "get_labeled_count")
               else sum(1 for s in builder.samples if getattr(s, "labeled", False)))
    print(f"Dataset chargé : {total} échantillons, {labeled} étiquetés",
          file=sys.stderr)

    if total == 0:
        return emit({"status": "error", "message": "Dataset vide",
                     "total": 0, "labeled": 0}, 1)
    if labeled == 0:
        return emit({"status": "error",
                     "message": "Aucun échantillon étiqueté. Utilisez "
                                "l'auto-étiquetage avant le prétraitement.",
                     "total": total, "labeled": 0}, 1)

    # --- Initialisation du modèle ----------------------------------------
    try:
        handler = init_handler(AceStepHandler, args, ace_root)
    except Exception as e:
        return emit({"status": "error",
                     "message": f"Initialisation du modèle échouée : {e}"}, 1)

    if getattr(handler, "model", None) is None:
        return emit({"status": "error",
                     "message": "Le modèle n'est pas chargé "
                                "(handler.model est None)."}, 1)

    # --- Prétraitement ----------------------------------------------------
    os.makedirs(args.output, exist_ok=True)

    def progress(msg):
        print(msg, file=sys.stderr, flush=True)

    try:
        output_paths, status = builder.preprocess_to_tensors(
            dit_handler=handler,
            output_dir=args.output,
            max_duration=args.max_duration,
            preprocess_mode=args.mode,
            progress_callback=progress,
            skip_existing=args.skip_existing,
        )
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        return emit({"status": "error",
                     "message": f"Prétraitement échoué : {e}"}, 1)

    return emit({
        "status": "success",
        "message": status,
        "total": total,
        "labeled": labeled,
        "written": len(output_paths or []),
        "output_dir": os.path.abspath(args.output),
    }, 0)


if __name__ == "__main__":
    sys.exit(main())
