"""The developer discovers fixed Host APIs from real read_material input."""
import hashlib
import json
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace

import pytest

from test_standard_artifacts import standard as standard
from test_studio import op
from wanx_studio import devkit
from wanx_studio.contracts import digest
from wanx_studio.runner import Runner


@pytest.mark.parametrize("standard", [None, "expert"], indirect=True)
async def test_real_standard_workspace_supplies_project_spec_and_fixed_renderer_bridge(standard, monkeypatch):
    svc, project = standard
    current = svc.store.get("alice", project["id"])
    expert = bool(current.get("deploymentExpert"))
    # Use the actual contract projector rather than the pipeline fixture's
    # intentionally minimal adoption-only handoff.
    current["preparation"]["handoff"]["contracts"] = svc.preparation.contracts(current, ["data", "foundation"] if expert else [])
    task = op()
    current["tasks"].append({"id": task, "state": "running", "solutionHash": digest(current["solution"]), "events": []})
    svc.store.save(current)
    observed = {}

    class StopAtNativeDispatch(Exception):
        pass

    class Input:
        def write(self, data):
            config = json.loads(data)
            workspace = Path(config["taskRoot"])
            observed["config"] = config
            observed["projectSpec"] = json.loads((workspace / "project-spec.json").read_text())
            observed["fixedSources"] = {name: (workspace / name).read_bytes()
                for name in ("shell/main.cjs", "shell/host.cjs", "shell/preload.cjs")}
            raise StopAtNativeDispatch()

    async def acquire(*args):
        return SimpleNamespace(proc=SimpleNamespace(stdin=Input(), returncode=0))

    # Native/model transport only is replaced. Runner.execute creates the
    # actual standard workspace using the fixed App Kit generator and npm ci.
    monkeypatch.setattr("wanx_studio.runner.runtime_config", lambda *args: {"synthetic": True})
    monkeypatch.setattr(svc.native_codex, "acquire", acquire)
    with pytest.raises(StopAtNativeDispatch):
        await Runner(svc).execute("alice", current, task, "Implement the frozen application")

    config = observed["config"]
    material = config["material"]
    assert "requestedChange" not in material, "a first build must not inherit another edit's original request"
    actual_spec = observed["projectSpec"]
    assert material["devKit"]["projectSpec"] == actual_spec == devkit.project_spec(current)
    assert material["devKit"]["projectSpecHash"] == devkit.digest(actual_spec)
    assert config["devKit"] is True
    assert {"app/host.mjs", "app/host.html", "app/styles.css", "app/pages/workspace.mjs"} <= config["files"].keys()
    assert material["contract"]["mutableFiles"] == sorted(config["files"])
    assert material["contract"]["mutableRoots"] == ["app/"]
    assert material["contract"]["uiTemplate"]["layoutEditable"] is True

    bridge = material["contract"]["rendererBridgeContract"]
    assert bridge["global"] == "window.wanx"
    assert bridge["readOnly"] is True  # Fixed API/source, not business read-only.
    assert bridge["demoIsExhaustive"] is False
    assert isinstance(bridge["methods"], dict)
    methods = {"context", "listFiles", "onInvalidated"}
    if expert:
        methods |= {"expertContext", "expertInvoke"}
    assert set(bridge["methods"]) == methods
    assert bridge["envelope"] == "{ok:true,value}|{ok:false,code}"
    assert bridge["fixedSourceHashes"] == {name: hashlib.sha256(value).hexdigest()
        for name, value in observed["fixedSources"].items()}
    if expert:
        # The ordinary demo does not exercise every immutable preload API.
        assert "expertInvoke" not in config["files"]["app/host.mjs"]
        assert b"expertContext" in observed["fixedSources"]["shell/preload.cjs"]
        assert b"expertInvoke" in observed["fixedSources"]["shell/preload.cjs"]
        assert bridge["expertOperations"] == material["verifiedContracts"]["foundation"]["operations"]
        assert set(bridge["expertOperations"]) == {"expert.run", "expert.tasks", "expert.cancel"}
        assert bridge["dataOperations"] == material["verifiedContracts"]["data"]["operations"]
        assert set(bridge["dataOperations"]) == {"data.list", "data.get", "data.put", "data.delete"}
        assert bridge["stateCollection"] == "state"
        assert bridge["recordShape"] == "flat"
        assert "record._revision" in bridge["expectedRevision"]
        assert "create 0" in bridge["expectedRevision"]
        assert "RECORD_CHANGED" in bridge["expectedRevision"]
        assert "json:string" in bridge["dataOperations"]["data.put"]
        assert 'operation:"expert.tasks"' in bridge["initialization"]
        assert "including the first create" in bridge["recordId"]
        assert "before expert.run" in bridge["recordId"]
        preview = bridge["unavailableExpertContext"]
        assert preview["code"] == "EXPERT_DEPLOYMENT_REQUIRED"
        assert preview["classification"] == "runtime-unavailable"
        assert preview["disableBusinessActions"] is True
        assert preview["mayInferDeploymentState"] is False
        assert "已部署应用" in preview["message"]
        rules = "\n".join(material["contract"]["rules"])
        assert "not an initialization failure" in rules
        assert "all other initialization errors" in rules
    else:
        for key in ("expertOperations", "dataOperations", "stateCollection", "recordShape", "expectedRevision", "initialization", "recordId", "unavailableExpertContext"):
            assert key not in bridge
        assert "wanx.expert-app.v1" not in json.dumps(bridge)
        assert "expertInstruction" not in material["contract"]
        assert "expertDeployment" not in material["contract"]


