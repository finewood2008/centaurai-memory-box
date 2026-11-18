import asyncio
import json
import os
import sqlite3
from types import SimpleNamespace

import pytest

from wanx_studio.ota_live import inspect_runtime, ProbeServer, query


@pytest.mark.asyncio
async def test_real_editor_services_pass_live_probe_until_their_lifecycle_closes(tmp_path):
    from wanx_studio.service import StudioService
    from wanx_studio.workshop import PersonalWorkshop
    from wanx_studio.deployment.miniapp_profile import MiniappProfile

    services = [StudioService(tmp_path / 'studio', tmp_path),
                PersonalWorkshop(tmp_path / 'workshop', tmp_path)]
    try:
        for svc in services:
            svc.deployment_profile = MiniappProfile(svc)
        assert (await inspect_runtime(services))['runtimeReady'] is True
        services[1].deployments._closed = True
        assert (await inspect_runtime(services))['runtimeReady'] is False
        services[1].deployments._closed = False
        await services[0].close()
        assert (await inspect_runtime(services))['runtimeReady'] is False
    finally:
        for svc in services:
            await svc.close()


def service(tmp_path, binding=None, verify=None):
    db = sqlite3.connect(':memory:')
    db.execute('CREATE TABLE deployment_profile_objects(kind TEXT,key TEXT,body TEXT)')
    if binding:
        db.execute('INSERT INTO deployment_profile_objects VALUES(?,?,?)', ('expert-binding', 'slot', json.dumps(binding)))
    profile = SimpleNamespace(available=True)
    return SimpleNamespace(closing=False, store=SimpleNamespace(db=db),
        deployments=SimpleNamespace(_closed=False, journal=SimpleNamespace(get_environment=lambda target: {
            'generation': 2, 'activeOperationId': None, 'health': 'healthy'})),
        deployment_profile=profile, expert_runtime=SimpleNamespace(closed=False, verify=verify))


@pytest.mark.asyncio
async def test_live_probe_verifies_real_bindings_without_starting_model_or_writing(tmp_path):
    seen = []
    async def verify(owner, binding, guard):
        guard(); seen.append((owner, binding))
    binding = {'owner': 'wanx:1', 'target': {'environment': 'prod'}, 'generation': 2,
               'state': 'active', 'expertBinding': {'profile': 'wanx-expert-app-v1', 'owner': 'wanx:1', 'target': {'environment': 'prod'}}}
    first, second = service(tmp_path, binding, verify), service(tmp_path)
    before = first.store.db.total_changes
    report = await inspect_runtime([first, second])
    assert report['runtimeReady'] is True and report['checkedBindings'] == 1
    assert len(seen) == 1 and first.store.db.total_changes == before
    assert 'wanx:1' not in json.dumps(report)


@pytest.mark.asyncio
async def test_missing_or_broken_live_runtime_cannot_pass_via_database_readability(tmp_path):
    assert (await inspect_runtime([None, service(tmp_path)]))['runtimeReady'] is False
    async def broken(*args):
        raise RuntimeError('private credential must not escape')
    binding = {'owner': 'wanx:1', 'target': {}, 'generation': 2,
               'state': 'active', 'expertBinding': {}}
    report = await inspect_runtime([service(tmp_path, binding, broken), service(tmp_path)])
    assert report['runtimeReady'] is False
    assert 'credential' not in json.dumps(report)


@pytest.mark.asyncio
async def test_private_socket_queries_running_service_and_cleans_up(tmp_path, monkeypatch):
    from pathlib import Path
    monkeypatch.chdir(tmp_path)
    path = Path('probe.sock')
    async def inspect():
        return {'schemaVersion': 1, 'protocol': 1, 'runtimeReady': True, 'checkedBindings': 0,
                'excludedBindings': 0, 'code': None}
    probe = ProbeServer(path, inspect)
    await probe.start()
    try:
        assert os.stat(path).st_mode & 0o777 == 0o600
        result = await query(path)
        assert result['runtimeReady'] is True
    finally:
        await probe.close()
    assert not path.exists()


