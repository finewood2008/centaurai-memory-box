"""Private model settings and authorization for standard application artifacts."""
import asyncio
from copy import deepcopy
from pathlib import Path
import threading
from types import SimpleNamespace
from uuid import uuid4

from fastapi import APIRouter, FastAPI
from httpx import ASGITransport, AsyncClient
import pytest

from standard_build_fixture import seeded
from wanx_studio.contracts import StudioError
from wanx_studio.delivery import mount, read, save
from wanx_studio.local_authority import Actor, _actor
from wanx_studio.service import StudioService
from wanx_studio.store import public

ROOT = Path(__file__).resolve().parents[2]


class Models:
    def __init__(self):
        self.enabled = {"one", "two"}
        self.calls = []

    def runtime_catalog(self):
        return {
            "models": [
                {"id": key, "name": key, "provider": "WANX"} for key in sorted(self.enabled)
            ],
            "defaultId": "one",
        }

    async def __call__(self, owner, body):
        self.calls.append(owner)
        return {"choices": [{"message": {"content": "default"}}]}


@pytest.fixture
async def fixture(tmp_path):
    models = Models()
    svc = StudioService(tmp_path, ROOT, models)
    try:
        project = await seeded(svc, "admin")
        yield svc, models, project
    finally:
        await svc.close()


async def test_standard_artifact_cannot_enable_a_private_model_or_change_project(fixture):
    svc, models, project = fixture
    pid = project["id"]
    before = svc.store.get("admin", pid)
    assert read(svc, "admin", pid)["usesModel"] is False
    for environment in (None, "deployment:dev", "deployment:prod"):
        with pytest.raises(StudioError, match="RUNTIME_MODEL_NOT_USED"):
            save(svc, "admin", pid, {
                "operationId": uuid4().hex, "expectedRevision": 0, "modelId": "two",
            }, environment=environment)
        value = read(svc, "admin", pid, environment=environment)
        assert value["revision"] == 0 and value["modelId"] is None
    assert svc.store.get("admin", pid) == before
    assert models.runtime_catalog()["defaultId"] == "one"


async def test_standard_preview_denies_direct_model_execution(fixture):
    svc, models, project = fixture
    opened = svc.open_runtime("admin", project["id"], project["artifacts"][0]["hash"], "preview")
    with pytest.raises(StudioError, match="EXPERT_DEPLOYMENT_REQUIRED"):
        await svc.invoke("admin", opened["session"], "model.generate", {"prompt": "hello"})
    assert models.calls == []


async def test_private_settings_revalidate_catalog_and_remain_environment_scoped_after_restart(fixture):
    svc, models, project = fixture
    pid = project["id"]
    # Existing installations may already have preferences stored for each scope.
    stored = svc.store.get("admin", pid)
    stored["_runtimeModel"] = {"revision": 3, "modelId": "two"}
    stored["_runtimeModels"] = {
        "deployment:dev": {"revision": 1, "modelId": "one"},
        "deployment:prod": {"revision": 2, "modelId": "two"},
    }
    svc.store.save(stored)
    assert {"_runtimeModel", "_runtimeModels"}.isdisjoint(public(deepcopy(stored)))
    root = svc.store.root
    await svc.close()
    reopened = StudioService(root, ROOT, models)
    try:
        models.enabled.remove("two")
        for environment, revision, model_id, available in (
            (None, 3, "two", False),
            ("deployment:dev", 1, "one", True),
            ("deployment:prod", 2, "two", False),
        ):
            value = read(reopened, "admin", pid, environment=environment)
            assert (value["revision"], value["modelId"], value["available"]) == (revision, model_id, available)
    finally:
        await reopened.close()


async def test_private_settings_require_project_ownership_and_admin_authority(fixture):
    svc, _, project = fixture
    pid = project["id"]
    body = {"operationId": uuid4().hex, "expectedRevision": 0, "modelId": "two"}
    with pytest.raises(StudioError, match="PROJECT_NOT_FOUND"):
        read(svc, "other", pid)
    svc.team = SimpleNamespace(is_admin=lambda owner: owner == "admin")
    with pytest.raises(StudioError, match="STUDIO_ADMIN_REQUIRED"):
        read(svc, "member", pid)
    with pytest.raises(StudioError, match="STUDIO_ADMIN_REQUIRED"):
        save(svc, "member", pid, body)
    assert read(svc, "admin", pid)["revision"] == 0


async def test_private_catalog_read_does_not_return_after_local_revoke(fixture, monkeypatch):
    svc, models, project = fixture
    started, release = threading.Event(), threading.Event()
    revoked = False
    catalog = models.runtime_catalog

    def paused():
        started.set()
        assert release.wait(3)
        return catalog()

    def check():
        if revoked:
            raise RuntimeError("revoked")

    monkeypatch.setattr(models, "runtime_catalog", paused)
    app, router = FastAPI(), APIRouter()
    mount(router, svc, lambda: "admin")
    app.include_router(router)
    actor_token = _actor.set(Actor(None, None, SimpleNamespace(require_live=check)))
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            pending = asyncio.create_task(client.get(f"/_client/projects/{project['id']}/runtime-model"))
            try:
                assert await asyncio.to_thread(started.wait, 2)
                revoked = True
            finally:
                release.set()
            with pytest.raises(RuntimeError, match="revoked"):
                await pending
        assert models.calls == []
    finally:
        _actor.reset(actor_token)
