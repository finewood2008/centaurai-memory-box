from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from standard_build_fixture import seeded
from test_studio import ROOT, op
from test_workshop_model import DefaultModels
from wanx_studio.contracts import StudioError
from wanx_studio.workshop import PersonalWorkshop


@pytest.fixture
async def installed(tmp_path):
    files = AsyncMock(return_value=[{"id": "private", "name": "私人.txt", "text": "private"}])
    svc = PersonalWorkshop(tmp_path, ROOT, DefaultModels(), files)
    svc.knowledge_provider = SimpleNamespace(catalog=AsyncMock(), read=AsyncMock())
    try:
        project = await seeded(svc)
        artifact = project["artifacts"][0]
        svc.versions.adopt("alice", project["id"], {
            "artifactHash": artifact["hash"], "operationId": op(),
            "expectedRevision": project["versioning"]["revision"], "confirmedByUser": True,
        })
        svc.installed("alice", project["id"], {
            "artifactHash": artifact["hash"], "operationId": op(),
            "applicationId": project["appId"], "version": artifact["version"],
        })
        yield svc, project, artifact
    finally:
        await svc.close()


@pytest.mark.parametrize("environment", ["preview", "production"])
async def test_standard_workshop_session_cannot_acquire_legacy_business_grants(installed, environment):
    svc, project, artifact = installed
    if environment == "preview":
        opened = svc.open_runtime("alice", project["id"], artifact["hash"], environment)
        assert opened["standardLayout"]["packageSha256"] == artifact["packageSha256"]
    else:
        opened = svc.open_installed_runtime("alice", project["appId"], artifact["hash"], environment)
        assert opened["packageSha256"] == artifact["packageSha256"]
    token = opened["session"]
    before = svc.store.get("alice", project["id"])
    with pytest.raises(StudioError, match="RUNTIME_SESSION_EXPIRED"):
        await svc.select_files("bob", token, ["private"])
    with pytest.raises(StudioError, match="APP_NOT_FOUND"):
        svc.open_installed_runtime("bob", project["appId"], artifact["hash"], "production")
    layout = environment == "preview"
    denied = "EXPERT_DEPLOYMENT_REQUIRED" if layout else "CAPABILITY_DENIED"
    with pytest.raises(StudioError, match="EXPERT_DEPLOYMENT_REQUIRED" if layout else "FILES_UNAVAILABLE"):
        await svc.select_files("alice", token, ["private"])
    with pytest.raises(StudioError, match=denied):
        await svc.select_knowledge("alice", token, ["w"])
    for method, params in [
        ("knowledge.search", {"warehouseId": "w", "query": "private"}),
        ("model.select", {"operationId": op(), "expectedRevision": 0, "modelId": "default-a"}),
        ("dialogue.invoke", {"operation": "read", "input": {}}),
        ("files.read", {"id": "private"}),
    ]:
        with pytest.raises(StudioError, match=denied):
            await svc.invoke("alice", token, method, params)
    assert svc.store.get("alice", project["id"]) == before
    svc.files.assert_not_awaited()
    svc.knowledge_provider.catalog.assert_not_awaited()
    svc.knowledge_provider.read.assert_not_awaited()
    svc.close_runtime("alice", token)
    with pytest.raises(StudioError, match="RUNTIME_SESSION_EXPIRED"):
        await svc.invoke("alice", token, "files.read", {"id": "private"})
