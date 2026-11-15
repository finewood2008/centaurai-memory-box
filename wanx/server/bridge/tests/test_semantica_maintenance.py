"""A persistent migration fence blocks real upstream requests until exact release."""

import asyncio
import json
import os
import subprocess
import sys
from importlib import import_module
from types import SimpleNamespace

import httpx
import pytest

from wanx_bridge.semantica import client as mounted

BINDING = {
    "schemaVersion": 1,
    "operationId": "migration-test",
    "attemptGeneration": 1,
    "planDigest": "a" * 64,
}
CONFIG = {
    "service_url": "http://127.0.0.1:8090",
    "service_token": "synthetic-" * 6,
    "box_id": "synthetic-box",
    "application_id": "semantica",
}


@pytest.fixture
def configured(tmp_path, monkeypatch):
    path = tmp_path / "semantica.json"
    path.write_text(json.dumps(CONFIG))
    path.chmod(0o600)
    calls = []
    real = httpx.AsyncClient

    def response(request):
        calls.append(request)
        return httpx.Response(200, json={"ok": True})

    monkeypatch.setattr(
        mounted.httpx,
        "AsyncClient",
        lambda **kw: real(**kw, transport=httpx.MockTransport(response)),
    )
    return path, calls


@pytest.mark.parametrize("marker", [json.dumps(BINDING), "{corrupt", "{}"])
async def test_actual_client_cannot_contact_service_during_maintenance(configured, marker):
    path, calls = configured
    gate = path.parent / "semantica-maintenance.json"
    gate.write_text(marker)
    gate.chmod(0o600)
    with pytest.raises(mounted.SemanticaError) as caught:
        await mounted.SemanticaClient.from_file(path, 7).request("GET", "/documents")
    assert caught.value.code == "SEMANTICA_MAINTENANCE"
    assert caught.value.status == 503 and not calls


async def test_only_fixed_capability_probe_is_allowed(configured):
    path, calls = configured
    gate = path.parent / "semantica-maintenance.json"
    gate.write_text(json.dumps(BINDING))
    gate.chmod(0o600)
    client = mounted.SemanticaClient.from_file(path, 7)
    assert await client.request("GET", "/capabilities") == {"ok": True}
    with pytest.raises(mounted.SemanticaError):
        await client.public_read("POST", "/search", "xg_" + "a" * 40, payload={"query": "x"})
    assert len(calls) == 1


async def test_existing_job_authorization_can_finish_while_new_extraction_is_blocked(configured):
    path, calls = configured
    gate = import_module("wanx_bridge.semantica.maintenance")
    gate.acquire(path.parent, BINDING)
    client = mounted.SemanticaClient.from_file(path, 7)
    assert await client.request(
        "POST",
        "/processing/authorize",
        payload={
            "operation_id": "same-existing-job",
            "job_id": "job",
            "purpose": "extraction",
            "model_id": "model",
            "model_revision": "revision",
        },
    ) == {"ok": True}
    with pytest.raises(mounted.SemanticaError) as caught:
        await client.request("POST", "/processing/check", payload={"operation_id": "new-check"})
    assert caught.value.code == "SEMANTICA_MAINTENANCE" and len(calls) == 1


@pytest.mark.parametrize("suffix", ["/native/documents", "/native/documents/doc/extraction"])
async def test_actual_bridge_blocks_native_upload_and_extraction(tmp_path, suffix):
    from test_gateway import Auth

    from wanx_bridge.server import create_app

    gate = import_module("wanx_bridge.semantica.maintenance")
    config_file = tmp_path / "semantica.json"
    config_file.write_text(json.dumps(CONFIG))
    config_file.chmod(0o600)
    gate.acquire(tmp_path, BINDING)
    upstream = []

    def handle(request):
        upstream.append(request)
        return httpx.Response(200, json={"should_not": "forward"})

    app = create_app(
        Auth(),
        object(),
        semantica_config_file=config_file,
        http_transport=httpx.MockTransport(handle),
        dashboard_dir=tmp_path,
    )
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://bridge"
        ) as http:
            response = await http.post(
                "/api/semantica" + suffix,
                headers={"authorization": "Bearer opaque-marker"},
                files={"file": ("material.txt", b"synthetic material")},
            )
    assert response.status_code == 503
    assert response.json()["code"] == "SEMANTICA_MAINTENANCE" and not upstream


