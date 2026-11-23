from copy import deepcopy
import pytest
from wanx_studio.contracts import StudioError,digest
from wanx_studio.prd import PRD_REVIEW_SECTIONS
from standard_build_fixture import historical_records, workspace_files
from test_studio import svc,seeded,op


def adopt(svc,p):
    return svc.versions.adopt('alice',p['id'],{'operationId':op(),'expectedRevision':p['versioning']['revision'],'artifactHash':p['artifacts'][-1]['hash'],'confirmedByUser':True})

async def candidate(svc,p,files=None,owner='alice'):
    task_id=op()
    def change(q):
        it=svc.versions.task(q,'只调整界面')
        q['tasks'].append({
            'id': task_id, 'state': 'running', 'solutionHash': digest(q['solution']),
            'buildInput': q['confirmation']['buildInput'], 'baseHash': it['baseHash'],
            'iterationId': it['id'], 'instruction': '只调整界面', 'events': [], 'question': None,
        })
    svc.store.mutate(owner,p['id'],op(),{},change)
    project = svc.store.get(owner, p['id'])
    baseline = workspace_files(svc, owner, project, task_id)
    return await svc.add_artifact(owner, p['id'], task_id, baseline if files is None else files)

async def test_compiled_launch_archive_receives_private_files_not_public_summary(svc):
    from wanx_studio.client_launch import ClientLaunch
    p=await seeded(svc)
    source=svc.store.get('alice',p['id'])['artifacts'][-1]['files']
    seen=[]
    class Context:
        async def launch_archive(self,owner,pid,storage,artifact):
            assert artifact['files']==source
            seen.append(artifact['hash'])
            return {'state':'saved','id':'archive-fixture'}
    svc.context_provider=Context()
    svc.client_launch=ClientLaunch(svc)
    def configure(q):
        from wanx_studio.preparation import initial
        q['preparation']={**initial(q),'handoff':{},'launchConfiguration':{'storage':{'folderId':'folder-fixture'}}}
    svc.store.mutate('alice',p['id'],op(),{},configure)
    # Exercise compilation and public snapshot redaction, not just archive() in isolation.
    p=await candidate(svc,p)
    artifact=svc.store.get('alice',p['id'])['artifacts'][-1]
    assert seen==[artifact['hash']]
    assert svc.store.get('alice',p['id'])['preparation']['storageReceipts'][artifact['hash']]['state']=='saved'
    assert 'files' not in p['artifacts'][-1]

def begin(svc,p,h=None):
    return svc.versions.iteration('alice',p['id'],{'operationId':op(),'expectedRevision':p['versioning']['revision'],'action':'begin','baseHash':h,'goal':'调整布局'})

async def test_adopted_version_survives_draft_and_failed_improvement(svc):
    p=adopt(svc,await seeded(svc));h=p['versioning']['adoptedHash'];frozen=svc.versions.read('alice',p['id'],h)['snapshot']
    p=begin(svc,p)
    p=svc.update_solution('alice',p['id'],{'operationId':op(),'expectedHash':p['solutionHash'],'solution':{**p['solution'],'outputs':'新的输出'}})
    assert svc.install_payload('alice',p['id'],h)['artifactHash']==h
    assert svc.versions.read('alice',p['id'],h)['snapshot']==frozen
    assert p['versioning']['adoptedHash']==h
    # Failed work and abandonment retain frozen version and new draft.
    svc.store.mutate('alice',p['id'],op(),{},lambda q:q['tasks'].append({'id':'failed','state':'failed','solutionHash':digest(q['solution'])}))
    p=svc.versions.iteration('alice',p['id'],{'operationId':op(),'expectedRevision':p['versioning']['revision'],'action':'abandon'})
    assert p['versioning']['iteration'] is None and p['solution']['outputs']=='新的输出'
    assert svc.install_payload('alice',p['id'],h)['artifactHash']==h

