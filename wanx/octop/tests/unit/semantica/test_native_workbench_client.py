"""Legacy personal and team clients retain revision-bound correction reads."""

import base64
import json

import httpx
import pytest
from wanx_bridge.semantica import client as module
from wanx_bridge.semantica.client import SemanticaClient, SemanticaError

WAREHOUSE = "10000000-0000-4000-8000-000000000001"
PATH = f"/warehouses/{WAREHOUSE}/workbench/documents/doc-a/corrections/draft-a/items"
EDITOR = {"session": "synthetic-editor-session-123", "generation": "2"}


@pytest.fixture
def transport(monkeypatch):
    seen = []

    def handle(request):
        seen.append(request)
        return httpx.Response(200, json={"items": []})

    original = httpx.AsyncClient
    monkeypatch.setattr(
        module.httpx,
        "AsyncClient",
        lambda **kwargs: original(**kwargs, transport=httpx.MockTransport(handle)),
    )
    return seen


def client(team=False):
    return SemanticaClient(
        {
            "service_url": "http://127.0.0.1:8090",
            "service_token": "synthetic-native-client-token-over-32-characters",
            "box_id": "synthetic-box",
            "application_id": "omnia",
        },
        7,
        team=team,
    )


@pytest.mark.parametrize(
    "suffix", ["sessions", "draft-a/claim", "draft-a/release", "draft-a/heartbeat"]
)
async def test_editor_lifecycle_uses_signed_scoped_operations(transport, suffix):
    payload = {"operation_id": "editor-op", "_native_operation_id": "editor-op"}
    if suffix != "sessions":
        payload["_native_editor"] = EDITOR
    await client().request(
        "POST",
        f"/warehouses/{WAREHOUSE}/workbench/documents/doc-a/corrections/{suffix}",
        payload=payload,
    )
    assert json.loads(transport[0].content) == payload


async def test_editor_read_envelope_preserves_session_without_url_credentials(transport):
    body = {
        "path": "/api/documents/doc-a/corrections/draft-a/items",
        "query": {"revision": "2"},
        "_native_editor": EDITOR,
        "_native_operation_id": "read-items",
    }
    await client().request(
        "POST", f"/warehouses/{WAREHOUSE}/workbench/_correction_read", payload=body
    )
    request = transport[0]
    assert json.loads(request.content) == body
    assert EDITOR["session"] not in str(request.url)
    raw = request.headers["x-semantica-scope"]
    grant = json.loads(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)))
    assert grant["operation_id"] == "read-items"
    assert grant["actor_id"] == "wanx:7"


@pytest.mark.parametrize(
    "change",
    [
        {"path": "/api/settings/status"},
        {"path": "/api/documents/doc-a/corrections/draft-a/discard"},
        {"query": {"workspace_id": "foreign"}},
        {"query": {"method": "POST"}},
        {"query": {"revision": 2}},
        {"method": "POST"},
        {"_native_editor": {"session": "short", "generation": "2"}},
    ],
)
async def test_editor_envelope_cannot_expand_routes_or_scope(transport, change):
    body = {
        "path": "/api/documents/doc-a/corrections/draft-a/items",
        "query": {"revision": "2"},
        "_native_editor": EDITOR,
        "_native_operation_id": "read-items",
        **change,
    }
    with pytest.raises(SemanticaError):
        await client().request(
            "POST", f"/warehouses/{WAREHOUSE}/workbench/_correction_read", payload=body
        )
    assert not transport


@pytest.mark.parametrize("team", [False, True])
async def test_native_correction_revision_query_retains_signed_personal_or_team_scope(
    transport, team
):
    result = await client(team).request(
        "GET", PATH, query={"revision": "2", "kind": "entity", "offset": "0", "limit": "20"}
    )
    assert result == {"items": []}
    request = transport[0]
    assert (
        request.url.path == "/api/integration/workbench/documents/doc-a/corrections/draft-a/items"
    )
    assert request.url.params["revision"] == "2"
    raw = request.headers["x-semantica-scope"]
    grant = json.loads(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)))
    assert grant["actor_id"] == "wanx:7"
    assert grant["permissions"] == ["read"]
    assert grant["operation_id"] is None
    assert grant["owner_view"] is False
    assert grant.get("resource_owner") == ("team:wanx" if team else None)
    assert list(grant["workspace_bindings"].values()) == [
        ("team:wanx" if team else "personal:wanx:7") + ":warehouse:" + WAREHOUSE
    ]


@pytest.mark.parametrize("path", ["/documents", f"/warehouses/{WAREHOUSE}/documents"])
async def test_revision_is_not_enabled_for_non_native_reads(transport, path):
    with pytest.raises(SemanticaError) as error:
        await client().request("GET", path, query={"revision": "1"})
    assert error.value.code == "SEMANTICA_QUERY_NOT_ALLOWED"
    assert transport == []


