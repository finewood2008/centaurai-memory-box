import asyncio
import json
from copy import deepcopy
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from httpx import ASGITransport, AsyncClient
from test_edits import body, pipeline, wait
from test_studio import ROOT, op, seeded
from wanx_studio.contracts import StudioError, digest
from wanx_studio.runner import Runner
from wanx_studio.service import StudioService
from wanx_studio.versions import verify
from wanx_studio.workshop import FORMAT, PREFIX, PersonalWorkshop, mount_workshop


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


async def source(svc):
    p = await seeded(svc)
    a = svc.store.get("alice", p["id"])["artifacts"][0]
    return {
        "allowed": True,
        "format": FORMAT,
        "files": a["files"],
        "sourceHash": digest(a["files"]),
        "applicationId": p["appId"],
        "version": a["version"],
        "origin": "local",
    }


async def test_copy_is_independent_atomic_idempotent_and_has_no_initial_interview(svc, workshop):
    payload = {"operationId": op(), "name": "台账 · 我的定制", "source": await source(svc)}
    a, b = await asyncio.gather(
        workshop.copy_source("alice", payload), workshop.copy_source("alice", payload)
    )
    assert a["id"] == b["id"]
    assert len(workshop.store.list("alice")) == 1
    p = workshop.store.get("alice", a["id"])
    assert p["appId"] != payload["source"]["applicationId"]
    assert p["preparation"]["references"] == []
    assert p["preparation"]["report"] is None
    assert p["preparation"]["interview"]["state"] == "completed"
    assert p["preparation"]["interview"]["turns"] == []
    assert not p.get("_runtimeModel") and not p.get("engine")
    assert p["messages"] == [] and p["_edits"]["enabled"]
    verify(p["artifacts"][0])
    assert a["workshop"]["sourceHash"] == payload["source"]["sourceHash"]
    with pytest.raises(StudioError, match="PROJECT_NOT_FOUND"):
        workshop.store.get("bob", a["id"])
    with pytest.raises(StudioError, match="OPERATION_CONFLICT"):
        await workshop.copy_source("alice", {**payload, "name": "不同请求"})


@pytest.mark.parametrize(
    ("change", "code"),
    [
        ({"allowed": False}, "WORKSHOP_MODIFICATION_NOT_ALLOWED"),
        ({"format": "native-desktop"}, "WORKSHOP_FORMAT_UNSUPPORTED"),
        ({"files": {}}, "WORKSHOP_SOURCE_REQUIRED"),
        ({"sourceHash": "0" * 64}, "WORKSHOP_SOURCE_CHANGED"),
        ({"files": {"../../secret.js": ""}}, "WORKSHOP_SOURCE_INVALID"),
    ],
)
async def test_source_rejected_without_partial_project(svc, workshop, change, code):
    value = {**await source(svc), **change}
    with pytest.raises(StudioError, match=code):
        await workshop.copy_source("alice", {"operationId": op(), "name": "副本", "source": value})
    assert workshop.store.list("alice") == []


