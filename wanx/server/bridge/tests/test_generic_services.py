"""A second service must work by configuration without inheriting Huohua authority."""

import copy
import json
import os
import time

import httpx
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from wanx_bridge import service_activation
from wanx_bridge import service_registry
from wanx_bridge.config import BridgeAuthError
from wanx_bridge.server import _allowed, create_app
from wanx_bridge.service_health import service_status
from wanx_bridge.service_registry import ServiceRegistry, ServiceRegistryError
from wanx_bridge.service_sessions import ServiceSessionVerifier, service_proof_signature

SERVICE = "example.notes"
PREFIX = f"/api/services/{SERVICE}/v1"


def configuration(tmp_path):
    key = Ed25519PrivateKey.generate()
    public = tmp_path / "notes.pub"
    public.write_bytes(key.public_key().public_bytes_raw())
    public.chmod(0o600)
    record = {
        "enabled": True, "upstream": "http://127.0.0.1:19093", "uid": 10007,
        "tokenAudience": "wanx-bridge", "protocolVersion": 1,
        "minWanxVersion": ">=1.0.0",
        "routes": [{"prefix": PREFIX, "methods": ["GET", "POST"], "sse": True}],
        "health": {"liveness": "/healthz", "readiness": "/readyz", "version": "/version"},
        "activation": {"mode": "legacy"}, "servicePublicKeyFile": str(public),
    }
    huohua = copy.deepcopy(record)
    huohua.update(upstream="http://127.0.0.1:8093")
    huohua["routes"][0]["prefix"] = "/api/huohua/v1"
    return {"schemaVersion": 1, "services": {SERVICE: record, "huohua.workbench": huohua}}, key


def test_second_service_roundtrip_and_scopes(tmp_path):
    raw, key = configuration(tmp_path)
    registry = ServiceRegistry.from_mapping(raw)
    assert ServiceRegistry.from_mapping(registry.as_dict()).as_dict() == registry.as_dict()
    record = registry.get(SERVICE)
    assert record.route_prefix == PREFIX
    assert record.allows("POST", PREFIX + "/notes")
    assert not record.allows("GET", "/api/huohua/v1/notes")
    verifier = ServiceSessionVerifier(registry, Ed25519PrivateKey.generate())
    issued = verifier.issue(SERVICE, protocol_version=1, nonce="n",
                            signature=service_proof_signature(key, SERVICE, 1, "n"))
    claims = verifier.verify(issued["access_token"], service_id=SERVICE)
    assert set(claims["scope"]) == {"service:read", "service:write"}
    with pytest.raises(BridgeAuthError):
        verifier.verify(issued["access_token"], service_id="huohua.workbench")
    with pytest.raises(BridgeAuthError, match="SERVICE_SCOPE_INVALID"):
        verifier.issue_delegated(SERVICE, protocol_version=1, box_id="box", user_id="7",
                                 space_id="personal", scope=["workbench:browser"])


@pytest.mark.parametrize("prefix", ["/api", "/api/agents", "/api/bridge/v1", "/api/huohua/v1",
                                    "/api/services/other/v1", PREFIX + "/../x", PREFIX + "/%2e"])
def test_service_cannot_claim_another_namespace(tmp_path, prefix):
    raw, _ = configuration(tmp_path)
    raw["services"][SERVICE]["routes"][0]["prefix"] = prefix
    with pytest.raises(ServiceRegistryError, match="SERVICE_REGISTRY_ROUTE_INVALID"):
        ServiceRegistry.from_mapping(raw)


@pytest.mark.parametrize("origin", ["http://localhost:19093", "http://192.168.0.78:19093",
                                    "http://127.0.0.1:0", "http://127.0.0.1:19093/foo",
                                    "http://user@127.0.0.1:19093"])
def test_generic_upstream_remains_explicit_loopback(tmp_path, origin):
    raw, _ = configuration(tmp_path)
    raw["services"][SERVICE]["upstream"] = origin
    with pytest.raises(ServiceRegistryError, match="SERVICE_REGISTRY_UPSTREAM_INVALID"):
        ServiceRegistry.from_mapping(raw)


async def test_generic_http_sse_and_authority_isolation(tmp_path):
    raw, _ = configuration(tmp_path)
    registry = ServiceRegistry.from_mapping(raw)
    verifier = ServiceSessionVerifier(registry, Ed25519PrivateKey.generate())
    seen = []

    def handler(request):
        if request.url.path in {"/healthz", "/readyz", "/version"}:
            return httpx.Response(200, json={"ready": True, "protocolVersion": 1, "version": "1.0.0"})
        seen.append(request)
        return httpx.Response(200, content=b"data: notes\n\n", headers={"content-type": "text/event-stream"})

    class Auth:
        def authorize(self, token):
            if token != "host-session":
                raise BridgeAuthError("AUTH_REQUIRED", 401)
            return type("Session", (), {"upstream_token": "octop-secret", "user": {"id": "7"},
                                       "expires_at": time.time() + 60,
                                       "upstream_expires_at": time.time() + 3600})()

        def assert_live(self, session):
            pass

    app = create_app(Auth(), object(), upstream_url="http://127.0.0.1:18088",
                     http_transport=httpx.MockTransport(handler), service_registry=registry,
                     service_session_verifier=verifier, build_metadata={"version": "1.0.0"})
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://box") as client:
            headers = {"Authorization": "Bearer host-session", "Cookie": "secret",
                       "x-wanx-user-id": "forged"}
            for path in (PREFIX, PREFIX + "/events", "/api/huohua/v1/events"):
                response = await client.get(path, headers=headers)
                assert response.status_code == 200, response.text
                assert response.text == "data: notes\n\n"
            assert [r.url.port for r in seen] == [19093, 19093, 8093]
            token = seen[0].headers["authorization"].removeprefix("Bearer ")
            claims = verifier.verify(token, service_id=SERVICE)
            assert claims["userId"] == "7" and claims["spaceId"] == "personal"
            assert set(claims["scope"]) == {"service:read", "service:write"}
            assert not any(k in seen[0].headers for k in ("cookie", "x-wanx-user-id"))
            assert "octop-secret" not in str(seen[0].headers)
            for path, body in (("/api/bridge/v1/capabilities/dialogue.models", {"method": "GET"}),
                               ("/api/bridge/v1/services/huohua.workbench/tasks", {})):
                denied = await client.post(path, headers={"Authorization": f"Bearer {token}"}, json=body)
                assert denied.status_code in {401, 403}
            before = len(seen)
            assert (await client.delete(PREFIX + "/notes", headers=headers)).status_code == 403
            assert (await client.get(PREFIX + "/%252e%252e/secrets", headers=headers)).status_code == 403
            assert (await client.get(PREFIX + "/notes")).status_code == 401
            assert (await client.get("/api/services/missing/v1/notes", headers=headers)).status_code in {403, 404}
            assert len(seen) == before


