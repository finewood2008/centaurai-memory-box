"""Page-scoped registration through the real Bridge HTTP adapter."""
# ruff: noqa: F811 - imported fixture shares its test argument name.

import copy
import json
import time

import httpx
import pytest
from fastapi import FastAPI
from test_semantica_desktop_contract import AUTH, BASE, W, claims, desktop  # noqa: F401
from wanx_bridge.semantica import modeling_contract
from wanx_bridge.semantica.desktop import DesktopError, decode, resolve


@pytest.mark.parametrize("path", ["/modeling/onboarding", W + "/modeling/suggestion-context"])
async def test_modeling_routes_work_when_bridge_is_mounted_under_a_prefix(desktop, path):
    _, _, _, seen, _, app = desktop
    parent = FastAPI()
    parent.mount("/box", app)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=parent), base_url="http://bridge"
    ) as client:
        response = await client.get("/box" + BASE + path, headers=AUTH)
    assert response.status_code == 200, response.text
    assert seen[0].url.path.startswith("/api/integration/modeling/")
    assert "/box/" not in seen[0].url.path


async def test_changed_application_identity_cannot_receive_original_personal_answers(desktop):
    client, _, profile, _, reply, _ = desktop

    async def change_identity(request):
        profile["application_id"] = "semantica"
        return httpx.Response(200, json={"answers": {"background": "private-before-switch"}})

    reply["handler"] = change_identity
    response = await client.get(BASE + "/modeling/onboarding", headers=AUTH)
    assert response.status_code == 403, response.text
    assert "private-before-switch" not in response.text


@pytest.mark.parametrize("operation", ["x" * 121, "has space", "bad/op", "bad\n"])
async def test_persisted_creation_operation_can_be_reused_as_a_write_id(desktop, operation):
    client, _, _, seen, _, _ = desktop
    body = copy.deepcopy(SAVE)
    body["answers"]["creation_operation"] = operation
    response = await client.post(BASE + "/modeling/onboarding", headers=AUTH, json=body)
    assert response.status_code == 422, response.text
    assert seen == []


@pytest.mark.parametrize("operation", ["", "x" * 120, "create-warehouse_001"])
async def test_valid_persisted_creation_operation_is_preserved(desktop, operation):
    client, _, _, seen, _, _ = desktop
    body = copy.deepcopy(SAVE)
    body["answers"]["creation_operation"] = operation
    response = await client.post(BASE + "/modeling/onboarding", headers=AUTH, json=body)
    assert response.status_code == 200
    assert json.loads(seen[0].content) == body


SAVE = {
    "operation_id": "save",
    "expected_revision": 0,
    "answers": {
        "industry": "manufacturing",
        "occupation": "legal",
        "background": "contract review",
        "purpose": "identify obligations",
        "material_types": "contracts",
        "flow_mode": "create",
        "flow_step": "confirm",
        "warehouse_name": "Contracts",
    },
}
CREATE = {
    "operation_id": "create",
    "expected_revision": 1,
    "name": "Contracts",
    "purpose": "identify obligations",
    "warehouse_scope": {
        "industry": "manufacturing",
        "occupation": "legal",
        "background": "warehouse business scope",
        "material_types": "contracts",
        "questions": "Which obligations are overdue?",
    },
}
CONFIRM = {
    "operation_id": "confirm",
    "expected_revision": 1,
    "onboarding_revision": 2,
    "answers": {"industry": "manufacturing", "occupation": "legal", "purpose": "obligations"},
}
GENERATE = {
    "operation_id": "generate",
    "confirmation_id": "confirmation-a",
    "base_ontology_id": "ontology-a",
}
CASES = [
    ("GET", "/modeling/onboarding", None),
    ("POST", "/modeling/onboarding", SAVE),
    ("GET", "/modeling/warehouses", None),
    ("POST", "/modeling/onboarding/onboard-a/warehouse", CREATE),
    ("GET", W + "/modeling/suggestion-context", None),
    ("POST", W + "/modeling/answer-confirmations", CONFIRM),
    ("POST", W + "/modeling/answer-suggestions", GENERATE),
    ("GET", W + "/modeling/answer-suggestions/proposal-a", None),
]


@pytest.mark.parametrize(
    "scope",
    [
        {"industry": "x" * 201},
        {"occupation": 42},
        {"actor_id": "other"},
        {"permissions": ["write"]},
    ],
)
async def test_warehouse_scope_is_bounded_and_cannot_inject_identity(desktop, scope):
    client, _, _, seen, _, _ = desktop
    response = await client.post(
        BASE + "/modeling/onboarding/onboard-a/warehouse",
        headers=AUTH,
        json={**CREATE, "warehouse_scope": scope},
    )
    assert response.status_code in (403, 422)
    assert seen == []


async def test_name_only_creation_preserves_legacy_wire_body(desktop):
    client, _, _, seen, _, _ = desktop
    body = {k: v for k, v in CREATE.items() if k != "warehouse_scope"}
    response = await client.post(
        BASE + "/modeling/onboarding/onboard-a/warehouse", headers=AUTH, json=body
    )
    assert response.status_code == 200
    assert json.loads(seen[-1].content) == body


