"""Protocol-3 managed expert delivery preserves the adopted ZIP identity."""
import base64
from copy import deepcopy
import hashlib
import io
import json
from pathlib import Path
import zipfile

import pytest
from wanx_studio.contracts import StudioError
from wanx_studio.standard_package import validate_standard_package
from wanx_studio.deployment.standard_client import CLIENT_FORMAT, RUNTIME_CONTRACT, delivery_digest, validate_client


def package(extra=None):
    manifest={"applicationId":"dev.wanx.standard.example","name":"Standard expert","version":"0.1.0","protocolVersion":3,"runtime":"electron","launchMode":"shared","entrypoint":"shell/main.cjs","capabilities":["identity.read","http.request"],"compatibility":{"backendProductId":"wanx","clientRange":">=0.1.0 <2.0.0","hostProtocolRange":">=1.0.0 <2.0.0","backendContracts":[{"id":"wanx.expert-app.v1","range":">=1.0.0 <2.0.0","features":["context","expert","data"]}],"resourceDependencies":[],"localDataSchema":{"readRange":"=1.0.0","writeVersion":"1.0.0"}}}
    stream=io.BytesIO()
    with zipfile.ZipFile(stream,"w",zipfile.ZIP_DEFLATED) as archive:
        for name,value in {"application.manifest.json":json.dumps(manifest),"shell/main.cjs":"require('./host.cjs')","shell/host.cjs":"// SDK host.request only","shell/preload.cjs":"// narrow IPC", "app/host.html":"<main>Standard</main>","app/host.mjs":"// renderer",**(extra or {})}.items():
            archive.writestr(name,value)
    raw=stream.getvalue()
    return manifest,raw


def payload(extra=None):
    manifest,raw=package(extra)
    return {"format":CLIENT_FORMAT,"applicationId":manifest["applicationId"],"name":manifest["name"],"version":manifest["version"],"artifactHash":"a"*64,"manifest":manifest,"packageSha256":hashlib.sha256(raw).hexdigest(),"packageBase64":base64.b64encode(raw).decode(),"runtimeNamespace":"studio","runtimeContract":deepcopy(RUNTIME_CONTRACT)}


def test_standard_package_and_payload_preserve_exact_zip_and_base_identity():
    value=payload();original=deepcopy(value)
    raw=validate_standard_package(value["packageBase64"],value["packageSha256"],value["manifest"],application_id=value["applicationId"],version=value["version"])
    assert raw==base64.b64decode(value["packageBase64"])
    assert validate_client(value)==value
    assert value==original


@pytest.mark.parametrize("name",["../escape","/absolute","shell\\escape","a/../../escape",".env"])
def test_package_rejects_unsafe_archive_names(name):
    value=payload({name:"unsafe"})
    with pytest.raises(StudioError):validate_client(value)


def test_metadata_digest_binds_package_hash_without_canonicalizing_large_base64():
    value=payload({"large.bin":bytes(range(256))*5000})
    baseline=delivery_digest(value)
    changed={**value,"packageBase64":"x"*2000000}
    assert delivery_digest(changed)==baseline
    with pytest.raises(StudioError):validate_client(changed)
    assert delivery_digest({**value,"packageSha256":"b"*64})!=baseline


def test_package_mismatch_and_managed_capabilities_fail_closed():
    value=payload()
    with pytest.raises(StudioError):validate_client({**value,"packageSha256":"b"*64})
    wrong=deepcopy(value);wrong["manifest"]["applicationId"]="other.application"
    with pytest.raises(StudioError):validate_client(wrong)
    wrong=deepcopy(value);wrong["runtimeContract"]["collections"]={"other":{"text":"string"}}
    with pytest.raises(StudioError):validate_client(wrong)


def write_standard_source(path,release_id):
    from test_directory_intake import write_source,replace_artifact,encode
    manifest,_=write_source(path,release_id=release_id)
    value=payload();raw=base64.b64decode(value['packageBase64'])
    manifest['applicationId']=value['applicationId']
    manifest['client']['packageArtifactId']='standard-package'
    manifest['artifacts'].append({'artifactId':'standard-package','role':'client','path':'client/application.zip','mediaType':'application/zip','digest':'sha256:'+value['packageSha256'],'sizeBytes':len(raw),'platforms':[{'os':'darwin','arch':'arm64'}]})
    (path/'client/application.zip').write_bytes(raw)
    replace_artifact(path,manifest,'client/payload.json',{k:v for k,v in value.items() if k!='packageBase64'})
    return manifest,value


