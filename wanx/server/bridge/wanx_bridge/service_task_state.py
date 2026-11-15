"""Authenticated, atomically replaced private task journal owned by Bridge."""

from __future__ import annotations

import hashlib
import json
import os
import stat
import tempfile
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .config import BridgeAuthError

_CONTEXT = b"wanx-bridge-service-task-state-v1"
_LIMIT = 8 * 1024 * 1024


class ServiceTaskState:
    def __init__(self, path: Path, key: bytes):
        self.path = Path(path)
        self.cipher = AESGCM(hashlib.sha256(_CONTEXT + key).digest())
        parent = self.path.parent
        parent.mkdir(parents=True, mode=0o700, exist_ok=True)
        metadata = parent.lstat()
        if (
            not stat.S_ISDIR(metadata.st_mode)
            or metadata.st_uid != os.getuid()
            or metadata.st_mode & 0o022
        ):
            raise BridgeAuthError("TASK_STATE_INVALID", 503)

    def read(self):
        try:
            fd = os.open(self.path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        except FileNotFoundError:
            return []
        except OSError as exc:
            raise BridgeAuthError("TASK_STATE_INVALID", 503) from exc
        try:
            with os.fdopen(fd, "rb") as stream:
                metadata = os.fstat(stream.fileno())
                if (
                    not stat.S_ISREG(metadata.st_mode)
                    or metadata.st_uid != os.getuid()
                    or metadata.st_mode & 0o077
                    or metadata.st_size > _LIMIT
                ):
                    raise ValueError("unsafe journal")
                raw = stream.read(_LIMIT + 1)
            body = json.loads(self.cipher.decrypt(raw[:12], raw[12:], _CONTEXT))
            if (
                body.get("schemaVersion") != 1
                or not isinstance(body.get("tasks"), list)
                or len(body["tasks"]) > 4096
            ):
                raise ValueError("invalid journal")
            return body["tasks"]
        except Exception as exc:
            raise BridgeAuthError("TASK_STATE_INVALID", 503) from exc

    def write(self, tasks):
        raw = json.dumps({"schemaVersion": 1, "tasks": tasks}, separators=(",", ":")).encode()
        if len(raw) > _LIMIT - 28:
            raise BridgeAuthError("TASK_STATE_CAPACITY", 503)
        nonce = os.urandom(12)
        raw = nonce + self.cipher.encrypt(nonce, raw, _CONTEXT)
        name = None
        try:
            fd, name = tempfile.mkstemp(prefix=".service-tasks-", dir=self.path.parent)
            with os.fdopen(fd, "wb") as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(name, self.path)
            directory = os.open(self.path.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        except OSError as exc:
            raise BridgeAuthError("TASK_STATE_UNAVAILABLE", 503) from exc
        finally:
            if name and os.path.exists(name):
                os.unlink(name)
