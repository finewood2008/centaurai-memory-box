import asyncio
import json
from copy import deepcopy
from pathlib import Path
from uuid import uuid4
from unittest.mock import AsyncMock

import pytest
from wanx_studio.contracts import digest, StudioError
from wanx_studio.workshop import PersonalWorkshop
from wanx_studio.deployment.miniapp_profile import MiniappProfile, PROFILE
from wanx_studio.deployment.adapters import Blocked

ROOT=Path(__file__).resolve().parents[2]
OWNER='wanx:7'

@pytest.fixture
async def setup(tmp_path):
    svc=PersonalWorkshop(tmp_path,ROOT)
    revoked=[False]
    def authority(owner):
        if owner!=OWNER or revoked[0]:raise PermissionError()
    profile=MiniappProfile(svc,{'boxId':'box-test'},authority)
    svc.deployment_profile=profile;svc.deployments.adapter=profile
    svc.deployments.start=lambda:None;svc.deployments.retry_delay=0
    files={'miniapp.manifest.json':'{"schemaVersion":1,"name":"Notes","entry":"src/app.js","capabilities":["data"],"collections":{"notes":{"text":"string"}}}', 'src/app.js':'export function mount(root,api){root.textContent="Notes"; return ()=>{}; }'}
    source={'allowed':True,'format':'wanx-miniapp-source-v1','applicationId':'dev.synthetic.notes','version':'0.1.0','origin':'local','files':files,'sourceHash':digest(files)}
    p=await svc.copy_source(OWNER,{'operationId':uuid4().hex,'name':'Notes','source':source})
    a=p['artifacts'][0]
    p=svc.versions.adopt(OWNER,p['id'],{'operationId':uuid4().hex,'expectedRevision':p['versioning']['revision'],'artifactHash':a['hash'],'confirmedByUser':True})
    yield svc,profile,p,a,revoked
    await svc.close()

async def prepare(profile,p,a,environment='dev'):
    return await profile.prepare(OWNER,p['id'],{'artifactHash':a['hash'],'expectedRevision':p['versioning']['revision'],'environment':environment,'operationId':uuid4().hex})

async def run_until(svc,profile,operation,*,client=False,runtime=False):
    for _ in range(35):
        await svc.deployments.process_once(operation['id'])
        for ticket in profile.delivery_list(OWNER)['items'] if client else []:
            ticket=profile.delivery_claim(OWNER,ticket['id'],{'nonce':ticket['nonce'],'clientId':'client-test'})
            payload=profile.delivery_payload(OWNER,ticket['id'])
            assert payload['applicationId']==ticket['slotApplicationId']
            fields={'nonce','clientId','artifactHash','slotApplicationId','operationId','step','fence','generation','payloadDigest'}
            ack={k:ticket[k] for k in fields};ack['state']='prepared' if ticket['step']=='prepare_client' else 'active'
            profile.delivery_ack(OWNER,ticket['id'],ack)
            if runtime and ticket['step']=='activate':
                try:profile.open_runtime(OWNER,ticket['slotApplicationId'],{'artifactHash':ticket['artifactHash'],'environment':ticket['environment'],'generation':ticket['generation']})
                except StudioError as error:
                    assert error.code=='DEPLOYMENT_RUNTIME_STALE'
        current=svc.deployments.operation(OWNER,operation['id'])
        if current['state'] in {'succeeded','rejected','failed_recovered','failed_degraded','recovery_required'}:return current
    return current

