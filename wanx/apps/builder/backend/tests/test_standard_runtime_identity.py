"""Public runtime principals come from verified native or server-issued scope."""
import time
from types import SimpleNamespace

import pytest
from starlette.requests import Request
from centuarai_local_data_gate import GateContext
from centuarai_local_data_gate.client import SCOPE_KEY

from wanx_studio.contracts import StudioError
from wanx_studio.wanx import standard_runtime_identity

SLOT = 'ai.wanx.selfmade.' + 'a' * 32
LAUNCH = 'A' * 43


def request(application=SLOT, resource=None, *, target='/api/wanx-expert-app/v1/context', method='GET'):
    path, _, query = target.partition('?')
    context = GateContext(None, None, {'applicationId': application, 'audience': 'octop', 'launchId': LAUNCH,
        'resourceId': resource or 'team:application:' + application,
        'serviceContext': {'principalNamespace': 'synthetic'}}, 'synthetic-proof', 1)
    context._deadline = time.monotonic() + 60
    scope = {'type': 'http', 'method': method, 'path': path, 'raw_path': path.encode(),
             'query_string': query.encode(), 'headers': [(b'x-owner', b'wanx:999')], SCOPE_KEY: context}
    return Request(scope), context


def dependency(*, required=True, service=None):
    events = []
    authority = SimpleNamespace(enter=lambda user: events.append(('enter', user.id)) or 'token',
                                reset=lambda token: events.append(('reset', token)), required=lambda: required)
    service = service or SimpleNamespace()
    service.local_authority = authority
    return standard_runtime_identity(service, lambda: None), events


@pytest.mark.asyncio
async def test_identity_yields_only_canonical_owner_and_verified_slot_and_always_resets(monkeypatch, tmp_path):
    monkeypatch.setenv('WANX_STUDIO_IDENTITY_ALIASES', '2:1')
    identity, events = dependency(service=SimpleNamespace(store=SimpleNamespace(root=tmp_path)))
    req, _ = request()
    user = SimpleNamespace(id=2, role='admin', application_id='wanx')
    iterator = identity(req, user)
    assert await anext(iterator) == {'owner': 'wanx:1', 'applicationId': SLOT, 'launchId': LAUNCH}
    assert events == [('enter', 2)]
    await iterator.aclose()
    assert events == [('enter', 2), ('reset', 'token')]


@pytest.mark.asyncio
async def test_identity_rejects_non_native_or_wrong_application_scope_before_authority():
    identity, events = dependency()
    user = SimpleNamespace(id=2, role='admin', application_id=SLOT)
    requests = [request(application=app)[0] for app in ['wanx-host', 'ai.wanx.studio', 'ordinary.app']]
    requests += [request(resource=value)[0] for value in ['team:management', 'team:application:ai.wanx.selfmade.' + 'b'*32]]
    plain, _ = request(); plain.scope.pop(SCOPE_KEY); requests.append(plain)
    forged, context = request(); forged.scope[SCOPE_KEY] = SimpleNamespace(claims=context.claims); requests.append(forged)
    missing, _ = request(); claims = dict(missing.scope[SCOPE_KEY].claims); claims.pop('launchId'); missing.scope[SCOPE_KEY].claims = claims; requests.append(missing)
    malformed, _ = request(); malformed.scope[SCOPE_KEY].claims = {**malformed.scope[SCOPE_KEY].claims, 'launchId': 'header-selected-launch'}; requests.append(malformed)
    for req in requests:
        with pytest.raises(StudioError, match='EXPERT_OPERATION_DENIED'):
            await anext(identity(req, user))
    assert events == []


def sso_request(token=None):
    req, _ = request(); req.scope.pop(SCOPE_KEY)
    if token is not None:req.scope['headers'].append((b'x-wanx-expert-launch', token.encode()))
    return req


