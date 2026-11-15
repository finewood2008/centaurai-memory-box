"""Local native identity with real Bridge routing; Octop never gets business traffic."""

import asyncio
import base64
import json

import httpx
import pytest
from wanx_bridge.semantica import local_server

W = "10000000-0000-4000-8000-000000000001"
BASE = "/api/semantica"
AUTH = {"authorization": "Bearer native-token"}
SCHEMA = {"entity_types": [], "relation_types": []}


@pytest.fixture
async def bridge(tmp_path, monkeypatch):
    monkeypatch.setattr(local_server, "load_required_policy", lambda: None)
    config = tmp_path / "semantica.json"
    config.write_text(
        json.dumps(
            {
                "service_url": "http://127.0.0.1:8090",
                "service_token": "a" * 64,
                "box_id": "same-box",
                "application_id": "semantica",
            }
        )
    )
    seen = []
    state = {
        "profile": {
            "id": 7,
            "username": "developer",
            "application_id": "wanx",
            "role": "user",
            "permissions": ["knowledge_bases"],
        },
        "identity_status": 200,
        "after_business": None,
        "hold": False,
        "entered": asyncio.Event(),
        "cancelled": asyncio.Event(),
    }

    async def handler(request):
        seen.append(request)
        if request.url.port == 18088:
            assert request.url.path == "/api/auth/me", "Business request reached Octop"
            assert request.headers["authorization"] == "Bearer native-token"
            assert "cookie" not in request.headers
            return httpx.Response(state["identity_status"], json=state["profile"])
        assert request.url.port == 8090
        assert request.headers.get("authorization") == "Bearer " + "a" * 64
        assert "cookie" not in request.headers
        if state["after_business"]:
            state["after_business"]()
        state["entered"].set()
        if state["hold"]:
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                state["cancelled"].set()
                raise
        return httpx.Response(200, json={"received": True})

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler), follow_redirects=False
    ) as upstream:
        app = local_server.create_app(
            config_file=config, octop_url="http://127.0.0.1:18088", client=upstream
        )
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8088"
        ) as client:
            yield client, seen, state, app


@pytest.mark.parametrize(
    "method,path,body",
    [
        ("GET", "/modeling/onboarding", None),
        (
            "POST",
            "/modeling/onboarding",
            {
                "operation_id": "save",
                "expected_revision": 0,
                "answers": {"industry": "制造业"},
            },
        ),
        ("GET", "/modeling/warehouses", None),
        (
            "POST",
            "/modeling/onboarding/onboarding/warehouse",
            {"operation_id": "create", "expected_revision": 1, "name": "合同知识仓"},
        ),
        ("GET", f"/warehouses/{W}/modeling/suggestion-context", None),
        (
            "POST",
            f"/warehouses/{W}/modeling/answer-confirmations",
            {
                "operation_id": "confirm",
                "expected_revision": 1,
                "onboarding_revision": 1,
                "expected_confirmation_id": None,
                "answers": {"industry": "制造业"},
            },
        ),
        (
            "POST",
            f"/warehouses/{W}/modeling/answer-suggestions",
            {
                "operation_id": "generate",
                "confirmation_id": "confirmation",
                "base_ontology_id": "base",
            },
        ),
        ("GET", f"/warehouses/{W}/modeling/answer-suggestions/proposal", None),
        ("GET", f"/warehouses/{W}/modeling/answer-suggestions/proposal/rules", None),
        (
            "POST",
            f"/warehouses/{W}/modeling/rule-previews",
            {
                "operation_id": "prepare",
                "proposal_id": "proposal",
                "name": "合同本体",
                "schema": SCHEMA,
                "decisions": [],
            },
        ),
        (
            "POST",
            f"/warehouses/{W}/modeling/rule-previews/preview/publish",
            {"operation_id": "publish", "schema_digest": "a" * 64, "confirmed": True},
        ),
        ("GET", f"/warehouses/{W}/workbench/ontologies", None),
        ("GET", f"/warehouses/{W}/documents?limit=100&offset=0", None),
        (
            "DELETE",
            f"/warehouses/{W}/documents/document",
            {"operation_id": "20000000-0000-4000-8000-000000000002"},
        ),
    ],
)
async def test_routes_go_direct_to_semantica(bridge, method, path, body):
    client, seen, _, _ = bridge
    response = await client.request(
        method,
        BASE + path,
        headers={
            **AUTH,
            "x-semantica-scope": "forged",
            "x-semantica-signature": "forged",
            "cookie": "secret=ignored",
        },
        json=body,
    )
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    business = [r for r in seen if r.url.port == 8090]
    assert len(business) == 1
    request = business[0]
    scope = request.headers["x-semantica-scope"]
    claims = json.loads(base64.urlsafe_b64decode(scope + "=" * (-len(scope) % 4)))
    assert claims["actor_id"] == "wanx:7"
    assert claims["box_id"] == "same-box"
    assert claims["operation_id"] == (body or {}).get("operation_id")
    assert (json.loads(request.content) if body else None) == body
    if "/warehouses/" in path and "/modeling/" in path:
        suffix = path.split("/modeling", 1)[1]
        assert (
            request.url.path
            == "/api/integration/modeling/warehouses/" + claims["workspace_id"] + suffix
        )


