import hashlib
import json
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import FastAPI
from httpx import ASGITransport,AsyncClient

from wanx_studio.contracts import StudioError
from wanx_studio.deployment.adapters import Blocked
from wanx_studio.deployment.contracts import canonicalize_json
from wanx_studio.deployment.expert_dispatch import authorize_studio_audience
from wanx_studio.deployment.expert_profile import ExpertProfile
from wanx_studio.deployment.expert_runtime import validate_backend
from wanx_studio.deployment.intake import ReleaseIntake
from wanx_studio.deployment.miniapp_profile import MiniappProfile, configure
from wanx_studio.deployment.profiles import DeploymentProfiles
from wanx_studio.deployment.source_registry import SourceRegistry
from wanx_studio.service import StudioService
from wanx_studio.workshop import PersonalWorkshop
from test_directory_intake import write_source,replace_artifact
from test_expert_deployment import Experts,progress

ROOT=Path(__file__).resolve().parents[2]
OWNER='wanx:7'
RELEASE='studio-expert-0.1.0'


def studio_source(path):
    manifest,base=write_source(path,release_id=RELEASE)
    base={**base,'runtimeNamespace':'studio'}
    base['artifactHash']=hashlib.sha256(canonicalize_json({k:v for k,v in base.items() if k!='artifactHash'}).encode()).hexdigest()
    replace_artifact(path,manifest,'client/payload.json',base)
    return manifest,base


@pytest.fixture
async def studio(tmp_path):
    service=StudioService(tmp_path/'.wanx-app-studio',ROOT)
    user=SimpleNamespace(role='admin',disabled=False)
    service.team=SimpleNamespace(is_admin=lambda owner:owner==OWNER and user.role=='admin' and not user.disabled)
    registry=SourceRegistry(tmp_path);registry.seed_existing()
    intake=ReleaseIntake(service.store,tmp_path/'inbox',tmp_path/'snapshots',backend_validator=validate_backend,runtime_namespace='studio')
    path=intake.inbox/intake.owner_scope(OWNER)/RELEASE
    studio_source(path)
    experts=Experts(service)
    authority=lambda owner:None
    mini=MiniappProfile(service)
    expert=ExpertProfile(service,{'boxId':'synthetic-box'},authority,runtime=experts,intake=intake,source='studio',source_registry=registry)
    profiles=DeploymentProfiles(mini,expert)
    service.deployment_profile=profiles;service.directory_profile=expert;service.expert_runtime=experts
    service.deployments.adapter=profiles;service.deployments.start=lambda:None;service.deployments.retry_delay=0
    yield service,user,registry,intake,expert,profiles
    del service.expert_runtime
    await service.close();registry.close()


async def test_original_studio_service_executes_deployed_expert_without_workshop_identity(studio):
    service,user,registry,intake,expert,profiles=studio
    assert not getattr(service,'workshop',False) and expert.runtime_namespace=='studio'
    item=expert.ingest(OWNER,RELEASE)
    prep=await expert.prepare_directory(OWNER,RELEASE,{'directoryDigest':item['directoryDigest'],'environment':'dev','operationId':uuid4().hex})
    op=await expert.submit_directory(OWNER,RELEASE,{'preparationId':prep['preparationId'],'idempotencyKey':'studio-real-service'})
    assert (await progress(service,profiles,expert,op))['state']=='succeeded'
    slot=profiles.slot_id(OWNER,prep['target']);binding=profiles.find_binding(OWNER,slot)
    assert binding['base']['runtimeNamespace']=='studio'
    token=profiles.open_runtime(OWNER,slot,{'artifactHash':binding['artifactHash'],'environment':'dev','generation':1})['session']
    assert (await service.invoke(OWNER,token,'foundation.invoke',{'operation':'expert.tasks','input':{}}))['items']==[]
    registry.assert_source('studio',OWNER,prep['target'])
    with pytest.raises(StudioError,match='DEPLOYMENT_SOURCE_CONFLICT'):
        registry.claim('workshop',OWNER,prep['target'])
    user.role='user'
    with pytest.raises(StudioError,match='STUDIO_ADMIN_REQUIRED'):
        await service.invoke(OWNER,token,'foundation.invoke',{'operation':'expert.tasks','input':{}})


