import asyncio
from copy import deepcopy
import json
from pathlib import Path
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI

from wanx_studio.api import create_router
from wanx_studio.contracts import StudioError
from wanx_studio.deployment.expert_profile import ExpertProfile, PROFILE
from wanx_studio.deployment.expert_runtime import validate_backend
from wanx_studio.deployment.intake import ReleaseIntake
from wanx_studio.deployment.miniapp_profile import MiniappProfile
from wanx_studio.deployment.profiles import DeploymentProfiles
from wanx_studio.workshop import PersonalWorkshop
from test_directory_intake import write_source, replace_artifact

ROOT=Path(__file__).resolve().parents[2]
OWNER='wanx:7'
RELEASE='expert-profile-0.1.0-r1'


class Experts:
    def __init__(self, svc):
        self.svc=svc;self.prepared=[];self.probes=[];self.failures=0;self.active=False

    def busy(self, owner, slot):return self.active

    def templates(self):return []

    async def prepare(self, owner, target, project_id, descriptor, guard):
        guard()
        if self.failures:
            self.failures-=1
            raise StudioError('EXPERT_UNAVAILABLE',409)
        binding={'owner':owner,'target':target,'projectId':project_id,'slotApplicationId':self.svc.deployment_profile.slot_id(owner,target),
                 'template':descriptor['template'],'descriptorDigest':'sha256:'+'a'*64,'agentId':'synthetic-private-'+target['environment']}
        self.prepared.append(binding)
        return binding

    async def verify(self, owner, binding, guard):
        guard();assert owner==binding['owner']

    async def probe(self, owner, binding, operation_id, guard, *, text):
        guard();self.probes.append((binding['target']['environment'],operation_id))
        return {'id':operation_id,'state':'succeeded','result':text}

    async def invoke(self, owner, token, operation, body):
        self.svc.runtime(owner,token)
        if operation!='expert.tasks':raise StudioError('EXPERT_OPERATION_DENIED',403)
        return {'items':[],'context':{'scopeId':'a'*64}}


@pytest.fixture
async def setup(tmp_path):
    svc=PersonalWorkshop(tmp_path/'store',ROOT)
    mini=MiniappProfile(svc,{'boxId':'synthetic-box'},lambda owner:None)
    intake=ReleaseIntake(svc.store,tmp_path/'inbox',tmp_path/'snapshots',backend_validator=validate_backend)
    path=intake.inbox/intake.owner_scope(OWNER)/RELEASE
    manifest,base=write_source(path,release_id=RELEASE)
    template={**manifest['backend']['template'],'version':'0.0.0+sha.'+'a'*12}
    manifest['backend']['template']=template
    backend={'schemaVersion':1,'format':'wanx-expert-backend-v1','template':template,'mode':'ask'}
    replace_artifact(path,manifest,'backend/expert.json',backend)
    replace_artifact(path,manifest,'support/dependencies.lock.json',{'schemaVersion':1,'dependencies':[{'kind':'expert-template',**template}]})
    experts=Experts(svc)
    expert=ExpertProfile(svc,{'boxId':'synthetic-box'},lambda owner:None,runtime=experts,intake=intake)
    profiles=DeploymentProfiles(mini,expert)
    svc.deployment_profile=profiles;svc.directory_profile=expert;svc.expert_runtime=experts
    svc.deployments.adapter=profiles;svc.deployments.start=lambda:None;svc.deployments.retry_delay=0
    item=expert.ingest(OWNER,RELEASE)
    yield svc,profiles,expert,experts,item
    del svc.expert_runtime # This synthetic dependency owns no callback lifecycle.
    await svc.close()


async def deploy(svc, expert, item, environment, key):
    prep=await expert.prepare_directory(OWNER,RELEASE,{'directoryDigest':item['directoryDigest'],'environment':environment,'operationId':uuid4().hex})
    op=await expert.submit_directory(OWNER,RELEASE,{'preparationId':prep['preparationId'],'idempotencyKey':key})
    return prep,op


