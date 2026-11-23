"""Project-owned immutable versions and an explicit, single improvement line."""
from .public_capabilities import expert_contract
from copy import deepcopy
from itertools import chain
import time
from uuid import uuid4
from .contracts import StudioError, digest

ACTIVE={'queued','running','waiting'}

def idle(p, pending=True):
    direct=p.get('_edits',{}).get('enabled')
    if direct and any(e['state'] in {'queued','preparing','building','validating','clarifying'} for e in p['_edits']['items']):raise StudioError('BUILD_ACTIVE',409)
    if not direct and pending and any(t.get('state') in {'queued','paused'} for t in p.get('preparation',{}).get('interview',{}).get('turns',[])):raise StudioError('PRD_NOT_SYNCHRONIZED',409)
    if any(t['state'] in ACTIVE for t in p['tasks']):raise StudioError('BUILD_ACTIVE',409)
    if not direct and p.get('preparation',{}).get('interview',{}).get('state')=='running':raise StudioError('INTERVIEW_BUSY',409)

def next_version(p):
    artifacts = p["artifacts"]
    # Older projects used the artifact count. Imports and pruning can leave gaps.
    highest = max(len(artifacts) - 1, p.get("_versionSequence", -1))
    for artifact in chain(artifacts, p.get("_cleanedVersions", [])):
        patch = str(artifact.get("version", "")).rsplit(".", 1)[-1]
        if patch.isascii() and patch.isdecimal():
            highest = max(highest, int(patch))
    sequence = highest + 1
    if p.get("workshop"):
        p["_versionSequence"] = sequence
    return f"0.1.{sequence}"

def state(p):
    if 'versioning' in p:return deepcopy(p['versioning'])
    adopted=p.get('acceptance') or p.get('installed')
    h=adopted.get('artifactHash') if adopted else None
    return {'revision':0,'adoptedHash':h,'adoptions':[{'artifactHash':h,'at':adopted.get('createdAt',p['updatedAt']),'source':'legacy-acceptance' if p.get('acceptance') else 'legacy-install'}] if h else [],'iteration':None,'iterations':[],'feedback':''}

def ensure(p):
    if 'versioning' not in p:p['versioning']=state(p)
    return p['versioning']

def frozen(p):
    x=p.get('preparation')
    evidence=None
    if x:
        evidence={k:deepcopy(x[k]) for k in ['phase','revision','references','required','gaps','gapDecisions','report'] if k in x}
        from .capability_gaps import expert_gap_resolutions
        resolutions=expert_gap_resolutions(p)
        if resolutions:
            # A shipped version binds the fixed expert contract, not the old
            # temporary absence of that contract. Keep the old requirement as
            # history; import still discards all historical probe authority.
            evidence['gaps']=[g for g in evidence['gaps'] if g not in resolutions]
            evidence['resolvedCapabilityGaps']=[{'requirement':g,**deepcopy(proof)} for g,proof in resolutions.items()]
        evidence['interview']={'state':'completed','sync':'saved'}
    return deepcopy({'solution':p['solution'],'confirmation':p['confirmation'],'decisions':p['decisions'],'preparation':evidence,'contracts':deepcopy((x.get('handoff') or {}).get('contracts',{})) if x else {},'engine':deepcopy(p.get('engine')),'provenance':deepcopy(x.get('provenance',[])) if x else []})

def snapshot(p,a):
    if a.get('snapshot'):return deepcopy(a['snapshot'])
    # Exact hashes only: never fill historical content with today's draft.
    solution=next((r.get('solution') for r in p['revisions'] if r['hash']==a['solutionHash'] and r.get('solution')),None)
    if solution is None and digest(p['solution'])==a['solutionHash']:solution=p['solution']
    if solution is None or not a.get('confirmation'):return None
    # Older artifacts did not freeze capability evidence. Do not invent it.
    if 'preparation' in p:return None
    return deepcopy({'solution':solution,'confirmation':a['confirmation'],'decisions':{},'preparation':None})

def source_artifact(p,h):
    a=next((a for a in p['artifacts'] if a['hash']==h),None)
    if not a:raise StudioError('ARTIFACT_NOT_FOUND',404)
    return a

def artifact_hash(files,manifest,solution_hash,task_id,expert_contract_digest=None):
    value={'files':files,'manifest':manifest,'solutionHash':solution_hash,'taskId':task_id}
    if expert_contract_digest is not None:value['expertContractDigest']=expert_contract_digest
    return digest(value)