@pytest.mark.parametrize("method,path,body", CASES)
async def test_exact_routes_use_actual_actor_scope_and_unchanged_body(desktop, method, path, body):
    client, _, _, seen, _, _ = desktop
    response = await client.request(
        method,
        BASE + path,
        headers={**AUTH, "x-semantica-scope": "forged", "cookie": "private=secret"},
        json=body,
    )
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert len(seen) == 1
    request = seen[0]
    grant = claims(request)
    assert grant["actor_id"] == "wanx:7"
    assert grant["operation_id"] == (body or {}).get("operation_id")
    assert "cookie" not in request.headers
    if path.startswith(W):
        assert (
            request.url.path
            == "/api/integration/modeling/warehouses/"
            + grant["workspace_id"]
            + path.split("/modeling", 1)[1]
        )
        assert grant["workspace_bindings"][grant["workspace_id"]].endswith(
            W.replace("/warehouses/", ":warehouse:")
        )
    else:
        assert request.url.path == "/api/integration" + path
        assert grant["workspace_bindings"][grant["workspace_id"]] == "personal:wanx:7"
    assert (json.loads(request.content) if body else None) == body
    if body == GENERATE:
        assert request.extensions["timeout"]["read"] == 285
        assert 290 < grant["expires_at"] - time.time() <= 300


@pytest.mark.parametrize("method,path,body", CASES)
async def test_team_is_not_silently_reinterpreted_as_personal(desktop, method, path, body):
    client, _, _, seen, _, _ = desktop
    response = await client.request(
        method, BASE + path, headers={**AUTH, "x-wanx-data-context": "team"}, json=body
    )
    assert response.status_code == 403
    assert response.json()["code"] == "MODELING_HOST_CREATION_REQUIRED"
    assert seen == []


@pytest.mark.parametrize(
    "method,path",
    [
        ("GET", "/modeling/suggestion-context"),
        ("POST", "/modeling/answer-suggestions"),
        ("GET", W + "/modeling/onboarding"),
        ("POST", W + "/modeling/onboarding/onboard-a/warehouse"),
        ("DELETE", W + "/modeling/rule-previews"),
        ("PUT", W + "/modeling/rule-previews/draft/publish"),
        ("GET", W + "/modeling/impact-preview"),
        ("DELETE", W + "/workbench/conversations"),
        ("GET", "/open/v1/modeling/onboarding"),
        ("GET", "/modeling/warehouses/any/suggestion-context"),
        ("DELETE", "/modeling/onboarding"),
        ("PUT", W + "/modeling/answer-suggestions"),
        ("POST", W + "/modeling/answer-suggestions/proposal-a"),
    ],
)
async def test_other_pages_and_unregistered_methods_remain_denied(desktop, method, path):
    client, _, _, seen, _, _ = desktop
    response = await client.request(
        method, BASE + path, headers=AUTH, json=None if method == "GET" else GENERATE
    )
    assert response.status_code in {404, 405}
    assert seen == []


@pytest.mark.parametrize(
    "change",
    [
        {"actor_id": "other"},
        {"workspace_id": "foreign"},
        {"expected_revision": True},
        {"operation_id": ""},
        {"operation_id": "x" * 121},
        {"operation_id": "has space"},
        {"answers": {"industry": "x" * 201}},
        {"answers": {"occupation": ["legal"]}},
        {"answers": {"principal_key": "foreign"}},
        {"answers": {"workspace_id": "foreign"}},
        {"_native_operation_id": "different"},
        {"status": "unknown"},
    ],
)
async def test_invalid_fields_never_reach_owner(desktop, change):
    client, _, _, seen, _, _ = desktop
    response = await client.post(
        BASE + "/modeling/onboarding", headers=AUTH, json=copy.deepcopy(SAVE) | change
    )
    assert response.status_code in {403, 422}
    assert seen == []


@pytest.mark.parametrize("query", ["?limit=20", "?workspace_id=foreign", "?x=1&x=2"])
async def test_query_is_not_a_scope_or_unbounded_registration(desktop, query):
    client, _, _, seen, _, _ = desktop
    response = await client.get(BASE + "/modeling/onboarding" + query, headers=AUTH)
    assert response.status_code == 422
    assert seen == []


async def test_origin_body_limit_and_live_identity(desktop):
    client, _, profile, seen, _, _ = desktop
    path = BASE + "/modeling/onboarding"
    assert (await client.get(path, headers={**AUTH, "origin": "http://bridge"})).status_code == 403
    assert (
        await client.post(
            path,
            headers={**AUTH, "content-type": "application/json"},
            content=b" " * (128 * 1024 + 1),
        )
    ).status_code == 413
    assert (await client.get(path)).status_code in {401, 403}
    profile["permissions"] = []
    assert (await client.get(path, headers=AUTH)).status_code == 403
    assert seen == []


@pytest.mark.parametrize("code", sorted(modeling_contract.ERROR_CODES))
def test_registered_errors_preserve_code_without_private_diagnostics(code):
    raw = json.dumps({"code": code, "detail": "private raw answers", "message": "secret"}).encode()
    with pytest.raises(DesktopError) as caught:
        decode(409, raw, modeling=True)
    assert caught.value.code == code and caught.value.message is None
    with pytest.raises(DesktopError) as caught:
        decode(409, raw)
    assert caught.value.code == "SEMANTICA_VERSION_CONFLICT"  # Existing operations are unchanged.


async def test_openapi_preserves_the_eight_onboarding_operations(desktop):
    client, _, _, _, _, app = desktop
    schema = app.openapi()
    paths = {BASE + route for _, route, _, _ in modeling_contract.API_ROUTES}
    selected = {path: operations for path, operations in schema["paths"].items() if path in paths}
    assert sum(len(operations) for operations in selected.values()) == 8
    save = selected[BASE + "/modeling/onboarding"]["post"]
    assert (
        save["requestBody"]["content"]["application/json"]["schema"]["properties"]["answers"][
            "properties"
        ]["industry"]["maxLength"]
        == 200
    )
    assert "$ref" not in json.dumps(save["requestBody"])
    assert resolve("POST", W + "/modeling/answer-suggestions").body_limit == 128 * 1024
