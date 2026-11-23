"""The real legacy Bridge HTTP surface must preserve selected-warehouse grants."""
# ruff: noqa: F811 - imported pytest fixtures share test parameter names.

import asyncio
import json

import httpx
import pytest
from test_gateway import Auth
from test_semantica_desktop_contract import (
    AUTH,
    BASE,
    CONFIG,
    DesktopConfig,
    W,
    claims,
    desktop,  # noqa: F401 - shared real Bridge fixture
)

from wanx_bridge.semantica import desktop_routes
from wanx_bridge.semantica.desktop import resolve
from wanx_bridge.server import create_app


async def test_onboarding_trial_is_bound_to_the_signed_warehouse_and_draft(desktop):
    client, _, _, seen, reply, _ = desktop
    path = "/workbench/conversations/guide-a/onboarding/trial"
    body = {
        "operation_id": "try-guide",
        "_native_operation_id": "try-guide",
        "expected_revision": 1,
        "draft_digest": "a" * 64,
        "document_id": "document-a",
        "document_version_id": "version-a",
    }
    reply["value"] = {
        "conversation_id": "guide-a", "draft_digest": "a" * 64, "document_id": "document-a",
        "document_version_id": "version-a", "title": "合成资料", "source": {"id": "segment-a", "text": "合成原文"},
        "entities": [], "relations": [], "partial_results": False, "publication_performed": False,
    }
    response = await client.post(BASE + W + path, headers=AUTH, json=body)
    assert response.status_code == 200, response.text
    assert response.json() == reply["value"]
    assert seen[-1].url.path == "/api/integration" + path
    assert json.loads(seen[-1].content) == body
    assert claims(seen[-1])["operation_id"] == "try-guide"
    seen.clear()
    refused = await client.post(BASE + W + path, headers=AUTH, json={**body, "document_id": "branch/a"})
    assert refused.status_code == 422, refused.text
    assert not seen


@pytest.mark.parametrize(
    "method,path,body",
    [
        ("GET", "/settings/status", None),
        ("GET", "/ontologies", None),
        ("GET", "/ontology-suggestions/materials", None),
        ("GET", "/ontology-updates/rule-a?scope=selectable&offset=0", None),
        ("GET", "/ontology-updates/rule-a?scope=selectable", None),
        ("GET", "/documents?limit=20", None),
        ("GET", "/documents/doc-a/corrections/events", None),
        ("GET", "/knowledge-releases?limit=20", None),
        ("GET", "/search/source-details?kind=segments&document_id=doc-a", None),
        ("POST", "/ontologies", {"name": "Test", "schema": {}, "_native_operation_id": "create"}),
        ("POST", "/ontologies/rule-a/publish", {"_native_operation_id": "publish"}),
        (
            "POST",
            "/ontology-suggestions/generate",
            {
                "document_ids": ["doc-a"],
                "base_ontology_id": "rule-a",
                "schema": {},
                "_native_operation_id": "suggest",
            },
        ),
        (
            "POST",
            "/ontology-suggestions/draft",
            {
                "preview_ids": ["preview-a"],
                "name": "Draft",
                "schema": {},
                "operation_id": "draft",
                "_native_operation_id": "draft",
            },
        ),
    ],
)
async def test_workbench_is_signed_for_the_existing_user_and_selected_warehouse(
    desktop, method, path, body
):
    client, _, _, seen, _, _ = desktop
    response = await client.request(
        method,
        BASE + W + "/workbench" + path,
        json=body,
        headers={
            **AUTH,
            "cookie": "caller=private",
            "x-semantica-scope": "forged",
            "x-semantica-signature": "forged",
        },
    )
    assert response.status_code == 200
    assert len(seen) == 1
    outgoing = seen[0]
    assert outgoing.url.path == "/api/integration/workbench" + path.split("?")[0]
    assert "cookie" not in outgoing.headers
    grant = claims(outgoing)
    expected = DesktopConfig(**CONFIG).headers(7, "wanx", warehouse=W.split("/")[-1])
    expected_grant = claims(httpx.Request("GET", "http://synthetic", headers=expected))
    assert grant["workspace_id"] == expected_grant["workspace_id"]
    assert grant["workspace_bindings"] == expected_grant["workspace_bindings"]
    assert grant["actor_id"] == "wanx:7"
    assert grant["owner_view"] is False
    assert grant["permissions"] == (["read"] if method == "GET" else ["read", "write"])
    assert grant["operation_id"] == (body or {}).get("_native_operation_id")
    if body:
        assert json.loads(outgoing.content) == body
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize(
    "path,body",
    [
        (
            "/ontology-suggestions/generate",
            {
                "document_ids": ["doc-a"],
                "base_ontology_id": "rule-a",
                "schema": {},
                "_native_operation_id": "generate",
            },
        ),
        ("/ontology-suggestions/materials/doc-a/review", {"_native_operation_id": "review"}),
    ],
)
async def test_synchronous_workbench_models_get_the_existing_long_grant_budget(desktop, path, body):
    client, _, _, seen, _, _ = desktop
    response = await client.post(BASE + W + "/workbench" + path, json=body, headers=AUTH)
    assert response.status_code == 200
    assert resolve("POST", W + "/workbench" + path).timeout == 285
    assert seen[0].extensions["timeout"]["read"] == 285
    import time

    lifetime = claims(seen[0])["expires_at"] - time.time()
    assert 290 < lifetime <= 300


