"""Explicit Studio expert contracts, frozen into the normal Builder handoff."""
from copy import deepcopy
import re

from ..contracts import StudioError, digest
from ..versions import idle, source_artifact, state, verify
from .adapters import Blocked
from .expert_runtime import PROFILE, validate_backend

OPERATION = re.compile(r'^[a-f0-9]{32}$')


def selected(project):
    value=project.get('deploymentExpert')
    return value if isinstance(value,dict) and value.get('profile')==PROFILE else None


def validate_verification(value):
    if not isinstance(value,dict) or set(value)!={'schemaVersion','checks'} or type(value['schemaVersion']) is not int or value['schemaVersion']!=1 or not isinstance(value['checks'],list) or len(value['checks'])!=1:
        raise StudioError('EXPERT_VERIFICATION_INVALID',422)
    check=value['checks'][0]
    if not isinstance(check,dict) or set(check)!={'id','input','expected'} or check['id']!='text-roundtrip' or not isinstance(check['input'],dict) or set(check['input'])!={'text'} or not isinstance(check['expected'],dict) or set(check['expected'])!={'contains'}:
        raise StudioError('EXPERT_VERIFICATION_INVALID',422)
    for item,limit in ((check['input']['text'],4000),(check['expected']['contains'],512)):
        if not isinstance(item,str) or not item.strip() or len(item)>limit:raise StudioError('EXPERT_VERIFICATION_INVALID',422)
    return deepcopy(value)


def runtime_capabilities(project, capabilities):
    if not selected(project):return list(capabilities)
    # Selecting this backend explicitly assigns AI execution to the expert;
    # it does not grant an additional direct client model interface.
    return sorted(set(['foundation',*('foundation' if c=='model' else c for c in capabilities)]))


def capability_contracts(project, capabilities, catalog):
    result={key:deepcopy(catalog[key]) for key in capabilities if key in catalog and (not selected(project) or key in {'data','foundation'} or key.startswith('background.'))}
    contract=selected(project)
    if contract and 'foundation' in result:
        result['foundation']={
            'label':'盒端文本专家','methods':['foundation.invoke'],
            'limits':'固定部署专家合同，仅支持文本；由已部署应用隐式绑定实例。预览布局不调用未部署的专家；部署联调验证真实实例。',
            'expertDeployment':deepcopy(contract),
            'operations':{
                'expert.run':{'input':'{operationId:32位小写hex,text:1..12000字符}','output':'{run}'},
                'expert.tasks':{'input':'{} 或 {runId}','output':'{items,context:{scopeId}} 或 {run,context:{scopeId}}'},
                'expert.cancel':{'input':'{runId}','output':'{run}'},
            },
            'run':'{id,state,text,result,errorCode,createdAt,updatedAt}; Unix秒；result/errorCode可为空',
            'states':['queued','running','cancel_requested','succeeded','failed','cancelled','interrupted'],
            'retry':'新请求生成operationId并先用api.data保存operationId/text/scopeId；同请求重试沿用，不自动重放；跨scope复制的pending不能执行。',
        }
    return result


def instruction(project):
    if not selected(project):return ''
    return '''本项目已由用户显式选择 wanx-expert-app-v1 文本专家后端。客户端 capabilities 必须包含 foundation，可选 data；不要直接声明 model/files/knowledge/reports 或调用 model.generate。AI执行由部署后隐式绑定的专家提供。请按 availableContracts/handoff 的 foundation.expertDeployment 固定合同生成正常前端，api.foundation.invoke 的 operation 仅 expert.run/tasks/cancel，不传 agentId、URL、凭据、模型或目标环境。schema保持现有miniapp格式。专家在部署联调后可调用，布局预览不得伪造专家结果。持久化未确认请求和scopeId，重开只读历史，不自动重新运行未知任务。配置选择不是 PRD 确认或开发授权，仍走原确认和采用流程。'''


