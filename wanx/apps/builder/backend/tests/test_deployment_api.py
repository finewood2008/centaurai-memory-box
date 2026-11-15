import json
import asyncio
from contextlib import asynccontextmanager
from pathlib import Path
import sqlite3
from types import SimpleNamespace
from unittest.mock import Mock

from fastapi import APIRouter, FastAPI, Request
from fastapi.responses import JSONResponse
from httpx import ASGITransport, AsyncClient
import pytest

from wanx_studio.contracts import StudioError
from wanx_studio.deployment.adapters import Blocked, UnavailableAdapter
from wanx_studio.deployment.api import BODY_LIMIT, mount
from wanx_studio.deployment.coordinator import Coordinator

PREFIX = "/api/app-studio/deployment"
FIXTURES = Path(__file__).parent / "fixtures" / "deployment"
TARGET = "organizationId=org-demo&boxId=box-demo&applicationId=app-demo&environment=prod"


def sample(name):
    return json.loads((FIXTURES / name).read_text())


def stop_request():
    return dict(sample("stop.request.json"), expectedGeneration=0)


class Authority(UnavailableAdapter):
    available = True

    def __init__(self):
        self.delivered = []

    async def authorize(self, owner, target, action):
        if target["boxId"] == "forbidden":
            raise Blocked("DEPLOYMENT_TARGET_DENIED")

    async def verify_release(self, owner, bundle):
        return None

    async def deliver(self, receipt):
        self.delivered.append(receipt["receiptId"])
        return receipt["receiptId"]


@pytest.fixture
async def api(tmp_path):
    adapter = Authority()
    deployments = Coordinator(tmp_path, adapter, clock=lambda: 100)
    # Keep accepted operations queued; worker behavior has its own integration tests.
    deployments.start = Mock()
    authorized = []

    def authorize(owner):
        if owner == "blocked":
            raise StudioError("STUDIO_IDENTITY_FORBIDDEN", 403)
        authorized.append(owner)

    svc = SimpleNamespace(deployments=deployments, authorize_management=authorize)
    app, router = FastAPI(), APIRouter(prefix="/api/app-studio")

    async def identity(request: Request):
        owner = request.headers.get("x-owner")
        if not owner:
            raise StudioError("IDENTITY_REQUIRED", 401)
        return owner

    @app.exception_handler(StudioError)
    async def studio_error(request, error):
        return JSONResponse({"code": error.code}, status_code=error.status)

    mount(router, svc, identity)
    app.include_router(router)
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test", headers={"x-owner": "alice"}) as client:
            yield client, deployments, adapter, authorized
    finally:
        await deployments.close()


async def create_operation(client):
    registered = await client.post(PREFIX + "/releases", json=sample("managed-spec.bundle.json"))
    assert registered.status_code == 200, registered.text
    response = await client.post(PREFIX + "/operations", json=dict(sample("deploy.request.json"), expectedGeneration=0))
    assert response.status_code == 202, response.text
    return response.json()


async def test_accepted_operations_are_durable_and_resume_preserves_original_request(api):
    client, deployments, _, _ = api
    operation = await create_operation(client)
    assert operation["state"] == "queued"
    assert not {"owner", "request", "requestHash", "checkpoint", "leaseOwner", "fence"}.intersection(operation)
    url = PREFIX + "/operations/" + operation["id"]
    original = deployments.journal.get_operation("alice", operation["id"])
    assert (await client.get(url)).json() == operation
    resumed = await client.post(url + "/resume", json={})
    assert resumed.status_code == 202
    assert resumed.json() == operation
    assert deployments.journal.get_operation("alice", operation["id"]) == original
    assert (await client.post(PREFIX + "/operations", json=dict(sample("deploy.request.json"), expectedGeneration=0))).json() == operation
    assert (await client.get(PREFIX + "/operations?" + TARGET + "&limit=1")).json() == {"items": [operation]}
    assert (await client.get(url + "/receipt")).json() is None
    page = (await client.get(url + "/events?after=0&limit=1")).json()
    assert page["items"][0]["sequence"] == 1
    assert (await client.get(url + "/events?after=9007199254740991")).status_code == 200
    environment = await client.get(PREFIX + "/environments?" + TARGET)
    assert environment.status_code == 200
    assert environment.json()["generation"] == 0


