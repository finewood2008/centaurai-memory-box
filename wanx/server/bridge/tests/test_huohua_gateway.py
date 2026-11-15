import json
import time

import httpx
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi import FastAPI, WebSocket
from test_gateway import live_server
from websockets.asyncio.client import connect

from wanx_bridge.config import BridgeAuthError
from wanx_bridge.huohua import HuohuaCapabilityGateway, resolve_capability
from wanx_bridge.server import create_app
from wanx_bridge.service_registry import ServiceRegistry
from wanx_bridge.service_sessions import ServiceSessionVerifier, service_proof_signature


def make(tmp_path):
    service_key = Ed25519PrivateKey.generate()
    public = tmp_path / "service.pub"
    public.write_bytes(service_key.public_key().public_bytes_raw())
    public.chmod(0o600)
    path = tmp_path / "services.json"
    path.write_text(json.dumps({"schemaVersion": 1, "services": {"huohua.workbench": {
        "enabled": True, "upstream": "http://127.0.0.1:8093", "uid": 10006,
        "tokenAudience": "wanx-bridge", "protocolVersion": 1, "minWanxVersion": ">=1.0.0",
        "routes": [{"prefix": "/api/huohua/v1", "methods": ["GET", "POST"], "sse": True, "websocket": False}],
        "health": {"liveness": "/healthz", "readiness": "/readyz", "version": "/version"},
        "activation": {"mode": "legacy"}, "servicePublicKeyFile": str(public),
    }}}))
    path.chmod(0o600)
    registry = ServiceRegistry.load(path)
    verifier = ServiceSessionVerifier(registry, Ed25519PrivateKey.generate())
    proof = service_proof_signature(service_key, "huohua.workbench", 1, "n")
    token = verifier.issue("huohua.workbench", protocol_version=1, nonce="n", signature=proof, user_id="7")["access_token"]
    return verifier, token


async def test_capability_gateway_uses_fixed_path_and_context(tmp_path):
    verifier, token = make(tmp_path)
    calls = []

    class Adapter:
        async def capability_request(self, method, path, claims, body, query):
            calls.append((method, path, claims["userId"], body, query))
            return {"ok": True}

    gateway = HuohuaCapabilityGateway(Adapter(), origin="http://127.0.0.1:18088", verifier=verifier)
    assert await gateway.dispatch(token, "dialogue.models", {"method": "GET"}) == {"ok": True}
    assert calls == [("GET", "/api/dialogue/models", "7", None, {})]

    try:
        await gateway.dispatch(token, "dialogue.models", {"method": "GET", "path": "/api/providers/resolved"})
    except BridgeAuthError as exc:
        assert exc.code == "CAPABILITY_PATH_NOT_ALLOWED"
    else:
        raise AssertionError("unexpected capability path acceptance")


async def test_capability_gateway_rejects_nested_identity_override(tmp_path):
    verifier, token = make(tmp_path)

    class Adapter:
        async def capability_request(self, *_args):
            raise AssertionError("request must be rejected before adapter")

    gateway = HuohuaCapabilityGateway(Adapter(), origin="http://127.0.0.1:18088", verifier=verifier)
    try:
        await gateway.dispatch(
            token,
            "personal-space.files",
            {"method": "GET", "body": {"userId": "other"}},
        )
    except BridgeAuthError as exc:
        assert exc.code == "SERVICE_CONTEXT_FORBIDDEN"
    else:
        raise AssertionError("unexpected nested identity acceptance")


async def test_capability_gateway_rejects_agent_websocket_path(tmp_path):
    verifier, token = make(tmp_path)

    class Adapter:
        async def capability_request(self, *_args):
            raise AssertionError("request must be rejected before adapter")

    gateway = HuohuaCapabilityGateway(Adapter(), origin="http://127.0.0.1:18088", verifier=verifier)
    try:
        await gateway.dispatch(
            token,
            "agents",
            {"method": "GET", "path": "/api/agents/a/chat/ws"},
        )
    except BridgeAuthError as exc:
        assert exc.code == "CAPABILITY_WEBSOCKET_NOT_ALLOWED"
    else:
        raise AssertionError("unexpected websocket capability acceptance")


async def test_capability_gateway_rejects_encoded_traversal_and_context_alias(tmp_path):
    verifier, token = make(tmp_path)

    class Adapter:
        async def capability_request(self, *_args):
            raise AssertionError("request must be rejected before adapter")

    gateway = HuohuaCapabilityGateway(Adapter(), origin="http://127.0.0.1:18088", verifier=verifier)
    for request in (
        {"method": "GET", "path": "/api/personal-space/files/%2e%2e/overview"},
        {"method": "GET", "body": {"USER-ID": "other"}},
    ):
        try:
            await gateway.dispatch(token, "personal-space.files", request)
        except BridgeAuthError as exc:
            assert exc.code in {"CAPABILITY_PATH_INVALID", "SERVICE_CONTEXT_FORBIDDEN"}
        else:
            raise AssertionError("unexpected unsafe capability acceptance")


