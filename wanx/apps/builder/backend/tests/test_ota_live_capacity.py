"""Disk snapshot capacity must not expand the live process's retained input."""
import json
import sqlite3
from types import SimpleNamespace

import pytest

from wanx_studio import ota_live, ota_readiness


def service(*bodies):
    db = sqlite3.connect(":memory:")
    db.execute("CREATE TABLE deployment_profile_objects(kind TEXT,key TEXT,body TEXT)")
    db.executemany("INSERT INTO deployment_profile_objects VALUES('expert-binding',?,?)",
                   [(str(index), body) for index, body in enumerate(bodies)])
    return SimpleNamespace(closing=False, store=SimpleNamespace(db=db),
                           deployments=SimpleNamespace(_closed=False))


def test_live_limits_are_independent_of_larger_disk_snapshot_limits():
    assert ota_readiness.MAX_BODY == 64 * 1024 * 1024
    assert ota_readiness.SNAPSHOT_BUDGET == 2 * 1024 * 1024 * 1024
    assert ota_live.MAX_BODY == 16 * 1024 * 1024
    assert ota_live.MAX_BINDING_BYTES == 128 * 1024 * 1024


@pytest.mark.asyncio
async def test_live_probe_rejects_binding_above_16_mib_without_writing():
    body = json.dumps({"state": "inactive", "padding": "x" * (16 * 1024 * 1024)})
    assert 16 * 1024 * 1024 < len(body.encode()) < ota_readiness.MAX_BODY
    svc = service(body)
    before = svc.store.db.total_changes
    try:
        report = await ota_live.inspect_runtime([svc])
        assert report["runtimeReady"] is False
        assert report["code"] == "KAIWU_RUNTIME_NOT_READY"
        assert report["excludedBindings"] == 0
        assert svc.store.db.total_changes == before
    finally:
        svc.store.db.close()


@pytest.mark.asyncio
async def test_live_binding_total_is_bounded_across_stores_at_exact_boundary(monkeypatch):
    # Scale only the live aggregate limit; exercise real SQLite iteration and
    # retained bodies across both services without a 128 MiB test allocation.
    body = json.dumps({"state": "inactive", "padding": "x" * 256})
    size = len(body.encode())
    first, second = service(body), service(body)
    before = [svc.store.db.total_changes for svc in (first, second)]
    try:
        monkeypatch.setattr(ota_live, "MAX_BINDING_BYTES", 2 * size - 1, raising=False)
        report = await ota_live.inspect_runtime([first, second])
        assert report["runtimeReady"] is False
        assert report["excludedBindings"] == 1
        monkeypatch.setattr(ota_live, "MAX_BINDING_BYTES", 2 * size)
        report = await ota_live.inspect_runtime([first, second])
        assert report["runtimeReady"] is True
        assert report["excludedBindings"] == 2
        assert [svc.store.db.total_changes for svc in (first, second)] == before
    finally:
        first.store.db.close()
        second.store.db.close()