async def test_default_adapter_reports_unavailable_without_accepting_side_effects(api):
    client, deployments, _, _ = api
    deployments.adapter = UnavailableAdapter()
    assert (await client.get(PREFIX + "/capabilities")).json()["available"] is False
    for path, body in [("/operations", sample("deploy.request.json")), ("/releases", sample("managed-spec.bundle.json"))]:
        response = await client.post(PREFIX + path, json=body)
        assert response.status_code == 503
        assert response.json() == {"code": "DEPLOYMENT_ADAPTER_UNAVAILABLE"}
    assert deployments.operations("alice") == []
    deployments.start.assert_not_called()


async def test_release_registration_validates_contract_and_is_owner_scoped(api):
    client, deployments, _, _ = api
    bundle = sample("managed-spec.bundle.json")
    response = await client.post(PREFIX + "/releases", json=bundle)
    assert response.status_code == 200
    assert response.json() == bundle
    assert deployments.journal.release("alice", bundle["applicationId"], bundle) == bundle
    with pytest.raises(StudioError):
        deployments.journal.release("bob", bundle["applicationId"], bundle)
    for path, body in [("/releases", dict(bundle, privateSecret="secret-marker")),
                       ("/operations", dict(stop_request(), owner="secret-marker"))]:
        response = await client.post(PREFIX + path, json=body)
        assert response.status_code == 422
        assert "secret-marker" not in response.text


ROUTES = [("GET", "/capabilities"), ("POST", "/releases"), ("POST", "/operations"),
          ("GET", "/operations"), ("GET", "/environments?" + TARGET),
          ("GET", "/operations/{id}"), ("GET", "/operations/{id}/events"),
          ("GET", "/operations/{id}/receipt"), ("POST", "/operations/{id}/resume"),
          ("POST", "/operations/{id}/receipt/retry")]


@pytest.mark.parametrize("method,path", ROUTES)
async def test_every_route_requires_identity_and_management_authorization(api, method, path):
    client, _, _, authorized = api
    path = PREFIX + path.replace("{id}", "a" * 32)
    response = await client.request(method, path, headers={"x-owner": "blocked"})
    assert response.status_code == 403
    client.headers.pop("x-owner")
    response = await client.request(method, path)
    assert response.status_code == 401
    assert authorized == []


async def test_foreign_owners_cannot_read_resume_or_redeliver_operations(api):
    client, _, adapter, _ = api
    operation = await create_operation(client)
    url = PREFIX + "/operations/" + operation["id"]
    for method, suffix in [("GET", ""), ("GET", "/events"), ("GET", "/receipt"),
                           ("POST", "/resume"), ("POST", "/receipt/retry")]:
        response = await client.request(method, url + suffix, headers={"x-owner": "bob"})
        assert response.status_code == 404, response.text
    assert (await client.get(PREFIX + "/operations", headers={"x-owner": "bob"})).json() == {"items": []}
    assert adapter.delivered == []
    response = await client.get(PREFIX + "/environments?" + TARGET.replace("box-demo", "forbidden"))
    assert response.status_code == 403


@pytest.mark.parametrize("content", [b'{"kind":"stop","kind":"deploy"}', b'{"x":{"y":1,"y":2}}',
                                     b'{"x":NaN}', b'{"x":Infinity}', b'{"x":-Infinity}',
                                     b'{"x":', b'[]', b'null', b'"secret-marker"', b'\xff', b''])
async def test_strict_json_rejects_invalid_and_duplicate_keys_without_echoing_input(api, content):
    client, deployments, _, _ = api
    for path in ["/operations", "/releases"]:
        response = await client.post(PREFIX + path, content=content)
        assert response.status_code == 422
        assert response.json() == {"code": "DEPLOYMENT_BODY_INVALID"}
    deployments.start.assert_not_called()