async def test_studio_preview_foundation_requires_an_actual_expert_deployment(studio):
    service,*_=studio
    token='synthetic-preview'
    service.runtime_sessions[token]={'owner':OWNER,'expires':10**12,'manifest':{'capabilities':['foundation']}}
    with pytest.raises(StudioError,match='EXPERT_DEPLOYMENT_REQUIRED'):
        await service.invoke(OWNER,token,'foundation.invoke',{'operation':'expert.tasks','input':{}})


async def test_two_editor_stores_cannot_prepare_independent_generations_for_the_same_slot(studio,tmp_path):
    service,user,registry,intake,expert,profiles=studio
    item=expert.ingest(OWNER,RELEASE)
    prep=await expert.prepare_directory(OWNER,RELEASE,{'directoryDigest':item['directoryDigest'],'environment':'dev','operationId':uuid4().hex})
    workshop=PersonalWorkshop(tmp_path/'.wanx-workshop',ROOT)
    other_intake=ReleaseIntake(workshop.store,tmp_path/'other-inbox',tmp_path/'other-snapshots',backend_validator=validate_backend)
    source=other_intake.inbox/other_intake.owner_scope(OWNER)/RELEASE
    write_source(source,release_id=RELEASE)
    other=ExpertProfile(workshop,{'boxId':'synthetic-box'},lambda owner:None,runtime=Experts(workshop),intake=other_intake,source_registry=registry)
    try:
        release=other.ingest(OWNER,RELEASE)
        with pytest.raises(StudioError,match='DEPLOYMENT_SOURCE_CONFLICT'):
            other.directory_context(OWNER,RELEASE)
        with pytest.raises(StudioError,match='DEPLOYMENT_SOURCE_CONFLICT'):
            await other.prepare_directory(OWNER,RELEASE,{'directoryDigest':release['directoryDigest'],'environment':'dev','operationId':uuid4().hex})
        assert workshop.store.db.execute("SELECT count(*) FROM deployment_profile_objects WHERE kind='expert-preparation'").fetchone()[0]==0
        registry.assert_source('studio',OWNER,prep['target'])
    finally:await workshop.close()


def test_managed_audience_cannot_use_management_or_another_slot_session():
    app='ai.wanx.selfmade.'+'a'*32
    other='ai.wanx.selfmade.'+'b'*32
    service=SimpleNamespace(runtime_sessions={'own':{'owner':OWNER,'app':'base','deploymentSlot':app},'foreign':{'owner':OWNER,'app':other,'deploymentSlot':other}})
    assert authorize_studio_audience(service,OWNER,app,f'/deployment/apps/{app}/runtime','POST')
    assert authorize_studio_audience(service,OWNER,app,'/runtime/own/invoke','POST')
    for path,method in [('/deployment/directory-releases','GET'),('/projects','GET'),(f'/deployment/apps/{other}/runtime','POST'),('/runtime/foreign/invoke','POST'),('/runtime/own/invoke','GET')]:
        with pytest.raises(StudioError,match='STUDIO_IDENTITY_FORBIDDEN'):
            authorize_studio_audience(service,OWNER,app,path,method)


def test_studio_intake_rejects_a_valid_workshop_payload_before_it_can_route_to_workshop(studio):
    service,user,registry,intake,*_=studio
    source=intake.inbox/intake.owner_scope(OWNER)/'wrong-source'
    write_source(source,release_id='wrong-source')
    with pytest.raises(StudioError,match='DIRECTORY_CLIENT_NAMESPACE_INVALID'):
        intake.ingest(OWNER,'wrong-source')