def test_browser_capability_allowlist_covers_http_control_without_open_proxy():
    assert resolve_capability("browser.env", "GET", "/api/browser/env-status") == (
        "/api/browser/env-status",
        "workbench:browser",
    )
    assert resolve_capability(
        "browser.handoff", "POST", "/api/browser/sessions/owned/handoff"
    )[0].endswith("/owned/handoff")
    assert resolve_capability(
        "browser.record", "POST", "/api/browser/record-replay/start"
    )[1] == "workbench:browser"
    for capability, method, path in (
        ("browser.env", "POST", "/api/browser/env-status"),
        ("browser.handoff", "POST", "/api/browser/sessions/other"),
        ("browser.record", "PUT", "/api/browser/record-replay/start"),
        ("browser.env", "GET", "/api/internal/secrets"),
    ):
        try:
            resolve_capability(capability, method, path)
        except BridgeAuthError:
            pass
        else:
            raise AssertionError("unexpected browser capability acceptance")


def _app_environment(tmp_path, handler, *, upstream_url="http://127.0.0.1:18088"):
    service_key = Ed25519PrivateKey.generate()
    public = tmp_path / "service.pub"
    public.write_bytes(service_key.public_key().public_bytes_raw())
    public.chmod(0o600)
    path = tmp_path / "services.json"
    path.write_text(json.dumps({"schemaVersion": 1, "services": {"huohua.workbench": {
        "enabled": True, "upstream": "http://127.0.0.1:8093", "uid": 10006,
        "tokenAudience": "wanx-bridge", "protocolVersion": 1, "minWanxVersion": ">=1.0.0",
        "version": "1.0.0",
        "routes": [{"prefix": "/api/huohua/v1", "methods": ["GET", "POST"], "sse": True, "websocket": False}],
        "health": {"liveness": "/healthz", "readiness": "/readyz", "version": "/version"},
        "activation": {"mode": "legacy"}, "servicePublicKeyFile": str(public),
    }}}))
    path.chmod(0o600)
    registry = ServiceRegistry.load(path)
    bridge_key = Ed25519PrivateKey.generate()
    verifier = ServiceSessionVerifier(registry, bridge_key)

    class Auth:
        def __init__(self):
            self.session = type("Session", (), {
                "upstream_token": "octop-secret",
                "user": {"id": "user-7"},
                "expires_at": time.time() + 30,
                "upstream_expires_at": time.time() + 3600,
            })()

        def authorize(self, token):
            if token != "host-session":
                raise BridgeAuthError("AUTH_REQUIRED", 401)
            return self.session

        def assert_live(self, _session):
            return None

    transport = httpx.MockTransport(handler)
    app = create_app(
        Auth(),
        object(),
        upstream_url=upstream_url,
        clipboard_url=None,
        http_transport=transport,
        service_registry=registry,
        service_session_verifier=verifier,
        build_metadata={"version": "1.0.0"},
    )
    return app, verifier


@pytest.mark.asyncio
async def test_browser_websocket_uses_bound_upstream_token(tmp_path):
    upstream = FastAPI()
    seen = []

    @upstream.websocket("/api/browser-stream/ws")
    async def browser(websocket: WebSocket):
        await websocket.accept()
        seen.append({"headers": dict(websocket.headers), "query": dict(websocket.query_params)})
        await websocket.send_text("browser-ready")
        await websocket.close()

    async with live_server(upstream) as upstream_url:
        app, verifier = _app_environment(
            tmp_path,
            lambda _request: httpx.Response(200, json={"ready": True}),
            upstream_url=upstream_url,
        )
        token = verifier.issue_delegated(
            "huohua.workbench",
            protocol_version=1,
            box_id="box",
            user_id="user-7",
            space_id=None,
            scope=("workbench:browser",),
            upstream_token="octop-secret",
        )
        async with live_server(app) as bridge_url:
            async with connect(
                bridge_url.replace("http:", "ws:") + "/api/browser-stream/ws?token=" + token,
                proxy=None,
            ) as websocket:
                assert await websocket.recv() == "browser-ready"

    assert seen[0]["headers"]["authorization"] == "Bearer octop-secret"
    assert seen[0]["query"]["token"] == "octop-secret"
    assert token not in str(seen[0])


