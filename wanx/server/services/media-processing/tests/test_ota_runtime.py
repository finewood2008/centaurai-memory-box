import json
import os
from threading import Event

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi import WebSocket
from fastapi.testclient import TestClient
import pytest
from starlette.websockets import WebSocketDisconnect

from wanx_media import app, ota_runtime
from wanx_media.worker import Worker


@pytest.fixture
def managed(tmp_path, monkeypatch):
    root = tmp_path.resolve()
    monkeypatch.setattr(ota_runtime, "_TRUST_ROOT", root)
    monkeypatch.setattr(ota_runtime, "_OWNER_UID", os.getuid())
    path = root / "runtime.json"
    marker = root / "drain"
    identity = {
        "version": "1.0.0",
        "buildId": "build",
        "sourceCommit": "a" * 40,
        "artifactDigest": "b" * 64,
        "runtimeDigest": "c" * 64,
        "activationGeneration": 2,
        "profile": dict(ota_runtime._PROFILE),
        "protocolVersion": 1,
    }
    path.write_text(json.dumps(identity))
    path.chmod(0o644)
    monkeypatch.setenv("WANX_MEDIA_OTA_RUNTIME_FILE", str(path))
    return root, path, marker, identity


def test_managed_version_is_bound_to_running_generation_and_local_assets(managed, monkeypatch):
    root, path, _, identity = managed
    monkeypatch.setattr(app, "local_models_configured", lambda _: False)
    public = Ed25519PrivateKey.generate().public_key()
    application = app.create_app(root / "store", public)
    path.write_text(json.dumps({**identity, "activationGeneration": 3}))
    with TestClient(application, client=("127.0.0.1", 50000)) as client:
        assert client.get("/version").json() == identity
        assert client.get("/readyz").json() == {"ready": False}

    monkeypatch.setattr(app, "local_models_configured", lambda _: True)
    monkeypatch.delenv("WANX_MEDIA_SUMMARY_CLOUD_KEY_FILE", raising=False)
    with TestClient(app.create_app(root / "store", public)) as client:
        assert client.get("/readyz").json() == {"ready": True}
        assert client.get("/version").json()["activationGeneration"] == 3


@pytest.mark.parametrize("kind", ["symlink", "writable", "foreign-profile", "invalid-generation"])
def test_invalid_ota_identity_cannot_fall_back_to_pilot(managed, kind):
    root, path, _, identity = managed
    if kind == "symlink":
        path.rename(root / "other.json")
        path.symlink_to(root / "other.json")
    elif kind == "writable":
        path.chmod(0o666)
    elif kind == "foreign-profile":
        path.write_text(json.dumps({**identity, "profile": {**identity["profile"], "profileDigest": "d" * 64}}))
    else:
        path.write_text(json.dumps({**identity, "activationGeneration": True}))
    with pytest.raises(ValueError, match="WANX_MEDIA_OTA_IDENTITY_INVALID"):
        ota_runtime.load_runtime_identity()


def test_drain_blocks_new_jobs_and_websockets_without_hiding_health(managed, monkeypatch):
    root, _, marker, _ = managed
    monkeypatch.setattr(app, "local_models_configured", lambda _: True)
    public = Ed25519PrivateKey.generate().public_key()
    application = app.create_app(root / "store", public)
    with TestClient(application, client=("127.0.0.1", 50500)) as client:
        drain = "/internal/ota/v1/drain"
        assert client.get(drain).json() == {"draining": False, "idle": False}
        marker.touch()
        assert client.post(app.PREFIX + "/jobs", json={}).json() == {"code": "MEDIA_UPDATING"}
        assert client.get(app.INTERNAL + "/context").status_code == 503
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(app.ASR_SESSIONS + "/" + "a" * 32 + "/stream"):
                pytest.fail("a new stream must be rejected during drain")
        assert client.get(drain).json() == {"draining": True, "idle": True}
        assert client.get("/readyz").json() == {"ready": True}
        marker.unlink()
        assert client.get(drain).json() == {"draining": False, "idle": False}
    nonlocal_client = TestClient(app.create_app(root / "store", public, start_worker=False))
    assert nonlocal_client.get(drain).status_code == 403


def test_worker_preserves_queued_tasks_while_drain_is_set():
    observed = Event()

    class Store:
        def claim(self):
            raise AssertionError("draining worker must not claim a queued job")

    def draining():
        observed.set()
        return True

    worker = Worker(Store(), pause_requested=draining)
    worker.thread.start()
    try:
        assert observed.wait(2)
        assert worker.idle()
    finally:
        worker.stop.set()
        worker.thread.join(timeout=2)
    assert not worker.thread.is_alive()


def test_drain_waits_until_an_existing_stream_finishes(managed, monkeypatch):
    root, _, marker, _ = managed
    monkeypatch.setattr(app, "local_models_configured", lambda _: True)
    public = Ed25519PrivateKey.generate().public_key()
    application = app.create_app(root / "store", public)
    path = app.PREFIX + "/test-ota-stream"

    @application.websocket(path)
    async def fixture_stream(socket: WebSocket):
        await socket.accept()
        await socket.receive_text()
        await socket.close()

    with TestClient(application, client=("127.0.0.1", 50500)) as client:
        with client.websocket_connect(path) as socket:
            marker.touch()
            assert client.get("/internal/ota/v1/drain").json() == {"draining": True, "idle": False}
            socket.send_text("end")
            with pytest.raises(WebSocketDisconnect):
                socket.receive_text()
        assert client.get("/internal/ota/v1/drain").json() == {"draining": True, "idle": True}
