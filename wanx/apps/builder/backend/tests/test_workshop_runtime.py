import json
from copy import deepcopy
from unittest.mock import AsyncMock

import pytest
from test_studio import ROOT, op
from test_workshop_model import DefaultModels
from wanx_studio.contracts import StudioError, digest
from wanx_studio.workshop import PersonalWorkshop


class Knowledge:
    def __init__(self):
        self.allowed = True
        self.revoke_during_read = False
        self.calls = []

    async def catalog(self, owner):
        return [{"id": "w", "name": "合成知识"}] if self.allowed else []

    async def read(self, owner, action, params):
        self.calls.append((owner, action, params))
        if self.revoke_during_read:
            self.allowed = False
        return {"items": [{"id": "e", "text": "合成片段"}]}


@pytest.fixture
async def setup(tmp_path):
    files = AsyncMock(return_value=[{"id": "f", "name": "合成.txt", "text": "原文"}])
    svc = PersonalWorkshop(tmp_path, ROOT, DefaultModels(), files)
    svc.knowledge_provider = Knowledge()
    source = json.loads((ROOT / "templates/knowledge-qa/wanx.editable.json").read_text())
    p = await svc.copy_source("alice", {"operationId": op(), "name": "问答", "source": source})
    a = p["artifacts"][0]
    token = svc.open_runtime("alice", p["id"], a["hash"], "preview")["session"]
    yield svc, source, p, token
    await svc.close()


async def test_optional_knowledge_starts_without_binding_and_grants_are_app_environment_owner_scoped(
    setup,
):
    svc, source, p, token = setup
    await svc.versions.authorize("alice", p["id"], p["artifacts"][0]["hash"])
    with pytest.raises(StudioError, match="KNOWLEDGE_NOT_SELECTED"):
        await svc.invoke("alice", token, "knowledge.search", {"warehouseId": "w", "query": "问题"})
    await svc.select_knowledge("alice", token, ["w"])
    assert (
        await svc.invoke("alice", token, "knowledge.search", {"warehouseId": "w", "query": "问题"})
    )["items"]
    reopened = svc.open_runtime("alice", p["id"], p["artifacts"][0]["hash"], "preview")["session"]
    assert (
        await svc.invoke("alice", reopened, "knowledge.evidence", {"warehouseId": "w", "id": "e"})
    )["items"]
    q = await svc.copy_source("alice", {"operationId": op(), "name": "另一个", "source": source})
    other = svc.open_runtime("alice", q["id"], q["artifacts"][0]["hash"], "preview")["session"]
    with pytest.raises(StudioError, match="KNOWLEDGE_NOT_SELECTED"):
        await svc.invoke("alice", other, "knowledge.search", {"warehouseId": "w", "query": "问题"})
    with pytest.raises(StudioError, match="RUNTIME_SESSION_EXPIRED"):
        await svc.invoke("bob", token, "model.list", {})
    await svc.select_files("alice", token, ["f"])
    assert (await svc.invoke("alice", reopened, "files.read", {"id": "f"}))["text"] == "原文"
    svc.files.side_effect = StudioError("REVOKED", 403)
    with pytest.raises(StudioError, match="REVOKED"):
        await svc.invoke("alice", reopened, "files.read", {"id": "f"})
    stored = svc.store.get("alice", p["id"])
    assert stored["_runtimeSources"].get("production") is None
    assert "_runtimeSources" not in svc.store.get("alice", q["id"])


async def test_inflight_revocation_and_arbitrary_methods_fail_closed(setup):
    svc, _, _, token = setup
    await svc.select_knowledge("alice", token, ["w"])
    svc.knowledge_provider.revoke_during_read = True
    with pytest.raises(StudioError, match="KNOWLEDGE_ACCESS_REVOKED"):
        await svc.invoke("alice", token, "knowledge.search", {"warehouseId": "w", "query": "问题"})
    with pytest.raises(StudioError, match="METHOD_NOT_ALLOWED"):
        await svc.invoke("alice", token, "knowledge.delete", {"warehouseId": "w"})


