"""Run in the repository's Bridge test environment with wanx_media on PYTHONPATH."""

import asyncio
from contextlib import AsyncExitStack, asynccontextmanager
import hashlib
import io
import json
from pathlib import Path
import secrets
import socket
import tempfile
import time
from types import SimpleNamespace

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
import httpx
from PIL import Image
import uvicorn

from wanx_bridge.config import BridgeAuthError
from wanx_bridge.server import create_app as bridge_app
from wanx_bridge.service_registry import ServiceRegistry
from wanx_bridge.service_sessions import ServiceSessionVerifier
from wanx_media.app import PREFIX, SERVICE, create_app


@asynccontextmanager
async def serve(app):
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        sock.listen()
        server = uvicorn.Server(
            uvicorn.Config(app, log_level="critical", access_log=False)
        )
        task = asyncio.create_task(server.serve(sockets=[sock]))
        try:
            async with asyncio.timeout(10):
                while not server.started:
                    if task.done():
                        await task
                    await asyncio.sleep(0.01)
            yield f"http://127.0.0.1:{sock.getsockname()[1]}"
        finally:
            server.should_exit = True
            await asyncio.wait_for(task, 15)


async def main():
    marker = secrets.token_urlsafe(32)
    other_user = secrets.token_urlsafe(32)
    other_space = secrets.token_urlsafe(32)

    class Auth:
        config = SimpleNamespace(device_id="pilot-box")

        def authorize(self, token):
            if token not in (marker, other_user, other_space):
                raise BridgeAuthError("AUTH_REQUIRED", 401)
            return SimpleNamespace(
                user={
                    "id": "other-account" if token == other_user else "pilot-account",
                    "spaceId": "alternate" if token == other_space else "personal",
                },
                upstream_token="unused",
                upstream_expires_at=time.time() + 60,
                expires_at=time.time() + 60,
            )

        def assert_live(self, session):
            if session.expires_at <= time.time():
                raise BridgeAuthError("AUTH_REQUIRED", 401)

    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        async with AsyncExitStack() as stack:
            signing = Ed25519PrivateKey.generate()
            media = create_app(root / "data", signing.public_key())
            target = await stack.enter_async_context(serve(media))
            registry = json.loads(
                (Path(__file__).parents[1] / "registry.example.json").read_text()
            )
            record = registry["services"][SERVICE]
            record["upstream"] = target
            service_key = root / "installation.pub"
            service_key.write_bytes(
                Ed25519PrivateKey.generate().public_key().public_bytes_raw()
            )
            service_key.chmod(0o600)
            record["servicePublicKeyFile"] = str(service_key)
            registry_file = root / "registry.json"
            registry_file.write_text(json.dumps(registry))
            registry_file.chmod(0o600)
            registry = ServiceRegistry.load(registry_file)
            verifier = ServiceSessionVerifier(registry, signing)
            bridge = bridge_app(
                Auth(),
                object(),
                upstream_url="http://127.0.0.1:1",
                service_registry=registry,
                service_session_verifier=verifier,
                build_metadata={"version": "1.5.2"},
                semantica_config_file=root / "semantica.json",
            )
            origin = await stack.enter_async_context(serve(bridge))
            store = media.state.store
            grant, secret = store.grant(
                "pilot-box",
                "pilot-account",
                "personal",
                "first",
                ["image.fingerprint"],
                120,
            )
            _, second = store.grant(
                "pilot-box",
                "pilot-account",
                "personal",
                "second",
                ["image.fingerprint"],
                120,
            )
            headers = {"Authorization": "Bearer " + marker, "X-Media-Grant": secret}
            async with httpx.AsyncClient(
                base_url=origin, headers=headers, trust_env=False
            ) as h:
                response = await h.get("/api/bridge/v1/services/" + SERVICE + "/status")
                assert response.json()["status"] == "ready"
                assert (await h.get(PREFIX + "/capabilities")).json()[
                    "instance"
                ] == "first"
                png = io.BytesIO()
                Image.new("RGB", (32, 32), "green").save(png, format="PNG")
                data = png.getvalue()
                response = await h.post(
                    PREFIX + "/jobs",
                    json={
                        "requestId": "integration",
                        "capability": "image.fingerprint",
                        "size": len(data),
                        "sha256": hashlib.sha256(data).hexdigest(),
                    },
                )
                assert response.status_code == 200, response.status_code
                job = PREFIX + "/jobs/" + response.json()["id"]
                assert (await h.put(job + "/input?offset=0", content=data)).json()[
                    "offset"
                ] == len(data)
                assert (await h.post(job + "/submit")).json()["state"] == "queued"
                async with asyncio.timeout(15):
                    while (await h.get(job)).json()["state"] != "done":
                        await asyncio.sleep(0.1)
                assert (await h.get(job + "/result")).json()["result"][
                    "model"
                ] == "dhash64-v1"
                assert (
                    await h.get(job + "/result", headers={"X-Media-Grant": second})
                ).status_code == 404
                # Two valid, independently authenticated sessions cannot reuse a grant
                # issued to another user or to another space on the same box.
                for bearer, space in (
                    (other_user, "personal"),
                    (other_space, "alternate"),
                ):
                    wrong = {
                        "Authorization": "Bearer " + bearer,
                        "X-Wanx-Space-Id": space,
                    }
                    assert (
                        await h.get(job + "/result", headers=wrong)
                    ).status_code == 403
                _, separate = store.grant(
                    "pilot-box",
                    "other-account",
                    "personal",
                    "first",
                    ["image.fingerprint"],
                    120,
                )
                tenant = {
                    "Authorization": "Bearer " + other_user,
                    "X-Media-Grant": separate,
                }
                assert (
                    await h.get(PREFIX + "/capabilities", headers=tenant)
                ).status_code == 200
                assert (await h.get(job + "/result", headers=tenant)).status_code == 404
                store.revoke(grant)
                assert (await h.get(job + "/result")).status_code == 403
    return {
        "status": "passed",
        "transport": "real-loopback-Bridge-and-media",
        "registryValidated": True,
        "productionCredentialsUsed": False,
        "mediaJob": "image.fingerprint",
        "grantIsolation": True,
        "crossUserAndSpaceIsolation": True,
        "revocation": True,
    }


if __name__ == "__main__":
    print(json.dumps(asyncio.run(main()), indent=2))
