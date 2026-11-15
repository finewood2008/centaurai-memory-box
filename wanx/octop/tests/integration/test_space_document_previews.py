from __future__ import annotations

import asyncio
import hashlib
import os
from pathlib import Path
from typing import Any

import pytest

from octop.infra.personal_space import previews
from tests.support.auth import TEST_PASSWORD, create_user


async def test_preview_cache_never_bypasses_original_file_authorization(
    env: Any, monkeypatch: Any
) -> None:
    client, _, owner = env
    raw, pdf = b"synthetic office file", b"%PDF-1.7\nsynthetic cached preview"
    monkeypatch.setattr(previews, "convert_pdf", lambda data, suffix, path: path.write_bytes(pdf))
    item = "b" * 32
    digest = hashlib.sha256(raw).hexdigest()
    await create_user(client, owner, username="preview-other")
    login = await client.post(
        "/api/auth/login", json={"username": "preview-other", "password": TEST_PASSWORD}
    )
    other = {"Authorization": "Bearer " + login.json()["access_token"]}
    prefix = "/api/personal-space"
    response = await client.post(
        prefix + "/uploads",
        headers=owner,
        json={"id": item, "name": "合成测试.pptx", "size": len(raw)},
    )
    assert response.status_code == 200
    await client.put(
        prefix + f"/uploads/{item}?offset=0",
        headers={**owner, "x-content-sha256": digest},
        content=raw,
    )
    await client.post(prefix + f"/uploads/{item}/complete", headers=owner, json={"digest": digest})
    route = f"/api/_client/space-previews/{item}?version=1"
    assert (await client.post(route)).status_code == 401
    assert (await client.post(route, headers=other)).status_code == 404
    assert (await client.post(route, headers=owner)).json()["state"] == "processing"
    for _ in range(100):
        response = await client.get(route, headers=owner)
        if response.json().get("state") == "ready":
            break
        await asyncio.sleep(0.01)
    assert response.json()["digest"] == hashlib.sha256(pdf).hexdigest()
    content = f"/api/_client/space-previews/{item}/content?version=1"
    assert (await client.get(content, headers=owner)).content == pdf
    assert (await client.get(content, headers=other)).status_code == 404
    assert (
        await client.get(content.replace("version=1", "version=2"), headers=owner)
    ).status_code == 409
    await client.delete(prefix + f"/files/{item}", headers=owner)
    assert (await client.get(content, headers=owner)).status_code == 404
    schema = (await client.get("/api/openapi.json", headers=owner)).json()
    assert not any("space-previews" in path for path in schema.get("paths", {}))


@pytest.mark.skipif(
    not os.environ.get("WANX_PREVIEW_FIXTURES"),
    reason="explicit synthetic Office fixtures and converter required",
)
@pytest.mark.parametrize("extension", ["docx", "pptx"])
async def test_real_office_preview_through_authenticated_http(env: Any, extension: str) -> None:
    client, _, owner = env
    raw = (Path(os.environ["WANX_PREVIEW_FIXTURES"]) / f"preview-test.{extension}").read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    item = ("c" if extension == "docx" else "d") * 32
    prefix = "/api/personal-space"
    response = await client.post(
        prefix + "/uploads",
        headers=owner,
        json={"id": item, "name": "真实转换验证." + extension, "size": len(raw)},
    )
    assert response.status_code == 200
    response = await client.put(
        prefix + f"/uploads/{item}?offset=0",
        headers={**owner, "x-content-sha256": digest},
        content=raw,
    )
    assert response.status_code == 200
    response = await client.post(
        prefix + f"/uploads/{item}/complete", headers=owner, json={"digest": digest}
    )
    assert response.status_code == 200
    route = f"/api/_client/space-previews/{item}?version=1"
    assert (await client.post(route, headers=owner)).status_code == 200
    for _ in range(600):
        response = await client.get(route, headers=owner)
        assert response.status_code == 200, response.text
        if response.json()["state"] == "ready":
            break
        await asyncio.sleep(0.25)
    assert response.json()["state"] == "ready"
    result = await client.get(
        f"/api/_client/space-previews/{item}/content?version=1", headers=owner
    )
    assert result.content.startswith(b"%PDF-")
    assert hashlib.sha256(result.content).hexdigest() == response.json()["digest"]
    original = await client.get(prefix + f"/files/{item}/content", headers=owner)
    assert original.content == raw
