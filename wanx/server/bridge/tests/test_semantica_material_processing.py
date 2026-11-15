"""C4 route allowlist, strict payloads, scope and additive response forwarding."""

# ruff: noqa: F811
import json

import pytest
from test_semantica_desktop_contract import AUTH, BASE, W, claims, desktop  # noqa: F401
from wanx_bridge.semantica import conversation_contract as contract
from wanx_bridge.semantica import material_processing_contract as material
from wanx_bridge.semantica.desktop import DesktopError, resolve


@pytest.mark.parametrize("suffix", ["processing-previews", "processing-transitions"])
async def test_strict_transition_payloads_and_scope(desktop, suffix):
    client, _, _, seen, _, _ = desktop
    model = (
        material.ProcessingPreview
        if suffix.endswith("previews")
        else material.ProcessingConfirm
    )
    body = material.EXAMPLES[model]
    path = BASE + W + "/workbench/conversations/materials/document/" + suffix
    changes = [
        {"force": True},
        {"workspace_id": "other"},
        {"expected_workflow_revision": True},
        {"_native_operation_id": "mismatch"},
    ]
    if model is material.ProcessingPreview:
        changes += [{"dialogue_context": None}, {"target_mode": "dialogue"}]
    else:
        changes += [{"confirmed": False}, {"preview_digest": "bad"}]
    for change in changes:
        response = await client.post(path, headers=AUTH, json={**body, **change})
        assert response.status_code in (403, 422), response.text
    assert seen == []
    response = await client.post(path + "?workspace_id=other", headers=AUTH, json=body)
    assert response.status_code in (403, 422)


async def test_receipts_and_errors_pass_without_filtering_or_leaking_diagnostics(
    desktop,
):
    client, _, profile, seen, reply, _ = desktop
    path = (
        BASE + W + "/workbench/conversations/materials/document/processing-transitions"
    )
    payload = {
        "receipt": {
            "transition_id": "transition",
            "thinking_mode": "off",
            "publication_performed": False,
            "future_field": "preserved",
        },
        "reused": False,
    }
    reply.update(status=202, value=payload)
    result = await client.post(
        path, headers=AUTH, json=material.EXAMPLES[material.ProcessingConfirm]
    )
    assert result.status_code == 202
    assert result.json() == payload
    assert claims(seen[-1])["operation_id"] == "confirm"
    assert result.headers["cache-control"] == "no-store"
    for code in material.ERROR_CODES:
        reply.update(status=409, value={"code": code, "detail": "PRIVATE source text"})
        result = await client.post(
            path, headers=AUTH, json=material.EXAMPLES[material.ProcessingConfirm]
        )
        assert result.status_code == 409
        assert result.json()["code"] == code
        assert "PRIVATE" not in result.text
    reply.update(
        status=200,
        value={
            "receipt": payload["receipt"],
            "current": {
                "stage": "stale",
                "publication_performed": True,
                "is_current": False,
                "published_run_id": "run",
            },
        },
    )
    result = await client.get(path + "/transition", headers=AUTH)
    assert result.json() == reply["value"]
    count = len(seen)
    profile["permissions"] = []
    result = await client.get(path + "/transition", headers=AUTH)
    assert result.status_code == 403
    assert len(seen) == count


def test_new_routes_are_finite_and_have_documented_contracts():
    for method, path, _, model, _ in material.ROUTES:
        concrete = path.format(document_id="doc", transition_id="transition")
        assert resolve(method, W + concrete)
        schema = contract.schema_extra(method, path, model, {})
        assert (
            str(202 if model is material.ProcessingConfirm else 200)
            in schema["responses"]
        )
        assert "$ref" not in json.dumps(schema)
    with pytest.raises(DesktopError):
        resolve("POST", W + "/workbench/conversations/materials/doc/release-hold")


async def test_automatic_replacement_ack_is_forwarded_exactly(desktop):
    client, _, _, seen, reply, _ = desktop
    path = BASE + W + "/workbench/conversations/materials/document/processing-transitions"
    body = {**material.EXAMPLES[material.ProcessingConfirm], "replacement_acknowledgement": "b" * 64}
    reply.update(status=202, value={"receipt": {"replacement": {"requires_acknowledgement": True,
        "acknowledgement_digest": "b" * 64}}, "reused": False})
    response = await client.post(path, headers=AUTH, json=body)
    assert response.status_code == 202
    assert response.json() == reply["value"]
    assert json.loads(seen[-1].content)["replacement_acknowledgement"] == "b" * 64
    count = len(seen)
    for value in (True, "bad", 1):
        response = await client.post(path, headers=AUTH, json={**body, "replacement_acknowledgement": value})
        assert response.status_code == 422
    assert len(seen) == count
