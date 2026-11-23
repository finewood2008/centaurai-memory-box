"""Managed deployment transport, persistence and authorization on standard releases."""
import asyncio
from copy import deepcopy
import threading
from uuid import uuid4

import pytest

from wanx_studio.contracts import StudioError
from wanx_studio.deployment.adapters import Blocked
from wanx_studio.deployment.standard_runtime import StandardRuntime
from test_expert_deployment import OWNER, RELEASE, deploy, launch, open_directory, progress, setup


async def pending_delivery(svc, profiles, operation):
    for _ in range(35):
        await svc.deployments.process_once(operation['id'])
        await asyncio.sleep(0)
        tickets = profiles.delivery_list(OWNER)['items']
        if tickets:
            assert tickets[0]['operationId'] == operation['id']
            assert tickets[0]['step'] == 'prepare_client'
            return tickets[0]
    pytest.fail('Coordinator did not issue a prepare_client ticket')


async def test_preparation_authority_and_claim_proofs_fail_closed(setup, monkeypatch):
    svc, profiles, expert, _, item = setup
    prep, op = await deploy(svc, expert, item, 'dev', 'once')
    replay = await expert.submit_directory(OWNER, RELEASE, {
        'preparationId': prep['preparationId'], 'idempotencyKey': 'once',
    })
    assert replay['id'] == op['id']
    ticket = await pending_delivery(svc, profiles, op)
    fields = ('nonce', 'artifactHash', 'slotApplicationId', 'operationId', 'step', 'fence',
              'generation', 'payloadDigest')
    ack = {**{k: ticket[k] for k in fields}, 'clientId': 'client-test', 'state': 'prepared'}
    with pytest.raises(StudioError, match='DEPLOYMENT_ACK_MISMATCH'):
        profiles.delivery_ack(OWNER, ticket['id'], ack)
    profiles.delivery_claim(OWNER, ticket['id'], {'nonce': ticket['nonce'], 'clientId': 'client-test'})
    with pytest.raises(StudioError, match='DEPLOYMENT_CLIENT_BUSY'):
        profiles.delivery_claim(OWNER, ticket['id'], {'nonce': ticket['nonce'], 'clientId': 'other'})
    with pytest.raises(StudioError, match='DEPLOYMENT_ACK_MISMATCH'):
        profiles.delivery_ack(OWNER, ticket['id'], {**ack, 'generation': ticket['generation'] + 1})
    assert expert.get('ticket', ticket['id'])['state'] == 'pending'
    assert svc.deployments.journal.receipt(OWNER, op['id']) is None
    with pytest.raises(Blocked, match='DEPLOYMENT_TARGET_DENIED'):
        await profiles.authorize(OWNER, {**prep['target'], 'boxId': 'other'}, 'deploy')

    def revoked(owner):
        raise PermissionError()
    monkeypatch.setattr(expert, 'authority', revoked)
    with pytest.raises(Blocked, match='DEPLOYMENT_TARGET_DENIED'):
        profiles.delivery_list(OWNER)


async def test_registration_retry_and_second_preparation_preserve_inflight_request(setup, monkeypatch):
    svc, profiles, expert, _, item = setup
    body = {'directoryDigest': item['directoryDigest'], 'environment': 'dev', 'operationId': uuid4().hex}
    async def fail(*args):
        raise OSError('injected register crash')
    with monkeypatch.context() as patch:
        patch.setattr(svc.deployments, 'register_release', fail)
        with pytest.raises(OSError, match='injected register crash'):
            await expert.prepare_directory(OWNER, RELEASE, body)
    prep = await expert.prepare_directory(OWNER, RELEASE, body)
    op = await expert.submit_directory(OWNER, RELEASE, {
        'preparationId': prep['preparationId'], 'idempotencyKey': 'retry',
    })
    another = await expert.prepare_directory(OWNER, RELEASE, {**body, 'operationId': uuid4().hex})
    assert another['preparationId'] != prep['preparationId']
    assert (await progress(svc, profiles, expert, op))['state'] == 'succeeded'
    assert expert.record(svc.deployments.journal.get_operation(OWNER, op['id']))['body'] == body


