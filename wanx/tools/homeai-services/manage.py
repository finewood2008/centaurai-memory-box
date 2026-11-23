#!/usr/bin/env python3
"""Stage and register local HomeAI pilots without replacing unrelated registry entries."""

from __future__ import annotations

import argparse
from contextlib import contextmanager
from contextlib import ExitStack
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

APPS = {
    "media": ("media-processing", "wanx_media", "wanx-media"),
    "homeai": ("homeai", "homeai", "wanx-homeai"),
}
PORTS = {"media": 29094, "homeai": 29095}
REPO = Path(__file__).resolve().parents[2]


def digest(path):
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def safe_dir(path):
    if path.is_symlink():
        raise ValueError("managed directory must not be a symbolic link")
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.stat().st_uid != os.geteuid() or path.stat().st_mode & 0o077:
        raise ValueError(
            "managed directory requires current owner and private permissions"
        )


def private_file(path):
    if (
        path.is_symlink()
        or not path.is_file()
        or path.stat().st_mode & 0o077
        or path.stat().st_uid != os.geteuid()
    ):
        raise ValueError(
            "registry/key must be a private regular file owned by the current user"
        )


def save(path, data):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as out:
        tmp = Path(out.name)
        try:
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
        except BaseException:
            tmp.unlink()
            raise
    try:
        os.replace(tmp, path)
        fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        tmp.unlink(missing_ok=True)


def json_bytes(value):
    return (
        json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    ).encode()


@contextmanager
def locked(path):
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)


def sources(repo):
    selected = {}
    for key, (folder, package, _) in APPS.items():
        src = repo / "server/services" / folder
        for path in [
            src / "pyproject.toml",
            src / "uv.lock",
            *sorted((src / package).rglob("*.py")),
        ]:
            if not path.is_file() or path.is_symlink():
                raise ValueError("service sources must be regular files")
            selected[Path(key) / path.relative_to(src)] = path
        if key == "media":
            selected[Path(key) / "registry.example.json"] = (
                src / "registry.example.json"
            )
    return selected


def stage(args):
    root = args.root
    safe_dir(root)
    releases = root / "releases"
    safe_dir(releases)
    with locked(root / ".stage.lock"):
        selected = sources(args.repo)
        checks = {str(name): digest(path) for name, path in selected.items()}
        ident = hashlib.sha256(json_bytes(checks)).hexdigest()
        target = releases / ident
        if target.exists():
            verify_release(target, ident)
        else:
            with tempfile.TemporaryDirectory(dir=releases) as tmp:
                built = Path(tmp) / "release"
                for relative, source in selected.items():
                    dest = built / relative
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(source, dest)
                save(built / "sources.json", json_bytes(checks))
                verify_release(built, ident)
                built.rename(target)
        return {"release": ident, "files": len(checks)}


def verify_release(path, ident):
    if not re.fullmatch("[0-9a-f]{64}", ident) or path.is_symlink():
        raise ValueError("invalid release")
    manifest = path / "sources.json"
    if digest(manifest) != ident:
        raise ValueError("release manifest mismatch")
    records = json.loads(manifest.read_bytes())
    present = set()
    for member in path.rglob("*"):
        if member.is_symlink():
            raise ValueError("release contains an unexpected symlink")
        if member.is_file() and member != manifest:
            present.add(str(member.relative_to(path)))
    if present != set(records):
        raise ValueError("release file set mismatch")
    for name, expected in records.items():
        member = path / name
        if (
            Path(name).is_absolute()
            or ".." in Path(name).parts
            or member.is_symlink()
            or digest(member) != expected
        ):
            raise ValueError("release source mismatch")


