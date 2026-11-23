"""Real ECDSA broker capabilities, queue lifetimes and private model admission."""

import hashlib
import json

import pytest
from test_local_data_effects import commit, snapshot
from test_local_data_effects import observed as observed_inventory
from test_local_data_routes import observed
from test_local_data_sessions import Harness, nonce

from wanx_bridge import local_data_protocol as wire
from wanx_bridge.local_data_routes import application_policy, child_policy, route_policy

JOB = "10000000-0000-4000-8000-000000000001"
MODEL = {"modelId": "1:synthetic/model", "modelRevision": "a" * 64, "purpose": "extraction"}


async def native_source(operation="/conversations/c/intents/i/confirm", *, clock=None, method="POST"):
    h = Harness()
    if clock is not None:
        h.clock = clock
    h.view["grants"] = [{"resourceId": "semantica", "actions": ["read", "write"]}]
    s = h.service
    s.application_policy, s.route_policy, s.child_policy = (
        application_policy,
        route_policy,
        child_policy,
    )
    s.gateway_semantica_task_signer = lambda payload: wire.sign_gateway_semantica_task(
        payload, h.gateway
    )
    s.gateway_model_request_signer = lambda payload: wire.sign_gateway_model_request(
        payload, h.gateway
    )
    s.gateway_model_request_verifier = lambda proof, now: wire.verify_gateway_model_request(
        proof, wire.public_jwk(h.gateway), now
    )
    s.gateway_model_lease_signer = lambda payload: wire.sign_gateway_model_lease(payload, h.gateway)
    await h.start()
    ctx = s._sessions[h.session["sessionId"]]["context"]
    warehouse = route_policy(ctx, observed("/api/semantica/documents"))["serviceContext"][
        "workspaceId"
    ]
    path = (
        "/api/semantica/documents"
        if operation is None
        else "/api/semantica/warehouses/" + warehouse + "/workbench" + operation
    )
    payload = h.payload(method=method, rawTarget=path)
    op = await s.admit_request(h.signed(payload), h.observed(payload))
    await s.activate_request(op["operationId"], payload["bodySha256"], payload["bodyBytes"])
    proof = await s.gateway_request(
        op["operationId"], {**h.observed(payload), "rawTarget": op["route"]["upstreamPath"]}
    )
    await h.native_start(op, proof)
    return h, op


async def queued_task(h, op, *, kind="extraction", task_id=JOB, snapshot=MODEL, n=12):
    body = {
        **h.native(op, n=n),
        "taskId": task_id,
        "taskKind": kind,
        "taskDigest": wire.digest({"synthetic_source": "v1", "kind": kind}),
        "modelSnapshot": snapshot,
    }
    signed = await h.service.semantica_models.task_start(body, audience="semantica")
    claims = wire.verify_gateway_semantica_task(signed, wire.public_jwk(h.gateway), h.clock.wall)
    return h.service._operations[claims["operationId"]], claims, signed


@pytest.mark.asyncio
async def test_reading_sensitive_settings_can_resolve_the_selected_model_without_starting_a_task():
    h, operation = await native_source("/sensitive/settings", method="GET")
    try:
        raw = b'{"action":"catalog"}'
        proof = await h.service.semantica_models.model_request({
            **h.native(operation, n=11), "modelAction": "catalog",
            "bodySha256": wire.encode(hashlib.sha256(raw).digest()), "bodyBytes": len(raw),
        }, audience="semantica")
        claims = wire.verify_gateway_model_request(proof, wire.public_jwk(h.gateway), h.clock.wall)
        assert claims["modelAction"] == "catalog"
        assert claims["taskId"] is None
        with pytest.raises(wire.DataProtocolError, match="LOCAL_DATA_SCOPE_DENIED"):
            await queued_task(h, operation, kind="sensitive", snapshot={**MODEL, "purpose": "sensitive"})
    finally:
        await h.service.close()


