from copy import deepcopy
from pathlib import Path

import pytest

from wanx_studio import devkit, devkit_build
from wanx_studio.contracts import StudioError
from wanx_studio.prd import implementation_missing
from wanx_studio.service import StudioService


ROOT = Path(__file__).resolve().parents[2]


def solution():
    return {"capabilities": [], "prd": {
        "features": [{"priority": "must", "title": "筛选", "implementation": {
            "source": "frontend", "caseRefs": ["filter"], "contractIds": []}}],
        "tests": [{"ref": "filter", "title": "列表可筛选"}]}}


def test_prd_cross_references_survive_rename_but_not_removal():
    draft = solution()
    draft["prd"]["tests"][0]["title"] = "只显示待办"
    assert not implementation_missing(draft)
    draft["prd"]["tests"].clear()
    assert implementation_missing(draft) == ["筛选：未关联有效验收用例"]
    draft["prd"]["features"][0]["implementation"].update(source="contract", contractIds=["space.drive"])
    assert "筛选：实现来源与已声明合同不一致" in implementation_missing(draft)


def test_queued_workspace_rejects_changed_input_before_generation(tmp_path):
    project = {"devKit":True, "solution":solution(), "decisions":{}, "id":"a"*32,
               "name":"Filter", "appId":"dev.wanx.filter"}
    frozen = devkit.build_input(project, ROOT)
    changed = deepcopy(project)
    changed["solution"]["prd"]["features"][0]["title"] = "导出"
    with pytest.raises(StudioError, match="BUILD_INPUT_CHANGED"):
        devkit_build.create_workspace(changed, ROOT, tmp_path, frozen=frozen)
    assert not list(tmp_path.iterdir())
    project["kitSha256"] = "0"*64
    with pytest.raises(StudioError, match="PROJECT_KIT_CHANGED"):
        devkit.build_input(project, ROOT)


async def test_workspace_failure_never_compiles_legacy_bundle(tmp_path):
    svc = StudioService(tmp_path/"state", ROOT)
    try:
        project = svc.create_project("alice", "Filter", "筛选任务", "create-1")
        with pytest.raises(StudioError, match="DEVKIT_WORKSPACE_REQUIRED"):
            await svc.add_artifact("alice", project["id"], "missing-task", {"src/app.js":"invalid"})
        assert not svc.store.get("alice", project["id"])["artifacts"]
    finally:
        await svc.close()
