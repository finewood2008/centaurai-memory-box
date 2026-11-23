"""Offline adapters. Model options come from the installer, never from request paths."""

from __future__ import annotations

import csv
import hashlib
from functools import lru_cache
import importlib.util
import io
import os
from pathlib import Path
import shutil
import subprocess
import warnings

from PIL import Image, ImageOps

SUMMARY_CAPABILITY = "text.summarize"
CAPABILITIES = (
    "audio.transcribe",
    "image.ocr",
    "image.fingerprint",
    "image.labels",
    "image.embedding",
    "image.match",
    "text.embedding",
    SUMMARY_CAPABILITY,
)
MAX_PIXELS = 32_000_000
MAX_SECONDS = 3600


class MediaError(Exception):
    """The message is a public, content-free error code."""


def model_dir(cap: str):
    variable = (
        "WANX_MEDIA_ASR_MODEL" if cap == "audio.transcribe" else "WANX_MEDIA_CLIP_MODEL"
    )
    value = os.getenv(variable)
    return Path(value) if value and Path(value).is_absolute() else None


def configured(cap: str) -> bool:
    if cap == SUMMARY_CAPABILITY:
        from .summary_engine import configured as summary_configured

        return summary_configured()
    if cap == "image.fingerprint":
        return True
    if cap == "image.ocr":
        return shutil.which("tesseract") is not None
    directory = model_dir(cap)
    if directory is None or not directory.is_dir():
        return False
    if cap == "audio.transcribe":
        return (
            (directory / "model.bin").is_file()
            and (directory / "tokenizer.json").is_file()
            and importlib.util.find_spec("faster_whisper") is not None
        )
    return (directory / "model.safetensors").is_file() and all(
        importlib.util.find_spec(module) is not None
        for module in ("transformers", "torch")
    )


@lru_cache(maxsize=1)
def heif_decoder():
    try:
        import pillow_heif

        info = pillow_heif.libheif_info()
        decoders = info.get("decoders", {})
        if not any(
            "hevc" in str(value).lower() or "de265" in key
            for key, value in decoders.items()
        ):
            return None
        pillow_heif.register_heif_opener(
            thumbnails=False, depth_images=False, aux_images=False, decode_threads=2
        )
        return str(info["libheif"])
    except (ImportError, OSError):
        return None


def capability_info(cap):
    ready = configured(cap)
    result = {
        "id": cap,
        "configured": ready,
        "state": "configured" if ready else "unavailable",
    }
    if cap == "audio.transcribe":
        result.update(
            formats=["wav", "flac", "ogg", "mp3", "m4a"], maxDurationSeconds=MAX_SECONDS
        )
    elif cap == "text.embedding":
        result.update(
            formats=["text/plain;charset=utf-8"], maxInputBytes=1024, maxCharacters=128
        )
    elif cap == SUMMARY_CAPABILITY:
        from .summary_engine import MAX_INPUT_BYTES

        result.update(
            formats=["text/plain;charset=utf-8"],
            maxInputBytes=MAX_INPUT_BYTES,
            processingLocation="cloud",
        )
    else:
        formats = ["jpeg", "png", "webp"]
        version = heif_decoder()
        if version:
            formats.extend(["heic", "heif"])
            result["heif"] = {"libheif": version, "maxPrimaryFrames": 1}
        result.update(formats=formats, maxPixels=MAX_PIXELS)
    return result


def validate_options(cap, options):
    allowed = {"image.match": {"query"}, "image.labels": {"labels"}}.get(cap, set())
    if options.keys() - allowed:
        raise ValueError("INVALID_OPTIONS")
    if cap == "image.match":
        value = options.get("query")
        if not isinstance(value, str) or not 1 <= len(value.strip()) <= 128:
            raise ValueError("QUERY_REQUIRED")
    if cap == "image.labels":
        labels = options.get("labels")
        if (
            not isinstance(labels, list)
            or not 2 <= len(labels) <= 32
            or any(
                not isinstance(x, str) or not 1 <= len(x.strip()) <= 64 for x in labels
            )
            or len(set(labels)) != len(labels)
        ):
            raise ValueError("LABEL_CANDIDATES_REQUIRED")


