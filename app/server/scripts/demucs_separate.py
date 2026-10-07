#!/usr/bin/env python3
"""
demucs_separate.py — Separation de stems via Demucs, dans son venv isole.

Contrat STRICT (voir basic_pitch_convert.py, meme principe) : une seule
ligne JSON sur stdout en toute fin d'execution, jamais de texte libre.
Toute progression/diagnostic va sur stderr, relaye tel quel par le
serveur Node sans bloquer sur son contenu.

Usage :
    python3 demucs_separate.py <input_audio> <output_dir> <stem_mode>

    stem_mode : "4" (htdemucs — drums, bass, other, vocals)
             ou "6" (htdemucs_6s — + guitar, piano)
"""

import sys
import json
import time
import traceback


def main():
    if len(sys.argv) != 4:
        print(json.dumps({
            "success": False,
            "error": f"Usage: demucs_separate.py <input> <output_dir> <4|6>, received {len(sys.argv) - 1} argument(s)."
        }))
        sys.exit(1)

    input_path, output_dir, stem_mode = sys.argv[1], sys.argv[2], sys.argv[3]
    model_name = "htdemucs_6s" if stem_mode == "6" else "htdemucs"

    start = time.time()

    try:
        import torch
        from demucs.api import Separator, save_audio

        print(f"[demucs] Modele : {model_name}", file=sys.stderr)
        print(f"[demucs] Entree : {input_path}", file=sys.stderr)

        separator = Separator(model=model_name, device="cpu")

        print("[demucs] Separation en cours...", file=sys.stderr)
        _, separated = separator.separate_audio_file(input_path)

        import os
        os.makedirs(output_dir, exist_ok=True)

        stem_paths = {}
        for stem_name, stem_tensor in separated.items():
            stem_path = os.path.join(output_dir, f"{stem_name}.wav")
            save_audio(stem_tensor, stem_path, samplerate=separator.samplerate)
            stem_paths[stem_name] = stem_path
            print(f"[demucs] Ecrit : {stem_name}.wav", file=sys.stderr)

        elapsed = round(time.time() - start, 1)
        print(json.dumps({
            "success": True,
            "model": model_name,
            "stems": stem_paths,
            "elapsedSeconds": elapsed,
        }))

    except Exception as e:
        print(f"[demucs] ERREUR : {e}", file=sys.stderr)
        print(traceback.format_exc(), file=sys.stderr)
        print(json.dumps({
            "success": False,
            "error": str(e),
        }))
        sys.exit(1)


if __name__ == "__main__":
    main()