async def test_real_coordinator_waits_for_client_and_runtime_then_emits_matching_receipt(setup):
    svc,profile,p,a,_=setup
    prep=await prepare(profile,p,a)
    operation=await profile.submit(OWNER,p['id'],{'preparationId':prep['preparationId'],'idempotencyKey':'deploy-1'})
    current=await run_until(svc,profile,operation)
    assert current['state']=='waiting_client'
    assert current['phase']=='prepare_client'
    ticket=profile.delivery_list(OWNER)['items'][0]
    ticket=profile.delivery_claim(OWNER,ticket['id'],{'nonce':ticket['nonce'],'clientId':'client-test'})
    fields={'nonce','clientId','artifactHash','slotApplicationId','operationId','step','fence','generation','payloadDigest'}
    profile.delivery_ack(OWNER,ticket['id'],{**{k:ticket[k] for k in fields},'state':'prepared'})
    await svc.deployments.process_once(operation['id'])
    resumed=svc.deployments.operation(OWNER,operation['id'])
    assert resumed['phase']=='prepare_channels' and resumed['errorCode'] is None
    current=await run_until(svc,profile,operation,client=True)
    assert current['state']=='waiting_client' and current['phase']=='verify_active'
    assert svc.deployments.journal.receipt(OWNER,operation['id']) is None
    current=await run_until(svc,profile,operation,client=True,runtime=True)
    assert current['state']=='succeeded', current
    assert current['errorCode'] is None
    stored=svc.deployments.journal.get_operation(OWNER,operation['id'])
    assert stored['errorCode'] is None
    legacy=deepcopy(stored);legacy['errorCode']='CLIENT_UNAVAILABLE'
    assert svc.deployments.public_operation(legacy)['errorCode'] is None
    legacy['state']='failed_degraded'
    assert svc.deployments.public_operation(legacy)['errorCode']=='CLIENT_UNAVAILABLE'
    receipt=svc.deployments.journal.receipt(OWNER,operation['id'])['receipt']
    assert 'error' not in receipt
    assert {c['role'] for c in receipt['componentResults']}=={'backend','client'}
    assert all(c['status']=='ready' and c['actualReleaseRef']==prep['releaseRef'] for c in receipt['componentResults'])
    assert svc.store.get(OWNER,p['id'])['installed'] is None
    assert svc.deployments.capabilities()['operations']==['deploy']

async def test_dev_prod_slots_data_copy_isolation_and_old_generation_invalidated(setup):
    svc,profile,p,a,_=setup
    ordinary=svc.open_runtime(OWNER,p['id'],a['hash'],'preview')['session']
    # Ordinary production data is synthetic fixture input, not an installation receipt.
    svc.data({'owner':OWNER,'app':p['appId'],'environment':'production','manifest':a['manifest']},'data.put',{'collection':'notes','id':'original','value':{'text':'copied'},'expectedRevision':0})
    prep=await prepare(profile,p,a)
    op=await profile.submit(OWNER,p['id'],{'preparationId':prep['preparationId'],'idempotencyKey':'dev'})
    assert (await run_until(svc,profile,op,client=True,runtime=True))['state']=='succeeded'
    devslot=profile.slot_id(OWNER,prep['target'])
    dev=profile.open_runtime(OWNER,devslot,{'artifactHash':a['hash'],'environment':'dev','generation':1})['session']
    assert (await svc.invoke(OWNER,dev,'data.get',{'collection':'notes','id':'original'}))['text']=='copied'
    await svc.invoke(OWNER,dev,'data.put',{'collection':'notes','id':'dev-only','value':{'text':'development'},'expectedRevision':0})
    prodprep=await prepare(profile,p,a,'prod')
    prodop=await profile.submit(OWNER,p['id'],{'preparationId':prodprep['preparationId'],'idempotencyKey':'prod'})
    assert (await run_until(svc,profile,prodop,client=True,runtime=True))['state']=='succeeded'
    prodslot=profile.slot_id(OWNER,prodprep['target']);assert prodslot!=devslot
    prod=profile.open_runtime(OWNER,prodslot,{'artifactHash':a['hash'],'environment':'prod','generation':1})['session']
    await svc.invoke(OWNER,prod,'data.put',{'collection':'notes','id':'prod-only','value':{'text':'production'},'expectedRevision':0})
    assert await svc.invoke(OWNER,dev,'data.get',{'collection':'notes','id':'prod-only'}) is None
    assert await svc.invoke(OWNER,ordinary,'data.get',{'collection':'notes','id':'original'}) is None
    nextprep=await prepare(profile,p,a)
    nextop=await profile.submit(OWNER,p['id'],{'preparationId':nextprep['preparationId'],'idempotencyKey':'dev-next'})
    assert (await run_until(svc,profile,nextop,client=True,runtime=True))['state']=='succeeded'
    with pytest.raises(StudioError,match='UPDATE_REQUIRED'):
        await svc.invoke(OWNER,dev,'data.list',{'collection':'notes'})
    fresh=profile.open_runtime(OWNER,devslot,{'artifactHash':a['hash'],'environment':'dev','generation':2})['session']
    assert (await svc.invoke(OWNER,fresh,'data.get',{'collection':'notes','id':'dev-only'}))['text']=='development'

