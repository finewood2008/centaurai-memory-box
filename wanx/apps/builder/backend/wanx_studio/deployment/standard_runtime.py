"""Public fixed HTTP contract for a trusted, deployed protocol-3 expert client.

Identity is injected by the WANX host gate, never supplied by an application.
The original archive manifest remains intact; only backend-owned runtime state
supplies the implicit expert and data scope.
"""
from copy import deepcopy
from datetime import datetime,timezone
import re
import secrets
import time

from fastapi import Depends,Request
from ..contracts import StudioError
from .api import _body,_query
from .standard_client import CONTRACT,RUNTIME_CONTRACT,is_standard,metadata,validate_client
from .miniapp_profile import sha

SLOT=re.compile(r'ai\.wanx\.selfmade\.[a-f0-9]{32}')
OPERATIONS={'expert.run','expert.tasks','expert.cancel','data.list','data.get','data.put','data.delete'}


def assert_session(svc,owner,token):
    session=svc.runtime_sessions.get(token)
    if not session or session.get('standardExpertContract')!=RUNTIME_CONTRACT or session.get('owner')!=owner or session.get('expires',0)<time.time():raise StudioError('RUNTIME_SESSION_EXPIRED',401)
    authority=getattr(svc,'local_authority',None)
    if authority is not None:authority.application(owner,session['deploymentSlot'])
    svc.deployment_profile.assert_runtime(session)
    return session


def mint_sso_launch(svc,profile,owner,binding):
    authority=getattr(svc,'local_authority',None)
    if authority is not None and authority.required():raise StudioError('EXPERT_OPERATION_DENIED',403)
    profile.assert_source(owner,binding['target'])
    session={'owner':owner,'deploymentSlot':binding['expertBinding']['slotApplicationId'],
        'deploymentGeneration':binding['generation'],'artifact':binding['artifactHash'],
        'expires':profile.clock()+3600}
    profile.assert_runtime(session)
    launches=getattr(svc,'standard_launch_sessions',None)
    if launches is None:svc.standard_launch_sessions=launches={}
    for key,value in list(launches.items()):
        if value['expires']<profile.clock():launches.pop(key,None)
    token=secrets.token_urlsafe(32)
    launches[token]=session
    return {'schemaVersion':1,'transport':'wanx-expert-app-v1','launchToken':token,'expiresAt':session['expires']}


