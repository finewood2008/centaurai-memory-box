"""Required broker uses the same finite contract and frozen warehouse resource."""

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from test_local_data_routes import context, observed

from wanx_bridge.local_data_protocol import DataProtocolError
from wanx_bridge.local_data_routes import route_policy, validate_staged

WAREHOUSE = "10000000-0000-4000-8000-000000000001"
FOREIGN = "20000000-0000-4000-8000-000000000001"
RESOURCE = "team:knowledge:" + WAREHOUSE
CASES = [
    ("GET", "/settings/status", "workbench_status"),
    ("GET", "/jobs?limit=10&offset=0", "list_jobs"),
    ("GET", "/documents?limit=500&offset=0", "list_documents"),
    ("GET", "/documents/doc-a?segment_offset=0&segment_limit=200", "get_document"),
    ("GET", "/ontologies", "list_ontologies"),
    ("POST", "/ontologies", "create_ontology"),
    ("POST", "/ontologies/rule-a/publish", "publish_ontology"),
    ("GET", "/ontology-updates/rule-a?scope=selectable&offset=0", "read_ontology_impact"),
]


def selected(ctx, path, method, *, team=False, warehouse=None):
    if warehouse is None:
        warehouse = (
            WAREHOUSE
            if team
            else route_policy(ctx, observed("/api/semantica/documents"))["serviceContext"][
                "workspaceId"
            ]
        )
    request = observed(f"/api/semantica/warehouses/{warehouse}/workbench" + path, method)
    if team:
        request["headers"]["dataContext"] = RESOURCE
    return route_policy(ctx, request), request


@pytest.mark.parametrize(
    "method,path,operation",
    [
        ("GET", "/conversations", "list_conversations"),
        ("GET", "/conversations/conversation/onboarding", "get_onboarding_state"),
        ("POST", "/conversations/conversation/onboarding/start", "start_onboarding"),
        ("POST", "/conversations/conversation/onboarding/turns", "send_onboarding_turn"),
        ("GET", "/conversations/conversation/onboarding/turns/turn", "get_onboarding_turn"),
        ("POST", "/conversations/conversation/onboarding/preview", "preview_onboarding"),
        ("POST", "/conversations/conversation/onboarding/publish", "publish_onboarding"),
        ("POST", "/conversations", "create_conversation"),
        ("POST", "/conversations/conversation/intents/intent/change-context", "get_material_change_context"),
        ("POST", "/conversations/conversation/intents/intent/change-proposals", "generate_material_change"),
        ("POST", "/conversations/conversation/intents/intent/change-proposals/proposal/read", "read_material_change"),
        ("POST", "/conversations/conversation/intents/intent/change-proposals/proposal/apply", "apply_material_change"),
    ],
)
@pytest.mark.parametrize("team", [False, True])
def test_required_conversations_freeze_operation_and_existing_warehouse(method, path, operation, team):
    ctx = context(RESOURCE if team else "semantica")
    if team:
        ctx.update(team={"roleId": "manager", "permissions": []}, ownershipEpoch=1)
    route, _ = selected(ctx, path, method, team=team)
    assert route["serviceContext"]["operation"] == operation
    assert route["resourceId"] == (RESOURCE if team else "semantica")
    assert route["action"] == ("read" if method == "GET" else "execute" if team else "write")
    assert route["upstreamPath"] == "/api/integration/workbench" + path
    assert route["serviceContext"]["warehouseId"] == (WAREHOUSE if team else route["serviceContext"]["workspaceId"])
    assert route["serviceContext"]["principalNamespace"] == ctx["principalNamespace"]


@pytest.mark.parametrize("team", [False, True])
@pytest.mark.parametrize("method,path,operation", CASES)
def test_required_workbench_freezes_exact_operation_action_and_resource(
    team, method, path, operation
):
    ctx = context(RESOURCE if team else "semantica")
    if team:
        ctx.update(team={"roleId": "manager", "permissions": []}, ownershipEpoch=1)
    route, _ = selected(ctx, path, method, team=team)
    assert route["audience"] == "semantica"
    assert route["resourceId"] == (RESOURCE if team else "semantica")
    assert route["action"] == ("read" if method == "GET" else "execute" if team else "write")
    assert route["upstreamPath"] == "/api/integration/workbench" + path
    assert route["bodyLimit"] == (0 if method == "GET" else 2 * 1024**2)
    assert route["serviceContext"]["operation"] == operation
    assert route["serviceContext"]["kind"] == "warehouse"
    assert route["serviceContext"]["principalNamespace"] == ctx["principalNamespace"]
    assert route["serviceContext"]["warehouseId"] == (WAREHOUSE if team else route["serviceContext"]["workspaceId"])