def install(args):
    safe_dir(args.root)
    if not re.fullmatch("[0-9a-f]{64}", args.release):
        raise ValueError("invalid release")
    release = args.root / "releases" / args.release
    with locked(args.root / ".install.lock"):
        verify_release(release, args.release)
        # A selected deployment profile is immutable. Re-running never silently removes an extra.
        extras = sorted(set(args.extra))
        activation = args.root / "active.json"
        profile = hashlib.sha256(
            json_bytes([args.release, extras, str(args.python.resolve())])
        ).hexdigest()
        envs = args.root / "runtimes" / profile
        for service in APPS:
            env = envs / service
            cmd = [
                args.uv,
                "sync",
                "--locked",
                "--no-dev",
                "--no-editable",
                "--python",
                str(args.python.resolve()),
                "--project",
                str(release / service),
            ]
            if not args.online:
                cmd.append("--offline")
            if service == "media":
                for extra in extras:
                    cmd += ["--extra", extra]
            subprocess.run(
                cmd, env={**os.environ, "UV_PROJECT_ENVIRONMENT": str(env)}, check=True
            )
            subprocess.run(
                [str(env / "bin" / APPS[service][2]), "--help"],
                stdout=subprocess.DEVNULL,
                check=True,
            )
        previous = json.loads(activation.read_bytes()) if activation.exists() else None
        current = {"release": args.release, "profile": profile, "extras": extras}
        if previous != current:
            if previous:
                save(args.root / "previous.json", json_bytes(previous))
            save(activation, json_bytes(current))
        return current


def runtime(root, service):
    active = json.loads((root / "active.json").read_bytes())
    if not re.fullmatch("[0-9a-f]{64}", active["profile"]):
        raise ValueError("invalid runtime profile")
    binary = root / "runtimes" / active["profile"] / service / "bin" / APPS[service][2]
    if not binary.is_file():
        raise ValueError("missing installed runtime")
    return binary


def ports(args):
    mapping = {"media": args.media_port, "homeai": args.homeai_port}
    if len(set(mapping.values())) != 2 or any(
        p < 1024 or p > 65535 for p in mapping.values()
    ):
        raise ValueError("use distinct unprivileged loopback ports")
    return mapping


def service_lock(root, service):
    descriptor = os.open(
        root / (service + ".process-lock"),
        os.O_NOFOLLOW | os.O_CREAT | os.O_RDWR,
        0o600,
    )
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(descriptor)
        raise ValueError("managed service is running") from None
    return descriptor


def deactivate(args):
    safe_dir(args.root)
    with locked(args.root / ".install.lock"), ExitStack() as guards:
        if (args.root / "owned-registry.json").exists():
            raise ValueError("unregister this installation before deactivating")
        for service in APPS:
            guards.callback(os.close, service_lock(args.root, service))
        active = args.root / "active.json"
        if active.exists():
            os.replace(active, args.root / "previous.json")
    return {"active": False, "dataPreserved": True}


def serve(args):
    safe_dir(args.root)
    descriptor = service_lock(args.root, args.service)
    os.set_inheritable(descriptor, True)
    addresses = ports(args)
    key = args.bridge_public_key.resolve()
    if not key.is_file() or key.stat().st_size != 32:
        raise ValueError("use the trusted raw 32-byte Bridge verification key")
    binary = runtime(args.root, args.service)
    data = args.root / "data" / args.service
    safe_dir(data)
    cmd = [str(binary), "serve", "--port", str(addresses[args.service])]
    env = dict(os.environ)
    if args.service == "media":
        cmd += ["--data-dir", str(data), "--public-key", str(key)]
    else:
        cmd += ["--data", str(data)]
        env.update(
            HOMEAI_BOX_ID=args.box,
            HOMEAI_BRIDGE_PUBLIC_KEY_FILE=str(key),
            HOMEAI_MEDIA_LOOPBACK_PORT=str(addresses["media"]),
        )
    os.execve(binary, cmd, env)


def ensure_service_keys(root, service):
    # These keys prove service installation; they do not sign user JWTs.
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    keys = root / "keys"
    safe_dir(keys)
    priv = keys / (service + ".key")
    pub = keys / (service + ".pub")
    if priv.exists():
        private_file(priv)
        key = Ed25519PrivateKey.from_private_bytes(priv.read_bytes())
    elif pub.exists():
        raise ValueError("installation public key exists without its private key")
    else:
        key = Ed25519PrivateKey.generate()
        save(priv, key.private_bytes_raw())
    raw = key.public_key().public_bytes_raw()
    if pub.exists():
        private_file(pub)
        if pub.read_bytes() != raw:
            raise ValueError("installation key pair mismatch")
    else:
        save(pub, raw)
    return str(pub)


