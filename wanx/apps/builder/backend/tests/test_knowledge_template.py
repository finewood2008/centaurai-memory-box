"""Exercise the actual in-development PersonalWorkshop, compiler and runtime."""

import json
from copy import deepcopy
from unittest.mock import AsyncMock

import pytest
from test_edits import body, wait
from test_studio import ROOT, op
from test_workshop_model import DefaultModels
from wanx_studio.contracts import StudioError
from wanx_studio.versions import verify
from wanx_studio.workshop import PersonalWorkshop, validate_source


@pytest.fixture
async def knowledge_workshop(tmp_path):
    service = PersonalWorkshop(tmp_path / "workshop", ROOT, DefaultModels(), AsyncMock(return_value=[]))
    yield service
    await service.close()


def template():
    return json.loads((ROOT / "templates/knowledge-qa/wanx.editable.json").read_text())


async def copy(service, name="智能问答系统"):
    return await service.copy_source(
        "alice", {"operationId": op(), "name": name, "source": template()}
    )


async def test_real_template_passes_source_checks_and_copies_without_data_or_bindings(
    knowledge_workshop,
):
    files, manifest = validate_source(template())
    assert manifest["capabilities"] == ["data", "model", "files", "knowledge", "dialogue"]
    assert "src/repository.js" in files
    p = await copy(knowledge_workshop)
    q = await copy(knowledge_workshop, "内部制度问答")
    assert p["appId"] != q["appId"]
    assert p["preparation"]["references"] == []
    assert not p.get("_runtimeModel")
    assert p["engine"]["id"] == "wanx-default"
    assert p["preparation"]["interview"]["turns"] == []
    verify(knowledge_workshop.store.get("alice", p["id"])["artifacts"][0])
    with pytest.raises(StudioError, match="PROJECT_NOT_FOUND"):
        knowledge_workshop.store.get("bob", p["id"])


async def test_real_runtime_schema_app_environment_and_owner_isolation(knowledge_workshop):
    service = knowledge_workshop
    p = await copy(service)
    q = await copy(service, "制度问答")
    a = p["artifacts"][0]
    trial = service.open_runtime("alice", p["id"], a["hash"], "preview")["session"]
    other = service.open_runtime("alice", q["id"], q["artifacts"][0]["hash"], "preview")["session"]
    saved = await service.invoke(
        "alice",
        trial,
        "data.put",
        {
            "collection": "documents",
            "value": {
                "title": "合成资料",
                "body": "合成正文",
                "status": "draft",
                "sourceId": "",
                "digest": "abc",
                "updated": 1,
            },
        },
    )
    assert saved["_revision"] == 1
    assert not (await service.invoke("alice", other, "data.list", {"collection": "documents"}))[
        "items"
    ]
    with pytest.raises(StudioError, match="RUNTIME_SESSION_EXPIRED"):
        await service.invoke("bob", trial, "data.list", {"collection": "documents"})
    with pytest.raises(StudioError, match="KNOWLEDGE_NOT_SELECTED"):
        await service.invoke("alice", trial, "knowledge.search", {"query": "合成"})
    with pytest.raises(StudioError, match="RECORD_SCHEMA_INVALID"):
        await service.invoke(
            "alice", trial, "data.put", {"collection": "documents", "value": {"updated": "bad"}}
        )
    service.versions.adopt(
        "alice",
        p["id"],
        {
            "operationId": op(),
            "expectedRevision": p["versioning"]["revision"],
            "artifactHash": a["hash"],
            "confirmedByUser": True,
        },
    )
    service.installed(
        "alice",
        p["id"],
        {
            "operationId": op(),
            "artifactHash": a["hash"],
            "applicationId": p["appId"],
            "version": a["version"],
        },
    )
    production = service.open_runtime("alice", p["id"], a["hash"], "production")["session"]
    assert not (
        await service.invoke("alice", production, "data.list", {"collection": "documents"})
    )["items"]
    payload = service.install_payload("alice", p["id"], a["hash"])
    assert payload["runtimeNamespace"] == "workshop"
    assert payload["editable"]["allowed"]
    validate_source(payload["editable"])
    assert "合成正文" not in json.dumps(payload, ensure_ascii=False)


async def test_template_direct_edit_recompiles_and_keeps_records(knowledge_workshop):
    service = knowledge_workshop
    p = await copy(service)
    original = deepcopy(template())
    token = service.open_runtime("alice", p["id"], p["artifacts"][0]["hash"], "preview")["session"]
    await service.invoke(
        "alice",
        token,
        "data.put",
        {
            "collection": "tests",
            "value": {"question": "保留的题目", "expected": "handoff", "contains": ""},
        },
    )
    # The default model is simulated; actual model tools, queue and compiler run.
    await service.edits.submit("alice", p["id"], body(p, "调整问答页的布局"))
    result = await wait(service, p["id"])
    assert result["items"][0]["state"] == "completed", result["items"][0].get("error")
    assert len(result["project"]["artifacts"]) == 2
    assert (await service.invoke("alice", token, "data.list", {"collection": "tests"}))["items"][0][
        "question"
    ] == "保留的题目"
    assert template() == original