class StandardRuntime:
    def __init__(self,svc):self.svc=svc

    def sso_principal(self,owner,token):
        authority=getattr(self.svc,'local_authority',None)
        if authority is not None and authority.required():raise StudioError('EXPERT_OPERATION_DENIED',403)
        if not isinstance(token,str) or not re.fullmatch(r'[A-Za-z0-9_-]{43}',token):raise StudioError('EXPERT_OPERATION_DENIED',403)
        session=getattr(self.svc,'standard_launch_sessions',{}).get(token)
        if not session or session['owner']!=owner or session['expires']<time.time():raise StudioError('EXPERT_OPERATION_DENIED',403)
        profile=getattr(self.svc,'directory_profile',None)
        if profile is None or not profile.available:raise StudioError('EXPERT_RUNTIME_UNAVAILABLE',503)
        profile.assert_runtime(session)
        principal={'owner':owner,'applicationId':session['deploymentSlot'],'launchId':token}
        self.binding(principal)
        return principal

    def binding(self,principal):
        if not isinstance(principal,dict) or set(principal)!={'owner','applicationId','launchId'} or not isinstance(principal['owner'],str) or not isinstance(principal['applicationId'],str) or not SLOT.fullmatch(principal['applicationId']) or not isinstance(principal['launchId'],str) or not re.fullmatch(r'[A-Za-z0-9_-]{43}',principal['launchId']):
            raise StudioError('EXPERT_DEPLOYMENT_REQUIRED',403)
        owner,slot=principal['owner'],principal['applicationId']
        authority=getattr(self.svc,'local_authority',None)
        if authority is not None:authority.application(owner,slot)
        profile=getattr(self.svc,'directory_profile',None)
        if profile is None or not profile.available:raise StudioError('EXPERT_RUNTIME_UNAVAILABLE',503)
        profile.authorize_owner(owner)
        binding=profile.find_binding(owner,slot)
        if not binding or binding.get('owner')!=owner or binding.get('state')!='active' or not is_standard(binding.get('base')) or not binding.get('expertBinding'):
            raise StudioError('EXPERT_DEPLOYMENT_REQUIRED',409)
        validate_client(metadata(binding['base']),archive=False)
        profile.assert_source(owner,binding['target'])
        environment=self.svc.deployments.journal.get_environment(binding['target'])
        expert=binding['expertBinding']
        if environment['generation']!=binding['generation'] or expert.get('generation')!=binding['generation'] or expert.get('target')!=binding['target'] or expert.get('slotApplicationId')!=slot:
            raise StudioError('DEPLOYMENT_RUNTIME_STALE',409)
        return profile,deepcopy(binding)

    @staticmethod
    def pin(profile,principal,binding,*,create=False):
        key=sha([principal['owner'],principal['applicationId'],principal['launchId']])[7:]
        fingerprint={key:binding[key] for key in ('generation','artifactHash','operationId')}
        fingerprint['packageSha256']=binding['base']['packageSha256']
        previous=profile.get('standard-launch',key)
        if previous is None:
            if not create:raise StudioError('EXPERT_CONTEXT_REQUIRED',409)
            profile.put('standard-launch',key,fingerprint)
        elif previous!=fingerprint:raise StudioError('UPDATE_REQUIRED',409)

    def context(self,principal):
        profile,binding=self.binding(principal)
        target=binding['target'];base=binding['base']
        # Opening the actual installed runtime is observable, but only an expert
        # API call marks the expert-client handshake as ready.
        with profile.transaction():
            current=profile.find_binding(principal['owner'],principal['applicationId'])
            if not current or current['generation']!=binding['generation'] or current['operationId']!=binding['operationId']:raise StudioError('DEPLOYMENT_RUNTIME_STALE',409)
            self.pin(profile,principal,current,create=True)
            current['runtimeReady']={'operationId':binding['operationId'],'artifactHash':binding['artifactHash'],'generation':binding['generation']}
            profile.put('binding',profile.slot_key(principal['owner'],target),current)
        return {'schemaVersion':1,'scopeId':sha([principal['owner'],target,principal['applicationId'],'run'])[7:],
            'applicationId':target['applicationId'],'baseApplicationId':target['applicationId'],'slotApplicationId':principal['applicationId'],
            'boxId':target['boxId'],'environment':target['environment'],'generation':binding['generation'],'operationId':binding['operationId'],
            'artifactHash':binding['artifactHash'],'packageSha256':base['packageSha256'],'runtimeNamespace':'studio','contract':deepcopy(CONTRACT),
            'backend':{'schemaVersion':1,'productId':'wanx','deviceId':target['boxId'],'observedAt':datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z'),
                'authorization':{'status':'ready'},'contracts':[deepcopy(CONTRACT)],'resources':[],'bindings':[]}}

    async def invoke(self,principal,body):
        if not isinstance(body,dict) or set(body)!={'operation','input'} or not isinstance(body.get('operation'),str) or body['operation'] not in OPERATIONS or not isinstance(body.get('input'),dict):raise StudioError('EXPERT_INPUT_INVALID',422)
        profile,binding=self.binding(principal)
        with profile.transaction():
            self.pin(profile,principal,binding)
        owner=principal['owner'];base=binding['base'];token=secrets.token_urlsafe(32)
        session={'owner':owner,'project':binding['projectId'],'app':binding['target']['applicationId'],'artifact':binding['artifactHash'],
            'environment':'deployment:'+binding['target']['environment'],'manifest':deepcopy(base['manifest']),'files':{},'expires':profile.clock()+3600,
            'deploymentSlot':principal['applicationId'],'deploymentGeneration':binding['generation'],'deploymentProfile':profile.profile_id,
            'standardExpertContract':deepcopy(RUNTIME_CONTRACT)}
        self.svc.runtime_sessions[token]=session
        try:
            if body['operation'].startswith('expert.'):
                result=await self.svc.expert_runtime.invoke(owner,token,body['operation'],body['input'])
                assert_session(self.svc,owner,token)
                profile.mark_client_ready(owner,token)
            else:
                value=body['input']
                allowed={'data.list':{'collection','offset','limit'},'data.get':{'collection','id'},'data.put':{'collection','id','value','expectedRevision'},'data.delete':{'collection','id','expectedRevision'}}[body['operation']]
                if value.get('collection')!='state' or set(value)-allowed:raise StudioError('DATA_INPUT_INVALID',422)
                for field in ('expectedRevision','offset','limit'):
                    if field in value and (type(value[field]) is not int or not 0<=value[field]<=9007199254740991):raise StudioError('DATA_INPUT_INVALID',422)
                if 'limit' in value and not 1<=value['limit']<=200:raise StudioError('DATA_INPUT_INVALID',422)
                if 'id' in value and (not isinstance(value['id'],str) or not 1<=len(value['id'])<=128):raise StudioError('DATA_INPUT_INVALID',422)
                if body['operation'] in {'data.get','data.put','data.delete'} and 'id' not in value:raise StudioError('DATA_INPUT_INVALID',422)
                if body['operation']=='data.put' and (not isinstance(value.get('value'),dict) or set(value['value'])!={'json'} or not isinstance(value['value']['json'],str)):raise StudioError('RECORD_SCHEMA_INVALID',422)
                try:
                    if 'id' in value:value['id'].encode('utf-8')
                    if 'value' in value:value['value']['json'].encode('utf-8')
                except UnicodeError:raise StudioError('DATA_INPUT_INVALID',422) from None
                data_session={**session,'manifest':{**session['manifest'],'collections':deepcopy(RUNTIME_CONTRACT['collections'])}}
                result=self.svc.data(data_session,body['operation'],value)
            assert_session(self.svc,owner,token)
            return result
        finally:
            self.svc.runtime_sessions.pop(token,None)


def mount(app,svc,identity):
    runtime=StandardRuntime(svc)
    @app.get('/api/wanx-expert-app/v1/context',tags=['expert-app'])
    async def context(request:Request,principal=Depends(identity)):
        _query(request)
        return runtime.context(principal)
    @app.post('/api/wanx-expert-app/v1/invoke',tags=['expert-app'])
    async def invoke(request:Request,principal=Depends(identity)):
        _query(request)
        return await runtime.invoke(principal,await _body(request))