def model_bytes(task):
    ctx = task["route"]["serviceContext"]
    return json.dumps(
        {
            "action": "infer",
            "owner": json.dumps(["box:test", "semantica", ctx["principalNamespace"]]),
            "job_id": JOB,
            "warehouse_id": ctx["warehouseId"],
            "purpose": "extraction",
            "selection": {"id": MODEL["modelId"], "revision": MODEL["modelRevision"]},
            "text": "synthetic",
            "schema": {"type": "object"},
        },
        separators=(",", ":"),
    ).encode()


async def model_ticket(h, task, *, n=15):
    raw = model_bytes(task)
    body = {
        **h.native(task, n=n),
        "modelAction": "infer",
        "bodySha256": wire.encode(hashlib.sha256(raw).digest()),
        "bodyBytes": len(raw),
    }
    proof = await h.service.semantica_models.model_request(body, audience="semantica")
    claims = wire.verify_gateway_model_request(proof, wire.public_jwk(h.gateway), h.clock.wall)
    return raw, proof, claims


@pytest.mark.asyncio
async def test_required_task_survives_original_http_completion_but_not_authority_revocation():
    h, op = await native_source()
    task, claims, _ = await queued_task(h, op)
    await h.service.native_closed(
        {**h.native(op, n=20), "outcome": "completed"}, audience="semantica"
    )
    await h.service.finish_operation(op["operationId"], transport_closed=True)
    checked = await h.service.semantica_models.task_check(
        h.native(task, n=21), audience="semantica"
    )
    assert (
        wire.verify_gateway_semantica_task(checked, wire.public_jwk(h.gateway), h.clock.wall)[
            "taskId"
        ]
        == JOB
    )
    assert claims["parentRequestId"] == op["operationId"]
    h.view["status"] = "revoked"
    h.clock.advance(1001)
    with pytest.raises(wire.DataProtocolError):
        await h.service.semantica_models.task_check(h.native(task, n=22), audience="semantica")
    # Physical cleanup may still be acknowledged after logical denial.
    closed = await h.service.semantica_models.task_close(
        {**h.native(task, n=23), "outcome": "denied"}, audience="semantica"
    )
    assert (
        wire.verify_gateway_semantica_task(closed, wire.public_jwk(h.gateway), h.clock.wall)[
            "state"
        ]
        == "closed"
    )
    await h.service.close()


@pytest.mark.asyncio
async def test_model_ticket_is_native_peer_only_exact_bytes_one_use_and_live_checked():
    h, op = await native_source()
    task, _, _ = await queued_task(h, op)
    raw, proof, claims = await model_ticket(h, task)
    relay = {
        "proof": proof,
        "bodySha256": claims["bodySha256"],
        "bodyBytes": len(raw),
        "relayGeneration": nonce(30),
        "relayNonce": nonce(31),
    }
    with pytest.raises(wire.DataProtocolError):
        await h.service.semantica_models.model_admit(relay, audience="semantica")
    with pytest.raises(wire.DataProtocolError):
        await h.service.semantica_models.model_admit(
            {**relay, "bodyBytes": len(raw) + 1}, audience="octop"
        )
    signed = await h.service.semantica_models.model_admit(relay, audience="octop")
    lease = wire.verify_gateway_model_lease(signed, wire.public_jwk(h.gateway), h.clock.wall)
    assert lease["taskId"] == JOB and lease["taskDigest"] == claims["taskDigest"]
    assert lease["gatewayProofDigest"] == wire.gateway_proof_digest(proof)
    with pytest.raises(wire.DataProtocolError, match="LOCAL_DATA_REPLAY"):
        await h.service.semantica_models.model_admit(relay, audience="octop")
    check = {
        "leaseId": lease["leaseId"],
        "relayGeneration": relay["relayGeneration"],
        "relayNonce": nonce(32),
    }
    await h.service.semantica_models.model_check(check, audience="octop")
    with pytest.raises(wire.DataProtocolError, match="LOCAL_DATA_REPLAY"):
        await h.service.semantica_models.model_check(check, audience="octop")
    h.view["status"] = "revoked"
    h.clock.advance(1001)
    with pytest.raises(wire.DataProtocolError):
        await h.service.semantica_models.model_check(
            {**check, "relayNonce": nonce(33)}, audience="octop"
        )
    await h.service.semantica_models.model_close(
        {**check, "relayNonce": nonce(34), "outcome": "denied"}, audience="octop"
    )
    await h.service.close()


