"""Preview through real signed TLS/gateway/UDS, without widening host authority."""

# Shared gateway fixtures are independently packaged.
# ruff: noqa: E402
from __future__ import annotations

import asyncio
import hashlib
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "server" / "bridge"))
sys.path.insert(0, str(ROOT / "server" / "bridge" / "tests"))

from centuarai_local_data_gate.native_policy import check_octop_request, classify_octop
from test_local_data_gateway import network as network
from test_local_data_gateway import proof
from wanx_bridge.local_data_protocol import DataProtocolError

from octop.api.common.local_data import _check_private_resources, _resolve
from octop.infra.agents.middleware.local_data import local_data_live_check
from octop.infra.personal_space import previews
from octop.infra.personal_space.service import PersonalSpace


def test_preview_policy_preserves_selected_space_and_finite_routes():
    route = "/api/_client/space-previews/" + "a" * 32
    for method in ("GET", "POST", "HEAD"):
        value = classify_octop(method, route + "?version=1", "http", "wanx-host")
        assert value["action"] == "read" and value["bodyLimit"] == 0
    selected = "team:space:" + "b" * 32
    value = classify_octop("GET", route + "?version=1", "http", "wanx-host", selected)
    assert value["resourceId"] == selected
    for path, method, app, context in (
        (route + "?version=1&drive=" + "c" * 32, "GET", "wanx-host", selected),
        (route + "?version=1&space_id=personal", "GET", "wanx-host", None),
        (route, "DELETE", "wanx-host", None),
        (route + "/content", "POST", "wanx-host", None),
        (route, "GET", "ai.wanx.studio", None),
        (route, "GET", "centaurai.wanx.dialogue", None),
        ("/api/_client/space-mcp/connections", "GET", "wanx-host", None),
    ):
        with pytest.raises(DataProtocolError):
            classify_octop(method, path, "http", app, context)


async def test_signed_host_preview_rechecks_local_owner_and_deletion(env, network, monkeypatch):
    client, server, _ = env
    app = client._octop_app
    app.state.local_data_required = True
    identities = []

    async def authorize(scope, context):
        check_octop_request(scope, context.claims)
        user = await asyncio.to_thread(_resolve, server, context)
        await asyncio.to_thread(_check_private_resources, server, scope, context, user)
        scope.setdefault("state", {})["octop_user"] = user
        local_data_live_check.set(context.require_live)
        identities.append(user)

    network.native.authorize = authorize
    network.native.app = app
    counter = 100

    async def request(path, method="GET"):
        nonlocal counter
        counter += 1
        _, signed = proof(network, path, method=method, n=counter)
        return await network.client.request(
            method, path, headers={"x-centuarai-data-proof": signed}
        )

    assert (await request("/api/personal-space/overview")).status_code == 200
    owner = identities[-1]
    storage = PersonalSpace(server.paths.root / ".wanx-personal-space", owner.id)
    raw, pdf = b"synthetic office", b"%PDF-1.7\nlocal signed preview"
    item = "e" * 32
    digest = hashlib.sha256(raw).hexdigest()
    storage.upload_create("", "local.docx", len(raw), item)
    storage.upload_chunk(item, 0, raw, digest)
    storage.upload_complete(item, digest)
    monkeypatch.setattr(previews, "convert_pdf", lambda data, suffix, path: path.write_bytes(pdf))
    route = f"/api/_client/space-previews/{item}?version=1"
    response = await request(route, "POST")
    assert response.status_code == 200, response.text
    for _ in range(100):
        response = await request(route)
        assert response.status_code == 200, response.text
        if response.json()["state"] == "ready":
            break
        await asyncio.sleep(0.01)
    assert response.json()["state"] == "ready"
    content = f"/api/_client/space-previews/{item}/content?version=1"
    assert (await request(content)).content == pdf
    assert (await request(route.replace(item, "f" * 32))).status_code == 404
    storage.trash(item)
    assert (await request(content)).status_code == 404