async def test_explicit_historical_baseline_and_retry_do_not_use_latest_unrelated_source(svc):
    p=adopt(svc,await seeded(svc));old=p['artifacts'][0]['hash'];p=begin(svc,p)
    files=deepcopy(svc.store.get('alice',p['id'])['artifacts'][0]['files']);files['app/host.mjs']+='\n// second version\n'
    p=adopt(svc,await candidate(svc,p,files));p=begin(svc,p,old)
    # Actual Runner reads the selected old files, not last artifact.
    task_id=op()
    def task(q):
        it=svc.versions.task(q,'new line');q['tasks'].append({'id':task_id,'state':'queued','baseHash':it['baseHash'],'iterationId':it['id'],'solutionHash':digest(q['solution'])})
    svc.store.mutate('alice',p['id'],op(),{},task);q=svc.store.get('alice',p['id'])
    assert '// second version' not in svc.runner.source_files('alice',q,task_id)['app/host.mjs']
    assert q['tasks'][-1]['baseHash']==old

async def test_restore_reuses_package_and_preserves_existing_data_and_unknown_fields(svc):
    p = adopt(svc, await seeded(svc))
    first = p['artifacts'][0]
    p = adopt(svc, await candidate(svc, begin(svc, p)))
    scope = historical_records(p, priority='string')
    row = svc.data(scope, 'data.put', {'collection': 'items', 'value': {'title': '当前数据', 'priority': '高'}})
    check = svc.versions.restore_check('alice', p['id'], first['hash'])
    body = {**check, 'operationId': op(), 'confirmedByUser': True}
    restored = svc.versions.restore('alice', p['id'], body)
    again = svc.versions.restore('alice', p['id'], body)
    assert again['versioning'] == restored['versioning']
    assert restored['artifacts'] == p['artifacts']
    assert restored['versioning']['adoptedHash'] == first['hash']
    assert svc.install_payload('alice', p['id'], first['hash'])['version'] == first['version']
    svc.data(historical_records(p), 'data.put', {'collection': 'items', 'id': row['_id'],
                                               'expectedRevision': 1, 'value': {'title': '旧版修改'}})
    latest = svc.data(scope, 'data.get', {'collection': 'items', 'id': row['_id']})
    assert latest['priority'] == '高' and latest['title'] == '旧版修改'

async def test_restore_and_adopt_checks_fence_stale_permission_integrity_and_busy(svc,monkeypatch):
    p=adopt(svc,await seeded(svc));old=p['artifacts'][0]['hash'];p=begin(svc,p)
    assert svc.versions.restore_check('alice',p['id'],old)['artifactHash']==old
    p=adopt(svc,await candidate(svc,p));check=svc.versions.restore_check('alice',p['id'],old)
    svc.versions.feedback('alice',p['id'],{'operationId':op(),'expectedRevision':check['expectedRevision'],'text':'新的意见'})
    with pytest.raises(StudioError,match='VERSION_CHANGED'):svc.versions.restore('alice',p['id'],{'operationId':op(),'expectedRevision':check['expectedRevision'],'checkHash':check['checkHash'],'artifactHash':old,'confirmedByUser':True})
    with pytest.raises(StudioError,match='PROJECT_NOT_FOUND'):svc.versions.read('bob',p['id'],old)
    def revoked(*_a,**_k):raise StudioError('CAPABILITY_CHECK_REQUIRED',409)
    monkeypatch.setattr(svc,'authorize_version',revoked)
    with pytest.raises(StudioError,match='CAPABILITY_CHECK_REQUIRED'):svc.versions.restore_check('alice',p['id'],old)
    monkeypatch.undo()
    svc.store.mutate('alice',p['id'],op(),{},lambda q:q['artifacts'][0]['files'].update({'app/host.mjs':'tampered'}))
    with pytest.raises(StudioError,match='ARTIFACT_INTEGRITY_FAILED'):svc.versions.restore_check('alice',p['id'],old)