@pytest.mark.asyncio
async def test_model_callback_is_a_signed_child_for_exact_job_and_same_warehouse():
    h, op = await native_source()
    task, _, _ = await queued_task(h, op)
    raw, proof, claims = await model_ticket(h, task)
    authorization = {
        "operation_id": claims["requestId"],
        "job_id": JOB,
        "purpose": "extraction",
        "model_id": MODEL["modelId"],
        "model_revision": MODEL["modelRevision"],
        "task_digest": claims["taskDigest"],
    }
    body = {
        "proof": proof,
        "bodySha256": claims["bodySha256"],
        "bodyBytes": len(raw),
        "relayGeneration": nonce(30),
        "relayNonce": nonce(31),
        "authorizationBody": authorization,
    }
    signed = await h.service.semantica_models.model_admit(body, audience="octop")
    lease = wire.verify_gateway_model_lease(signed, wire.public_jwk(h.gateway), h.clock.wall)
    child = wire.verify_gateway_request(
        lease["authorizationProof"], wire.public_jwk(h.gateway), h.clock.wall
    )
    assert child["parentOperationId"] == task["operationId"]
    assert child["rawTarget"] == "/api/integration/processing/authorize"
    assert child["serviceContext"] == {
        **task["route"]["serviceContext"],
        "operation": "authorize_processing",
    }
    assert child["bodySha256"] == lease["authorizationBodySha256"]
    assert child["principalId"] == claims["principalId"]
    assert child["action"] == task["route"]["action"]
    check = {
        "leaseId": lease["leaseId"],
        "relayGeneration": nonce(30),
        "relayNonce": nonce(32),
        "authorizationBody": {**authorization, "job_id": "foreign"},
    }
    with pytest.raises(wire.DataProtocolError):
        await h.service.semantica_models.model_check(check, audience="octop")
    await h.service.close()


@pytest.mark.asyncio
async def test_task_kinds_cannot_escalate_and_derived_jobs_are_bounded():
    h, op = await native_source("/conversations/c/messages")
    bad = {
        **h.native(op, n=40),
        "taskId": JOB,
        "taskKind": "publication",
        "taskDigest": nonce(43),
        "modelSnapshot": None,
    }
    with pytest.raises(wire.DataProtocolError):
        await h.service.semantica_models.task_start(bad, audience="semantica")
    task, _, _ = await queued_task(h, op, kind="dialogue", n=41)
    with pytest.raises(wire.DataProtocolError):
        await h.service.semantica_models.task_start(
            {
                **h.native(task, n=42),
                "taskId": "other",
                "taskKind": "extraction",
                "taskDigest": nonce(43),
                "modelSnapshot": MODEL,
            },
            audience="semantica",
        )
    await h.service.close()


@pytest.mark.asyncio
async def test_parse_index_sensitive_derivation_keeps_original_request_and_survives_parent_finish():
    h, source = await native_source(None)
    parse, _, _ = await queued_task(h, source, kind="parse", snapshot=None)
    index, _, _ = await queued_task(
        h, parse, kind="index", snapshot=None, task_id="index-job", n=13
    )
    sensitive, claims, _ = await queued_task(
        h, index, kind="sensitive", snapshot=None, task_id="sensitive-job", n=14
    )
    assert claims["parentRequestId"] == source["operationId"]
    assert claims["serviceContext"] == source["route"]["serviceContext"]
    await h.service.semantica_models.task_close(
        {**h.native(index, n=15), "outcome": "completed"}, audience="semantica"
    )
    await h.service.semantica_models.task_close(
        {**h.native(parse, n=16), "outcome": "completed"}, audience="semantica"
    )
    checked = await h.service.semantica_models.task_check(
        h.native(sensitive, n=17), audience="semantica"
    )
    assert (
        wire.verify_gateway_semantica_task(checked, wire.public_jwk(h.gateway), h.clock.wall)[
            "taskId"
        ]
        == "sensitive-job"
    )
    with pytest.raises(wire.DataProtocolError):
        await h.service.semantica_models.model_request(
            {
                **h.native(sensitive, n=18),
                "modelAction": "infer",
                "bodySha256": wire.digest({}),
                "bodyBytes": 2,
            },
            audience="semantica",
        )
    await h.service.close()