async def test_generic_activation_is_bound_to_registered_identity_and_profile(tmp_path, monkeypatch):
    from test_service_activation import activation

    raw, _ = configuration(tmp_path)
    path = tmp_path / "activation.json"
    profile = {"profileId": "notes-python", "profileVersion": 1, "profileDigest": "e" * 64}
    raw["services"][SERVICE]["activation"] = {
        "mode": "ota", "path": str(path), "profiles": [profile],
    }
    registry = ServiceRegistry.from_mapping(raw)
    monkeypatch.setattr(service_activation, "ROOT_UID", os.geteuid())
    monkeypatch.setattr(service_activation, "TRUST_BOUNDARY", tmp_path)
    committed = {**activation(), "serviceId": SERVICE, "profile": profile}
    running = {**committed, "protocolVersion": 1}

    def save(value):
        path.write_text(json.dumps(value))
        path.chmod(0o600)

    def handler(request):
        return httpx.Response(200, json=running if request.url.path == "/version" else {"ready": True})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        async def status():
            return await service_status(registry, SERVICE, client=client, wanx_version="1.0.0")

        assert (await status())["status"] == "not_installed"
        save({**committed, "state": "preparing"})
        assert (await status())["status"] == "starting"
        save(committed)
        assert (await status())["status"] == "ready"
        running["buildId"] = "other-build"
        assert (await status())["code"] == "SERVICE_ACTIVATION_MISMATCH"
        save({**committed, "serviceId": "huohua.workbench"})
        assert (await status())["code"] == "SERVICE_ACTIVATION_INVALID"
        save({**committed, "profile": {**profile, "profileDigest": "f" * 64}})
        assert (await status())["code"] == "SERVICE_ACTIVATION_INVALID"


def test_generic_ota_requires_installer_pinned_profile(tmp_path):
    raw, _ = configuration(tmp_path)
    raw["services"][SERVICE].pop("activation")
    with pytest.raises(ServiceRegistryError, match="SERVICE_REGISTRY_ACTIVATION_INVALID"):
        ServiceRegistry.from_mapping(raw)


def test_media_ota_projection_preserves_existing_services(tmp_path):
    raw, _ = configuration(tmp_path)
    registry = ServiceRegistry.from_mapping(raw)
    media = copy.deepcopy(raw["services"][SERVICE])
    media.update(
        upstream="http://127.0.0.1:19094",
        routes=[{"prefix": "/api/services/wanx.media/v1", "methods": ["GET", "POST"], "websocket": True}],
        activation={
            "mode": "ota",
            "path": str(service_registry.MEDIA_ACTIVATION),
            "profiles": [service_registry.MEDIA_PROFILE],
        },
    )
    overlay = tmp_path / "media-registry.json"

    def save(value):
        overlay.write_text(json.dumps({"schemaVersion": 1, "services": value}))
        overlay.chmod(0o600)

    save({"wanx.media": media})
    merged = registry.with_media_ota(overlay)
    assert merged.without_media().as_dict() == registry.as_dict()
    assert merged.get("wanx.media").allows(
        "GET", f"/api/services/wanx.media/v1/asr/sessions/{'a' * 32}/stream", websocket=True,
    )
    with pytest.raises(ServiceRegistryError, match="MEDIA_OTA_REGISTRY_INVALID"):
        merged.with_media_ota(overlay)
    save({"wanx.media": {**media, "activation": {"mode": "legacy"}}})
    with pytest.raises(ServiceRegistryError, match="MEDIA_OTA_REGISTRY_INVALID"):
        registry.with_media_ota(overlay)
    save({"wanx.media": media, SERVICE: raw["services"][SERVICE]})
    with pytest.raises(ServiceRegistryError, match="MEDIA_OTA_REGISTRY_INVALID"):
        registry.with_media_ota(overlay)


@pytest.mark.parametrize("path", [PREFIX, PREFIX + "/ws", "/api/services/missing/v1/ws", "/api/huohua/v1/ws"])
def test_service_websocket_never_falls_back_to_octop(path):
    assert not _allowed(path, "WEBSOCKET")


def test_wrong_installation_key_is_rejected_without_server_error(tmp_path):
    raw, _ = configuration(tmp_path)
    verifier = ServiceSessionVerifier(ServiceRegistry.from_mapping(raw), Ed25519PrivateKey.generate())
    signature = service_proof_signature(Ed25519PrivateKey.generate(), SERVICE, 1, "forged")
    with pytest.raises(BridgeAuthError, match="SERVICE_PROOF_INVALID"):
        verifier.issue(SERVICE, protocol_version=1, nonce="forged", signature=signature)
