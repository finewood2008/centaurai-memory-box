"""Frozen expert configuration survives transfer without importing runtime authority."""
import asyncio
from copy import deepcopy
from uuid import uuid4
from pathlib import Path

import pytest

from test_standard_artifacts import standard
from wanx_studio.contracts import StudioError


@pytest.mark.parametrize('standard',['expert'],indirect=True)
async def test_verified_expert_transfer_can_be_adopted_and_edited_under_current_owner(standard,monkeypatch):
    svc,p=standard
    from wanx_studio.runner import Runner
    svc.runner=Runner(svc)
    original=deepcopy(svc.store.get('alice',p['id'])['artifacts'][-1])
    svc.versions.adopt('alice',p['id'],{'operationId':uuid4().hex,'expectedRevision':p['versioning']['revision'],'artifactHash':original['hash'],'confirmedByUser':True})
    bundle=svc.export_standard_version('alice',p['id'],original['hash'])
    frozen=original['snapshot']['contracts']['foundation']['expertDeployment']
    # These editable/export-side assertions are not the frozen source contract.
    bundle['project']['deploymentExpert']={'profile':'wanx-expert-app-v1','revision':999,'template':{'resourceId':'other'}}
    bundle['project']['expertBinding']={'agentId':'foreign','owner':'alice'}
    operation=uuid4().hex
    imported=svc.import_standard_version('bob',bundle,operation)
    again=svc.import_standard_version('bob',bundle,operation)
    assert again['id']==imported['id']
    current=svc.store.get('bob',imported['id'])
    assert current['deploymentExpert']==frozen
    assert current['_deploymentExpertRevision']==frozen['revision']
    assert 'expertBinding' not in current
    assert current['versioning']['adoptedHash'] is None
    assert current['artifacts']==[original]
    adopted=svc.versions.adopt('bob',imported['id'],{'operationId':uuid4().hex,'expectedRevision':current['versioning']['revision'],'artifactHash':original['hash'],'confirmedByUser':True})
    observed=[]
    async def analyse(owner,pid,eid):
        value=await svc.edits.tool(owner,pid,eid,'read_project',{})
        observed.append((owner,value['buildProposal']['contract']['expertContractDigest']))
        await svc.edits.tool(owner,pid,eid,'update_prd',{'expectedHash':value['expectedHash'],'summary':{'workflow':'输入文本后查看回答','outputs':'显示专家回答'},'upsert':[{'section':'tests','value':{'title':'界面标题','given':'打开应用','when':'查看页面','then':'显示新标题'}}]})
        current=await svc.edits.tool(owner,pid,eid,'read_project',{})
        await svc.edits.tool(owner,pid,eid,'finish_edit',{'outcome':'ready','summary':'更新界面标题','runtimeIntent':{'solutionHash':current['expectedHash'],'capabilities':current['solution']['capabilities'],'execution':'managed-expert'}})
    from wanx_studio import devkit_build
    from wanx_studio.versions import next_version,verify
    probes=[]
    async def probe(owner,pid,cap):probes.append((owner,cap));return {'status':'passed'}
    async def preflight(**_):return {'available':True}
    async def execute(owner,q,tid,instruction):
        workspace=devkit_build.create_workspace(q,svc.project_root,svc.store.root/'tasks'/tid,version=next_version(q))
        current=svc.store.get(owner,q['id']);task=next(t for t in current['tasks'] if t['id']==tid)
        task.update(devKitWorkspace=workspace['root'],devKitSpecHash=workspace['specHash']);svc.store.save(current)
        files=devkit_build.mutable_files(Path(workspace['root']));files['app/host.mjs']+='\n// synthetic imported direct edit\n'
        await svc.add_artifact(owner,q['id'],tid,files)
    monkeypatch.setattr(svc.preparation,'probe_runtime',probe)
    monkeypatch.setattr(svc.runner,'preflight',preflight)
    monkeypatch.setattr(svc.runner,'execute',execute)
    monkeypatch.setattr(svc.edits,'analyse',analyse)
    await svc.edits.submit('bob',imported['id'],{'operationId':uuid4().hex,'expectedRevision':adopted['versioning']['revision'],'baseHash':original['hash'],'text':'检查当前界面','contextId':'synthetic-transfer'})
    for _ in range(1000):
        result=svc.edits.result('bob',imported['id'])
        if not svc.edits.jobs:break
        await asyncio.sleep(.01)
    assert observed==[('bob',original['expertContractDigest'])]
    assert result['items'][0]['state']=='completed',result['items'][0].get('error')
    updated=svc.store.get('bob',imported['id'])
    assert len(updated['artifacts'])==2 and updated['artifacts'][0]==original
    verify(updated['artifacts'][-1])
    assert updated['artifacts'][-1]['expertContractDigest']==original['expertContractDigest']
    assert probes and all(owner=='bob' for owner,_ in probes)
    # Configuration preservation cannot bypass current management authorization.
    def denied(_owner):raise StudioError('STUDIO_ADMIN_REQUIRED',403)
    monkeypatch.setattr(svc,'authorize_management',denied)
    with pytest.raises(StudioError,match='STUDIO_ADMIN_REQUIRED'):
        svc.edits.get('bob',imported['id'])


