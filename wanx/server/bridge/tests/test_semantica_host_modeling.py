"""Native Host onboarding contract; real auth dependencies, synthetic owner HTTP."""

import asyncio
import base64
import json
from types import SimpleNamespace

import httpx
import pytest
from fastapi import Depends, FastAPI, Header, HTTPException, Request

from wanx_bridge.semantica import host_modeling, host_routes

WAREHOUSE = "11111111-1111-4111-8111-111111111111"


@pytest.fixture
async def env(tmp_path, monkeypatch):
    (tmp_path / "semantica.json").write_text(
        json.dumps(
            {
                "box_id": "local-test",
                "application_id": "semantica",
                "service_url": "http://127.0.0.1:8090",
                "service_token": "synthetic" * 8,
            }
        )
    )
    state = SimpleNamespace(
        user_id=7,
        allowed=True,
        calls=[],
        gate=None,
        slow=False,
        cancelled=False,
        response_status=200,
        response={"status": "succeeded", "valid": True},
    )

    async def current(request: Request, authorization: str | None = Header(None), **kwargs):
        if authorization != "Bearer synthetic-native":
            raise HTTPException(401)
        return SimpleNamespace(id=state.user_id, role="admin", application_id="wanx")

    # Avoid **kwargs becoming a required FastAPI query parameter.
    async def dependency(request: Request, authorization: str | None = Header(None)):
        return await current(request, authorization)

    def permission(key):
        assert key == "knowledge_bases"

        async def check(user=Depends(dependency)):
            if not state.allowed:
                raise HTTPException(403)
            return user

        return check

    async def owner(request):
        encoded = request.headers["x-semantica-scope"]
        claims = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
        state.calls.append((request, claims))
        if state.slow:
            try:
                await asyncio.sleep(5)
            except asyncio.CancelledError:
                state.cancelled = True
                raise
        return httpx.Response(state.response_status, json=state.response)

    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        host_modeling,
        "httpx",
        SimpleNamespace(
            AsyncClient=lambda **kwargs: real_client(
                transport=httpx.MockTransport(owner), **kwargs
            ),
        ),
    )
    monkeypatch.setattr(host_modeling, "load_required_policy", lambda: state.gate)
    router, _ = host_routes.create_host_routers(
        current_user=current,
        get_server=lambda: SimpleNamespace(
            services=SimpleNamespace(paths=SimpleNamespace(root=tmp_path))
        ),
        require_permission=permission,
        application_id=lambda user: user.application_id,
        model_host=SimpleNamespace(),
    )
    app = FastAPI()
    app.include_router(router, prefix="/api")
    async with real_client(
        transport=httpx.ASGITransport(app=app),
        base_url="http://local",
        headers={"authorization": "Bearer synthetic-native"},
    ) as client:
        yield state, client, app


@pytest.mark.parametrize(
    "method,path,body",
    [
        ("GET", "/modeling/onboarding", None),
        (
            "POST",
            "/modeling/onboarding",
            {"operation_id": "save-1", "expected_revision": 0, "answers": {"industry": "test"}},
        ),
        ("GET", "/modeling/warehouses", None),
        (
            "POST",
            "/modeling/onboarding/draft-1/warehouse",
            {"operation_id": "create-1", "expected_revision": 1, "name": "test"},
        ),
        ("GET", f"/warehouses/{WAREHOUSE}/modeling/suggestion-context", None),
        (
            "POST",
            f"/warehouses/{WAREHOUSE}/modeling/answer-confirmations",
            {
                "operation_id": "confirm-1",
                "expected_revision": 1,
                "onboarding_revision": 1,
                "answers": {"purpose": "test"},
            },
        ),
        (
            "POST",
            f"/warehouses/{WAREHOUSE}/modeling/answer-suggestions",
            {
                "operation_id": "generate-1",
                "confirmation_id": "confirmation-1",
                "base_ontology_id": "ontology-1",
            },
        ),
        ("GET", f"/warehouses/{WAREHOUSE}/modeling/answer-suggestions/result-1", None),
    ],
)
async def test_eight_routes_preserve_body_and_derive_scope(env, method, path, body):
    state, client, app = env
    response = await client.request(method, "/api/semantica" + path, json=body)
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    request, claims = state.calls[-1]
    assert claims["actor_id"] == "wanx:7"
    assert claims["operation_id"] == (body or {}).get("operation_id")
    assert json.loads(request.content) == body if body else not request.content
    if path.startswith("/warehouses/"):
        assert (
            request.url.path
            == "/api/integration/modeling/warehouses/"
            + claims["workspace_id"]
            + path.split("/modeling", 1)[1]
        )
        assert claims["workspace_id"] != WAREHOUSE
    else:
        assert request.url.path == "/api/integration" + path
    assert request.headers["authorization"] != "Bearer synthetic-native"
    if path.endswith("/answer-suggestions"):
        assert request.extensions["timeout"]["read"] == 285
    assert "/api/semantica/modeling/onboarding" in app.openapi()["paths"]


