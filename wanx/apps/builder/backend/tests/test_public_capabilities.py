"""Standard Builder planning must never probe the historical miniapp API."""
import json
from uuid import uuid4

import pytest

from wanx_studio import devkit
from wanx_studio.contracts import StudioError, digest
from wanx_studio.prd_patch import apply_patch
from test_preparation import env, ROOT
from test_studio_expert_delivery import wire, configure
from test_standard_artifacts import standard

EXPERT = 'wanx.expert-app.v1'


def make_standard(svc, pid):
    p = svc.store.get('alice', pid)
    p['devKit'] = True
    p['solution']['capabilities'] = []
    svc.store.save(p)
    return p


async def test_standard_intake_uses_public_contract_ids(env):
    svc, pid, _ = env
    make_standard(svc, pid)
    async def model(owner, body):
        prompt = body['messages'][0]['content']
        assert 'capabilities 只能从 data/model/files/knowledge/reports' not in prompt
        assert EXPERT in prompt
        return {'choices': [{'message': {'content': json.dumps({
            'message': '已记录专家需求', 'brief': {'goal': '专家总结'},
            'capabilities': [EXPERT]})}}]}
    svc.model = model
    p = await svc.preparation.intake('alice', pid, {'operationId': uuid4().hex, 'text': '专家总结'})
    assert p['preparation']['required'] == [EXPERT]
    p = await svc.preparation.check('alice', pid, {'operationId': uuid4().hex})
    result = p['preparation']['report']['results'][EXPERT]
    assert result['code'] == 'EXPERT_CONTRACT_REQUIRED'
    assert not svc.runtime_sessions


@pytest.mark.parametrize('cap', ['data', 'model', 'files', 'knowledge', 'reports', 'foundation'])
async def test_old_standard_capabilities_fail_same_way_in_probe_and_build(env, cap):
    svc, pid, _ = env
    p = make_standard(svc, pid)
    p['solution']['capabilities'] = [cap]
    p['preparation']['required'] = [cap]
    svc.store.save(p)
    async def forbidden(*args):
        raise AssertionError('must not call miniapp runtime')
    svc.invoke = forbidden
    checked = await svc.preparation.check('alice', pid, {'operationId': uuid4().hex})
    assert checked['preparation']['report']['results'][cap]['code'] == 'LEGACY_CAPABILITY_REPLAN_REQUIRED'
    report = devkit.compatibility_report(p, ROOT)
    assert {'code': 'LEGACY_CAPABILITY_REPLAN_REQUIRED', 'path': '/capabilities/' + cap} in report['stages']['runtime']['errors']
    with pytest.raises(StudioError, match='LEGACY_CAPABILITY_REPLAN_REQUIRED'):
        apply_patch(p, {'expectedHash': digest(p['solution']), 'capabilities': [cap]})


async def test_expert_preparation_checks_contract_not_direct_model(env, tmp_path):
    svc, pid, calls = env
    p = make_standard(svc, pid)
    manager, _ = wire(svc, tmp_path)
    configure(manager, p)
    p = svc.store.get('alice', pid)
    p['solution']['capabilities'] = [EXPERT]
    p['preparation']['required'] = [EXPERT]
    svc.store.save(p)
    async def forbidden(*args):
        raise AssertionError('direct model/miniapp probe forbidden')
    svc.invoke = forbidden
    svc.model = forbidden
    p = await svc.preparation.check('alice', pid, {'operationId': uuid4().hex})
    result = p['preparation']['report']['results'][EXPERT]
    assert result['status'] == 'passed', result
    assert result['runtimeVerified'] is False
    assert not calls and not svc.runtime_sessions
    contracts = svc.preparation.contracts(svc.store.get('alice', pid))
    assert not {'model', 'data', 'files', 'knowledge', 'reports', 'foundation'} & contracts.keys()
    assert contracts[EXPERT]['expertDeployment']['template']
    assert not devkit.compatibility_report(svc.store.get('alice', pid), ROOT)['stages']['runtime']['errors']


async def test_public_catalog_does_not_claim_all_documented_apis_are_callable(env):
    svc, pid, _ = env
    p = make_standard(svc, pid)
    catalog = svc.preparation.contracts(p)
    assert catalog['knowledge.retrieval']['status'] == 'contract-only'
    assert catalog['space.drive']['status'] == 'ready-for-acceptance'
    for cap in ['space.drive', 'starlink.evidence', 'knowledge.retrieval']:
        p['preparation']['required'] = [cap]
        svc.store.save(p)
        checked = await svc.preparation.check('alice', pid, {'operationId': uuid4().hex})
        result = checked['preparation']['report']['results'][cap]
        report = devkit.compatibility_report({**p, 'solution': {**p['solution'], 'capabilities': [cap]}}, ROOT)
        assert result['code'] == report['stages']['runtime']['errors'][0]['code']
        assert result['status'] != 'passed'


