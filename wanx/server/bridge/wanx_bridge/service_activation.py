"""Read the OS-owned activation commit before exposing an optional service.

The updater alone owns this record. The service process cannot grant itself a
public route by answering a health check while a candidate is being verified.
"""

from __future__ import annotations

import json
import os
import re
import stat
import tempfile
from pathlib import Path
from typing import Any

ROOT_UID = 0
TRUST_BOUNDARY = Path("/")
DEFAULT_ACTIVATION = Path("/var/lib/wanx/services/huohua.workbench/activation.json")
PROFILE = {
    "profileId": "huohua-python312-ubuntu2404-x64",
    "profileVersion": 1,
    "profileDigest": "2ed938432d04035fff396c7e70e845442f0bb9abce5246d9479842bda3255069",
}
PROFILE_314 = {
    "profileId": "huohua-python314-ubuntu-x64",
    "profileVersion": 1,
    "profileDigest": "6fab32770dbeaa4210be3afa9ee9b585144f3b4a13b53cd1631bb372965e9e50",
}
# Exact OS-owned profiles only; the original 3.12 identity remains recoverable.
SUPPORTED_PROFILES = (PROFILE, PROFILE_314)
_FIELDS = {
    "schemaVersion",
    "serviceId",
    "state",
    "version",
    "buildId",
    "sourceCommit",
    "artifactDigest",
    "runtimeDigest",
    "activationGeneration",
    "serviceProtocol",
    "profile",
    "operationId",
    "attemptGeneration",
    "planDigest",
}


class ActivationError(ValueError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def _parent_trust(path: Path) -> None:
    for parent in path.parents:
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != ROOT_UID or info.st_mode & 0o022:
            raise ValueError("untrusted activation directory")
        if parent == TRUST_BOUNDARY:
            return
    raise ValueError("activation outside trust boundary")


def load_activation(
    path: Path,
    *,
    service_id: str = "huohua.workbench",
    supported_profiles: tuple[dict[str, Any], ...] = SUPPORTED_PROFILES,
) -> dict[str, Any] | None:
    try:
        _parent_trust(path)
        try:
            fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        except FileNotFoundError:
            return None
        with os.fdopen(fd, "rb") as stream:
            info = os.fstat(stream.fileno())
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_uid != ROOT_UID
                or info.st_mode & 0o022
                or info.st_size > 8192
            ):
                raise ValueError("untrusted activation file")
            value = json.loads(stream.read(8193))
        if not isinstance(value, dict) or set(value) != _FIELDS:
            raise ValueError("activation schema")
        if (
            type(value["schemaVersion"]) is not int
            or value["schemaVersion"] != 1
            or value["serviceId"] != service_id
            or value["state"] not in {"preparing", "committed"}
            or type(value["serviceProtocol"]) is not int
            or value["serviceProtocol"] != 1
            or not isinstance(value["profile"], dict)
            or type(value["profile"].get("profileVersion")) is not int
            or value["profile"] not in supported_profiles
        ):
            raise ValueError("unsupported activation")
        for field in ("version", "buildId", "operationId"):
            if not isinstance(value[field], str) or not 1 <= len(value[field]) <= 256:
                raise ValueError("activation identity")
        for field in ("artifactDigest", "runtimeDigest", "planDigest"):
            if not isinstance(value[field], str) or not re.fullmatch(r"[0-9a-f]{64}", value[field]):
                raise ValueError("activation digest")
        if not isinstance(value["sourceCommit"], str) or not re.fullmatch(
            r"[0-9a-f]{40,64}", value["sourceCommit"]
        ):
            raise ValueError("activation source")
        for field in ("activationGeneration", "attemptGeneration"):
            if type(value[field]) is not int or value[field] < 1:
                raise ValueError("activation generation")
        return value
    except FileNotFoundError:
        return None
    except (OSError, ValueError, TypeError, KeyError) as exc:
        raise ActivationError("SERVICE_ACTIVATION_INVALID") from exc


def matches_running(activation: dict[str, Any], running: dict[str, Any]) -> bool:
    return (
        all(
            running.get(field) == activation[field]
            for field in (
                "version",
                "buildId",
                "sourceCommit",
                "artifactDigest",
                "runtimeDigest",
                "activationGeneration",
                "profile",
            )
        )
        and running.get("protocolVersion") == activation["serviceProtocol"]
    )


def running_process_identity() -> dict[str, Any]:
    """The updater verifies this identity inside the fixed Bridge container."""
    try:
        fields = Path("/proc/self/stat").read_text().rsplit(")", 1)[1].split()
        start_ticks = fields[19]
        boot_id = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
        if not start_ticks.isdigit() or not re.fullmatch(r"[0-9a-f-]{36}", boot_id):
            raise ValueError("process identity")
        return {"pid": os.getpid(), "startTimeTicks": start_ticks, "bootId": boot_id}
    except (OSError, ValueError, IndexError) as exc:
        raise ActivationError("BRIDGE_PROCESS_EVIDENCE_UNAVAILABLE") from exc


def write_bridge_evidence(path: Path, metadata: dict[str, Any]) -> None:
    """Publish only the running build's stamped identity, never a guessed version."""
    build_id = metadata.get("buildId")
    parent = path.parent
    info = parent.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022:
        raise ActivationError("BRIDGE_BUILD_EVIDENCE_PATH_INVALID")
    if not isinstance(build_id, str) or not 1 <= len(build_id) <= 256:
        # A restarted unstamped build must not inherit its predecessor's proof.
        path.unlink(missing_ok=True)
        raise ActivationError("BRIDGE_BUILD_EVIDENCE_UNAVAILABLE")
    try:
        process = running_process_identity()
    except ActivationError:
        path.unlink(missing_ok=True)
        raise
    descriptor, temporary = tempfile.mkstemp(prefix=".ota-evidence-", dir=parent)
    try:
        with os.fdopen(descriptor, "w") as stream:
            json.dump(
                {
                    "schemaVersion": 1,
                    "bridgeProtocol": 1,
                    "bridgeBuildId": build_id,
                    "process": process,
                },
                stream,
                sort_keys=True,
            )
            stream.flush()
            os.fchmod(stream.fileno(), 0o644)
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        fd = os.open(parent, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
