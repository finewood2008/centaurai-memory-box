"""Queued Builder work freezes a reference, never the proxy credentials."""
import asyncio
import json

import pytest

from test_codex_device_provider import device, application_defaults
from test_edits import pipeline, body, wait
from test_studio import svc, seeded, op
from wanx_studio.contracts import StudioError


@pytest.fixture
def chosen(svc, device, application_defaults, monkeypatch):
    models, row, *_ = device
    svc.model = models
    monkeypatch.setattr(models, 'fingerprint', lambda: 'synthetic-model-configuration')
    choice = {'provider_name': row.name, 'model': 'gpt-z',
              'model_ref': row.name + '/gpt-z', 'available': True}
    application_defaults['defaults']['kaiwu'] = choice
    return choice


async def test_build_freezes_reference_before_background_admission(svc, chosen, monkeypatch):
    p = await seeded(svc)
    entered, release = asyncio.Event(), asyncio.Event()
    captured = []

    async def preflight(**kwargs):
        entered.set()
        await release.wait()
        return {'available': True}

    async def acquire(key, script, config):
        captured.append(json.loads(config['WANX_CODEX_CONFIG'])['model'])
        raise StudioError('SYNTHETIC_STOP', 409)

    monkeypatch.setattr(svc.runner, 'preflight', preflight)
    monkeypatch.setattr(svc.native_codex, 'acquire', acquire)
    result = await svc.runner.start('alice', p['id'], {
        'operationId': op(), 'solutionHash': p['solutionHash'], 'instruction': '',
    })
    await entered.wait()
    task = svc.store.get('alice', p['id'])['tasks'][-1]
    try:
        assert task.get('_codexModel') == 'admin-managed-qeetoken/gpt-z'
        assert 'local-proxy-token' not in json.dumps(task)
    finally:
        chosen.update(model='gpt-a', model_ref='admin-managed-qeetoken/gpt-a')
        release.set()
        await svc.runner.jobs[result['tasks'][-1]['id']]
    assert captured == ['gpt-z']


async def test_interview_queued_behind_running_turn_keeps_its_model(svc, chosen):
    p = svc.store.create('alice', 'test', 'synthetic goal', op())
    svc.preparation.enable('alice', p['id'])
    p = svc.store.get('alice', p['id'])
    p['preparation']['phase'] = 'acp'
    p['preparation']['interview']['state'] = 'running'
    svc.store.save(p)
    await svc.preparation.pm.start('alice', p['id'], {'operationId': op(), 'text': 'First queued input'})
    chosen.update(model='gpt-a', model_ref='admin-managed-qeetoken/gpt-a')
    await svc.preparation.pm.start('alice', p['id'], {'operationId': op(), 'text': 'Next queued input'})
    turns = svc.store.get('alice', p['id'])['preparation']['interview']['turns']
    assert [turn.get('_codexModel') for turn in turns] == [
        'admin-managed-qeetoken/gpt-z', 'admin-managed-qeetoken/gpt-a',
    ]
    assert 'local-proxy-token' not in json.dumps(turns)


async def test_edit_queue_and_its_build_keep_submission_model(svc, pipeline, chosen, monkeypatch):
    p = await seeded(svc)
    entered, release = asyncio.Event(), asyncio.Event()
    analyse = pipeline[0]

    async def delayed(*args):
        if not entered.is_set():
            entered.set()
            await release.wait()
        await analyse(*args)

    monkeypatch.setattr(svc.edits, 'analyse', delayed)
    await svc.edits.submit('alice', p['id'], body(p, 'First change'))
    await entered.wait()
    try:
        p = svc.edits.result('alice', p['id'])['project']
        await svc.edits.submit('alice', p['id'], body(p, 'Queued change'))
        chosen.update(model='gpt-a', model_ref='admin-managed-qeetoken/gpt-a')
    finally:
        release.set()
    result = await wait(svc, p['id'])
    assert [item['state'] for item in result['items']] == ['completed', 'completed']
    project = svc.store.get('alice', p['id'])
    assert [edit.get('_codexModel') for edit in project['_edits']['items']] == [
        'admin-managed-qeetoken/gpt-z', 'admin-managed-qeetoken/gpt-z',
    ]
    assert [task.get('_codexModel') for task in project['tasks'][1:]] == [
        'admin-managed-qeetoken/gpt-z', 'admin-managed-qeetoken/gpt-z',
    ]
    assert 'local-proxy-token' not in json.dumps(project)



async def test_active_edit_resource_hash_uses_frozen_codex_model(svc, chosen):
    p = await seeded(svc)
    svc.preparation.enable('alice', p['id'])
    p = svc.store.get('alice', p['id'])
    edit = {'_codexModel': 'admin-managed-qeetoken/gpt-z'}
    before = svc.edits.resource_hash('alice', p, edit)
    chosen.update(model='gpt-a', model_ref='admin-managed-qeetoken/gpt-a')
    assert svc.edits.resource_hash('alice', p, edit) == before