async def test_body_limit_applies_to_streamed_content_without_content_length(api):
    client, deployments, _, _ = api

    async def content():
        yield b'{"secret":"'
        for _ in range(17):
            yield b"a" * 65536
        yield b'"}'

    response = await client.post(PREFIX + "/operations", content=content())
    assert response.status_code == 413
    assert response.json() == {"code": "DEPLOYMENT_BODY_TOO_LARGE"}
    assert BODY_LIMIT == 1024 * 1024
    deployments.start.assert_not_called()


@pytest.mark.parametrize("path", [
    "/capabilities?x=secret-marker", "/operations?limit=0", "/operations?limit=101",
    "/operations?limit=01", "/operations?limit=1&limit=2", "/operations?boxId=box",
    "/operations?constructor=x", "/operations?__proto__=x", "/environments",
    "/environments?" + TARGET + "&boxId=box", "/environments?" + TARGET + "&limit=1",
    "/environments?" + TARGET.replace("prod", "production"),
    "/environments?" + TARGET.replace("box-demo", "_box"),
    "/environments?" + TARGET.replace("box-demo", "a" * 129),
    "/environments?" + TARGET.replace("box-demo", "box%2Fother"),
    "/operations/{id}/events?after=-1", "/operations/{id}/events?after=9007199254740992",
    "/operations/{id}/events?after=1e2", "/operations/{id}/events?after=01",
    "/operations/{id}/events?after=0&after=1", "/operations/{id}/events?limit=0",
    "/operations/{id}/events?limit=101", "/operations/{id}/events?secret=secret-marker",
    "/operations/{id}/receipt?limit=1", "/operations/{id}?after=0",
])
async def test_query_whitelist_matches_the_renderer_bridge(api, path):
    client, deployments, _, _ = api
    response = await client.get(PREFIX + path.replace("{id}", "a" * 32))
    assert response.status_code == 422
    assert response.json() == {"code": "DEPLOYMENT_QUERY_INVALID"}
    deployments.start.assert_not_called()


async def test_mutations_reject_query_parameters_and_resume_cannot_change_body(api):
    client, deployments, _, _ = api
    operation = await create_operation(client)
    url = PREFIX + "/operations/" + operation["id"]
    before = deployments.journal.get_operation("alice", operation["id"])
    for path in [PREFIX + "/releases", PREFIX + "/operations", url + "/resume", url + "/receipt/retry"]:
        assert (await client.post(path + "?x=secret-marker", json={})).json() == {"code": "DEPLOYMENT_QUERY_INVALID"}
    for suffix in ["/resume", "/receipt/retry"]:
        for body in [{"target": {"boxId": "other"}}, {"idempotencyKey": "changed"}, [], None]:
            response = await client.post(url + suffix, content=json.dumps(body))
            assert response.status_code == 422
    assert deployments.journal.get_operation("alice", operation["id"]) == before


async def test_receipt_retry_only_redelivers_and_never_restarts_deployment(api):
    client, deployments, adapter, _ = api
    operation = await create_operation(client)
    journal = deployments.journal
    op = journal.claim(operation["id"], "fixture", 100, 30)
    op["state"] = "rejected"
    receipt = {"receiptId": "receipt-demo", "operationId": op["id"], "operationRevision": op["revision"] + 1,
               "kind": op["request"]["kind"], "target": op["target"], "outcome": "rejected",
               "commitStatus": op["commitStatus"], "committedGeneration": None, "previousGeneration": 0,
               "environmentRevision": journal.get_environment(op["target"])["revision"]}
    done = journal.save(op, "fixture", op["fence"], 100, receipt=receipt)
    deployments.start.reset_mock()
    url = PREFIX + "/operations/" + operation["id"] + "/receipt/retry"
    response = await client.post(url, json={})
    assert response.status_code == 200
    assert response.json()["deliveryStatus"] == "delivered"
    assert response.json()["receipt"] == receipt
    assert (await client.post(url)).status_code == 200
    assert adapter.delivered == ["receipt-demo"]
    assert journal.get_operation("alice", op["id"]) == done
    deployments.start.assert_not_called()


