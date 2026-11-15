import json
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest
from test_studio import svc as svc

from wanx_studio.contracts import StudioError, digest
from wanx_studio.foundation_runtime import native_operation
from wanx_studio.workshop import PersonalWorkshop

ROOT = Path(__file__).resolve().parents[2]


def test_native_foundation_fixed_contract_and_scope(tmp_path):
    session = {
        "manifest": {"capabilities": ["foundation"]},
        "app": "ai.wanx.selfmade." + "a" * 32,
        "environment": "preview",
    }
    service = SimpleNamespace(
        store=SimpleNamespace(root=tmp_path), runtime=lambda owner, token: session
    )

    def invoke(owner, params):
        return native_operation(service, owner, "opaque", params)

    value = {"operation": "status", "input": {}}
    first = invoke("alice", value)["nativeFoundation"]
    assert set(first) == {"appId", "environment", "scopeId", "operation", "input"}
    assert first["scopeId"] != invoke("bob", value)["nativeFoundation"]["scopeId"]
    session["environment"] = "production"
    assert first["scopeId"] != invoke("alice", value)["nativeFoundation"]["scopeId"]
    for params in [
        {"operation": "http.request", "input": {}},
        {"operation": [], "input": {}},
        {**value, "account": "bob"},
        {"operation": "status", "input": {"text": "x" * 90001}},
    ]:
        with pytest.raises(StudioError):
            invoke("alice", params)
    session["manifest"]["capabilities"] = []
    with pytest.raises(StudioError, match="CAPABILITY_DENIED"):
        invoke("alice", value)


@pytest.mark.asyncio
async def test_foundation_copy_and_runtime_ownership(tmp_path):
    svc = PersonalWorkshop(tmp_path, ROOT)
    try:
        files = {
            "miniapp.manifest.json": json.dumps(
                {
                    "schemaVersion": 1,
                    "name": "知客基础能力验收",
                    "entry": "src/app.js",
                    "capabilities": ["data", "foundation"],
                    "collections": {
                        "customer_extensions": {
                            "customerId": "string",
                            "fields": "string",
                        }
                    },
                }
            ),
            "src/app.js": "export async function mount(root,api){const s=await api.foundation.invoke('status',{});root.textContent=s.ready?'已连接':'开始使用';}",
        }
        source = {
            "allowed": True,
            "format": "wanx-miniapp-source-v1",
            "applicationId": "centaurai.wanx.weekly-report",
            "version": "0.9.0",
            "origin": "local",
            "files": files,
            "sourceHash": digest(files),
        }
        p = await svc.copy_source(
            "alice",
            {"operationId": uuid4().hex, "name": "知客独立副本", "source": source},
        )
        artifact = p["artifacts"][0]
        token = svc.open_runtime("alice", p["id"], artifact["hash"], "preview")[
            "session"
        ]
        result = await svc.invoke(
            "alice", token, "foundation.invoke", {"operation": "status", "input": {}}
        )
        assert result["nativeFoundation"]["appId"] != source["applicationId"]
        with pytest.raises(StudioError):
            await svc.invoke(
                "bob", token, "foundation.invoke", {"operation": "status", "input": {}}
            )
        record = await svc.invoke(
            "alice",
            token,
            "data.put",
            {
                "collection": "customer_extensions",
                "id": "stable-customer",
                "expectedRevision": 0,
                "value": {
                    "customerId": "stable-customer",
                    "fields": '{"industry":"培训"}',
                },
            },
        )
        assert record["_revision"] == 1
        second = await svc.copy_source(
            "alice",
            {"operationId": uuid4().hex, "name": "另一个副本", "source": source},
        )
        other = svc.open_runtime(
            "alice", second["id"], second["artifacts"][0]["hash"], "preview"
        )["session"]
        assert (
            await svc.invoke(
                "alice", other, "data.list", {"collection": "customer_extensions"}
            )
        )["items"] == []
        assert (
            await svc.invoke(
                "alice",
                other,
                "foundation.invoke",
                {"operation": "status", "input": {}},
            )
        )["nativeFoundation"]["scopeId"] != result["nativeFoundation"]["scopeId"]
    finally:
        await svc.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("inherited", [True, False])
async def test_model_edit_preserves_only_inherited_foundation(svc, tmp_path, inherited):
    from test_edits import body, wait
    from test_workshop import source
    from test_workshop_model import DefaultModels, reply
    from unittest.mock import AsyncMock

    service = PersonalWorkshop(
        tmp_path / "edit", ROOT, DefaultModels(), AsyncMock(return_value=[])
    )
    try:
        package = await source(svc)
        if inherited:
            manifest = json.loads(package["files"]["miniapp.manifest.json"])
            manifest["capabilities"].append("foundation")
            package["files"]["miniapp.manifest.json"] = json.dumps(manifest)
            package["sourceHash"] = digest(package["files"])
        p = await service.copy_source(
            "alice",
            {"operationId": uuid4().hex, "name": "合成迭代验收", "source": package},
        )
        original_generate = service.generate

        async def generate(owner, pid, request, **kwargs):
            if not request.get("tools"):
                return reply(
                    json.dumps(
                        {
                            "outcome": "ready",
                            "summary": "保留基础能力并调整配色",
                            "patch": {
                                "capabilities": ["data", "model", "files", "foundation"],
                                "upsert": [{"section": "dataFields", "value": {"name": "industry", "type": "text", "required": False, "description": "已有JSON中的可选界面字段", "example": ""}}]
                            },
                        }
                    )
                )
            return await original_generate(owner, pid, request, **kwargs)

        service.generate = generate
        await service.edits.submit("alice", p["id"], body(p, "调整配色，保留基础能力"))
        result = await wait(service, p["id"])
        edit = result["items"][0]
        if inherited:
            assert edit["state"] == "completed", edit.get("error")
            assert len(result["project"]["artifacts"]) == 2
            assert result["project"]["artifacts"][-1]["manifest"]["collections"] == result["project"]["artifacts"][0]["manifest"]["collections"]
            assert (
                "foundation"
                in result["project"]["artifacts"][-1]["manifest"]["capabilities"]
            )
        else:
            assert edit["state"] == "failed"
            assert edit["error"] == "WORKSHOP_CAPABILITY_UNSUPPORTED"
            assert len(result["project"]["artifacts"]) == 1
    finally:
        await service.close()