def standard_artifact_hash(a):
    """Bind the shipped package and its frozen build contract as one version."""
    return digest({k:a.get(k) for k in ["standardArtifactVersion","version","snapshot","files","manifest","solutionHash","taskId","projectSpecHash","packageSha256","expertContractDigest"]} | {"generationManifest":a["devKitPackage"].get("generationManifest")})


def verify(a):
    expert=expert_contract(a.get('snapshot',{}).get('contracts',{})).get('expertDeployment')
    sealed=a.get('expertContractDigest')
    if sealed is not None and (not expert or digest(expert)!=sealed) or expert and expert.get('profile')=='wanx-expert-app-v1' and sealed is None:
        raise StudioError('ARTIFACT_INTEGRITY_FAILED',409)
    if a.get('devKitPackage'):
        try:
            from .standard_package import validate_standard_package
            package=a['devKitPackage']
            if a.get('standardArtifactVersion')!=1 or package['packageSha256']!=a['packageSha256'] or not a.get('snapshot') or not a.get('contentHash'):
                raise ValueError('unsealed package')
            validate_standard_package(package['packageBase64'],a['packageSha256'],a['manifest'],version=a['version'])
            expected=standard_artifact_hash(a)
        except (StudioError,KeyError,TypeError,ValueError) as error:
            raise StudioError('ARTIFACT_INTEGRITY_FAILED',409) from error
    else:raise StudioError('STANDARD_ARTIFACT_REQUIRED',409)
    if a['hash']!=expected or a.get('contentHash',digest({k:a[k] for k in ['files','manifest','bundle','css']}))!=digest({k:a[k] for k in ['files','manifest','bundle','css']}):
        raise StudioError('ARTIFACT_INTEGRITY_FAILED',409)
    if a.get('checkpoint') and (digest(a['checkpoint'])!=a.get('checkpointHash') or a['checkpoint']['artifactHash']!=a['hash']):raise StudioError('ARTIFACT_INTEGRITY_FAILED',409)

def shadow(p,a):
    snap=snapshot(p,a)
    if not snap:raise StudioError('VERSION_SNAPSHOT_INCOMPLETE',409)
    if digest(snap['solution'])!=a['solutionHash'] or not snap.get('confirmation') or snap['confirmation']['hash']!=a['solutionHash']:raise StudioError('ARTIFACT_INTEGRITY_FAILED',409)
    q=deepcopy(p);q.update({k:deepcopy(v) for k,v in snap.items() if k not in {'preparation','engine'}})
    if snap['preparation']:q['preparation']=snap['preparation']
    else:q.pop('preparation',None)
    return q

def compatible_restore(p,candidate):
    # Reversion may hide additive fields/collections, never reinterpret them.
    # Trusted data.put preserves unknown fields; data never moves backwards.
    # Standard WANX App Dev Kit manifests describe Host capabilities and do
    # not carry the legacy miniapp `collections` schema. Their data contract
    # is validated by the kit pipeline and must not enter legacy comparison.
    if not isinstance(candidate.get('collections'), dict):
        return True
    manifests=[a['manifest'] for a in p['artifacts'] if any(r['artifactHash']==a['hash'] for r in state(p)['adoptions']) or p.get('installed',{} ) and p['installed']['artifactHash']==a['hash']]
    manifests += [a["manifest"] for a in p.get("_cleanedVersions", []) if any(r["artifactHash"] == a["hash"] for r in state(p)["adoptions"])]
    for previous in manifests:
        for name,fields in candidate['collections'].items():
            old=previous['collections'].get(name,{})
            if any(k in old and old[k]!=v for k,v in fields.items()):return False
    return True

def summaries(p):
    v=state(p);adopted={r['artifactHash'] for r in v['adoptions']};iteration=v['iteration']
    return [{**{k:a.get(k) for k in ['hash','version','taskId','createdAt','solutionHash','baseHash','summary','restoredFrom','iterationId','sourceFormat','projectSpecHash','packageSha256']},'snapshotAvailable':snapshot(p,a) is not None,'status':'current' if a['hash']==v['adoptedHash'] else 'historical' if a['hash'] in adopted else 'trial' if iteration and a.get('iterationId')==iteration['id'] else 'unused'} for a in reversed(p['artifacts'])]