async def test_model_choice_uses_existing_binding_and_rejects_stale_or_unavailable_choices(setup):
    svc, _, _, token = setup
    initial = await svc.invoke("alice", token, "model.list", {})
    chosen = await svc.invoke(
        "alice",
        token,
        "model.select",
        {"operationId": op(), "expectedRevision": initial["revision"], "modelId": "default-b"},
    )
    assert chosen["modelId"] == "default-b"
    with pytest.raises(StudioError, match="RUNTIME_MODEL_CHANGED"):
        await svc.invoke(
            "alice",
            token,
            "model.select",
            {"operationId": op(), "expectedRevision": initial["revision"], "modelId": None},
        )
    with pytest.raises(StudioError, match="RUNTIME_MODEL_UNAVAILABLE"):
        await svc.invoke(
            "alice",
            token,
            "model.select",
            {"operationId": op(), "expectedRevision": chosen["revision"], "modelId": "missing"},
        )


async def test_deployment_model_choices_are_environment_scoped_and_do_not_inherit_project_choice(setup):
    svc, _, p, preview = setup
    await svc.invoke(
        "alice", preview, "model.select",
        {"operationId": op(), "expectedRevision": 0, "modelId": "default-b"},
    )
    dev = svc.open_runtime("alice", p["id"], p["artifacts"][0]["hash"], "deployment:dev")["session"]
    prod = svc.open_runtime("alice", p["id"], p["artifacts"][0]["hash"], "deployment:prod")["session"]
    assert (await svc.invoke("alice", dev, "model.list", {}))["modelId"] is None
    assert (await svc.invoke("alice", prod, "model.list", {}))["modelId"] is None
    body = {"operationId": op(), "expectedRevision": 0, "modelId": "default-a"}
    assert (await svc.invoke("alice", dev, "model.select", body))["revision"] == 1
    assert (await svc.invoke("alice", dev, "model.select", body))["revision"] == 1
    with pytest.raises(StudioError, match="OPERATION_CONFLICT"):
        await svc.invoke("alice", prod, "model.select", body)
    assert (await svc.invoke("alice", prod, "model.list", {}))["revision"] == 0
    assert (await svc.invoke("alice", preview, "model.list", {}))["modelId"] == "default-b"
    await svc.invoke("alice", dev, "model.generate", {"prompt": "合成验证"})
    assert svc.model.model.used == ["default-a"]
    assert (await svc.invoke("alice", prod, "model.generate", {"prompt": "合成验证"}))["text"] == "WANX_OK"


@pytest.mark.parametrize("method", ["model.list", "model.select"])
async def test_model_settings_do_not_return_after_runtime_is_revoked_during_catalog_read(setup, monkeypatch, method):
    import asyncio
    import threading

    svc, _, _, token = setup
    started, release = threading.Event(), threading.Event()
    original = svc.model.runtime_catalog

    def catalog():
        started.set()
        assert release.wait(3)
        return original()

    monkeypatch.setattr(svc.model, "runtime_catalog", catalog)
    params = {} if method == "model.list" else {
        "operationId": op(), "expectedRevision": 0, "modelId": "default-a",
    }
    pending = asyncio.create_task(svc.invoke("alice", token, method, params))
    try:
        assert await asyncio.to_thread(started.wait, 2)
        del svc.runtime_sessions[token]
    finally:
        release.set()
    with pytest.raises(StudioError, match="RUNTIME_SESSION_EXPIRED"):
        await pending


