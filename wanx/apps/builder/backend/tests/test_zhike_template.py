import json
from pathlib import Path
from uuid import uuid4

import pytest

from wanx_studio.contracts import StudioError
from wanx_studio.workshop import PersonalWorkshop

ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.asyncio
async def test_bundled_zhike_copy_runtime_and_saved_extensions_are_isolated(tmp_path):
    service = PersonalWorkshop(tmp_path, ROOT)
    source = json.loads((ROOT / "templates/zhike/wanx.editable.json").read_text())
    try:
        first, second = [
            await service.copy_source("alice", {"operationId": uuid4().hex, "name": name, "source": source})
            for name in ["我的知客", "第二个知客"]
        ]
        assert first["appId"] != second["appId"] != source["applicationId"]
        assert first["workshop"]["applicationId"] == "centaurai.wanx.template.zhike"
        assert first["preparation"]["references"] == []
        assert not first.get("_runtimeModel")
        artifact = first["artifacts"][0]
        service.versions.adopt("alice", first["id"], {"operationId": uuid4().hex, "expectedRevision": first["versioning"]["revision"], "artifactHash": artifact["hash"], "confirmedByUser": True})
        service.installed("alice", first["id"], {"operationId": uuid4().hex, "artifactHash": artifact["hash"], "applicationId": first["appId"], "version": artifact["version"]})

        def token(project, environment):
            return service.open_runtime("alice", project["id"], project["artifacts"][0]["hash"], environment)["session"]

        preview, other = token(first, "preview"), token(second, "preview")
        await service.invoke("alice", preview, "data.put", {"collection": "customer_extensions", "id": "synthetic-customer", "value": {"customerId": "synthetic-customer", "fields": '{"industry":"training"}'}, "expectedRevision": 0})
        own = await service.invoke("alice", preview, "data.get", {"collection": "customer_extensions", "id": "synthetic-customer"})
        assert own["fields"] == '{"industry":"training"}'
        for isolated in [other, token(first, "production")]:
            assert await service.invoke("alice", isolated, "data.get", {"collection": "customer_extensions", "id": "synthetic-customer"}) is None
        reopened = token(first, "preview")
        assert (await service.invoke("alice", reopened, "data.get", {"collection": "customer_extensions", "id": "synthetic-customer"}))["fields"] == own["fields"]
        scopes = []
        for session in [preview, other, token(first, "production")]:
            value = await service.invoke("alice", session, "foundation.invoke", {"operation": "conversation.status", "input": {}})
            scopes.append(value["nativeFoundation"]["scopeId"])
            assert value["nativeFoundation"]["appId"] != "centaurai.wanx.weekly-report"
        assert len(set(scopes)) == 3
        with pytest.raises(StudioError):
            await service.invoke("bob", preview, "foundation.invoke", {"operation": "conversation.send", "input": {"id": "synthetic", "text": "do not execute"}})
    finally:
        await service.close()