async def test_reopen_resumes_persisted_client_intent_and_emits_matching_receipt(setup, tmp_path):
    svc, profiles, expert, _, item = setup
    prep, op = await deploy(svc, expert, item, 'dev', 'restart')
    before = await pending_delivery(svc, profiles, op)
    assert svc.deployments.journal.receipt(OWNER, op['id']) is None
    await svc.close()
    reopened, profiles, expert, _ = open_directory(tmp_path)
    try:
        ticket, = profiles.delivery_list(OWNER)['items']
        assert (ticket['id'], ticket['nonce']) == (before['id'], before['nonce'])
        current = await progress(reopened, profiles, expert, op)
        assert current['state'] == 'succeeded' and current['errorCode'] is None
        receipt = reopened.deployments.journal.receipt(OWNER, op['id'])['receipt']
        assert 'error' not in receipt
        assert {r['role'] for r in receipt['componentResults']} == {'backend', 'client'}
        assert all(r['actualReleaseRef'] == prep['releaseRef'] and r['status'] == 'ready'
                   for r in receipt['componentResults'])
        assert reopened.store.db.execute('SELECT count(*) FROM projects').fetchone()[0] == 0
    finally:
        await reopened.close()


async def test_supported_actions_are_profile_specific_and_unknown_declaration_fails_closed(setup, monkeypatch):
    svc, profiles, expert, _, item = setup
    assert svc.deployments.capabilities()['operations'] == ['deploy']
    with monkeypatch.context() as patch:
        patch.setattr(profiles, 'supported_actions', ['unsafe'])
        assert svc.deployments.capabilities()['operations'] == []
    prep, _ = await deploy(svc, expert, item, 'dev', 'deploy')
    request = deepcopy(expert.get('preparation', prep['preparationId'])['request'])
    request.update(kind='restart', idempotencyKey='bad-action')
    with pytest.raises(StudioError, match='DEPLOYMENT_ACTION_UNAVAILABLE'):
        await svc.deployments.submit(OWNER, request)


async def test_queued_data_write_cannot_mutate_new_generation(setup, monkeypatch):
    svc, profiles, expert, _, item = setup
    prep, op = await deploy(svc, expert, item, 'dev', 'generation-one')
    assert (await progress(svc, profiles, expert, op))['state'] == 'succeeded'
    slot = profiles.slot_id(OWNER, prep['target'])
    runtime = StandardRuntime(svc)
    first = launch(svc, profiles, slot)
    queued, release = threading.Event(), threading.Event()
    data = svc.data
    def paused(session, method, params):
        if method == 'data.put':
            queued.set()
            assert release.wait(10)
        return data(session, method, params)
    monkeypatch.setattr(svc, 'data', paused)
    row = {'collection': 'state', 'id': 'stale'}
    write = {'operation': 'data.put', 'input': {**row, 'value': {'json': 'stale'}}}
    task = asyncio.create_task(asyncio.to_thread(asyncio.run, runtime.invoke(first, write)))
    try:
        assert await asyncio.to_thread(queued.wait, 3)
        _, upgrade = await deploy(svc, expert, item, 'dev', 'generation-two')
        assert (await progress(svc, profiles, expert, upgrade))['state'] == 'succeeded'
    finally:
        release.set()
    with pytest.raises(StudioError, match='UPDATE_REQUIRED'):
        await task
    current = launch(svc, profiles, slot)
    assert runtime.context(current)['generation'] == 2
    assert await runtime.invoke(current, {'operation': 'data.get', 'input': row}) is None


def test_sso_background_authority_uses_live_user_status_not_request_application_audience():
    from types import SimpleNamespace
    from unittest.mock import Mock
    from dataclasses import replace
    from octop.infra.db.repos.users import UserRow
    from wanx_studio.deployment.miniapp_profile import authorize_sso_owner
    # Real SSO users need not have a durable application_id attribute; that
    # audience belongs to the authenticated request checked by Workshop.identity.
    repo=Mock()
    services=SimpleNamespace(user_repo=repo)
    row=UserRow(id=7,username='synthetic-sso-user',password_hash=None,role='user',display_name=None,disabled=0,created_at=0,locale='zh-CN',email=None,sso_provider_id=1,sso_subject='synthetic-subject')
    assert not hasattr(row,'application_id')
    repo.get.return_value=row
    authorize_sso_owner(services,'wanx:7')
    repo.get.assert_called_with(7)
    repo.get.return_value=replace(row,disabled=1)
    with pytest.raises(PermissionError):authorize_sso_owner(services,'wanx:7')
    repo.get.return_value=None
    with pytest.raises(PermissionError):authorize_sso_owner(services,'wanx:7')
    for owner in ['alice','other:7','wanx:bad',None]:
        with pytest.raises(PermissionError):authorize_sso_owner(services,owner)
