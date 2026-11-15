import json
import os

import httpx
import pytest

from wanx_bridge import service_activation
from wanx_bridge.huohua import service_status
from wanx_bridge.service_registry import ServiceRegistry

PROFILE = {
    "profileId": "huohua-python312-ubuntu2404-x64",
    "profileVersion": 1,
    "profileDigest": "2ed938432d04035fff396c7e70e845442f0bb9abce5246d9479842bda3255069",
}


def activation():
    return {
        "schemaVersion": 1,
        "serviceId": "huohua.workbench",
        "state": "committed",
        "version": "1.0.0",
        "buildId": "spark-test-1",
        "sourceCommit": "a" * 40,
        "artifactDigest": "b" * 64,
        "runtimeDigest": "c" * 64,
        "activationGeneration": 1,
        "serviceProtocol": 1,
        "profile": dict(PROFILE),
        "operationId": "op-1",
        "attemptGeneration": 1,
        "planDigest": "d" * 64,
    }


def setup(tmp_path, monkeypatch):
    monkeypatch.setattr(service_activation, "ROOT_UID", os.geteuid())
    # The test tree is not an OS-owned production path. Check its immediate
    # parent; production paths additionally check every ancestor.
    monkeypatch.setattr(service_activation, "TRUST_BOUNDARY", tmp_path)
    path = tmp_path / "activation.json"
    raw = {
        "schemaVersion": 1,
        "services": {
            "huohua.workbench": {
                "enabled": True,
                "upstream": "http://127.0.0.1:8093",
                "uid": 10006,
                "tokenAudience": "wanx-bridge",
                "protocolVersion": 1,
                "minWanxVersion": ">=1.0.0",
                "routes": [{"prefix": "/api/huohua/v1", "methods": ["GET", "POST"], "sse": True}],
                "health": {"liveness": "/healthz", "readiness": "/readyz", "version": "/version"},
                "servicePublicKeyFile": str(tmp_path / "key.pub"),
                "activation": {"mode": "ota", "path": str(path)},
            }
        },
    }
    calls = []
    running = {**activation(), "protocolVersion": 1}

    def handler(request):
        calls.append(request.url.path)
        return httpx.Response(
            200, json=running if request.url.path == "/version" else {"ready": True}
        )

    return (
        path,
        ServiceRegistry.from_mapping(raw),
        running,
        calls,
        httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )


def save(path, value):
    path.write_text(json.dumps(value))
    path.chmod(0o644)


async def test_only_committed_matching_activation_is_ready_without_bridge_restart(
    tmp_path, monkeypatch
):
    path, registry, running, calls, client = setup(tmp_path, monkeypatch)
    async with client:
        assert (await service_status(registry, "huohua.workbench", client=client))[
            "status"
        ] == "not_installed"
        assert not calls
        value = activation()
        value["state"] = "preparing"
        save(path, value)
        assert (await service_status(registry, "huohua.workbench", client=client))[
            "code"
        ] == "SERVICE_ACTIVATION_PENDING"
        assert not calls
        value["state"] = "committed"
        save(path, value)
        assert (await service_status(registry, "huohua.workbench", client=client))[
            "status"
        ] == "ready"
        running["buildId"] = "candidate"
        assert (await service_status(registry, "huohua.workbench", client=client))[
            "code"
        ] == "SERVICE_ACTIVATION_MISMATCH"


@pytest.mark.parametrize("mutation", ["writable", "symlink", "owner", "profile", "missing_binding"])
async def test_untrusted_or_incomplete_activation_fails_closed(tmp_path, monkeypatch, mutation):
    path, registry, running, calls, client = setup(tmp_path, monkeypatch)
    value = activation()
    if mutation == "profile":
        value["profile"]["profileDigest"] = "0" * 64
    if mutation == "missing_binding":
        del value["planDigest"]
    save(path, value)
    if mutation == "writable":
        path.chmod(0o666)
    if mutation == "symlink":
        target = path.with_suffix(".real")
        path.rename(target)
        path.symlink_to(target)
    if mutation == "owner":
        monkeypatch.setattr(service_activation, "ROOT_UID", os.geteuid() + 1)
    async with client:
        result = await service_status(registry, "huohua.workbench", client=client)
    assert result["status"] != "ready"
    assert not calls