async def test_permissions_and_required_gate_are_not_bypassed(env):
    state, client, _ = env
    state.allowed = False
    assert (await client.get("/api/semantica/modeling/onboarding")).status_code == 403
    state.allowed = True
    assert (
        await client.get("/api/semantica/modeling/onboarding", headers={"authorization": "bad"})
    ).status_code == 401
    state.gate = object()
    result = await client.get("/api/semantica/modeling/onboarding")
    assert result.json()["code"] == "LOCAL_DATA_REQUIRED"
    assert not state.calls


@pytest.mark.parametrize(
    "headers,query,body,status",
    [
        (
            {"origin": "http://localhost"},
            "",
            {"operation_id": "x", "expected_revision": 0, "answers": {}},
            403,
        ),
        (
            {"x-wanx-data-context": "team"},
            "",
            {"operation_id": "x", "expected_revision": 0, "answers": {}},
            403,
        ),
        (
            {},
            "?workspace_id=other",
            {"operation_id": "x", "expected_revision": 0, "answers": {}},
            422,
        ),
        (
            {},
            "",
            {"operation_id": "x", "expected_revision": 0, "answers": {"workspace_id": "other"}},
            403,
        ),
        ({}, "", {"expected_revision": 0, "answers": {}}, 422),
    ],
)
async def test_invalid_inputs_never_reach_owner(env, headers, query, body, status):
    state, client, _ = env
    response = await client.post(
        "/api/semantica/modeling/onboarding" + query, json=body, headers=headers
    )
    assert response.status_code == status, response.text
    assert not state.calls


async def test_replay_and_conflict_keep_operation_and_safe_error(env):
    state, client, _ = env
    body = {"operation_id": "same-intent", "expected_revision": 1, "name": "test"}
    path = "/api/semantica/modeling/onboarding/draft-1/warehouse"
    for _ in range(2):
        assert (await client.post(path, json=body)).status_code == 200
    assert state.calls[0][0].content == state.calls[1][0].content
    state.response_status = 409
    state.response = {"code": "MODELING_REVISION_CHANGED", "message": "private diagnostic"}
    result = await client.post(path, json=body)
    assert result.status_code == 409
    assert result.json() == {"code": "MODELING_REVISION_CHANGED", "message": None}


async def test_accounts_get_different_owner_scope(env):
    state, client, _ = env
    await client.get("/api/semantica/modeling/onboarding")
    state.user_id = 8
    await client.get("/api/semantica/modeling/onboarding")
    assert state.calls[0][1]["workspace_id"] != state.calls[1][1]["workspace_id"]


async def test_revocation_cancels_pending_owner_request(env):
    state, client, _ = env
    state.slow = True
    pending = asyncio.create_task(client.get("/api/semantica/modeling/onboarding"))
    for _ in range(100):
        if state.calls:
            break
        await asyncio.sleep(0.01)
    state.allowed = False
    result = await asyncio.wait_for(pending, 3)
    assert result.status_code == 403
    assert state.cancelled


async def test_non_loopback_and_oversized_body_are_rejected(env):
    state, client, _ = env
    result = await client.post(
        "/api/semantica/modeling/onboarding",
        content=b"x" * (128 * 1024 + 1),
        headers={"content-type": "application/json"},
    )
    assert result.status_code == 413
    client._transport.client = ("192.0.2.10", 1234)
    result = await client.get("/api/semantica/modeling/onboarding")
    assert result.status_code == 403
    assert not state.calls


async def test_forged_headers_do_not_select_identity(env):
    state, client, _ = env
    result = await client.get(
        "/api/semantica/modeling/onboarding",
        headers={"x-semantica-scope": "forged", "x-semantica-signature": "forged"},
    )
    assert result.status_code == 200
    assert state.calls[-1][1]["actor_id"] == "wanx:7"


async def test_malformed_json_and_get_body_do_not_reach_owner(env):
    state, client, _ = env
    for method, raw in [("POST", '{"operation_id":"a","operation_id":"b"}'), ("GET", "{}")]:
        result = await client.request(
            method,
            "/api/semantica/modeling/onboarding",
            content=raw,
            headers={"content-type": "application/json"},
        )
        assert result.status_code == 422
    assert not state.calls
