"""Standard Host iteration seams, using real generated/packaged immutable versions."""
import asyncio
from copy import deepcopy
from pathlib import Path
from uuid import uuid4
import pytest
from test_standard_artifacts import standard
from wanx_studio import devkit_build
from wanx_studio.contracts import StudioError,digest
from wanx_studio.versions import next_version,verify

@pytest.mark.parametrize('standard',['expert'],indirect=True)
@pytest.mark.parametrize('legacy_checkpoint',[False,True])
async def test_real_standard_artifact_has_readable_public_proposal(standard,legacy_checkpoint):
 from fastapi import FastAPI
 from httpx import ASGITransport,AsyncClient
 from wanx_studio.api import create_router
 svc,p=standard;app=FastAPI();app.include_router(create_router(svc,lambda:'alice'))
 if legacy_checkpoint:
  q=svc.store.get('alice',p['id']);a=q['artifacts'][-1]
  a['checkpoint']={'schemaVersion':1,'artifactHash':a['hash'],'contract':{'collections':{'legacy_requests':{'text':'string'}},'capabilities':['data','foundation'],'visibility':'application-access'}}
  a['checkpointHash']=digest(a['checkpoint']);verify(a);svc.store.save(q)
 async with AsyncClient(transport=ASGITransport(app=app),base_url='http://test') as client:
  response=await client.get('/api/app-studio/_builder/projects/'+p['id']+'/proposal')
 assert response.status_code==200
 value=response.json()
 assert value['contract']['format']=='wanx-app-dev-kit'
 assert value['contract']['hostCapabilities']==['identity.read','http.request']
 assert value['contract']['backendContracts']==p['artifacts'][-1]['manifest']['compatibility']['backendContracts']
 assert 'collections' not in value['contract']
 assert value['previousContract']==value['contract']

