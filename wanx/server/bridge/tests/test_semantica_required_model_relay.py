"""Private HTTP callback and provider use cross a real signed Unix broker."""

import asyncio
import hashlib
import json
import os
import sqlite3
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from centuarai_local_data_gate import GateConfig
from fastapi import FastAPI
from test_local_data_gateway import RealClock
from test_local_data_sessions import nonce
from test_semantica_model_authority import JOB, native_source, queued_task

from wanx_bridge import local_data_broker
from wanx_bridge import local_data_protocol as wire
from wanx_bridge.local_data_broker import LocalDataBroker
from wanx_bridge.model_reasoning import verified_reasoning
from wanx_bridge.semantica.model_relay import ModelRelay

PATH = "/internal/starklink/models"


@pytest.fixture
def broker_directory():
    with tempfile.TemporaryDirectory(prefix="wrm-", dir=Path("/tmp").resolve()) as directory:
        yield Path(directory)


@pytest.fixture
async def required_relay(tmp_path, monkeypatch, broker_directory):
    h, op = await native_source(clock=RealClock())
    tmp_path.chmod(0o700)
    if sys.platform != "linux":
        monkeypatch.setattr(local_data_broker, "peer_uid", lambda connection: os.geteuid())
    broker = LocalDataBroker(
        h.service,
        socket_path=broker_directory / "broker.sock",
        audience_uids={"octop": {os.geteuid()}, "semantica": {os.geteuid()}},
    )
    await broker.start()
    gate = GateConfig(
        "octop",
        "gateway:test",
        wire.public_jwk(h.gateway),
        "box:test",
        h.view["boxKeyThumbprint"],
        str(broker_directory / "broker.sock"),
        tmp_path,
    )
    config = tmp_path / "semantica.json"
    config.write_text(
        json.dumps(
            {
                "box_id": "box:test",
                "application_id": "semantica",
                "service_url": "http://127.0.0.1:18490",
                "service_token": "",
            }
        )
    )
    state = SimpleNamespace(
        h=h,
        op=op,
        native_calls=[],
        provider_calls=[],
        hold=False,
        block_callback=False,
        started=asyncio.Event(),
        release=asyncio.Event(),
        counter=80,
        confirm_mode=True,
        authorization_mode_override=None,
    )
    provider = {
        "id": 1,
        "name": "Synthetic",
        "kind": "openai",
        "enabled": True,
        "base_url": "http://model/v1",
        "api_key": "synthetic-only",
    }
    model = {"provider_id": 1, "model": "test-model", "input": ["text"],
             "reasoning_config": verified_reasoning('https://token.qeeshu.com/v1', 'deepseek-flash')}

    class Admin:
        async def _admin(self, method, path):
            assert method == "GET" and path != "/api/users"
            return httpx.Response(
                200,
                json={
                    "/api/admin/providers": [provider],
                    "/api/providers/resolved": [model],
                    "/api/providers/application-defaults": {"managed": False, "defaults": {}},
                    "/api/providers/active-model": {
                        "provider_name": "Synthetic",
                        "model": "test-model",
                    },
                }[path],
            )

    async def upstream(request):
        assert "cookie" not in request.headers
        if request.url.host == "model":
            state.provider_calls.append(request)
            state.started.set()
            if state.hold:
                await state.release.wait()
            return httpx.Response(
                200,
                json={
                    "choices": [{"message": {"content": '{"ok":true}'}}],
                    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
                },
            )
        assert str(request.url) == "http://127.0.0.1:18490/api/integration/processing/authorize"
        if state.block_callback:
            await state.release.wait()
        assert "x-semantica-scope" not in request.headers and "authorization" not in request.headers
        proof = request.headers["x-centuarai-gateway-proof"]
        claims = wire.verify_gateway_request(proof, wire.public_jwk(h.gateway), h.clock.wall)
        assert claims["bodySha256"] == wire.encode(hashlib.sha256(request.content).digest())
        assert claims["parentOperationId"] == state.task["operationId"]
        body = json.loads(request.content)
        assert body["job_id"] == JOB and body["task_digest"] == state.task_claims["taskDigest"]
        state.counter += 3
        await h.service.native_admit(
            {
                "gatewayProof": proof,
                "nativeGateGeneration": nonce(9),
                "gateNonce": nonce(state.counter),
            },
            audience="semantica",
        )
        child = h.service._operations[claims["operationId"]]
        await h.service.native_activate(
            {
                **h.native(child, n=state.counter + 1),
                "bodySha256": claims["bodySha256"],
                "bodyBytes": len(request.content),
            },
            audience="semantica",
        )
        state.native_calls.append((claims, body))
        await h.service.native_closed(
            {**h.native(child, n=state.counter + 2), "outcome": "completed"}, audience="semantica"
        )
        return httpx.Response(200, json={"authorized": True,
            **({"inference_options": state.authorization_mode_override or body["inference_options"]}
               if state.confirm_mode and "inference_options" in body else {})})

    relay = ModelRelay(
        Admin(), config, tmp_path, gate_config=gate, transport=httpx.MockTransport(upstream)
    )
    items, _ = await relay._catalog()
    selection = {
        "modelId": items[0]["id"],
        "modelRevision": items[0]["revision"],
        "purpose": "extraction",
    }
    state.task, state.task_claims, _ = await queued_task(h, op, snapshot=selection)
    state.relay, state.selection = relay, selection
    app = FastAPI()
    relay.register(app)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1"
    ) as client:
        state.client = client
        try:
            yield state
        finally:
            state.release.set()
            await relay.close()
            await broker.close()
            await h.service.close()