async def test_team_workbench_body_timeout_uses_the_existing_504(desktop, monkeypatch):
    client, _, _, seen, _, _ = desktop

    async def timed_out(*args):
        raise TimeoutError()

    monkeypatch.setattr(desktop_routes, "bounded_body", timed_out)
    response = await client.get(
        BASE + W + "/workbench/ontologies", headers={**AUTH, "x-wanx-data-context": "team"}
    )
    assert response.status_code == 504
    assert response.json()["code"] == "SEMANTICA_SERVICE_TIMEOUT"
    assert response.headers["cache-control"] == "no-store"
    assert seen == []


@pytest.mark.parametrize(
    "method,path,body,status",
    [
        ("GET", "/workbench/ontologies", None, 404),
        ("GET", "/open/v1/workbench/ontologies", None, 404),
        ("GET", W + "/workbench/settings/llm", None, 404),
        ("GET", W + "/workbench/providers", None, 404),
        ("GET", W + "/workbench/unknown", None, 404),
        ("GET", W + "/workbench/documents/doc-a/original", None, 404),
        ("PUT", W + "/workbench/settings/status", {"_native_operation_id": "op"}, 405),
        ("DELETE", W + "/workbench/ontologies/rule-a", {}, 404),
        ("GET", W + "/workbench/ontologies?workspace_id=foreign", None, 422),
        ("GET", W + "/workbench/ontologies?owner_view=true", None, 422),
        ("GET", W + "/workbench/ontologies?limit=1&limit=2", None, 422),
        ("GET", W + "/workbench/ontology-updates/rule-a?scope=foreign", None, 422),
        ("GET", W + "/workbench/ontology-updates/rule-a?scope=all", None, 422),
        ("GET", W + "/workbench/ontology-updates/rule-a?scope=selectable&limit=20", None, 422),
        ("GET", W + "/workbench/jobs?limit=201", None, 422),
        ("GET", W + "/workbench/documents?limit=501", None, 422),
        ("POST", W + "/workbench/ontologies", {"name": "Test", "schema": {}}, 422),
        ("POST", W + "/workbench/ontologies", {"_native_operation_id": "bad operation"}, 422),
        (
            "POST",
            W + "/workbench/ontologies",
            {"_native_operation_id": "op", "workspace_id": "foreign"},
            403,
        ),
        (
            "POST",
            W + "/workbench/ontologies",
            {"_native_operation_id": "op", "workspace_ids": ["foreign"]},
            403,
        ),
        (
            "POST",
            W + "/workbench/ontologies",
            {"_native_operation_id": "op", "owner_view": True},
            403,
        ),
        (
            "POST",
            W + "/workbench/ontology-suggestions/draft",
            {"_native_operation_id": "op", "operation_id": "other"},
            422,
        ),
    ],
)
async def test_workbench_rejects_unscoped_global_or_forged_operations_before_upstream(
    desktop, method, path, body, status
):
    client, _, _, seen, _, _ = desktop
    response = await client.request(method, BASE + path, json=body, headers=AUTH)
    assert response.status_code == status
    assert seen == []


