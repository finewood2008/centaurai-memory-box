"""Rebuild standard iterations from verified immutable artifacts, never stale cwd."""
from copy import deepcopy
import json
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4
import pytest
from test_standard_artifacts import standard
from wanx_studio import devkit_build
from wanx_studio.contracts import digest,StudioError
from wanx_studio.runner import Runner
from wanx_studio.versions import verify

@pytest.mark.parametrize('newer_version',[False,True])
async def test_standard_iteration_rebuilds_selected_baseline_and_starts_fresh_native_session(standard,tmp_path,monkeypatch,newer_version):
 svc,p=standard;q=svc.store.get('alice',p['id']);first=deepcopy(q['artifacts'][0]);old_path=Path(q['tasks'][0]['devKitWorkspace'])
 assert not old_path.exists(),'successful standard packaging removes the old working directory'
 q['tasks'][0]['sessionId']='synthetic-original-session';svc.store.save(q)
 if newer_version:
  tid=uuid4().hex;q=svc.store.get('alice',p['id']);q['tasks'].append({'id':tid,'state':'running','solutionHash':digest(q['solution']),'events':[]})
  workspace=devkit_build.create_workspace(q,svc.project_root,tmp_path/'newer'/tid,version='0.1.1')
  q['tasks'][-1].update(devKitWorkspace=workspace['root'],devKitSpecHash=workspace['specHash']);svc.store.save(q)
  files=devkit_build.mutable_files(Path(workspace['root']));files['app/host.mjs']+='\n// newer version must not replace explicitly selected baseline\n'
  await svc.add_artifact('alice',p['id'],tid,files)
 q=svc.store.get('alice',p['id']);tid=uuid4().hex
 q['tasks'].append({'id':tid,'state':'running','baseHash':first['hash'],'solutionHash':digest(q['solution']),'instruction':'Preserve selected baseline and fix layout','events':[],'buildFormat':'wanx-app-dev-kit'})
 svc.store.save(q);svc.runner=Runner(svc);svc.runner.touch('alice',p['id'])
 observed={};releases=[]
 class Input:
  def write(self,data):
   config=json.loads(data);observed['config']=config
   # This mirrors NativeSession's deliberate same-thread/stored-cwd resume:
   # resuming the old native session or scope still selects its deleted cwd.
   if config.get('sessionId') or config.get('scope')==p['id']:old_path.stat()
   assert Path(config['taskRoot']).is_dir()
  async def drain(self):pass
 class Output:
  def __init__(self):self.count=0
  async def readline(self):
   self.count+=1
   if self.count==1:return json.dumps({'type':'result','files':observed['config']['files']}).encode()+b'\n'
   return b'{"type":"idle"}\n'
 proc=SimpleNamespace(stdin=Input(),stdout=Output(),returncode=0)
 async def acquire(key,*_):observed['key']=key;return SimpleNamespace(proc=proc)
 async def release(worker,healthy):releases.append(healthy)
 async def abandon(*_):pass
 monkeypatch.setattr('wanx_studio.runner.runtime_config',lambda *_:{'synthetic':True})
 monkeypatch.setattr(svc.native_codex,'acquire',acquire);monkeypatch.setattr(svc.native_codex,'release',release);monkeypatch.setattr(svc.native_codex,'abandon',abandon)
 await svc.runner.run('alice',q,tid,'Preserve selected baseline and fix layout')
 current=svc.store.get('alice',p['id']);task=next(t for t in current['tasks'] if t['id']==tid)
 assert task['state']=='completed',task.get('error')
 assert observed['config']['sessionId'] is None
 assert observed['config']['scope']!=p['id']
 assert observed['key']==('alice',p['id'],'build',tid)
 assert observed['config']['files']==first['files']
 assert observed['config']['material']['instruction']=='Preserve selected baseline and fix layout'
 assert releases==[False],'a completed ephemeral standard worker must be physically closed'
 assert current['artifacts'][0]==first
 verify(current['artifacts'][-1])
 assert current['artifacts'][-1]['version']==('0.1.2' if newer_version else '0.1.1')
 assert not old_path.exists(),'do not fabricate the removed historical workspace'