async def request_body(state, *, n=20, **changes):
    ctx = state.task["route"]["serviceContext"]
    body = {
        "action": "infer",
        "owner": json.dumps(["box:test", "semantica", ctx["principalNamespace"]]),
        "job_id": JOB,
        "warehouse_id": ctx["warehouseId"],
        "purpose": "extraction",
        "selection": {
            "id": state.selection["modelId"],
            "revision": state.selection["modelRevision"],
        },
        "text": "synthetic",
        "schema": {"type": "object", "properties": {"ok": {"const": True}}, "required": ["ok"]},
        **changes,
    }
    raw = json.dumps(body, sort_keys=True, separators=(",", ":")).encode()
    source = {
        **state.h.native(state.task, n=n),
        "modelAction": "infer",
        "bodySha256": wire.encode(hashlib.sha256(raw).digest()),
        "bodyBytes": len(raw),
    }
    proof = await state.h.service.semantica_models.model_request(source, audience="semantica")
    return raw, proof


@pytest.mark.asyncio
async def test_required_inference_uses_real_broker_callback_and_stable_principal_audit(
    required_relay,
):
    state = required_relay
    raw, proof = await request_body(state)
    response = await state.client.post(
        PATH,
        content=raw,
        headers={"content-type": "application/json", "x-centuarai-model-proof": proof},
    )
    assert response.status_code == 200, response.text
    assert json.loads(response.json()["text"]) == {"ok": True}
    assert len(state.provider_calls) == 1 and len(state.native_calls) >= 2
    with sqlite3.connect(state.relay.ledger.path) as db:
        usage = json.loads(db.execute("SELECT payload FROM usage").fetchone()[0])
    assert (
        usage["principal_namespace"] == state.task["route"]["serviceContext"]["principalNamespace"]
    )
    assert "user_id" not in usage
    replay = await state.client.post(
        PATH,
        content=raw,
        headers={"content-type": "application/json", "x-centuarai-model-proof": proof},
    )
    assert replay.status_code == 403 and len(state.provider_calls) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize('confirm', [True, False])
async def test_required_thinking_mode_is_forwarded_and_confirmed(required_relay, confirm):
    state = required_relay
    state.confirm_mode = confirm
    options = {'thinking_mode': 'off'}
    raw, proof = await request_body(state, inference_options=options)
    response = await state.client.post(PATH, content=raw,
        headers={'content-type': 'application/json', 'x-centuarai-model-proof': proof})
    if confirm:
        assert response.status_code == 200, response.text
        assert response.json()['inference_options'] == options
        payload = json.loads(state.provider_calls[0].content)
        assert payload['thinking'] == {'type': 'disabled'}
        assert payload['reasoning_effort'] == 'none'
        assert all(body['inference_options'] == options for _, body in state.native_calls)
    else:
        assert response.status_code == 403, response.text
        assert not state.provider_calls