def fingerprint_file(path: Path):
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def audio_format(path):
    # Only admit self-contained audio containers; never auto-detect a playlist.
    with path.open("rb") as media_file:
        header = media_file.read(16)
    if header.startswith(b"RIFF") and header[8:12] == b"WAVE":
        return "wav"
    if header.startswith(b"fLaC"):
        return "flac"
    if header.startswith(b"OggS"):
        return "ogg"
    if header.startswith(b"ID3") or (
        header[0:1] == b"\xff" and len(header) > 1 and header[1] & 0xE0 == 0xE0
    ):
        return "mp3"
    if header[4:8] == b"ftyp":
        return "mov"
    raise MediaError("UNSUPPORTED_AUDIO_FORMAT")


def transcribe(path):
    import av
    from faster_whisper import WhisperModel

    model = model_dir("audio.transcribe")
    # Bound decoded duration, including containers with absent or inaccurate headers.
    import numpy as np

    samples = bytearray()
    sample_rate = 16_000
    resampler = av.AudioResampler(format="s16", layout="mono", rate=sample_rate)
    with (
        path.open("rb") as audio_file,
        av.open(
            audio_file,
            mode="r",
            format=audio_format(path),
            options={
                "enable_drefs": "0",
                "use_absolute_path": "0",
                "protocol_whitelist": "pipe",
            },
        ) as stream,
    ):
        for frame in stream.decode(audio=0):
            for mono in resampler.resample(frame):
                samples.extend(mono.to_ndarray().astype("<i2", copy=False).tobytes())
            if len(samples) > MAX_SECONDS * 32000:
                raise MediaError("AUDIO_DURATION_LIMIT")
        for mono in resampler.resample(None):
            samples.extend(mono.to_ndarray().astype("<i2", copy=False).tobytes())
    if not samples or len(samples) > MAX_SECONDS * 32000:
        raise MediaError("AUDIO_DURATION_INVALID")
    recognizer = WhisperModel(
        str(model), device="cpu", compute_type="int8", local_files_only=True
    )
    audio = np.frombuffer(samples, dtype="<i2").astype("float32") / 32768
    # The bundled Silero filter keeps Faster-Whisper's original-audio timestamps.
    segments, info = recognizer.transcribe(audio, beam_size=3, vad_filter=True)
    duration_ms = len(audio) * 1000 // sample_rate
    rows = []
    for seg in segments:
        text = seg.text.strip()
        start_ms = max(0, round(seg.start * 1000))
        end_ms = min(duration_ms, round(seg.end * 1000))
        if text and start_ms < end_ms:
            rows.append(
                {
                    "id": str(len(rows)),
                    "startMs": start_ms,
                    "endMs": end_ms,
                    "text": text,
                }
            )
    if not rows:
        raise MediaError("AUDIO_NO_SPEECH")
    return {
        "model": model.name,
        "modelSha256": fingerprint_file(model / "model.bin"),
        "language": info.language,
        "segments": rows,
        "text": "\n".join(s["text"] for s in rows),
    }


def ocr(img):
    language = os.getenv("WANX_MEDIA_OCR_LANG", "chi_sim+eng")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    try:
        out = subprocess.run(
            ["tesseract", "stdin", "stdout", "-l", language, "tsv"],
            input=buf.getvalue(),
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=180,
            check=True,
        ).stdout.decode("utf-8")
    except (OSError, subprocess.SubprocessError) as exc:
        raise MediaError("OCR_ENGINE_UNAVAILABLE") from exc
    words = []
    lines = {}
    for row in csv.DictReader(io.StringIO(out), delimiter="\t", quoting=csv.QUOTE_NONE):
        text = row.get("text", "").strip()
        if row["level"] != "5" or not text:
            continue
        key = tuple(row[k] for k in ("page_num", "block_num", "par_num", "line_num"))
        lines.setdefault(key, []).append(text)
        words.append(
            {
                "text": text,
                "box": [int(row[k]) for k in ("left", "top", "width", "height")],
                "confidence": float(row["conf"]) / 100,
            }
        )
    version = subprocess.run(
        ["tesseract", "--version"], capture_output=True, text=True, check=True
    ).stdout.splitlines()[0]
    return {
        "model": version + "/" + language,
        "text": "\n".join(" ".join(line) for line in lines.values()),
        "words": words,
    }


def read_query(path):
    if path.stat().st_size > 1024:
        raise MediaError("QUERY_SIZE_LIMIT")
    try:
        query = path.read_text(encoding="utf-8").strip()
    except UnicodeDecodeError:
        raise MediaError("INVALID_QUERY_ENCODING") from None
    if not 1 <= len(query) <= 128:
        raise MediaError("INVALID_QUERY_LENGTH")
    return query


