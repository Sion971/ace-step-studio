#!/usr/bin/env python3
"""
basic_pitch_convert.py — conversion audio -> MIDI via basic-pitch (Spotify).

Concu pour etre appele UNE FOIS par le serveur Node (spawn ponctuel, pas de
processus persistant), depuis l'environnement virtuel isole
(basic-pitch-venv/), jamais depuis le venv ACE-Step.

Usage :
    python3 basic_pitch_convert.py <audio_en_entree> <midi_en_sortie>

Sortie sur stdout : une seule ligne JSON, pour que le serveur Node puisse
l'analyser sans avoir a parser une sortie texte libre. Toute progression /
info de diagnostic part sur stderr, jamais sur stdout — separation stricte
pour eviter de polluer le JSON attendu par l'appelant.
"""

import sys
import json
import time


def emit_result(success: bool, **fields) -> None:
    """Une seule ligne JSON sur stdout — c'est le seul contrat avec l'appelant."""
    payload = {"success": success, **fields}
    print(json.dumps(payload), flush=True)


def main() -> int:
    if len(sys.argv) != 3:
        emit_result(False, error="Usage: basic_pitch_convert.py <input_audio> <output_midi>")
        return 1

    input_path, output_path = sys.argv[1], sys.argv[2]
    start = time.time()

    try:
        # Import differe : meme un import qui echoue (venv mal installe,
        # basic-pitch absent) doit produire le JSON d'erreur attendu par
        # l'appelant, pas une trace Python brute sur stderr uniquement.
        from basic_pitch.inference import predict
        from basic_pitch import ICASSP_2022_MODEL_PATH
    except ImportError as e:
        emit_result(False, error=f"basic-pitch introuvable dans ce venv : {e}")
        return 1

    print(f"[basic-pitch] Conversion : {input_path}", file=sys.stderr, flush=True)

    try:
        # Parametres par defaut de basic-pitch, deja verifies compatibles
        # avec la signature reelle lors de l'investigation navigateur
        # precedente (outputToNotesPoly) — onset_threshold=0.5,
        # frame_threshold=0.3, melodia_trick=True.
        model_output, midi_data, note_events = predict(
            input_path,
            model_or_model_path=ICASSP_2022_MODEL_PATH,
            onset_threshold=0.5,
            frame_threshold=0.3,
            minimum_note_length=127.70,
            melodia_trick=True,
        )
    except Exception as e:
        emit_result(False, error=f"Echec de l'inference : {e}")
        return 1

    if not note_events:
        # Pas une erreur en soi — un stem tres calme (bruit, silence) peut
        # legitimement ne produire aucune note detectee. L'appelant decide
        # comment presenter ce cas a l'utilisateur.
        emit_result(True, noteCount=0, warning="Aucune note detectee dans ce fichier.")
        return 0

    try:
        midi_data.write(output_path)
    except Exception as e:
        emit_result(False, error=f"Echec de l'ecriture du MIDI : {e}")
        return 1

    elapsed = round(time.time() - start, 2)
    print(f"[basic-pitch] Termine en {elapsed}s, {len(note_events)} notes.", file=sys.stderr, flush=True)
    emit_result(True, noteCount=len(note_events), elapsedSeconds=elapsed, outputPath=output_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