@pytest.mark.asyncio
async def test_service_proxy_delegates_identity_without_forwarding_host_credentials(tmp_path):
    seen = []

    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "127.0.0.1" and request.url.port == 8093:
            if request.url.path == "/healthz":
                return httpx.Response(200, json={"ok": True})
            if request.url.path == "/readyz":
                return httpx.Response(200, json={"ready": True})
            if request.url.path == "/version":
                return httpx.Response(200, json={"version": "1.0.0", "protocolVersion": 1})
            seen.append(request)
            return httpx.Response(200, json={"ok": True})
        return httpx.Response(404)

    app, verifier = _app_environment(tmp_path, handler)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://box") as client:
            response = await client.get(
                "/api/huohua/v1/status",
                headers={"Authorization": "Bearer host-session", "Cookie": "session=secret"},
            )
    assert response.status_code == 200
    assert len(seen) == 1
    assert seen[0].headers["authorization"].startswith("Bearer ey")
    assert seen[0].headers.get("cookie") is None
    claims = verifier.verify(seen[0].headers["authorization"].removeprefix("Bearer "))
    assert claims["userId"] == "user-7"
    assert claims["spaceId"] == "personal"
    assert "host-session" not in seen[0].headers["authorization"]


@pytest.mark.asyncio
async def test_capability_ingress_forwards_sse_and_rejects_provider_secret(tmp_path):
    calls = []

    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "127.0.0.1" and request.url.port == 18088:
            calls.append(request)
            if request.url.path == "/api/dialogue/models":
                return httpx.Response(200, json={"models": ["demo"]})
            return httpx.Response(200, content=b"data: token\n\n", headers={"content-type": "text/event-stream"})
        return httpx.Response(200, json={"ready": True})

    app, verifier = _app_environment(tmp_path, handler)
    token = verifier.issue_delegated(
        "huohua.workbench", protocol_version=1, box_id="box", user_id="user-7",
        space_id=None, scope=("workbench:read",), upstream_token="octop-secret",
    )
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://box") as client:
            models = await client.post(
                "/api/bridge/v1/capabilities/dialogue.models",
                headers={"Authorization": f"Bearer {token}"},
                json={"method": "GET"},
            )
            stream = await client.post(
                "/api/bridge/v1/capabilities/dialogue.sessions",
                headers={"Authorization": f"Bearer {verifier.issue_delegated('huohua.workbench', protocol_version=1, box_id='box', user_id='user-7', space_id=None, scope=('workbench:read',), upstream_token='octop-secret')}"},
                json={"method": "GET", "path": "/api/dialogue/sessions/demo"},
            )
            forbidden = await client.post(
                "/api/bridge/v1/capabilities/dialogue.models",
                headers={"Authorization": f"Bearer {token}"},
                json={"method": "GET", "body": {"provider_credentials": "secret"}},
            )
    assert models.status_code == 200 and models.json() == {"models": ["demo"]}
    assert stream.status_code == 200 and stream.headers["content-type"].startswith("text/event-stream")
    assert stream.text == "data: token\n\n"
    assert forbidden.status_code == 403 and forbidden.json()["code"] == "CAPABILITY_FIELD_FORBIDDEN"
    assert all(call.headers["authorization"] == "Bearer octop-secret" for call in calls)


@pytest.mark.asyncio
async def test_task_endpoints_bound_browser_capability_and_revoke_access(tmp_path):
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"ready": True, "protocolVersion": 1})

    app, verifier = _app_environment(tmp_path, handler)
    parent = verifier.issue_delegated(
        "huohua.workbench",
        protocol_version=1,
        box_id="box",
        user_id="user-7",
        space_id=None,
        scope=("workbench:read", "workbench:browser"),
        upstream_token="octop-secret",
    )
    headers = {"Authorization": f"Bearer {parent}"}
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://box") as client:
            created = await client.post(
                "/api/bridge/v1/services/huohua.workbench/tasks",
                headers=headers,
                json={"taskId": "browser-task", "ttlSeconds": 30, "scope": ["workbench:browser"]},
            )
            task_token = created.json()["access_token"]
            browser = await client.post(
                "/api/bridge/v1/capabilities/browser.env",
                headers={"Authorization": f"Bearer {task_token}"},
                json={"method": "GET"},
            )
            renewed = await client.post(
                "/api/bridge/v1/services/huohua.workbench/tasks/browser-task/renew",
                headers={"Authorization": f"Bearer {task_token}"},
                json={"ttlSeconds": 30},
            )
            revoked = await client.post(
                "/api/bridge/v1/services/huohua.workbench/tasks/browser-task/revoke",
                headers={"Authorization": f"Bearer {renewed.json()['access_token']}"},
                json={},
            )
            after_revoke = await client.post(
                "/api/bridge/v1/capabilities/browser.env",
                headers={"Authorization": f"Bearer {renewed.json()['access_token']}"},
                json={"method": "GET"},
            )
    assert created.status_code == 200
    assert browser.status_code == 200
    assert renewed.status_code == 200
    assert revoked.json() == {"taskId": "browser-task", "revoked": True}
    assert after_revoke.status_code == 401
    assert after_revoke.json()["code"] == "TASK_REVOKED"