async def test_standard_prd_can_replan_old_draft_without_approving_build(env):
    from wanx_studio.product_manager import planning_prompt
    svc, pid, _ = env
    p = make_standard(svc, pid)
    p['solution']['capabilities'] = ['data', 'model']
    p['preparation']['required'] = ['data', 'model']
    svc.store.save(p)
    checked = await svc.preparation.check('alice', pid, {'operationId': uuid4().hex})
    await svc.preparation.handoff('alice', pid, {'expectedRevision': checked['preparation']['revision']})
    p = svc.store.get('alice', pid)
    prompt = planning_prompt(p)
    assert '应用已有能力包含data/model' not in prompt
    assert '已开放 reports' not in prompt
    assert '当前 data 契约是应用获准用户共享' not in prompt
    turn = uuid4().hex
    p['preparation']['interview'].update(state='running', turnId=turn)
    svc.store.save(p)
    await svc.preparation.pm.tool('alice', pid, turn, 'update_prd', {
        'expectedHash': digest(p['solution']), 'capabilities': [EXPERT]})
    p = svc.store.get('alice', pid)
    assert p['solution']['capabilities'] == [EXPERT]
    p['preparation']['interview'].update(state='completed',sync='saved')
    svc.store.save(p)
    await svc.preparation.check('alice', pid, {'operationId': uuid4().hex})
    p = svc.store.get('alice', pid)
    assert svc.preparation.valid_report('alice', p)
    assert not svc.preparation.valid_report('alice', p, development=True)
    assert not p['confirmation'] and not p['tasks']


async def test_standard_expert_storage_is_fixed_public_state(env, tmp_path):
    from wanx_studio.iterative import contract, propose_contract
    from wanx_studio import devkit_build
    svc, pid, _ = env
    p = make_standard(svc, pid)
    manager, _ = wire(svc, tmp_path)
    configure(manager, p)
    p = svc.store.get('alice', pid)
    p['solution']['capabilities'] = [EXPERT]
    svc.store.save(p)
    assert contract(p)['collections'] == {'state': {'json': 'string'}}
    with pytest.raises(StudioError, match='STANDARD_CONTRACT_FIXED'):
        propose_contract(svc, 'alice', pid, {'expectedHash':digest(p['solution']), 'collections':{'items':{'title':'string'}}})
    workspace = devkit_build.create_workspace(p, ROOT, tmp_path / 'build')
    from pathlib import Path
    manifest = json.loads((Path(workspace['root']) / 'application.manifest.json').read_text())
    assert manifest['capabilities'] == ['identity.read','http.request']
    assert manifest['compatibility']['backendContracts'][0]['id'] == EXPERT


def test_public_catalog_status_changes_invalidate_planning_fingerprint(monkeypatch, tmp_path):
    from wanx_studio import public_capabilities as public
    path = tmp_path / 'contract-status.v1.json'
    document = {'version':'test','apis':[{'id':EXPERT,'status':'ready-for-acceptance'}]}
    path.write_text(json.dumps(document))
    monkeypatch.setattr(public, 'contract_root', lambda *_: tmp_path)
    before = public.fingerprint()
    document['apis'][0]['status'] = 'contract-only'
    path.write_text(json.dumps(document))
    assert before != public.fingerprint()
    assert public.gaps([EXPERT],backend={'mode':'existing','connectionRef':EXPERT}) == [
        {'id':EXPERT,'reason':'PUBLIC_CONTRACT_NOT_IMPLEMENTED'}]


@pytest.mark.parametrize('standard', ['expert'], indirect=True)
async def test_historical_standard_expert_can_replan_without_mutating_artifact(standard):
    from copy import deepcopy
    from wanx_studio.iterative import planned_standard_contract
    from wanx_studio.versions import standard_artifact_hash, verify
    svc, result = standard
    project = svc.store.get('alice', result['id'])
    old = deepcopy(project['artifacts'][-1])
    # Recreate a sealed historical standard version with the previous IDs.
    old['snapshot']['solution']['capabilities'] = ['data','foundation']
    old['solutionHash'] = digest(old['snapshot']['solution'])
    old['snapshot']['contracts']['foundation'] = old['snapshot']['contracts'].pop(EXPERT)
    old['hash'] = standard_artifact_hash(old)
    verify(old)
    before = deepcopy(old)
    project['solution']['capabilities'] = [EXPERT]
    planned = planned_standard_contract(project, old)
    assert planned['capabilities'] == [EXPERT]
    assert planned['hostCapabilities'] == old['manifest']['capabilities']
    assert old == before




def test_standard_iteration_prompt_does_not_inherit_miniapp_storage():
    from wanx_studio.edits import iteration_prompt
    prompt=iteration_prompt({'devKit':True})
    assert '自动新增兼容的设置集合' not in prompt
    assert 'opaque-origin iframe' not in prompt
    assert '已开放 reports' not in prompt
    assert 'wanx.expert-app.v1' in prompt
    assert 'state' in prompt
