"""Real, box-local miniapp deployment profile with durable client delivery.

Only process wiring can enable the profile. Browser input never supplies a box,
release body, execution authority, filesystem path or command.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import platform
import re
import secrets
import shutil
import stat
import sqlite3
import time
from copy import deepcopy
from contextlib import contextmanager
from uuid import uuid4

from ..contracts import StudioError, compatible
from ..versions import source_artifact, verify, idle
from .adapters import Blocked, Observation, Plan
from .contracts import canonicalize_json, bundle_digest, request_digest, validate_bundle
from .standard_client import is_standard,delivery_digest

PROFILE = 'wanx-miniapp-v1'
CAPABILITIES = frozenset({'data', 'model', 'files', 'knowledge'})
ID = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')


def sha(value):
    return 'sha256:' + hashlib.sha256(canonicalize_json(value).encode()).hexdigest()


def identifier(prefix, value):
    return prefix + hashlib.sha256(canonicalize_json(value).encode()).hexdigest()[:32]


def load_target(path, *, profile=PROFILE):
    """Load an explicitly enabled profile from a protected startup file."""
    # Unsupported hosts must not enable deployment without no-follow opening
    # and POSIX ownership checks, or prevent unrelated applications starting.
    if not hasattr(os, 'O_NOFOLLOW') or not hasattr(os, 'geteuid'):
        return None
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, 'r') as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > 4096 or info.st_uid not in {0, os.geteuid()} or info.st_mode & 0o022:
                return None
            value = json.load(stream)
        if set(value) != {'schemaVersion', 'enabled', 'profile', 'boxId', 'authorityMode'} or value['schemaVersion'] != 1 or value['enabled'] is not True or value['profile'] != profile or value['authorityMode'] != 'sso' or not ID.fullmatch(value['boxId']):
            return None
        actual = os.environ.get('WANX_PLATFORM_DEVICE_ID')
        return value if not actual or actual == value['boxId'] else None
    except (OSError, ValueError, TypeError, KeyError):
        return None


class MiniappProfile:
    supported_actions = ['deploy']
    profile_id = PROFILE

    def object_kind(self, kind):
        return kind

    def __init__(self, svc, target=None, authority=None, *, clock=time.time, source='workshop', source_registry=None):
        if source not in {'workshop','studio'}:raise ValueError('Unknown deployment source')
        self.svc, self.target, self.authority, self.clock = svc, deepcopy(target), authority, clock
        self.source=self.runtime_namespace=source
        self.source_registry=source_registry
        self.available = bool(target and authority)
        self.lock = svc.store.lock
        root = svc.store.root / 'deployment'
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
        # Bindings, data copies and effect evidence commit in ONE database.
        self.db = svc.store.db
        self.db.execute('CREATE TABLE IF NOT EXISTS deployment_profile_objects(kind TEXT,key TEXT,body TEXT NOT NULL,PRIMARY KEY(kind,key))')

    def close(self):
        pass # Store owns the shared database lifecycle

    @contextmanager
    def transaction(self):
        with self.svc.store.transaction():
            yield

    def get(self, kind, key):
        with self.lock:
            row = self.db.execute('SELECT body FROM deployment_profile_objects WHERE kind=? AND key=?', (self.object_kind(kind), key)).fetchone()
            return json.loads(row[0]) if row else None

    def put(self, kind, key, value):
        self.db.execute('INSERT INTO deployment_profile_objects VALUES(?,?,?) ON CONFLICT(kind,key) DO UPDATE SET body=excluded.body', (self.object_kind(kind),key,json.dumps(value,ensure_ascii=False)))

    def find_binding(self, owner, slot):
        if not isinstance(slot,str) or not re.fullmatch(r'ai\.wanx\.selfmade\.[a-f0-9]{32}',slot):return None
        binding=self.get('binding','slot-'+slot.rsplit('.',1)[1])
        if binding and binding['owner']==owner:
            self.assert_source(owner,binding['target'])
            return binding
        return None

    def claim_target(self, owner, target):
        if self.source_registry:self.source_registry.claim(self.source,owner,target)

    def assert_source(self, owner, target, *, operation=False, allow_unclaimed=False):
        if self.source_registry:
            try:self.source_registry.assert_source(self.source,owner,target,allow_unclaimed=allow_unclaimed)
            except StudioError:
                if operation:raise Blocked('RUNTIME_INCOMPATIBLE') from None
                raise

    def authorize_owner(self, owner):
        if not self.available:
            raise Blocked('DEPLOYMENT_ADAPTER_UNAVAILABLE')
        try:
            self.authority(owner)
        except Exception:
            raise Blocked('DEPLOYMENT_TARGET_DENIED') from None

    def target_for(self, owner, application_id, environment):
        if not isinstance(environment,str) or environment not in {'dev', 'prod'}:
            raise StudioError('DEPLOYMENT_ENVIRONMENT_INVALID',422)
        return {'organizationId':identifier('personal-', owner),'boxId':self.target['boxId'], 'applicationId':application_id,'environment':environment}

    def slot_id(self, owner, target):
        return identifier('ai.wanx.selfmade.', [owner,target])

    def slot_key(self, owner, target):
        return identifier('slot-', [owner,target])

    def context(self, owner, project_id):
        self.svc.authorize_management(owner)
        p = self.svc.store.get(owner, project_id)
        h = p.get('versioning',{}).get('adoptedHash') or (p.get('acceptance') or {}).get('artifactHash')
        a = source_artifact(p,h) if h else None
        result = {'schemaVersion':1,'profile':PROFILE,'available':self.available,'reason':None if self.available else 'DEPLOYMENT_ADAPTER_UNAVAILABLE','projectId':project_id,'applicationId':p['appId'],'artifact':{'hash':a['hash'],'version':a['version']} if a else None,'target':None,'environments':[],'supportedActions':self.supported_actions,'supportedCapabilities':sorted(CAPABILITIES)}
        if a and a.get('devKitPackage'):
            result.update(available=False,reason='STANDARD_DEPLOYMENT_CONTRACT_REQUIRED')
        elif a and set(a['manifest']['capabilities'])-CAPABILITIES:
            result.update(available=False,reason='RUNTIME_INCOMPATIBLE')
        if self.available:
            self.authorize_owner(owner)
            target = self.target_for(owner,p['appId'],'dev')
            result['target'] = {k:v for k,v in target.items() if k != 'environment'}
            for env in ('dev','prod'):
                target=self.target_for(owner,p['appId'],env)
                self.assert_source(owner,target,allow_unclaimed=True)
                state = self.svc.deployments.journal.get_environment(target)
                result['environments'].append({'id':env, **{k:state.get(k) for k in ('generation','health','activeReleaseRef')}})
        return result

    def frozen_release(self, owner, p, a):
        verify(a)
        base = {'applicationId':p['appId'],'name':a['manifest']['name'],'version':a['version'],'artifactHash':a['hash'],'manifest':a['manifest'],'bundle':a['bundle'],'css':a['css'],'runtimeNamespace':self.runtime_namespace}
        if getattr(self.svc,'workshop',False) and a.get('files'):
            from ..contracts import digest
            base['editable'] = {'allowed':True,'format':'wanx-miniapp-source-v1','applicationId':p['appId'],'version':a['version'],'sourceHash':digest(a['files']),'files':deepcopy(a['files']),'origin':'local'}
        backend = {'profile':PROFILE,'artifactHash':a['hash'],'manifest':deepcopy(a['manifest'])}
        release_id=identifier('miniapp-', [p['appId'],a['hash']])
        runtime={'id':PROFILE,'revision':1}
        descriptors=[]
        for role, value in [('backend',backend),('client',base)]:
            descriptors.append({'artifactId':role+'-'+a['hash'][:32],'role':role,'mediaType':'application/json','digest':sha(value),'sizeBytes':len(canonicalize_json(value).encode()),'sourceRef':{'id':release_id+'-'+role,'digest':sha(value)},'platforms':[{'os':'linux' if role=='backend' else 'darwin','arch':platform.machine().lower().replace('x86_64','x64').replace('aarch64','arm64') if role=='backend' else 'arm64'}]})
        descriptors[1]['platforms']=[{'os':os_name,'arch':arch} for os_name in ('darwin','linux','win32') for arch in ('x64','arm64')]
        bundle={'schemaVersion':1,'releaseId':release_id,'applicationId':p['appId'],'payloadKind':'packaged-app','artifactDescriptors':descriptors,'dependencyLockDigest':sha({'runtime':runtime,'capabilities':sorted(a['manifest']['capabilities'])}),'runtimeRequirements':{'runtimeRef':runtime,'platforms':[{'os':'linux','arch':platform.machine().lower().replace('x86_64','x64').replace('aarch64','arm64')}],'resourceBudget':{'memoryBytes':16777216,'storageBytes':len(canonicalize_json(base).encode())*4},'healthContractRef':runtime,'dataCompatibilityRef':{'id':'miniapp-schema-additive-v1','revision':1},'candidateMode':True},'clientDelivery':{'mode':'install','artifactId':descriptors[1]['artifactId']},'provenanceRef':{'id':release_id,'revision':1}}
        bundle['bundleDigest']=bundle_digest(bundle)
        return validate_bundle(bundle),base,backend

    async def prepare(self, owner, project_id, body):
        self.svc.authorize_management(owner)
        self.authorize_owner(owner)
        if set(body)!={'artifactHash','expectedRevision','environment','operationId'} or not re.fullmatch('[a-f0-9]{32}',str(body['operationId'])) or type(body['expectedRevision']) is not int:
            raise StudioError('DEPLOYMENT_PREPARATION_INVALID',422)
        key=identifier('prepare-', [owner,project_id,body['operationId']])
        with self.lock:
            old=self.get('preparation',key)
        if old:
            if old['body']!=body:raise StudioError('DEPLOYMENT_IDEMPOTENCY_CONFLICT',409)
            self.claim_target(owner,old['request']['target'])
            await self.svc.deployments.register_release(owner,old['bundle'])
            return deepcopy(old['public'])
        p=self.svc.store.get(owner,project_id);idle(p)
        if p.get('versioning',{}).get('revision',0)!=body['expectedRevision'] or p.get('versioning',{}).get('adoptedHash')!=body['artifactHash']:
            raise StudioError('DEPLOYMENT_VERSION_CHANGED',409)
        a=source_artifact(p,body['artifactHash'])
        if a.get('devKitPackage'):raise StudioError('STANDARD_DEPLOYMENT_CONTRACT_REQUIRED',409)
        if set(a['manifest']['capabilities'])-CAPABILITIES:raise StudioError('RUNTIME_INCOMPATIBLE',409)
        bundle,base,backend=self.frozen_release(owner,p,a)
        target=self.target_for(owner,p['appId'],body['environment'])
        self.claim_target(owner,target)
        state=self.svc.deployments.journal.get_environment(target)
        ref={'releaseId':bundle['releaseId'],'bundleDigest':bundle['bundleDigest']}
        regression=None
        if body['environment']=='prod':
            dev=self.svc.deployments.journal.get_environment(self.target_for(owner,p['appId'],'dev'))
            if dev.get('health')!='healthy' or dev.get('activeReleaseRef')!=ref:
                raise StudioError('DEPLOYMENT_DEV_VERIFICATION_REQUIRED',409)
            regression={'id':identifier('regression-', [owner,ref]),'revision':dev['revision']}
        previous=self.get('binding',self.slot_key(owner,target))
        if previous and not compatible(previous['manifest'],a['manifest']):raise StudioError('BREAKING_SCHEMA_CHANGE',409)
        reference={'id':key,'revision':1}
        request={'schemaVersion':1,'kind':'deploy','target':target,'releaseRef':ref,'expectedGeneration':state['generation'],'idempotencyKey':'pending','decisionRef':reference,'validationRef':reference,'bindingSetRef':reference,'channelBindingsRef':reference,'dataPlanRef':reference}
        if regression:request['regressionRef']=regression
        public={'schemaVersion':1,'preparationId':key,'projectId':project_id,'artifactHash':a['hash'],'environment':body['environment'],'expectedGeneration':state['generation'],'releaseRef':ref,'target':target}
        record={'owner':owner,'projectId':project_id,'body':deepcopy(body),'public':public,'bundle':bundle,'base':base,'backend':backend,'request':request,'createdAt':self.clock(),'expiresAt':self.clock()+86400}
        with self.transaction():
            # Data and the grants referenced by that data freeze together. Never
            # borrow preview grants or copy platform credentials/file contents.
            record['initialization']=self.initialization(owner,project_id,target)
            self.put('preparation',key,record)
            self.put('release',identifier('release-',[owner,ref]),{'bundle':bundle})
        await self.svc.deployments.register_release(owner,bundle)
        return public

    async def submit(self, owner, project_id, body):
        self.svc.authorize_management(owner);self.authorize_owner(owner)
        if set(body)!={'preparationId','idempotencyKey'} or not isinstance(body['preparationId'],str) or not ID.fullmatch(body['preparationId']) or not isinstance(body['idempotencyKey'],str) or not ID.fullmatch(body['idempotencyKey']):
            raise StudioError('DEPLOYMENT_PREPARATION_INVALID',422)
        with self.lock:
            record=self.get('preparation',body['preparationId'])
        if not record or record['owner']!=owner or record['projectId']!=project_id:raise StudioError('DEPLOYMENT_PREPARATION_NOT_FOUND',404)
        await self.svc.deployments.register_release(owner,record['bundle'])
        request=deepcopy(record['request']);request['idempotencyKey']=body['idempotencyKey']
        return await self.svc.deployments.submit(owner,request)

    async def authorize(self, owner, target, action):
        self.authorize_owner(owner)
        if action not in {'read','deploy'} or target!=self.target_for(owner,target['applicationId'],target['environment']):raise Blocked('DEPLOYMENT_TARGET_DENIED')
        self.assert_source(owner,target,operation=True)

    async def verify_release(self, owner, bundle):
        self.authorize_owner(owner)
        ref={'releaseId':bundle['releaseId'],'bundleDigest':bundle['bundleDigest']}
        record=self.get('release',identifier('release-',[owner,ref]))
        if not record or record['bundle']!=bundle:raise Blocked('PROVENANCE_INVALID')

    def record(self, operation):
        preparation=operation['request'].get('decisionRef',{}).get('id')
        record=self.get('preparation',preparation) if preparation else None
        if not record or record['owner']!=operation['owner']:raise Blocked('VERSION_NOT_PUBLISHED')
        return record

    async def check(self, operation, bundle, phase):
        self.assert_source(operation['owner'],operation['target'],operation=True)
        self.authorize_owner(operation['owner']);record=self.record(operation)
        expected=deepcopy(record['request']);expected['idempotencyKey']=operation['request']['idempotencyKey']
        if operation['request']!=expected or bundle!=record['bundle'] or record['expiresAt']<self.clock():raise Blocked('PROVENANCE_INVALID')
        p=self.svc.store.get(operation['owner'],record['projectId']);verify(source_artifact(p,record['base']['artifactHash']))
        if phase in {'validating','preflight','commit'}:
            if shutil.disk_usage(self.svc.store.root).free < len(canonicalize_json(record['base']).encode())*4:raise Blocked('INSUFFICIENT_RESOURCES')
            if operation['target']['environment']=='prod':
                dev=self.svc.deployments.journal.get_environment(self.target_for(operation['owner'],operation['target']['applicationId'],'dev'))
                if dev['health']!='healthy' or dev['activeReleaseRef']!=operation['request']['releaseRef']:raise Blocked('REGRESSION_EVIDENCE_MISMATCH')
        return Plan(())

    def ticket(self, op, step, record):
        key=identifier('',[op['id'],step]);old=self.get('ticket',key)
        if old:return old
        generation=op['request']['expectedGeneration']+1;slot=self.slot_id(op['owner'],op['target'])
        payload=deepcopy(record['base'])
        if not is_standard(payload):
            payload['applicationId']=slot
            payload['name']=record['base']['name']+(' · 联调' if op['target']['environment']=='dev' else ' · 正式')
        if payload.get('editable'):payload['editable']['applicationId']=slot
        payload['deployment']={'schemaVersion':1,'profile':self.profile_id,'slotApplicationId':slot,'baseApplicationId':op['target']['applicationId'],'boxId':op['target']['boxId'],'operationId':op['id'],'environment':op['target']['environment'],'generation':generation}
        if is_standard(payload):payload['deployment']['scopeId']=sha([op['owner'],op['target'],slot,'run'])[7:]
        ticket={'id':key,'owner':op['owner'],'nonce':secrets.token_urlsafe(24),'operationId':op['id'],'step':step,'fence':op['fence'],'generation':generation,'projectId':record['projectId'],'artifactHash':record['base']['artifactHash'],'baseApplicationId':op['target']['applicationId'],'slotApplicationId':slot,'version':record['base']['version'],'environment':op['target']['environment'],'boxId':op['target']['boxId'],'profile':self.profile_id,'payloadDigest':delivery_digest(payload),'payload':payload,'state':'pending','clientId':None,'claimUntil':0}
        if is_standard(payload):ticket['scopeId']=payload['deployment']['scopeId']
        self.put('ticket',key,ticket);return ticket

    def component_results(self, op, record):
        ref=op['request']['releaseRef'];out=[]
        for descriptor in record['bundle']['artifactDescriptors']:
            out.append({'componentId':descriptor['role'],'role':descriptor['role'],'required':True,'status':'ready','actualReleaseRef':ref,'actualVersion':record['base']['version']})
        return tuple(out)

    async def inspect(self, step, operation, bundle):
        self.authorize_owner(operation['owner'])
        with self.lock:
            record=self.record(operation);effect=self.get('effect',identifier('effect-',[operation['id'],step]))
            self.assert_current(operation)
            if effect and effect['done']:return Observation('done', self.component_results(operation,record) if step=='verify_active' else ())
            if step in {'prepare_client','activate'}:
                ticket=self.get('ticket',identifier('',[operation['id'],step]))
                if ticket:
                    expected='prepared' if step=='prepare_client' else 'active'
                    if ticket['state']==expected:
                        with self.transaction():self.put('effect',identifier('effect-',[operation['id'],step]),{'fence':operation['fence'],'done':True})
                        return Observation('done')
                    return Observation('waiting_client',code=ticket.get('lastError','CLIENT_UNAVAILABLE'))
            # A missing profile row proves no transaction committed for this step;
            # cross-database data application is idempotent and independently sealed.
            return Observation('not_started')

    def assert_current(self, op):
        self.assert_source(op['owner'],op['target'],operation=True)
        live=self.svc.deployments.journal.get_operation(op['owner'],op['id'])
        if live['fence']!=op['fence'] or live['leaseOwner']!=op['leaseOwner'] or live['leaseUntil']<=self.clock() or live['state'] in {'succeeded','rejected','failed_recovered','failed_degraded','recovery_required'}:
            raise StudioError('DEPLOYMENT_LEASE_LOST',409)
        environment=self.svc.deployments.journal.get_environment(op['target'])
        if environment['activeOperationId']!=op['id'] or environment['generation']!=(op['committedGeneration'] if op['commitStatus']=='committed' else op['previousGeneration']):
            raise StudioError('FENCING_CONFLICT',409)

    def activation_binding(self, op, record):
        return {'owner':op['owner'],'target':op['target'],'slotApplicationId':self.slot_id(op['owner'],op['target']),'projectId':record['projectId'],'artifactHash':record['base']['artifactHash'],'manifest':record['base']['manifest'],'generation':op['committedGeneration'],'operationId':op['id'],'state':'activating','base':record['base']}

    async def execute(self, step, op, bundle):
        self.authorize_owner(op['owner'])
        with self.transaction():
            self.assert_current(op)
            record=self.record(op);key=identifier('effect-',[op['id'],step]);effect=self.get('effect',key)
            if effect and effect['fence']>op['fence']:raise Blocked('GENERATION_CONFLICT')
            if effect and effect['done']:return Observation('done',self.component_results(op,record) if step=='verify_active' else ())
            effect={'fence':op['fence'],'done':False};self.put('effect',key,effect)
            if step=='prepare_backend':
                self.put('candidate',op['id'],{'owner':op['owner'],'target':op['target'],'manifest':record['backend']['manifest'],'artifactHash':record['base']['artifactHash']})
            elif step in {'prepare_client','activate'}:
                if step=='activate':
                    if op['commitStatus']!='committed':raise Blocked('GENERATION_CONFLICT')
                    binding=self.activation_binding(op,record)
                    previous=self.get('binding',self.slot_key(op['owner'],op['target']))
                    if previous and previous['generation']>binding['generation']:raise Blocked('GENERATION_CONFLICT')
                    self.put('binding',self.slot_key(op['owner'],op['target']),binding)
                    self.activate_data(op)
                ticket=self.ticket(op,step,record)
                if ticket['state'] not in {'prepared' if step=='prepare_client' else 'active'}:return Observation('waiting_client',code=ticket.get('lastError','CLIENT_UNAVAILABLE'))
                if step=='activate':
                    binding['state']='active';self.put('binding',self.slot_key(op['owner'],op['target']),binding)
            elif step=='prepare_channels':
                pass # this profile declares and resolves zero required Channels
            elif step=='prepare_data':
                self.prepare_data(op,record)
            elif step=='verify_candidate':
                if not self.get('candidate',op['id']) or not self.get('data',op['id']):raise Blocked('ADAPTER_UNCERTAIN')
                if self.get('ticket',identifier('',[op['id'],'prepare_client']))['state']!='prepared':return Observation('waiting_client',code='CLIENT_UNAVAILABLE')
            elif step=='verify_active':
                binding=self.get('binding',self.slot_key(op['owner'],op['target']))
                if not binding or binding['operationId']!=op['id'] or binding['state']!='active':return Observation('unknown')
                if binding.get('runtimeReady')!={'operationId':op['id'],'artifactHash':record['base']['artifactHash'],'generation':op['committedGeneration']}:return Observation('waiting_client',code='CLIENT_UNAVAILABLE')
            elif step=='compensate':
                self.put('candidate',op['id'],{'discarded':True})
                for row in self.db.execute("SELECT body FROM deployment_profile_objects WHERE kind=? AND json_extract(body,'$.operationId')=?",(self.object_kind('ticket'),op['id'])).fetchall():
                    ticket=json.loads(row[0])
                    if ticket['operationId']==op['id']:ticket['state']='cancelled';self.put('ticket',ticket['id'],ticket)
            else:raise Blocked('RUNTIME_INCOMPATIBLE')
            effect['done']=True;self.put('effect',key,effect)
            return Observation('done',self.component_results(op,record) if step=='verify_active' else ())

    def initialization(self, owner, project_id, target):
        destination='deployment:'+target['environment']
        initialized=self.get('binding',self.slot_key(owner,target)) is not None
        rows=[]
        resources={}
        if not initialized:
            source='production'
            if target['environment']=='prod':
                binding=self.get('binding',self.slot_key(owner,{**target,'environment':'dev'}))
                if not binding or binding['state']!='active':raise StudioError('DEPLOYMENT_DEV_VERIFICATION_REQUIRED',409)
                source='deployment:dev'
            p=self.svc.store.get(owner,project_id)
            grants=p.get('_runtimeSources',{}).get(source,{})
            model=p.get('_runtimeModel',{}) if source=='production' else p.get('_runtimeModels',{}).get(source,{})
            resources={'sources':{kind:deepcopy(grants[kind]) for kind in ('files','knowledge') if kind in grants},
                       'model':{key:deepcopy(model[key]) for key in ('revision','modelId','label') if key in model}}
            scope=(owner,target['applicationId'],source)
            count,size=self.db.execute('SELECT count(*),coalesce(sum(length(CAST(body AS BLOB))),0) FROM records WHERE owner=? AND app=? AND environment=?',scope).fetchone()
            resource_size=len(canonicalize_json(resources).encode())
            if count>20000 or size+resource_size>16*1024*1024 or shutil.disk_usage(self.svc.store.root).free<(size+resource_size)*3:raise Blocked('INSUFFICIENT_RESOURCES')
            rows=[list(row) for row in self.db.execute('SELECT collection,id,revision,body FROM records WHERE owner=? AND app=? AND environment=?',scope)]
        return {'initialized':initialized,'destination':destination,'rows':rows,'resources':resources}

    def prepare_data(self, op, record):
        # Old persisted data-only preparations remain resumable after upgrading.
        data=record.get('initialization')
        if data is None:data=self.initialization(op['owner'],record['projectId'],op['target'])
        self.put('data',op['id'],data)

    def activate_data(self, op):
        data=self.get('data',op['id'])
        if not data:raise Blocked('ADAPTER_UNCERTAIN')
        if data['initialized']:return
        for collection,record_id,revision,body in data['rows']:
            self.svc.store.db.execute('INSERT OR IGNORE INTO records VALUES(?,?,?,?,?,?,?)',(op['owner'],op['target']['applicationId'],data['destination'],collection,record_id,revision,body))
        resources=data.get('resources',{})
        p=self.svc.store.get(op['owner'],self.record(op)['projectId'])
        p.setdefault('_runtimeSources',{})[data['destination']]=deepcopy(resources.get('sources',{}))
        p.setdefault('_runtimeModels',{})[data['destination']]=deepcopy(resources.get('model',{}))
        self.svc.store.save(p)

    def delivery_list(self, owner):
        self.svc.authorize_management(owner);self.authorize_owner(owner)
        items=[]
        with self.lock:
            cursor=self.db.execute("SELECT key,json_extract(body,'$.state'),json_extract(body,'$.step'),json_extract(body,'$.slotApplicationId'),json_extract(body,'$.operationId') FROM deployment_profile_objects WHERE kind=? AND json_extract(body,'$.owner')=? AND json_extract(body,'$.state') IN ('pending','active') ORDER BY key",(self.object_kind('ticket'),owner))
            for key,state,step,slot,operation_id in cursor:
                if state=='active':
                    binding=self.find_binding(owner,slot)
                    if step!='activate' or not binding or binding['operationId']!=operation_id or binding.get('runtimeReady'):continue
                try:ticket=self.owned_ticket(owner,key)
                except StudioError:continue
                items.append(self.public_ticket(ticket))
                if len(items)==100:break
        return {'items':items}

    @staticmethod
    def public_ticket(ticket):
        return {k:deepcopy(v) for k,v in ticket.items() if k not in {'owner','payload','claimUntil'}}

    def delivery_claim(self, owner, ticket_id, body):
        self.svc.authorize_management(owner);self.authorize_owner(owner)
        if set(body)!={'nonce','clientId'} or not ID.fullmatch(str(body['clientId'])):raise StudioError('DEPLOYMENT_CLAIM_INVALID',422)
        with self.transaction():
            ticket=self.owned_ticket(owner,ticket_id)
            if body['nonce']!=ticket['nonce']:raise StudioError('DEPLOYMENT_TICKET_STALE',409)
            if ticket['clientId'] not in {None,body['clientId']}:
                if ticket['claimUntil']>self.clock():raise StudioError('DEPLOYMENT_CLIENT_BUSY',409)
                ticket['nonce']=secrets.token_urlsafe(24)
            ticket['clientId']=body['clientId'];ticket['claimUntil']=self.clock()+60
            self.put('ticket',ticket_id,ticket)
            return self.public_ticket(ticket)

    def owned_ticket(self, owner, ticket_id):
        ticket=self.get('ticket',ticket_id)
        if not ticket or ticket['owner']!=owner:raise StudioError('DEPLOYMENT_DELIVERY_NOT_FOUND',404)
        op=self.svc.deployments.journal.get_operation(owner,ticket['operationId'])
        self.assert_source(owner,op['target'])
        if op['state'] in {'rejected','failed_recovered','failed_degraded','recovery_required','compensating'} or ticket['state']=='cancelled':raise StudioError('DEPLOYMENT_TICKET_STALE',409)
        return ticket

    def delivery_payload(self, owner, ticket_id):
        self.svc.authorize_management(owner);self.authorize_owner(owner)
        return deepcopy(self.owned_ticket(owner,ticket_id)['payload'])

    def delivery_ack(self, owner, ticket_id, body):
        self.svc.authorize_management(owner);self.authorize_owner(owner)
        fields={'nonce','clientId','state','artifactHash','slotApplicationId','operationId','step','fence','generation','payloadDigest'}
        failed=body.get('state')=='failed'
        if set(body)!=(fields|{'errorCode'} if failed else fields) or (failed and body['errorCode']!='CLIENT_UNAVAILABLE'):raise StudioError('DEPLOYMENT_ACK_INVALID',422)
        if any(type(body[key]) is not int for key in ('generation','fence')):
            raise StudioError('DEPLOYMENT_ACK_INVALID',422)
        with self.transaction():
            ticket=self.owned_ticket(owner,ticket_id)
            if any(body[k]!=ticket[k] for k in fields-{'state'}) or ticket['claimUntil']<self.clock() or (not failed and body['state']!=('prepared' if ticket['step']=='prepare_client' else 'active')):
                raise StudioError('DEPLOYMENT_ACK_MISMATCH',409)
            if failed:ticket['lastError']=body['errorCode']
            else:
                ticket['state']=body['state'];ticket.pop('lastError',None)
                current=self.svc.deployments.journal.get_operation(owner,ticket['operationId'])
                self.put('effect',identifier('effect-',[ticket['operationId'],ticket['step']]),{'fence':current['fence'],'done':True})
                if ticket['step']=='activate':
                    binding=self.find_binding(owner,ticket['slotApplicationId'])
                    if current['commitStatus']!='committed' or current['committedGeneration']!=ticket['generation']:raise StudioError('DEPLOYMENT_TICKET_STALE',409)
                    if not binding or binding['operationId']!=ticket['operationId'] or binding['generation']!=ticket['generation']:raise StudioError('DEPLOYMENT_TICKET_STALE',409)
                    binding['state']='active';self.put('binding',self.slot_key(owner,binding['target']),binding)
            self.put('ticket',ticket_id,ticket)
            return {'accepted':True}

    async def deliver(self, receipt):
        with self.transaction():self.put('receipt',receipt['receiptId'],receipt)
        return receipt['receiptId']

    def open_runtime(self, owner, slot_id, body):
        self.svc.authorize_management(owner);self.authorize_owner(owner)
        if set(body)!={'artifactHash','environment','generation'} or type(body['generation']) is not int or body['generation']<1 or not isinstance(body['environment'],str) or body['environment'] not in {'dev','prod'} or not isinstance(body['artifactHash'],str):raise StudioError('DEPLOYMENT_RUNTIME_INVALID',422)
        binding=self.find_binding(owner,slot_id)
        if not binding or binding['state']!='active' or binding['artifactHash']!=body['artifactHash'] or binding['generation']!=body['generation'] or binding['target']['environment']!=body['environment']:
            raise StudioError('DEPLOYMENT_RUNTIME_STALE',409)
        if is_standard(binding['base']):
            from .standard_runtime import mint_sso_launch
            return mint_sso_launch(self.svc,self,owner,binding)
        token=secrets.token_urlsafe(32)
        self.svc.runtime_sessions[token]={'owner':owner,'project':binding['projectId'],'app':binding['target']['applicationId'],'artifact':binding['artifactHash'],'environment':'deployment:'+binding['target']['environment'],'manifest':binding['manifest'],'files':{},'expires':self.clock()+3600,'deploymentSlot':slot_id,'deploymentGeneration':binding['generation'],'deploymentProfile':self.profile_id}
        binding['runtimeReady']={'operationId':binding['operationId'],'artifactHash':binding['artifactHash'],'generation':binding['generation']}
        with self.transaction():self.put('binding',self.slot_key(owner,binding['target']),binding)
        base=binding['base']
        return {'session':token,'manifest':base['manifest'],'bundle':base['bundle'],'css':base['css']}

    def assert_runtime(self, session):
        if not session.get('deploymentSlot'):return
        self.authorize_owner(session['owner'])
        binding=self.find_binding(session['owner'],session['deploymentSlot'])
        if not binding or binding['state']!='active' or binding['generation']!=session['deploymentGeneration'] or binding['artifactHash']!=session['artifact']:
            raise StudioError('UPDATE_REQUIRED',409)


def _sso_user(services, owner):
    """Recheck the persisted user, matching PersonalWorkshop's SSO authority.

    The authenticated HTTP dependency already checked the requesting application
    and bound owner to its real user. application_id is a request/token audience,
    not the database user's durable permission to resume an accepted operation.
    Never retain or reconstruct that request token in the background worker.
    """
    if not isinstance(owner,str) or not re.fullmatch(r'wanx:[0-9]+',owner):raise PermissionError()
    user=services.user_repo.get(int(owner.split(':')[1]))
    if user is None or user.disabled or getattr(user,'local_data',False):raise PermissionError()
    return user


def authorize_sso_owner(services,owner):
    _sso_user(services,owner)


def authorize_sso_admin(services,owner):
    if _sso_user(services,owner).role!='admin':raise PermissionError()


def configure(svc, services, target_path, *, server=None, source=None):
    """Wire a persistent SSO authority; local-trust task grants are not inferred."""
    expected='workshop' if getattr(svc,'workshop',False) else 'studio'
    source=source or expected
    if source!=expected:raise ValueError('Deployment source does not match service')
    target=None
    def authority(owner):
        (authorize_sso_admin if source=='studio' else authorize_sso_owner)(services,owner)
    registry=None
    expert_target=load_target(target_path.with_name('deployment-expert-target.json'),profile='wanx-expert-app-v1') if server is not None else None
    if svc.local_authority.required():expert_target=None
    if server is not None and (target or expert_target):
        from .source_registry import for_server
        try:registry=for_server(server,target_path.parent)
        except (OSError,ValueError,StudioError,sqlite3.Error):
            # Invalid routing state must disable deployment, not the editor or
            # unrelated platform applications. Never silently ignore the guard.
            target=expert_target=None
    profile=MiniappProfile(svc,target,authority if target else None,source=source,source_registry=registry)
    if server is not None:
        from .expert_profile import ExpertProfile
        from .profiles import DeploymentProfiles
        runtime=intake=None
        if expert_target:
            from .expert_runtime import ExpertRuntime, validate_backend
            from .intake import ReleaseIntake
            runtime=ExpertRuntime(svc,server,authority=authority)
            intake=ReleaseIntake(svc.store,target_path.parent/'deployment-inbox',svc.store.root/'deployment'/'release-snapshots',backend_validator=validate_backend,runtime_namespace=source)
        svc.expert_runtime=runtime
        svc.directory_profile=ExpertProfile(svc,expert_target,authority if expert_target else None,runtime=runtime,intake=intake,source=source,source_registry=registry)
        profile=DeploymentProfiles(profile,svc.directory_profile)
    svc.deployment_profile=profile
    svc.deployments.adapter=profile
    return profile