async def test_configure_uses_persisted_studio_admin_and_keeps_local_trust_disabled(tmp_path):
    root=tmp_path/'server';root.mkdir()
    target=root/'deployment-expert-target.json'
    target.write_text(json.dumps({'schemaVersion':1,'enabled':True,'profile':'wanx-expert-app-v1','boxId':'synthetic-box','authorityMode':'sso'}));target.chmod(0o600)
    user=SimpleNamespace(id=7,role='admin',disabled=False,local_data=False)
    services=SimpleNamespace(user_repo=SimpleNamespace(get=lambda uid:user if uid==7 else None))
    server=SimpleNamespace(paths=SimpleNamespace(root=root),services=services,app_runtime=SimpleNamespace(agent_registry=object(),gateway=object()),expert_catalog=None,user_manager=SimpleNamespace(get_by_id=lambda uid:user))
    service=StudioService(root/'.wanx-app-studio',ROOT)
    service.local_authority=SimpleNamespace(required=lambda:False)
    service.team=SimpleNamespace(is_admin=lambda owner:user.role=='admin' and not user.disabled)
    profile=configure(service,services,root/'deployment-target.json',server=server,source='studio')
    try:
        assert not profile.miniapp.available and profile.expert.available
        assert profile.expert.runtime_namespace=='studio'
        profile.expert.authorize_owner(OWNER)
        user.role='user'
        with pytest.raises(Blocked,match='DEPLOYMENT_TARGET_DENIED'):profile.expert.authorize_owner(OWNER)
        with pytest.raises(StudioError,match='EXPERT_IDENTITY_REQUIRED'):service.expert_runtime._user(OWNER)
    finally:
        await service.close();server._wanx_deployment_source_registry.close()
    second=StudioService(root/'.wanx-app-studio',ROOT)
    second.local_authority=SimpleNamespace(required=lambda:True)
    try:
        configured=configure(second,services,root/'deployment-target.json',server=server,source='studio')
        assert not configured.expert.available and second.expert_runtime is None
    finally:await second.close()


async def test_real_wanx_mount_keeps_managed_audience_out_of_editor_and_directory_management(tmp_path,monkeypatch):
    from octop.api.deps import current_user
    from wanx_studio.wanx import mount_wanx
    monkeypatch.setattr('wanx_studio.wanx.WanxModels',lambda services:None)
    root=tmp_path/'server';root.mkdir()
    (root/'deployment-expert-target.json').write_text(json.dumps({'schemaVersion':1,'enabled':True,'profile':'wanx-expert-app-v1','boxId':'synthetic-box','authorityMode':'sso'}))
    user=SimpleNamespace(id=7,role='admin',disabled=False,application_id='wanx',local_data=False)
    server=SimpleNamespace(paths=SimpleNamespace(root=root),services=SimpleNamespace(user_repo=SimpleNamespace(get=lambda uid:user if uid==7 else None)),
        user_manager=SimpleNamespace(get_by_id=lambda uid:user),app_runtime=SimpleNamespace(agent_registry=object(),gateway=object()),expert_catalog=None)
    app=FastAPI();app.dependency_overrides[current_user]=lambda:user
    service=mount_wanx(app,server,ROOT)
    slot='ai.wanx.selfmade.'+'a'*32;other='ai.wanx.selfmade.'+'b'*32
    session={'owner':OWNER,'app':slot,'project':'synthetic','artifact':'a'*64,'environment':'preview','expires':10**12,
        'manifest':{'capabilities':['data'],'collections':{'notes':{'text':'string'}}}}
    service.runtime_sessions.update(own=session,foreign={**session,'app':other},otherOwner={**session,'owner':'wanx:8'})
    try:
        async with AsyncClient(transport=ASGITransport(app=app),base_url='http://test') as client:
            assert (await client.get('/api/app-studio/context')).json()['mode']=='wanx'
            assert (await client.get('/api/app-studio/deployment/directory-releases')).json()['available'] is True
            user.application_id=slot
            for path in ('/context','/projects','/deployment/directory-releases'):
                assert (await client.get('/api/app-studio'+path)).status_code==403
            assert (await client.post('/api/app-studio/deployment/directory-releases/release/prepare',json={})).status_code==403
            body={'method':'data.list','params':{'collection':'notes'}}
            response=await client.post('/api/app-studio/runtime/own/invoke',json=body)
            assert response.status_code==200,response.text
            for token in ('foreign','otherOwner'):
                assert (await client.post(f'/api/app-studio/runtime/{token}/invoke',json=body)).status_code==403
            user.application_id='wanx';user.role='user'
            assert (await client.get('/api/app-studio/deployment/directory-releases')).status_code==403
            user.role='admin';user.disabled=True
            assert (await client.get('/api/app-studio/deployment/directory-releases')).status_code==403
    finally:
        await service.close();server._wanx_deployment_source_registry.close()
