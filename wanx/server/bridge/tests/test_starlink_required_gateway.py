"""New workbench routes cross actual TLS, staging, signatures and Unix leases."""

import asyncio
import hashlib
import json

import httpx
import pytest
from test_local_data_gateway import network as network_fixture
from test_local_data_gateway import proof
from test_local_data_routes import observed

from wanx_bridge.local_data_routes import route_policy

network = network_fixture


def warehouse_path(network, suffix):
    context = network.h.service._sessions[network.h.session["sessionId"]]["context"]
    private = route_policy(context, observed("/api/semantica/documents"))["serviceContext"]
    return "/api/semantica/warehouses/" + private["workspaceId"] + "/workbench" + suffix


def encoded(body):
    return json.dumps(body, sort_keys=True, separators=(",", ":")).encode()


@pytest.mark.asyncio
@pytest.mark.parametrize("network", ["semantica"], indirect=True)
async def test_real_required_warehouse_runtime_is_a_principal_read_not_a_warehouse_id(network):
    path = "/api/semantica/warehouses/runtime"
    _, signed = proof(network, path)
    response = await network.client.get(path, headers={"x-centuarai-data-proof": signed})
    assert response.status_code == 200
    native_path, claims = network.calls[0]
    assert native_path == "/api/integration/warehouses/runtime"
    assert claims["action"] == "read" and claims["resourceId"] == "semantica"
    assert claims["serviceContext"]["operation"] == "get_warehouse_runtime"
    assert claims["serviceContext"]["warehouseId"] is None


@pytest.mark.asyncio
@pytest.mark.parametrize("network", ["semantica"], indirect=True)
async def test_real_required_knowledge_run_is_a_scoped_read(network):
    path = warehouse_path(network, "/knowledge/runs/10000000-0000-4000-8000-000000000001")
    _, signed = proof(network, path)
    response = await network.client.get(path, headers={"x-centuarai-data-proof": signed})
    assert response.status_code == 200
    native_path, claims = network.calls[0]
    assert native_path.endswith("/workbench/knowledge/runs/10000000-0000-4000-8000-000000000001")
    assert claims["action"] == "read" and claims["resourceId"] == "semantica"
    assert claims["serviceContext"]["operation"] == "get_knowledge_run"


@pytest.mark.asyncio
@pytest.mark.parametrize("network", ["semantica"], indirect=True)
async def test_real_required_conversation_enters_one_exact_warehouse_once(network):
    path = warehouse_path(network, "/conversations")
    raw = encoded({"operation_id": "create", "_native_operation_id": "create"})
    _, signed = proof(
        network, path, method="POST", data=raw, selectors={"contentType": "application/json"}
    )
    headers = {"x-centuarai-data-proof": signed, "content-type": "application/json"}
    response = await network.client.post(path, content=raw, headers=headers)
    assert response.status_code == 200, response.text
    assert response.content == hashlib.sha256(raw).hexdigest().encode()
    assert network.writes == [raw]
    native_path, claims = network.calls[0]
    assert native_path == "/api/integration/workbench/conversations"
    assert claims["audience"] == "semantica"
    assert claims["serviceContext"]["operation"] == "create_conversation"
    assert claims["resourceId"] == "semantica" and claims["action"] == "write"
    # A channel proof cannot be reused to create a second native operation.
    again = await network.client.post(path, content=raw, headers=headers)
    assert again.status_code == 403 and len(network.calls) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("network", ["semantica"], indirect=True)
@pytest.mark.parametrize(
    "body",
    [
        {"operation_id": "other", "_native_operation_id": "create"},
        {"operation_id": "create", "_native_operation_id": "create", "actor_id": "foreign"},
        {"operation_id": "create", "_native_operation_id": "create", "workspace_id": "foreign"},
        {"operation_id": "create", "_native_operation_id": "create", "owner_view": True},
    ],
)
async def test_signed_forged_conversation_envelope_never_reaches_native_handler(network, body):
    path = warehouse_path(network, "/conversations")
    raw = encoded(body)
    _, signed = proof(
        network, path, method="POST", data=raw, selectors={"contentType": "application/json"}
    )
    response = await network.client.post(
        path,
        content=raw,
        headers={"x-centuarai-data-proof": signed, "content-type": "application/json"},
    )
    assert response.status_code == 403
    assert network.calls == [] and network.writes == []


@pytest.mark.asyncio
@pytest.mark.parametrize("network", ["semantica"], indirect=True)
async def test_signed_unapproved_team_selector_and_mutated_bytes_have_no_native_effect(network):
    own = warehouse_path(network, "/conversations")
    raw = encoded({"operation_id": "create", "_native_operation_id": "create"})
    selector = "team:knowledge:20000000-0000-4000-8000-000000000001"
    _, signed = proof(
        network,
        own,
        method="POST",
        data=raw,
        selectors={"contentType": "application/json", "dataContext": selector},
    )
    response = await network.client.post(
        own,
        content=raw,
        headers={
            "x-centuarai-data-proof": signed,
            "content-type": "application/json",
            "x-wanx-data-context": selector,
        },
    )
    assert response.status_code == 403
    _, signed = proof(
        network, own, method="POST", data=raw, n=4, selectors={"contentType": "application/json"}
    )
    response = await network.client.post(
        own,
        content=raw + b" ",
        headers={"x-centuarai-data-proof": signed, "content-type": "application/json"},
    )
    assert response.status_code == 403
    assert network.calls == [] and network.writes == []


@pytest.mark.asyncio
@pytest.mark.parametrize("network", ["semantica"], indirect=True)
async def test_required_model_proposal_is_cancelled_on_authority_revocation(network):
    path = warehouse_path(network, "/conversations/conversation/intents/intent/change-proposals")
    raw = encoded(
        {
            "operation_id": "change",
            "_native_operation_id": "change",
            "context_digest": "a" * 64,
            "instruction": "只修改合成目标",
        }
    )
    _, signed = proof(
        network, path, method="POST", data=raw, selectors={"contentType": "application/json"}
    )
    pending = asyncio.create_task(
        network.client.post(
            path,
            content=raw,
            headers={"x-centuarai-data-proof": signed, "content-type": "application/json"},
        )
    )
    try:
        await asyncio.wait_for(network.native_started.wait(), 2)
        network.h.view["status"] = "revoked"
        try:
            response = await asyncio.wait_for(pending, 5)
            assert response.status_code == 403
        except httpx.RemoteProtocolError:
            pass
        assert len(network.calls) == 1 and network.writes == []
        for _ in range(200):
            if not network.gateway.operations:
                break
            await asyncio.sleep(0.01)
        assert not network.gateway.operations
    finally:
        network.release_native.set()
        if not pending.done():
            pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)
