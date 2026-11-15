"""Canonical adapter ownership and host registration preserve authorization."""

import ast
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from wanx_bridge.semantica import client, host_routes


def test_no_second_adapter_implementation_in_octop():
    root = Path(__file__).resolve().parents[3]
    assert not list((root / "src/octop/infra/semantica").glob("*.py"))
    assert not (root / "src/octop/api/routers/semantica.py").exists()
    assert not (root / "src/octop/api/starlink_mcp.py").exists()
    assert (
        Path(client.__file__)
        .resolve()
        .is_relative_to(root.parent / "server/bridge/wanx_bridge/semantica")
    )


def test_host_registration_still_requires_authoritative_permission(monkeypatch):
    invoked = AsyncMock(return_value={"items": []})
    monkeypatch.setattr(
        client.SemanticaClient,
        "from_file",
        lambda *args, **kwargs: SimpleNamespace(request=invoked),
    )
    permitted = {"value": False}

    def permission(name):
        assert name == "knowledge_bases"

        def dependency():
            if not permitted["value"]:
                raise HTTPException(403, "denied")
            return SimpleNamespace(id=7, role="admin")

        return dependency

    def server():
        return SimpleNamespace(services=SimpleNamespace(paths=SimpleNamespace(root=Path("."))))

    app = FastAPI()
    router, internal = host_routes.create_host_routers(
        current_user=lambda: None,
        get_server=server,
        require_permission=permission,
        application_id=lambda user: "wanx",
        model_host=SimpleNamespace(),
    )
    app.include_router(router, prefix="/api")
    app.include_router(internal)
    with TestClient(app) as http:
        assert http.get("/api/semantica/warehouses").status_code == 403
        invoked.assert_not_awaited()
        permitted["value"] = True
        assert http.get("/api/semantica/warehouses").json() == {"items": []}
        invoked.assert_awaited_once()
    operations = app.openapi()["paths"]["/api/semantica/{path}"]
    assert set(operations) == {"get", "post", "put", "patch", "delete"}
    assert len({value["operationId"] for value in operations.values()}) == 5


def test_host_and_studio_do_not_import_removed_adapters():
    root = Path(__file__).resolve().parents[3]
    removed = ("octop.infra.semantica", "octop.api.starlink_mcp", "octop.api.routers.semantica")
    for source in (root / "src/octop", root.parent / "apps/builder/backend/wanx_studio"):
        for path in source.rglob("*.py"):
            for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
                names = []
                if isinstance(node, ast.ImportFrom):
                    names = [node.module or ""]
                    names.extend((node.module or "") + "." + alias.name for alias in node.names)
                elif isinstance(node, ast.Import):
                    names = [alias.name for alias in node.names]
                assert not any(
                    name == old or name.startswith(old + ".") for name in names for old in removed
                ), path
