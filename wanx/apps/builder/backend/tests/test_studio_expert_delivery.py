"""Original Studio contract selection and immutable, adopted-artifact delivery."""
from copy import deepcopy
import json
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

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
    # The unit fixture substitutes the engine, while keeping actual compilation,
    # integrity, task completion and adoption code. Real acceptance uses Codex.
    manifest={'schemaVersion':1,'name':'Synthetic Studio expert','entry':'src/app.js','capabilities':['data','foundation'],'collections':{'items':{'text':'string'}}}
    files={'miniapp.manifest.json':json.dumps(manifest),'src/app.js':'export function mount(root, api){root.textContent="Synthetic";}'}
    task=uuid4().hex
    def begin(q):
        q['solution'].update(audience='本人',workflow='输入文本后调用专家',inputs='文本',outputs='专家回复',acceptance=['返回回复'],capabilities=['data','foundation'])
        q['confirmation']={'hash':digest(q['solution']),'at':1}
        q['preparation']={**svc.preparation.state('alice',p['id']), 'phase':'acp',
            'handoff':{'contracts':{'foundation':{'expertDeployment':contract}}}}
        it=svc.versions.task(q,'Build synthetic expert')
        q['tasks'].append({'id':task,'state':'running','solutionHash':digest(q['solution']),'instruction':'Build synthetic expert','events':[],'question':None,'iterationId':it['id'],'baseHash':it['baseHash']})
    svc.store.mutate('alice',p['id'],op(),{},begin)
    # Exercise compilation; capability live-probing itself is covered separately.
    previous=svc.authorize_version
    svc.authorize_version=lambda *_:None
    try:
        p=await svc.add_artifact('alice',p['id'],task,files)
        return svc.versions.adopt('alice',p['id'],{'operationId':op(),'expectedRevision':p['versioning']['revision'],'artifactHash':p['artifacts'][-1]['hash'],'confirmedByUser':True})
    finally:svc.authorize_version=previous


async def test_contract_is_explicit_versioned_and_preserves_other_foundation_semantics(svc,tmp_path):
    manager,_=wire(svc,tmp_path)
    p=svc.store.create('alice','Expert','Synthetic expert app',op());svc.preparation.enable('alice',p['id'])
    assert manager.context('alice',p['id'])['configuration']['contract'] is None
    result=configure(manager,p);contract=result['configuration']['contract']
    assert result['configuration']['revision']==1 and contract['template']==TEMPLATE
    assert result['project']['deploymentExpert']['template']==TEMPLATE
    assert 'foundation' in svc.preparation.required(svc.store.get('alice',p['id']))
    with pytest.raises(StudioError,match='EXPERT_CONTRACT_CHANGED'):
        configure(manager,p)
    with pytest.raises(StudioError,match='STUDIO_ADMIN_REQUIRED'):
        manager.configure('bob',p['id'],{'operationId':op(),'expectedRevision':0,'template':TEMPLATE,'verification':VERIFICATION})


async def test_export_uses_completed_adopted_bytes_and_distinct_payload_hash_without_recompile(svc,tmp_path,monkeypatch):
    manager,exporter=wire(svc,tmp_path)
    p=svc.store.create('alice','Expert','Synthetic expert app',op());svc.preparation.enable('alice',p['id'])
    configured=configure(manager,p)
    p=await artifact(svc,p,configured['configuration']['contract'])
    a=deepcopy(svc.store.get('alice',p['id'])['artifacts'][-1])
    # Existing authorize_version is intentionally the real version guard; the
    # fixture has no background grants and only supported data/foundation.
    body={'operationId':op(),'expectedArtifactHash':a['hash'],'expectedVersionRevision':p['versioning']['revision']}
    async def forbidden(*args,**kwargs):raise AssertionError('Export must not compile')
    monkeypatch.setattr(svc,'add_artifact',forbidden)
    result=exporter.export('alice',p['id'],body)
    frozen=svc.directory_profile.intake.get('alice',result['release']['releaseId'])
    assert frozen['base']['bundle']==a['bundle'] and frozen['base']['css']==a['css']
    assert frozen['base']['artifactHash']!=a['hash']
    assert frozen['base']['runtimeNamespace']=='studio'
    assert result['source']['artifactHash']==a['hash'] and result['source']['taskId']==a['taskId']
    assert exporter.export('alice',p['id'],body)==result
    assert svc.store.get('alice',p['id'])['artifacts'][-1]==a
    assert len(svc.store.get('alice',p['id'])['artifacts'])==1