async def test_native_corrections_keep_scope_and_operation_restrictions(transport):
    for options in (
        {"query": {"revision": "1", "workspace_id": "foreign"}},
        {"payload": {"_native_operation_id": "operation", "workspace_id": "foreign"}},
    ):
        with pytest.raises(SemanticaError):
            await client().request("POST" if "payload" in options else "GET", PATH, **options)
    with pytest.raises(SemanticaError) as error:
        await client().request(
            "POST",
            f"/warehouses/{WAREHOUSE}/workbench/documents/doc-a/corrections",
            payload={"operation_id": "unsigned"},
        )
    assert error.value.code == "SEMANTICA_OPERATION_ID_REQUIRED"
    assert transport == []


@pytest.mark.parametrize(
    "method,path,query",
    [
        ("GET", "/workbench/documents/doc-a/corrections/draft-a/items", {}),
        ("GET", f"/warehouses/{WAREHOUSE}/workbench/unknown", {}),
        ("POST", PATH, {}),
        ("GET", PATH, {"warehouse_id": WAREHOUSE}),
        ("GET", PATH, {"summary": "true"}),
    ],
)
async def test_legacy_corrections_remain_finite_and_cannot_select_scope(
    transport, method, path, query
):
    with pytest.raises(SemanticaError):
        await client().request(method, path, query=query)
    assert transport == []


@pytest.mark.parametrize(
    "status,code",
    [
        (403, "CORRECTION_OWNER_REQUIRED"),
        (404, "CORRECTION_NOT_FOUND"),
        (409, "CORRECTION_REVISION_CONFLICT"),
        (422, "INVALID_CORRECTION_REQUEST"),
        (500, "CORRECTION_INTERNAL_FAILURE"),
    ],
)
async def test_native_error_metadata_keeps_status_and_domain_code_without_private_text(
    monkeypatch, status, code
):
    original = httpx.AsyncClient
    upstream = httpx.MockTransport(
        lambda request: httpx.Response(
            status,
            json={
                "code": code,
                "detail": "private backend diagnostic",
                "message": "private backend message",
                "stack": "private stack",
            },
        )
    )
    monkeypatch.setattr(
        module.httpx, "AsyncClient", lambda **kw: original(**kw, transport=upstream)
    )
    with pytest.raises(SemanticaError) as error:
        await client().request("GET", PATH, query={"revision": "1"})
    assert error.value.code == code
    assert error.value.status == status
    assert error.value.message is None


@pytest.mark.parametrize("code", ["PRIVATE_BACKEND_FAILURE", {"private": "diagnostic"}])
async def test_native_unknown_error_shape_is_sanitized_to_service_failure(monkeypatch, code):
    original = httpx.AsyncClient
    upstream = httpx.MockTransport(
        lambda request: httpx.Response(
            500,
            json={
                "code": code,
                "detail": "private backend diagnostic",
            },
        )
    )
    monkeypatch.setattr(
        module.httpx, "AsyncClient", lambda **kw: original(**kw, transport=upstream)
    )
    with pytest.raises(SemanticaError) as error:
        await client().request("GET", PATH)
    assert (error.value.code, error.value.status, error.value.message) == (
        "SEMANTICA_SERVICE_ERROR",
        503,
        None,
    )


def test_non_native_decoder_keeps_its_original_error_policy():
    with pytest.raises(SemanticaError) as error:
        SemanticaClient.decode(
            httpx.Response(
                409,
                json={
                    "code": "CORRECTION_REVISION_CONFLICT",
                    "detail": "private backend diagnostic",
                },
            )
        )
    assert (error.value.code, error.value.status, error.value.message) == (
        "SEMANTICA_VERSION_CONFLICT",
        409,
        None,
    )


@pytest.mark.parametrize("team", [False, True])
async def test_typed_document_block_pagination_remains_scoped(transport, team):
    await client(team).request(
        "GET",
        f"/warehouses/{WAREHOUSE}/documents/doc-a",
        query={"segment_limit": "200", "block_offset": "500", "block_limit": "1"},
    )
    request = transport[0]
    assert request.url.path == "/api/integration/documents/doc-a"
    assert request.url.params["block_offset"] == "500"
    raw = request.headers["x-semantica-scope"]
    grant = json.loads(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)))
    assert grant["permissions"] == ["read"]
    assert grant["workspace_id"]


@pytest.mark.parametrize(
    "path,query",
    [
        ("documents/doc-a", {"block_offset": "-1"}),
        ("documents/doc-a", {"block_offset": "1e2"}),
        ("documents/doc-a", {"block_limit": "0"}),
        ("documents/doc-a", {"block_limit": "501"}),
        ("jobs", {"block_offset": "0"}),
        ("documents/doc-a/text", {"block_offset": "0"}),
    ],
)
async def test_block_page_contract_rejects_invalid_ranges_and_other_routes(transport, path, query):
    with pytest.raises(SemanticaError):
        await client().request("GET", f"/warehouses/{WAREHOUSE}/{path}", query=query)
    assert not transport