@pytest.mark.parametrize("standard", ["expert"], indirect=True)
async def test_standard_edit_material_preserves_only_current_original_request_and_answers(standard, monkeypatch):
    svc, project = standard
    current = svc.store.get("alice", project["id"])
    current["preparation"]["handoff"]["contracts"] = svc.preparation.contracts(current, ["data", "foundation"])
    edit_id, task = op(), op()
    original = "ORIGINAL_REQUEST_SENTINEL：读取 flat record.json，禁止 record.value.json；unknown 无 runId 时保留 operationId，只查询不重放。\nCAS RECORD_CHANGED 后重新读取，不覆盖其他会话；跨 scope 历史只读，禁止 cancel/replay。"
    answers = [{"operationId": op(), "text": "ANSWER_SENTINEL：确认初始化解析失败后保持提交禁用，不写入空记录。"}]
    edit = {"id": edit_id, "text": original, "answers": deepcopy(answers), "state": "building", "baseHash": current["artifacts"][-1]["hash"],
        "contextId": "synthetic-current-edit", "stream": "PM_STREAM_IS_NOT_THE_USER_REQUEST", "summary": "修复请求历史恢复并保留隔离。"}
    current["_edits"] = {"enabled": True, "items": [
        {"id": op(), "text": "UNRELATED_OLD_EDIT_TEXT", "answers": [{"text": "UNRELATED_OLD_ANSWER"}], "state": "completed"},
        edit,
        {"id": op(), "text": "UNRELATED_QUEUED_EDIT_TEXT", "answers": [{"text": "UNRELATED_QUEUED_ANSWER"}], "state": "queued"},
    ]}
    from wanx_studio.iterative import standard_contract
    edit["execution"] = {"resourceHash": svc.edits.resource_hash("alice", current, edit)}
    task_row = {"id": task, "editId": edit_id, "baseHash": edit["baseHash"], "state": "running", "solutionHash": digest(current["solution"]), "events": [],
        "operationId": op(), "createdAt": 1, "change": {"id": edit_id, "spec": {"behavior": deepcopy(current["solution"])}, "contract": standard_contract(current["artifacts"][-1])}}
    current["tasks"].append(task_row)
    svc.store.save(current)
    svc.edits.contexts[("alice", current["id"])] = (edit_id, edit["contextId"])
    # The real execution projection deliberately removes _edits; the task's
    # editId must resolve the original request from the current owned store.
    execution = svc.edits.execution_project("alice", current, task_row)
    assert "_edits" not in execution
    observed = {}

    class StopAtNativeDispatch(Exception):
        pass

    class Input:
        def write(self, data):
            observed.update(json.loads(data))
            assert Path(observed["taskRoot"]).joinpath("project-spec.json").is_file()
            raise StopAtNativeDispatch()

    async def acquire(*args):
        return SimpleNamespace(proc=SimpleNamespace(stdin=Input(), returncode=0))

    monkeypatch.setattr("wanx_studio.runner.runtime_config", lambda *args: {"synthetic": True})
    monkeypatch.setattr(svc.native_codex, "acquire", acquire)
    with pytest.raises(StopAtNativeDispatch):
        await Runner(svc).execute("alice", execution, task, edit["summary"])
    material = observed["material"]
    assert material["instruction"] == edit["summary"]
    assert material["requestedChange"] == {"text": original, "answers": answers}
    serialized = json.dumps(material, ensure_ascii=False)
    for unrelated in ("UNRELATED_OLD_EDIT_TEXT", "UNRELATED_OLD_ANSWER", "UNRELATED_QUEUED_EDIT_TEXT", "UNRELATED_QUEUED_ANSWER", "PM_STREAM_IS_NOT_THE_USER_REQUEST"):
        assert unrelated not in serialized
    assert svc.store.get("alice", project["id"])["_edits"]["items"][1]["text"] == original
    assert svc.store.get("alice", project["id"])["_edits"]["items"][1]["answers"] == answers
