"""Real standard-kit pipeline with synthetic developer output; no model calls."""
from copy import deepcopy
import base64
import json
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest

from wanx_studio import devkit, devkit_build
from wanx_studio.contracts import StudioError, digest
from wanx_studio.service import StudioService
from wanx_studio.versions import verify

ROOT=Path(__file__).resolve().parents[2]

@pytest.fixture
async def standard(tmp_path,request):
 svc=StudioService(tmp_path/'state',ROOT)
 p=svc.store.create('alice','Synthetic standard','Synthetic build',uuid4().hex,dev_kit=True)
 svc.preparation.enable('alice',p['id'])
 p=svc.store.get('alice',p['id'])
 # Keep identity valid here to isolate the adoption/integrity regression.
 p['appId']='dev.wanx.synthetic.a12345678'
 p['solution']['capabilities']=[]
 expert={'schemaVersion':1,'profile':'wanx-expert-app-v1','revision':1,'template':{'resourceId':'synthetic-expert','version':'0.0.0+sha.'+'a'*12,'digest':'sha256:'+'a'*64},'verification':{'schemaVersion':1,'checks':[{'id':'text-roundtrip','input':{'text':'Synthetic'},'expected':{'contains':'Synthetic'}}]}} if getattr(request,'param',None)=='expert' else None
 if expert:p['deploymentExpert']=expert;p['solution']['capabilities']=['wanx.expert-app.v1']
 p['confirmation']={'hash':digest(p['solution']),'at':1}
 p['preparation'].update(phase='acp',handoff={'contracts':{'wanx.expert-app.v1':{'expertDeployment':expert}} if expert else {}})
 p['preparation']['interview'].update(state='completed',sync='saved')
 tid=uuid4().hex
 p['tasks']=[{'id':tid,'state':'running','solutionHash':digest(p['solution']),'instruction':'Synthetic developer result','events':[],'question':None,'buildFormat':'wanx-app-dev-kit'}]
 svc.store.save(p)
 workspace=devkit_build.create_workspace(p,ROOT,tmp_path/'tasks'/tid)
 p=svc.store.get('alice',p['id']);p['tasks'][0].update(devKitWorkspace=workspace['root'],devKitSpecHash=workspace['specHash']);svc.store.save(p)
 result=await svc.add_artifact('alice',p['id'],tid,devkit_build.mutable_files(Path(workspace['root'])))
 yield svc,result
 await svc.close()

async def test_real_standard_pipeline_artifact_can_be_normally_adopted(standard):
 svc,p=standard;a=svc.store.get('alice',p['id'])['artifacts'][-1]
 assert all(v['exitCode']==0 for v in a['devKitPackage']['stages'].values())
 adopted=svc.versions.adopt('alice',p['id'],{'operationId':uuid4().hex,'expectedRevision':p['versioning']['revision'],'artifactHash':a['hash'],'confirmedByUser':True})
 assert adopted['versioning']['adoptedHash']==a['hash']
 assert a['snapshot']['solution']==svc.store.get('alice',p['id'])['solution']
 assert a['contentHash']
 verify(a)

@pytest.mark.parametrize('field',['manifest','files','packageBytes','packageDigest','projectSpec','generation','missingContentHash','version'])
async def test_standard_artifact_rejects_tampered_immutable_content(standard,field):
 svc,p=standard;a=deepcopy(svc.store.get('alice',p['id'])['artifacts'][-1])
 if field=='manifest':a['manifest']['name']='Changed'
 elif field=='files':a['files']['app/host.mjs']+='\n// Changed\n'
 elif field=='packageBytes':a['devKitPackage']['packageBase64']=base64.b64encode(b'changed').decode()
 elif field=='packageDigest':a['devKitPackage']['packageSha256']='0'*64
 elif field=='projectSpec':a['projectSpecHash']='0'*64
 elif field=='missingContentHash':a.pop('contentHash')
 elif field=='version':a['version']='0.1.99'
 else:a['devKitPackage']['generationManifest']['changed']=True
 with pytest.raises(StudioError,match='ARTIFACT_INTEGRITY_FAILED'):verify(a)