async def test_activation_replaced_during_probe_is_not_advertised_ready(tmp_path, monkeypatch):
    path, registry, running, calls, client = setup(tmp_path, monkeypatch)
    await client.aclose()
    save(path, activation())

    def handler(request):
        if request.url.path == "/version":
            value = activation()
            value["state"] = "preparing"
            save(path, value)
        return httpx.Response(
            200, json=running if request.url.path == "/version" else {"ready": True}
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        assert (await service_status(registry, "huohua.workbench", client=client))[
            "code"
        ] == "SERVICE_ACTIVATION_CHANGED"


def test_build_evidence_requires_actual_running_identity_and_writes_atomic_json(
    tmp_path, monkeypatch
):
    process = {"pid": 123, "startTimeTicks": "42", "bootId": "a" * 36}
    monkeypatch.setattr(service_activation, "running_process_identity", lambda: process)
    path = tmp_path / "evidence.json"
    with pytest.raises(
        service_activation.ActivationError, match="BRIDGE_BUILD_EVIDENCE_UNAVAILABLE"
    ):
        service_activation.write_bridge_evidence(path, {"version": "1.0.0"})
    assert not path.exists()
    service_activation.write_bridge_evidence(path, {"buildId": "running-release-1"})
    assert json.loads(path.read_text()) == {
        "schemaVersion": 1,
        "bridgeProtocol": 1,
        "bridgeBuildId": "running-release-1",
        "process": process,
    }
    assert path.stat().st_mode & 0o777 == 0o644


def test_unstamped_restart_invalidates_previous_build_evidence(tmp_path, monkeypatch):
    monkeypatch.setattr(service_activation, "running_process_identity", lambda: {"pid": 123})
    path = tmp_path / "evidence.json"
    service_activation.write_bridge_evidence(path, {"buildId": "old-build"})
    with pytest.raises(service_activation.ActivationError):
        service_activation.write_bridge_evidence(path, {})
    assert not path.exists()


def test_process_evidence_failure_invalidates_previous_build(tmp_path, monkeypatch):
    path = tmp_path / "evidence.json"
    path.write_text("stale")

    def unavailable():
        raise service_activation.ActivationError("BRIDGE_PROCESS_EVIDENCE_UNAVAILABLE")

    monkeypatch.setattr(service_activation, "running_process_identity", unavailable)
    with pytest.raises(
        service_activation.ActivationError, match="BRIDGE_PROCESS_EVIDENCE_UNAVAILABLE"
    ):
        service_activation.write_bridge_evidence(path, {"buildId": "build-1"})
    assert not path.exists()


async def test_python314_shared_ubuntu_profile_is_ready_only_for_matching_runtime(tmp_path, monkeypatch):
    path, registry, running, calls, client = setup(tmp_path, monkeypatch)
    value = activation()
    value["profile"] = {
        "profileId": "huohua-python314-ubuntu-x64",
        "profileVersion": 1,
        "profileDigest": "6fab32770dbeaa4210be3afa9ee9b585144f3b4a13b53cd1631bb372965e9e50",
    }
    running["profile"] = dict(value["profile"])
    save(path, value)
    async with client:
        assert (await service_status(registry, "huohua.workbench", client=client))["status"] == "ready"
        running["profile"] = dict(PROFILE)
        assert (await service_status(registry, "huohua.workbench", client=client))["code"] == "SERVICE_ACTIVATION_MISMATCH"


@pytest.mark.parametrize("profile", [
    {**PROFILE, "profileId": "huohua-python314-ubuntu-x64"},
    {**PROFILE, "profileDigest": "6fab32770dbeaa4210be3afa9ee9b585144f3b4a13b53cd1631bb372965e9e50"},
    {**PROFILE, "profileId": "huohua-python312-ubuntu2604-x64"},
    {**PROFILE, "profileVersion": 2},
    {**PROFILE, "profileVersion": True},
])
async def test_profile_catalog_rejects_mixed_or_unknown_identity(tmp_path, monkeypatch, profile):
    path, registry, running, calls, client = setup(tmp_path, monkeypatch)
    value = activation()
    value["profile"] = profile
    running["profile"] = profile
    save(path, value)
    async with client:
        assert (await service_status(registry, "huohua.workbench", client=client))["code"] == "SERVICE_ACTIVATION_INVALID"
    assert not calls
