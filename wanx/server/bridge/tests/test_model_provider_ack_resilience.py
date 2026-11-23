"""Real catalog ACK outages must not revoke a current, installed GET lease."""
import asyncio
import json

import httpx
import pytest
from fastapi import FastAPI
from test_model_provider_catalog import setup as setup
from test_model_provider_catalog import use_v3
from test_model_provider_runtime import Admin, RediscoveryResponseStream

from wanx_bridge.config import BridgeAuthError
from wanx_bridge.model_provider_runtime import ModelProviderRuntime


def start_stream(runtime, *, model="chat-model"):
    app = FastAPI()
    runtime.register_routes(app)
    messages, delivered = [], asyncio.Event()
    incoming = asyncio.Queue()
    incoming.put_nowait({"type": "http.request", "body": json.dumps({"model": model, "input": "hello", "stream": True}).encode(), "more_body": False})

    async def send(message):
        messages.append(message)
        if message["type"] == "http.response.body" and message.get("body"):
            delivered.set()

    scope = {"type": "http", "asgi": {"version": "3.0", "spec_version": "2.4"},
        "http_version": "1.1", "method": "POST", "scheme": "http",
        "path": "/model-providers/qeetoken/v1/responses", "query_string": b"",
        "headers": [(b"authorization", ("Bearer " + runtime.entries["qeetoken"]["key"]).encode()),
                    (b"content-type", b"application/json")]}
    return asyncio.create_task(app(scope, incoming.get, send)), messages, delivered


async def post(runtime, key, *, model="chat-model"):
    app = FastAPI()
    runtime.register_routes(app)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://local") as client:
        return await client.post("/model-providers/qeetoken/v1/responses",
            json={"model": model, "input": "next request"}, headers={"Authorization": "Bearer " + key})


@pytest.fixture
async def installed_provider(request):
    catalog, state = request.getfixturevalue("setup")
    use_v3(catalog, state)
    stream = RediscoveryResponseStream()
    state.update(models=["chat-model"], tasks=[], authority=True, guard_seen=asyncio.Event(), ack_attempts=0)
    control_transport = catalog.client._transport

    async def control(request):
        if request.method == "POST":
            state["ack_attempts"] += 1
            if state.get("ack_mutate"):
                state["ack_mutate"]()
            if state.get("ack_fault") == "timeout":
                raise httpx.ReadTimeout("synthetic ACK timeout", request=request)
            if state.get("ack_fault") in {403, 409, 429, 503}:
                return httpx.Response(state["ack_fault"], text="synthetic ACK fault")
        return await control_transport.handle_async_request(request)

    # Only the HTTP control-plane transport is controlled. Catalog parsing,
    # binding validation, lease clocks and applied ACK protocol remain real.
    catalog.client._transport = httpx.MockTransport(control)

    async def upstream(request):
        if request.url.path == "/v1/models":
            return httpx.Response(200, json={"data": [{"id": model} for model in state["models"]]})
        if json.loads(request.content).get("stream"):
            return httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=stream)
        return httpx.Response(200, json={"id": "synthetic-response", "output_text": "next request works"})

    async def authority(snapshot):
        if state.get("observe_guard") and not runtime.lock.locked():
            state["guard_seen"].set()
        return state["authority"]

    runtime = ModelProviderRuntime(catalog, Admin(), "http://127.0.0.1:18089",
        authority_check=authority, transport=httpx.MockTransport(upstream))
    try:
        yield runtime, catalog, state, stream
    finally:
        for task in state["tasks"]:
            if not task.done():
                task.cancel()
        await asyncio.gather(*state["tasks"], return_exceptions=True)
        await runtime.close()


async def opened_stream(runtime, state):
    task, messages, delivered = start_stream(runtime)
    state["tasks"].append(task)
    await asyncio.wait_for(delivered.wait(), 1)
    assert messages[0]["status"] == 200 and not task.done()
    return task, messages