@pytest.mark.parametrize("team", [False, True])
@pytest.mark.parametrize("path", ["/ontologies", "/documents/doc-a?segment_limit=200"])
def test_required_workbench_cannot_select_another_warehouse(team, path):
    ctx = context(RESOURCE if team else "semantica")
    if team:
        ctx.update(team={"roleId": "manager", "permissions": []}, ownershipEpoch=1)
    if team:
        with pytest.raises(DataProtocolError):
            selected(ctx, path, "GET", team=True, warehouse=FOREIGN)
    else:
        own, _ = selected(ctx, path, "GET")
        other, _ = selected(ctx, path, "GET", warehouse=FOREIGN)
        # A personal object ID never selects another principal. The workspace
        # is still derived from this verified owner and the domain must prove
        # that the selected warehouse row actually belongs to it.
        assert other["serviceContext"]["principalNamespace"] == ctx["principalNamespace"]
        assert other["serviceContext"]["warehouseId"] == FOREIGN
        assert other["serviceContext"]["workspaceId"] != own["serviceContext"]["workspaceId"]
        assert other["resourceId"] == "semantica"


@pytest.mark.parametrize(
    "query",
    [
        "segment_limit=0",
        "segment_limit=201",
        "segment_limit=-1",
        "segment_limit=01",
        "segment_limit=1.5",
        "segment_offset=-1",
        "segment_offset=2147483648",
        "segment_offset=00",
        "segment_offset=1e2",
        "segment_limit=20&segment_limit=30",
        "workspace_id=foreign",
        "limit=20",
    ],
)
def test_required_document_detail_rejects_invalid_or_duplicate_pagination(query):
    with pytest.raises(DataProtocolError):
        selected(context("semantica"), "/documents/doc-a?" + query, "GET")


@pytest.mark.parametrize(
    "method,path",
    [
        ("GET", "/settings/models"),
        ("PUT", "/settings/status"),
        ("GET", "/ontology-suggestions/materials"),
        ("POST", "/ontology-updates/rule-a/start"),
        ("GET", "/jobs?limit=201"),
        ("GET", "/jobs?offset=0&offset=1"),
        ("GET", "/documents?workspace_id=foreign"),
        ("GET", "/ontology-updates/rule-a?scope=all"),
        ("GET", "/ontology-updates/rule-a"),
        ("GET", "/ontology-updates/rule-a?limit=20"),
        ("GET", "/ontologies/../documents"),
        ("POST", "/documents/doc-a"),
        ("GET", "/documents/doc-a/original"),
        ("GET", "/documents/doc-a/"),
    ],
)
def test_required_workbench_does_not_open_other_operations(method, path):
    with pytest.raises(DataProtocolError):
        selected(context("semantica"), path, method)


@pytest.mark.parametrize("team", [False, True])
def test_required_workbench_read_grant_never_authorizes_manual_writes(team):
    ctx = context(RESOURCE if team else "semantica", ["read"])
    if team:
        ctx.update(team={"roleId": "member", "permissions": []}, ownershipEpoch=1)
    assert selected(ctx, "/ontologies", "GET", team=team)[0]["action"] == "read"
    for path in ["/ontologies", "/ontologies/rule-a/publish"]:
        with pytest.raises(DataProtocolError):
            selected(ctx, path, "POST", team=team)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "body",
    [
        {"name": "Test", "schema": {}, "_native_operation_id": "native-create"},
        {"name": "Test", "schema": {}},
        {
            "name": "Test",
            "schema": {},
            "_native_operation_id": "native-create",
            "operation_id": "shadow",
        },
        {
            "name": "Test",
            "schema": {},
            "workspaceId": "foreign",
            "_native_operation_id": "native-create",
        },
    ],
)
async def test_required_workbench_checks_business_operation_before_forwarding(body):
    route, observation = selected(context("semantica"), "/ontologies", "POST")
    raw = json.dumps(body).encode()
    staging = SimpleNamespace(length=len(raw), read=AsyncMock(return_value=raw))
    work = validate_staged(None, {"route": route, "observation": observation}, staging)
    if set(body) == {"name", "schema", "_native_operation_id"} and body["schema"] == {}:
        await work
    else:
        with pytest.raises(DataProtocolError):
            await work


@pytest.mark.asyncio
@pytest.mark.parametrize("path", ["/ontologies", "/documents/doc-a?segment_limit=200"])
async def test_required_workbench_read_cannot_carry_a_body(path):
    route, observation = selected(context("semantica"), path, "GET")
    with pytest.raises(DataProtocolError):
        await validate_staged(
            None, {"route": route, "observation": observation}, SimpleNamespace(length=2)
        )