async def test_complete_unadopted_version_can_restore_but_cannot_export_until_adopted(svc):
    p=await seeded(svc);h=p['artifacts'][0]['hash']
    with pytest.raises(StudioError,match='USER_ACCEPTANCE_REQUIRED'):svc.install_payload('alice',p['id'],h)
    assert svc.versions.restore_check('alice',p['id'],h)['artifactHash']==h
    def incomplete(q):
        q['artifacts'][0].pop('snapshot');q['revisions']=[];q['solution']['outputs']='different'
    svc.store.mutate('alice',p['id'],op(),{},incomplete)
    assert not svc.versions.read('alice',p['id'],h)['snapshotAvailable']
    with pytest.raises(StudioError,match='VERSION_SNAPSHOT_INCOMPLETE'):begin(svc,p,h)

async def test_saved_feedback_is_model_free_and_idempotent(svc):
    p=await seeded(svc);body={'operationId':op(),'expectedRevision':p['versioning']['revision'],'text':'希望更清楚'}
    a=svc.versions.feedback('alice',p['id'],body);b=svc.versions.feedback('alice',p['id'],body)
    assert a['versioning']==b['versioning'] and svc.used('alice',p['id'])==0
    body['text']='changed'
    with pytest.raises(StudioError,match='OPERATION_CONFLICT'):svc.versions.feedback('alice',p['id'],body)

async def test_choose_earlier_candidate_from_same_iteration_without_replacing_data(svc):
    p=begin(svc,await seeded(svc));p=await candidate(svc,p);first=p['artifacts'][-1]
    files=deepcopy(svc.store.get('alice',p['id'])['artifacts'][-1]['files']);files['app/host.mjs']+='\n// alternative layout\n'
    p=await candidate(svc,p,files);newest=p['artifacts'][-1]['hash']
    scope=historical_records(p)
    row=svc.data(scope,'data.put',{'collection':'items','value':{'title':'保留业务数据'}})
    body={'operationId':op(),'expectedRevision':p['versioning']['revision'],'artifactHash':first['hash'],'confirmedByUser':True}
    selected=svc.versions.adopt('alice',p['id'],body);again=svc.versions.adopt('alice',p['id'],body)
    assert selected['versioning']==again['versioning']
    assert selected['versioning']['adoptedHash']==first['hash']
    assert newest in [a['hash'] for a in selected['artifacts']]
    assert (svc.data(scope,'data.get',{'collection':'items','id':row['_id']}))['title']=='保留业务数据'
    assert svc.install_payload('alice',p['id'],first['hash'])['artifactHash']==first['hash']

async def test_earlier_candidate_requires_completed_task_but_not_current_draft(svc):
    p=begin(svc,await seeded(svc));p=await candidate(svc,p);first=p['artifacts'][-1];p=await candidate(svc,p)
    body={'operationId':op(),'expectedRevision':p['versioning']['revision'],'artifactHash':first['hash'],'confirmedByUser':True}
    def incomplete(q):next(t for t in q['tasks'] if t['id']==first['taskId'])['state']='failed'
    svc.store.mutate('alice',p['id'],op(),{},incomplete)
    with pytest.raises(StudioError,match='VERSION_CHANGED'):svc.versions.adopt('alice',p['id'],body)
    def completed(q):next(t for t in q['tasks'] if t['id']==first['taskId'])['state']='completed'
    svc.store.mutate('alice',p['id'],op(),{},completed)
    p=svc.update_solution('alice',p['id'],{'operationId':op(),'expectedHash':p['solutionHash'],'solution':{**p['solution'],'outputs':'新的范围'}})
    result=svc.versions.adopt('alice',p['id'],{**body,'operationId':op()})
    assert result['versioning']['adoptedHash']==first['hash']
    assert result['solution']['outputs']=='新的范围'