@pytest.mark.parametrize('standard',['expert'],indirect=True)
@pytest.mark.parametrize('reduce_capabilities',[False,True])
async def test_real_standard_direct_edit_builds_next_immutable_package(standard,monkeypatch,reduce_capabilities):
 from wanx_studio.runner import Runner
 import threading
 from wanx_studio import devkit
 main_thread=threading.get_ident();report=devkit.compatibility_report
 def threaded_report(*args):
  assert threading.get_ident()!=main_thread, 'Project reads must not block the event loop with generator work'
  return report(*args)
 monkeypatch.setattr(devkit,'compatibility_report',threaded_report)
 svc,p=standard;svc.runner=Runner(svc);baseline=deepcopy(svc.store.get('alice',p['id'])['artifacts'][-1])
 async def probe(*_):return {'status':'passed'}
 async def preflight(**_):return {'available':True}
 async def analyse(owner,pid,eid):
  r=await svc.edits.tool(owner,pid,eid,'read_project',{})
  assert r['buildProposal']['contract']['format']=='wanx-app-dev-kit'
  assert 'expertContext' in r['standardInstruction'] and 'expertInvoke' in r['standardInstruction']
  with pytest.raises(StudioError,match='STANDARD_CONTRACT_FIXED'):
   await svc.edits.tool(owner,pid,eid,'propose_contract',{'expectedHash':r['expectedHash'],'collections':{'arbitrary':{'field':'string'}}})
  await svc.edits.tool(owner,pid,eid,'update_prd',{'expectedHash':r['expectedHash'],'summary':{'workflow':'输入文本后查看回答','outputs':'显示专家回答'},'upsert':[{'section':'tests','value':{'title':'界面标题','given':'打开应用','when':'查看页面','then':'显示新标题'}}]})
  current=await svc.edits.tool(owner,pid,eid,'read_project',{})
  if reduce_capabilities:
   await svc.edits.tool(owner,pid,eid,'update_prd',{'expectedHash':current['expectedHash'],'capabilities':[]})
   current=await svc.edits.tool(owner,pid,eid,'read_project',{})
  await svc.edits.tool(owner,pid,eid,'finish_edit',{'outcome':'ready','summary':'修改界面标题','runtimeIntent':{'solutionHash':current['expectedHash'],'capabilities':current['solution']['capabilities'],'execution':'managed-expert'}})
 async def execute(owner,q,tid,instruction):
  workspace=devkit_build.create_workspace(q,svc.project_root,svc.store.root/'tasks'/tid,version=next_version(q))
  current=svc.store.get(owner,q['id']);task=next(t for t in current['tasks'] if t['id']==tid)
  task.update(devKitWorkspace=workspace['root'],devKitSpecHash=workspace['specHash']);svc.store.save(current)
  files=devkit_build.mutable_files(Path(workspace['root']));files['app/host.mjs']+='\n// synthetic direct edit\n'
  await svc.add_artifact(owner,q['id'],tid,files)
 monkeypatch.setattr(svc.preparation,'probe_runtime',probe)
 monkeypatch.setattr(svc.runner,'preflight',preflight)
 monkeypatch.setattr(svc.edits,'analyse',analyse)
 monkeypatch.setattr(svc.runner,'execute',execute)
 request={'operationId':uuid4().hex,'expectedRevision':p['versioning']['revision'],'baseHash':baseline['hash'],'text':'修改界面标题','contextId':'synthetic-test'}
 await svc.edits.submit('alice',p['id'],request)
 for _ in range(500):
  result=svc.edits.result('alice',p['id'])
  if result['items'][0]['state'] in {'completed','failed','interrupted','clarifying'} and not svc.edits.jobs:break
  await asyncio.sleep(.01)
 assert result['items'][0]['state']=='completed',result['items'][0]
 q=svc.store.get('alice',p['id']);assert len(q['artifacts'])==2
 assert q['artifacts'][0]==baseline
 a=q['artifacts'][-1];verify(a)
 assert a['version']=='0.1.1' and a['manifest']['version']=='0.1.1'
 assert a['manifest']['capabilities']==baseline['manifest']['capabilities']
 assert a['manifest']['compatibility']==baseline['manifest']['compatibility']
 assert a['expertContractDigest']==baseline['expertContractDigest']
 assert a['snapshot']['solution']['outputs']=='显示专家回答'
 assert a['snapshot']['solution']['capabilities']==([] if reduce_capabilities else ['wanx.expert-app.v1'])
 assert a['checkpoint']['contract']['format']=='wanx-app-dev-kit'
 assert 'collections' not in a['manifest']


@pytest.mark.parametrize('standard',['expert'],indirect=True)
async def test_standard_contract_proposal_cannot_add_legacy_collections(standard):
 from wanx_studio.iterative import propose_contract
 svc,p=standard;before=deepcopy(svc.store.get('alice',p['id']))
 with pytest.raises(StudioError,match='STANDARD_CONTRACT_FIXED'):
  propose_contract(svc,'alice',p['id'],{'expectedHash':digest(before['solution']),'collections':{'arbitrary':{'field':'string'}}})
 assert svc.store.get('alice',p['id'])==before


@pytest.mark.parametrize('standard',['expert'],indirect=True)
async def test_standard_direct_edit_cannot_replace_frozen_expert_contract(standard,monkeypatch):
 from wanx_studio.runner import Runner
 svc,p=standard;svc.runner=Runner(svc)
 q=svc.store.get('alice',p['id']);q['deploymentExpert']['revision']+=1
 q['deploymentExpert']['template']['digest']='sha256:'+'b'*64
 q['preparation']['handoff']['contracts']['wanx.expert-app.v1']['expertDeployment']=deepcopy(q['deploymentExpert'])
 svc.store.save(q)
 async def no_model(owner,pid,eid):
  await svc.edits.tool(owner,pid,eid,'finish_edit',{'outcome':'no_change','summary':'Synthetic no model'})
 monkeypatch.setattr(svc.edits,'analyse',no_model)
 request={'operationId':uuid4().hex,'expectedRevision':p['versioning']['revision'],'baseHash':p['artifacts'][-1]['hash'],'text':'修改界面标题','contextId':'synthetic-test'}
 with pytest.raises(StudioError,match='STANDARD_CONTRACT_CHANGED'):
  await svc.edits.submit('alice',p['id'],request)
