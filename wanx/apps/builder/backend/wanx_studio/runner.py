from __future__ import annotations
from .public_capabilities import expert_contract

import asyncio
import hashlib
from copy import deepcopy
import json
import os
import signal
import shutil
import sys
import time
from uuid import uuid4
from pathlib import Path

from .local_authority import to_thread
from .contracts import StudioError, digest
from .foundation import FOUNDATION_PROMPT, foundation_policy
from .store import public
from .codex_config import runtime_config, resolve_runtime, config_fingerprint, snapshot_model


class Runner:
    EXECUTOR = "Codex"
    VERSION = "native-app-server"
    TASK_TIMEOUT_SECONDS = 1800
    LEASE_SECONDS = 90
    def __init__(self, service):
        self.svc=service
        self.cached=None
        self.cached_at=0
        self.probing=asyncio.Lock()
        self.start_lock=asyncio.Lock()
        self.leases={}
        self.jobs={}

    async def preflight(self, fresh=False, for_turn=False, owner=None, model_ref=None):
        # The real native worker performs the connection/policy handshake once.
        # A build must not launch and discard a second Codex just to probe it.
        base={'available':False,'executor':'Codex','transport':'app-server','modelCalls':0,
              'check':'configuration' if for_turn else 'protocol'}
        async with self.probing:
            try:
                config,summary=await to_thread(resolve_runtime,'wanx_task',self.svc,owner,model_ref)
            except StudioError as error:
                return {**base,'code':error.code}
            base['configuration']=summary
            node=await to_thread(shutil.which,'node')
            if not node:
                return {**base,'code':'CODEX_NODE_MISSING'}
            if for_turn:
                return {**base,'available':True}
            stamp=config_fingerprint({'runtime':config,'node':node})
            if self.cached and not fresh and getattr(self,'cached_stamp',None)==stamp and time.monotonic()-self.cached_at<60:
                return self.cached
            env={k:v for k,v in os.environ.items() if k in {'PATH','LANG','TMPDIR'}}
            proc=None
            try:
                proc=await asyncio.create_subprocess_exec(node,str(self.svc.project_root/'tools/probe-codex.mjs'),stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.DEVNULL,cwd=self.svc.project_root,env={**env,**config,'WANX_PYTHON_PATH':sys.executable},start_new_session=True)
                out,_=await asyncio.wait_for(proc.communicate(),40)
                result=json.loads(out)
                if type(result) is not dict or type(result.get('available')) is not bool or result.get('modelCalls')!=0:
                    raise ValueError('invalid probe result')
                if result['available'] and getattr(proc,'returncode',0):
                    raise ValueError('unsuccessful probe process')
                result={**base,**result,'configuration':summary}
            except asyncio.CancelledError:
                if proc is not None:
                    await self.svc.native_codex.stop(proc,grace_seconds=3)
                raise
            except FileNotFoundError:
                result={**base,'code':'CODEX_NODE_MISSING'}
            except asyncio.TimeoutError:
                result={**base,'code':'CODEX_PROBE_TIMEOUT'}
            except Exception:
                result={**base,'code':'PREFLIGHT_FAILED'}
            if proc is not None:
                try:
                    await self.svc.native_codex.stop(proc,grace_seconds=3)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    result={**base,'code':'CODEX_PROBE_CLEANUP_FAILED'}
            self.cached=result
            self.cached_at=time.monotonic()
            self.cached_stamp=stamp
            return self.cached

    async def start(self, owner, project_id, body, *, iterative=None, edit_id=None):
        async with self.start_lock:
            from .iterative import authorize
            request_hash=digest({'body':body,'iterative':iterative,**({'editId':edit_id} if edit_id else {})})
            p=self.svc.store.get(owner,project_id)
            if not p.get('devKit'):
                raise StudioError('STANDARD_PROJECT_REQUIRED',409)
            existing=next((t for t in p['tasks'] if t.get('operationId')==body['operationId']),None)
            if existing:
                if existing.get('requestHash') and existing['requestHash']!=request_hash:raise StudioError('OPERATION_CONFLICT',409)
                self.svc.authorize_management(owner)
                return public(p)
            self.svc.authorize_management(owner)
            if not edit_id and any(e['state'] in {'queued','preparing','building','validating','clarifying'} for e in p.get('_edits',{}).get('items',[])):
                raise StudioError('BUILD_ACTIVE',409)
            if iterative and iterative.get('visualReview'):
                from .visual_review import authorize_visual
                review=authorize_visual(p,iterative['visualReview'])
                base=next(a for a in p['artifacts'] if a['hash']==review['baseHash'])
                self.svc.versions.guard(owner,p,base)
            if self.jobs or any(not k.startswith('interview:') for k in self.svc.processes) or any(t['state'] in {'running','waiting','queued'} for t in p['tasks']):
                raise StudioError('BUILD_CONCURRENCY_LIMIT',409)
            self.svc.engines.guard(owner,p,required=True)
            if edit_id:
                _,edit=self.svc.edits.live(owner,project_id,edit_id)
                if not edit.get('execution') or edit['execution']['specHash']!=body['solutionHash']:raise StudioError('SOLUTION_CHANGED',409)
            elif iterative and 'preparation' in p:
                authorize(p,iterative)
                p=await self.svc.preparation.ensure_development(owner,project_id)
            if not edit_id:await self.svc.preparation.guard_async(owner,p,development=True)
            if edit_id:pass
            elif iterative:authorize(p,iterative)
            elif not p['confirmation'] or p['confirmation']['hash']!=body['solutionHash'] or digest(p['solution'])!=body['solutionHash']:
                raise StudioError('CONFIRMATION_REQUIRED',409)
            model_ref=edit.get('_codexModel') if edit_id and '_codexModel' in edit else await to_thread(snapshot_model,self.svc)
            task_id=uuid4().hex
            def change(project):
                execution=deepcopy(edit['execution']) if edit_id else authorize(project,iterative) if iterative else None
                if execution and not edit_id:
                    project['confirmation']={'hash':execution['specHash'],'decisionsHash':digest(project['decisions']),'operationId':body['operationId'],'createdAt':time.time()}
                if not edit_id and (digest(project['solution'])!=body['solutionHash'] or not project['confirmation']):
                    raise StudioError('SOLUTION_CHANGED',409)
                iteration=self.svc.versions.task(project,body['instruction'],**({'base':edit['baseHash'],'edit_id':edit_id} if edit_id else {}))
                if edit_id:
                    self.svc.edits.live(owner,project_id,edit_id)
                    iteration['baseHash']=edit['baseHash']
                project['tasks'].append({'baseHash':iteration['baseHash'],'iterationId':iteration['id'],'instruction':body['instruction'],'id':task_id,'operationId':body['operationId'],'requestHash':request_hash,'executor':self.EXECUTOR,'version':self.VERSION,'state':'queued','solutionHash':body['solutionHash'],'createdAt':time.time(),'events':[],'question':None,'engine':p.get('engine'),'buildFormat':'wanx-app-dev-kit'})
                from .devkit import build_input
                working = self.svc.edits.project(project, edit) if edit_id else project
                if edit_id:
                    working['solution'] = deepcopy(execution['spec']['behavior'])
                frozen = build_input(working, self.svc.project_root)
                if execution and not edit_id:
                    project['confirmation']['buildInput'] = frozen
                if not execution and project['confirmation'].get('buildInput') != frozen:
                    raise StudioError('BUILD_INPUT_CHANGED',409)
                project['tasks'][-1]['buildInput'] = frozen
                if model_ref is not None:project['tasks'][-1]['_codexModel']=model_ref
                if execution:project['tasks'][-1]['change']=execution
                if edit_id:
                    project['tasks'][-1]['editId']=edit_id
                    if edit.get('visualReview'):project['tasks'][-1]['visualReview']=deepcopy(edit['visualReview'])
                if iterative and iterative.get('visualReview'):
                    project['tasks'][-1]['visualReview']=iterative['visualReview']
                project['stage']='building'
                project['acceptance']=None
            result=self.svc.store.mutate(owner,project_id,body['operationId'],{'action':'build',**body,**({'iterative':iterative} if iterative else {})},change)
            p=self.svc.store.get(owner,project_id)
            if edit_id:p=self.svc.edits.execution_project(owner,p,p['tasks'][-1])
            self.touch(owner,project_id)
            from .local_authority import start_background
            try:
                job=await start_background(self.svc,owner,project_id,task_id,'build',lambda:self.run(owner,p,task_id,body['instruction']))
            except BaseException as error:
                code=error.code if isinstance(error,StudioError) else 'STUDIO_TASK_AUTHORIZATION_DENIED'
                def denied(project):
                    task=next(t for t in project['tasks'] if t['id']==task_id)
                    task.update(state='failed',error=code,finishedAt=time.time())
                    project['stage']='failed'
                self.svc.store.mutate(owner,project_id,'task-denied-'+task_id,{'task':task_id},denied)
                raise
            self.jobs[task_id]=job
            self.svc.background.add(job)
            job.add_done_callback(self.svc.background.discard)
            return result

    def touch(self, owner, project_id):
        self.leases[(owner,project_id)]=time.monotonic()

    async def guard_lease(self, owner, project_id):
        while True:
            await asyncio.sleep(2)
            self.svc.authorize_management(owner)
            if time.monotonic()-self.leases.get((owner,project_id),0)>self.LEASE_SECONDS:
                raise StudioError("WORKBENCH_SESSION_EXPIRED",401)

    def event(self, owner, project_id, task_id, event):
        with self.svc.store.transaction():
            event={**event,'at':time.time()}
            self.svc.store.append_event(owner,project_id,task_id,event)
            # Terminal bytes and diagnostics are persisted in task_events only.
            # Saving the entire source/version history for every PTY fragment
            # can hold up tool authorization on the same worker stream.
            if event['type'].startswith('terminal') or event['type']=='diagnostic':return
            p=self.svc.store.get(owner,project_id)
            task=next(t for t in p['tasks'] if t['id']==task_id)
            task['events'].append({'type':event['type'],'text':str(event.get('text',''))[:8000],'at':event['at']})
            task['events']=task['events'][-300:]
            self.svc.store.save(p)

    def source_files(self, owner, p, task_id):
        task=next(t for t in p['tasks'] if t['id']==task_id)
        if 'baseHash' in task:
            latest=next((a for a in p['artifacts'] if a['hash']==task['baseHash']),None)
        else:latest=p['artifacts'][-1] if p['artifacts'] else None
        sources=latest['files'] if latest else {}
        for previous in reversed(p['tasks']):
            if latest and previous['id']==latest['taskId']:
                break
            saved=self.svc.store.root/'tasks'/previous['id']/'sources.json'
            if previous['id']!=task_id and previous['state'] in {'failed','cancelled','interrupted'} and previous['solutionHash']==digest(p['solution']) and previous.get('iterationId')==task.get('iterationId') and previous.get('baseHash')==task.get('baseHash') and saved.is_file() and not saved.is_symlink():
                self.event(owner,p['id'],task_id,{'type':'status','text':'已恢复上次任务保存的源码，继续完成当前确认方案'})
                return json.loads(saved.read_text())
        return sources

    async def run(self, owner, p, task_id, instruction):
        try:
            task=next(t for t in p['tasks'] if t['id']==task_id)
            if task['state']=='queued':
                self.event(owner,p['id'],task_id,{'type':'status','text':'开发任务已保存，正在检查本机开发环境…'})
                check=await self.preflight(for_turn=True,owner=owner,model_ref=task.get('_codexModel'))
                if not check['available']:
                    self.event(owner,p['id'],task_id,{'type':'status','text':'开发环境检查未通过：'+check.get('code','PREFLIGHT_FAILED')})
                    raise StudioError('ISOLATION_UNAVAILABLE',409)
                if time.monotonic()-self.leases.get((owner,p['id']),0)>self.LEASE_SECONDS:
                    raise StudioError('WORKBENCH_SESSION_EXPIRED',401)
                with self.svc.store.transaction():
                    p=self.svc.store.get(owner,p['id'])
                    task=next(t for t in p['tasks'] if t['id']==task_id)
                    if task['state']!='queued':
                        return
                    self.svc.authorize_management(owner)
                    self.svc.engines.guard(owner,p,required=True)
                    task['state']='running'
                    self.svc.store.save(p)
                if task.get('editId'):p=self.svc.edits.execution_project(owner,p,task)
                self.event(owner,p['id'],task_id,{'type':'status','text':'开发环境检查通过，正在使用 '+self.EXECUTOR+' 修改…'})
            await self.execute(owner,p,task_id,instruction)
        except BaseException as error:
            code=None
            with self.svc.store.transaction():
                current=self.svc.store.get(owner,p['id'])
                task=next(t for t in current['tasks'] if t['id']==task_id)
                if task['state'] in {'running','waiting','queued'}:
                    restarting=isinstance(error,asyncio.CancelledError) and getattr(self.svc,'closing',False)
                    task['state']='interrupted' if restarting else 'cancelled' if isinstance(error,asyncio.CancelledError) else 'failed'
                    task['error']='SERVICE_RESTARTED' if restarting else error.code if isinstance(error,StudioError) else 'CODEX_EXECUTION_FAILED'
                    current['stage']=task['state']
                    self.svc.store.save(current)
                    code=task['error']
            if code:
                self.event(owner,p['id'],task_id,{'type':'status','text':'开发未完成：'+code})
        finally:
            proc=self.svc.processes.pop(task_id,None)
            if proc is not None:
                await self.svc.native_codex.abandon(proc)
            self.jobs.pop(task_id,None)
            latest=self.svc.store.get(owner,p['id'])
            finished=next(t for t in latest['tasks'] if t['id']==task_id)
            if not finished.get('editId') and not self.svc.edits.enabled(latest):
                if finished['state']=='completed':await self.svc.preparation.pm.drain(owner,p['id'])
                else:self.svc.preparation.pm.pause(owner,p['id'],finished.get('error') or 'BUILD_INCOMPLETE')

    async def execute(self, owner, p, task_id, instruction):
        project_id=p['id']
        env={k:v for k,v in os.environ.items() if k in {'PATH','LANG','TMPDIR'}}
        config_env=await to_thread(runtime_config,'wanx_task',self.svc,owner,next(t for t in p['tasks'] if t['id']==task_id).get('_codexModel'))
        if not config_env:
            raise StudioError('CODEX_NOT_CONFIGURED',409)
        idle=False
        if not p.get("devKit"):
            raise StudioError("STANDARD_PROJECT_REQUIRED",409)
        from .deployment.project_expert import selected as expert_selected, instruction as expert_instruction
        material={'foundationConstraints':foundation_policy(p),'originalGoal':p['originalGoal'],'solution':p['solution'],'dependencyDecisions':p['decisions'],'verifiedCapabilities':p.get('preparation',{}).get('report'),'verifiedContracts':(p.get('preparation',{}).get('handoff') or {}).get('contracts',{}),'instruction':instruction}
        change=next(t for t in p['tasks'] if t['id']==task_id).get('change')
        if change:
            material['executionPackage']={'schemaVersion':1,'changeId':change['id'],'spec':change['spec'],'contract':change['contract']}
        task_root=self.svc.store.root/'tasks'/task_id
        task_root.mkdir(parents=True,mode=0o700)
        from . import devkit_build
        devkit_workspace=None
        if devkit_build.enabled(p):
            from .versions import next_version
            build_task=next(t for t in p['tasks'] if t['id']==task_id)
            if build_task.get('editId'):
                # execution_project intentionally removes private edit state.
                # Re-read this task's live edit, never another/latest request.
                _,edit=self.svc.edits.live(owner,project_id,build_task['editId'])
                material['requestedChange']={'text':edit['text'],'answers':deepcopy(edit.get('answers',[]))}
            devkit_workspace=devkit_build.create_iteration_workspace(p,self.svc.project_root,task_root,build_task,version=next_version(p))
            self.svc.store.mutate(owner,project_id,'devkit-workspace-'+task_id,{'task':task_id,'specHash':devkit_workspace['specHash']},lambda current: next(t for t in current['tasks'] if t['id']==task_id).update({'devKitWorkspace':devkit_workspace['root'],'devKitSpecHash':devkit_workspace['specHash']}))
            sources=devkit_build.mutable_files(Path(devkit_workspace['root']))
            from .public_capabilities import planning_instruction
            material['foundationInstruction']=planning_instruction()
            material['devKit']={'projectSpec':deepcopy(devkit_workspace['spec']),'projectSpecHash':devkit_workspace['specHash'],'hostCapabilities':devkit_workspace['hostCapabilities'],'capabilityGaps':devkit_workspace['capabilityGaps']}
            material['contract']={'workspace':'wanx-app-dev-kit standard host','mutableFiles':sorted(sources),'mutableRoots':['app/'],'sourceExtensions':['html','mjs','js','css','json','svg','txt'],'immutableFiles':['project-spec.json','generation-manifest.json','application.manifest.json','shell/main.cjs','shell/host.cjs','shell/preload.cjs','vendor/'],'hostCapabilities':devkit_workspace['hostCapabilities'],'rules':['Use only the public WANX Host SDK through the existing host adapter.','Do not add renderer URL access, arbitrary IPC channels, credentials, local storage or Builder private API calls.','A missing public contract is a plan gap; do not invent a backend or expert endpoint.']}
            bridge={'global':'window.wanx','readOnly':True,'demoIsExhaustive':False,
                'envelope':'{ok:true,value}|{ok:false,code}',
                'methods':{'context':'window.wanx.context()','listFiles':'window.wanx.listFiles()',
                           'onInvalidated':'window.wanx.onInvalidated(callback) -> unsubscribe'},
                'fixedSourceHashes':{name:hashlib.sha256((Path(devkit_workspace['root'])/name).read_bytes()).hexdigest()
                    for name in ('shell/main.cjs','shell/host.cjs','shell/preload.cjs')}}
            material['contract']['rendererBridgeContract']=bridge
            material['contract']['uiTemplate']={'id':'workspace-reference','version':1,'layoutEditable':True,'sourceOfTruth':'confirmed PRD and requestedChange; preserve the selected baseline on iterations'}
            material['contract']['rules'].append('The UI is a default reference, not a fixed layout. The confirmed PRD may change navigation, page structure, styling and expert entry points. Edit or add app/ text sources using relative offline imports. Preserve unrelated baseline files; remove obsolete app sources explicitly. Only platform shell, SDK, identity and permissions stay fixed. Delivered files are native browser modules: load CSS via HTML link, reference images via HTML/CSS, and use JSON import attributes (with {type:"json"}) when importing JSON. Do not use CommonJS require or JavaScript imports of CSS/images.')
            material['contract']['rules'].append('rendererBridgeContract describes immutable Host APIs, not new permissions or read-only business data. The initial app/host files are a replaceable demonstration, not an exhaustive API inventory. Read this contract before inferring a missing bridge from the demonstration.')
            material['contract']['rules'].append('The installed app enforces app/host.html CSP. Its static style elements and style attributes must be permitted by that policy, including correct hashes/nonces when used. Layout preview replaces CSP and is not proof that delivered styles work. A new build rejects HOST_INLINE_STYLE_BLOCKED conflicts; fix the business HTML/CSS consistently without expanding script or network permissions or changing the fixed shell.')
            if expert_selected(p):
                material['contract']['expertInstruction']=expert_instruction(p)
                material['contract']['expertDeployment']=deepcopy(expert_contract(material['verifiedContracts']).get('expertDeployment'))
                bridge['methods'].update(expertContext='window.wanx.expertContext()',expertInvoke='window.wanx.expertInvoke({operation,input})')
                bridge['unavailableExpertContext']={'code':'EXPERT_DEPLOYMENT_REQUIRED','classification':'runtime-unavailable','disableBusinessActions':True,'mayInferDeploymentState':False,'message':'当前未连接专家运行环境。布局预览仅展示页面，专家功能请在已部署应用中使用。'}
                material['contract']['rules'].append('When expertContext returns {ok:false,code:"EXPERT_DEPLOYMENT_REQUIRED"}, display unavailableExpertContext.message as a neutral unavailable state, not an initialization failure. Disable submit, refresh, cancellation and other business actions; do not read or write business state, invoke an expert, fabricate context or show success. This code alone does not prove preview mode or deployment status. Preserve all other initialization errors as visible failures with business actions disabled; never catch every error as preview or retry/replay automatically.')
                bridge.update(expertOperations=deepcopy(expert_contract(material['verifiedContracts']).get('operations',{})),
                    dataOperations=deepcopy(expert_contract(material['verifiedContracts']).get('data',material['verifiedContracts'].get('data',{})).get('operations',{})),
                    stateCollection='state',recordShape='flat',
                    initialization='expertContext() -> expertInvoke({operation:"expert.tasks",input:{}}) -> data.list. A successful expert.* call completes client readiness; context/data.list alone do not.',
                    recordId='Every data.put requires a stable id, including the first create (for example operationId). Persist successfully before expert.run.',
                    expectedRevision='Use record._revision; create 0; RECORD_CHANGED reloads the current record without overwriting it.')
        else:
            sources=self.source_files(owner,p,task_id)
        codex_root=Path(devkit_workspace['root']) if devkit_workspace else task_root
        renderer_assets={}
        if devkit_workspace:
            from .standard_preview import workspace_sources
            renderer_assets={name:content for name,content in workspace_sources(Path(devkit_workspace['root'])).items() if name not in sources}
            material['contract']['preservedAssets']=sorted(renderer_assets)
        config={'rendererAssets':renderer_assets,'taskRoot':str(codex_root),'material':material,'files':sources,'authorizeTools':True,'scope':project_id+':'+task_id if devkit_workspace else project_id,'sessionId':None if devkit_workspace else next((t.get('sessionId') for t in reversed(p['tasks']) if t.get('sessionId')),None),'devKit':bool(devkit_workspace)}
        review=next(t for t in p['tasks'] if t['id']==task_id).get('visualReview')
        if review:
            material['visualReview']={k:v for k,v in review.items() if k!='image'}
            material['contract']['rules'].append('Use the numbered preview screenshot and normalized regions for the requested local change. Follow the frozen change specification and contract; preserve unrelated functionality. Never embed the screenshot or its content in application source.' if next(t for t in p['tasks'] if t['id']==task_id).get('editId') else 'Use the numbered preview screenshot and normalized regions for this UI-only change. Preserve behavior, storage keys and permissions; require_plan if the requested change needs a new business rule or contract. Never embed the screenshot or its content in application source.')
            config['visualReview']=review
        # An ephemeral standard workspace must never resume a native thread
        # pinned to a removed historical cwd. Legacy workers retain pooling.
        worker_key=(owner,project_id,'build',task_id) if devkit_workspace else (owner,project_id,'build')
        worker=await self.svc.native_codex.acquire(worker_key,'driver.mjs',config_env)
        proc=worker.proc
        self.svc.processes[task_id]=proc
        proc.stdin.write((json.dumps(config,ensure_ascii=False)+'\n').encode())
        await proc.stdin.drain()
        async def consume():
            nonlocal idle
            while line:=await proc.stdout.readline():
                event=json.loads(line)
                kind=event.get('type')
                if kind=='idle':idle=True;break
                if kind=='session':
                    with self.svc.store.transaction():
                        current=self.svc.store.get(owner,project_id)
                        next(t for t in current['tasks'] if t['id']==task_id)['sessionId']=event['sessionId']
                        self.svc.store.save(current)
                    self.event(owner,project_id,task_id,{'type':'status','text':'Codex 原生会话已复用' if event.get('reused') else 'Codex 原生会话已连接','sessionId':event['sessionId'],'reused':event.get('reused',False),'workerPid':event.get('workerPid'),'appServerPid':event.get('appServerPid')})
                    continue
                if kind=='authorize':
                    self.svc.authorize_management(owner)
                    self.svc.engines.guard(owner,self.svc.store.get(owner,project_id),required=True)
                    executing=next(t for t in self.svc.store.get(owner,project_id)['tasks'] if t['id']==task_id)
                    if executing.get('editId'):self.svc.edits.live(owner,project_id,executing['editId'])
                    proc.stdin.write((json.dumps({'id':event['id'],'result':True})+'\n').encode())
                    await proc.stdin.drain()
                    continue
                if kind.startswith('terminal') or kind=='diagnostic':
                    self.event(owner,project_id,task_id,event)
                    continue
                current=self.svc.store.get(owner,project_id)
                task=next(t for t in current['tasks'] if t['id']==task_id)
                if task['state'] not in {'running','waiting'}:
                    continue
                if kind=='requires_plan':
                    self.event(owner,project_id,task_id,event)
                    if task.get('editId'):
                        def ask(p,e):
                            e.update({'state':'clarifying','question':{'focus':'iteration','text':event['requirement'],'why':event['reason'],'options':['保留原功能（推荐）｜本轮先完成其余明确修改。','补充要求｜我来说明这部分的具体规则。']}})
                            t=next(t for t in p['tasks'] if t['id']==task_id);t.update({'state':'failed','error':'EDIT_ANSWER_REQUIRED'})
                        self.svc.edits.mutate(owner,project_id,task['editId'],ask)
                        continue
                    with self.svc.store.transaction():
                        current=self.svc.store.get(owner,project_id)
                        task=next(t for t in current['tasks'] if t['id']==task_id)
                        dependency={'id':'codex-'+uuid4().hex,'requirement':event['requirement'],'reason':event['reason']}
                        current['solution']['dependencies'].append(dependency)
                        current['revisions'].append({'number':len(current['revisions'])+1,'hash':digest(current['solution']),'solution':json.loads(json.dumps(current['solution'])),'source':'development-clarification','createdAt':time.time()})
                        current['confirmation']=None;current['acceptance']=None
                        current['stage']='discovery';task['state']='failed';task['error']='PLAN_CLARIFICATION_REQUIRED'
                        self.svc.store.save(current)
                elif kind=='result':
                    await self.svc.add_artifact(owner,project_id,task_id,event['files'])
                elif kind in {'message','tool','status','activity','file','plan','policy','validation'}:
                    if task.get('editId') and kind=='validation':
                        self.svc.edits.mutate(owner,project_id,task['editId'],lambda p,e:e.update({'state':'validating'}))
                    self.event(owner,project_id,task_id,event)
                elif kind=='failed':
                    raise StudioError(str(event.get('code','BUILD_FAILED')))
            if not idle:raise StudioError('CODEX_CONNECTION_CLOSED')
            state=next(t for t in self.svc.store.get(owner,project_id)['tasks'] if t['id']==task_id)['state']
            if state in {'running','waiting'}:
                raise StudioError('BUILD_INCOMPLETE')
        consumer=asyncio.create_task(consume())
        guard=asyncio.create_task(self.guard_lease(owner,project_id))
        try:
            # First builds can spend over ten minutes generating multiple files.
            # Keep the live-session guard in charge of disconnect cancellation.
            done,_=await asyncio.wait({consumer,guard},timeout=self.TASK_TIMEOUT_SECONDS,return_when=asyncio.FIRST_COMPLETED)
            if not done:
                raise TimeoutError()
            for finished in done:
                await finished
        except BaseException as error:
            code=None
            with self.svc.store.transaction():
                current=self.svc.store.get(owner,project_id)
                task=next(t for t in current['tasks'] if t['id']==task_id)
                if task['state'] in {'running','waiting'}:
                    task['state']='cancelled' if isinstance(error,asyncio.CancelledError) else 'failed'
                    task['error']=error.code if isinstance(error,StudioError) else 'BUILD_TIMEOUT' if isinstance(error,TimeoutError) else 'BUILD_FAILED'
                    current['stage']=task['state']
                    self.svc.store.save(current)
                    code=task['error']
            if code:
                self.event(owner,project_id,task_id,{'type':'status','text':'开发未完成：'+code})
        finally:
            consumer.cancel()
            guard.cancel()
            await asyncio.gather(consumer,guard,return_exceptions=True)
            await self.svc.native_codex.release(worker,idle and not bool(devkit_workspace))
            self.svc.processes.pop(task_id,None)
            self.jobs.pop(task_id,None)

    async def stop(self, proc):
        if proc.returncode is None:
            if os.name=='nt':
                # Only the live child object started by this runner, never a
                # PID recovered from disk. /T includes its ACP descendants.
                killer=await asyncio.create_subprocess_exec('taskkill','/PID',str(proc.pid),'/T','/F',stdout=asyncio.subprocess.DEVNULL,stderr=asyncio.subprocess.DEVNULL)
                await killer.wait()
                await proc.wait()
                return
            try:
                os.killpg(proc.pid,signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                await asyncio.wait_for(proc.wait(),3)
            except TimeoutError:
                try:
                    os.killpg(proc.pid,signal.SIGKILL)
                except ProcessLookupError:
                    pass
                await proc.wait()

    async def cancel(self, owner, project_id, task_id, operation_id):
        def change(p):
            task=next((t for t in p['tasks'] if t['id']==task_id),None)
            if not task:
                raise StudioError('TASK_NOT_FOUND',404)
            if task['state'] in {'running','waiting','queued'}:
                task['state']='cancelled'
                task['question']=None
                p['stage']='cancelled'
        result=self.svc.store.mutate(owner,project_id,operation_id,{'action':'cancel','task':task_id},change)
        job=self.jobs.get(task_id)
        if job:
            job.cancel()
            await asyncio.gather(job,return_exceptions=True)
            self.jobs.pop(task_id,None)
        elif task_id in self.svc.processes:
            await self.stop(self.svc.processes[task_id])
        return result

    async def example(self, owner, project_id, operation_id):
        """Explicit local demonstration, with its provenance visible everywhere."""
        p=self.svc.store.get(owner,project_id)
        if p['artifacts']:
            return public(p)
        task_id='example_'+uuid4().hex
        def seed(project):
            # This explicitly labelled local fixture uses the historical miniapp
            # runtime; it must not masquerade as a standard Host project.
            project['devKit']=False
            solution={'audience':'需要跟进业务事项的个人用户','workflow':'新增、编辑、删除业务事项；按状态筛选；主动请求 AI 汇总；参考主动选择的资料。AI 建议经本人确认后才修改记录。','inputs':'事项信息和选定的 UTF-8 网盘文本资料','outputs':'持久保存的业务台账、进展汇总与待办建议','fields':['标题','业务对象','状态','负责人','截止日期','备注'],'acceptance':['事项可新增、编辑、删除与筛选','重新打开后记录仍然存在','AI 汇总仅作为建议展示','选定资料才可被读取','独立安装和更新保留正式记录'],'capabilities':['data','model','files'],'dependencies':[]}
            self.svc.revise(project,solution,'fixed-example')
            project['confirmation']={'hash':digest(project['solution']),'decisionsHash':digest(project['decisions']),'source':'fixed-example','createdAt':time.time()}
            project['tasks'].append({'id':task_id,'executor':'fixed-example','version':'1','state':'running','solutionHash':digest(project['solution']),'createdAt':time.time(),'events':[{'type':'status','text':'已载入固定交互样例；没有运行 DSH，也没有调用真实模型。','at':time.time()}],'question':None})
            project['example']=True
        self.svc.store.mutate(owner,project_id,operation_id,{'action':'example'},seed)
        folder=self.svc.project_root/'examples/ledger'
        files={f.relative_to(folder).as_posix():f.read_text(encoding='utf-8') for f in folder.rglob('*') if f.is_file()}
        return await self.svc.add_artifact(owner,project_id,task_id,files)
