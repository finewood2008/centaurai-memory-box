"""Original Studio contract selection and immutable, adopted-artifact delivery."""
from copy import deepcopy
import base64
from types import SimpleNamespace
from standard_build_fixture import workspace_files
from wanx_studio.public_capabilities import EXPERT

import pytest

from wanx_studio.contracts import StudioError, digest
from wanx_studio.deployment.expert_runtime import validate_backend
from wanx_studio.deployment.intake import ReleaseIntake
from wanx_studio.deployment.project_expert import ProjectExpert
from wanx_studio.deployment.studio_release import StudioRelease
from wanx_studio.versions import verify
from test_studio import svc, op

TEMPLATE={'resourceId':'synthetic-expert','version':'0.0.0+sha.'+'a'*12,'digest':'sha256:'+'a'*64}
VERIFICATION={'schemaVersion':1,'checks':[{'id':'text-roundtrip','input':{'text':'Please reply SYNTHETIC_READY'},'expected':{'contains':'SYNTHETIC_READY'}}]}


def wire(svc,tmp_path):
    intake=ReleaseIntake(svc.store,tmp_path/'inbox',tmp_path/'snapshots',backend_validator=validate_backend,runtime_namespace='studio')
    def authorize(owner):
        if owner!='alice':raise StudioError('STUDIO_ADMIN_REQUIRED',403)
    profile=SimpleNamespace(available=True,runtime_namespace='studio',intake=intake,authorize_owner=authorize,
        experts=SimpleNamespace(templates=lambda:[{**TEMPLATE,'name':'Synthetic expert'}]))
    svc.directory_profile=profile
    return ProjectExpert(svc),StudioRelease(svc)


def configure(manager,p):
    return manager.configure('alice',p['id'],{'operationId':op(),'expectedRevision':0,'template':TEMPLATE,'verification':VERIFICATION})


async def artifact(svc,p,contract):
    project = svc.store.get('alice', p['id'])
    task = op()
    solution_hash = digest(project['solution'])
    project['confirmation'] = {'hash': solution_hash, 'at': 1}
    project['preparation'].update(
        phase='acp', handoff={'contracts': {EXPERT: {'expertDeployment': contract}}},
    )
    project['preparation']['interview'].update(state='completed', sync='saved')
    project['tasks'].append({
        'id': task, 'state': 'running', 'solutionHash': solution_hash,
        'instruction': 'Build standard expert', 'events': [], 'question': None,
    })
    svc.store.save(project)
    files = workspace_files(svc, 'alice', project, task)
    built = await svc.add_artifact('alice', p['id'], task, files)
    return svc.versions.adopt('alice', p['id'], {
        'operationId': op(), 'expectedRevision': built['versioning']['revision'],
        'artifactHash': built['artifacts'][-1]['hash'], 'confirmedByUser': True,
    })


def assert_exported_package(intake, frozen, artifact):
    package_id = frozen['manifest']['client']['packageArtifactId']
    descriptor = next(a for a in frozen['bundle']['artifactDescriptors'] if a['artifactId'] == package_id)
    assert intake.resolve_artifact('alice', descriptor['sourceRef']) == base64.b64decode(
        artifact['devKitPackage']['packageBase64']
    )
    assert frozen['base']['artifactHash'] == artifact['hash']
    assert frozen['base']['packageSha256'] == artifact['packageSha256']


async def test_contract_is_explicit_versioned_and_preserves_other_foundation_semantics(svc,tmp_path):
    manager,_=wire(svc,tmp_path)
    p=svc.create_project('alice','Expert','Synthetic expert app',op());svc.preparation.enable('alice',p['id'])
    assert manager.context('alice',p['id'])['configuration']['contract'] is None
    result=configure(manager,p);contract=result['configuration']['contract']
    assert result['configuration']['revision']==1 and contract['template']==TEMPLATE
    assert result['project']['deploymentExpert']['template']==TEMPLATE
    assert EXPERT in svc.preparation.required(svc.store.get('alice',p['id']))
    with pytest.raises(StudioError,match='EXPERT_CONTRACT_CHANGED'):
        configure(manager,p)
    with pytest.raises(StudioError,match='STUDIO_ADMIN_REQUIRED'):
        manager.configure('bob',p['id'],{'operationId':op(),'expectedRevision':0,'template':TEMPLATE,'verification':VERIFICATION})


async def test_export_uses_completed_adopted_zip_and_hash_without_recompile(svc,tmp_path,monkeypatch):
    manager,exporter=wire(svc,tmp_path)
    p=svc.create_project('alice','Expert','Synthetic expert app',op());svc.preparation.enable('alice',p['id'])
    configured=configure(manager,p)
    p=await artifact(svc,p,configured['configuration']['contract'])
    a=deepcopy(svc.store.get('alice',p['id'])['artifacts'][-1])
    body={'operationId':op(),'expectedArtifactHash':a['hash'],'expectedVersionRevision':p['versioning']['revision']}
    async def forbidden(*args,**kwargs):raise AssertionError('Export must not compile')
    monkeypatch.setattr(svc,'add_artifact',forbidden)
    result=exporter.export('alice',p['id'],body)
    frozen=svc.directory_profile.intake.get('alice',result['release']['releaseId'])
    assert_exported_package(svc.directory_profile.intake, frozen, a)
    assert frozen['base']['runtimeNamespace']=='studio'
    assert result['source']['artifactHash']==a['hash'] and result['source']['taskId']==a['taskId']
    assert exporter.export('alice',p['id'],body)==result
    assert svc.store.get('alice',p['id'])['artifacts'][-1]==a
    assert len(svc.store.get('alice',p['id'])['artifacts'])==1


