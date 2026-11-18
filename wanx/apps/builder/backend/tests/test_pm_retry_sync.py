"""A failed original input can resume against an already complete saved PRD."""
import asyncio
from copy import deepcopy
import json
from types import SimpleNamespace
import pytest
from test_preparation import env
from test_prd_completeness import prepared,assess
from wanx_studio.contracts import digest
from wanx_studio.iterative import propose_contract,proposal

@pytest.mark.parametrize('agent_mode',['follow-action','explicit-noop','ignore-action','stale-hash','unresolved-question'])
async def test_retry_complete_draft_requires_explicit_hash_checked_save_before_finish(env,monkeypatch,agent_mode):
 svc,pid=await prepared(env);p=svc.store.get('alice',pid)
 # Prior successful PM turn uses the real save path, including derived fields.
 await svc.preparation.pm.tool('alice',pid,'review-turn','update_prd',{'expectedHash':digest(p['solution'])})
 p=svc.store.get('alice',pid)
 propose_contract(svc,'alice',pid,{'expectedHash':digest(p['solution']),'collections':{'items':{'title':'string'}}})
 assert (await assess(svc,pid))['complete']
 p=svc.store.get('alice',pid);s=p['preparation']['interview']
 s.update(state='completed',sync='saved');s['turns'][0]['state']='completed'
 text='按已确认内容继续处理当前 PRD，不新增范围'
 s['turns'].insert(0,{'id':'original-failed-turn','operationId':'original-failed-op','text':text,'state':'failed','at':0})
 p['messages'].append({'id':'synthetic-original-message','role':'user','text':text,'operationId':'original-failed-op'})
 svc.store.save(p);original=deepcopy(p['solution']);responses={};observed={}
 monkeypatch.setattr('wanx_studio.product_manager.runtime_config',lambda *_:{'synthetic':True})
 class Input:
  def write(self,data):
   value=json.loads(data)
   if 'id' in value:responses[value['id']]=value
  async def drain(self):pass
 class Output:
  async def __aiter__(self):
   yield json.dumps({'type':'request','id':'read','method':'read_project','args':{}}).encode()
   read=responses['read']['result'];observed['read']=read
   yield json.dumps({'type':'request','id':'validate','method':'validate_project_spec','args':{'expectedHash':read['expectedHash']}}).encode()
   if agent_mode=='unresolved-question':
    yield json.dumps({'type':'request','id':'question','method':'ask_product','args':{'text':'是否需要额外审核？','why':'会影响本轮产品范围','options':['保留现有范围（推荐）｜继续已有流程','增加审核｜需明确审核规则']}}).encode()
   yield json.dumps({'type':'request','id':'complete1','method':'complete_prd','args':{'expectedHash':read['expectedHash'],'summary':'合成：已核对现有完整 PRD，无新增业务内容。'}}).encode()
   check=responses['complete1']['result'];observed['firstComplete']=check
   action=check.get('requiredAction')
   if agent_mode!='ignore-action' and (agent_mode in {'explicit-noop','stale-hash'} or action):
    args={'expectedHash':read['expectedHash']} if agent_mode=='explicit-noop' else {'expectedHash':'0'*64} if agent_mode=='stale-hash' else action['arguments']
    yield json.dumps({'type':'request','id':'save','method':'update_prd','args':args}).encode()
    if 'result' in responses['save']:
     expected=responses['save']['result']['expectedHash']
     yield json.dumps({'type':'request','id':'complete2','method':'complete_prd','args':{'expectedHash':expected,'summary':'合成：已保存当前版本，无业务语义变化。'}}).encode()
   yield json.dumps({'type':'text','text':'合成：当前方案已核对。'}).encode()
   yield json.dumps({'type':'complete'}).encode();yield json.dumps({'type':'idle'}).encode()
 class Proc:
  returncode=0
  stdin=Input();stdout=Output()
 async def acquire(*_):return SimpleNamespace(proc=Proc())
 async def release(*_):pass
 monkeypatch.setattr(svc.native_codex,'acquire',acquire);monkeypatch.setattr(svc.native_codex,'release',release)
 await svc.preparation.pm.start('alice',pid,{'operationId':'original-failed-op','text':text})
 for _ in range(200):
  if ('alice',pid) not in svc.preparation.jobs:break
  await asyncio.sleep(.01)
 current=svc.store.get('alice',pid);s=current['preparation']['interview']
 assert observed['firstComplete']['complete'] is False
 assert '先保存本轮已确认的 PRD' in observed['firstComplete']['missing']
 assert current['solution']==original
 assert observed['read']['prdSynchronization']['state']=='pending'
 action=observed['firstComplete']['requiredAction']
 assert action=={'tool':'update_prd','arguments':{'expectedHash':digest(original)}}
 assert observed['read']['prdSynchronization']['requiredAction']==action
 if agent_mode in {'ignore-action','stale-hash'}:
  assert s['sync']=='failed'
  assert next(t for t in s['turns'] if t['id']=='original-failed-turn')['state']=='failed'
  assert not proposal(current)['ready'] and not s.get('prdReview')
  if agent_mode=='stale-hash':assert responses['save']['error']=='SOLUTION_CHANGED'
  assert current['confirmation'] is None and current['tasks']==[]
  return
 if agent_mode=='unresolved-question':
  assert responses['complete2']['result']['complete'] is False
  assert '还有向用户提出的问题尚未回答' in responses['complete2']['result']['missing']
  assert s['sync']=='saved' and not s.get('prdReview') and not proposal(current)['ready']
  assert current['confirmation'] is None and current['tasks']==[]
  return
 assert responses['complete2']['result']['complete'] is True
 assert s['sync']=='saved',{'sync':s['sync'],'turns':[(t['id'],t['state']) for t in s['turns']],'firstComplete':observed['firstComplete']}
 assert next(t for t in s['turns'] if t['id']=='original-failed-turn')['state']=='completed'
 assert proposal(current)['ready']
 assert current['confirmation'] is None and current['tasks']==[]