@pytest.mark.parametrize('standard',[None,'expert'],indirect=True)
async def test_transferred_standard_preparation_http_routes_keep_complete_state_and_require_current_checks(standard,monkeypatch):
    from fastapi import FastAPI
    from fastapi.responses import JSONResponse
    from httpx import ASGITransport,AsyncClient
    from wanx_studio.api import create_router
    from wanx_studio.runner import Runner
    svc,p=standard;svc.runner=Runner(svc)
    original=deepcopy(svc.store.get('alice',p['id'])['artifacts'][-1])
    svc.versions.adopt('alice',p['id'],{'operationId':uuid4().hex,'expectedRevision':p['versioning']['revision'],'artifactHash':original['hash'],'confirmedByUser':True})
    imported=svc.import_standard_version('bob',svc.export_standard_version('alice',p['id'],original['hash']),uuid4().hex)
    app=FastAPI()
    @app.exception_handler(StudioError)
    async def failure(request,error):return JSONResponse({'code':error.code},status_code=error.status)
    app.include_router(create_router(svc,lambda:'bob'))
    root='/api/app-studio/projects/'+imported['id']
    probed=[]
    async def probe(owner,pid,cap):probed.append((owner,pid,cap));return {'status':'passed'}
    async def preflight(**kwargs):assert kwargs['owner']=='bob';return {'available':True}
    monkeypatch.setattr(svc.preparation,'probe_runtime',probe)
    monkeypatch.setattr(svc.runner,'preflight',preflight)
    async with AsyncClient(transport=ASGITransport(app=app,raise_app_exceptions=False),base_url='http://test') as client:
        intake=await client.get(root+'/intake');assert intake.status_code==200
        state=intake.json()
        assert {'version','brief','messages','events','contextRevision','entryIds','provenance'}<=state.keys()
        assert state['report'] is None
        assert state['handoff']['report']['codex']['available'] is False
        assert state['handoff']['report']['operationId'] is None
        events=await client.get(root+'/intake/events');assert events.status_code==200
        assert events.json()=={'items':[],'nextCursor':0,'hasMore':False}
        context=await client.get(root+'/context');assert context.status_code==200
        assert context.json()=={'references':[],'revision':0}
        capabilities=await client.get(root+'/capabilities');assert capabilities.status_code==200
        assert capabilities.json()['valid'] is False
        handoff=await client.post(root+'/intake/handoff',json={'operationId':uuid4().hex,'expectedRevision':state['revision']})
        assert handoff.status_code==409 and handoff.json()['code']=='CAPABILITY_CHECK_REQUIRED'
        from types import SimpleNamespace
        denied_refs=[]
        async def metadata(owner,kind,ref):
            denied_refs.append((owner,kind,ref));raise StudioError('CONTEXT_PERMISSION_DENIED',403)
        monkeypatch.setattr(svc,'context_provider',SimpleNamespace(metadata=metadata),raising=False)
        denied=await client.put(root+'/context',json={'operationId':uuid4().hex,'expectedRevision':0,'references':[{'kind':'space','id':'other-owner-document'}]})
        assert denied.status_code==403 and denied_refs==[('bob','space','other-owner-document')]
        assert (await client.get(root+'/context')).json()=={'references':[],'revision':0}
        monkeypatch.setattr(svc,'context_provider',None)
        changed=await client.put(root+'/context',json={'operationId':uuid4().hex,'expectedRevision':0,'references':[]})
        assert changed.status_code==200,changed.text
        assert (await client.get(root+'/context')).json()['revision']==1
        stale=await client.put(root+'/context',json={'operationId':uuid4().hex,'expectedRevision':0,'references':[]})
        assert stale.status_code==409 and stale.json()['code']=='CONTEXT_CHANGED'
        check_id=uuid4().hex
        checked=await client.post(root+'/capabilities/check',json={'operationId':check_id})
        assert checked.status_code==200,checked.text
        assert (await client.get(root+'/capabilities')).json()['valid'] is True
        state=(await client.get(root+'/intake')).json()
        handed=await client.post(root+'/intake/handoff',json={'operationId':uuid4().hex,'expectedRevision':state['revision']})
        assert handed.status_code==200,handed.text
        current=(await client.get(root+'/intake')).json()
        assert current['handoff']['report']['operationId']==check_id
        assert current['report']['operationId']==check_id
        before=(await client.get(root+'/intake/events')).json()
        assert before['items'][-1]['type']=='intake.handed-off'
        repeated=await client.post(root+'/intake/handoff',json={'operationId':uuid4().hex,'expectedRevision':current['revision']})
        assert repeated.status_code==200
        assert (await client.get(root+'/intake/events')).json()==before
    assert all(owner=='bob' and pid==imported['id'] for owner,pid,_ in probed)
    assert svc.store.get('bob',imported['id'])['artifacts']==[original]