def test_directory_preserves_zip_as_independent_verified_artifact(tmp_path):
    from wanx_studio.store import Store
    from wanx_studio.deployment.intake import ReleaseIntake
    from wanx_studio.deployment.expert_runtime import validate_backend
    import shutil
    store=Store(tmp_path/'store')
    try:
        intake=ReleaseIntake(store,tmp_path/'inbox',tmp_path/'snapshots',backend_validator=validate_backend,runtime_namespace='studio')
        source=intake.inbox/intake.owner_scope('wanx:7')/'standard-1'
        manifest,value=write_standard_source(source,'standard-1')
        frozen=intake.ingest('wanx:7','standard-1')
        assert 'packageBase64' not in frozen['base']
        descriptor=next(a for a in frozen['bundle']['artifactDescriptors'] if a['artifactId']=='standard-package')
        assert intake.resolve_artifact('wanx:7',descriptor['sourceRef'])==base64.b64decode(value['packageBase64'])
        shutil.rmtree(source)
        assert intake.get('wanx:7','standard-1')==frozen
        assert store.db.execute('SELECT count(*) FROM projects').fetchone()[0]==0
    finally:store.close()


@pytest.fixture
async def standard_setup(tmp_path):
    from wanx_studio.service import StudioService
    from wanx_studio.deployment.intake import ReleaseIntake
    from wanx_studio.deployment.expert_runtime import validate_backend
    from wanx_studio.deployment.expert_profile import ExpertProfile
    from wanx_studio.deployment.miniapp_profile import MiniappProfile,sha
    from wanx_studio.deployment.profiles import DeploymentProfiles
    from wanx_studio.deployment.standard_runtime import assert_session
    from test_expert_deployment import Experts,OWNER,RELEASE
    class StandardExperts(Experts):
        async def invoke(self,owner,token,operation,body):
            session=assert_session(self.svc,owner,token)
            binding=self.svc.deployment_profile.find_binding(owner,session['deploymentSlot'])
            if operation!='expert.tasks' or body:raise StudioError('EXPERT_INPUT_INVALID',422)
            return {'items':[],'context':{'scopeId':sha([owner,binding['target'],session['deploymentSlot'],'run'])[7:]}}
    svc=StudioService(tmp_path/'store',Path(__file__).resolve().parents[2])
    mini=MiniappProfile(svc,{'boxId':'synthetic-box'},lambda owner:None,source='studio')
    intake=ReleaseIntake(svc.store,tmp_path/'inbox',tmp_path/'snapshots',backend_validator=validate_backend,runtime_namespace='studio')
    _,value=write_standard_source(intake.inbox/intake.owner_scope(OWNER)/RELEASE,RELEASE)
    experts=StandardExperts(svc)
    expert=ExpertProfile(svc,{'boxId':'synthetic-box'},lambda owner:None,runtime=experts,intake=intake,source='studio')
    profiles=DeploymentProfiles(mini,expert)
    svc.deployment_profile=profiles;svc.directory_profile=expert;svc.expert_runtime=experts
    svc.deployments.adapter=profiles;svc.deployments.start=lambda:None;svc.deployments.retry_delay=0
    yield svc,profiles,expert,expert.ingest(OWNER,RELEASE),value
    del svc.expert_runtime
    await svc.close()


