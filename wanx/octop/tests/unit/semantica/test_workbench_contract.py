"""Exercise the existing core transport with the native owner's finite requests."""

import base64
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from centuarai_local_data_gate import starlink_workbench
from starlette.requests import Request
from wanx_bridge.semantica import client as module
from wanx_bridge.semantica.client import SemanticaClient, SemanticaError

WAREHOUSE = "10000000-0000-4000-8000-000000000001"
PREFIX = f"/warehouses/{WAREHOUSE}/workbench"
CONFIG = {
    "service_url": "http://127.0.0.1:8090",
    "service_token": "s" * 48,
    "box_id": "test-box",
    "application_id": "semantica",
}
CREATE = {"name": "Test", "schema": {}, "_native_operation_id": "create-a"}
CASES = [
    ("GET", "/settings/status", None, {}),
    ("GET", "/jobs", None, {"limit": "10", "offset": "0"}),
    ("GET", "/documents", None, {"limit": "500", "offset": "0"}),
    ("GET", "/documents/doc-a", None, {"segment_offset": "0", "segment_limit": "200"}),
    ("GET", "/ontologies", None, {}),
    ("POST", "/ontologies", CREATE, {}),
    ("POST", "/ontologies/rule-a/publish", {"_native_operation_id": "publish-a"}, {}),
    ("GET", "/ontology-updates/rule-a", None, {"scope": "selectable", "offset": "0"}),
]


@pytest.fixture
def outgoing(monkeypatch):
    seen = []

    class Client:
        def __init__(self, **_):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            pass

        async def request(self, method, url, **kwargs):
            seen.append((method, url, kwargs))
            return httpx.Response(200, json={"items": []})

    monkeypatch.setattr(module.httpx, "AsyncClient", Client)
    return seen


@pytest.mark.asyncio
@pytest.mark.parametrize("version", [None, WAREHOUSE])
async def test_delete_document_preserves_expected_version(outgoing, version):
    client = SemanticaClient(CONFIG, 7)
    payload = {"operation_id": WAREHOUSE, "expected_version_id": version}
    await client.request("DELETE", f"/warehouses/{WAREHOUSE}/documents/doc-a", payload=payload)
    assert outgoing[0][0] == "DELETE"
    assert outgoing[0][1].endswith("/api/integration/documents/doc-a")
    assert outgoing[0][2]["json"] == payload


@pytest.mark.asyncio
@pytest.mark.parametrize("extra", [{"expected_version_id": "../other"}, {"workspace_id": "other"}])
async def test_delete_document_rejects_invalid_version_or_scope(outgoing, extra):
    with pytest.raises(SemanticaError, match="SEMANTICA_INVALID_REQUEST"):
        await SemanticaClient(CONFIG, 7).request(
            "DELETE", f"/warehouses/{WAREHOUSE}/documents/doc-a",
            payload={"operation_id": WAREHOUSE, **extra},
        )
    assert not outgoing


@pytest.mark.asyncio
@pytest.mark.parametrize("method,path,body,query", CASES)
async def test_core_workbench_binds_existing_owner_and_operation(
    outgoing, method, path, body, query
):
    client = SemanticaClient(CONFIG, 7)
    assert await client.request(method, PREFIX + path, payload=body, query=query) == {"items": []}
    assert len(outgoing) == 1
    actual_method, url, options = outgoing[0]
    assert (actual_method, url) == (
        method,
        CONFIG["service_url"] + "/api/integration/workbench" + path,
    )
    encoded = options["headers"]["x-semantica-scope"]
    grant = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
    assert grant["actor_id"] == "wanx:7"
    assert grant["operation_id"] == (body or {}).get("_native_operation_id")
    assert grant["permissions"] == (["read"] if body is None else ["read", "write"])
    assert grant["workspace_id"] != WAREHOUSE
    assert options["json"] == body
    assert options["params"] == query


@pytest.mark.parametrize(
    "query", [{}, {"segment_limit": "1"}, {"segment_offset": "2147483647", "segment_limit": "200"}]
)
def test_document_detail_contract_is_an_exact_read(query):
    path = "/workbench/documents/doc-a"
    assert starlink_workbench.operation_name("GET", path) == "get_document"
    assert starlink_workbench.query_keys("GET", path) == frozenset(
        {"segment_offset", "segment_limit"}
    )
    starlink_workbench.validate_query("GET", path, query)
    assert starlink_workbench.validate_body("GET", path, None) is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "query",
    [
        {"segment_limit": "0"},
        {"segment_limit": "201"},
        {"segment_limit": "-1"},
        {"segment_limit": "01"},
        {"segment_limit": "1.5"},
        {"segment_offset": "-1"},
        {"segment_offset": "2147483648"},
        {"segment_offset": "00"},
        {"segment_offset": "1e2"},
        {"limit": "20"},
        {"workspace_id": "foreign"},
    ],
)
async def test_core_document_detail_rejects_unbounded_or_foreign_query(outgoing, query):
    with pytest.raises(SemanticaError):
        await SemanticaClient(CONFIG, 7).request("GET", PREFIX + "/documents/doc-a", query=query)
    assert outgoing == []