async def test_export_rejects_unadopted_stale_revision_tampering_and_wrong_namespace(svc,tmp_path):
    manager,exporter=wire(svc,tmp_path)
    p=svc.store.create('alice','Expert','Synthetic expert app',op());svc.preparation.enable('alice',p['id'])
    configured=configure(manager,p)
    with pytest.raises(StudioError,match='USER_ADOPTION_REQUIRED'):
        exporter.export('alice',p['id'],{'operationId':op(),'expectedArtifactHash':'a'*64,'expectedVersionRevision':0})
    p=await artifact(svc,p,configured['configuration']['contract']);h=p['versioning']['adoptedHash']
    body={'operationId':op(),'expectedArtifactHash':h,'expectedVersionRevision':p['versioning']['revision']-1}
    with pytest.raises(StudioError,match='VERSION_CHANGED'):exporter.export('alice',p['id'],body)
    body['expectedVersionRevision']+=1
    svc.store.mutate('alice',p['id'],op(),{},lambda q:q['artifacts'][0]['files'].update({'src/app.js':'tampered'}))
    with pytest.raises(StudioError,match='ARTIFACT_INTEGRITY_FAILED'):exporter.export('alice',p['id'],body)


async def test_new_expert_artifact_hash_binds_its_frozen_backend_contract(svc,tmp_path):
    manager,exporter=wire(svc,tmp_path)
    p=svc.store.create('alice','Expert','Synthetic expert app',op());svc.preparation.enable('alice',p['id'])
    configured=configure(manager,p);p=await artifact(svc,p,configured['configuration']['contract'])
    def tamper(q):
        q['artifacts'][0]['snapshot']['contracts']['foundation']['expertDeployment']['verification']['checks'][0]['expected']['contains']='different expectation'
    svc.store.mutate('alice',p['id'],op(),{},tamper)
    with pytest.raises(StudioError,match='ARTIFACT_INTEGRITY_FAILED'):
        exporter.export('alice',p['id'],{'operationId':op(),'expectedArtifactHash':p['versioning']['adoptedHash'],'expectedVersionRevision':p['versioning']['revision']})


async def test_restored_expert_version_preserves_frozen_contract_and_exports_with_current_adoption_revision(svc,tmp_path):
    manager,exporter=wire(svc,tmp_path)
    p=svc.store.create('alice','Expert','Synthetic expert app',op());svc.preparation.enable('alice',p['id'])
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
    current=svc.store.get('alice',p['id']);a=current['artifacts'][-1]
    assert len(current['artifacts'])==3 and a['restoredFrom']==original['hash']
    assert a['hash']!=original['hash'] and a['taskId']!=original['taskId']
    assert restored['versioning']['adoptedHash']==a['hash'] and restored['versioning']['revision']>before_restore_revision
    assert a['expertContractDigest']==original['expertContractDigest']==digest(contract)
    assert a['snapshot']['contracts']['foundation']['expertDeployment']==contract
    verify(a)

    export_request={'operationId':op(),'expectedArtifactHash':a['hash'],'expectedVersionRevision':before_restore_revision}
    with pytest.raises(StudioError,match='VERSION_CHANGED'):
        exporter.export('alice',p['id'],export_request)
    export_request['expectedVersionRevision']=restored['versioning']['revision']
    result=exporter.export('alice',p['id'],export_request)
    frozen=svc.directory_profile.intake.get('alice',result['release']['releaseId'])
    assert result['source']['artifactHash']==a['hash'] and result['source']['taskId']==a['taskId']
    assert result['source']['versionRevision']==restored['versioning']['revision']
    assert frozen['base']['version']==a['version'] and a['version']!=original['version']
    assert frozen['base']['bundle']==original['bundle'] and frozen['base']['css']==original['css']
    assert frozen['backend']['template']==contract['template'] and frozen['verification']==contract['verification']
    # Restoring changes the version identity, never weakens its contract seal.
    changed=deepcopy(a)
    changed['snapshot']['contracts']['foundation']['expertDeployment']['verification']['checks'][0]['expected']['contains']='tampered'
    with pytest.raises(StudioError,match='ARTIFACT_INTEGRITY_FAILED'):
        verify(changed)