def load_query_encoder():
    import torch
    from transformers import ChineseCLIPModel, ChineseCLIPProcessor

    directory = model_dir("text.embedding")
    processor = ChineseCLIPProcessor.from_pretrained(
        str(directory), local_files_only=True
    )
    full = ChineseCLIPModel.from_pretrained(
        str(directory), local_files_only=True, use_safetensors=True
    ).eval()
    text_model = full.text_model
    projection = full.text_projection
    max_length = full.config.text_config.max_position_embeddings
    # The image encoder is not resident during text-only queries.
    del full
    model_digest = fingerprint_file(directory / "model.safetensors")

    def encode(query):
        with torch.inference_mode():
            tokens = processor.tokenizer(
                [query], truncation=True, max_length=max_length, return_tensors="pt"
            )
            hidden = text_model(**tokens, return_dict=True).last_hidden_state
            vector = torch.nn.functional.normalize(projection(hidden[:, 0, :]), dim=-1)
            return {
                "model": directory.name,
                "modelSha256": model_digest,
                "vector": vector[0].tolist(),
            }

    return encode


def clip(cap, img, options):
    import torch
    from transformers import ChineseCLIPModel, ChineseCLIPProcessor

    directory = model_dir(cap)
    processor = ChineseCLIPProcessor.from_pretrained(
        str(directory), local_files_only=True
    )
    model = ChineseCLIPModel.from_pretrained(
        str(directory), local_files_only=True, use_safetensors=True
    ).eval()
    texts = (
        options.get("labels")
        if cap == "image.labels"
        else [options["query"]]
        if cap == "image.match"
        else None
    )
    with torch.inference_mode():
        result = {
            "model": directory.name,
            "modelSha256": fingerprint_file(directory / "model.safetensors"),
        }
        pixels = processor(images=img, return_tensors="pt")["pixel_values"]
        if texts is None:
            image = torch.nn.functional.normalize(
                model.get_image_features(pixel_values=pixels), dim=-1
            )
            result["vector"] = image[0].tolist()
        else:
            tokens = processor.tokenizer(
                texts,
                padding=True,
                truncation=True,
                max_length=model.config.text_config.max_position_embeddings,
                return_tensors="pt",
            )
            # The joint forward projects the text encoder's CLS state. The text
            # submodel has no separate pooling layer on Chinese-CLIP checkpoints.
            paired = model(pixel_values=pixels, **tokens, return_dict=True)
            if cap == "image.match":
                result["score"] = (paired.image_embeds @ paired.text_embeds.T)[
                    0, 0
                ].item()
            else:
                scores = paired.logits_per_image[0].softmax(dim=-1).tolist()
                result["labels"] = sorted(
                    [{"label": t, "score": v} for t, v in zip(texts, scores)],
                    key=lambda x: x["score"],
                    reverse=True,
                )
        return result


def run(cap: str, path: Path, options: dict):
    if cap == SUMMARY_CAPABILITY:
        from .summary_engine import summarize

        return summarize(path, options)
    if not configured(cap):
        raise MediaError("MODEL_UNAVAILABLE")
    if cap == "audio.transcribe":
        return transcribe(path)
    if cap == "text.embedding":
        return load_query_encoder()(read_query(path))
    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        formats = ["JPEG", "PNG", "WEBP"]
        if heif_decoder():
            formats.append("HEIF")
        with Image.open(path, formats=formats) as source:
            if source.format == "HEIF" and getattr(source, "n_frames", 1) != 1:
                raise MediaError("HEIF_FRAME_LIMIT")
            if source.width * source.height > MAX_PIXELS:
                raise MediaError("IMAGE_PIXEL_LIMIT")
            # OCR boxes refer to the encoded raster; return orientation for display mapping.
            orientation = source.getexif().get(274, 1)
            raw_size = source.size
            image = (
                source.convert("RGB")
                if cap == "image.ocr"
                else ImageOps.exif_transpose(source).convert("RGB")
            )
    if cap == "image.ocr":
        result = ocr(image)
    elif cap == "image.fingerprint":
        pixels = list(
            image.convert("L").resize((9, 8), Image.Resampling.LANCZOS).getdata()
        )
        bits = sum(
            (pixels[y * 9 + x] > pixels[y * 9 + x + 1]) << (y * 8 + x)
            for y in range(8)
            for x in range(8)
        )
        result = {"model": "dhash64-v1", "hash": format(bits, "016x")}
    else:
        result = clip(cap, image, options)
    return {
        **result,
        "width": raw_size[0],
        "height": raw_size[1],
        "exifOrientation": orientation,
    }