async def test_preparation_authority_and_claim_proofs_fail_closed(setup):
    svc,profile,p,a,revoked=setup
    with pytest.raises(StudioError,match='DEPLOYMENT_DEV_VERIFICATION_REQUIRED'):await prepare(profile,p,a,'prod')
    prep=await prepare(profile,p,a)
    body={'preparationId':prep['preparationId'],'idempotencyKey':'once'}
    op=await profile.submit(OWNER,p['id'],body)
    assert (await profile.submit(OWNER,p['id'],body))['id']==op['id']
    await run_until(svc,profile,op)
    ticket=profile.delivery_list(OWNER)['items'][0]
    with pytest.raises(StudioError,match='DEPLOYMENT_ACK_MISMATCH'):
        fields={'nonce','clientId','artifactHash','slotApplicationId','operationId','step','fence','generation','payloadDigest'}
        ack={k:ticket[k] for k in fields};ack.update(clientId='client-test',state='prepared')
        profile.delivery_ack(OWNER,ticket['id'],ack)
    claimed=profile.delivery_claim(OWNER,ticket['id'],{'nonce':ticket['nonce'],'clientId':'client-test'})
    with pytest.raises(StudioError,match='DEPLOYMENT_CLIENT_BUSY'):
        profile.delivery_claim(OWNER,ticket['id'],{'nonce':ticket['nonce'],'clientId':'different-client'})
    bad={**ack,'generation':999}
    with pytest.raises(StudioError,match='DEPLOYMENT_ACK_MISMATCH'):profile.delivery_ack(OWNER,ticket['id'],bad)
    revoked[0]=True
    with pytest.raises(Blocked,match='DEPLOYMENT_TARGET_DENIED'):
        profile.delivery_list(OWNER)
    revoked[0]=False
    with pytest.raises(Blocked):await profile.authorize(OWNER,{**prep['target'],'boxId':'other'},'deploy')

async def test_same_artifact_prepare_cannot_replace_inflight_authority_and_failed_registration_retries(setup):
    svc,profile,p,a,_=setup
    body={'artifactHash':a['hash'],'expectedRevision':p['versioning']['revision'],'environment':'dev','operationId':uuid4().hex}
    original=svc.deployments.register_release
    async def fail(*args):raise OSError('injected register crash')
    svc.deployments.register_release=fail
    with pytest.raises(OSError):await profile.prepare(OWNER,p['id'],body)
    svc.deployments.register_release=original
    prep=await profile.prepare(OWNER,p['id'],body)
    op=await profile.submit(OWNER,p['id'],{'preparationId':prep['preparationId'],'idempotencyKey':'first'})
    another=await prepare(profile,p,a)
    assert another['preparationId']!=prep['preparationId']
    assert (await run_until(svc,profile,op,client=True,runtime=True))['state']=='succeeded'

async def test_process_reopen_resumes_persisted_client_intent_without_installed_forgery(setup):
    svc,profile,p,a,_=setup
    prep=await prepare(profile,p,a)
    op=await profile.submit(OWNER,p['id'],{'preparationId':prep['preparationId'],'idempotencyKey':'restart'})
    await run_until(svc,profile,op)
    oldticket=profile.delivery_list(OWNER)['items'][0]
    root=svc.store.root
    await svc.close()
    reopened=PersonalWorkshop(root,ROOT)
    try:
        adapter=MiniappProfile(reopened,{'boxId':'box-test'},lambda owner:None if owner==OWNER else (_ for _ in ()).throw(PermissionError()))
        reopened.deployment_profile=adapter;reopened.deployments.adapter=adapter;reopened.deployments.start=lambda:None;reopened.deployments.retry_delay=0
        ticket=adapter.delivery_list(OWNER)['items'][0]
        assert (ticket['id'],ticket['nonce'])==(oldticket['id'],oldticket['nonce'])
        assert (await run_until(reopened,adapter,op,client=True,runtime=True))['state']=='succeeded'
        assert reopened.store.get(OWNER,p['id'])['installed'] is None
    finally:await reopened.close()

async def test_supported_actions_are_profile_specific_and_unknown_declaration_fails_closed(setup):
    svc,profile,p,a,_=setup
    assert svc.deployments.capabilities()['operations']==['deploy']
    profile.supported_actions=['unsafe']
    assert svc.deployments.capabilities()['operations']==[]
    profile.supported_actions=['deploy']
    prep=await prepare(profile,p,a)
    record=profile.get('preparation',prep['preparationId'])
    request=deepcopy(record['request']);request['kind']='restart';request['idempotencyKey']='bad-action'
    with pytest.raises(StudioError,match='DEPLOYMENT_ACTION_UNAVAILABLE'):
        await svc.deployments.submit(OWNER,request)