def records(args):
    addresses = ports(args)
    return {
        "wanx." + service: {
            "enabled": True,
            "upstream": "http://127.0.0.1:" + str(addresses[service]),
            "uid": getattr(args, service + "_uid"),
            "tokenAudience": "wanx-bridge",
            "protocolVersion": 1,
            "minWanxVersion": ">=1.5.2",
            "servicePublicKeyFile": ensure_service_keys(args.root, service),
            "activation": {"mode": "legacy"},
            "routes": [
                {
                    "prefix": "/api/services/wanx." + service + "/v1",
                    "methods": ["GET", "POST", "PUT", "DELETE"],
                    "sse": False,
                    "websocket": service == "media" and args.media_streaming,
                }
            ],
            "health": {
                "liveness": "/healthz",
                "readiness": "/readyz",
                "version": "/version",
            },
        }
        for service in APPS
    }


def registry(args):
    root = args.root
    safe_dir(root)
    path = args.registry.absolute()
    if not path.parent.is_dir() or path.is_symlink():
        raise ValueError(
            "registry requires a real existing parent and regular destination"
        )
    receipt = root / "owned-registry.json"
    with (
        locked(root / ".registry.lock"),
        locked(path.with_name(path.name + ".homeai.lock")),
    ):
        if path.exists():
            private_file(path)
            original = path.read_bytes()
            if len(original) > 65536:
                raise ValueError("existing registry exceeds Bridge limit")
            merged = json.loads(original)
        else:
            original = None
            merged = {"schemaVersion": 1, "services": {}}
        if merged.get("schemaVersion") != 1 or not isinstance(
            merged.get("services"), dict
        ):
            raise ValueError("invalid existing registry")
        services = merged["services"]
        owned = (
            json.loads(receipt.read_bytes())
            if receipt.exists()
            else {"registry": str(path), "entries": {}}
        )
        if owned["registry"] != str(path):
            raise ValueError(
                "staging root already owns entries in a different registry"
            )
        entries = owned["entries"]
        if set(entries) - {"wanx.media", "wanx.homeai"}:
            raise ValueError("ownership receipt contains unexpected service IDs")
        # A conflict signals manual changes. Preserve them for the operator.
        if any(
            service in services and services[service] != entry
            for service, entry in entries.items()
        ):
            raise ValueError("registered service was changed outside this installation")
        if args.command == "unregister":
            for service in entries:
                services.pop(service, None)
            new = {}
        else:
            if min(args.homeai_uid, args.media_uid) < 0:
                raise ValueError("invalid service UID")
            new = records(args)
            for service, entry in new.items():
                if service in services and service not in entries:
                    raise ValueError(
                        "service ID already registered by another installation"
                    )
                if any(
                    i not in new and e.get("upstream") == entry["upstream"]
                    for i, e in services.items()
                ):
                    raise ValueError(
                        "loopback port already reserved by another service"
                    )
            if entries and new != entries:
                raise ValueError(
                    "unregister this installation before changing ports or service UIDs"
                )
            services.update(new)
        if original is None and not new:
            receipt.unlink(missing_ok=True)
            return {"registry": "absent", "managedServices": []}
        if len(json_bytes(merged)) > 65536:
            raise ValueError("merged registry exceeds Bridge size limit")
        # Persist intent before adding entries, so retry after a crash can complete.
        if new and entries != new:
            save(receipt, json_bytes({"registry": str(path), "entries": new}))
        if original is None or json.loads(original) != merged:
            save(path, json_bytes(merged))
        if not new and receipt.exists():
            receipt.unlink()
        return {
            "managedServices": sorted(new),
            "totalServices": len(services),
            "requiresBridgeRestart": True,
        }