@pytest.mark.asyncio
async def test_socket_refuses_to_replace_foreign_files(tmp_path):
    path = tmp_path / 'probe.sock'; path.write_text('customer data')
    probe = ProbeServer(path, lambda: None)
    with pytest.raises(OSError):
        await probe.start()
    assert path.read_text() == 'customer data'


@pytest.mark.asyncio
async def test_restart_replaces_only_same_uid_refused_socket(tmp_path, monkeypatch):
    import socket
    from pathlib import Path
    monkeypatch.chdir(tmp_path)
    path = Path('probe.sock')
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as stale:
        stale.bind(str(path))
    async def inspect():
        return {'schemaVersion': 1, 'protocol': 1, 'runtimeReady': True}
    probe = ProbeServer(path, inspect)
    await probe.start()
    try:
        assert (await query(path))['runtimeReady'] is True
        other = ProbeServer(path, inspect)
        with pytest.raises(OSError):
            await other.start()
        assert (await query(path))['runtimeReady'] is True
    finally:
        await probe.close()


@pytest.mark.asyncio
@pytest.mark.skipif(os.name != 'posix', reason='POSIX OTA admission')
async def test_http_state_admission_is_fenced_while_read_only_polling_remains_available(tmp_path):
    from wanx_studio.upgrade_guard import acquire, request_admission
    from wanx_studio.contracts import StudioError
    svc = SimpleNamespace(store=SimpleNamespace(root=tmp_path))
    exclusive = acquire(tmp_path, exclusive=True)
    try:
        with pytest.raises(StudioError, match='BUILDER_UPGRADE_BUSY'):
            async with request_admission(svc, 'POST'):
                pytest.fail('mutating HTTP request crossed OTA fence')
        async with request_admission(svc, 'GET'):
            pass
    finally:
        exclusive.close()
    async with request_admission(svc, 'POST'):
        with pytest.raises(StudioError, match='BUILDER_UPGRADE_BUSY'):
            acquire(tmp_path, exclusive=True)
    with acquire(tmp_path, exclusive=True):
        pass


def test_probe_registration_is_safe_before_event_loop_and_preserves_app_lifespan(tmp_path, monkeypatch):
    from contextlib import asynccontextmanager
    from pathlib import Path
    from fastapi import FastAPI
    import wanx_studio.ota_live as live
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv('WANX_KAIWU_OTA_PROTOCOL', '1')
    monkeypatch.setattr(live, 'SOCKET', Path('probe.sock'))
    events = []
    @asynccontextmanager
    async def original(app):
        events.append('start')
        yield
        events.append('stop')
    app = FastAPI(lifespan=original)
    server = SimpleNamespace(_wanx_studio_service=service(tmp_path), _wanx_workshop_service=service(tmp_path))
    live.register(app, server)
    assert not Path('probe.sock').exists()
    async def run():
        async with app.router.lifespan_context(app):
            assert events == ['start']
            assert (await query(Path('probe.sock')))['runtimeReady'] is True
        assert events == ['start', 'stop'] and not Path('probe.sock').exists()
    asyncio.run(run())


@pytest.mark.asyncio
async def test_later_workspace_check_cannot_hide_an_earlier_binding_change(tmp_path):
    calls = []
    async def verify(owner, binding, guard):
        calls.append(binding)
        if len(calls) == 2:
            first = json.loads(svc.store.db.execute("SELECT body FROM deployment_profile_objects WHERE key='slot'").fetchone()[0])
            first['generation'] = 3
            svc.store.db.execute("UPDATE deployment_profile_objects SET body=? WHERE key='slot'", (json.dumps(first),))
    def binding(environment):
        return {'owner': 'wanx:1', 'target': {'environment': environment}, 'generation': 2,
                'state': 'active', 'expertBinding': {'owner': 'wanx:1', 'target': {'environment': environment}}}
    svc = service(tmp_path, binding('dev'), verify)
    svc.store.db.execute("INSERT INTO deployment_profile_objects VALUES(?,?,?)", ('expert-binding', 'slot2', json.dumps(binding('prod'))))
    report = await inspect_runtime([svc])
    assert report['runtimeReady'] is False
