#!/usr/bin/env python3
"""Trusted, idempotent SSO Huohua identity bootstrap; never starts a service.

Run after OS's fixed Huohua profile provisioning. The supplied public key must
be exported from the installed SSO Bridge signing identity by the operator.
Application archives never invoke this program or provide its inputs.
"""
from __future__ import annotations

import argparse
import ipaddress
import json
import os
import pwd
import re
import stat
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)

ROOT_UID = 0
ROOT_GID = 0
BRIDGE_UID = 10003
BRIDGE_GID = 10003
IDENTITY = Path("etc/centuaros/huohua")
REGISTRY = Path("etc/centuaros/huohua-bridge")
ACTIVATION = "/var/lib/wanx/services/huohua.workbench/activation.json"
_IP_COMMANDS = (Path("/usr/sbin/ip"), Path("/usr/bin/ip"))


def _directory(root: Path, path: Path) -> None:
    if not path.is_relative_to(root):
        raise ValueError("UNSAFE_PATH")
    for current in reversed((path, *path.parents)):
        if not current.is_relative_to(root):
            continue
        current.mkdir(mode=0o755, exist_ok=True)
        info = current.lstat()
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != ROOT_UID or info.st_mode & 0o022
                or (current != root or root == Path("/")) and not info.st_mode & 0o001):
            raise ValueError("UNSAFE_DIRECTORY")


def _existing(path: Path, uid: int, gid: int, mode: int) -> bytes | None:
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise ValueError("UNSAFE_FILE") from exc
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != uid or info.st_gid != gid or stat.S_IMODE(info.st_mode) != mode or info.st_size > 65536:
            raise ValueError("UNSAFE_FILE")
        return stream.read(65537)


