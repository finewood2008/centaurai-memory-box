"""Private iterative build adapter. The existing Solution remains the sole draft.

Contract proposals never grant runtime permissions. Each execution freezes the
draft and an exact data contract; legacy confirm/build endpoints stay unchanged.
"""
from copy import deepcopy
import time

from fastapi import Depends
from pydantic import Field

from .contracts import Operation, StudioError, check_manifest, digest, readiness
from .capability_gaps import unresolved_capability_gaps
from .foundation import foundation_policy
from .versions import state
from .visual_review import VisualReview, authorize_visual


def data_intent(p):
    solution=p['solution']
    return digest({'fields':solution.get('prd',{}).get('dataFields',solution['fields']),
                   'capabilities':sorted(solution['capabilities'])})


def standard_contract(artifact):
    """A standard Host package has no legacy miniapp collections schema."""
    from .versions import verify
    verify(artifact)
    return {'format':'wanx-app-dev-kit',
        'capabilities':sorted(artifact['snapshot']['solution']['capabilities']),
        'hostCapabilities':deepcopy(artifact['manifest']['capabilities']),
        'backendContracts':deepcopy(artifact['manifest'].get('compatibility',{}).get('backendContracts',[])),
        'expertContractDigest':artifact.get('expertContractDigest'),
        'visibility':'application-access'}


def contract(p):
    base=baseline(p)
    if base and base.get('devKitPackage'):
        return planned_standard_contract(p,base)
    draft=p.get('_iterative',{}).get('contractDraft')
    if draft and draft['dataIntent']==data_intent(p):
        return deepcopy(draft['contract'])
    # Existing products keep their exact schema. Do not guess new field keys.
    base=baseline(p)
    if base:
        snap=base.get('snapshot',{})
        if snap.get('solution') and data_intent({**p,'solution':snap['solution']})==data_intent(p):
            return {'collections':deepcopy(base['manifest']['collections']),
                    'capabilities':sorted(p['solution']['capabilities']),
                    'visibility':'application-access'}
    if 'data' not in p['solution']['capabilities']:
        return {'collections':{},'capabilities':sorted(p['solution']['capabilities']),
                'visibility':'application-access'}
    return None


def planned_standard_contract(project, base):
    """Regenerate reduced permissions through the trusted generator, never app code.

    Expanding capabilities or changing a backend still requires explicit planning
    and authorization; a direct edit can only remove product capabilities.
    """
    from .capability_mapping import resolve
    from .devkit import project_spec
    fixed = standard_contract(base)
    requested = sorted(set(project['solution']['capabilities']))
    if requested == fixed['capabilities']:
        return fixed
    if not set(requested) <= set(fixed['capabilities']):
        return None
    spec = project_spec(project)
    mapping = resolve(requested, expert=bool(spec['expert'].get('enabled')), backend=spec['backend'])
    if mapping['gaps'] or not set(mapping['hostCapabilities']) <= set(fixed['hostCapabilities']):
        return None
    return {**fixed, 'capabilities':requested, 'hostCapabilities':mapping['hostCapabilities']}


def baseline(p):
    v=state(p);it=v['iteration'] or {}
    key=it.get('latestHash') or it.get('baseHash') or v['adoptedHash'] or (p['artifacts'][-1]['hash'] if p['artifacts'] else None)
    return next((a for a in p['artifacts'] if a['hash']==key),None)


def proposal(p, *, require_review=True):
    s=p['solution'];prd=s.get('prd') or {};c=contract(p);base=baseline(p)
    missing=[]
    from .product_questions import pending_choices
    if pending_choices(p):missing.append('请先回答本轮产品选择，再阅读完整 PRD')
    if not p['artifacts'] and readiness(s,p['decisions'])['missing']:
        missing.append('完整 PRD（流程、页面、数据与验收）')
    if not (prd.get('problem') or p['originalGoal']).strip():missing.append('要解决的问题')
    if not s['workflow'].strip():missing.append('主要使用流程')
    if not s['acceptance']:missing.append('可试用的验收目标')
    if prd.get('openQuestions'):missing.append('尚未决定的问题')
    unresolved=[d['requirement'] for d in s['dependencies'] if p['decisions'].get(d['id'],{}).get('choice') not in {'manual','defer'}]
    if unresolved:missing.append('能力缺口尚未记录取舍：'+'、'.join(unresolved))
    if c is None:missing.append('数据保存方式（由产品经理整理）')
    prep=p.get('preparation',{})
    gaps=[g.split('：',1)[0] for g in unresolved_capability_gaps(p)]
    if gaps:missing.append('现有 WANX 能力尚不支持，尚未记录本轮范围决定：'+'、'.join(gaps))
    old=(standard_contract(base) if base.get('devKitPackage') else base.get('checkpoint',{}).get('contract')) if base else None
    if base and not old:
        old=standard_contract(base) if base.get('devKitPackage') else {'collections':base['manifest']['collections'],'capabilities':sorted(base['manifest']['capabilities']),'visibility':'application-access'}
    spec={'schemaVersion':1,'hash':digest(s),'intent':p['originalGoal'],'foundationConstraints':foundation_policy(),
          'behavior':deepcopy(s),'contract':c,'decisions':deepcopy(p['decisions'])}
    impact=digest({'spec':spec,'base':base['hash'] if base else None})
    needs_review=False
    if require_review:
        from .prd_review import review_missing
        review=review_missing(p,impact)
        needs_review=not missing and review==['产品经理尚未完成信息完备性检查'] and not p.get('preparation',{}).get('interview',{}).get('readinessPolicy')
        missing.extend(review)
    return {'schemaVersion':1,'specHash':digest(s),'impactHash':impact,
            'baseCheckpoint':base['hash'] if base else None,'contract':c,'previousContract':old,
            'needsContractConfirmation':False,'ready':not missing,'missing':missing,'needsCompletenessReview':needs_review,
            'spec':spec}