async def finish_standard(setup,operation,launch='A'*43):
    import asyncio
    from test_expert_deployment import OWNER
    from wanx_studio.deployment.standard_runtime import StandardRuntime
    svc,profiles,expert,_,value=setup
    runtime=StandardRuntime(svc);proof=None
    for _ in range(65):
        await svc.deployments.process_once(operation['id']);await asyncio.sleep(0)
        for ticket in profiles.delivery_list(OWNER)['items']:
            ticket=profiles.delivery_claim(OWNER,ticket['id'],{'nonce':ticket['nonce'],'clientId':'standard-client'})
            ticket['payload']=profiles.delivery_payload(OWNER,ticket['id'])
            assert ticket['scopeId']==ticket['payload']['deployment']['scopeId']
            assert ticket['payload']['applicationId']==value['applicationId']
            assert ticket['payload']['manifest']==value['manifest']
            assert ticket['payload']['packageBase64']==value['packageBase64']
            assert delivery_digest(ticket['payload'])==ticket['payloadDigest']
            fields={'nonce','clientId','artifactHash','slotApplicationId','operationId','step','fence','generation','payloadDigest'}
            profiles.delivery_ack(OWNER,ticket['id'],{**{k:ticket[k] for k in fields},'state':'prepared' if ticket['step']=='prepare_client' else 'active'})
            if ticket['step']=='activate':
                principal={'owner':OWNER,'applicationId':ticket['slotApplicationId'],'launchId':launch}
                proof=runtime.context(principal)
                await runtime.invoke(principal,{'operation':'expert.tasks','input':{}})
        current=svc.deployments.operation(OWNER,operation['id'])
        if current['state'] in {'succeeded','rejected','failed_recovered','failed_degraded','recovery_required'}:return current,proof
    return current,proof


async def test_standard_delivery_runtime_data_and_persistent_launch_fencing(standard_setup):
    from test_expert_deployment import deploy,OWNER
    from wanx_studio.deployment.standard_runtime import StandardRuntime
    from jsonschema import Draft202012Validator
    svc,profiles,expert,item,value=standard_setup
    prep,operation=await deploy(svc,expert,item,'dev','standard-dev')
    current,proof=await finish_standard(standard_setup,operation)
    assert current['state']=='succeeded',current
    root=Path(__file__).resolve().parents[4]
    schemas=root/'apps/personal-client/host-sdk/contracts/schemas'
    Draft202012Validator(json.loads((schemas/'expert-app-context.v1.schema.json').read_text())).validate(proof)
    validate_result=Draft202012Validator(json.loads((schemas/'expert-app-result.v1.schema.json').read_text())).validate
    runtime=StandardRuntime(svc)
    principal={'owner':OWNER,'applicationId':proof['slotApplicationId'],'launchId':'A'*43}
    put=await runtime.invoke(principal,{'operation':'data.put','input':{'collection':'state','id':'pending','value':{'json':'{"pending":true}'}}})
    validate_result(put)
    assert put['_revision']==1
    for operation_,input_ in [('data.get',{'collection':'state','id':'pending'}),('data.list',{'collection':'state'}),('expert.tasks',{})]:
        validate_result(await runtime.invoke(principal,{'operation':operation_,'input':input_}))
    with pytest.raises(StudioError,match='DATA_INPUT_INVALID'):
        await runtime.invoke(principal,{'operation':'data.get','input':{'collection':'state','id':'pending','value':{}}})
    with pytest.raises(StudioError,match='EXPERT_CONTEXT_REQUIRED'):
        await runtime.invoke({**principal,'launchId':'B'*43},{'operation':'expert.tasks','input':{}})
    opened=profiles.open_runtime(OWNER,proof['slotApplicationId'],{'artifactHash':proof['artifactHash'],'environment':'dev','generation':proof['generation']})
    prep,nextop=await deploy(svc,expert,item,'dev','standard-upgrade')
    current,_=await finish_standard(standard_setup,nextop,launch='C'*43)
    assert current['state']=='succeeded',current
    with pytest.raises(StudioError,match='UPDATE_REQUIRED'):StandardRuntime(svc).sso_principal(OWNER,opened['launchToken'])
    with pytest.raises(StudioError,match='UPDATE_REQUIRED'):StandardRuntime(svc).context(principal)
    with pytest.raises(StudioError,match='UPDATE_REQUIRED'):
        await StandardRuntime(svc).invoke(principal,{'operation':'expert.tasks','input':{}})