@pytest.mark.parametrize('standard',['expert'],indirect=True)
@pytest.mark.parametrize('damage',['package','expert-seal','unknown-base','wrong-application'])
async def test_standard_workspace_rejects_untrusted_or_foreign_baseline_before_creation(standard,tmp_path,damage):
 svc,p=standard;q=svc.store.get('alice',p['id']);a=q['artifacts'][0];base=a['hash']
 if damage=='package':a['devKitPackage']['packageBase64']='Y2hhbmdlZA=='
 elif damage=='expert-seal':a['snapshot']['contracts']['foundation']['expertDeployment']['template']['digest']='sha256:'+'b'*64
 elif damage=='unknown-base':base='f'*64
 else:q['appId']='dev.wanx.foreign.a12345678'
 expected='ARTIFACT_NOT_FOUND' if damage=='unknown-base' else 'STANDARD_CONTRACT_CHANGED' if damage=='wrong-application' else 'ARTIFACT_INTEGRITY_FAILED'
 parent=tmp_path/'must-not-create'
 with pytest.raises(StudioError,match=expected):devkit_build.create_iteration_workspace(q,svc.project_root,parent,{'baseHash':base},version='0.1.1')
 assert not parent.exists()


async def test_custom_prd_layout_nested_sources_and_binary_assets_survive_iteration(standard,tmp_path):
 import base64
 import io
 import zipfile
 from wanx_studio.standard_preview import compile_layout
 svc,p=standard;q=svc.store.get('alice',p['id']);first=q['artifacts'][0]
 tid=uuid4().hex
 q['tasks'].append({'id':tid,'state':'running','solutionHash':digest(q['solution']),'events':[]})
 workspace=devkit_build.create_iteration_workspace(q,svc.project_root,tmp_path/'custom',{'baseHash':first['hash']},version='0.1.1')
 root=Path(workspace['root'])
 files={
  'app/host.html':'<!doctype html><html><head><link rel="stylesheet" href="theme/report.css"></head><body><main id="report"></main><script type="module" src="host.mjs"></script></body></html>',
  'app/host.mjs':'import {title} from "./pages/report.mjs"; document.getElementById("report").textContent=title;',
  'app/pages/report.mjs':'export const title="PRD custom report";',
  'app/theme/report.css':'main { display:grid; grid-template-columns:1fr 2fr; }',
 }
 logo=b'\x89PNG\r\n\x1a\n'
 (root/'app/logo.png').write_bytes(logo)
 q['tasks'][-1].update(devKitWorkspace=workspace['root'],devKitSpecHash=workspace['specHash']);svc.store.save(q)
 await svc.add_artifact('alice',p['id'],tid,files)
 q=svc.store.get('alice',p['id']);custom=q['artifacts'][-1]
 assert custom['files']==files
 with zipfile.ZipFile(io.BytesIO(base64.b64decode(custom['devKitPackage']['packageBase64']))) as archive:
  assert 'app/pages/workspace.mjs' not in archive.namelist()
  assert archive.read('app/logo.png')==logo
 layout=compile_layout(svc.project_root,custom)
 assert 'PRD custom report' in layout['document']
 assert 'grid-template-columns: 1fr 2fr' in layout['document']
 next_workspace=devkit_build.create_iteration_workspace(q,svc.project_root,tmp_path/'next',{'baseHash':custom['hash']},version='0.1.2')
 next_root=Path(next_workspace['root'])
 assert devkit_build.mutable_files(next_root)==files
 assert (next_root/'app/logo.png').read_bytes()==logo
 assert not (next_root/'app/pages/tasks.mjs').exists()