@pytest.mark.asyncio
async def test_core_document_detail_rejects_a_read_body(outgoing):
    with pytest.raises(SemanticaError):
        await SemanticaClient(CONFIG, 7).request("GET", PREFIX + "/documents/doc-a", payload={})
    assert outgoing == []


@pytest.mark.parametrize(
    "method,path",
    [
        ("POST", "/workbench/documents/doc-a"),
        ("PUT", "/workbench/documents/doc-a"),
        ("GET", "/workbench/documents/doc-a/original"),
        ("GET", "/workbench/documents/doc-a/"),
        ("GET", "/workbench/documents/%2e%2e"),
        ("GET", "/workbench/documents/../doc-a"),
    ],
)
def test_document_detail_does_not_open_adjacent_shared_operations(method, path):
    assert starlink_workbench.operation_name(method, path) is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "method,path,body,query",
    [
        ("GET", "/settings/models", None, {}),
        ("PUT", "/settings/status", {"_native_operation_id": "op"}, {}),
        ("GET", "/ontology-suggestions/unknown", None, {}),
        ("PUT", "/ontology-updates/rule-a/start", {"_native_operation_id": "op"}, {}),
        ("GET", "/ontologies/../documents", None, {}),
        ("GET", "/ontologies/%2f/publish", None, {}),
        ("GET", "/ontologies", {}, {}),
        ("GET", "/ontologies", None, {"workspace_id": "foreign"}),
        ("GET", "/documents", None, {"limit": "501"}),
        ("GET", "/jobs", None, {"limit": "201"}),
        ("GET", "/jobs", None, {"offset": "-1"}),
        ("GET", "/ontology-updates/rule-a", None, {"scope": "all"}),
        ("GET", "/ontology-updates/rule-a", None, {}),
        ("GET", "/ontology-updates/rule-a", None, {"limit": "50"}),
        ("POST", "/ontologies", {**CREATE, "operation_id": "shadow"}, {}),
        ("POST", "/ontologies", {"name": "Test", "schema": {}}, {}),
        ("POST", "/ontologies", {**CREATE, "payload": {"workspace_id": "foreign"}}, {}),
        (
            "POST",
            "/ontologies/rule-a/publish",
            {"_native_operation_id": "op", "owner_view": True},
            {},
        ),
    ],
)
async def test_core_workbench_rejects_unknown_scope_method_query_and_write(
    outgoing, method, path, body, query
):
    with pytest.raises(SemanticaError):
        await SemanticaClient(CONFIG, 7).request(method, PREFIX + path, payload=body, query=query)
    assert outgoing == []


@pytest.mark.asyncio
async def test_core_workbench_requires_a_selected_warehouse(outgoing):
    with pytest.raises(SemanticaError, match="SEMANTICA_OPERATION_NOT_ALLOWED"):
        await SemanticaClient(CONFIG, 7).request("GET", "/workbench/ontologies")
    assert outgoing == []


@pytest.mark.asyncio
async def test_ontology_schema_is_business_data_not_an_authority_selector(outgoing):
    body = {
        **CREATE,
        "schema": {"example": {"workspace_id": "business-field", "actor_id": "example"}},
    }
    await SemanticaClient(CONFIG, 7).request("POST", PREFIX + "/ontologies", payload=body)
    assert outgoing[0][2]["json"] == body
    encoded = outgoing[0][2]["headers"]["x-semantica-scope"]
    grant = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
    assert grant["actor_id"] == "wanx:7"
    assert grant["workspace_id"] != "business-field"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "role,application,status",
    [
        ("user", "wanx", 403),
        ("admin", "semantica", 403),
        ("admin", "wanx", 200),
    ],
)
async def test_core_team_workbench_keeps_administrator_boundary(
    tmp_path, monkeypatch, role, application, status
):
    from wanx_bridge.semantica import host_routes as router

    from octop.api.deps import current_user, get_server, require_permission
    from octop.infra.agents.application import application_id
    from octop.infra.bridge_dependencies import semantica_model_host

    routes, _ = router.create_host_routers(
        current_user=current_user,
        get_server=get_server,
        require_permission=require_permission,
        application_id=application_id,
        model_host=semantica_model_host(),
    )
    endpoint = next(route.endpoint for route in routes.routes if route.name == "semantica_request")

    (tmp_path / "semantica.json").write_text(json.dumps(CONFIG))
    forward = AsyncMock(return_value={"items": []})
    monkeypatch.setattr(router.SemanticaClient, "request", forward)
    request = Request(
        {
            "type": "http",
            "method": "GET",
            "headers": [(b"x-wanx-data-context", b"team")],
            "query_string": b"",
            "path": "/api/semantica" + PREFIX + "/ontologies",
        }
    )
    response = await endpoint(
        PREFIX[1:] + "/ontologies",
        request,
        user=SimpleNamespace(id=7, role=role, application_id=application),
        server=SimpleNamespace(services=SimpleNamespace(paths=SimpleNamespace(root=tmp_path))),
    )
    assert response.status_code == status
    assert forward.await_count == (1 if status == 200 else 0)