def propose_contract(svc,owner,pid,args):
    if set(args)!={'expectedHash','collections'}:raise StudioError('CONTRACT_INPUT_INVALID')
    def change(p):
        if args['expectedHash']!=digest(p['solution']):raise StudioError('SOLUTION_CHANGED',409)
        base=baseline(p)
        if base and base.get('devKitPackage'):raise StudioError('STANDARD_CONTRACT_FIXED',409)
        m=check_manifest({'schemaVersion':1,'name':p['name'],'entry':'src/app.js',
                          'collections':args['collections'],'capabilities':p['solution']['capabilities']})
        if bool(m['collections'])!=('data' in m['capabilities']):raise StudioError('CONTRACT_DATA_POLICY_REQUIRED',409)
        p.setdefault('_iterative',{})['contractDraft']={'dataIntent':data_intent(p),
            'contract':{'collections':m['collections'],'capabilities':sorted(m['capabilities']),
                        'visibility':'application-access'}}
    svc.preparation.mutate(owner,pid,'contract-proposal',change)
    return {'saved':True,'requiresUserConfirmation':False}


class Start(Operation):
    specHash: str = Field(pattern=r'^[a-f0-9]{64}$')
    impactHash: str = Field(pattern=r'^[a-f0-9]{64}$')
    confirmedContract: bool = False
    instruction: str = Field(default='',max_length=8000)
    visualReview: VisualReview | None = None


def authorize(p,body):
    if body.get('visualReview'):authorize_visual(p,body['visualReview'])
    proposed=proposal(p)
    if proposed['specHash']!=body['specHash'] or proposed['impactHash']!=body['impactHash']:
        raise StudioError('SOLUTION_CHANGED',409)
    if not proposed['ready']:raise StudioError('SOLUTION_NOT_READY',409)
    # The explicit build action freezes this exact contract. No second technical
    # capability approval is required; runtime resource authorization still applies.
    return {'id':body['operationId'],'schemaVersion':1,'spec':proposed['spec'],
            'specHash':body['specHash'],'impactHash':body['impactHash'],
            'baseCheckpoint':proposed['baseCheckpoint'],'contract':proposed['contract'],
            'contractConfirmed':True,'confirmationMode':'build-action','createdAt':time.time()}


def enforce(change,manifest):
    c=change['contract']
    if not set(manifest['capabilities'])<=set(c['capabilities']):raise StudioError('CAPABILITY_NOT_CONFIRMED',409)
    for collection,fields in manifest['collections'].items():
        if collection not in c['collections'] or any(c['collections'][collection].get(k)!=v for k,v in fields.items()):
            raise StudioError('CONTRACT_SCHEMA_NOT_CONFIRMED',409)


def mount(router,svc,identity):
    @router.get('/_builder/context',include_in_schema=False)
    async def context(owner=Depends(identity)):
        svc.authorize_management(owner)
        return {'protocolVersion':1,'iterativeBuild':1,'directEdits':1}

    @router.get('/_builder/projects/{pid}/proposal',include_in_schema=False)
    async def read(pid:str,owner=Depends(identity)):
        svc.authorize_management(owner)
        result=proposal(svc.store.get(owner,pid));result.pop('spec')
        return result

    @router.post('/_builder/projects/{pid}/build',include_in_schema=False)
    async def build(pid:str,body:Start,owner=Depends(identity)):
        return await svc.runner.start(owner,pid,{'operationId':body.operationId,
            'solutionHash':body.specHash,'instruction':body.instruction},iterative=body.model_dump())
