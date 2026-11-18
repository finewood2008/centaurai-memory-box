"""Cross-entry budgets, gateway paging, and safe owner errors."""

import asyncio
import base64
import hashlib
import hmac
import json
from types import SimpleNamespace

import httpx
import pytest
from test_local_data_routes import context, observed

from wanx_bridge.local_data_protocol import DataProtocolError
from wanx_bridge.local_data_routes import route_policy
from wanx_bridge.semantica import client as mounted
from wanx_bridge.semantica.desktop import DesktopError, decode, resolve
from wanx_bridge.semantica.transport_contract import OWNER_ERROR_CODES

WAREHOUSE = "10000000-0000-4000-8000-000000000001"
CONFIG = {
    "service_url": "http://127.0.0.1:8090",
    "service_token": "synthetic-" * 6,
    "box_id": "synthetic-box",
    "application_id": "semantica",
}


@pytest.mark.parametrize("code", ["INDEX_REQUIRED", "INDEX_STALE", "NO_PARSED_CONTENT", "EMBEDDING_NOT_CONFIGURED", "UNRELATED"])
@pytest.mark.parametrize("public", [False, True])
def test_private_index_recovery_is_preserved_by_both_bridge_adapters(code, public):
    response = httpx.Response(409, json={"detail": {"error": {"code": code, "message": "private diagnostics"}}})
    expected = "SEMANTICA_VERSION_CONFLICT" if public or code == "UNRELATED" else f"SEMANTICA_{code}"
    with pytest.raises(mounted.SemanticaError) as mounted_error:
        mounted.SemanticaClient.decode(response, public=public)
    with pytest.raises(DesktopError) as desktop_error:
        decode(response.status_code, response.content, public=public)
    for error in (mounted_error.value, desktop_error.value):
        assert error.code == expected
        assert error.status == 409
        assert "private diagnostics" not in str(error)


@pytest.mark.parametrize("status, detail, code", [
    (415, "文件内容不是有效的 DOCX", "SEMANTICA_FILE_CONTENT_MISMATCH"),
    (415, "Office 文件损坏或不是有效的 ZIP", "SEMANTICA_FILE_CONTENT_MISMATCH"),
    (422, "DOCX 已加密，无法解析", "SEMANTICA_FILE_ENCRYPTED"),
    (415, "private diagnostic", None),
])
@pytest.mark.parametrize("public", [False, True])
def test_import_failure_recognizes_only_known_private_refusals(status, detail, code, public):
    response = httpx.Response(status, json={"detail": detail})
    for decoder, exception in (
        (lambda: mounted.SemanticaClient.decode(response, public=public), mounted.SemanticaError),
        (lambda: decode(status, response.content, public=public), DesktopError),
    ):
        with pytest.raises(exception) as refused:
            decoder()
        if code and not public:
            assert refused.value.code == code and refused.value.status == status
        else:
            assert refused.value.code not in {"SEMANTICA_FILE_CONTENT_MISMATCH", "SEMANTICA_FILE_ENCRYPTED"}
        assert detail not in str(refused.value)


async def test_onboarding_bootstrap_uses_the_signed_personal_root(monkeypatch):
    calls = []

    def response(request):
        calls.append(request)
        encoded = request.headers["x-semantica-scope"]
        grant = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
        assert grant["actor_id"] == "wanx:7"
        assert set(grant["workspace_bindings"].values()) == {"personal:wanx:7"}
        assert grant["operation_id"] == ("first-run" if request.method == "POST" else None)
        assert request.url.path == "/api/integration/modeling/onboarding"
        return httpx.Response(200, json={"ok": True})

    real = httpx.AsyncClient
    monkeypatch.setattr(mounted.httpx, "AsyncClient", lambda **kw: real(**kw, transport=httpx.MockTransport(response)))
    client = mounted.SemanticaClient(CONFIG, 7)
    path = "/modeling/onboarding"
    body = {"operation_id": "first-run", "expected_revision": 0, "answers": {}, "status": "in_progress"}
    assert (await client.request("GET", path))["ok"]
    assert (await client.request("POST", path, payload=body))["ok"]
    with pytest.raises(mounted.SemanticaError) as denied:
        await mounted.SemanticaClient(CONFIG, 7, team=True).request("POST", path, payload=body)
    assert denied.value.status == 403
    with pytest.raises(mounted.SemanticaError) as invalid:
        await client.request("POST", path, payload={**body, "answers": {"workspace_id": WAREHOUSE}})
    assert invalid.value.code == "SEMANTICA_SCOPE_NOT_SELECTABLE"
    assert len(calls) == 2