@pytest.mark.parametrize("context", ["personal", "team"])
async def test_workbench_rejects_browser_origin_and_requires_current_user_permission(
    desktop, context
):
    client, _, profile, seen, _, _ = desktop
    response = await client.get(
        BASE + W + "/workbench/ontologies",
        headers={**AUTH, "origin": "http://bridge", "x-wanx-data-context": context},
    )
    assert response.status_code == 403
    assert seen == []
    profile["permissions"] = []
    response = await client.get(BASE + W + "/workbench/ontologies", headers=AUTH)
    assert response.status_code == 403
    assert seen == []


@pytest.mark.parametrize("context", ["personal", "team"])
async def test_workbench_body_limit_is_enforced_before_any_service_request(desktop, context):
    client, _, _, seen, _, _ = desktop
    response = await client.post(
        BASE + W + "/workbench/ontologies",
        headers={**AUTH, "x-wanx-data-context": context},
        json={"_native_operation_id": "op", "name": "x" * (1024 * 1024 + 65536)},
    )
    assert response.status_code == 413
    assert seen == []


@pytest.mark.parametrize("status", [200, 403])
async def test_team_workbench_retains_core_authority_after_bounded_validation(tmp_path, status):
    seen = []
    body = {"name": "Scoped draft", "schema": {}, "_native_operation_id": "create"}

    async def handler(request):
        seen.append(request)
        assert request.url == "http://127.0.0.1:18088" + BASE + W + "/workbench/ontologies"
        assert request.headers["authorization"] == "Bearer private.upstream.jwt"
        assert request.headers["x-wanx-data-context"] == "team"
        assert "cookie" not in request.headers
        assert "x-semantica-scope" not in request.headers
        assert json.loads(await request.aread()) == body
        return httpx.Response(
            status,
            stream=httpx.ByteStream(b'{"items":[]}'),
            headers={"content-type": "application/json"},
        )

    app = create_app(
        Auth(), object(), http_transport=httpx.MockTransport(handler), dashboard_dir=tmp_path
    )
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://bridge"
        ) as client:
            response = await client.post(
                BASE + W + "/workbench/ontologies",
                json=body,
                headers={**AUTH, "x-wanx-data-context": "team", "x-semantica-scope": "forged"},
            )
    assert response.status_code == status
    assert len(seen) == 1


async def test_workbench_ontology_schema_does_not_select_request_authority(desktop):
    client, _, _, seen, _, _ = desktop
    body = {
        "name": "Business schema",
        "schema": {"example": {"workspace_ids": ["business-field"], "actor_id": "example"}},
        "_native_operation_id": "create",
    }
    response = await client.post(BASE + W + "/workbench/ontologies", json=body, headers=AUTH)
    assert response.status_code == 200
    assert json.loads(seen[0].content) == body
    assert claims(seen[0])["actor_id"] == "wanx:7"
    assert claims(seen[0])["workspace_id"] != "business-field"


async def test_workbench_preserves_service_cross_warehouse_denial(desktop):
    client, _, _, seen, reply, _ = desktop
    reply.update(status=404, value={"detail": "resource does not belong to selected warehouse"})
    response = await client.get(BASE + W + "/workbench/documents/foreign-document", headers=AUTH)
    assert response.status_code == 404
    assert response.json()["code"] == "SEMANTICA_RESOURCE_NOT_FOUND"
    assert len(seen) == 1
    assert claims(seen[0])["permissions"] == ["read"]
    assert "foreign-document" not in json.dumps(claims(seen[0]))


async def test_workbench_does_not_deliver_a_response_after_session_revocation(desktop):
    client, auth, _, seen, reply, _ = desktop
    started, release = asyncio.Event(), asyncio.Event()

    async def delayed(request):
        started.set()
        await release.wait()
        return httpx.Response(200, json={"items": ["must-not-deliver"]})

    reply["handler"] = delayed
    pending = asyncio.create_task(client.get(BASE + W + "/workbench/ontologies", headers=AUTH))
    await asyncio.wait_for(started.wait(), 2)
    auth.deadline = 0
    release.set()
    response = await asyncio.wait_for(pending, 2)
    assert response.status_code == 401
    assert "must-not-deliver" not in response.text
    assert len(seen) == 1