async def progress(svc, profiles, expert, operation, *, handshake=True):
    for _ in range(65):
        await svc.deployments.process_once(operation['id'])
        await asyncio.sleep(0)
        for ticket in profiles.delivery_list(OWNER)['items']:
            ticket=profiles.delivery_claim(OWNER,ticket['id'],{'nonce':ticket['nonce'],'clientId':'synthetic-client'})
            fields={'nonce','clientId','artifactHash','slotApplicationId','operationId','step','fence','generation','payloadDigest'}
            profiles.delivery_ack(OWNER,ticket['id'],{**{k:ticket[k] for k in fields},'state':'prepared' if ticket['step']=='prepare_client' else 'active'})
            if ticket['step']=='activate':
                token=profiles.open_runtime(OWNER,ticket['slotApplicationId'],{'artifactHash':ticket['artifactHash'],'environment':ticket['environment'],'generation':ticket['generation']})['session']
                if handshake:await svc.invoke(OWNER,token,'foundation.invoke',{'operation':'expert.tasks','input':{}})
        current=svc.deployments.operation(OWNER,operation['id'])
        if current['state'] in {'succeeded','rejected','failed_recovered','failed_degraded','recovery_required'}:return current
    return current


async def test_directory_deploy_uses_real_contracts_without_editable_project_and_requires_client_expert_handshake(setup):
    svc,profiles,expert,experts,item=setup
    assert svc.store.db.execute('SELECT count(*) FROM projects').fetchone()[0]==0
    prep,op=await deploy(svc,expert,item,'dev','directory-dev')
    current=await progress(svc,profiles,expert,op,handshake=False)
    assert current['state']=='waiting_client' and current['phase']=='verify_active'
    assert svc.deployments.journal.receipt(OWNER,op['id']) is None
    slot=profiles.slot_id(OWNER,prep['target'])
    binding=profiles.find_binding(OWNER,slot)
    token=profiles.open_runtime(OWNER,slot,{'artifactHash':binding['artifactHash'],'environment':'dev','generation':1})['session']
    assert await svc.invoke(OWNER,token,'foundation.invoke',{'operation':'expert.tasks','input':{}})=={'items':[],'context':{'scopeId':'a'*64}}
    assert (await progress(svc,profiles,expert,op))['state']=='succeeded'
    receipt=svc.deployments.journal.receipt(OWNER,op['id'])['receipt']
    assert [r['role'] for r in receipt['componentResults']]==['backend','client']
    assert all(r['status']=='ready' for r in receipt['componentResults'])
    assert profiles.find_binding(OWNER,slot)['target']['applicationId']=='demo.expert.application'
    assert experts.prepared[0]['target']['environment']=='dev' and experts.probes
    assert svc.store.db.execute('SELECT count(*) FROM projects').fetchone()[0]==0


async def test_prod_requires_verified_dev_preserves_client_data_and_private_instances_are_environment_scoped(setup):
    svc,profiles,expert,experts,item=setup
    with pytest.raises(StudioError,match='DEPLOYMENT_DEV_VERIFICATION_REQUIRED'):
        await deploy(svc,expert,item,'prod','too-early')
    prep,op=await deploy(svc,expert,item,'dev','dev')
    assert (await progress(svc,profiles,expert,op))['state']=='succeeded'
    devslot=profiles.slot_id(OWNER,prep['target']);binding=profiles.find_binding(OWNER,devslot)
    token=profiles.open_runtime(OWNER,devslot,{'artifactHash':binding['artifactHash'],'environment':'dev','generation':1})['session']
    await svc.invoke(OWNER,token,'data.put',{'collection':'results','id':'proof','value':{'text':'copied'}})
    prodprep,prod=await deploy(svc,expert,item,'prod','prod')
    assert (await progress(svc,profiles,expert,prod))['state']=='succeeded'
    prodslot=profiles.slot_id(OWNER,prodprep['target']);assert prodslot!=devslot
    prodtoken=profiles.open_runtime(OWNER,prodslot,{'artifactHash':binding['artifactHash'],'environment':'prod','generation':1})['session']
    assert (await svc.invoke(OWNER,prodtoken,'data.get',{'collection':'results','id':'proof'}))['text']=='copied'
    await svc.invoke(OWNER,prodtoken,'data.put',{'collection':'results','id':'prod-only','value':{'text':'isolated'}})
    assert await svc.invoke(OWNER,token,'data.get',{'collection':'results','id':'prod-only'}) is None
    assert profiles.find_binding(OWNER,devslot)['expertBinding']['agentId']!=profiles.find_binding(OWNER,prodslot)['expertBinding']['agentId']