def model_files(path):
    result = {}
    for file in sorted(path.rglob("*")):
        if file.is_symlink():
            raise ValueError("materialize model symlinks before sealing a bundle")
        if file.is_file():
            result[str(file.relative_to(path))] = {
                "bytes": file.stat().st_size,
                "sha256": digest(file),
            }
    if not result:
        raise ValueError("empty model directory")
    return result


def model(args):
    path = args.model_dir.resolve()
    manifest = args.manifest.absolute()
    if manifest.is_relative_to(path):
        raise ValueError("keep manifest outside sealed model directory")
    if args.command == "model-manifest":
        value = {
            "schemaVersion": 1,
            "engine": args.engine,
            "source": args.source,
            "revision": args.revision,
            "license": args.license,
            "files": model_files(path),
        }
        data = json_bytes(value)
        if manifest.exists() and manifest.read_bytes() != data:
            raise ValueError("target manifest exists with different contents")
        save(manifest, data)
        return {"files": len(value["files"]), "manifestSha256": digest(manifest)}
    if digest(manifest) != args.expected_sha256:
        raise ValueError("manifest differs from trusted release digest")
    value = json.loads(manifest.read_bytes())
    if value.get("schemaVersion") != 1 or value["files"] != model_files(path):
        raise ValueError("model contents differ from approved manifest")
    return {"verified": True, "engine": value["engine"], "files": len(value["files"])}


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in (
        "stage",
        "install",
        "serve",
        "register",
        "unregister",
        "deactivate",
        "model-manifest",
        "model-verify",
    ):
        sub = commands.add_parser(name)
        if name.startswith("model-"):
            sub.add_argument("--model-dir", type=Path, required=True)
            sub.add_argument("--manifest", type=Path, required=True)
            if name == "model-manifest":
                for key in ("source", "revision", "license"):
                    sub.add_argument("--" + key, required=True)
                sub.add_argument(
                    "--engine",
                    choices=["asr", "streaming", "punctuation", "clip", "ocr"],
                    required=True,
                )
            else:
                sub.add_argument("--expected-sha256", required=True)
            continue
        sub.add_argument("--root", type=Path, required=True)
        if name == "stage":
            sub.add_argument("--repo", type=Path, default=REPO)
        if name == "install":
            sub.add_argument("--release", required=True)
            sub.add_argument("--python", type=Path, default=Path(sys.executable))
            sub.add_argument("--uv", default="uv")
            sub.add_argument(
                "--online",
                action="store_true",
                help="permit uv to fetch locked dependencies",
            )
            sub.add_argument(
                "--extra",
                choices=["asr", "streaming", "vision", "heif"],
                action="append",
                default=[],
            )
        if name in ("register", "unregister"):
            sub.add_argument("--registry", type=Path, required=True)
        if name == "register":
            sub.add_argument(
                "--media-streaming", action="store_true",
                help="enable the realtime ASR WebSocket route on the media service",
            )
            for service in APPS:
                sub.add_argument("--" + service + "-uid", type=int, required=True)
        if name in ("register", "serve"):
            for service, port in PORTS.items():
                sub.add_argument("--" + service + "-port", type=int, default=port)
        if name == "serve":
            sub.add_argument("--service", choices=list(APPS), required=True)
            sub.add_argument("--bridge-public-key", type=Path, required=True)
            sub.add_argument("--box", required=True)
    args = parser.parse_args()
    if hasattr(args, "root"):
        args.root = args.root.absolute()
    dispatch = {
        "stage": stage,
        "install": install,
        "serve": serve,
        "register": registry,
        "unregister": registry,
        "deactivate": deactivate,
        "model-manifest": model,
        "model-verify": model,
    }
    try:
        result = dispatch[args.command](args)
    except (
        ValueError,
        KeyError,
        PermissionError,
        FileNotFoundError,
        subprocess.CalledProcessError,
    ) as exc:
        parser.exit(2, str(exc) + "\n")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