def differences(p,a,base_hash=None):
    target=snapshot(p,a);base=next((b for b in p['artifacts'] if b['hash']==base_hash),None) if base_hash else None
    if base_hash and not base:
        if any(b['hash']==base_hash for b in p.get('_cleanedVersions',[])):
            return {'sections':[],'addedFields':[],'hiddenFields':[],'changedFields':[],'addedCapabilities':[],'removedCapabilities':[],'baselineCleaned':True}
        raise StudioError('ARTIFACT_NOT_FOUND',404)
    old=snapshot(p,base) if base else None
    labels={'problem':'目标与现状','currentApproach':'目标与现状','successOutcome':'目标与现状','scenarios':'使用流程','features':'功能范围','outOfScope':'功能范围','pages':'页面草图','dataFields':'数据字段','rules':'规则与异常','exceptions':'规则与异常','tests':'验收条件','openQuestions':'待讨论问题'}
    before=old['solution'].get('prd',{}) if old else {};after=target['solution'].get('prd',{}) if target else {}
    sections=list(dict.fromkeys(label for field,label in labels.items() if before.get(field)!=after.get(field)))
    current=base['manifest'].get('collections',{}) if base else {};wanted=a['manifest'].get('collections',{})
    left={c+'.'+k:v for c,fields in current.items() for k,v in fields.items()};right={c+'.'+k:v for c,fields in wanted.items() for k,v in fields.items()}
    return {'sections':sections,'addedFields':sorted(right.keys()-left.keys()),'hiddenFields':sorted(left.keys()-right.keys()),'changedFields':sorted(k for k in right.keys()&left.keys() if right[k]!=left[k]),'addedCapabilities':sorted(set(a['manifest']['capabilities'])-set(base['manifest']['capabilities'] if base else [])),'removedCapabilities':sorted(set(base['manifest']['capabilities'] if base else [])-set(a['manifest']['capabilities']))}