@pytest.mark.asyncio
async def test_required_auto_rejects_contradictory_mode_acknowledgment(required_relay):
    state = required_relay
    state.authorization_mode_override = {'thinking_mode': 'off'}
    raw, proof = await request_body(state, inference_options={'thinking_mode': 'auto'})
    response = await state.client.post(PATH, content=raw,
        headers={'content-type': 'application/json', 'x-centuarai-model-proof': proof})
    assert response.status_code == 403
    assert not state.provider_calls


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "change", [{"job_id": "foreign"}, {"owner": '["box:test","semantica","forged"]'}]
)
async def test_required_signed_body_cannot_change_owner_or_job(required_relay, change):
    state = required_relay
    raw, proof = await request_body(state, **change)
    response = await state.client.post(
        PATH,
        content=raw,
        headers={"content-type": "application/json", "x-centuarai-model-proof": proof},
    )
    assert response.status_code == 403
    assert state.provider_calls == [] and state.native_calls == []


@pytest.mark.asyncio
async def test_required_missing_proof_never_falls_back_to_private_loopback_trust(required_relay):
    state = required_relay
    raw, _ = await request_body(state)
    response = await state.client.post(
        PATH, content=raw, headers={"content-type": "application/json"}
    )
    assert response.status_code == 403 and state.provider_calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "change", [{"state": "closed"}, {"schemaVersion": 2, "teamDigest": nonce(99)}]
)
async def test_required_live_model_check_rejects_signed_closed_or_changed_identity_lease(
    required_relay, monkeypatch, change
):
    state = required_relay
    raw, proof = await request_body(state)
    original = wire.verify_gateway_model_request(
        proof, wire.public_jwk(state.h.gateway), state.h.clock.wall
    )
    original["_model_proof"] = proof
    relay = state.relay.required
    admit = {
        "proof": proof,
        "bodySha256": original["bodySha256"],
        "bodyBytes": len(raw),
        "relayGeneration": relay.generation,
        "relayNonce": nonce(40),
    }
    lease = await relay._lease("model-admit", admit, original)
    body = {
        "leaseId": lease["leaseId"],
        "relayGeneration": relay.generation,
        "relayNonce": nonce(41),
    }
    positive = await state.h.service.semantica_models.model_check(body, audience="octop")
    invalid = wire.verify_gateway_model_lease(
        positive, wire.public_jwk(state.h.gateway), state.h.clock.wall
    )
    invalid.update(change)
    signed = wire.sign_gateway_model_lease(invalid, state.h.gateway)

    async def changed(_operation, _body):
        return signed

    monkeypatch.setattr(relay.broker, "call", changed)
    with pytest.raises(wire.DataProtocolError):
        await relay._lease("model-check", body, original, lease_id=lease["leaseId"])
    assert state.provider_calls == []


@pytest.mark.asyncio
async def test_required_inflight_model_is_cancelled_when_principal_is_revoked(required_relay):
    state = required_relay
    state.hold = True
    raw, proof = await request_body(state)
    pending = asyncio.create_task(
        state.client.post(
            PATH,
            content=raw,
            headers={"content-type": "application/json", "x-centuarai-model-proof": proof},
        )
    )
    await asyncio.wait_for(state.started.wait(), 2)
    state.h.view["status"] = "revoked"
    try:
        response = await asyncio.wait_for(pending, 5)
        assert response.status_code == 403
        assert state.relay.pending == 0 and not state.relay.required.tasks
    finally:
        state.release.set()
        if not pending.done():
            pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)


@pytest.mark.asyncio
async def test_required_inflight_model_is_drained_when_job_callback_stalls(required_relay):
    state = required_relay
    state.hold = True
    raw, proof = await request_body(state)
    pending = asyncio.create_task(
        state.client.post(
            PATH,
            content=raw,
            headers={"content-type": "application/json", "x-centuarai-model-proof": proof},
        )
    )
    await asyncio.wait_for(state.started.wait(), 2)
    state.block_callback = True
    try:
        response = await asyncio.wait_for(pending, 5)
        assert response.status_code == 503
        assert state.relay.pending == 0 and not state.relay.required.tasks
    finally:
        state.release.set()
        if not pending.done():
            pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)