def test_acquire_persists_and_release_requires_exact_binding(tmp_path):
    gate = import_module("wanx_bridge.semantica.maintenance")
    assert gate.CAPABILITY == "wanx.semantica-maintenance.v1"
    assert gate.acquire(tmp_path, BINDING) == {
        "schemaVersion": 1,
        "status": "held",
        "binding": BINDING,
    }
    assert gate.read(tmp_path) == gate.acquire(tmp_path, BINDING)
    with pytest.raises(gate.MaintenanceError):
        gate.release(tmp_path, {**BINDING, "operationId": "another"})
    assert gate.read(tmp_path)["status"] == "held"
    assert gate.release(tmp_path, BINDING) == {"schemaVersion": 1, "status": "released"}
    assert gate.read(tmp_path) == {"schemaVersion": 1, "status": "idle"}
    assert gate.release(tmp_path, BINDING)["status"] == "released"


def test_corrupt_symlink_and_linked_gate_fail_closed(tmp_path):
    gate = import_module("wanx_bridge.semantica.maintenance")
    marker = tmp_path / "semantica-maintenance.json"
    for raw in (b"{", json.dumps({**BINDING, "attemptGeneration": True}).encode()):
        marker.write_bytes(raw)
        marker.chmod(0o600)
        with pytest.raises(gate.MaintenanceError):
            gate.release(tmp_path, BINDING)
        with pytest.raises(gate.MaintenanceError):
            with gate.request_guard(tmp_path, "GET", "/api/integration/documents"):
                pytest.fail("maintenance allowed request")
        marker.unlink()
    external = tmp_path / "external"
    external.write_text(json.dumps(BINDING))
    external.chmod(0o600)
    marker.symlink_to(external)
    with pytest.raises(gate.MaintenanceError):
        gate.acquire(tmp_path, BINDING)
    marker.unlink()
    os.link(external, marker)
    with pytest.raises(gate.MaintenanceError):
        gate.release(tmp_path, BINDING)
    assert external.exists()