class Versions:
    def __init__(self,svc):self.svc=svc
    def bump(self,p):ensure(p)['revision']+=1
    def expected(self,p,body):
        if body['expectedRevision']!=state(p)['revision']:raise StudioError('VERSION_CHANGED',409)
    def guard(self,owner,p,a):
        verify(a);q=shadow(p,a);self.svc.authorize_version(owner,p,a)
        if not compatible_restore(p,a['manifest']):raise StudioError('VERSION_DATA_INCOMPATIBLE',409)
        return q
    async def authorize(self,owner,pid,h):
        p=self.svc.store.get(owner,pid);a=source_artifact(p,h);q=self.guard(owner,p,a)
        # Background documents helped author this version; they are not its
        # runtime grants. Runtime knowledge access checks current app bindings.
        if 'knowledge' in a['manifest']['capabilities'] and not getattr(self.svc,'workshop',False):
            team=getattr(self.svc,'team',None)
            if not team:raise StudioError('KNOWLEDGE_UNAVAILABLE',409)
            bindings=(team.services.application_repo.deployment(p['appId']) or {}).get('configuration',{}).get('studio_team_data',{})
            if not bindings:raise StudioError('KNOWLEDGE_AUTHORIZATION_REQUIRED',409)
            from wanx_bridge.semantica.team_data import read_bound
            from wanx_bridge.semantica.client import SemanticaError
            try:
                for warehouse in bindings:await read_bound(team.services,owner,p['appId'],'documents',{'warehouseId':warehouse})
            except SemanticaError as error:raise StudioError(error.code,error.status) from None
    def read(self,owner,pid,h=None):
        p=self.svc.store.get(owner,pid)
        if not h:return {'revision':state(p)['revision'],'versions':summaries(p)}
        a=source_artifact(p,h)
        return {**next(v for v in summaries(p) if v['hash']==h),'snapshot':snapshot(p,a),'manifest':a['manifest'],'changes':differences(p,a,a.get('baseHash'))}
    def feedback(self,owner,pid,body):
        def change(p):
            self.expected(p,body);ensure(p)['feedback']=body['text'];self.bump(p)
        return self.svc.store.mutate(owner,pid,body['operationId'],{'action':'feedback',**body},change)
    def begin(self,p,base,goal):
        v=ensure(p)
        if v['iteration']:raise StudioError('ITERATION_ACTIVE',409)
        if base:
            a=source_artifact(p,base);snap=snapshot(p,a)
            if not snap:raise StudioError('VERSION_SNAPSHOT_INCOMPLETE',409)
            p['solution']=deepcopy(snap['solution']);p['decisions']=deepcopy(snap['decisions']);p['confirmation']=deepcopy(snap['confirmation'])
            p.get('_iterative',{}).pop('contractDraft',None)
            # Current authorization/report remains authoritative and is rechecked.
            if 'preparation' in p:p['preparation'].pop('entryIds',None)
        v['iteration']={'id':uuid4().hex,'baseHash':base,'goal':goal,'state':'discussing','createdAt':time.time()}
        p['acceptance']=None;p['stage']='discovery';self.bump(p)
    def iteration(self,owner,pid,body):
        def change(p):
            self.expected(p,body);idle(p,pending=body['action']=='begin');v=ensure(p)
            if body['action']=='begin':self.begin(p,body.get('baseHash') or v['adoptedHash'] or (p['artifacts'][-1]['hash'] if p['artifacts'] else None),body.get('goal',''))
            else:
                if not v['iteration']:raise StudioError('ITERATION_NOT_FOUND',409)
                v['iterations'].append({**v['iteration'],'state':'abandoned','draft':frozen(p),'at':time.time()});v['iteration']=None;self.bump(p)
        return self.svc.store.mutate(owner,pid,body['operationId'],{'action':'iteration',**body},change)
    def task(self,p,instruction,*,base=None,edit_id=None):
        v=ensure(p)
        if edit_id:
            if v['iteration']:v['iterations'].append({**v['iteration'],'state':'continued','draft':frozen(p),'at':time.time()})
            v['iteration']={'id':edit_id,'baseHash':base,'goal':instruction,'state':'building','createdAt':time.time()}
            self.bump(p)
            return deepcopy(v['iteration'])
        if not v['iteration']:
            # Compatibility for existing clients: select a baseline explicitly once.
            v['iteration']={'id':uuid4().hex,'baseHash':v['adoptedHash'] or (p['artifacts'][-1]['hash'] if p['artifacts'] else None),'goal':instruction,'state':'building','createdAt':time.time()}
        v['iteration']['state']='building';self.bump(p)
        chosen=deepcopy(v['iteration'])
        chosen['baseHash']=v['iteration'].get('latestHash') or v['iteration']['baseHash']
        return chosen
    def add(self,p,a,task):
        v=ensure(p);iteration=v['iteration']
        a.update({'snapshot':frozen(p),'contentHash':digest({k:a[k] for k in ['files','manifest','bundle','css']}),'baseHash':task.get('baseHash'),'iterationId':task.get('iterationId') or (iteration['id'] if iteration else None),'summary':task.get('instruction') or (iteration.get('goal') if iteration else '') or '首次构建'})
        if iteration:iteration.update({'state':'trial','latestHash':a['hash']})
        self.bump(p)
    def adoption(self,p,a,source,operation):
        v=ensure(p);v['adoptedHash']=a['hash'];v['adoptions'].append({'artifactHash':a['hash'],'at':time.time(),'source':source,'operationId':operation})
        if v['iteration']:
            v['iterations'].append({**v['iteration'],'state':'adopted','artifactHash':a['hash'],'draft':frozen(p),'at':time.time()});v['iteration']=None
        p['stage']='adopted';self.bump(p)
    def adopt(self,owner,pid,body):
        self.svc.authorize_management(owner)
        def change(p):
            self.expected(p,body);idle(p,pending=False);a=source_artifact(p,body['artifactHash']);self.guard(owner,p,a)
            if not body.get('confirmedByUser'):raise StudioError('USER_ADOPTION_REQUIRED',409)
            task=next((t for t in p['tasks'] if t['id']==a['taskId']),None)
            if not task or task['state']!='completed':raise StudioError('VERSION_CHANGED',409)
            self.adoption(p,a,'user-adoption',body['operationId'])
        return self.svc.store.mutate(owner,pid,body['operationId'],{'action':'adopt',**body},change)
    def restore_check(self,owner,pid,h,comparison_hash=None):
        p=self.svc.store.get(owner,pid);idle(p,pending=False);v=state(p)
        a=source_artifact(p,h);self.guard(owner,p,a)
        completed={t['id'] for t in p['tasks'] if t['state']=='completed'}
        if a['taskId'] not in completed:raise StudioError('VERSION_CHANGED',409)
        # Compare to the selected preview, even before any version was adopted.
        # Older clients omit the baseline: use the latest successful artifact.
        base=source_artifact(p,comparison_hash) if comparison_hash else next(b for b in reversed(p['artifacts']) if b['taskId'] in completed)
        if base['taskId'] not in completed:raise StudioError('VERSION_CHANGED',409)
        verify(base);shadow(p,base)
        return {'expectedRevision':v['revision'],'artifactHash':h,'currentHash':v['adoptedHash'],'comparisonHash':base['hash'],'comparisonVersion':base['version'],'dataPolicy':'preserve','restores':a['version'],'capabilities':a['manifest']['capabilities'],'changes':differences(p,a,base['hash']),'checkHash':digest({'revision':v['revision'],'hash':h,'current':v['adoptedHash'],'comparison':base['hash'],'manifest':a['manifest']})}
    def restore(self,owner,pid,body,*,trial=False):
        self.svc.authorize_management(owner)
        def change(p):
            self.expected(p,body);check=self.restore_check(owner,pid,body['artifactHash'],body.get('comparisonHash'))
            if check['checkHash']!=body['checkHash'] or not body.get('confirmedByUser'):raise StudioError('VERSION_CHANGED',409)
            old=source_artifact(p,body['artifactHash'])
            if old.get('devKitPackage'):
                # Restoring an immutable ZIP reuses its real version/hash. A
                # new version number would require a new package and build.
                q=shadow(p,old)
                p.update({k:deepcopy(q[k]) for k in ['solution','decisions','confirmation']})
                p.get('_iterative',{}).pop('contractDraft',None)
                if 'preparation' in p:p['preparation'].pop('entryIds',None)
                v=ensure(p)
                if v['iteration']:
                    v['iterations'].append({**v['iteration'],'state':'abandoned','draft':frozen(p),'at':time.time()});v['iteration']=None
                if trial:
                    v['iteration']={'id':uuid4().hex,'baseHash':old['hash'],'latestHash':old['hash'],'goal':'恢复自 v'+old['version'],'state':'trial','createdAt':time.time()}
                    p['stage']='preview';p['acceptance']=None;self.bump(p)
                else:self.adoption(p,old,'user-restore',body['operationId'])
                return
            a=deepcopy(old);task_id='restore_'+uuid4().hex
            a.update({'taskId':task_id,'version':next_version(p),'createdAt':time.time(),'restoredFrom':old['hash'],'baseHash':old['hash'],'iterationId':None,'summary':'恢复自 v'+old['version']})
            a['hash']=artifact_hash(a['files'],a['manifest'],a['solutionHash'],task_id,a.get('expertContractDigest'))
            if a.get('checkpoint'):
                a['checkpoint'].update({'artifactHash':a['hash'],'parent':old['hash'],'changeId':task_id})
                a['checkpointHash']=digest(a['checkpoint'])
            p['tasks'].append({'id':task_id,'state':'completed','executor':'restore','solutionHash':a['solutionHash'],'createdAt':time.time(),'events':[{'type':'status','text':'复用所选版本的代码与方案，保留当前业务数据；未调用开发模型。','at':time.time()}],'question':None,'baseHash':old['hash']})
            p['artifacts'].append(a)
            v=ensure(p)
            if v['iteration']:
                v['iterations'].append({**v['iteration'],'state':'abandoned','draft':frozen(p),'at':time.time()})
                v['iteration']=None
            # Restore the working PRD as well; never restore old conversation or data.
            q=shadow(p,a);p.update({k:deepcopy(q[k]) for k in ['solution','decisions','confirmation']})
            p.get('_iterative',{}).pop('contractDraft',None)
            if 'preparation' in p:p['preparation'].pop('entryIds',None)
            if trial:
                a['iterationId']=task_id
                v['iteration']={'id':task_id,'baseHash':old['hash'],'latestHash':a['hash'],'goal':a['summary'],'state':'trial','createdAt':time.time()}
                p['stage']='preview';p['acceptance']=None;self.bump(p)
            else:self.adoption(p,a,'user-restore',body['operationId'])
        return self.svc.store.mutate(owner,pid,body['operationId'],{'action':'restore-trial' if trial else 'restore-version',**body},change)
    def payload(self,owner,pid,h):
        p=self.svc.store.get(owner,pid);v=state(p)
        if v['adoptedHash']!=h:raise StudioError('USER_ADOPTION_REQUIRED',409)
        a=source_artifact(p,h);self.guard(owner,p,a)
        return {'taskId':a['taskId'],'applicationId':p['appId'],'name':a['manifest']['name'],'projectId':pid,'version':a['version'],'artifactHash':h,'manifest':a['manifest'],'bundle':a['bundle'],'css':a['css']}