async def test_standard_sso_opaque_launch_fails_closed(standard_setup):
    from test_expert_deployment import deploy,OWNER
    from wanx_studio.deployment.standard_runtime import StandardRuntime
    svc,profiles,expert,item,_=standard_setup
    prep,operation=await deploy(svc,expert,item,'dev','sso-launch')
    current,proof=await finish_standard(standard_setup,operation)
    assert current['state']=='succeeded'
    opened=profiles.open_runtime(OWNER,proof['slotApplicationId'],{'artifactHash':proof['artifactHash'],'environment':'dev','generation':proof['generation']})
    assert set(opened)=={'schemaVersion','transport','launchToken','expiresAt'}
    assert opened['transport']=='wanx-expert-app-v1'
    token=opened['launchToken'];runtime=StandardRuntime(svc)
    assert token not in svc.runtime_sessions
    principal=runtime.sso_principal(OWNER,token)
    assert runtime.context(principal)['slotApplicationId']==proof['slotApplicationId']
    for owner,bad in [(OWNER,None),(OWNER,'bad'),('wanx:8',token),(OWNER,'Z'*43)]:
        with pytest.raises(StudioError,match='EXPERT_OPERATION_DENIED'):runtime.sso_principal(owner,bad)
    svc.standard_launch_sessions[token]['expires']=0
    with pytest.raises(StudioError,match='EXPERT_OPERATION_DENIED'):runtime.sso_principal(OWNER,token)
    svc.standard_launch_sessions={}
    with pytest.raises(StudioError,match='EXPERT_OPERATION_DENIED'):StandardRuntime(svc).sso_principal(OWNER,token)


async def test_standard_prod_copies_data_then_keeps_scopes_isolated(standard_setup):
    from test_expert_deployment import deploy,OWNER
    from wanx_studio.deployment.standard_runtime import StandardRuntime
    svc,profiles,expert,item,_=standard_setup
    _,dev=await deploy(svc,expert,item,'dev','isolation-dev')
    state,devproof=await finish_standard(standard_setup,dev)
    assert state['state']=='succeeded'
    runtime=StandardRuntime(svc);devp={'owner':OWNER,'applicationId':devproof['slotApplicationId'],'launchId':'A'*43}
    await runtime.invoke(devp,{'operation':'data.put','input':{'collection':'state','id':'copied','value':{'json':'dev value'}}})
    _,prod=await deploy(svc,expert,item,'prod','isolation-prod')
    state,prodproof=await finish_standard(standard_setup,prod,launch='B'*43)
    assert state['state']=='succeeded'
    prodp={'owner':OWNER,'applicationId':prodproof['slotApplicationId'],'launchId':'B'*43}
    assert prodproof['scopeId']!=devproof['scopeId']
    assert (await runtime.invoke(prodp,{'operation':'data.get','input':{'collection':'state','id':'copied'}}))['json']=='dev value'
    await runtime.invoke(prodp,{'operation':'data.put','input':{'collection':'state','id':'private','value':{'json':'prod value'}}})
    assert await runtime.invoke(devp,{'operation':'data.get','input':{'collection':'state','id':'private'}}) is None


async def test_real_standard_build_adopt_export_preserves_original_zip(tmp_path,monkeypatch):
    from uuid import uuid4
    from wanx_studio.service import StudioService
    from wanx_studio import devkit_build
    from wanx_studio.contracts import digest
    from test_studio_expert_delivery import wire, TEMPLATE
    svc=StudioService(tmp_path/'state',Path(__file__).resolve().parents[2])
    try:
        _,exporter=wire(svc,tmp_path)
        svc.directory_profile.experts.templates = lambda: [{**TEMPLATE, 'resourceId': 'general-assistant'}]
        ordinary=svc.create_project('alice','Ordinary','Synthetic client build',uuid4().hex)
        assert not ordinary.get('deploymentExpert')
        p=svc.create_project('alice','Standard expert','Synthetic build',uuid4().hex,target='expert')
        svc.preparation.enable('alice',p['id'])
        p=svc.store.get('alice',p['id'])
        contract=p['deploymentExpert']
        p['confirmation']={'hash':digest(p['solution']),'at':1}
        p['preparation'].update(phase='acp',handoff={'contracts':{'wanx.expert-app.v1':{'expertDeployment':contract}}})
        p['preparation']['interview'].update(state='completed',sync='saved')
        tid=uuid4().hex
        p['tasks']=[{'id':tid,'state':'running','solutionHash':digest(p['solution']),'instruction':'Synthetic standard developer result','events':[],'question':None,'buildFormat':'wanx-app-dev-kit'}]
        svc.store.save(p)
        workspace=devkit_build.create_workspace(p,svc.project_root,tmp_path/'tasks'/tid)
        p=svc.store.get('alice',p['id']);p['tasks'][0].update(devKitWorkspace=workspace['root'],devKitSpecHash=workspace['specHash']);svc.store.save(p)
        public=await svc.add_artifact('alice',p['id'],tid,devkit_build.mutable_files(Path(workspace['root'])))
        artifact=deepcopy(svc.store.get('alice',p['id'])['artifacts'][-1])
        adopted=svc.versions.adopt('alice',p['id'],{'operationId':uuid4().hex,'expectedRevision':public['versioning']['revision'],'artifactHash':artifact['hash'],'confirmedByUser':True})
        async def forbid(*args,**kwargs):raise AssertionError('Export cannot rebuild adopted artifacts')
        monkeypatch.setattr(svc,'add_artifact',forbid)
        request={'operationId':uuid4().hex,'expectedArtifactHash':artifact['hash'],'expectedVersionRevision':adopted['versioning']['revision']}
        exported=exporter.export('alice',p['id'],request)
        frozen=svc.directory_profile.intake.get('alice',exported['release']['releaseId'])
        assert 'Synthetic build' in artifact['snapshot']['expertPrompt']
        assert frozen['backend']['prompt'] == artifact['snapshot']['expertPrompt']
        assert frozen['base']['artifactHash']==artifact['hash']
        assert frozen['base']['manifest']==artifact['manifest']
        assert frozen['base']['applicationId']==p['appId']
        assert 'packageBase64' not in frozen['base']
        package_id=frozen['manifest']['client']['packageArtifactId']
        descriptor=next(a for a in frozen['bundle']['artifactDescriptors'] if a['artifactId']==package_id)
        assert svc.directory_profile.intake.resolve_artifact('alice',descriptor['sourceRef'])==base64.b64decode(artifact['devKitPackage']['packageBase64'])
        assert exporter.export('alice',p['id'],request)==exported
    finally:await svc.close()