async def test_real_fixed_http_version_routes_validate_identity_user_action_and_shape(tmp_path):
    from httpx import ASGITransport,AsyncClient
    from wanx_studio.local import build_local
    app=build_local(tmp_path)
    try:
        async with AsyncClient(transport=ASGITransport(app=app),base_url='http://testserver') as c:
            assert (await c.get('/api/app-studio/projects')).status_code==401
            await c.get('/api/app-studio/session')
            p=await seeded(app.state.studio,'synthetic-local-user')
            pid=p['id']
            payload={'operationId':op(),'expectedRevision':p['versioning']['revision'],'artifactHash':p['artifacts'][0]['hash'],'confirmedByUser':False}
            assert (await c.post(f'/api/app-studio/projects/{pid}/adopt',json=payload)).status_code==422
            payload['confirmedByUser']=True
            a=await c.post(f'/api/app-studio/projects/{pid}/adopt',json={**payload,'owner':'someone'})
            assert a.status_code==422
            a=await c.post(f'/api/app-studio/projects/{pid}/adopt',json=payload);assert a.status_code==200
            assert a.json()['versioning']['adoptedHash']==payload['artifactHash']
            assert (await c.get(f'/api/app-studio/projects/{pid}/versions')).json()['versions'][0]['status']=='current'
            assert (await c.get(f'/api/app-studio/projects/{pid}/versions/{payload["artifactHash"]}')).json()['snapshot']['solution']==p['solution']
            assert (await c.get('/api/app-studio/projects/'+'f'*32+'/versions')).status_code==404
            assert (await c.post(f'/api/app-studio/projects/{pid}/restore-version',json={**payload,'expectedRevision':a.json()['versioning']['revision'],'checkHash':'a'*64})).status_code==409
    finally:await app.state.studio.close()

async def test_public_history_preserves_actual_iteration_membership_without_draft(svc):
    p=adopt(svc,await seeded(svc));p=begin(svc,p)
    p=await candidate(svc,p);iteration_id=p['versioning']['iteration']['id']
    assert p['versions'][0]['iterationId']==iteration_id
    assert p['tasks'][-1]['iterationId']==iteration_id
    assert svc.versions.read('alice',p['id'],p['versions'][0]['hash'])['iterationId']==iteration_id
    p=adopt(svc,p)
    assert p['versioning']['iterations'][-1]['id']==iteration_id
    assert 'draft' not in p['versioning']['iterations'][-1]

async def test_adoption_preserves_paused_messages_but_rejects_running_pm(svc):
    from wanx_studio.preparation import initial
    p=await seeded(svc)
    def pending(q):
        q['preparation']=initial(q)
        q['preparation']['interview'].update({'state':'failed','sync':'failed','turns':[{'id':'later','state':'paused','text':'补充修改'}]})
        q['confirmation']=None
    svc.store.mutate('alice',p['id'],op(),{},pending)
    p=svc.snapshot('alice',p['id'])
    result=adopt(svc,p)
    assert result['preparation']['interview']['turns'][0]['state']=='paused'
    svc.store.mutate('alice',p['id'],op(),{},lambda q:q['preparation']['interview'].update({'state':'running'}))
    with pytest.raises(StudioError,match='INTERVIEW_BUSY'):adopt(svc,result)

async def test_adoption_rechecks_current_management_authority(svc):
    p=await seeded(svc)
    class Team:
        def is_admin(self,owner):return False
    svc.team=Team()
    with pytest.raises(StudioError,match='STUDIO_ADMIN_REQUIRED'):adopt(svc,p)