@pytest.mark.parametrize(
    "path,method,body,budget",
    [
        (
            "/workbench/ontology-suggestions/generate",
            "POST",
            {
                "_native_operation_id": "generate",
                "document_ids": ["doc"],
                "base_ontology_id": "onto",
                "schema": {},
            },
            285,
        ),
        (
            "/workbench/ontology-suggestions/materials/doc/review",
            "POST",
            {"_native_operation_id": "review"},
            285,
        ),
        (
            "/workbench/conversations",
            "POST",
            {"operation_id": "ontology-change", "_native_operation_id": "ontology-change", "scenario": "change"},
            45,
        ),
        ("/processing/check", "POST", {"operation_id": "check"}, 285),
        ("/processing", "PUT", {"operation_id": "save"}, 285),
        ("/reasoning/prepare", "POST", {"operation_id": "prepare", "arguments": {}}, 285),
        ("/search", "POST", {"query": "synthetic"}, 85),
        ("/documents/doc", "GET", None, 45),
    ],
)
async def test_same_budget_and_valid_signed_scope_through_both_entries(
    monkeypatch, path, method, body, budget
):
    now = [1000]
    monkeypatch.setattr(mounted, "time", SimpleNamespace(time=lambda: now[0]))
    calls = []

    def response(request):
        calls.append(request)
        assert request.extensions["timeout"]["read"] == budget
        encoded = request.headers["x-semantica-scope"]
        assert hmac.compare_digest(
            request.headers["x-semantica-signature"],
            hmac.new(
                CONFIG["service_token"].encode(), encoded.encode(), hashlib.sha256
            ).hexdigest(),
        )
        grant = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
        assert grant["expires_at"] - now[0] == (300 if budget == 285 else 120)
        now[0] += budget
        assert now[0] < grant["expires_at"]  # Includes replies beyond the old 120 s lease.
        assert grant["actor_id"] == "wanx:7"
        resource = next(iter(grant["workspace_bindings"].values()))
        assert resource == (
            "personal:wanx:7"
            if path.startswith("/processing")
            else "personal:wanx:7:warehouse:" + WAREHOUSE
        )
        return httpx.Response(200, json={"ok": True})

    real = httpx.AsyncClient
    monkeypatch.setattr(
        mounted.httpx,
        "AsyncClient",
        lambda **kw: real(**kw, transport=httpx.MockTransport(response)),
    )
    target = path if path.startswith("/processing") else f"/warehouses/{WAREHOUSE}" + path
    assert resolve(method, target).timeout == budget
    assert await mounted.SemanticaClient(CONFIG, 7).request(method, target, payload=body) == {
        "ok": True
    }
    assert len(calls) == 1


@pytest.mark.parametrize("failure", ["budget", "socket"])
async def test_timeout_cancels_the_hop_and_retains_uncertain_failure(monkeypatch, failure):
    cancelled = []

    async def response(request):
        if failure == "socket":
            raise httpx.ReadTimeout("private credential diagnostic")
        try:
            await asyncio.sleep(10)
        finally:
            cancelled.append(True)

    real = httpx.AsyncClient
    monkeypatch.setattr(
        mounted.httpx,
        "AsyncClient",
        lambda **kw: real(**kw, transport=httpx.MockTransport(response)),
    )
    monkeypatch.setattr(mounted, "operation_timeout", lambda _: 0.02)
    with pytest.raises(mounted.SemanticaError) as caught:
        await mounted.SemanticaClient(CONFIG, 7).request(
            "GET", f"/warehouses/{WAREHOUSE}/documents/doc"
        )
    assert caught.value.code == "SEMANTICA_SERVICE_TIMEOUT"
    assert caught.value.status == 504 and caught.value.message is None
    if failure == "budget":
        assert cancelled == [True]