class ProjectExpert:
    def __init__(self,service):self.svc=service

    def profile(self,owner):
        self.svc.authorize_management(owner)
        profile=getattr(self.svc,'directory_profile',None)
        if not profile or not profile.available:raise StudioError('DEPLOYMENT_ADAPTER_UNAVAILABLE',503)
        if profile.runtime_namespace!='studio':raise StudioError('EXPERT_STUDIO_REQUIRED',403)
        try:profile.authorize_owner(owner)
        except Blocked as exc:raise StudioError(exc.code,403) from None
        return profile

    def template(self,profile,value):
        descriptor=validate_backend({'schemaVersion':1,'format':'wanx-expert-backend-v1','template':value,'mode':'ask'})
        if not any(all(row.get(k)==v for k,v in descriptor['template'].items()) for row in profile.experts.templates()):
            raise StudioError('EXPERT_TEMPLATE_CHANGED',409)
        return deepcopy(descriptor['template'])

    def source(self,owner,project):
        adopted=state(project)['adoptedHash']
        if not adopted:raise StudioError('USER_ADOPTION_REQUIRED',409)
        idle(project,pending=False)
        artifact=source_artifact(project,adopted);verify(artifact)
        task=next((t for t in project['tasks'] if t['id']==artifact['taskId']),None)
        if not task or task['state']!='completed':raise StudioError('VERSION_CHANGED',409)
        self.svc.versions.payload(owner,project['id'],adopted)
        contract=(artifact.get('snapshot',{}).get('contracts',{}).get('foundation',{}).get('expertDeployment'))
        if not contract or contract.get('profile')!=PROFILE:raise StudioError('EXPERT_CONTRACT_REQUIRED',409)
        validate_backend({'schemaVersion':1,'format':'wanx-expert-backend-v1','template':contract['template'],'mode':'ask'})
        validate_verification(contract['verification'])
        caps=set(artifact['manifest']['capabilities'])
        if 'foundation' not in caps or not caps<={'data','foundation'}:raise StudioError('EXPERT_CLIENT_CAPABILITY_UNSUPPORTED',409)
        return artifact,deepcopy(contract),{'artifactHash':adopted,'version':artifact['version'],'versionRevision':state(project)['revision'],
            'taskId':artifact['taskId'],'contentHash':artifact['contentHash'],'profile':PROFILE}

    def context(self,owner,pid):
        self.svc.authorize_management(owner);project=self.svc.store.get(owner,pid)
        revision=project.get('_deploymentExpertRevision',0)
        editable=True
        try:idle(project)
        except StudioError:editable=False
        result={'schemaVersion':1,'profile':PROFILE,'projectId':pid,'available':False,'reason':None,
            'configuration':{'revision':revision,'editable':editable,'contract':deepcopy(selected(project))},'templates':[],'source':None}
        try:profile=self.profile(owner)
        except StudioError as exc:
            result['reason']=exc.code;return result
        result.update(available=True,templates=profile.experts.templates())
        try:
            _,_,result['source']=self.source(owner,project)
        except StudioError as exc:result['reason']=exc.code
        return result

    def configure(self,owner,pid,body):
        profile=self.profile(owner)
        if not isinstance(body,dict) or set(body)!={'operationId','expectedRevision','template','verification'} or not isinstance(body['operationId'],str) or not OPERATION.fullmatch(body['operationId']) or type(body['expectedRevision']) is not int:
            raise StudioError('EXPERT_CONTRACT_INVALID',422)
        spec=None
        if body['template'] is not None:
            spec={'schemaVersion':1,'profile':PROFILE,'template':self.template(profile,body['template']),'verification':validate_verification(body['verification'])}
        elif body['verification'] is not None:raise StudioError('EXPERT_CONTRACT_INVALID',422)
        def change(project):
            self.profile(owner);idle(project)
            revision=project.get('_deploymentExpertRevision',0)
            if revision!=body['expectedRevision']:raise StudioError('EXPERT_CONTRACT_CHANGED',409)
            if 'preparation' not in project:raise StudioError('INTAKE_REQUIRED',409)
            if spec is None and project['artifacts']:raise StudioError('EXPERT_CONTRACT_LOCKED',409)
            self.svc.invalidate(project)
            project['_deploymentExpertRevision']=revision+1
            if spec:project['deploymentExpert']={**deepcopy(spec),'revision':revision+1}
            else:project.pop('deploymentExpert',None)
            prep=project['preparation'];prep.update(phase='intake',report=None,handoff=None)
            prep['revision']+=1
            prep['interview'].update(state='idle',sync='pending',question=None,questions=[],error=None)
            self.svc.preparation.event(project,'expert.contract.selected',profile=PROFILE,revision=revision+1)
        self.svc.store.mutate(owner,pid,body['operationId'],{'action':'expert-contract',**body},change)
        return {**self.context(owner,pid),'project':self.svc.snapshot(owner,pid)}


def mount(router,svc,identity):
    if getattr(svc,'workshop',False):return
    from fastapi import Depends,Request
    from .api import _body,_query
    from ..local_authority import to_thread
    manager=ProjectExpert(svc)
    @router.get('/projects/{pid}/deployment/expert')
    async def context(pid:str,request:Request,owner=Depends(identity)):
        _query(request);return await to_thread(manager.context,owner,pid)
    @router.put('/projects/{pid}/deployment/expert')
    async def configure(pid:str,request:Request,owner=Depends(identity)):
        _query(request);return await to_thread(manager.configure,owner,pid,await _body(request))
    @router.post('/projects/{pid}/deployment/release')
    async def release(pid:str,request:Request,owner=Depends(identity)):
        from .studio_release import StudioRelease
        _query(request);return await to_thread(StudioRelease(svc).export,owner,pid,await _body(request))