def _write(path: Path, raw: bytes, uid: int, gid: int, mode: int) -> None:
    fd, temporary = tempfile.mkstemp(prefix=".huohua-provision-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(raw)
            stream.flush()
            os.fchown(stream.fileno(), uid, gid)
            os.fchmod(stream.fileno(), mode)
            os.fsync(stream.fileno())
        # Atomic create-only publication: another bootstrap may have installed
        # its private identity since preflight. Never replace that identity.
        os.link(temporary, path, follow_symlinks=False)
        os.unlink(temporary)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        Path(temporary).unlink(missing_ok=True)


def _local_ipv4_addresses() -> set[str]:
    """Read assigned interface addresses, without DNS or a non-local bind probe."""
    command = None
    for candidate in _IP_COMMANDS:
        try:
            info = candidate.stat()
        except FileNotFoundError:
            continue
        if stat.S_ISREG(info.st_mode) and info.st_uid == ROOT_UID and not info.st_mode & 0o022:
            command = str(candidate)
            break
    if command is None:
        raise ValueError("LOCAL_INTERFACE_EVIDENCE_REQUIRED")
    try:
        result = subprocess.run([command, "-j", "-4", "address", "show"],
                                capture_output=True, text=True, check=True, timeout=5)
        if len(result.stdout) > 1024 * 1024:
            raise ValueError("interface evidence too large")
        interfaces = json.loads(result.stdout)
        if not isinstance(interfaces, list):
            raise TypeError("interface evidence schema")
        addresses = set()
        for interface in interfaces:
            if "UP" not in interface["flags"]:
                continue
            for address in interface.get("addr_info", []):
                if address.get("family") == "inet":
                    addresses.add(str(ipaddress.IPv4Address(address["local"])))
        return addresses
    except (OSError, subprocess.SubprocessError, ValueError, TypeError, KeyError) as exc:
        raise ValueError("LOCAL_INTERFACE_EVIDENCE_REQUIRED") from exc


def _bridge_origin(bridge_url: str) -> None:
    try:
        origin = urlsplit(bridge_url)
        address = ipaddress.IPv4Address(origin.hostname or "")
        if (origin.scheme != "http" or origin.username or origin.password or origin.path
                or origin.query or origin.fragment or not origin.port
                or bridge_url != f"http://{address}:{origin.port}"
                or address.is_unspecified or address.is_multicast or address.is_reserved):
            raise ValueError("invalid origin")
    except ValueError as exc:
        raise ValueError("INVALID_BRIDGE_IDENTITY") from exc
    # The existing loopback contract works without iproute2. A non-loopback
    # literal must be assigned to an UP local interface at trusted provisioning.
    if str(address) != "127.0.0.1" and str(address) not in _local_ipv4_addresses():
        raise ValueError("INVALID_BRIDGE_IDENTITY")


def provision(root: Path, *, box_id: str, bridge_url: str, bridge_public: bytes) -> None:
    # root is a filesystem seam for tests; the command only ever uses '/'.
    if os.geteuid() != ROOT_UID:
        raise ValueError("ROOT_REQUIRED")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", box_id):
        raise ValueError("INVALID_BRIDGE_IDENTITY")
    _bridge_origin(bridge_url)
    public_key = serialization.load_pem_public_key(bridge_public)
    if not isinstance(public_key, Ed25519PublicKey):
        raise TypeError("INVALID_BRIDGE_KEY")
    public = public_key.public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
    account = pwd.getpwnam("centuaros-huohua")
    identity, registry = root / IDENTITY, root / REGISTRY
    _directory(root, identity)
    _directory(root, registry)
    private_path = identity / "service-private.pem"
    prior = _existing(private_path, ROOT_UID, account.pw_gid, 0o640)
    key = serialization.load_pem_private_key(prior, password=None) if prior else Ed25519PrivateKey.generate()
    if not isinstance(key, Ed25519PrivateKey):
        raise TypeError("INVALID_SERVICE_KEY")
    private = prior or key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    record = {"enabled": True, "upstream": "http://127.0.0.1:8093", "uid": account.pw_uid,
              "tokenAudience": "wanx-bridge", "protocolVersion": 1, "minWanxVersion": ">=1.0.0",
              "routes": [{"prefix": "/api/huohua/v1", "methods": ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"], "sse": True, "websocket": False}],
              "health": {"liveness": "/healthz", "readiness": "/readyz", "version": "/version"},
              "activation": {"mode": "ota", "path": ACTIVATION},
              "servicePublicKeyFile": "/etc/centuaros/huohua-bridge/service.pub"}
    environment = {"WANX_BRIDGE_URL": bridge_url, "HUOHUA_BOX_ID": box_id,
                   "HUOHUA_SERVICE_PRIVATE_KEY_FILE": "/etc/centuaros/huohua/service-private.pem",
                   "WANX_BRIDGE_PUBLIC_KEY_FILE": "/etc/centuaros/huohua/bridge-public.key",
                   "HUOHUA_ENABLE_LEGACY_PREFIX": "0"}
    files = [
        (private_path, private, ROOT_UID, account.pw_gid, 0o640),
        (identity / "bridge-public.key", public, ROOT_UID, account.pw_gid, 0o644),
        (registry / "service.pub", key.public_key().public_bytes_raw(), BRIDGE_UID, BRIDGE_GID, 0o600),
        (registry / "service-registry.json", (json.dumps({"schemaVersion": 1, "services": {"huohua.workbench": record}}, sort_keys=True) + "\n").encode(), BRIDGE_UID, BRIDGE_GID, 0o600),
        (root / "etc/centuaros/huohua.env", "".join(f'{name}="{value}"\n' for name, value in environment.items()).encode(), ROOT_UID, ROOT_GID, 0o600),
    ]
    # Refuse implicit key rotation, ownership adoption, or changing another box.
    pending = []
    for path, raw, uid, gid, mode in files:
        existing = _existing(path, uid, gid, mode)
        if existing is not None and existing != raw:
            raise ValueError("EXISTING_CONFIGURATION_DIFFERS")
        if existing is None:
            pending.append((path, raw, uid, gid, mode))
    for item in pending:
        _write(*item)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--box-id", required=True)
    parser.add_argument("--bridge-url", required=True)
    parser.add_argument("--bridge-public-key", type=Path, required=True)
    args = parser.parse_args()
    provision(Path("/"), box_id=args.box_id, bridge_url=args.bridge_url, bridge_public=args.bridge_public_key.read_bytes())
    print("Huohua SSO identities provisioned; existing keys preserved; no service restarted.")


if __name__ == "__main__":
    main()