async def test_restore_without_adoption_compares_latest_successful_preview(svc):
    p=await seeded(svc);old=p['artifacts'][0]['hash']
    files=deepcopy(svc.store.get('alice',p['id'])['artifacts'][0]['files'])
    files['app/host.mjs']+='\n// preview-only iteration\n'
    p=await candidate(svc,p,files);latest=p['artifacts'][-1]['hash']
    assert p['versioning']['adoptedHash'] is None
    before=svc.store.db.execute('select body from projects where id=?',(p['id'],)).fetchone()[0]
    check=svc.versions.restore_check('alice',p['id'],old)
    assert check['changes']=={'sections':[],'addedFields':[],'hiddenFields':[],'changedFields':[],'addedCapabilities':[],'removedCapabilities':[]}
    assert check['currentHash'] is None
    assert check['comparisonHash']==latest and check['comparisonVersion']==p['artifacts'][-1]['version']
    assert before==svc.store.db.execute('select body from projects where id=?',(p['id'],)).fetchone()[0]
    # Older clients omit the optional baseline; restore still preserves history.
    restored=svc.versions.restore('alice',p['id'],{'operationId':op(),'expectedRevision':check['expectedRevision'],'artifactHash':old,'checkHash':check['checkHash'],'confirmedByUser':True},trial=True)
    assert restored['artifacts']==p['artifacts'] and restored['versioning']['adoptedHash'] is None
    assert restored['versioning']['iteration']['baseHash']==old

async def test_restore_uses_selected_preview_and_binds_confirmation_to_it(svc):
    p=adopt(svc,await seeded(svc));old=p['artifacts'][0]['hash']
    # This later build has a declared external backend and its Host HTTP permission.
    svc.store.mutate('alice',p['id'],op(),{},lambda q:q.update(
        devKitBackend={'mode':'custom','deployment':'external','contractRef':'wanx.public.drive.v1'}))
    draft=deepcopy(p['solution']);draft['prd']['rules'].append('筛选清空后显示全部条目')
    p=svc.update_solution('alice',p['id'],{'operationId':op(),'expectedHash':p['solutionHash'],'solution':draft})
    svc.confirm('alice',p['id'],{'operationId':op(),'solutionHash':p['solutionHash'],'reviewedSections':PRD_REVIEW_SECTIONS})
    p=await candidate(svc,p);latest=p['artifacts'][-1]['hash']
    check=svc.versions.restore_check('alice',p['id'],old,latest)
    assert check['currentHash']==old and check['comparisonHash']==latest
    assert check['changes']['sections']==['规则与异常']
    assert check['changes']['removedCapabilities']==['http.request']
    assert svc.versions.restore_check('alice',p['id'],latest,old)['changes']['addedCapabilities']==['http.request']
    same=svc.versions.restore_check('alice',p['id'],old,old)
    assert same['changes']['sections']==[] and same['checkHash']!=check['checkHash']
    body={'operationId':op(),'expectedRevision':check['expectedRevision'],'artifactHash':old,'comparisonHash':old,'checkHash':check['checkHash'],'confirmedByUser':True}
    with pytest.raises(StudioError,match='VERSION_CHANGED'):svc.versions.restore('alice',p['id'],body,trial=True)
    assert len(svc.store.get('alice',p['id'])['artifacts'])==2
    with pytest.raises(StudioError,match='ARTIFACT_NOT_FOUND'):svc.versions.restore_check('alice',p['id'],old,'f'*64)
    # A present but unfinished baseline must not be treated as a successful preview.
    svc.store.mutate('alice',p['id'],op(),{},lambda q:q['tasks'][-1].update({'state':'failed'}))
    with pytest.raises(StudioError,match='VERSION_CHANGED'):svc.versions.restore_check('alice',p['id'],old,latest)
    assert svc.versions.restore_check('alice',p['id'],old)['comparisonHash']==old

async def test_restore_rejects_corrupted_comparison_snapshot(svc):
    p=await seeded(svc);old=p['artifacts'][0]['hash']
    p=await candidate(svc,p);latest=p['artifacts'][-1]['hash']
    svc.store.mutate('alice',p['id'],op(),{},lambda q:q['artifacts'][-1]['snapshot']['solution'].update({'outputs':'tampered'}))
    with pytest.raises(StudioError,match='ARTIFACT_INTEGRITY_FAILED'):svc.versions.restore_check('alice',p['id'],old,latest)