@pytest.mark.parametrize("action", ["model", "files", "knowledge"])
async def test_queued_runtime_setting_write_cannot_cross_deployment_generation(setup, monkeypatch, action):
    import asyncio
    import threading
    from wanx_studio.deployment.miniapp_profile import MiniappProfile

    svc, _, p, _ = setup
    _, artifact = svc.artifact("alice", p["id"], p["artifacts"][0]["hash"])
    profile = MiniappProfile(svc, {"boxId": "synthetic-box"}, lambda owner: None)
    svc.deployment_profile = profile
    target = profile.target_for("alice", p["appId"], "dev")
    slot = profile.slot_id("alice", target)
    binding = {
        "owner": "alice", "target": target, "slotApplicationId": slot,
        "projectId": p["id"], "artifactHash": artifact["hash"], "manifest": artifact["manifest"],
        "generation": 1, "operationId": "synthetic-operation", "state": "active", "base": artifact,
    }
    with profile.transaction():
        profile.put("binding", profile.slot_key("alice", target), binding)
    body = {"artifactHash": artifact["hash"], "environment": "dev", "generation": 1}
    token = profile.open_runtime("alice", slot, body)["session"]
    queued = threading.Event()
    if action == "model":
        original = svc.store.mutate

        def write(*args, **kwargs):
            queued.set()
            return original(*args, **kwargs)

        monkeypatch.setattr(svc.store, "mutate", write)
        async def select():
            return await svc.invoke("alice", token, "model.select", {
                "operationId": op(), "expectedRevision": 0, "modelId": "default-b",
            })
    else:
        original = svc.remember_sources

        def write(*args, **kwargs):
            queued.set()
            return original(*args, **kwargs)

        monkeypatch.setattr(svc, "remember_sources", write)
        async def select():
            if action == "files":
                return await svc.select_files("alice", token, ["f"])
            return await svc.select_knowledge("alice", token, ["w"])

    # The writer is really queued on the shared database lock while activation
    # advances the binding in a transaction owned by this thread.
    with svc.store.lock:
        pending = asyncio.create_task(select())
        assert await asyncio.to_thread(queued.wait, 2)
        with profile.transaction():
            binding["generation"] = 2
            profile.put("binding", profile.slot_key("alice", target), binding)
    with pytest.raises(StudioError, match="UPDATE_REQUIRED"):
        await pending
    current = profile.open_runtime("alice", slot, {**body, "generation": 2})["session"]
    assert (await svc.invoke("alice", current, "model.list", {}))["revision"] == 0
    with pytest.raises(StudioError, match="FILE_NOT_SELECTED"):
        await svc.invoke("alice", current, "files.read", {"id": "f"})
    with pytest.raises(StudioError, match="KNOWLEDGE_NOT_SELECTED"):
        await svc.invoke("alice", current, "knowledge.search", {"warehouseId": "w", "query": "合成问题"})


async def test_source_upgrade_preserves_identity_history_and_data_and_retries_are_idempotent(setup):
    svc, source, p, token = setup
    saved = await svc.invoke(
        "alice", token, "data.put", {"collection": "documents", "value": {"title": "已有资料"}}
    )
    updated = deepcopy(source)
    updated["files"]["src/config.json"] += "\n"
    updated["sourceHash"] = digest(updated["files"])
    body = {
        "operationId": op(),
        "expectedArtifactHash": p["artifacts"][0]["hash"],
        "source": updated,
    }
    q = await svc.update_source("alice", p["id"], body)
    assert q["appId"] == p["appId"]
    assert len(q["artifacts"]) == 2
    assert q["artifacts"][0]["hash"] == p["artifacts"][0]["hash"]
    assert q["artifacts"][-1]["version"] == "0.1.1"
    assert len((await svc.update_source("alice", p["id"], body))["artifacts"]) == 2
    assert (
        await svc.invoke(
            "alice", token, "data.get", {"collection": "documents", "id": saved["_id"]}
        )
    )["title"] == "已有资料"
    with pytest.raises(StudioError, match="VERSION_CHANGED"):
        await svc.update_source("alice", p["id"], {**body, "operationId": op()})
    breaking = deepcopy(updated)
    manifest = json.loads(breaking["files"]["miniapp.manifest.json"])
    del manifest["collections"]["documents"]
    breaking["files"]["miniapp.manifest.json"] = json.dumps(manifest)
    breaking["sourceHash"] = digest(breaking["files"])
    with pytest.raises(StudioError, match="VERSION_DATA_INCOMPATIBLE"):
        await svc.update_source(
            "alice",
            p["id"],
            {
                "operationId": op(),
                "expectedArtifactHash": q["artifacts"][-1]["hash"],
                "source": breaking,
            },
        )
