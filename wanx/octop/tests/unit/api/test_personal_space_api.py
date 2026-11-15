from __future__ import annotations

import hashlib
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI

from octop.api.deps import current_user, get_server
from octop.api.routers.personal_space import router
from octop.infra import box_resources
from octop.infra.personal_space.service import CHUNK_SIZE


@pytest.mark.asyncio
async def test_api_identity_chunk_contract_and_application_boundary(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        box_resources,
        "public_address",
        lambda: {"publicIp": "8.8.4.4", "publicIpCollectedAt": 100.0},
    )
    monkeypatch.setattr(
        box_resources,
        "network_addresses",
        lambda _: {
            "addresses": ["192.168.1.201", "172.17.0.1", "8.8.4.4"],
            "lanAddresses": ["192.168.1.201", "fd12::201"],
            "scope": "container",
        },
    )
    app = FastAPI()
    app.include_router(router, prefix="/api/personal-space")
    identity = SimpleNamespace(id=1, application_id="wanx")
    app.dependency_overrides[current_user] = lambda: identity
    app.dependency_overrides[get_server] = lambda: SimpleNamespace(
        paths=SimpleNamespace(root=tmp_path)
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.get("/api/personal-space/overview")
        assert response.json()["protocolVersion"] == 1
        assert response.json()["wanxStorage"]["scope"] == "wanx-managed-files"
        assert response.json()["wanxStorage"]["bytes"] >= 0
        assert isinstance(response.json()["network"]["addresses"], list)
        assert response.json()["network"]["lanAddresses"] == ["192.168.1.201", "fd12::201"]
        assert response.json()["network"]["scope"] == "container"
        assert response.json()["network"]["publicIp"] == "8.8.4.4"
        assert str(tmp_path) not in response.text
        body = {"id": "a" * 32, "name": "report.txt", "size": 3}
        assert (
            await client.post("/api/personal-space/uploads", json={**body, "user_id": 2})
        ).status_code == 422
        assert (await client.post("/api/personal-space/uploads", json=body)).status_code == 200
        digest = hashlib.sha256(b"abc").hexdigest()
        response = await client.put(
            f"/api/personal-space/uploads/{'a' * 32}?offset=0",
            content=b"abc",
            headers={"x-content-sha256": digest},
        )
        assert response.json() == {"offset": 3}
        response = await client.post(
            f"/api/personal-space/uploads/{'a' * 32}/complete", json={"digest": digest}
        )
        assert response.json()["name"] == "report.txt"
        identity.id = 2
        assert (
            await client.get(f"/api/personal-space/files/{'a' * 32}/content")
        ).status_code == 404
        identity.id = 1
        response = await client.get(f"/api/personal-space/files/{'a' * 32}/content?length=3")
        assert response.content == b"abc"
        assert response.headers["x-content-sha256"] == digest
        response = await client.put(
            f"/api/personal-space/uploads/{'a' * 32}?offset=0", content=b"x" * (CHUNK_SIZE + 1)
        )
        assert response.status_code == 413
        identity.application_id = "zhijun"
        assert (await client.get("/api/personal-space/overview")).status_code == 200
        assert (
            await client.get(f"/api/personal-space/files/{'a' * 32}/content")
        ).status_code == 200


@pytest.mark.asyncio
async def test_container_overview_api_preserves_host_metric_values(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from octop.infra import host_resources

    proc = tmp_path / "host-proc"
    proc.mkdir()
    (proc / "meminfo").write_text("MemTotal: 1000 kB\nMemAvailable: 250 kB\n")
    (proc / "stat").write_text("cpu 100 0 20 800 40 0 0 0 50 0\n")
    monkeypatch.setenv("OCTOP_IN_CONTAINER", "1")
    monkeypatch.setenv("OCTOP_HOST_PROC", str(proc))
    monkeypatch.setattr(
        host_resources.time,
        "sleep",
        lambda _: (proc / "stat").write_text("cpu 130 0 30 860 40 0 0 0 70 0\n"),
    )
    monkeypatch.setattr(box_resources, "public_address", lambda: {})
    monkeypatch.setattr(box_resources, "component_roots", lambda: ())
    app = FastAPI()
    app.include_router(router, prefix="/api/personal-space")
    app.dependency_overrides[current_user] = lambda: SimpleNamespace(id=1, application_id="wanx")
    app.dependency_overrides[get_server] = lambda: SimpleNamespace(
        paths=SimpleNamespace(root=tmp_path / "data")
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.get("/api/personal-space/overview")
    assert response.status_code == 200
    assert response.json()["cpu"] == {"scope": "host", "percent": 40.0}
    assert response.json()["memory"] == {
        "scope": "host",
        "total": 1024000,
        "used": 768000,
        "percent": 75.0,
    }
    assert str(proc) not in response.text