@pytest.mark.asyncio
async def test_auto_material_publication_is_derived_only_from_scoped_processing_requests():
    h, source = await native_source("/conversations/materials/document/processing-starts")
    index, _, _ = await queued_task(h, source, kind="index", snapshot=None, task_id="source-index")
    extraction, _, _ = await queued_task(h, source, task_id=JOB, n=13)
    with pytest.raises(wire.DataProtocolError):
        await queued_task(h, source, kind="publication", snapshot=None, task_id="unbound", n=14)
    publication, claims, _ = await queued_task(h, extraction, kind="publication", snapshot=None,
                                               task_id="source-publication", n=15)
    assert claims["parentRequestId"] == source["operationId"]
    assert claims["serviceContext"] == source["route"]["serviceContext"]
    await h.service.semantica_models.task_close({**h.native(index, n=16), "outcome": "completed"}, audience="semantica")
    await h.service.semantica_models.task_close({**h.native(extraction, n=17), "outcome": "completed"}, audience="semantica")
    rebuilt, _, _ = await queued_task(h, publication, kind="index", snapshot=None, task_id="graph-index", n=18)
    _, claims, _ = await queued_task(h, rebuilt, kind="sensitive", snapshot=None, task_id="graph-scan", n=19)
    assert claims["parentRequestId"] == source["operationId"]
    await h.service.close()
    other, old = await native_source()
    unrelated, _, _ = await queued_task(other, old)
    with pytest.raises(wire.DataProtocolError):
        await queued_task(other, unrelated, kind="publication", snapshot=None, task_id="other-publication", n=21)
    await other.service.close()


@pytest.mark.asyncio
async def test_physical_effect_waits_for_model_listener_drain_after_backend_task_closed():
    h, op = await native_source()
    h.service.effects.audiences = frozenset({"semantica", "octop"})
    h.service.gateway_observation_signer = lambda payload: wire.sign_gateway_observation(
        payload, h.gateway
    )
    task, _, _ = await queued_task(h, op)
    raw, proof, claims = await model_ticket(h, task)
    admit = {
        "proof": proof,
        "bodySha256": claims["bodySha256"],
        "bodyBytes": len(raw),
        "relayGeneration": nonce(30),
        "relayNonce": nonce(31),
    }
    signed = await h.service.semantica_models.model_admit(admit, audience="octop")
    lease = wire.verify_gateway_model_lease(signed, wire.public_jwk(h.gateway), h.clock.wall)
    h.clock.advance(1)
    effect = commit(h)
    await h.service.observe_commit(effect)
    await h.service.invalidate_authority()
    await h.service.native_closed(
        {**h.native(op, n=60), "outcome": "cancelled"}, audience="semantica"
    )
    await h.service.finish_operation(op["operationId"], "cancelled", transport_closed=True)
    await h.service.semantica_models.task_close(
        {**h.native(task, n=61), "outcome": "cancelled"}, audience="semantica"
    )
    await observed_inventory(h, [], n=62, audience="semantica")
    await observed_inventory(h, [], n=63, audience="octop")
    before = await snapshot(h, effect)
    assert before["effectState"] != "effective"
    assert before["native"]["targetOperations"] == 3
    await h.service.semantica_models.model_close(
        {
            "leaseId": lease["leaseId"],
            "relayGeneration": nonce(30),
            "relayNonce": nonce(64),
            "outcome": "cancelled",
        },
        audience="octop",
    )
    after = await snapshot(h, effect)
    assert after["effectState"] == "effective"
    assert after["native"]["closedOperations"] == 3
    await h.service.close()