async def test_copy_data_namespaces_preview_production_and_restore_keep_original(svc, workshop):
    s = await source(svc)
    p = await workshop.copy_source("alice", {"operationId": op(), "name": "副本", "source": s})
    second = await workshop.copy_source(
        "alice", {"operationId": op(), "name": "另一个副本", "source": s}
    )

    def adopt_and_install(p, target=workshop):
        a = p["artifacts"][-1]
        target.versions.adopt(
            "alice",
            p["id"],
            {
                "operationId": op(),
                "expectedRevision": p["versioning"]["revision"],
                "artifactHash": a["hash"],
                "confirmedByUser": True,
            },
        )
        target.installed(
            "alice",
            p["id"],
            {
                "operationId": op(),
                "artifactHash": a["hash"],
                "applicationId": p["appId"],
                "version": a["version"],
            },
        )
        return target.open_runtime("alice", p["id"], a["hash"], "production")["session"]

    from wanx_studio.store import public

    original = public(svc.store.list("alice")[0])
    original_token = adopt_and_install(original, svc)
    await svc.invoke(
        "alice",
        original_token,
        "data.put",
        {"collection": "items", "value": {"title": "原应用已有记录"}},
    )
    originals = deepcopy(svc.store.list("alice"))

    token = adopt_and_install(p)
    await workshop.invoke(
        "alice", token, "data.put", {"collection": "items", "value": {"title": "个人数据"}}
    )
    other = adopt_and_install(second)
    assert (await workshop.invoke("alice", other, "data.list", {"collection": "items"}))[
        "items"
    ] == []
    trial = workshop.open_runtime("alice", p["id"], p["artifacts"][0]["hash"], "preview")["session"]
    assert (await workshop.invoke("alice", trial, "data.list", {"collection": "items"}))[
        "items"
    ] == []
    check = workshop.versions.restore_check("alice", p["id"], p["artifacts"][0]["hash"])
    workshop.versions.restore(
        "alice", p["id"], {**check, "operationId": op(), "confirmedByUser": True}, trial=True
    )
    assert (await workshop.invoke("alice", token, "data.list", {"collection": "items"}))["items"][
        0
    ]["title"] == "个人数据"
    assert svc.store.list("alice") == originals
    assert (await svc.invoke("alice", original_token, "data.list", {"collection": "items"}))[
        "items"
    ][0]["title"] == "原应用已有记录"


async def test_personal_copy_reuses_direct_edits_queue(svc, workshop, monkeypatch):
    p = await workshop.copy_source(
        "alice", {"operationId": op(), "name": "副本", "source": await source(svc)}
    )
    # Use the existing deterministic runner adapter to exercise the real queue,
    # compile, immutable versions and preview; no external model call is claimed.
    workshop.model = object()
    pipeline.__wrapped__(workshop, monkeypatch)
    await workshop.edits.submit("alice", p["id"], body(p, "主题改成浅色"))
    r = await wait(workshop, p["id"])
    assert r["items"][0]["state"] == "completed", json.dumps(r["items"][0], ensure_ascii=False)
    assert len(r["project"]["artifacts"]) == 2
    assert r["project"]["preparation"]["interview"]["turns"] == []


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
            payload = {"operationId": op(), "name": "副本", "source": await source(svc)}
            p = (await client.post(PREFIX + "/copies", json=payload)).json()
            assert p["id"]
            await seeded(svc, "wanx:1")
            catalog = (await client.get(PREFIX + "/sources")).json()["items"]
            assert len(catalog) == 1 and "files" not in catalog[0]["source"]
            source_id = catalog[0]["id"]
            source_hash = catalog[0]["source"]["sourceHash"]
            duplicated = svc.store.get("wanx:1", source_id)
            second_version = deepcopy(duplicated["artifacts"][-1])
            second_version["version"] = "0.1.9"
            duplicated["artifacts"].append(second_version)
            svc.store.save(duplicated)
            matching = await client.get(
                PREFIX + f"/sources/{source_id}",
                params={"sourceHash": source_hash, "version": "0.1.9"},
            )
            assert matching.status_code == 200 and matching.json()["version"] == "0.1.9"
            missing = await client.get(
                PREFIX + f"/sources/{source_id}",
                params={"sourceHash": source_hash, "version": "8.8.8"},
            )
            assert missing.status_code == 409
            detail = await client.get(
                PREFIX + f"/sources/{source_id}",
                params={"sourceHash": source_hash, "version": catalog[0]["source"]["version"]},
            )
            assert detail.status_code == 200 and detail.json()["files"]
            assert (
                await client.get(
                    PREFIX + f"/sources/{source_id}",
                    params={"sourceHash": "0" * 64, "version": catalog[0]["source"]["version"]},
                )
            ).status_code == 409
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
            assert (await client.get(PREFIX + "/sources")).json()["items"] == []
            assert (
                await client.get(
                    PREFIX + f"/sources/{source_id}",
                    params={"sourceHash": source_hash, "version": catalog[0]["source"]["version"]},
                )
            ).status_code == 404
            assert (await client.get(PREFIX + "/projects/" + p["id"])).status_code == 404
            user.local_team = {}
            assert (await client.get(PREFIX + "/projects")).status_code == 403
    finally:
        await instance.close()
