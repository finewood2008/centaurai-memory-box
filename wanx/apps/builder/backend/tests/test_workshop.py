from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from httpx import ASGITransport, AsyncClient
from test_studio import ROOT, op
from wanx_studio.contracts import StudioError
from wanx_studio.runner import Runner
from wanx_studio.service import StudioService
from wanx_studio.workshop import PREFIX, PersonalWorkshop, mount_workshop


@pytest.fixture
async def svc(tmp_path):
    service = StudioService(tmp_path / "original", ROOT)
    service.runner = Runner(service)
    yield service
    await service.close()


@pytest.fixture
async def workshop(tmp_path):
    service = PersonalWorkshop(tmp_path / "workshop", ROOT)
    service.runner = Runner(service)
    yield service
    await service.close()


async def test_private_http_personal_only_no_first_build_no_cross_account(
    svc, tmp_path, monkeypatch
):
    monkeypatch.setattr("wanx_studio.wanx.WanxModels", lambda _services: None)
    from octop.api.deps import current_user

    user = SimpleNamespace(id=1, disabled=False, application_id="wanx", local_team=None)
    server = SimpleNamespace(
        paths=SimpleNamespace(root=tmp_path / "server"),
        services=SimpleNamespace(
            user_repo=SimpleNamespace(get=lambda uid: SimpleNamespace(disabled=False))
        ),
        add_shutdown_callback=lambda fn: None,
    )
    app = FastAPI()
    app.dependency_overrides[current_user] = lambda: user

    @app.exception_handler(StudioError)
    async def failure(_r, e):
        return JSONResponse({"code": e.code}, e.status)

    instance = mount_workshop(app, server, ROOT, svc)
    instance.engines.provider = None
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            c = await client.get(PREFIX + "/context")
            assert c.json()["mode"] == "workshop"
            p = instance.store.create("wanx:1", "标准项目", "维护已安装版本", op(), dev_kit=True)
            for method, route in [
                ("GET", "/sources"), ("GET", "/sources/" + p["id"]), ("POST", "/copies"),
                ("POST", "/projects/" + p["id"] + "/source-update"),
                ("GET", "/runtime/example/knowledge"), ("POST", "/runtime/example/haowen-native"),
            ]:
                assert (await client.request(method, PREFIX + route)).status_code == 404
            # Workshop management is private, owner-scoped and leaves runtime data intact.
            listing = await client.get(PREFIX + "/_management/projects")
            managed = next(x for x in listing.json()["projects"] if x["id"] == p["id"])
            archived = await client.post(PREFIX + "/_management/projects/" + p["id"], json={
                "operationId": op(), "action": "delete", "expectedRevision": managed["management"]["revision"],
            })
            assert archived.status_code == 200 and archived.json()["project"]["deletedAt"]
            assert (await client.get(PREFIX + "/projects/" + p["id"])).status_code == 404
            restored = await client.post(PREFIX + "/_management/projects/" + p["id"], json={
                "operationId": op(), "action": "restore", "expectedRevision": archived.json()["project"]["management"]["revision"],
            })
            assert restored.status_code == 200 and not restored.json()["project"]["deletedAt"]
            assert (await client.post(PREFIX + "/projects", json={})).status_code == 403
            assert (
                await client.post(PREFIX + "/projects/" + p["id"] + "/build", json={})
            ).status_code == 403
            user.id = 2
            assert (await client.get(PREFIX + "/_management/projects")).json()["projects"] == []
            assert (await client.get(PREFIX + "/projects/" + p["id"])).status_code == 404
            user.local_team = {}
            assert (await client.get(PREFIX + "/projects")).status_code == 403
    finally:
        await instance.close()
