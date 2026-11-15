"""Finite MCP contracts, safe failures, authenticated public address discovery."""

# ruff: noqa: F811
import json
from contextlib import contextmanager
from types import SimpleNamespace

import httpx
import pytest
from test_semantica_desktop_contract import AUTH, BASE, desktop  # noqa: F401
from test_semantica_host_modeling import env  # noqa: F401

from wanx_bridge.semantica import mcp
from wanx_bridge.semantica.client import SemanticaError
from wanx_bridge.semantica.mcp_reasoning_contract import OPERATIONS, validate_payload

ARGS = {
    "discover": {},
    "prepare": {"skill_id": "native-check", "idempotency_key": "prepare"},
    "reference": {
        "preparation_id": "prep",
        "skill_id": "native-check",
        "reference_id": "package-entry",
    },
    "scope": {"preparation_id": "prep"},
    "search": {"preparation_id": "prep", "query": "check"},
    "evidence": {"preparation_id": "prep", "evidence_id": "evidence"},
    "read-document": {"preparation_id": "prep", "document_id": "document"},
    "coverage": {"preparation_id": "prep"},
}


@pytest.mark.parametrize("operation", OPERATIONS)
@pytest.mark.parametrize(
    "field", ["workspace_id", "warehouse_id", "principal", "delivery_mode", "actor_id"]
)
def test_arguments_cannot_override_authority(operation, field):
    with pytest.raises(ValueError):
        validate_payload(
            "/reasoning/" + operation, {"arguments": {**ARGS[operation], field: "other"}}, None
        )


@pytest.mark.parametrize("operation", OPERATIONS)
async def test_fixed_post_payload_and_maintenance_guard(tmp_path, monkeypatch, operation):
    (tmp_path / "semantica.json").write_text(json.dumps({"service_url": "http://127.0.0.1:8090"}))
    server = SimpleNamespace(paths=SimpleNamespace(root=tmp_path))
    calls, guards = [], []

    async def upstream(request):
        calls.append(request)
        assert request.method == "POST"
        assert request.url.path == "/api/open/v1/reasoning/" + operation
        assert request.headers["Authorization"] == "Bearer xg_" + "a" * 40
        payload = json.loads(request.content)
        assert payload == validate_payload(
            "/reasoning/" + operation, {"arguments": ARGS[operation]}, None
        )
        return httpx.Response(200, json={"safe": True})

    real = httpx.AsyncClient
    monkeypatch.setattr(
        mcp,
        "httpx",
        SimpleNamespace(
            AsyncClient=lambda **kw: real(transport=httpx.MockTransport(upstream), **kw)
        ),
    )

    @contextmanager
    def guard(root, method, path):
        guards.append((root, method, path))
        yield

    monkeypatch.setattr(mcp, "request_guard", guard)
    assert await mcp.public_read(
        server, "xg_" + "a" * 40, "/reasoning/" + operation, payload={"arguments": ARGS[operation]}
    ) == {"safe": True}
    assert len(calls) == 1
    assert guards == [(tmp_path, "POST", "/api/open/v1/reasoning/" + operation)]


@pytest.mark.parametrize(
    "path",
    [
        "/reasoning/delete",
        "/reasoning/../documents",
        "/integration/skills",
        "/reasoning/discover/extra",
    ],
)
async def test_unknown_paths_fail_before_configuration_or_network(path):
    with pytest.raises(SemanticaError) as error:
        await mcp._public_read(None, "xg_" + "a" * 40, path, payload={"arguments": {}})
    assert error.value.code == "SEMANTICA_INVALID_REQUEST"


def test_error_text_is_never_accepted_as_a_public_code():
    assert (
        mcp.safe_error(SemanticaError("REASONING_SCOPE_CHANGED", 409, "PRIVATE REQUEST BODY"))
        == "REASONING_SCOPE_CHANGED"
    )
    assert (
        mcp.safe_error(SemanticaError("REASONING_SECRET_TOKEN_ABC", 500)) == "STARLINK_UNAVAILABLE"
    )
    assert mcp.safe_error(RuntimeError("Authorization: Bearer PRIVATE")) == "STARLINK_UNAVAILABLE"


async def test_desktop_connection_info_requires_identity_and_public_https(desktop):
    client, auth, profile, seen, reply, app = desktop
    path = "https://bridge.example.com" + BASE + "/mcp/connection-info"
    result = await client.get(path, headers=AUTH)
    assert result.status_code == 200, result.text
    assert result.json() == {"url": "https://bridge.example.com/mcp/starlink"}
    assert result.headers["cache-control"] == "no-store"
    assert seen == []  # Never proxy the discovery route to owner/management APIs.
    assert (await client.get(path)).status_code == 401
    profile["permissions"] = []
    assert (await client.get(path, headers=AUTH)).status_code == 403


@pytest.mark.parametrize(
    "origin",
    [
        "http://bridge.example.com",
        "https://localhost",
        "https://192.168.0.1",
        "https://127.0.0.1",
        "https://bridge.local",
    ],
)
async def test_desktop_never_advertises_internal_or_forged_forwarded_address(desktop, origin):
    client, *_ = desktop
    result = await client.get(
        origin + BASE + "/mcp/connection-info",
        headers={**AUTH, "X-Forwarded-Proto": "https", "X-Forwarded-Host": "attacker.example.com"},
    )
    assert result.status_code == 503
    assert result.json()["code"] == "MCP_PUBLIC_URL_UNAVAILABLE"


async def test_native_host_registers_discovery_before_catchall_and_checks_permissions(env):
    state, client, app = env
    path = "https://bridge.example.com/api/semantica/mcp/connection-info"
    result = await client.get(path)
    assert result.status_code == 200, result.text
    assert result.json() == {"url": "https://bridge.example.com/mcp/starlink"}
    assert result.headers["cache-control"] == "no-store"
    assert state.calls == []
    assert (await client.get(path, headers={"Authorization": "Bearer wrong"})).status_code == 401
    state.allowed = False
    assert (await client.get(path)).status_code == 403


@pytest.mark.parametrize("query", ["?warehouse_id=other", "?token=private"])
async def test_discovery_rejects_caller_overrides(desktop, query):
    client, *_ = desktop
    response = await client.get(
        "https://bridge.example.com" + BASE + "/mcp/connection-info" + query, headers=AUTH
    )
    assert response.status_code == (401 if query.startswith("?token=") else 422)
    assert "private" not in response.text