async def test_resource_deployment_freezes_first_copy_and_preserves_environment_bindings(setup):
    from test_workshop_model import DefaultModels
    from test_workshop_runtime import Knowledge
    svc,profile,_,_,_=setup
    svc.model.model=DefaultModels()
    svc.files=AsyncMock(return_value=[{'id':'file-production','name':'synthetic.txt','text':'fixture contents'}])
    svc.knowledge_provider=Knowledge()
    files={'miniapp.manifest.json':json.dumps({'schemaVersion':1,'name':'Resources','entry':'src/app.js','capabilities':['data','model','files','knowledge'],'collections':{'notes':{'text':'string'}}}), 'src/app.js':'export function mount(root,api){root.textContent="Resources"; return ()=>{}; }'}
    source={'allowed':True,'format':'wanx-miniapp-source-v1','applicationId':'dev.synthetic.resources','version':'0.1.0','origin':'local','files':files,'sourceHash':digest(files)}
    p=await svc.copy_source(OWNER,{'operationId':uuid4().hex,'name':'Resources','source':source})
    a=p['artifacts'][0]
    p=svc.versions.adopt(OWNER,p['id'],{'operationId':uuid4().hex,'expectedRevision':p['versioning']['revision'],'artifactHash':a['hash'],'confirmedByUser':True})
    with svc.store.transaction():
        stored=svc.store.get(OWNER,p['id'])
        stored['_runtimeModel']={'revision':2,'modelId':'default-b','label':'synthetic B','unrelated':'synthetic-do-not-copy'}
        stored['_runtimeSources']={'production':{'files':['file-production'],'knowledge':['w']},'preview':{'files':['preview-only']}}
        svc.store.save(stored)
    assert profile.context(OWNER,p['id'])['available']
    assert set(profile.context(OWNER,p['id'])['supportedCapabilities'])=={'data','model','files','knowledge'}
    prep=await prepare(profile,p,a)
    assert 'synthetic-do-not-copy' not in json.dumps(profile.get('preparation',prep['preparationId'])['initialization'])
    # Accepted preparation freezes references; later ordinary changes do not leak.
    with svc.store.transaction():
        stored=svc.store.get(OWNER,p['id'])
        stored['_runtimeModel']['modelId']='default-a'
        stored['_runtimeSources']['production']['files']=[]
        svc.store.save(stored)
    op=await profile.submit(OWNER,p['id'],{'preparationId':prep['preparationId'],'idempotencyKey':'resources-dev'})
    assert (await run_until(svc,profile,op,client=True,runtime=True))['state']=='succeeded'
    slot=profile.slot_id(OWNER,prep['target'])
    dev=profile.open_runtime(OWNER,slot,{'artifactHash':a['hash'],'environment':'dev','generation':1})['session']
    assert (await svc.invoke(OWNER,dev,'model.list',{}))['modelId']=='default-b'
    assert (await svc.invoke(OWNER,dev,'files.read',{'id':'file-production'}))['text']=='fixture contents'
    with pytest.raises(StudioError,match='FILE_NOT_SELECTED'):
        await svc.invoke(OWNER,dev,'files.read',{'id':'preview-only'})
    assert (await svc.invoke(OWNER,dev,'knowledge.search',{'warehouseId':'w','query':'fixture'}))['items']
    await svc.invoke(OWNER,dev,'model.select',{'operationId':uuid4().hex,'expectedRevision':2,'modelId':'default-a'})
    prodprep=await prepare(profile,p,a,'prod')
    prodop=await profile.submit(OWNER,p['id'],{'preparationId':prodprep['preparationId'],'idempotencyKey':'resources-prod'})
    assert (await run_until(svc,profile,prodop,client=True,runtime=True))['state']=='succeeded'
    prod=profile.open_runtime(OWNER,profile.slot_id(OWNER,prodprep['target']),{'artifactHash':a['hash'],'environment':'prod','generation':1})['session']
    assert (await svc.invoke(OWNER,prod,'model.list',{}))['modelId']=='default-a'
    await svc.invoke(OWNER,prod,'model.select',{'operationId':uuid4().hex,'expectedRevision':3,'modelId':None})
    assert (await svc.invoke(OWNER,dev,'model.list',{}))['modelId']=='default-a'
    # Upgrade keeps the destination's changes, even when ordinary config differs.
    nextprep=await prepare(profile,p,a)
    nextop=await profile.submit(OWNER,p['id'],{'preparationId':nextprep['preparationId'],'idempotencyKey':'resources-next'})
    assert (await run_until(svc,profile,nextop,client=True,runtime=True))['state']=='succeeded'
    fresh=profile.open_runtime(OWNER,slot,{'artifactHash':a['hash'],'environment':'dev','generation':2})['session']
    assert (await svc.invoke(OWNER,fresh,'model.list',{}))['modelId']=='default-a'
    assert (await svc.invoke(OWNER,prod,'model.list',{}))['modelId'] is None
    assert (await svc.invoke(OWNER,fresh,'files.read',{'id':'file-production'}))['text']=='fixture contents'
    svc.files.side_effect=StudioError('REVOKED',403)
    with pytest.raises(StudioError,match='REVOKED'):
        await svc.invoke(OWNER,fresh,'files.read',{'id':'file-production'})
    svc.knowledge_provider.allowed=False
    with pytest.raises(StudioError,match='KNOWLEDGE_ACCESS_REVOKED'):
        await svc.invoke(OWNER,fresh,'knowledge.search',{'warehouseId':'w','query':'fixture'})
    root=svc.store.root
    await svc.close()
    reopened=PersonalWorkshop(root,ROOT,DefaultModels(),AsyncMock(return_value=[{'id':'file-production','name':'synthetic.txt','text':'fixture contents'}]))
    try:
        adapter=MiniappProfile(reopened,{'boxId':'box-test'},lambda owner:None)
        reopened.deployment_profile=adapter;reopened.deployments.adapter=adapter
        token=adapter.open_runtime(OWNER,slot,{'artifactHash':a['hash'],'environment':'dev','generation':2})['session']
        assert (await reopened.invoke(OWNER,token,'model.list',{}))['modelId']=='default-a'
        assert (await reopened.invoke(OWNER,token,'files.read',{'id':'file-production'}))['text']=='fixture contents'
    finally:
        await reopened.close()