def test_new_standard_identity_remains_valid_and_stable_with_numeric_names(tmp_path,monkeypatch):
 monkeypatch.setattr('wanx_studio.store.uuid4',lambda:SimpleNamespace(hex='0'*32))
 svc=StudioService(tmp_path,ROOT)
 try:
  p=svc.store.create('alice','123 App','Synthetic identity',uuid4().hex,dev_kit=True)
  assert devkit.APPLICATION_ID.fullmatch(p['appId'])
  assert devkit.project_spec(p)['applicationId']==p['appId']
  original=p['appId'];p['name']='Renamed application'
  assert devkit.project_spec(p)['applicationId']==original
 finally:svc.store.close()

async def test_standard_adopted_transfer_preserves_frozen_version(standard):
 svc,p=standard;a=svc.store.get('alice',p['id'])['artifacts'][-1]
 svc.versions.adopt('alice',p['id'],{'operationId':uuid4().hex,'expectedRevision':p['versioning']['revision'],'artifactHash':a['hash'],'confirmedByUser':True})
 # The editable draft after adoption must not become transfer provenance.
 q=svc.store.get('alice',p['id']);q['solution']['goal']='Changed current draft';svc.store.save(q)
 payload=svc.install_payload('alice',p['id'],a['hash'])
 assert payload['packageSha256']==a['packageSha256']
 bundle=svc.export_standard_version('alice',p['id'],a['hash'])
 assert bundle['project']['solution']==a['snapshot']['solution']
 imported=svc.import_standard_version('bob',bundle,uuid4().hex)
 b=svc.store.get('bob',imported['id'])['artifacts'][-1]
 assert b['snapshot']==a['snapshot'] and b['hash']==a['hash']
 svc.versions.adopt('bob',imported['id'],{'operationId':uuid4().hex,'expectedRevision':imported['versioning']['revision'],'artifactHash':b['hash'],'confirmedByUser':True})
 verify(b)

@pytest.mark.parametrize('field',['snapshot','expertContract'])
async def test_standard_snapshot_tamper_is_detected(standard,field):
 svc,p=standard;a=deepcopy(svc.store.get('alice',p['id'])['artifacts'][-1])
 if field=='snapshot':a['snapshot']['decisions']['new']='Changed'
 else:a['snapshot']['contracts']['wanx.expert-app.v1']={'expertDeployment':{'profile':'wanx-expert-app-v1'}}
 with pytest.raises(StudioError,match='ARTIFACT_INTEGRITY_FAILED'):verify(a)

@pytest.mark.parametrize('standard',['expert'],indirect=True)
async def test_standard_expert_contract_is_frozen_and_hash_bound(standard):
 svc,p=standard;a=svc.store.get('alice',p['id'])['artifacts'][-1]
 frozen=deepcopy(a['snapshot']['contracts']['wanx.expert-app.v1']['expertDeployment'])
 assert a['expertContractDigest']==digest(frozen)
 assert a['manifest']['capabilities']==['identity.read','http.request']
 q=svc.store.get('alice',p['id']);q['deploymentExpert']['revision']=99;svc.store.save(q)
 assert a['snapshot']['contracts']['wanx.expert-app.v1']['expertDeployment']==frozen
 verify(a)

async def test_standard_restore_reuses_immutable_package_version(standard):
 svc,p=standard;a=svc.store.get('alice',p['id'])['artifacts'][-1]
 check=svc.versions.restore_check('alice',p['id'],a['hash'])
 body={**check,'operationId':uuid4().hex,'confirmedByUser':True}
 result=svc.versions.restore('alice',p['id'],body)
 restored=svc.store.get('alice',p['id'])['artifacts'][-1]
 assert restored['version']==restored['manifest']['version']==a['version']
 assert restored['hash']==a['hash']
 assert result['versioning']['adoptedHash']==a['hash']
 verify(restored)