async def test_directory_conflict_and_active_runs_cannot_be_bypassed_with_stale_preparation(setup):
    svc,profiles,expert,experts,item=setup
    with pytest.raises(StudioError,match='DEPLOYMENT_VERSION_CHANGED'):
        await expert.prepare_directory(OWNER,RELEASE,{'directoryDigest':'sha256:'+'0'*64,'environment':'dev','operationId':uuid4().hex})
    experts.active=True
    with pytest.raises(StudioError,match='EXPERT_RUN_ACTIVE'):await deploy(svc,expert,item,'dev','busy')
    experts.active=False
    prep,op=await deploy(svc,expert,item,'dev','good')
    assert (await progress(svc,profiles,expert,op))['state']=='succeeded'
    slot=profiles.slot_id(OWNER,prep['target']);binding=profiles.find_binding(OWNER,slot)
    token=profiles.open_runtime(OWNER,slot,{'artifactHash':binding['artifactHash'],'environment':'dev','generation':1})['session']
    nextprep,nextop=await deploy(svc,expert,item,'dev','upgrade')
    assert (await progress(svc,profiles,expert,nextop))['state']=='succeeded'
    with pytest.raises(StudioError,match='UPDATE_REQUIRED'):
        await svc.invoke(OWNER,token,'foundation.invoke',{'operation':'expert.tasks','input':{}})


async def test_directory_routes_are_project_independent_and_require_strict_body_and_query(setup):
    svc,profiles,expert,experts,item=setup
    app=FastAPI()
    @app.exception_handler(StudioError)
    async def error(request,exc):
        from fastapi.responses import JSONResponse
        return JSONResponse({'code':exc.code},status_code=exc.status)
    app.include_router(create_router(svc,lambda:OWNER))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
        assert (await client.get('/api/app-studio/deployment/directory-releases')).json()['items'][0]['applicationId']==item['applicationId']
        assert (await client.post(f'/api/app-studio/deployment/directory-releases/{RELEASE}/ingest',json={'path':'/tmp/arbitrary'})).status_code==422
        assert (await client.get(f'/api/app-studio/deployment/directory-releases/{RELEASE}/context?boxId=other')).status_code==422
        body={'directoryDigest':item['directoryDigest'],'environment':'dev','operationId':uuid4().hex}
        response=await client.post(f'/api/app-studio/deployment/directory-releases/{RELEASE}/prepare',json=body)
        assert response.status_code==200,response.text
        prep=response.json()
        response=await client.post(f'/api/app-studio/deployment/directory-releases/{RELEASE}/submit',json={'preparationId':prep['preparationId'],'idempotencyKey':'real-api-submit'})
        assert response.status_code==202,response.text


async def test_candidate_uses_frozen_verification_and_rejects_wrong_expert_result(setup):
    svc,profiles,expert,experts,item=setup
    seen=[]
    async def wrong_result(owner,binding,operation_id,guard,*,text):
        guard();seen.append(text)
        return {'id':operation_id,'state':'succeeded','result':'unexpected response'}
    experts.probe=wrong_result
    prep,op=await deploy(svc,expert,item,'dev','wrong-probe')
    current=await progress(svc,profiles,expert,op)
    assert seen==[expert.record(svc.deployments.journal.get_operation(OWNER,op['id']))['verification']['checks'][0]['input']['text']]
    assert current['state'] in {'rejected','failed_recovered'}
    assert profiles.find_binding(OWNER,profiles.slot_id(OWNER,prep['target'])) is None


@pytest.mark.parametrize('failures,expected',[(1,'succeeded'),(3,'failed_recovered')])
async def test_expert_preparation_retries_are_bounded_and_can_recover(setup,failures,expected):
    svc,profiles,expert,experts,item=setup
    experts.failures=failures
    prep,op=await deploy(svc,expert,item,'dev','prepare-retry')
    for _ in range(5):
        current=await progress(svc,profiles,expert,op)
        if current['state'] in {'succeeded','rejected','failed_recovered','failed_degraded','recovery_required'}:break
        error=expert.get('prepare-error',op['id'])
        if error:expert.put('prepare-error',op['id'],{**error,'retryAt':0})
    assert current['state']==expected
    assert experts.failures==0
    if failures==3:
        assert expert.get('prepare-error',op['id'])['attempts']==3
        assert profiles.find_binding(OWNER,profiles.slot_id(OWNER,prep['target'])) is None