def team_request(query, suffix="/documents/doc", method="GET"):
    resource = "team:knowledge:" + WAREHOUSE
    ctx = {**context(resource), "ownershipEpoch": 1, "team": {"permissions": []}}
    request = observed(f"/api/semantica/warehouses/{WAREHOUSE}" + suffix + query, method)
    request["headers"]["dataContext"] = resource
    return ctx, request


@pytest.mark.parametrize(
    "query",
    [
        "?block_offset=500",
        "?segment_offset=100&segment_limit=200&block_limit=1",
        "?block_offset=2147483647&block_limit=500",
    ],
)
def test_document_paging_preserves_exact_scope_and_query(query):
    ctx, request = team_request(query)
    route = route_policy(ctx, request)
    assert route["upstreamPath"] == "/api/integration/documents/doc" + query
    assert route["action"] == "read" and route["resourceId"] == "team:knowledge:" + WAREHOUSE
    assert route["serviceContext"]["warehouseId"] == WAREHOUSE
    assert (
        resolve("GET", request["rawTarget"].removeprefix("/api/semantica").split("?")[0]).path
        == "/documents/doc"
    )


@pytest.mark.parametrize(
    "query,suffix,method",
    [
        ("?block_limit=0", "/documents/doc", "GET"),
        ("?block_limit=501", "/documents/doc", "GET"),
        ("?block_offset=-1", "/documents/doc", "GET"),
        ("?block_offset=01", "/documents/doc", "GET"),
        ("?block_offset=2147483648", "/documents/doc", "GET"),
        ("?block_limit=1&block_limit=2", "/documents/doc", "GET"),
        ("?block_limit=1&workspace_id=other", "/documents/doc", "GET"),
        ("?block_limit=1", "/documents", "GET"),
        ("?block_limit=1", "/documents/doc/text", "GET"),
        ("?block_limit=1", "/documents/doc", "DELETE"),
    ],
)
def test_block_page_never_widens_other_routes_or_scope(query, suffix, method):
    with pytest.raises(DataProtocolError):
        route_policy(*team_request(query, suffix, method))


@pytest.mark.parametrize("code", sorted(OWNER_ERROR_CODES))
@pytest.mark.parametrize("nested", [False, True])
def test_both_entries_preserve_only_registered_owner_codes(code, nested):
    value = {"code": code, "message": "private material", "detail": "private credentials"}
    body = {"detail": value} if nested else value
    for callback, error in (
        (
            lambda: mounted.SemanticaClient.decode(
                httpx.Response(409, json=body), native_workbench=True
            ),
            mounted.SemanticaError,
        ),
        (lambda: decode(409, json.dumps(body).encode(), native_workbench=True), DesktopError),
    ):
        with pytest.raises(error) as caught:
            callback()
        assert caught.value.code == code and caught.value.status == 409
        assert caught.value.message is None


@pytest.mark.parametrize(
    "native,code",
    [
        (False, "ONTOLOGY_SUGGESTION_EXPIRED"),
        (True, "ONTOLOGY_PRIVATE_DIAGNOSTIC"),
        (True, "RELEASE_UNKNOWN"),
        (True, {"secret": "private"}),
    ],
)
def test_owner_errors_do_not_expand_other_surfaces_or_arbitrary_codes(native, code):
    body = {"code": code, "message": "private"}
    for callback, error in (
        (
            lambda: mounted.SemanticaClient.decode(
                httpx.Response(409, json=body), native_workbench=native
            ),
            mounted.SemanticaError,
        ),
        (lambda: decode(409, json.dumps(body).encode(), native_workbench=native), DesktopError),
        (
            lambda: decode(409, json.dumps(body).encode(), native_workbench=True, public=True),
            DesktopError,
        ),
    ):
        with pytest.raises(error) as caught:
            callback()
        assert caught.value.code == "SEMANTICA_VERSION_CONFLICT" and caught.value.message is None


