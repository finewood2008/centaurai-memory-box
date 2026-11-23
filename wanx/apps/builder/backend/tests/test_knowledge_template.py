"""A retired source template cannot enter the standard client build flow."""
import json

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from test_studio import ROOT, op
from wanx_studio.api import create_router
from wanx_studio.contracts import digest
from wanx_studio.workshop import PREFIX, PersonalWorkshop


@pytest.mark.parametrize(("template", "name"), [("knowledge-qa", "好问"), ("zhike", "知客")])
async def test_retired_template_cannot_be_copied(tmp_path, template, name):
    service = PersonalWorkshop(tmp_path / "workshop", ROOT)
    app = FastAPI()
    app.include_router(create_router(service, lambda: "alice", prefix=PREFIX))
    source = json.loads((ROOT / "tests" / "fixtures" / f"retired-{template}.json").read_text())
    assert source["applicationId"] == "centaurai.wanx.template." + template
    assert source["format"] == "wanx-miniapp-source-v1"
    assert source["sourceHash"] == digest(source["files"])
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post(PREFIX + "/copies", json={"operationId": op(), "name": name, "source": source})
            assert response.status_code == 404
            assert service.store.list("alice") == []
    finally:
        await service.close()