def test_acquire_drains_cross_process_inflight_requests(tmp_path):
    gate = import_module("wanx_bridge.semantica.maintenance")
    with gate.request_guard(tmp_path, "POST", "/api/integration/processing"):
        code = (
            "import json,sys;from pathlib import Path;"
            "from wanx_bridge.semantica.maintenance import acquire;"
            "print(json.dumps(acquire(Path(sys.argv[1]),json.loads(sys.argv[2]),timeout=3)),flush=True)"
        )
        child = subprocess.Popen(
            [sys.executable, "-c", code, str(tmp_path), json.dumps(BINDING)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        try:
            import time

            deadline = time.monotonic() + 2
            while (
                not (tmp_path / "semantica-maintenance.json").exists()
                and time.monotonic() < deadline
            ):
                assert child.poll() is None
                time.sleep(0.01)
            assert child.poll() is None
            assert (tmp_path / "semantica-maintenance.json").exists()
            with pytest.raises(gate.MaintenanceError):
                with gate.request_guard(tmp_path, "GET", "/api/integration/documents"):
                    pytest.fail("new poll bypassed the pending drain")
        except BaseException:
            child.kill()
            child.wait()
            raise
    out, err = child.communicate(timeout=5)
    assert child.returncode == 0, err.decode()
    assert json.loads(out)["status"] == "held"
    with pytest.raises(gate.MaintenanceError):
        with gate.request_guard(tmp_path, "GET", "/api/integration/documents"):
            pytest.fail("gate reopened after drain")


def test_gate_file_is_private_and_survives_new_module_instance(tmp_path):
    gate = import_module("wanx_bridge.semantica.maintenance")
    gate.acquire(tmp_path, BINDING)
    marker = tmp_path / "semantica-maintenance.json"
    assert marker.stat().st_mode & 0o777 == 0o600
    assert marker.stat().st_uid == os.getuid()
    code = (
        "import json,sys;from pathlib import Path;"
        "from wanx_bridge.semantica.maintenance import read;"
        "print(json.dumps(read(Path(sys.argv[1]))))"
    )
    result = subprocess.check_output([sys.executable, "-c", code, str(tmp_path)], text=True)
    assert json.loads(result)["binding"] == BINDING


def test_publish_crash_leaves_one_link_and_same_task_can_resume(tmp_path):
    gate = import_module("wanx_bridge.semantica.maintenance")
    code = """import json,os,sys
from pathlib import Path
from wanx_bridge.semantica import maintenance as gate
rename=gate.os.rename
def cut(source,target):
    rename(source,target)
    os._exit(73)
gate.os.rename=cut
gate.acquire(Path(sys.argv[1]),json.loads(sys.argv[2]))
"""
    child = subprocess.run([sys.executable, "-c", code, str(tmp_path), json.dumps(BINDING)])
    assert child.returncode == 73
    marker = tmp_path / "semantica-maintenance.json"
    assert marker.stat().st_nlink == 1
    assert gate.acquire(tmp_path, BINDING)["status"] == "held"
    assert gate.release(tmp_path, BINDING)["status"] == "released"


def test_business_errors_are_not_relabelled_as_maintenance(tmp_path):
    gate = import_module("wanx_bridge.semantica.maintenance")
    with pytest.raises(OSError, match="business unavailable"):
        with gate.request_guard(tmp_path, "POST", "/api/integration/processing"):
            raise OSError("business unavailable")


async def test_asgi_fence_drains_until_stream_response_closes(tmp_path):
    gate = import_module("wanx_bridge.semantica.maintenance")
    streaming, finish = asyncio.Event(), asyncio.Event()
    sent = []

    async def app(scope, receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"first", "more_body": True})
        streaming.set()
        await finish.wait()
        await send({"type": "http.response.body", "body": b"last"})

    async def send(value):
        sent.append(value)

    async def receive():
        return {"type": "http.request", "body": b""}

    wrapped = gate.SemanticaMaintenanceMiddleware(app, home=tmp_path)
    response = asyncio.create_task(
        wrapped(
            {"type": "http", "method": "GET", "path": "/api/semantica/native/documents"},
            receive,
            send,
        )
    )
    await streaming.wait()
    acquire = asyncio.create_task(asyncio.to_thread(gate.acquire, tmp_path, BINDING, timeout=3))
    try:
        for _ in range(100):
            if (tmp_path / "semantica-maintenance.json").exists():
                break
            await asyncio.sleep(0.01)
        assert not acquire.done()
        finish.set()
        await response
        assert (await acquire)["status"] == "held"
        assert sent[-1]["body"] == b"last"
    finally:
        finish.set()
        await asyncio.gather(response, acquire, return_exceptions=True)


async def test_mcp_public_read_cannot_bypass_the_same_fence(tmp_path):
    gate = import_module("wanx_bridge.semantica.maintenance")
    mcp = import_module("wanx_bridge.semantica.mcp")
    gate.acquire(tmp_path, BINDING)
    with pytest.raises(mounted.SemanticaError) as caught:
        await mcp.public_read(
            SimpleNamespace(paths=SimpleNamespace(root=tmp_path)),
            "xg_" + "a" * 40,
            "/search",
            payload={"query": "synthetic"},
        )
    assert caught.value.code == "SEMANTICA_MAINTENANCE" and caught.value.status == 503


def test_non_posix_development_host_preserves_ordinary_flow_without_a_fence(tmp_path, monkeypatch):
    gate = import_module("wanx_bridge.semantica.maintenance")
    monkeypatch.setattr(gate, "fcntl", None)
    with gate.request_guard(tmp_path, "POST", "/api/integration/processing"):
        pass
    with pytest.raises(gate.MaintenanceError):
        gate.acquire(tmp_path, BINDING)
    (tmp_path / "semantica-maintenance.json").write_text("{}")
    with pytest.raises(gate.MaintenanceError):
        with gate.request_guard(tmp_path, "GET", "/api/integration/documents"):
            pytest.fail("unrecognized persistent fence was ignored")


def test_split_uid_root_gateway_preserves_ordinary_flow_but_cannot_claim_drain(
    tmp_path, monkeypatch
):
    gate = import_module("wanx_bridge.semantica.maintenance")
    if tmp_path.stat().st_uid == 0:
        pytest.skip("requires a non-root fixture owner")
    monkeypatch.setattr(gate.os, "geteuid", lambda: 0)
    with gate.request_guard(tmp_path, "GET", "/api/integration/documents"):
        pass
    assert not (tmp_path / "semantica-maintenance.lock").exists()
    with pytest.raises(gate.MaintenanceError):
        gate.acquire(tmp_path, BINDING)
    (tmp_path / "semantica-maintenance.json").write_text(json.dumps(BINDING))
    with pytest.raises(gate.MaintenanceError):
        with gate.request_guard(tmp_path, "POST", "/api/integration/processing"):
            pytest.fail("root gateway bypassed a foreign service user's fence")
