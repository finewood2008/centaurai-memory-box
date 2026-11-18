"""Standard layout preview uses the immutable ZIP and admits no business RPC."""
from copy import deepcopy
import subprocess
import pytest
from test_standard_artifacts import standard
from test_workshop import workshop
from wanx_studio.contracts import StudioError

async def test_actual_standard_package_opens_explicit_layout_without_changing_version(standard):
 svc,p=standard;a=deepcopy(svc.store.get('alice',p['id'])['artifacts'][-1])
 result=svc.open_runtime('alice',p['id'],a['hash'],'preview')
 assert result['standardLayout']['format']=='wanx-standard-layout-v1'
 assert result['standardLayout']['artifactHash']==a['hash']
 assert result['standardLayout']['packageSha256']==a['packageSha256']
 assert '<html' in result['standardLayout']['document'].lower()
 assert result['packageBase64']==a['devKitPackage']['packageBase64']
 assert 'bundle' not in result and 'css' not in result
 assert svc.store.get('alice',p['id'])['artifacts'][-1]==a
 assert svc.store.get('alice',p['id'])['versioning']['adoptedHash'] is None

async def test_standard_preview_rejects_tampered_package_before_lease(standard):
 svc,p=standard;q=svc.store.get('alice',p['id']);a=q['artifacts'][-1]
 a['devKitPackage']['packageBase64']='Y2hhbmdlZA==';svc.store.save(q)
 before=deepcopy(svc.runtime_sessions)
 with pytest.raises(StudioError,match='ARTIFACT_INTEGRITY_FAILED'):
  svc.open_runtime('alice',p['id'],a['hash'],'preview')
 assert svc.runtime_sessions==before

async def test_standard_preview_compile_failure_leaves_no_runtime_lease(standard,monkeypatch):
 svc,p=standard;before=deepcopy(svc.runtime_sessions);calls=[]
 def timeout(*args,**kwargs):calls.append(args);raise subprocess.TimeoutExpired('synthetic compiler',15)
 monkeypatch.setattr(subprocess,'run',timeout)
 with pytest.raises(StudioError,match='STANDARD_PREVIEW_UNAVAILABLE'):
  svc.open_runtime('alice',p['id'],p['artifacts'][-1]['hash'],'preview')
 assert svc.runtime_sessions==before
 assert len(calls)==1

async def test_layout_only_session_rejects_generic_business_and_can_close(standard):
 from fastapi import FastAPI
 from httpx import ASGITransport,AsyncClient
 from wanx_studio.api import create_router
 svc,p=standard;result=svc.open_runtime('alice',p['id'],p['artifacts'][-1]['hash'],'preview');token=result['session']
 calls=[]
 async def model(*_):calls.append('model');raise AssertionError('layout preview must not execute business')
 svc.model=model
 for method,params in [('data.list',{'collection':'state'}),('model.generate',{'prompt':'synthetic'}),('foundation.invoke',{'operation':'expert.run','input':{'operationId':'a'*32,'text':'synthetic'}}),('knowledge.search',{}),('reports.context',{}),('files.read',{'id':'synthetic'})]:
  with pytest.raises(StudioError,match='EXPERT_DEPLOYMENT_REQUIRED'):await svc.invoke('alice',token,method,params)
 with pytest.raises(StudioError,match='EXPERT_DEPLOYMENT_REQUIRED'):await svc.select_files('alice',token,[])
 with pytest.raises(StudioError,match='EXPERT_DEPLOYMENT_REQUIRED'):svc.runtime('alice',token)
 from wanx_studio.foundation_runtime import native_operation
 with pytest.raises(StudioError,match='EXPERT_DEPLOYMENT_REQUIRED'):native_operation(svc,'alice',token,{'operation':'haowen.context','input':{}})
 app=FastAPI();app.include_router(create_router(svc,lambda:'alice'))
 async with AsyncClient(transport=ASGITransport(app=app),base_url='http://test') as client:
  revoked=await client.delete('/api/app-studio/runtime/'+token)
 assert revoked.status_code==200 and token not in svc.runtime_sessions and calls==[]


async def test_layout_close_preserves_owner_and_expiry_checks(standard):
 svc,p=standard;value=svc.open_runtime('alice',p['id'],p['artifacts'][-1]['hash'],'preview');token=value['session']
 with pytest.raises(StudioError,match='RUNTIME_SESSION_EXPIRED'):svc.close_runtime('alice','unknown-layout-token')
 with pytest.raises(StudioError,match='RUNTIME_SESSION_EXPIRED'):svc.close_runtime('bob',token)
 assert token in svc.runtime_sessions
 svc.runtime_sessions[token]['expires']=0
 with pytest.raises(StudioError,match='RUNTIME_SESSION_EXPIRED'):svc.close_runtime('alice',token)
 assert token in svc.runtime_sessions

async def test_standard_production_runtime_retains_zip_contract(standard):
 from uuid import uuid4
 svc,p=standard;a=svc.store.get('alice',p['id'])['artifacts'][-1]
 svc.versions.adopt('alice',p['id'],{'operationId':uuid4().hex,'expectedRevision':p['versioning']['revision'],'artifactHash':a['hash'],'confirmedByUser':True})
 svc.installed('alice',p['id'],{'operationId':uuid4().hex,'artifactHash':a['hash'],'applicationId':a['manifest']['applicationId'],'version':a['version']})
 value=svc.open_runtime('alice',p['id'],a['hash'],'production')
 assert value['packageBase64']==a['devKitPackage']['packageBase64']
 assert 'standardLayout' not in value and 'layoutOnly' not in svc.runtime_sessions[value['session']]
 svc.close_runtime('alice',value['session'])


async def test_legacy_workshop_delete_keeps_dynamic_actor_check(workshop,monkeypatch):
 from fastapi import FastAPI
 from httpx import ASGITransport,AsyncClient
 from wanx_studio.api import create_router
 from test_studio import seeded
 p=await seeded(workshop);token=workshop.open_runtime('alice',p['id'],p['artifacts'][-1]['hash'],'preview')['session']
 original=workshop.authorize_management;calls=[]
 def checked(owner):calls.append(owner);return original(owner)
 monkeypatch.setattr(workshop,'authorize_management',checked)
 app=FastAPI();app.include_router(create_router(workshop,lambda:'alice'))
 async with AsyncClient(transport=ASGITransport(app=app),base_url='http://test') as client:
  response=await client.delete('/api/app-studio/runtime/'+token)
 assert response.status_code==200 and token not in workshop.runtime_sessions and calls==['alice']
 token=workshop.open_runtime('alice',p['id'],p['artifacts'][-1]['hash'],'preview')['session']
 workshop.actor_check=lambda *_:None
 with pytest.raises(StudioError,match='WORKSHOP_IDENTITY_REQUIRED'):workshop.close_runtime('alice',token)
 assert token in workshop.runtime_sessions