async def test_pre_resource_preparation_without_initialization_remains_resumable(setup):
    svc,profile,p,a,_=setup
    prep=await prepare(profile,p,a)
    with profile.transaction():
        record=profile.get('preparation',prep['preparationId'])
        del record['initialization'] # Persisted shape from the prior data-only release.
        profile.put('preparation',prep['preparationId'],record)
    op=await profile.submit(OWNER,p['id'],{'preparationId':prep['preparationId'],'idempotencyKey':'legacy-resume'})
    assert (await run_until(svc,profile,op,client=True,runtime=True))['state']=='succeeded'


async def test_data_write_queued_before_generation_change_cannot_mutate_new_generation(setup,monkeypatch):
    import threading
    svc,profile,p,a,_=setup
    prep=await prepare(profile,p,a)
    op=await profile.submit(OWNER,p['id'],{'preparationId':prep['preparationId'],'idempotencyKey':'race-data'})
    assert (await run_until(svc,profile,op,client=True,runtime=True))['state']=='succeeded'
    slot=profile.slot_id(OWNER,prep['target'])
    body={'artifactHash':a['hash'],'environment':'dev','generation':1}
    token=profile.open_runtime(OWNER,slot,body)['session']
    queued=threading.Event()
    original=svc.data
    def write(*args,**kwargs):
        queued.set()
        return original(*args,**kwargs)
    monkeypatch.setattr(svc,'data',write)
    with svc.store.lock:
        pending=asyncio.create_task(svc.invoke(OWNER,token,'data.put',{'collection':'notes','id':'stale','value':{'text':'must not commit'}}))
        assert await asyncio.to_thread(queued.wait,2)
        with profile.transaction():
            binding=profile.find_binding(OWNER,slot)
            binding['generation']=2
            profile.put('binding',profile.slot_key(OWNER,prep['target']),binding)
    with pytest.raises(StudioError,match='UPDATE_REQUIRED'):
        await pending
    fresh=profile.open_runtime(OWNER,slot,{**body,'generation':2})['session']
    assert await svc.invoke(OWNER,fresh,'data.get',{'collection':'notes','id':'stale'}) is None


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