@pytest.mark.asyncio
@pytest.mark.parametrize("fault", [503, 429, "timeout"])
async def test_real_catalog_transient_ack_preserves_active_sse_and_next_request(installed_provider, fault):
    runtime, catalog, state, stream = installed_provider
    await runtime.reconcile()
    key = runtime.entries["qeetoken"]["key"]
    deadline = catalog.deadline
    lease = catalog.active()["expiresAt"]
    task, messages = await opened_stream(runtime, state)
    state["ack_fault"] = fault
    # Time spent waiting for an ACK does not renew the GET lease.
    def ack_time():
        state["now"] += 2
        state["mono"] += 2
    state["ack_mutate"] = ack_time
    with pytest.raises(BridgeAuthError, match="MODEL_PROVIDER_TEMPORARILY_UNAVAILABLE"):
        await runtime.reconcile()
    assert runtime.entries, "transient installation ACK revoked an unchanged valid lease"
    assert catalog.active()["expiresAt"] == lease and catalog.deadline == deadline
    assert runtime.entries["qeetoken"]["key"] == key
    # This event comes from a real periodic _watch authority check, while no
    # reconcile or subsequent request is running and the upstream is paused.
    state["observe_guard"] = True
    checked = asyncio.create_task(state["guard_seen"].wait())
    state["tasks"].append(checked)
    await asyncio.wait_for(asyncio.wait({task, checked}, return_when=asyncio.FIRST_COMPLETED), 1)
    assert state["guard_seen"].is_set() and not task.done()
    state["observe_guard"] = False
    assert (await post(runtime, key)).status_code == 200
    state["ack_fault"] = None
    await runtime.reconcile()
    assert state["ack_attempts"] == 3 and runtime.last_error is None
    assert catalog.deadline == deadline and runtime.entries["qeetoken"]["key"] == key
    stream.continue_stream.set()
    stream.release.set()
    await asyncio.wait_for(task, 1)
    assert b"".join(message.get("body", b"") for message in messages) == stream.first + stream.middle + stream.last
    assert stream.closed and not runtime.requests


@pytest.mark.asyncio
@pytest.mark.parametrize("fault", [503, 429, "timeout"])
async def test_first_ack_outage_keeps_only_the_current_installed_get_lease(installed_provider, fault):
    runtime, catalog, state, stream = installed_provider
    state["ack_fault"] = fault
    with pytest.raises(BridgeAuthError, match="MODEL_PROVIDER_TEMPORARILY_UNAVAILABLE"):
        await runtime.reconcile()
    assert state["ack_attempts"] == 1
    key = runtime.entries["qeetoken"]["key"]
    assert runtime.admin.rows[0]["enabled"]
    assert catalog.active()["providers"] and (await post(runtime, key)).status_code == 200
    state["now"] += 301
    state["mono"] += 301
    assert (await post(runtime, key)).status_code != 200
    with pytest.raises(BridgeAuthError, match="MODEL_PROVIDER_LEASE_EXPIRED|MODEL_PROVIDER_UNAVAILABLE"):
        catalog.active()


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["configuration", "credential", "owner", "model"])
async def test_new_get_installs_current_authority_but_ack_outage_never_restores_old_access(installed_provider, change):
    runtime, catalog, state, stream = installed_provider
    await runtime.reconcile()
    old_key = runtime.entries["qeetoken"]["key"]
    task, messages = await opened_stream(runtime, state)
    provider = state["value"]["providers"][0]
    if change == "configuration":
        provider.update(configVersion="2", displayName="Updated provider")
    elif change == "credential":
        provider.update(configVersion="2", credentialGeneration="2", apiKey="synthetic-rotated-key")
    elif change == "owner":
        state["value"].update(bindingId="binding-2", ownerAccountId="owner-2", ownershipEpoch=2)
    else:
        state["models"] = ["next-model"]
    state["ack_fault"] = 503
    with pytest.raises(BridgeAuthError, match="MODEL_PROVIDER_TEMPORARILY_UNAVAILABLE"):
        await runtime.reconcile()
    assert catalog.active()["providers"] and runtime.entries
    current_key = runtime.entries["qeetoken"]["key"]
    assert (await post(runtime, old_key)).status_code != 200
    assert (await post(runtime, current_key, model="next-model" if change == "model" else "chat-model")).status_code == 200
    await asyncio.wait_for(task, 1)
    assert b"".join(message.get("body", b"") for message in messages) == stream.first
    assert stream.closed