async def test_health_and_openapi_identify_complete_direct_transport(bridge):
    client, seen, _, app = bridge
    response = await client.get("/api/bridge/health")
    assert response.json() == {
        "service": "wanx-semantica-bridge",
        "protocol": 1,
        "transport": "semantica-direct",
        "box_id": "same-box",
    }
    assert not seen
    assert (
        BASE + "/warehouses/{warehouse_id}/modeling/rule-previews/{preview_id}/publish"
        in app.openapi()["paths"]
    )


@pytest.mark.parametrize(
    "path,body",
    [
        (
            "/documents/document",
            {"operation_id": "20000000-0000-4000-8000-000000000002"},
        ),
        (
            f"/warehouses/{W}/jobs/job",
            {"operation_id": "20000000-0000-4000-8000-000000000002"},
        ),
        (f"/warehouses/{W}/documents/document", {"operation_id": "short"}),
        (
            f"/warehouses/{W}/documents/document",
            {
                "operation_id": "20000000-0000-4000-8000-000000000002",
                "workspace_id": "other",
            },
        ),
        (
            f"/warehouses/{W}/documents/document?confirm=true",
            {"operation_id": "20000000-0000-4000-8000-000000000002"},
        ),
    ],
)
async def test_delete_remains_scoped_and_requires_unchanged_operation_body(bridge, path, body):
    client, seen, _, _ = bridge
    response = (
        await client.delete(BASE + path, headers=AUTH)
        if body is None
        else await client.request("DELETE", BASE + path, headers=AUTH, json=body)
    )
    assert response.status_code in {405, 422}
    assert not any(r.url.port == 8090 for r in seen)


@pytest.mark.parametrize(
    "headers,query,status",
    [
        ({}, "", 401),
        ({**AUTH, "origin": "http://evil.invalid"}, "", 403),
        ({**AUTH, "x-wanx-data-context": "team"}, "", 403),
        (AUTH, "?access_token=token", 403),
    ],
)
async def test_invalid_admission_never_reaches_upstream(bridge, headers, query, status):
    client, seen, _, _ = bridge
    response = await client.get(BASE + "/warehouses" + query, headers=headers)
    assert response.status_code == status
    assert not seen


@pytest.mark.parametrize("mode", ["expired", "permission", "identity", "application"])
async def test_authority_is_native_identity_not_caller_headers(bridge, mode):
    client, seen, state, _ = bridge
    if mode == "expired":
        state["identity_status"] = 401
    elif mode == "permission":
        state["profile"]["permissions"] = []
    elif mode == "identity":
        state["profile"]["id"] = "7"
    else:
        state["profile"]["application_id"] = "unauthorized"
    response = await client.get(BASE + "/warehouses", headers=AUTH)
    assert response.status_code in {401, 403}
    assert not any(r.url.port == 8090 for r in seen)


async def test_revoked_permission_cancels_inflight_model_wait(bridge):
    client, _, state, _ = bridge
    state["hold"] = True
    task = asyncio.create_task(client.get(BASE + "/warehouses", headers=AUTH))
    await asyncio.wait_for(state["entered"].wait(), 2)
    state["profile"]["permissions"] = []
    response = await asyncio.wait_for(task, 3)
    assert response.status_code == 403
    assert state["cancelled"].is_set()


async def test_no_stale_result_after_identity_changes(bridge):
    client, _, state, _ = bridge
    state["after_business"] = lambda: state["profile"].update(id=8)
    response = await client.get(BASE + "/warehouses", headers=AUTH)
    assert response.status_code == 403


async def test_required_gate_is_not_downgraded(bridge, monkeypatch):
    client, seen, _, _ = bridge
    monkeypatch.setattr(local_server, "load_required_policy", lambda: {"required": True})
    response = await client.get(BASE + "/warehouses", headers=AUTH)
    assert response.status_code == 503
    assert response.json()["code"] == "LOCAL_DATA_REQUIRED"
    assert not seen


async def test_remote_peer_cannot_use_local_entry(bridge):
    _, seen, _, app = bridge
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, client=("192.0.2.1", 1234)),
        base_url="http://127.0.0.1:8088",
    ) as remote:
        response = await remote.get(BASE + "/warehouses", headers=AUTH)
    assert response.status_code == 403
    assert not seen


@pytest.mark.parametrize(
    "url",
    [
        "http://localhost:18088",
        "http://127.0.0.1:18088/api",
        "http://user@127.0.0.1:18088",
        "http://127.0.0.1:18088/?token=x",
        "https://127.0.0.1:18088",
    ],
)
def test_only_literal_loopback_upstreams(url):
    with pytest.raises(ValueError):
        local_server.loopback_origin(url)