async def test_expert_foundation_preflight_routes_model_dependency_without_executing_an_instance(svc,tmp_path,monkeypatch):
    manager,_=wire(svc,tmp_path)
    p=svc.store.create('alice','Expert','Synthetic expert app',op());svc.preparation.enable('alice',p['id'])
    configure(manager,p)
    model_calls=[];runtime_calls=[]
    async def model(owner,body):
        # Only the provider transport is replaced: probe_runtime -> invoke ->
        # model.generate -> generate and its usage accounting remain real.
        model_calls.append((owner,deepcopy(body)))
        session=next(iter(svc.runtime_sessions.values()))
        assert session['project']==p['id'] and session['manifest']['capabilities']==['model']
        assert 'deploymentProfile' not in session
        return {'choices':[{'message':{'content':'WANX_EXPERT_DEPENDENCY_OK'}}]}
    original_invoke=svc.invoke
    async def invoke(owner,token,method,params):
        runtime_calls.append(method)
        return await original_invoke(owner,token,method,params)
    async def forbidden(*args,**kwargs):
        raise AssertionError('Preparation must not create or execute a deployment expert')
    monkeypatch.setattr(svc,'model',model)
    monkeypatch.setattr(svc,'invoke',invoke)
    monkeypatch.setattr(svc.directory_profile.experts,'probe',forbidden,raising=False)
    monkeypatch.setattr(svc.directory_profile.experts,'create',forbidden,raising=False)
    before=deepcopy(svc.store.get('alice',p['id']))
    result=await svc.preparation.probe_runtime('alice',p['id'],'foundation')
    assert runtime_calls==['model.generate'] and len(model_calls)==1 and model_calls[0][0]=='alice'
    assert 'WANX_EXPERT_DEPENDENCY_OK' in model_calls[0][1]['messages'][0]['content']
    assert svc.store.db.execute('SELECT state FROM usage WHERE owner=? AND task=?',('alice',p['id'])).fetchall()[0][0]=='completed'
    assert result['status']=='passed' and result['expertTemplate']==TEMPLATE
    assert '模型依赖连通' in result['coverage'] and '实例执行及客户端握手由部署候选验证' in result['coverage']
    assert not svc.runtime_sessions and svc.store.get('alice',p['id'])==before


async def test_plain_foundation_preflight_stays_native_only_and_does_not_probe_model(svc,monkeypatch):
    p=svc.store.create('alice','Plain','Plain foundation app',op());svc.preparation.enable('alice',p['id'])
    async def forbidden(*args,**kwargs):
        raise AssertionError('Ordinary foundation must not borrow the expert model preflight')
    monkeypatch.setattr(svc,'model',forbidden)
    with pytest.raises(StudioError,match='FOUNDATION_NATIVE_RUNTIME_REQUIRED'):
        await svc.preparation.probe_runtime('alice',p['id'],'foundation')
    assert not svc.runtime_sessions
    assert svc.store.db.execute('SELECT count(*) FROM usage').fetchone()[0]==0
