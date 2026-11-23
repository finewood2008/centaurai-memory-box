"""Strict ACK integers at the real HTTP boundary, with durable side-effect checks."""

# ruff: noqa: F811

import asyncio
from copy import deepcopy

import httpx
import pytest
from fastapi import FastAPI
from fastapi.responses import JSONResponse

from wanx_studio.api import create_router
from wanx_studio.contracts import StudioError
from wanx_studio.deployment.miniapp_profile import identifier
from test_expert_deployment import OWNER, deploy
from test_standard_expert_deployment import finish_standard, standard_setup  # noqa: F401


FIELDS = {
    "nonce", "clientId", "artifactHash", "slotApplicationId", "operationId",
    "step", "fence", "generation", "payloadDigest",
}


def acknowledgement(ticket):
    return {
        **{key: ticket[key] for key in FIELDS},
        "state": "prepared" if ticket["step"] == "prepare_client" else "active",
    }


def observed_state(svc, expert, op):
    return {
        "profile": svc.store.db.execute(
            "SELECT kind,key,body FROM deployment_profile_objects ORDER BY kind,key"
        ).fetchall(),
        "operation": deepcopy(svc.deployments.journal.get_operation(OWNER, op["id"])),
        "environment": svc.deployments.journal.get_environment(op["target"]),
        "receipt": svc.deployments.journal.receipt(OWNER, op["id"]),
    }


@pytest.fixture
async def delivery(standard_setup):
    svc, profiles, expert, item, _ = standard_setup
    _, op = await deploy(svc, expert, item, "dev", "strict-ack-types")
    for _ in range(30):
        await svc.deployments.process_once(op["id"])
        await asyncio.sleep(0)
        tickets = profiles.delivery_list(OWNER)["items"]
        if tickets:
            break
    assert tickets and tickets[0]["step"] == "prepare_client"
    ticket = profiles.delivery_claim(
        OWNER, tickets[0]["id"], {"nonce": tickets[0]["nonce"], "clientId": "standard-client"}
    )
    app = FastAPI()

    @app.exception_handler(StudioError)
    async def error(_request, exc):
        return JSONResponse({"code": exc.code}, status_code=exc.status)

    app.include_router(create_router(svc, lambda: OWNER))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        yield client, svc, profiles, expert, op, ticket


@pytest.mark.parametrize("field", ["generation", "fence"])
@pytest.mark.parametrize("kind", ["true", "false", "float", "string", "null"])
async def test_ack_rejects_non_integer_proofs_without_durable_side_effects(delivery, field, kind):
    client, svc, _, expert, op, ticket = delivery
    body = acknowledgement(ticket)
    body[field] = {
        "true": True, "false": False, "float": float(ticket[field]),
        "string": str(ticket[field]), "null": None,
    }[kind]
    before = observed_state(svc, expert, op)
    response = await client.post(f"/api/app-studio/deployment/client-deliveries/{ticket['id']}/ack", json=body)
    assert response.status_code == 422, response.text
    assert response.json() == {"code": "DEPLOYMENT_ACK_INVALID"}
    assert observed_state(svc, expert, op) == before
    assert expert.get("ticket", ticket["id"])["state"] == "pending"
    assert svc.deployments.journal.receipt(OWNER, op["id"]) is None


async def test_ack_accepts_exact_integers_and_replays_without_fabricating_readiness(delivery):
    client, svc, _, expert, op, ticket = delivery
    assert type(ticket["generation"]) is int and type(ticket["fence"]) is int
    route = f"/api/app-studio/deployment/client-deliveries/{ticket['id']}/ack"
    response = await client.post(route, json=acknowledgement(ticket))
    assert response.status_code == 200 and response.json() == {"accepted": True}
    assert expert.get("ticket", ticket["id"])["state"] == "prepared"
    before = observed_state(svc, expert, op)
    replay = await client.post(route, json=acknowledgement(ticket))
    assert replay.status_code == 200 and replay.json() == {"accepted": True}
    assert observed_state(svc, expert, op) == before
    assert svc.deployments.journal.receipt(OWNER, op["id"]) is None


@pytest.mark.parametrize("field", ["generation", "fence"])
async def test_ack_keeps_integer_value_mismatch_rejection(delivery, field):
    client, svc, _, expert, op, ticket = delivery
    body = acknowledgement(ticket)
    body[field] += 1
    before = observed_state(svc, expert, op)
    response = await client.post(f"/api/app-studio/deployment/client-deliveries/{ticket['id']}/ack", json=body)
    assert response.status_code == 409
    assert response.json() == {"code": "DEPLOYMENT_ACK_MISMATCH"}
    assert observed_state(svc, expert, op) == before


async def test_old_activation_ack_cannot_replace_a_new_generation(delivery, standard_setup):
    client, svc, profiles, expert, op, _ = delivery
    assert (await finish_standard(standard_setup, op))[0]["state"] == "succeeded"
    old = expert.get("ticket", identifier("", [op["id"], "activate"]))
    _, next_op = await deploy(svc, expert, standard_setup[3], "dev", "next-generation")
    assert (await finish_standard(standard_setup, next_op, launch="B" * 43))[0]["state"] == "succeeded"
    before = observed_state(svc, expert, next_op)
    response = await client.post(f"/api/app-studio/deployment/client-deliveries/{old['id']}/ack", json=acknowledgement(old))
    assert response.status_code == 409
    assert response.json() == {"code": "DEPLOYMENT_TICKET_STALE"}
    assert observed_state(svc, expert, next_op) == before
    assert profiles.find_binding(OWNER, old["slotApplicationId"])["generation"] == 2