async def test_export_rejects_unadopted_stale_revision_and_tampering(svc,tmp_path):
    manager,exporter=wire(svc,tmp_path)
    p=svc.create_project('alice','Expert','Synthetic expert app',op());svc.preparation.enable('alice',p['id'])
    configured=configure(manager,p)
    with pytest.raises(StudioError,match='USER_ADOPTION_REQUIRED'):
        exporter.export('alice',p['id'],{'operationId':op(),'expectedArtifactHash':'a'*64,'expectedVersionRevision':0})
    p=await artifact(svc,p,configured['configuration']['contract']);h=p['versioning']['adoptedHash']
    body={'operationId':op(),'expectedArtifactHash':h,'expectedVersionRevision':p['versioning']['revision']-1}
    with pytest.raises(StudioError,match='VERSION_CHANGED'):exporter.export('alice',p['id'],body)
    body['expectedVersionRevision']+=1
    svc.store.mutate('alice',p['id'],op(),{},lambda q:q['artifacts'][0]['files'].update({'app/host.mjs':'tampered'}))
    with pytest.raises(StudioError,match='ARTIFACT_INTEGRITY_FAILED'):exporter.export('alice',p['id'],body)


async def test_new_expert_artifact_hash_binds_its_frozen_backend_contract(svc,tmp_path):
    manager,exporter=wire(svc,tmp_path)
    p=svc.create_project('alice','Expert','Synthetic expert app',op());svc.preparation.enable('alice',p['id'])
    configured=configure(manager,p);p=await artifact(svc,p,configured['configuration']['contract'])
    def tamper(q):
        q['artifacts'][0]['snapshot']['contracts'][EXPERT]['expertDeployment']['verification']['checks'][0]['expected']['contains']='different expectation'
    svc.store.mutate('alice',p['id'],op(),{},tamper)
    with pytest.raises(StudioError,match='ARTIFACT_INTEGRITY_FAILED'):
        exporter.export('alice',p['id'],{'operationId':op(),'expectedArtifactHash':p['versioning']['adoptedHash'],'expectedVersionRevision':p['versioning']['revision']})


async def test_restored_expert_version_preserves_frozen_contract_and_exports_with_current_adoption_revision(svc,tmp_path):
    manager,exporter=wire(svc,tmp_path)
    p=svc.create_project('alice','Expert','Synthetic expert app',op());svc.preparation.enable('alice',p['id'])
    contract=configure(manager,p)['configuration']['contract']
    p=await artifact(svc,p,contract)
    original=deepcopy(svc.store.get('alice',p['id'])['artifacts'][-1])
    p=await artifact(svc,p,contract)
    before_restore_revision=p['versioning']['revision']
    check=svc.versions.restore_check('alice',p['id'],original['hash'])
    request={'operationId':op(),'expectedRevision':check['expectedRevision'],'checkHash':check['checkHash'],
        'artifactHash':original['hash'],'confirmedByUser':True}
    restored=svc.versions.restore('alice',p['id'],request)
    retried=svc.versions.restore('alice',p['id'],request)
    assert retried['versioning']['adoptedHash']==restored['versioning']['adoptedHash']
    assert retried['versioning']['revision']==restored['versioning']['revision']
    current = svc.store.get('alice', p['id'])
    assert len(current['artifacts']) == 2
    assert current['artifacts'][-1]['hash'] != original['hash']
    a = next(a for a in current['artifacts'] if a['hash'] == restored['versioning']['adoptedHash'])
    assert a == original
    assert restored['versioning']['adoptedHash']==a['hash'] and restored['versioning']['revision']>before_restore_revision
    assert a['expertContractDigest']==original['expertContractDigest']==digest(contract)
    assert a['snapshot']['contracts'][EXPERT]['expertDeployment']==contract
    verify(a)

    export_request={'operationId':op(),'expectedArtifactHash':a['hash'],'expectedVersionRevision':before_restore_revision}
    with pytest.raises(StudioError,match='VERSION_CHANGED'):
        exporter.export('alice',p['id'],export_request)
    export_request['expectedVersionRevision']=restored['versioning']['revision']
    result=exporter.export('alice',p['id'],export_request)
    frozen=svc.directory_profile.intake.get('alice',result['release']['releaseId'])
    assert result['source']['artifactHash']==a['hash'] and result['source']['taskId']==a['taskId']
    assert result['source']['versionRevision']==restored['versioning']['revision']
    assert frozen['base']['version']==a['version'] ==original['version']
    assert_exported_package(svc.directory_profile.intake, frozen, original)
    assert frozen['backend']['template']==contract['template'] and frozen['verification']==contract['verification']
    # Restoring changes the version identity, never weakens its contract seal.
    changed=deepcopy(a)
    changed['snapshot']['contracts'][EXPERT]['expertDeployment']['verification']['checks'][0]['expected']['contains']='tampered'
    with pytest.raises(StudioError,match='ARTIFACT_INTEGRITY_FAILED'):
        verify(changed)


async def test_standard_preflight_validates_contract_without_executing_expert(svc, tmp_path):
    manager, _ = wire(svc, tmp_path)
    p = svc.create_project('alice', 'Expert', 'Synthetic expert app', op())
    svc.preparation.enable('alice', p['id'])
    configure(manager, p)
    before = svc.store.get('alice', p['id'])
    result = await svc.preparation.probe_runtime('alice', p['id'], EXPERT)
    assert result['expertTemplate'] == TEMPLATE
    assert result['status'] == 'passed' and result['runtimeVerified'] is False
    assert not svc.runtime_sessions
    assert svc.store.get('alice', p['id']) == before
    assert svc.store.db.execute('SELECT count(*) FROM usage').fetchone()[0] == 0
