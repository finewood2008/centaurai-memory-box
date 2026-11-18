"""Regressions for compiling a UI while its required runtime cannot be delivered."""
from pathlib import Path
from uuid import uuid4
import pytest

from wanx_studio import devkit
from wanx_studio.deployment.miniapp_profile import MiniappProfile
from test_standard_artifacts import standard
from wanx_studio.contracts import StudioError, digest
from wanx_studio.runtime_contract import review

ROOT = Path(__file__).resolve().parents[2]


def test_missing_public_contract_cannot_pass_product_compatibility():
    project = {
        'id': 'a' * 32, 'name': 'Runtime contract regression',
        'appId': 'dev.wanx.contract-check', 'devKit': True, 'artifacts': [],
        'solution': {'capabilities': ['model', 'files', 'reports'], 'dependencies': []},
    }
    report = devkit.compatibility_report(project, ROOT)
    assert report['capabilityMapping']['gaps'] == [{'id': 'reports', 'reason': 'NO_PUBLIC_HOST_CONTRACT'}]
    assert report['valid'] is False
    assert report['stages']['runtime']['status'] == 'blocked'


async def test_standard_package_is_not_diagnosed_as_unsupported_product_capabilities(standard):
    svc, project = standard
    artifact = project['artifacts'][-1]
    svc.versions.adopt('alice', project['id'], {
        'operationId': uuid4().hex, 'expectedRevision': project['versioning']['revision'],
        'artifactHash': artifact['hash'], 'confirmedByUser': True,
    })
    profile = MiniappProfile(svc, {'boxId': 'synthetic-box'}, lambda owner: None)
    context = profile.context('alice', project['id'])
    assert context['available'] is False
    assert context['reason'] == 'STANDARD_DEPLOYMENT_CONTRACT_REQUIRED'


@pytest.mark.parametrize('change,code', [
    ('missing', 'EDIT_RUNTIME_INTENT_REQUIRED'),
    ('capabilities', 'EDIT_RUNTIME_PRD_MISMATCH'),
    ('expert', 'STANDARD_RUNTIME_REPLAN_REQUIRED'),
    ('stale', 'SOLUTION_CHANGED'),
])
def test_runtime_intent_cannot_replace_frozen_configuration(change, code):
    project = {'id':'a'*32, 'name':'Synthetic', 'appId':'dev.wanx.synthetic',
               'devKit':True, 'solution':{'capabilities':['model']}}
    intent = {'solutionHash':digest(project['solution']), 'capabilities':['model'], 'execution':'host'}
    if change == 'missing':intent = None
    elif change == 'capabilities':intent['capabilities'] = []
    elif change == 'expert':intent['execution'] = 'managed-expert'
    else:intent['solutionHash'] = '0'*64
    with pytest.raises(StudioError, match=code):
        review(project,intent)


@pytest.mark.parametrize('execution', [[], {}, None, 1])
def test_runtime_intent_rejects_non_string_execution(execution):
    project = {'solution': {'capabilities': []}}
    with pytest.raises(StudioError, match='EDIT_RUNTIME_INTENT_INVALID'):
        review(project, {'solutionHash': digest(project['solution']), 'capabilities': [], 'execution': execution})


@pytest.mark.parametrize('capability', ['model', 'files'])
def test_permission_without_callable_renderer_adapter_blocks_build(tmp_path, capability):
    from wanx_studio import devkit_build
    project = {'id': 'a'*32, 'name': 'Synthetic', 'appId': 'dev.wanx.synthetic',
               'devKit': True, 'artifacts': [], 'solution': {'capabilities': [capability]}}
    report = devkit.compatibility_report(project, ROOT)
    assert report['capabilityMapping']['gaps'] == []  # Public permission exists.
    assert report['stages']['runtime']['errors'] == [
        {'code': 'STANDARD_HOST_ADAPTER_UNAVAILABLE', 'path': '/capabilities/' + capability}]
    assert report['valid'] is False
    with pytest.raises(StudioError, match='STANDARD_RUNTIME_CONTRACT_REQUIRED'):
        devkit_build.create_workspace(project, ROOT, tmp_path)
    assert not (tmp_path/'devkit-workspace').exists()


from test_preparation import env


async def test_standard_prd_cannot_finish_with_only_legacy_runtime_contract(env):
    from test_prd_completeness import prepared, assess
    from wanx_studio.iterative import propose_contract
    svc, pid = await prepared(env)
    project = svc.store.get('alice', pid)
    project['devKit'] = True
    svc.store.save(project)
    propose_contract(svc, 'alice', pid, {'expectedHash': digest(project['solution']),
                                      'collections': {'items': {'title': 'string'}}})
    result = await assess(svc, pid)
    assert result['complete'] is False
    assert result['runtimeGaps']
    assert not svc.store.get('alice', pid)['preparation']['interview'].get('prdReview')