async def test_receipt_retry_leaves_other_owners_outbox_pending(api):
    client, deployments, adapter, _ = api
    operations = {}
    for owner in ["alice", "bob"]:
        client.headers["x-owner"] = owner
        operation = await create_operation(client)
        operations[owner] = operation
        journal = deployments.journal
        op = journal.claim(operation["id"], "fixture", 100, 30)
        op["state"] = "rejected"
        receipt = {"receiptId": "receipt-" + owner, "operationId": op["id"], "operationRevision": op["revision"] + 1,
                   "kind": op["request"]["kind"], "target": op["target"], "outcome": "rejected",
                   "commitStatus": op["commitStatus"], "committedGeneration": None, "previousGeneration": 0,
                   "environmentRevision": journal.get_environment(op["target"])["revision"]}
        journal.save(op, "fixture", op["fence"], 100, receipt=receipt)
    client.headers["x-owner"] = "alice"
    url = PREFIX + "/operations/" + operations["alice"]["id"] + "/receipt/retry"
    response = await client.post(url)
    assert response.status_code == 200
    assert response.json()["deliveryStatus"] == "delivered"
    assert adapter.delivered == ["receipt-alice"]
    untouched = deployments.journal.receipt("bob", operations["bob"]["id"])
    assert untouched["deliveryStatus"] == "pending"
    assert untouched["attempts"] == 0


@pytest.mark.parametrize("method,path", [("POST", "/recover"), ("POST", "/admin"),
    ("POST", "/executor"), ("POST", "/operations/" + "a" * 32 + "/recover"),
    ("PUT", "/operations"), ("DELETE", "/operations/" + "a" * 32), ("GET", "/releases")])
async def test_no_executor_recovery_or_wrong_method_routes(api, method, path):
    client, _, _, _ = api
    response = await client.request(method, PREFIX + path)
    assert response.status_code in {404, 405}


@pytest.mark.parametrize("operation_id", ["A" * 32, "a" * 31, "a" * 33, "dep_" + "a" * 32, "secret-marker"])
async def test_operation_id_format_is_checked_without_echoing_input(api, operation_id):
    client, deployments, _, _ = api
    for method, suffix in [("GET", ""), ("GET", "/events"), ("GET", "/receipt"),
                           ("POST", "/resume"), ("POST", "/receipt/retry")]:
        response = await client.request(method, PREFIX + "/operations/" + operation_id + suffix)
        assert response.status_code == 422
        assert response.json() == {"code": "DEPLOYMENT_OPERATION_ID_INVALID"}
    deployments.start.assert_not_called()


@pytest.mark.parametrize("personal,prefix", [(False, "/api/app-studio"), (True, "/api/_client/workshop")])
async def test_real_service_router_lifecycle_and_enterprise_personal_prefixes(tmp_path, personal, prefix):
    from wanx_studio.api import create_router
    from wanx_studio.service import StudioService
    from wanx_studio.workshop import PersonalWorkshop

    service_type = PersonalWorkshop if personal else StudioService
    root, project_root = tmp_path / "state", Path(__file__).resolve().parents[2]
    service = service_type(root, project_root)

    async def identity():
        return "alice"

    @asynccontextmanager
    async def lifespan(app):
        try:
            yield
        finally:
            await service.close()

    app = FastAPI(lifespan=lifespan)
    app.include_router(create_router(service, identity, prefix=prefix))
    try:
        assert service.deployments._task is None
        async with app.router.lifespan_context(app):
            task = service.deployments._task
            assert task is not None
            await asyncio.sleep(0)
            assert not task.done()
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                response = await client.get(prefix + "/deployment/capabilities")
                assert response.status_code == 200
                assert response.json()["available"] is False
                assert response.json()["reason"] == "DEPLOYMENT_ADAPTER_UNAVAILABLE"
                assert (await client.get(prefix + "/deployment/operations")).json() == {"items": []}
                other_prefix = "/api/app-studio" if personal else "/api/_client/workshop"
                assert (await client.get(other_prefix + "/deployment/capabilities")).status_code == 404
        assert task.done()
        assert service.lease.closed
        with pytest.raises(sqlite3.ProgrammingError):
            service.deployments.operations("alice")
    finally:
        await service.close()
    # Closing both the journal and the service lock permits a clean restart.
    reopened = service_type(root, project_root)
    try:
        assert reopened.deployments.operations("alice") == []
    finally:
        await reopened.close()