async def test_mounted_rename_keeps_exact_route_body_and_owner_identity(monkeypatch):
    calls=[]
    def response(request):
        calls.append(request)
        assert request.method == "PATCH" and request.url.path == "/api/integration/warehouses/" + WAREHOUSE
        assert json.loads(request.content) == {"name":"renamed","operation_id":"rename-stable"}
        encoded=request.headers["x-semantica-scope"]
        grant=json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
        assert grant["actor_id"] == "wanx:7" and grant["operation_id"] == "rename-stable"
        return httpx.Response(200,json={"id":WAREHOUSE,"name":"renamed"})
    real=httpx.AsyncClient
    monkeypatch.setattr(mounted.httpx,"AsyncClient",lambda **kw:real(**kw,transport=httpx.MockTransport(response)))
    client=mounted.SemanticaClient(CONFIG,7)
    assert (await client.request("PATCH","/warehouses/"+WAREHOUSE,payload={"name":"renamed","operation_id":"rename-stable"}))["name"] == "renamed"
    with pytest.raises(mounted.SemanticaError):
        await client.request("PATCH","/warehouses/"+WAREHOUSE,payload={"name":"renamed","operation_id":"rename-stable","description":"overwrite"})
    assert len(calls)==1


def test_rename_gateway_grants_only_personal_write_or_current_team_execute():
    path="/api/semantica/warehouses/"+WAREHOUSE
    personal=route_policy(context("semantica",["read","write"]),observed(path,"PATCH"))
    assert personal["action"]=="write" and personal["serviceContext"]["operation"]=="rename_warehouse"
    assert personal["serviceContext"]["warehouseId"]==WAREHOUSE
    team,request=team_request("",suffix="",method="PATCH")
    route=route_policy(team,request)
    assert route["action"]=="execute" and route["resourceId"]=="team:knowledge:"+WAREHOUSE
    assert route["upstreamPath"]=="/api/integration/warehouses/"+WAREHOUSE
    for change in [
        {"method":"PUT"},{"rawTarget":"/api/semantica/warehouses/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"},
        {"rawTarget":path+"?workspace_id=other"},
    ]:
        with pytest.raises(DataProtocolError):
            route_policy(team,{**request,**change})
    with pytest.raises(DataProtocolError):
        route_policy(context("semantica",["read"]),observed(path,"PATCH"))


async def test_mounted_rename_on_older_owner_requires_upgrade(monkeypatch):
    real=httpx.AsyncClient
    monkeypatch.setattr(mounted.httpx,"AsyncClient",lambda **kw:real(**kw,transport=httpx.MockTransport(lambda _:httpx.Response(405,json={"detail":"Method Not Allowed"}))))
    with pytest.raises(mounted.SemanticaError) as caught:
        await mounted.SemanticaClient(CONFIG,7).request("PATCH","/warehouses/"+WAREHOUSE,payload={"name":"renamed","operation_id":"rename-stable"})
    assert caught.value.code=="SEMANTICA_UPGRADE_REQUIRED" and caught.value.status==409


async def test_rename_gateway_staged_body_cannot_add_authority_or_mutate_other_metadata():
    from wanx_bridge.local_data_routes import business_object
    from wanx_bridge.semantica.local_data_policy import validate_staged
    context_value,observation=team_request("",suffix="",method="PATCH")
    route=route_policy(context_value,observation)
    class Staging:
        def __init__(self,body):
            self.raw=json.dumps(body).encode()
            self.length=len(self.raw)
        async def read(self,limit):
            assert len(self.raw)<=limit
            return self.raw
    operation={"route":route,"observation":observation}
    body={"name":"renamed","operation_id":"rename-stable"}
    await validate_staged(None,operation,Staging(body),business_object=business_object)
    for change in ({"warehouse_id":WAREHOUSE},{"workspace_id":"other"},{"description":"overwrite"},{"name":"x\x85"}):
        with pytest.raises(DataProtocolError):
            await validate_staged(None,operation,Staging({**body,**change}),business_object=business_object)