async def test_restore_compares_frozen_prd_instead_of_empty_or_current_draft(svc):
    p=await seeded(svc)
    draft=deepcopy(p['solution']);draft['prd']['rules'].append('本轮保留所有事项')
    p=svc.update_solution('alice',p['id'],{'operationId':op(),'expectedHash':p['solutionHash'],'solution':draft})
    svc.confirm('alice',p['id'],{'operationId':op(),'solutionHash':p['solutionHash'],'reviewedSections':['goal','flow','scope','pages','data','rules','acceptance']})
    p=await candidate(svc,p);old=p['artifacts'][-1]['hash']
    p=await candidate(svc,p);latest=p['artifacts'][-1]['hash']
    assert svc.versions.restore_check('alice',p['id'],old,latest)['changes']['sections']==[]
    draft=deepcopy(p['solution']);draft['prd']['rules'].append('保存失败时保留草稿并允许重试')
    p=svc.update_solution('alice',p['id'],{'operationId':op(),'expectedHash':p['solutionHash'],'solution':draft})
    # An unbuilt draft is not the baseline for frozen artifact comparison.
    assert svc.versions.restore_check('alice',p['id'],old,latest)['changes']['sections']==[]
    svc.confirm('alice',p['id'],{'operationId':op(),'solutionHash':p['solutionHash'],'reviewedSections':['goal','flow','scope','pages','data','rules','acceptance']})
    p=await candidate(svc,p)
    assert svc.versions.restore_check('alice',p['id'],old)['changes']['sections']==['规则与异常']

@pytest.mark.parametrize('private',[False,True])
async def test_http_restore_preview_baseline_validation_and_confirmation(tmp_path,private):
    from httpx import ASGITransport,AsyncClient
    from wanx_studio.local import build_local
    app=build_local(tmp_path);service=app.state.studio
    try:
        p=await seeded(service,'synthetic-local-user');old=p['artifacts'][0]['hash']
        files=deepcopy(service.store.get('synthetic-local-user',p['id'])['artifacts'][0]['files'])
        files['app/host.mjs']+='\n// synthetic HTTP preview\n'
        p=await candidate(service,p,files,'synthetic-local-user');latest=p['artifacts'][-1]['hash']
        path=f'/api/app-studio/projects/{p["id"]}/versions/{old}/restore-check'
        async with AsyncClient(transport=ASGITransport(app=app),base_url='http://testserver') as c:
            assert (await c.get(path)).status_code==401
            await c.get('/api/app-studio/session')
            assert (await c.get(path,params={'comparisonHash':'bad'})).status_code==422
            assert (await c.get(path,params={'comparisonHash':'f'*64})).status_code==404
            check=(await c.get(path,params={'comparisonHash':latest})).json()
            assert check['comparisonHash']==latest and check['changes']['addedCapabilities']==[]
            if private:service.edits.get('synthetic-local-user',p['id'])
            restore=f'/api/app-studio/{"_builder/" if private else ""}projects/{p["id"]}/restore-version'
            body={'operationId':op(),'expectedRevision':check['expectedRevision'],'artifactHash':old,'comparisonHash':latest,'checkHash':check['checkHash'],'confirmedByUser':True}
            assert (await c.post(restore,json={**body,'comparisonHash':'bad'})).status_code==422
            assert (await c.post(restore,json={**body,'comparisonHash':old})).status_code==409
            result=await c.post(restore,json=body);assert result.status_code==200,result.text
            restored=result.json();assert restored['artifacts']==p['artifacts']
            assert restored['versioning']['adoptedHash']==(None if private else old)
            if private:assert restored['versioning']['iteration']['baseHash']==old
    finally:await service.close()
