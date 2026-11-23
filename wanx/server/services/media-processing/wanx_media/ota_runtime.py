"""Expose the OS-stamped runtime identity of a managed media process."""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
import stat
import subprocess

from fastapi.responses import JSONResponse
from starlette.types import ASGIApp

from .media import configured, fingerprint_file, model_dir
from .stream_model import PUNCTUATION_SHA256, StreamingModel


_TRUST_ROOT = Path("/")
_OWNER_UID = 0
_PROFILE = {
    "profileId": "wanx-media-python314-ubuntu2604-x64",
    "profileVersion": 1,
    "profileDigest": "3a13f93e511058cbd79d51acd2cf1dd77d4e5cc733bcce929c341eb4f95ce780",
}
_MAX_IDENTITY_BYTES = 8192
_FIELDS = {
    "version", "buildId", "sourceCommit", "artifactDigest", "runtimeDigest",
    "activationGeneration", "profile", "protocolVersion",
}
_DIGEST = re.compile(r"[0-9a-f]{64}")
_SOURCE_COMMIT = re.compile(r"[0-9a-f]{40}|[0-9a-f]{64}")
_WHISPER_FILES = ("model.bin", "tokenizer.json", "config.json", "vocabulary.txt")


def _check_managed_path(path: Path) -> None:
    if not path.is_absolute() or not path.is_relative_to(_TRUST_ROOT) or ".." in path.parts:
        raise ValueError("untrusted media runtime identity path")
    for parent in path.parents:
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != _OWNER_UID or info.st_mode & 0o022:
            raise ValueError("untrusted media runtime identity directory")
        if parent == _TRUST_ROOT:
            break


def _read_identity(path: Path) -> dict:
    _check_managed_path(path)
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as stream:
        info = os.fstat(stream.fileno())
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != _OWNER_UID
            or info.st_mode & 0o022
            or not 0 < info.st_size <= _MAX_IDENTITY_BYTES
        ):
            raise ValueError("untrusted media runtime identity file")
        return json.loads(stream.read(_MAX_IDENTITY_BYTES + 1))


def load_runtime_identity() -> dict | None:
    value = os.getenv("WANX_MEDIA_OTA_RUNTIME_FILE")
    if value is None:
        return None
    try:
        identity = _read_identity(Path(value))
        if not isinstance(identity, dict) or set(identity) != _FIELDS:
            raise ValueError("invalid media runtime identity fields")
        profile = identity["profile"]
        if (
            not isinstance(profile, dict)
            or profile != _PROFILE
            or type(profile["profileVersion"]) is not int
            or not _SOURCE_COMMIT.fullmatch(identity["sourceCommit"])
            or not _DIGEST.fullmatch(identity["artifactDigest"])
            or not _DIGEST.fullmatch(identity["runtimeDigest"])
            or type(identity["activationGeneration"]) is not int
            or identity["activationGeneration"] < 1
            or type(identity["protocolVersion"]) is not int
            or identity["protocolVersion"] != 1
        ):
            raise ValueError("invalid media runtime identity")
        for name in ("version", "buildId"):
            text = identity[name]
            if not isinstance(text, str) or not 1 <= len(text) <= 128 or not text.isprintable():
                raise ValueError("invalid media build identity")
        return identity
    except (OSError, TypeError, ValueError) as exc:
        raise ValueError("WANX_MEDIA_OTA_IDENTITY_INVALID") from exc


def local_models_configured(streaming: StreamingModel) -> bool:
    """Check immutable local dependencies independently of optional cloud access."""
    whisper = model_dir("audio.transcribe")
    stream_directory = streaming.directory
    punctuation = streaming.punctuation_file
    try:
        if (
            whisper is None
            or not all((whisper / name).stat().st_size > 0 for name in _WHISPER_FILES)
            or not configured("audio.transcribe")
            or stream_directory is None
            or not stream_directory.is_absolute()
            or not streaming.configured()
            or punctuation is None
            or not punctuation.is_absolute()
            or not punctuation.is_file()
            or fingerprint_file(punctuation) != PUNCTUATION_SHA256
            or os.getenv("WANX_MEDIA_OCR_LANG", "chi_sim+eng") != "chi_sim+eng"
        ):
            return False
        languages = subprocess.run(
            ["tesseract", "--list-langs"], capture_output=True, check=True,
            text=True, timeout=5,
        ).stdout.splitlines()
        return {"chi_sim", "eng"}.issubset(languages)
    except (OSError, subprocess.SubprocessError, UnicodeError):
        return False


class MediaDrain:
    def __init__(self, marker: Path, api_prefixes: tuple[str, ...]):
        _check_managed_path(marker)
        self.marker = marker
        self.api_prefixes = api_prefixes
        self.inflight = 0

    def requested(self) -> bool:
        try:
            self.marker.lstat()
            return True
        except FileNotFoundError:
            return False
        except OSError:
            return True

    def middleware(self, app: ASGIApp) -> ASGIApp:
        async def gate(scope, receive, send):
            kind = scope["type"]
            if kind not in {"http", "websocket"} or not scope["path"].startswith(self.api_prefixes):
                await app(scope, receive, send)
                return
            if self.requested():
                if kind == "websocket":
                    await send({"type": "websocket.close", "code": 1013})
                else:
                    reply = JSONResponse({"code": "MEDIA_UPDATING"}, status_code=503)
                    await reply(scope, receive, send)
                return
            self.inflight += 1
            try:
                await app(scope, receive, send)
            finally:
                self.inflight -= 1

        return gate