async def test_public_mount_keeps_trusted_identity_out_of_body_and_rejects_extra_scope(standard_setup):
    import httpx
    from fastapi import FastAPI
    from fastapi.responses import JSONResponse
    from test_expert_deployment import deploy,OWNER
    from wanx_studio.deployment.standard_runtime import mount
    svc,profiles,expert,item,_=standard_setup
    _,operation=await deploy(svc,expert,item,'dev','public-route')
    state,proof=await finish_standard(standard_setup,operation)
    assert state['state']=='succeeded'
    app=FastAPI()
    @app.exception_handler(StudioError)
    async def failure(request,exc):return JSONResponse({'code':exc.code},status_code=exc.status)
    async def identity():yield {'owner':OWNER,'applicationId':proof['slotApplicationId'],'launchId':'D'*43}
    mount(app,svc,identity)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
        context=await client.get('/api/wanx-expert-app/v1/context')
        assert context.status_code==200 and context.json()['slotApplicationId']==proof['slotApplicationId']
        assert not {'owner','agentId','launchId','launchToken'}&context.json().keys()
        assert (await client.get('/api/wanx-expert-app/v1/context?environment=prod')).status_code==422
        for body in [{'operation':[],'input':{}},{'operation':'expert.tasks','input':{},'owner':'wanx:8'},{'operation':'data.get','input':{'collection':'state','id':'x','environment':'prod'}}]:
            assert (await client.post('/api/wanx-expert-app/v1/invoke',json=body)).status_code==422
        result=await client.post('/api/wanx-expert-app/v1/invoke',json={'operation':'expert.tasks','input':{}})
        assert result.status_code==200 and result.json()['context']['scopeId']==proof['scopeId']


@pytest.mark.parametrize('source',[
    'export const apiKey = "synthetic-private-value-123456789";',
    'export const workspace = "/Users/synthetic/private/project";',
    'export const endpoint = "http://192.168.1.99:8092/api";',
])
def test_standard_zip_rejects_inline_credentials_and_private_locators(source):
    with pytest.raises(StudioError,match='STANDARD_PACKAGE_INVALID'):
        validate_client(payload({'app/inline-config.mjs':source}))


def test_standard_zip_keeps_dynamic_sdk_environment_loopback_and_public_docs():
    value=payload({'shell/runtime-options.cjs':'const apiKey = process.env.WANX_HOST_TOKEN; const address = "127.0.0.1"; const endpoint = `http://${address}:${port}`;',
        'docs/setup.md':'Example /Users/example/project and http://127.0.0.1:1234 are documentation, not app configuration.',
        'app/image.bin':b'\x89PNG\x00'+b'apiKey=synthetic-private-value-123456789'})
    assert validate_client(value)==value