@pytest.mark.asyncio
@pytest.mark.parametrize("fault", [403, 409, "malformed"])
async def test_denied_or_malformed_ack_revokes_catalog_and_open_stream(installed_provider, fault):
    runtime, catalog, state, stream = installed_provider
    await runtime.reconcile()
    key = runtime.entries["qeetoken"]["key"]
    task, messages = await opened_stream(runtime, state)
    if fault == "malformed":
        state["bad_ack"] = True
    else:
        state["ack_fault"] = fault
    with pytest.raises(BridgeAuthError):
        await runtime.reconcile()
    assert not runtime.entries and catalog.snapshot is None
    assert (await post(runtime, key)).status_code != 200
    await asyncio.wait_for(task, 1)
    assert b"".join(message.get("body", b"") for message in messages) == stream.first
    assert stream.closed


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["lease", "authority"])
async def test_transient_ack_cannot_preserve_lease_or_authority_that_ended_during_ack(installed_provider, change):
    runtime, catalog, state, stream = installed_provider
    await runtime.reconcile()
    key = runtime.entries["qeetoken"]["key"]
    task, messages = await opened_stream(runtime, state)
    def invalidate():
        if change == "lease":
            state["now"] += 301
            state["mono"] += 301
        else:
            state["authority"] = False
    state.update(ack_fault=503, ack_mutate=invalidate)
    with pytest.raises(BridgeAuthError):
        await runtime.reconcile()
    assert not runtime.entries and catalog.snapshot is None
    assert (await post(runtime, key)).status_code != 200
    await asyncio.wait_for(task, 1)
    assert b"".join(message.get("body", b"") for message in messages) == stream.first
    assert stream.closed


@pytest.mark.asyncio
async def test_ack_outage_cannot_roll_back_new_get_application_defaults(installed_provider):
    runtime, catalog, state, stream = installed_provider
    state["value"]["applicationDefaults"] = {"revision": "1", "defaults": {
        "dialogue": {"providerId": "qeetoken", "modelId": "chat-model"}}}
    await runtime.reconcile()
    key = runtime.entries["qeetoken"]["key"]
    state["models"] = ["next-model"]
    state["value"]["applicationDefaults"] = {"revision": "2", "defaults": {
        "dialogue": {"providerId": "qeetoken", "modelId": "next-model"}}}
    state["ack_fault"] = 503
    with pytest.raises(BridgeAuthError, match="MODEL_PROVIDER_TEMPORARILY_UNAVAILABLE"):
        await runtime.reconcile()
    assert catalog.active()["applicationDefaults"] == state["value"]["applicationDefaults"]
    assert runtime.admin.application_defaults == {"managed": True, "revision": "2", "ready": True,
        "defaults": {"dialogue": {"provider_name": "admin-managed-qeetoken", "model": "next-model"}}}
    assert (await post(runtime, key)).status_code != 200
    assert (await post(runtime, runtime.entries["qeetoken"]["key"], model="next-model")).status_code == 200


@pytest.mark.asyncio
async def test_valid_get_revocation_remains_applied_even_when_ack_is_temporarily_unavailable(installed_provider):
    runtime, catalog, state, stream = installed_provider
    await runtime.reconcile()
    key = runtime.entries["qeetoken"]["key"]
    task, messages = await opened_stream(runtime, state)
    state["value"]["providers"][0].update(configVersion="2", enabled=False,
        protocol=None, baseUrl=None, apiKey=None, allowedModels=[])
    state["ack_fault"] = 503
    with pytest.raises(BridgeAuthError, match="MODEL_PROVIDER_TEMPORARILY_UNAVAILABLE"):
        await runtime.reconcile()
    assert catalog.active()["providers"] == [] and not runtime.entries
    assert runtime.admin.rows[0]["enabled"] is False and runtime.admin.rows[0]["models"] == []
    assert (await post(runtime, key)).status_code != 200
    await asyncio.wait_for(task, 1)
    assert b"".join(message.get("body", b"") for message in messages) == stream.first
    assert stream.closed
