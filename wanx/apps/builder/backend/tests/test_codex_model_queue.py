"""Queued Builder work freezes a reference, never the proxy credentials."""
import asyncio
import json
from pathlib import Path

import pytest

from test_codex_device_provider import device, application_defaults
from test_edits import body, wait
from test_standard_artifacts import standard
from test_studio import svc, op
from wanx_studio import devkit, devkit_build
from wanx_studio.contracts import StudioError, digest
from wanx_studio.runner import Runner
from wanx_studio.versions import next_version


@pytest.fixture
def chosen(device, application_defaults, monkeypatch):
    models, row, *_ = device
    monkeypatch.setattr(models, 'fingerprint', lambda: 'synthetic-model-configuration')
    choice = {'provider_name': row.name, 'model': 'gpt-z',
              'model_ref': row.name + '/gpt-z', 'available': True}
    application_defaults['defaults']['kaiwu'] = choice
    return models, choice


async def test_build_freezes_reference_before_background_admission(svc, chosen, monkeypatch):
    svc.model, chosen = chosen
    p = svc.create_project('alice', 'test', 'synthetic goal', op())
    project = svc.store.get('alice', p['id'])
    project['confirmation'] = {'hash': digest(project['solution']),
                               'buildInput': devkit.build_input(project, svc.project_root)}
    svc.store.save(project)
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
    await asyncio.wait_for(entered.wait(), timeout=10)
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
    svc.model, chosen = chosen
    p = svc.create_project('alice', 'test', 'synthetic goal', op())
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


async def test_edit_queue_and_its_build_keep_submission_model(standard, chosen, monkeypatch):
    svc, p = standard
    svc.model, chosen = chosen
    svc.runner = Runner(svc)
    entered, release = asyncio.Event(), asyncio.Event()

    async def analyse(owner, pid, eid):
        if not entered.is_set():
            entered.set()
            await release.wait()
        current = await svc.edits.tool(owner, pid, eid, 'read_project', {})
        updated = await svc.edits.tool(owner, pid, eid, 'update_prd', {
            'expectedHash': current['expectedHash'],
            'summary': {'workflow': '查看列表', 'outputs': current['request']},
            'upsert': [{'section': 'tests', 'value': {
                'title': '列表标题', 'given': '打开列表', 'when': '查看标题', 'then': current['request']}}],
        })
        await svc.edits.tool(owner, pid, eid, 'finish_edit', {
            'outcome': 'ready', 'summary': current['request'],
            'runtimeIntent': {'solutionHash': updated['expectedHash'], 'capabilities': [], 'execution': 'host'},
        })

    async def execute(owner, project, tid, instruction):
        task = next(t for t in project['tasks'] if t['id'] == tid)
        workspace = devkit_build.create_iteration_workspace(
            project, svc.project_root, svc.store.root / 'tasks' / tid, task, version=next_version(project))
        stored = svc.store.get(owner, project['id'])
        next(t for t in stored['tasks'] if t['id'] == tid).update(
            devKitWorkspace=workspace['root'], devKitSpecHash=workspace['specHash'])
        svc.store.save(stored)
        files = devkit_build.mutable_files(Path(workspace['root']))
        files['app/host.mjs'] += '\n// ' + tid + '\n'
        await svc.add_artifact(owner, project['id'], tid, files)

    async def preflight(**kwargs):
        return {'available': True}

    monkeypatch.setattr(svc.edits, 'analyse', analyse)
    monkeypatch.setattr(svc.runner, 'execute', execute)
    monkeypatch.setattr(svc.runner, 'preflight', preflight)
    await svc.edits.submit('alice', p['id'], body(p, 'First change'))
    await asyncio.wait_for(entered.wait(), timeout=10)
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
    svc.model, chosen = chosen
    p = svc.create_project('alice', 'test', 'synthetic goal', op())
    svc.preparation.enable('alice', p['id'])
    p = svc.store.get('alice', p['id'])
    edit = {'_codexModel': 'admin-managed-qeetoken/gpt-z'}
    before = svc.edits.resource_hash('alice', p, edit)
    chosen.update(model='gpt-a', model_ref='admin-managed-qeetoken/gpt-a')
    assert svc.edits.resource_hash('alice', p, edit) == before
