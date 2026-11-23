"""Build, install and run both services on temporary ports using synthetic identities."""

import argparse
from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
import platform
import secrets
import socket
import subprocess
import sys
import tempfile
import time
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
import jwt
import manage


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def close_process(proc):
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--python", type=Path, default=Path(sys.executable))
    parser.add_argument("--uv", default="uv")
    parser.add_argument("--online", action="store_true")
    args = parser.parse_args()
    os.umask(0o077)
    with tempfile.TemporaryDirectory(prefix="homeai-install-smoke-") as tmp:
        base = Path(tmp)
        root = base / "pilot"
        release = manage.stage(argparse.Namespace(root=root, repo=manage.REPO))[
            "release"
        ]
        active = manage.install(
            argparse.Namespace(
                root=root,
                release=release,
                python=args.python,
                uv=args.uv,
                extra=[],
                online=args.online,
            )
        )
        key = Ed25519PrivateKey.generate()
        pub = base / "fixture.pub"
        pub.write_bytes(key.public_key().public_bytes_raw())
        kid = hashlib.sha256(pub.read_bytes()).hexdigest()
        ports = {"homeai": free_port(), "media": free_port()}
        while ports["media"] == ports["homeai"]:
            ports["media"] = free_port()
        with ExitStack() as processes:
            for service in manage.APPS:
                cmd = [
                    sys.executable,
                    str(Path(manage.__file__).resolve()),
                    "serve",
                    "--root",
                    str(root),
                    "--service",
                    service,
                    "--bridge-public-key",
                    str(pub),
                    "--box",
                    "fixture-box",
                    "--media-port",
                    str(ports["media"]),
                    "--homeai-port",
                    str(ports["homeai"]),
                ]
                proc = subprocess.Popen(
                    cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
                )
                processes.callback(close_process, proc)
                for _ in range(100):
                    if proc.poll() is not None:
                        raise RuntimeError("staged service exited during startup")
                    try:
                        with urlopen(
                            f"http://127.0.0.1:{ports[service]}/readyz", timeout=1
                        ) as res:
                            if json.load(res)["ready"]:
                                break
                    except URLError:
                        pass
                    time.sleep(0.1)
                else:
                    raise RuntimeError("staged service not ready")
            origin = f"http://127.0.0.1:{ports['homeai']}/api/services/wanx.homeai/v1"

            def call(
                method,
                route,
                user,
                space="personal",
                obj=None,
                data=None,
                expected=200,
                raw=False,
            ):
                now = int(time.time())
                claims = {
                    "iss": "wanx-bridge",
                    "aud": "wanx-bridge",
                    "boxId": "fixture-box",
                    "userId": user,
                    "spaceId": space,
                    "serviceId": "wanx.homeai",
                    "iat": now,
                    "exp": now + 60,
                    "protocolVersion": 1,
                    "jti": secrets.token_hex(8),
                    "scope": ["service:read", "service:write"],
                }
                token = jwt.encode(claims, key, algorithm="EdDSA", headers={"kid": kid})
                req = Request(
                    origin + route,
                    method=method,
                    data=json.dumps(obj).encode() if obj is not None else data,
                    headers={
                        "Authorization": "Bearer " + token,
                        "Content-Type": "application/json"
                        if obj is not None
                        else "application/octet-stream",
                    },
                )
                try:
                    with urlopen(req, timeout=10) as res:
                        assert res.status == expected
                        return res.read() if raw else json.load(res)
                except HTTPError as exc:
                    if exc.code != expected:
                        raise
                    exc.close()

            data = b"synthetic proof of private original"
            spec = {
                "uploadId": "test-receipt",
                "name": "fixture.txt",
                "size": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
            }
            call("POST", "/uploads", "alice", obj=spec)
            call("PUT", "/uploads/test-receipt?offset=0", "alice", data=data)
            asset = call("POST", "/uploads/test-receipt/complete", "alice")["assetId"]
            route = "/assets/" + asset + "/content"
            assert call("GET", route, "alice", raw=True) == data
            call("GET", route, "bob", expected=404)
            call("GET", route, "alice", space="other-space", expected=404)
            try:
                manage.deactivate(argparse.Namespace(root=root))
            except ValueError:
                pass
            else:
                raise AssertionError("running installation deactivated")

        backup_key = base / "archive.key"
        backup_key.write_bytes(secrets.token_bytes(32))
        archive = base / "fixture.snapshot"
        binary = manage.runtime(root, "homeai")

        def snapshot(command, directory, source, expected=0):
            res = subprocess.run(
                [
                    str(binary),
                    command,
                    "--data",
                    str(directory),
                    "--archive",
                    str(source),
                    "--key-file",
                    str(backup_key),
                ],
                capture_output=True,
            )
            assert (res.returncode == 0) == (expected == 0)

        snapshot("backup", root / "data/homeai", archive)
        snapshot("restore", base / "restored", archive)
        altered = bytearray(archive.read_bytes())
        altered[-1] ^= 1
        modified = base / "modified.snapshot"
        modified.write_bytes(altered)
        snapshot("restore", base / "failed-restore", modified, expected=1)
        assert not (base / "failed-restore/library.sqlite3").exists()
        manage.deactivate(argparse.Namespace(root=root))
        assert (
            not (root / "active.json").exists()
            and (root / "data/homeai/library.sqlite3").is_file()
        )
        return {
            "status": "passed",
            "platform": platform.system(),
            "architecture": platform.machine(),
            "release": active["release"],
            "startup": ["wanx.media", "wanx.homeai"],
            "loopbackOnly": True,
            "crossUserDenied": True,
            "crossSpaceDenied": True,
            "snapshotRoundTrip": True,
            "modifiedAuthenticationTagRejected": True,
            "deactivatePreservesData": True,
            "productionCredentialsUsed": False,
        }


if __name__ == "__main__":
    print(json.dumps(main(), indent=2))
