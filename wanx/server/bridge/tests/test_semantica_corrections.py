"""Correction DTOs use the same finite warehouse boundary as the real ba5 API."""
# ruff: noqa: F811 - imported pytest fixtures share test parameter names.

import json
from urllib.parse import parse_qsl, urlsplit

import pytest
from test_semantica_desktop_contract import (
    AUTH,
    BASE,
    W,
    claims,
    desktop,  # noqa: F401
)

ROOT = "/documents/doc-a/corrections"
READS = [
    "/events?after_id=1&limit=20",
    "/events/1?offset=0&limit=20",
    "/draft-a",
    "/draft-a/items?revision=1&kind=entity&keyword=synthetic&offset=0&limit=20",
    "/draft-a/items/item-a?revision=1",
    "/draft-a/items/item-a/relations?revision=1&offset=0&limit=20",
    "/draft-a/sources?revision=1&offset=0&limit=20",
    "/draft-a/sources/segment-a?revision=1&start=5",
    "/draft-a/preview?revision=1&offset=0&limit=20",
    "/draft-a/suggestions?revision=1&kind=relation&offset=0&limit=20",
    "/draft-a/extraction-results?revision=1&kind=entity&offset=0&limit=20",
    "/draft-a/publication",
]
WRITES = [
    "",
    "/draft-a/rules",
    "/draft-a/apply",
    "/draft-a/save",
    "/draft-a/discard",
    "/draft-a/submit",
    "/draft-a/rebase",
    "/draft-a/ontology",
    "/draft-a/extraction-results/adopt",
    "/draft-a/suggestions/adopt",
    "/draft-a/publication/retry",
    "/draft-a/items/item-a/reset",
]


@pytest.mark.parametrize("suffix", READS)
async def test_correction_reads_preserve_only_the_endpoint_query_contract(desktop, suffix):
    client, _, _, seen, _, _ = desktop
    response = await client.get(BASE + W + "/workbench" + ROOT + suffix, headers=AUTH)
    assert response.status_code == 200
    outgoing = seen[0]
    target = urlsplit(ROOT + suffix)
    assert outgoing.url.path == "/api/integration/workbench" + target.path
    assert dict(outgoing.url.params) == dict(parse_qsl(target.query))
    grant = claims(outgoing)
    assert grant["actor_id"] == "wanx:7"
    assert grant["permissions"] == ["read"]
    assert grant["operation_id"] is None
    assert grant["owner_view"] is False
    assert len(grant["workspace_bindings"]) == 1


@pytest.mark.parametrize("suffix", WRITES)
async def test_correction_writes_preserve_signed_operation_and_domain_payload(desktop, suffix):
    client, _, _, seen, _, _ = desktop
    body = {"operation_id": "correction-op", "_native_operation_id": "correction-op"}
    response = await client.post(BASE + W + "/workbench" + ROOT + suffix, headers=AUTH, json=body)
    assert response.status_code == 200
    assert json.loads(seen[0].content) == body
    grant = claims(seen[0])
    assert grant["permissions"] == ["read", "write"]
    assert grant["operation_id"] == body["operation_id"]


@pytest.mark.parametrize(
    "suffix",
    [
        "/events?revision=1",
        "/events?offset=0",
        "/events/1?after_id=1",
        "/draft-a?revision=1",
        "/draft-a/items?start=0",
        "/draft-a/items/item-a?kind=entity",
        "/draft-a/items/item-a/relations?keyword=x",
        "/draft-a/sources?start=0",
        "/draft-a/sources/segment-a?limit=20",
        "/draft-a/preview?keyword=x",
        "/draft-a/suggestions?start=0",
        "/draft-a/extraction-results?summary=true",
        "/draft-a/publication?revision=1",
        "/draft-a/items?workspace_id=foreign",
        "/draft-a/items?revision=1&revision=2",
    ],
)
async def test_correction_query_keys_do_not_leak_between_endpoints(desktop, suffix):
    client, _, _, seen, _, _ = desktop
    response = await client.get(BASE + W + "/workbench" + ROOT + suffix, headers=AUTH)
    assert response.status_code == 422
    assert seen == []


@pytest.mark.parametrize(
    "path,body,status",
    [
        (ROOT, {"_native_operation_id": "op", "operation_id": "other"}, 422),
        (ROOT, {"_native_operation_id": "op", "workspace_id": "foreign"}, 403),
        (ROOT, {"_native_operation_id": "op", "payload": {"actor_id": "wanx:1"}}, 403),
        (ROOT, {"operation_id": "unsigned"}, 422),
        (ROOT + "?revision=1", {"_native_operation_id": "op"}, 422),
        ("/documents/doc-a/knowledge-corrections", {"_native_operation_id": "op"}, 404),
        (ROOT + "/draft-a/unknown", {"_native_operation_id": "op"}, 404),
    ],
)
async def test_correction_writes_keep_scope_body_and_route_guards(desktop, path, body, status):
    client, _, _, seen, _, _ = desktop
    response = await client.post(BASE + W + "/workbench" + path, headers=AUTH, json=body)
    assert response.status_code == status
    assert seen == []


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
async def test_native_correction_errors_keep_domain_code_and_status_without_diagnostics(
    desktop, status, code
):
    client, _, _, seen, reply, _ = desktop
    reply.update(
        status=status,
        value={
            "code": code,
            "detail": "private backend diagnostic",
            "message": "private backend message",
            "stack": "private stack",
        },
    )
    response = await client.get(BASE + W + "/workbench" + ROOT + "/draft-a", headers=AUTH)
    assert response.status_code == status
    assert response.json() == {"code": code, "message": None}
    assert len(seen) == 1


@pytest.mark.parametrize("code", ["PRIVATE_BACKEND_FAILURE", {"private": "diagnostic"}])
async def test_native_unknown_error_format_stays_a_sanitized_service_failure(desktop, code):
    client, _, _, _, reply, _ = desktop
    reply.update(status=500, value={"code": code, "detail": "private diagnostic"})
    response = await client.get(BASE + W + "/workbench" + ROOT + "/draft-a", headers=AUTH)
    assert response.status_code == 503
    assert response.json() == {"code": "SEMANTICA_SERVICE_ERROR", "message": None}


@pytest.mark.parametrize("public", [False, True])
async def test_other_and_open_api_errors_do_not_gain_workbench_domain_passthrough(desktop, public):
    client, _, _, _, reply, _ = desktop
    reply.update(status=409, value={"code": "CORRECTION_REVISION_CONFLICT", "detail": "private"})
    path = "/open/v1/documents" if public else W + "/documents"
    headers = {**AUTH, "x-xingtu-key": "xg_" + "a" * 40} if public else AUTH
    response = await client.get(BASE + path, headers=headers)
    assert response.status_code == 409
    assert response.json() == {"code": "SEMANTICA_VERSION_CONFLICT", "message": None}
