#!/usr/bin/env python3
"""
Local album-cover generator (SDXL Turbo) for ACE-Step Studio.

Long-lived worker driven by the Node server over stdin/stdout, one JSON object per line:

  stdin  : {"id": 1, "prompt": "...", "seed": 123, "steps": 3, "size": 512}
  stdout : {"id": 1, "ok": true, "mime": "image/jpeg", "data": "<base64>"}
           {"id": 1, "ok": false, "error": "..."}
           {"event": "loading"} / {"event": "ready"}   (progress, no id)
  stderr : free-form log lines (forwarded to the server console)

The model (stabilityai/sdxl-turbo, fp16 variant, about 7 GB) is downloaded by huggingface_hub into HF_HOME on first use,
then loaded with model CPU offload so that it fits next to the audio engine on an 8 GB card. The server stops this process
after a few idle minutes, which frees the VRAM.
"""
import base64
import io
import json
import os
import sys

MODEL_ID = os.environ.get("COVER_MODEL", "stabilityai/sdxl-turbo")


def log(*args):
    print("[cover-worker]", *args, file=sys.stderr, flush=True)


def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def load_pipeline():
    import torch
    from diffusers import AutoPipelineForText2Image

    if not torch.cuda.is_available():
        raise RuntimeError("no CUDA GPU available for local covers")
    send({"event": "loading"})
    log("loading", MODEL_ID, "(first use downloads about 7 GB)")
    pipe = AutoPipelineForText2Image.from_pretrained(
        MODEL_ID, torch_dtype=torch.float16, variant="fp16", use_safetensors=True
    )
    pipe.enable_model_cpu_offload()
    pipe.set_progress_bar_config(disable=True)
    send({"event": "ready"})
    log("ready")
    return pipe


def generate(pipe, req):
    import numpy as np
    import torch

    size = int(req.get("size") or 512)
    size = max(256, min(768, size - size % 8))
    generator = torch.Generator("cpu").manual_seed(int(req.get("seed") or 0) & 0x7FFFFFFF)
    image = pipe(
        prompt=str(req["prompt"])[:600],
        num_inference_steps=int(req.get("steps") or 3),
        guidance_scale=0.0,  # SDXL Turbo is distilled for guidance-free sampling
        width=size,
        height=size,
        generator=generator,
    ).images[0]
    # fp16 VAEs sometimes return a black frame: report it instead of saving it as a cover.
    if int(np.asarray(image).max()) < 12:
        raise RuntimeError("the model returned a black image")
    buf = io.BytesIO()
    image.convert("RGB").save(buf, format="JPEG", quality=92)
    torch.cuda.empty_cache()
    return buf.getvalue()


def main():
    pipe = None
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = {}
        try:
            req = json.loads(line)
            if pipe is None:
                pipe = load_pipeline()
            data = generate(pipe, req)
            send({"id": req.get("id"), "ok": True, "mime": "image/jpeg", "data": base64.b64encode(data).decode("ascii")})
        except Exception as exc:  # noqa: BLE001 - every failure goes back to the server, which falls back
            log("error:", repr(exc))
            send({"id": req.get("id"), "ok": False, "error": str(exc) or exc.__class__.__name__})


if __name__ == "__main__":
    main()