@pytest.mark.asyncio
async def test_sso_uses_only_a_server_issued_owner_scoped_launch_and_resets(monkeypatch, tmp_path):
    from wanx_studio.deployment.standard_runtime import StandardRuntime, mint_sso_launch

    service = SimpleNamespace(store=SimpleNamespace(root=tmp_path))
    identity, events = dependency(required=False, service=service)
    profile = SimpleNamespace(available=True, clock=time.time, assert_source=lambda *_: None,
        assert_runtime=lambda session: events.append(('scope', session['owner'], session['deploymentSlot'])))
    service.directory_profile = profile
    binding = {'target': {'applicationId': 'base.app'}, 'expertBinding': {'slotApplicationId': SLOT},
               'generation': 1, 'artifactHash': 'a'*64}
    # This test exercises the real issuer/principal credential checks. Binding
    # lookup and live generation checks have their own deployment integration tests.
    monkeypatch.setattr(StandardRuntime, 'binding', lambda self, principal: (profile, binding))
    issued = mint_sso_launch(service, profile, 'wanx:7', binding)
    events.clear()
    user = SimpleNamespace(id=7, role='user', application_id='wanx')
    iterator = identity(sso_request(issued['launchToken']), user)
    assert await anext(iterator) == {'owner': 'wanx:7', 'applicationId': SLOT, 'launchId': issued['launchToken']}
    assert events == [('enter', 7), ('scope', 'wanx:7', SLOT)]
    await iterator.aclose()
    assert events[-1] == ('reset', 'token')
    for token, actor in [(None, user), ('B'*43, user), (issued['launchToken'], SimpleNamespace(id=8, role='user', application_id='wanx'))]:
        before = len(events)
        with pytest.raises(StudioError, match='EXPERT_OPERATION_DENIED'):
            await anext(identity(sso_request(token), actor))
        assert events[before:] == [('enter', actor.id), ('reset', 'token')]
    service.standard_launch_sessions[issued['launchToken']]['expires'] = time.time() - 1
    with pytest.raises(StudioError, match='EXPERT_OPERATION_DENIED'):
        await anext(identity(sso_request(issued['launchToken']), user))
    assert events[-1] == ('reset', 'token')


@pytest.mark.asyncio
async def test_sso_cannot_downgrade_required_native_or_invalid_native_context(monkeypatch):
    from wanx_studio.deployment.standard_runtime import StandardRuntime

    called = []
    monkeypatch.setattr(StandardRuntime, 'sso_principal', lambda *_: called.append(True))
    user = SimpleNamespace(id=7, role='user', application_id='wanx')
    identity, events = dependency(required=True)
    with pytest.raises(StudioError, match='EXPERT_OPERATION_DENIED'):
        await anext(identity(sso_request('A'*43), user))
    assert not called and not events
    identity, events = dependency(required=False)
    for application in [SLOT, 'ai.wanx.studio', 'ordinary.app']:
        with pytest.raises(StudioError, match='EXPERT_OPERATION_DENIED'):
            await anext(identity(sso_request('A'*43), SimpleNamespace(id=7, role='admin', application_id=application)))
    invalid, _ = request(resource='team:management')
    invalid.scope['headers'].append((b'x-wanx-expert-launch', b'A'*43))
    with pytest.raises(StudioError, match='EXPERT_OPERATION_DENIED'):
        await anext(identity(invalid, user))
    assert not called and not events


@pytest.mark.asyncio
async def test_sso_stale_generation_error_keeps_code_and_closes_authority(monkeypatch):
    from wanx_studio.deployment.standard_runtime import StandardRuntime

    def stale(*_):raise StudioError('UPDATE_REQUIRED', 409)
    monkeypatch.setattr(StandardRuntime, 'sso_principal', stale)
    identity, events = dependency(required=False)
    user = SimpleNamespace(id=7, role='user', application_id='wanx')
    with pytest.raises(StudioError, match='UPDATE_REQUIRED'):
        await anext(identity(sso_request('A'*43), user))
    assert events == [('enter', 7), ('reset', 'token')]


@pytest.mark.asyncio
async def test_identity_rejects_query_wrong_methods_and_closed_native_context():
    identity, events = dependency()
    user = SimpleNamespace(id=2, role='admin', application_id='wanx')
    for method, target in [('HEAD', '/api/wanx-expert-app/v1/context'), ('GET', '/api/wanx-expert-app/v1/context?'),
                           ('GET', '/api/wanx-expert-app/v1/context?owner=wanx:999'),
                           ('POST', '/api/wanx-expert-app/v1/context'), ('GET', '/api/wanx-expert-app/v1/invoke')]:
        req, _ = request(target=target, method=method)
        # ASGI preserves a non-empty query; raw_path records the bare '?' case.
        if target.endswith('?'):req.scope['raw_path'] = target.encode()
        with pytest.raises(StudioError, match='EXPERT_OPERATION_DENIED'):
            await anext(identity(req, user))
    req, context = request(); context._closed = True
    with pytest.raises(StudioError, match='STUDIO_AUTHORIZATION_EXPIRED'):
        await anext(identity(req, user))
    assert events == []


@pytest.mark.asyncio
async def test_verified_runtime_context_is_fenced_before_persistent_pin_and_resets_authority(tmp_path):
    from wanx_studio.upgrade_guard import acquire
    identity, events = dependency(service=SimpleNamespace(store=SimpleNamespace(root=tmp_path)))
    req, _ = request()
    user = SimpleNamespace(id=7, role='user', application_id='wanx')
    exclusive = acquire(tmp_path, exclusive=True)
    try:
        with pytest.raises(StudioError, match='BUILDER_UPGRADE_BUSY'):
            await anext(identity(req, user))
    finally:
        exclusive.close()
    assert events == [('enter', 7), ('reset', 'token')]
