"""Live OTA inspection crosses the real expert verifier without invoking a model."""
import json
from types import SimpleNamespace

import pytest

from test_expert_runtime import setup, OWNER
from wanx_studio.ota_live import inspect_runtime


def live_service(h):
    h.svc.closing = False
    h.svc.expert_runtime = h.engine
    h.svc.deployment_profile.available = True
    h.svc.deployment_profile.expert = SimpleNamespace(available=True)
    h.svc.deployment_profile.miniapp = SimpleNamespace(available=True)
    h.svc.deployments = SimpleNamespace(_closed=False, journal=SimpleNamespace(
        get_environment=lambda target: {'generation': 1, 'health': 'healthy', 'activeOperationId': None}))
    h.svc.store.db.execute('CREATE TABLE IF NOT EXISTS deployment_profile_objects(kind TEXT,key TEXT,body TEXT)')
    binding = {**h.active[h.binding['slotApplicationId']], 'slotApplicationId': h.binding['slotApplicationId']}
    h.svc.store.db.execute('INSERT INTO deployment_profile_objects VALUES(?,?,?)',
                           ('expert-binding', 'slot', json.dumps(binding)))
    return h.svc


@pytest.mark.asyncio
async def test_live_probe_checks_real_frozen_expert_without_model_or_persistent_mutation(setup):
    h = setup
    service = live_service(h)
    before_changes = service.store.db.total_changes
    before_runs = service.store.db.execute('SELECT count(*) FROM deployment_expert_runs').fetchone()[0]
    before_workspace = dict(h.registry.workspaces[h.binding['agentId']].files)
    report = await inspect_runtime([service])
    assert report['runtimeReady'] is True and report['checkedBindings'] == 1
    assert service.store.db.total_changes == before_changes
    assert service.store.db.execute('SELECT count(*) FROM deployment_expert_runs').fetchone()[0] == before_runs
    assert h.registry.workspaces[h.binding['agentId']].files == before_workspace
    assert not h.enqueued and not h.prepared and not h.engine._upgrade_locks
    assert OWNER not in json.dumps(report)


@pytest.mark.asyncio
async def test_live_probe_detects_real_expert_workspace_drift(setup):
    h = setup
    service = live_service(h)
    h.registry.workspaces[h.binding['agentId']].files['SOUL.md'] = b'changed synthetic seed'
    before = service.store.db.total_changes
    report = await inspect_runtime([service])
    assert report['runtimeReady'] is False
    assert service.store.db.total_changes == before
    assert not h.enqueued and not h.prepared


@pytest.mark.asyncio
async def test_live_probe_rejects_revoked_real_expert_owner(setup):
    h = setup
    service = live_service(h)
    h.users[7].disabled = True
    before = service.store.db.total_changes
    report = await inspect_runtime([service])
    assert report['runtimeReady'] is False
    assert service.store.db.total_changes == before
    assert not h.enqueued and not h.prepared


@pytest.mark.asyncio
async def test_live_probe_rejects_binding_changed_while_verifying_workspace(setup, monkeypatch):
    h = setup
    service = live_service(h)
    verify = h.engine.verify
    async def changed(owner, binding, guard):
        await verify(owner, binding, guard)
        row = service.store.db.execute("SELECT body FROM deployment_profile_objects WHERE kind='expert-binding'").fetchone()
        active = json.loads(row[0]); active['generation'] = 2
        service.store.db.execute("UPDATE deployment_profile_objects SET body=? WHERE kind='expert-binding'", (json.dumps(active),))
        service.deployments.journal.get_environment = lambda target: {
            'generation': 2, 'health': 'healthy', 'activeOperationId': None}
    monkeypatch.setattr(h.engine, 'verify', changed)
    report = await inspect_runtime([service])
    assert report['runtimeReady'] is False
    assert not h.enqueued and not h.prepared
