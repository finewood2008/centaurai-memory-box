"""Directory releases using a box-held expert and the trusted miniapp host."""
from __future__ import annotations

import asyncio
import base64
from copy import deepcopy
from contextvars import Context
import re
import shutil

from ..contracts import StudioError, compatible
from .adapters import Blocked, Observation, Plan
from .miniapp_profile import MiniappProfile, identifier, sha
from .contracts import canonicalize_json
from .standard_client import is_standard,metadata,runtime_manifest

PROFILE = 'wanx-expert-app-v1'
RELEASE_ID = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')
TERMINAL = {'succeeded','rejected','failed_recovered','failed_degraded','recovery_required'}


class ExpertProfile(MiniappProfile):
    profile_id = PROFILE

    def __init__(self, svc, target=None, authority=None, *, runtime=None, intake=None, **kwargs):
        super().__init__(svc,target,authority,**kwargs)
        self.experts,self.intake=runtime,intake
        self.available=bool(self.available and runtime and intake)
        self.preparing={}
        self.other_profile=None

    def object_kind(self, kind):
        return 'expert-'+kind

    def directory_list(self, owner):
        self.svc.authorize_management(owner)
        if not self.available:
            return {'schemaVersion':1,'profile':PROFILE,'available':False,'reason':'DEPLOYMENT_ADAPTER_UNAVAILABLE','items':[]}
        self.authorize_owner(owner)
        items=[]
        for item in self.intake.list(owner).get('items',[]):
            release=self.intake.get(owner,item['releaseId'])
            items.append(self.public_release(release))
        return {'schemaVersion':1,'profile':PROFILE,'available':True,'reason':None,'items':items}

    @staticmethod
    def public_release(release):
        return {'releaseId':release['manifest']['releaseId'],'applicationId':release['manifest']['applicationId'],
                'version':release['manifest']['version'],'name':release['base']['name'],
                'directoryDigest':release['directoryDigest']}

    def ingest(self, owner, release_id):
        self.svc.authorize_management(owner);self.authorize_owner(owner)
        if not isinstance(release_id,str) or not RELEASE_ID.fullmatch(release_id):
            raise StudioError('DEPLOYMENT_RELEASE_INVALID',422)
        return self.public_release(self.intake.ingest(owner,release_id))

    def directory_context(self, owner, release_id):
        self.svc.authorize_management(owner);self.authorize_owner(owner)
        release=self.intake.get(owner,release_id);base=release['base']
        target=self.target_for(owner,base['applicationId'],'dev')
        environments=[]
        for env in ('dev','prod'):
            current={**target,'environment':env}
            self.assert_source(owner,current,allow_unclaimed=True)
            state=self.svc.deployments.journal.get_environment(current)
            environments.append({'id':env,**{k:state.get(k) for k in ('generation','health','activeReleaseRef')}})
        return {'schemaVersion':1,'profile':PROFILE,'available':True,'reason':None,'releaseId':release_id,
                'applicationId':base['applicationId'],'artifact':{'hash':base['artifactHash'],'version':base['version']},
                'target':{k:v for k,v in target.items() if k!='environment'},'environments':environments,
                'supportedActions':['deploy'],'supportedCapabilities':['data','foundation']}

    async def prepare_directory(self, owner, release_id, body):
        self.svc.authorize_management(owner);self.authorize_owner(owner)
        if not isinstance(body,dict) or set(body)!={'directoryDigest','environment','operationId'} or not re.fullmatch(r'[a-f0-9]{32}',str(body.get('operationId'))):
            raise StudioError('DEPLOYMENT_PREPARATION_INVALID',422)
        key=identifier('prepare-expert-',[owner,release_id,body['operationId']])
        old=self.get('preparation',key)
        if old:
            if old['body']!=body:raise StudioError('DEPLOYMENT_IDEMPOTENCY_CONFLICT',409)
            self.claim_target(owner,old['request']['target'])
            await self.svc.deployments.register_release(owner,old['bundle'])
            return deepcopy(old['public'])
        release=self.intake.get(owner,release_id)
        if release['directoryDigest']!=body['directoryDigest']:
            raise StudioError('DEPLOYMENT_VERSION_CHANGED',409)
        base=deepcopy(release['base'])
        if is_standard(base):
            descriptor=next(a for a in release['bundle']['artifactDescriptors'] if a['artifactId']==release['manifest']['client']['packageArtifactId'])
            base['packageBase64']=base64.b64encode(self.intake.resolve_artifact(owner,descriptor['sourceRef'])).decode()
        target=self.target_for(owner,base['applicationId'],body['environment'])
        self.claim_target(owner,target)
        if self.other_profile and self.other_profile.get('binding',self.slot_key(owner,target)):
            raise StudioError('RUNTIME_INCOMPATIBLE',409)
        previous=self.get('binding',self.slot_key(owner,target))
        if previous and (is_standard(previous['base'])!=is_standard(base) or not compatible(runtime_manifest(previous['base']),runtime_manifest(base))):
            raise StudioError('BREAKING_SCHEMA_CHANGE',409)
        if self.experts.busy(owner,self.slot_id(owner,target)):
            raise StudioError('EXPERT_RUN_ACTIVE',409)
        bundle=release['bundle'];ref={'releaseId':bundle['releaseId'],'bundleDigest':bundle['bundleDigest']}
        state=self.svc.deployments.journal.get_environment(target)
        regression=None
        if target['environment']=='prod':
            dev=self.svc.deployments.journal.get_environment({**target,'environment':'dev'})
            if dev['health']!='healthy' or dev['activeReleaseRef']!=ref:
                raise StudioError('DEPLOYMENT_DEV_VERIFICATION_REQUIRED',409)
            regression={'id':identifier('regression-',[owner,ref]),'revision':dev['revision']}
        reference={'id':key,'revision':1}
        request={'schemaVersion':1,'kind':'deploy','target':target,'releaseRef':ref,'expectedGeneration':state['generation'],
                 'idempotencyKey':'pending','decisionRef':reference,'validationRef':reference,'bindingSetRef':reference,
                 'channelBindingsRef':reference,'dataPlanRef':reference}
        if regression:request['regressionRef']=regression
        public={'schemaVersion':1,'preparationId':key,'releaseId':release_id,'directoryDigest':release['directoryDigest'],
                'environment':target['environment'],'expectedGeneration':state['generation'],'releaseRef':ref,'target':target}
        # Legacy delivery field projectId is an opaque directory context here;
        # no editable project, source compiler or fabricated adoption is created.
        record={'owner':owner,'projectId':identifier('',[owner,base['applicationId']]),'releaseId':release_id,
                'directoryDigest':release['directoryDigest'],'body':deepcopy(body),'public':public,'bundle':bundle,
                'base':base,'backend':release['backend'],'verification':release['verification'],'request':request,'createdAt':self.clock(),'expiresAt':self.clock()+86400}
        with self.transaction():
            record['initialization']=self.initialization(owner,record['projectId'],target)
            self.put('preparation',key,record)
            self.put('release',identifier('release-',[owner,ref]),{'bundle':bundle})
        await self.svc.deployments.register_release(owner,bundle)
        return public

    async def submit_directory(self, owner, release_id, body):
        self.svc.authorize_management(owner);self.authorize_owner(owner)
        record=self.get('preparation',body.get('preparationId')) if isinstance(body,dict) else None
        if not record or record['owner']!=owner or record['releaseId']!=release_id:
            raise StudioError('DEPLOYMENT_PREPARATION_NOT_FOUND',404)
        return await super().submit(owner,record['projectId'],body)

    async def check(self, op, bundle, phase):
        self.assert_source(op['owner'],op['target'],operation=True)
        self.authorize_owner(op['owner']);record=self.record(op)
        expected={**record['request'],'idempotencyKey':op['request']['idempotencyKey']}
        if expected!=op['request'] or bundle!=record['bundle'] or record['expiresAt']<self.clock():
            raise Blocked('PROVENANCE_INVALID')
        frozen=self.intake.get(op['owner'],record['releaseId'])
        if frozen['directoryDigest']!=record['directoryDigest'] or frozen['bundle']!=bundle:
            raise Blocked('PROVENANCE_INVALID')
        if shutil.disk_usage(self.svc.store.root).free<(len(canonicalize_json(metadata(record['base'])).encode())+len(record['base'].get('packageBase64','')))*4:
            raise Blocked('INSUFFICIENT_RESOURCES')
        if phase=='commit' and self.experts.busy(op['owner'],self.slot_id(op['owner'],op['target'])):
            raise Blocked('DEPENDENCY_UNAVAILABLE')
        if op['target']['environment']=='prod' and phase in {'validating','preflight','commit'}:
            dev=self.svc.deployments.journal.get_environment({**op['target'],'environment':'dev'})
            if dev['health']!='healthy' or dev['activeReleaseRef']!=op['request']['releaseRef']:
                raise Blocked('REGRESSION_EVIDENCE_MISMATCH')
        return Plan(())

    def assert_candidate_intent(self, op):
        self.assert_source(op['owner'],op['target'],operation=True)
        self.authorize_owner(op['owner'])
        current=self.svc.deployments.journal.get_operation(op['owner'],op['id'])
        env=self.svc.deployments.journal.get_environment(op['target'])
        if current['state'] in TERMINAL or current['phase'] not in {'prepare_backend','prepare_client','prepare_channels','prepare_data','verify_candidate'} or current['requestHash']!=op['requestHash'] or env['activeOperationId']!=op['id'] or env['generation']!=op['request']['expectedGeneration']:
            raise StudioError('DEPLOYMENT_LEASE_LOST',409)

    async def prepare_expert(self, op, record):
        try:
            binding=await self.experts.prepare(op['owner'],op['target'],record['projectId'],record['backend'],lambda:self.assert_candidate_intent(op))
            binding={**binding,'generation':op['request']['expectedGeneration']+1,'operationId':op['id']}
            with self.transaction():
                self.assert_candidate_intent(op)
                self.put('candidate',op['id'],{'owner':op['owner'],'target':op['target'],'expertBinding':binding,
                                              'manifest':record['base']['manifest'],'artifactHash':record['base']['artifactHash']})
                self.db.execute('DELETE FROM deployment_profile_objects WHERE kind=? AND key=?',(self.object_kind('prepare-error'),op['id']))
        except asyncio.CancelledError:
            raise
        except (Blocked,StudioError) as error:
            if getattr(error,'code',None) not in {'DEPLOYMENT_LEASE_LOST','FENCING_CONFLICT'}:
                self.prepare_error(op,'DEPENDENCY_UNAVAILABLE')
        except Exception:
            self.prepare_error(op,'ADAPTER_UNCERTAIN')

    def prepare_error(self, op, code):
        with self.transaction():
            old=self.get('prepare-error',op['id']) or {}
            self.put('prepare-error',op['id'],{'code':code,'attempts':old.get('attempts',0)+1,'retryAt':self.clock()+2})

    async def inspect(self, step, op, bundle):
        if step=='prepare_backend':
            self.assert_current(op)
            task=self.preparing.get(op['id'])
            if task and not task.done():return Observation('waiting_box',code='DEPENDENCY_UNAVAILABLE')
            error=self.get('prepare-error',op['id'])
            if error:
                if error['attempts']>=3:return Observation('failed',code=error['code'])
                if error['retryAt']>self.clock():return Observation('waiting_box',code=error['code'])
        return await super().inspect(step,op,bundle)

    async def execute(self, step, op, bundle):
        self.assert_current(op);record=self.record(op)
        if step=='prepare_backend':
            candidate=self.get('candidate',op['id'])
            if candidate:
                await self.experts.verify(op['owner'],candidate['expertBinding'],lambda:self.assert_current(op))
                with self.transaction():
                    self.assert_current(op)
                    self.put('effect',identifier('effect-',[op['id'],step]),{'fence':op['fence'],'done':True})
                return Observation('done')
            task=self.preparing.get(op['id'])
            if not task or task.done():
                task=asyncio.create_task(self.prepare_expert(deepcopy(op),record),context=Context())
                self.preparing[op['id']]=task;self.svc.background.add(task);task.add_done_callback(self.svc.background.discard)
            return Observation('waiting_box',code='DEPENDENCY_UNAVAILABLE')
        if step=='verify_candidate':
            candidate=self.get('candidate',op['id'])
            if not candidate:raise Blocked('ADAPTER_UNCERTAIN')
            verification=record['verification']['checks'][0]
            probe=await self.experts.probe(op['owner'],candidate['expertBinding'],op['id'],lambda:self.assert_candidate_intent(op),text=verification['input']['text'])
            if probe['state'] in {'queued','running','cancel_requested'}:
                return Observation('waiting_box',code='DEPENDENCY_UNAVAILABLE')
            if probe['state']!='succeeded' or verification['expected']['contains'] not in (probe.get('result') or ''):
                return Observation('failed',code='DEPENDENCY_UNAVAILABLE')
            with self.transaction():self.put('probe',op['id'],{'runId':probe['id'],'state':'succeeded'})
        if step in {'activate','verify_active'}:
            candidate=self.get('candidate',op['id'])
            if not candidate:raise Blocked('ADAPTER_UNCERTAIN')
            await self.experts.verify(op['owner'],candidate['expertBinding'],lambda:self.assert_current(op))
            if step=='verify_active':
                binding=self.find_binding(op['owner'],self.slot_id(op['owner'],op['target']))
                proof={'operationId':op['id'],'artifactHash':record['base']['artifactHash'],'generation':op['committedGeneration']}
                if not binding or binding.get('expertClientReady')!=proof:
                    return Observation('waiting_client',code='CLIENT_UNAVAILABLE')
        return await super().execute(step,op,bundle)

    def mark_client_ready(self, owner, token):
        with self.transaction():
            if self.svc.runtime_sessions.get(token,{}).get('standardExpertContract'):
                from .standard_runtime import assert_session
                session=assert_session(self.svc,owner,token)
            else:session=self.svc.runtime(owner,token)
            binding=self.find_binding(owner,session['deploymentSlot'])
            if not binding or not binding.get('expertBinding'):raise StudioError('EXPERT_BINDING_REQUIRED',403)
            binding['expertClientReady']={'operationId':binding['operationId'],'artifactHash':binding['artifactHash'],'generation':binding['generation']}
            self.put('binding',self.slot_key(owner,binding['target']),binding)

    def activation_binding(self, op, record):
        binding=super().activation_binding(op,record)
        candidate=self.get('candidate',op['id'])
        if not candidate or not self.get('probe',op['id']):raise Blocked('DEPENDENCY_UNAVAILABLE')
        binding['expertBinding']=deepcopy(candidate['expertBinding'])
        binding['directoryDigest']=record['directoryDigest'];binding['releaseId']=record['releaseId']
        return binding

    def initialization(self, owner, project_id, target):
        initialized=self.get('binding',self.slot_key(owner,target)) is not None
        rows=[]
        if not initialized and target['environment']=='prod':
            source=self.get('binding',self.slot_key(owner,{**target,'environment':'dev'}))
            if not source or source['state']!='active':raise StudioError('DEPLOYMENT_DEV_VERIFICATION_REQUIRED',409)
            scope=(owner,target['applicationId'],'deployment:dev')
            count,size=self.db.execute('SELECT count(*),coalesce(sum(length(CAST(body AS BLOB))),0) FROM records WHERE owner=? AND app=? AND environment=?',scope).fetchone()
            if count>20000 or size>16*1024*1024:raise Blocked('INSUFFICIENT_RESOURCES')
            rows=[list(row) for row in self.db.execute('SELECT collection,id,revision,body FROM records WHERE owner=? AND app=? AND environment=?',scope)]
        return {'initialized':initialized,'destination':'deployment:'+target['environment'],'rows':rows}

    def activate_data(self, op):
        data=self.get('data',op['id'])
        if not data:raise Blocked('ADAPTER_UNCERTAIN')
        if data['initialized']:return
        for collection,key,revision,body in data['rows']:
            self.db.execute('INSERT OR IGNORE INTO records VALUES(?,?,?,?,?,?,?)',(op['owner'],op['target']['applicationId'],data['destination'],collection,key,revision,body))

    def component_results(self, op, record):
        return tuple({'componentId':role,'role':role,'required':True,'status':'ready',
                      'actualReleaseRef':op['request']['releaseRef'],'actualVersion':record['base']['version']}
                     for role in ('backend','client'))