@pytest.mark.parametrize('standard',['expert'],indirect=True)
async def test_standard_runner_keeps_fixed_expert_instruction(standard,monkeypatch):
 from wanx_studio.runner import Runner
 from wanx_studio.deployment.project_expert import instruction
 svc,p=standard;p=svc.store.get('alice',p['id'])
 tid=uuid4().hex;p['tasks'].append({'id':tid,'state':'running','solutionHash':digest(p['solution']),'events':[]})
 svc.store.save(p)
 captured={}
 class StopAtDispatch(Exception):pass
 class Input:
  def write(self,data):captured.update(json.loads(data));raise StopAtDispatch()
 async def acquire(*_):return SimpleNamespace(proc=SimpleNamespace(stdin=Input(),returncode=0))
 monkeypatch.setattr('wanx_studio.runner.runtime_config',lambda *_:{'synthetic':True})
 monkeypatch.setattr(svc.native_codex,'acquire',acquire)
 with pytest.raises(StopAtDispatch):await Runner(svc).execute('alice',p,tid,'Synthetic runner check')
 contract=captured['material']['contract']
 assert contract['expertInstruction']==instruction(p)
 assert contract['expertDeployment']==p['artifacts'][-1]['snapshot']['contracts']['wanx.expert-app.v1']['expertDeployment']
 assert {'app/host.mjs','app/host.html'} <= set(contract['mutableFiles'])
 assert contract['mutableRoots']==['app/']
 assert 'modelMethod' not in contract


def test_existing_standard_identity_cannot_be_silently_replaced():
 p={'id':'a'*32,'name':'Synthetic','appId':'dev.wanx.synthetic.00000000','devKit':True,'solution':{}}
 with pytest.raises(StudioError,match='PROJECT_IDENTITY_INVALID'):devkit.project_spec(p)
 assert p['appId']=='dev.wanx.synthetic.00000000'
 p['devKit']=False
 assert devkit.project_spec(p)['applicationId']=='dev.wanx.synthetic'


async def test_two_real_standard_versions_restore_only_marks_current_adoption(standard,tmp_path):
 svc,p=standard;first=deepcopy(svc.store.get('alice',p['id'])['artifacts'][-1])
 def adopt(a):
  current=svc.store.get('alice',p['id'])
  return svc.versions.adopt('alice',p['id'],{'operationId':uuid4().hex,'expectedRevision':current['versioning']['revision'],'artifactHash':a['hash'],'confirmedByUser':True})
 adopt(first)
 assert 'restore' not in svc.install_payload('alice',p['id'],first['hash'])
 current=svc.store.get('alice',p['id']);tid=uuid4().hex
 current['tasks'].append({'id':tid,'state':'running','solutionHash':digest(current['solution']),'instruction':'Synthetic second version','events':[],'question':None,'buildFormat':'wanx-app-dev-kit'})
 svc.store.save(current)
 workspace=devkit_build.create_workspace(current,ROOT,tmp_path/'second'/tid,version='0.1.1')
 current=svc.store.get('alice',p['id']);current['tasks'][-1].update(devKitWorkspace=workspace['root'],devKitSpecHash=workspace['specHash']);svc.store.save(current)
 files=devkit_build.mutable_files(Path(workspace['root']));files['app/host.mjs']+='\n// synthetic second build\n'
 await svc.add_artifact('alice',p['id'],tid,files)
 second=deepcopy(svc.store.get('alice',p['id'])['artifacts'][-1]);adopt(second)
 assert first['hash']!=second['hash'] and first['packageSha256']!=second['packageSha256']
 assert second['version']=='0.1.1'
 assert 'restore' not in svc.install_payload('alice',p['id'],second['hash'])
 with pytest.raises(StudioError,match='USER_ACCEPTANCE_REQUIRED'):svc.install_payload('alice',p['id'],first['hash'])
 check=svc.versions.restore_check('alice',p['id'],first['hash'])
 svc.versions.restore('alice',p['id'],{**check,'operationId':uuid4().hex,'confirmedByUser':True})
 payload=svc.install_payload('alice',p['id'],first['hash'])
 assert payload['restore']=={'schemaVersion':1,'source':'restore','artifactHash':first['hash']}
 assert payload['version']==first['version']==first['manifest']['version']
 assert payload['packageBase64']==first['devKitPackage']['packageBase64']
 assert payload['packageSha256']==first['packageSha256']
 assert len(svc.store.get('alice',p['id'])['artifacts'])==2
 with pytest.raises(StudioError,match='USER_ACCEPTANCE_REQUIRED'):svc.install_payload('alice',p['id'],second['hash'])
 # An ordinary adoption of the same hash cannot inherit an earlier restore.
 adopt(first)
 assert 'restore' not in svc.install_payload('alice',p['id'],first['hash'])
