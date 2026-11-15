"""Exercise configured services over real loopback HTTP without production credentials.

Run with the candidate wanx_bridge on PYTHONPATH. All servers, keys and registry
files are temporary. The synthetic Host authority is confined to this process.
"""

from __future__ import annotations

import asyncio
import json
import secrets
import socket
import tempfile
import time
from contextlib import AsyncExitStack, asynccontextmanager
from pathlib import Path
from types import SimpleNamespace

import httpx
import uvicorn
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse

from wanx_bridge.config import BridgeAuthError
from wanx_bridge.server import create_app
from wanx_bridge.service_registry import ServiceRegistry
from wanx_bridge.service_sessions import ServiceSessionVerifier, service_proof_signature


@asynccontextmanager
async def serve(app):
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    sock.listen(128)
    server = uvicorn.Server(uvicorn.Config(app, log_level="critical", access_log=False))
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
        await asyncio.wait_for(task, 10)
        sock.close()


async def smoke():
    marker = secrets.token_urlsafe(32)
    observed = []
    verifier = None

    class Auth:
        def authorize(self, token):
            if token != marker:
                raise BridgeAuthError("AUTH_REQUIRED", 401)
            return SimpleNamespace(user={"id": "smoke-user"}, upstream_token="unused-octop-token",
                                   upstream_expires_at=time.time() + 60, expires_at=time.time() + 60)

        def assert_live(self, session):
            if time.time() >= session.expires_at:
                raise BridgeAuthError("AUTH_REQUIRED", 401)

    def backend(service_id):
        app = FastAPI()

        @app.get("/healthz")
        @app.get("/readyz")
        @app.get("/version")
        async def health():
            return {"ready": True, "protocolVersion": 1, "version": "1.0.0"}

        @app.api_route(f"/api/services/{service_id}/v1/{{path:path}}", methods=["GET", "POST"])
        async def echo(request: Request, path: str):
            token = request.headers["authorization"].removeprefix("Bearer ")
            claims = verifier.verify(token, service_id=service_id)
            assert claims["userId"] == "smoke-user"
            assert set(claims["scope"]) == {"service:read", "service:write"}
            assert "cookie" not in request.headers and "x-wanx-user-id" not in request.headers
            observed.append(service_id)
            if path == "events":
                async def events():
                    yield b"data: ready\n\n"
                return StreamingResponse(events(), media_type="text/event-stream")
            return {"serviceId": service_id, "body": (await request.body()).decode()}

        return app

    with tempfile.TemporaryDirectory(prefix="bridge-services-smoke-") as directory:
        async with AsyncExitStack() as stack:
            services = {}
            keys = {}
            for service_id, sse in (("smoke.notes", True), ("smoke.search", False)):
                origin = await stack.enter_async_context(serve(backend(service_id)))
                key = Ed25519PrivateKey.generate()
                public = Path(directory) / f"{service_id}.pub"
                public.write_bytes(key.public_key().public_bytes_raw())
                public.chmod(0o600)
                keys[service_id] = key
                services[service_id] = {
                    "enabled": True, "upstream": origin, "uid": 10007,
                    "tokenAudience": "wanx-bridge", "protocolVersion": 1, "minWanxVersion": ">=0.1.0",
                    "routes": [{"prefix": f"/api/services/{service_id}/v1", "methods": ["GET", "POST"], "sse": sse}],
                    "health": {"liveness": "/healthz", "readiness": "/readyz", "version": "/version"},
                    "servicePublicKeyFile": str(public), "activation": {"mode": "legacy"},
                }
            path = Path(directory) / "services.json"
            path.write_text(json.dumps({"schemaVersion": 1, "services": services}))
            path.chmod(0o600)
            registry = ServiceRegistry.load(path)
            verifier = ServiceSessionVerifier(registry, Ed25519PrivateKey.generate())
            bridge = create_app(Auth(), object(), upstream_url="http://127.0.0.1:1",
                                semantica_config_file=Path(directory) / "semantica.json",
                                service_registry=registry, service_session_verifier=verifier,
                                build_metadata={"version": "0.1.0"})
            origin = await stack.enter_async_context(serve(bridge))
            async with httpx.AsyncClient(base_url=origin, timeout=10, trust_env=False) as client:
                headers = {"Authorization": f"Bearer {marker}", "Cookie": "must-not-forward",
                           "x-wanx-user-id": "forged"}
                for service_id in services:
                    state = await client.get(f"/api/bridge/v1/services/{service_id}/status", headers=headers)
                    assert state.status_code == 200 and state.json()["status"] == "ready"
                    prefix = f"/api/services/{service_id}/v1"
                    response = await client.post(prefix + "/echo", headers=headers, content="payload")
                    assert response.json() == {"serviceId": service_id, "body": "payload"}
                    assert (await client.get(prefix + "/echo")).status_code == 401
                    assert (await client.delete(prefix + "/echo", headers=headers)).status_code == 403
                    assert (await client.get(prefix + "/%252e%252e/echo", headers=headers)).status_code == 403
                    response = await client.get(prefix + "/events", headers=headers)
                    if services[service_id]["routes"][0]["sse"]:
                        assert response.status_code == 200 and response.text == "data: ready\n\n"
                    else:
                        assert response.status_code == 502 and response.json()["code"] == "SERVICE_SSE_FORBIDDEN"
                    proof = {"serviceId": service_id, "protocolVersion": 1, "nonce": "smoke-proof",
                             "signature": service_proof_signature(keys[service_id], service_id, 1, "smoke-proof")}
                    session_path = f"/api/bridge/v1/services/{service_id}/session"
                    issued = await client.post(session_path, json=proof)
                    assert issued.status_code == 200
                    token = issued.json()["access_token"]
                    assert (await client.post(session_path, json=proof)).status_code == 401
                    assert (await client.post("/api/bridge/v1/capabilities/dialogue.models",
                                              headers={"Authorization": f"Bearer {token}"},
                                              json={"method": "GET"})).status_code in {401, 403}
                assert (await client.get("/api/services/missing/v1/echo", headers=headers)).status_code == 404
                assert set(observed) == set(services)
    return {"result": "passed", "services": sorted(services), "transport": "real-loopback-http-sse",
            "checks": ["status", "post-body", "delegated-identity", "credential-filtering", "method-allowlist",
                       "traversal-denied", "sse-policy", "installation-proof", "replay-denied",
                       "huohua-capabilities-denied", "unknown-service-denied"],
            "productionCredentialsUsed": False, "temporaryServersStopped": True}


if __name__ == "__main__":
    print(json.dumps(asyncio.run(smoke()), indent=2))
