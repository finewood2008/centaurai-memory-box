import { randomUUID } from 'node:crypto';
import {createProjectPreview} from './project-preview.mjs';
import {exportStudioPackage} from './export-package.mjs';
import {createDeploymentDelivery} from './personal-client/deployment-delivery.mjs';

const fail = code => Object.assign(new Error(code), { code });
// HTTP details stay inside the trusted Host, never on IPC-facing Error objects.
const responseMetadata = new WeakMap();
const projectId = id => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);
const scope = context => JSON.stringify([context.accountId, context.boxId, context.user.id]);
const connectionScope=context=>context&&['accountId','clientId','boxId'].every(key=>typeof context[key]==='string'&&context[key])?JSON.stringify([context.accountId,context.clientId,context.boxId]):'';

// Project metadata crosses into the client renderer; executable previews use a
// separate opaque sandbox channel. Credentials stay inside the trusted Host.
export function projectSummary(p) {
  const states = {
    discovery: ['正在梳理需求', '继续讨论'], confirmed: ['等待确认', '继续核对方案'],
    building: ['开发中', '查看进展'], waiting: ['等待回答', '回答问题'],
    preview: ['有新版本可试用', '打开产品'], adopted:['持续改进', '打开产品'], accepted: ['已有采用版本', '继续改进'],
    installed: ['已安装', '继续开发'], failed: ['开发未完成', '查看原因'],
    interrupted: ['任务已中断', '查看原因'], cancelled: ['已停止', '继续开发'],
  };
  let [label, action] = states[p.stage] || ['继续开发', '打开项目'];
  let attention = { waiting: '有一个开发问题需要你回答', preview: '新成果已生成，试用后可选择采用', adopted:'已采用，可继续改进或导出', accepted: '已有采用版本，可继续改进或导出', failed: '开发遇到问题，请查看原因', interrupted: '上次开发已中断，可以查看记录后继续' }[p.stage] || '';
  if(p.preparation?.phase==='intake'){label='构建准备';action='继续配置'}
  const adoptedHash=p.versioning?.adoptedHash||p.acceptance?.artifactHash||null;
  const adopted=p.artifacts?.find(a=>a.hash===adoptedHash);
  const s = p.solution;
  const ready = p.readiness?.ready ?? (s && ['audience', 'workflow', 'inputs', 'outputs'].every(k => s[k]?.trim()) && s.acceptance?.length && s.dependencies?.every(d => ['manual', 'defer'].includes(p.decisions?.[d.id]?.choice)));
  if (p.stage === 'discovery' && ready && !p.preparation) {
    label = '方案待确认'; action = '查看方案'; attention = '需求方案已整理好，请查看并确认';
  }
  return { id: p.id, appId: p.appId, name: p.name, goal: p.originalGoal, stage: p.stage,
    versions:(p.versions||p.artifacts?.slice().reverse()||[]).map(v=>Object.fromEntries(['hash','version','createdAt','baseHash','summary','status','restoredFrom'].map(k=>[k,v[k]]))),
    label, action, attention, preparationPhase:p.preparation?.phase||null, updatedAt: p.updatedAt,
    adoptedArtifactHash:adopted?.hash||null,adoptedTaskId:adopted?.taskId||null,adoptedVersion:adopted?.version||null,iterationState:p.versioning?.iteration?.state||null,
    deletedAt:p.deletedAt||null, nameMode:p.nameMode||'manual', latestTaskId:p.tasks?.at(-1)?.id||null, latestArtifactHash:p.artifacts?.at(-1)?.hash||null, acceptedArtifactHash:p.acceptance?.artifactHash||null, installedVersion: p.installed?.version || null, latestVersion: p.artifacts?.at(-1)?.version || null };
}

export function createStudioEntry({ createConnection, applications, assets, openWorkspace,workspacePlacement,chooseExport=async()=>{throw fail('STUDIO_EXPORT_UNAVAILABLE')},deploymentRoot,onDeploymentChanged,deploymentIntervalMs=2500,deploymentConnection }) {
  let destination = null;
  let closed=false,authorizationRevision=0,delivery,authorized,unsubscribe,unsubscribeConnection,observedConnection='';
  function clearDelivery(){unsubscribe?.();unsubscribe=null;authorized=null;delivery?.invalidate()}
  function close(){if(closed)return;closed=true;authorizationRevision++;destination=null;unsubscribeConnection?.();unsubscribeConnection=null;clearDelivery();delivery?.close()}
  async function enableDelivery(s,revision){
    if(!deploymentRoot||!applications.installDeployment)return;
    // /context is also readable by published-app users. Only this server-side
    // management check can authorize the main-process deployment worker.
    let capability;
    try{capability=await s.request('/deployment/capabilities')}
    catch(error){
      const response=responseMetadata.get(error);
      if(response?.status!==404||!response.routeMissing||error.code!=='STUDIO_REQUEST_FAILED')throw error;
      if(closed||revision!==authorizationRevision)throw fail('HOST_SESSION_EXPIRED');
      s.assertLive();
      // Older boxes may lack deployment routes. Opening the workbench still
      // requires the existing server-side management gate; no worker is enabled.
      let management;
      try{management=await s.request('/_builder/context')}
      catch(error){
        const response=responseMetadata.get(error);
        if(response?.status===404&&response.routeMissing&&error.code==='STUDIO_REQUEST_FAILED')throw fail('STUDIO_BOX_UPDATE_REQUIRED');
        throw error;
      }
      if(closed||revision!==authorizationRevision)throw fail('HOST_SESSION_EXPIRED');
      s.assertLive();
      if(management?.protocolVersion!==1||management.iterativeBuild!==1)throw fail('STUDIO_RESPONSE_INVALID');
      return;
    }
    if(closed||revision!==authorizationRevision)throw fail('HOST_SESSION_EXPIRED');
    s.assertLive();if(capability?.available!==true||capability.schemaVersion!==1||!Array.isArray(capability.operations)||!capability.operations.includes('deploy'))return;
    authorized=s;
    const invalidated=()=>{if(authorized===s){authorizationRevision++;clearDelivery()}};
    const off=s.active.link.onInvalidated?.(invalidated)||s.active.link.subscribe?.(()=>{try{s.assertLive()}catch{invalidated()}});
    if(authorized!==s){off?.();throw fail('HOST_SESSION_EXPIRED')}
    unsubscribe=off;
    delivery||=createDeploymentDelivery({runtimeNamespace:'studio',root:deploymentRoot,assets,applications,onChanged:onDeploymentChanged,intervalMs:deploymentIntervalMs,
      scopeKey:()=>authorized?.key||'',session:async()=>{if(!authorized||closed)throw fail('HOST_SESSION_EXPIRED');authorized.assertLive();return authorized}});
    void delivery.tick();
  }
  const exports=new Map();
  async function authorize(expectedConnection){
    const revision=++authorizationRevision;clearDelivery();const s=await session();
    if(expectedConnection&&connectionScope(s.active.link.context())!==expectedConnection)throw fail('HOST_SESSION_EXPIRED');
    await s.request('/context');s.assertLive();if(closed||revision!==authorizationRevision)throw fail('HOST_SESSION_EXPIRED');await enableDelivery(s,revision);return s.assertLive;
  }
  function connectionChanged(){
    if(closed)return;let next='';try{next=connectionScope(deploymentConnection.getContext())}catch{}
    if(next===observedConnection)return;
    observedConnection=next;authorizationRevision++;clearDelivery();
    // This is recovery of already accepted delivery, not a new deployment.
    // A normal user's denial stays silent and is cached until the scope changes.
    if(next)void authorize(next).catch(()=>{});
  }
  async function session() {
    if(closed)throw fail('HOST_SESSION_EXPIRED');
    const connection = await createConnection('ai.wanx.studio');
    if(closed)throw fail('HOST_SESSION_EXPIRED');
    const key = scope(connection.context());
    const assertLive = () => { if(closed)throw fail('HOST_SESSION_EXPIRED');if (scope(connection.context()) !== key) throw fail('STUDIO_CONTEXT_CHANGED'); };
    async function request(route, method = 'GET', body) {
      assertLive();
      const response = await connection.request({ path: '/api/app-studio' + route, method,
        signal: AbortSignal.timeout(route==='/preflight'?60000:route.startsWith('/_client/launch')||route.endsWith('/intake')||route.endsWith('/capabilities/check')?240000:60000), ...(body ? { headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(body)) } : {}) });
      assertLive();
      let raw = response.body;
      if (raw?.[Symbol.asyncIterator]) {
        const chunks = []; let size = 0;
        for await (const chunk of raw) { size += chunk.length; if (size > 16 * 1024 * 1024) throw fail('STUDIO_RESPONSE_TOO_LARGE'); chunks.push(chunk); }
        raw = Buffer.concat(chunks);
      }
      assertLive();
      if ((response.status === 404 || response.status === 503) && !route.includes('/context') && !route.includes('/intake') && !route.includes('/capabilities')) throw fail('STUDIO_UNAVAILABLE');
      try { const value=JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : typeof raw === 'string' ? raw : JSON.stringify(raw));
        const accepted=response.status===202&&method==='POST'&&/^\/(?:deployment\/operations(?:\/[a-f0-9]{32}\/resume)?|deployment\/directory-releases\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/submit|projects\/[a-f0-9]{32}\/deployment\/submit)$/.test(route);
        if(response.status!==200&&!accepted){const code=value.code||value.detail?.code,error=fail(typeof code==='string'&&/^[A-Z_]{4,80}$/.test(code)?code:'STUDIO_REQUEST_FAILED');if(method==='GET'&&['/deployment/capabilities','/_builder/context'].includes(route))responseMetadata.set(error,{status:response.status,routeMissing:value.detail==='Not Found'});throw error}return value; }
      catch(error) { if(error.code)throw error;throw fail('STUDIO_RESPONSE_INVALID'); }
    }
    return { key, request, assertLive,active:{link:connection} };
  }
  const preview=createProjectPreview(session);
  async function openIn(s, id) {
    s.assertLive();
    const target = { projectId: id, navigationId: randomUUID(), scope: s.key, assertLive: s.assertLive };
    destination = target;
    try { if(openWorkspace)await openWorkspace({protocolVersion:2,projectId:id});else await applications.launch('ai.wanx.studio'); }
    catch (error) { if (destination === target) destination = null; throw error; }
    s.assertLive(); if(!openWorkspace)applications.activate?.('ai.wanx.studio');
    return { projectId: id };
  }
  if(deploymentRoot&&deploymentConnection){unsubscribeConnection=deploymentConnection.subscribe(connectionChanged);queueMicrotask(connectionChanged)}
  return Object.freeze({
    close,
    ...preview,
    async runtimeModel(input){
      if(!projectId(input?.projectId))throw fail('STUDIO_PROJECT_INVALID');
      const s=await session();
      try{return await s.request('/_client/projects/'+input.projectId+'/runtime-model')}
      catch(e){if(e.code==='STUDIO_UNAVAILABLE')throw fail('RUNTIME_MODEL_UPDATE_REQUIRED');throw e}
    },
    async runtimeModelSave(input){
      if(!projectId(input?.projectId)||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0||typeof input.operationId!=='string'||(input.modelId!==null&&(typeof input.modelId!=='string'||input.modelId.length>128)))throw fail('STUDIO_REQUEST_DENIED');
      const s=await session();return s.request('/_client/projects/'+input.projectId+'/runtime-model','PUT',{operationId:input.operationId,expectedRevision:input.expectedRevision,modelId:input.modelId});
    },
    authorize,
    async launchSuggest(input){const s=await session();return s.request('/_client/launch/suggest','POST',{text:input?.text})},
    async launchSources(input){const s=await session();if(!['warehouses','storage','references'].includes(input?.kind))throw fail('CONTEXT_REFERENCE_INVALID');return s.request('/_client/launch/sources?kind='+input.kind+'&parent='+encodeURIComponent(input.parent||'')+'&spaceId='+encodeURIComponent(input.spaceId||'personal'))},
    async launchConfigure(input){const s=await session();if(input?.projectId&&!projectId(input.projectId))throw fail('STUDIO_PROJECT_INVALID');return s.request('/_client/launch/configure','POST',input)},
    async launchStart(input){const s=await session();if(!projectId(input?.projectId))throw fail('STUDIO_PROJECT_INVALID');const p=await s.request('/_client/launch/'+input.projectId+'/start','POST',{});await openIn(s,p.id);return p},
    async placement(input){if(!workspacePlacement)throw fail('HOST_BRIDGE_UPDATE_REQUIRED');return workspacePlacement(input)},
    async enginesList(){return (await session()).request('/engines')},
    async enginesCheck(input){if(input?.engineId!=='codex')throw fail('ENGINE_NOT_ADAPTED');return(await session()).request('/engines/check','POST',{engineId:input.engineId})},
    async enginesDefault(input){if(input?.engineId!=='codex')throw fail('ENGINE_NOT_ADAPTED');return(await session()).request('/engines/default','PUT',{engineId:input.engineId})},
    async intakeOpen(input={}) {
      const s=await session();
      if(input.projectId){if(!projectId(input.projectId))throw fail('STUDIO_PROJECT_INVALID');return s.request('/projects/'+input.projectId)}
      if(input.goal){
        if(typeof input.goal!=='string'||!input.goal.trim()||input.goal.length>12000||typeof input.operationId!=='string')throw fail('STUDIO_CREATE_INVALID');
        return s.request('/projects','POST',{name:'待命名项目',goal:input.goal.trim(),intake:true,operationId:input.operationId});
      }
      const [context,catalog]=await Promise.all([s.request('/context'),s.request('/capabilities')]);
      if(context.features?.taskPreparation!==1)throw fail('HOST_BRIDGE_UPDATE_REQUIRED');return{context,catalog};
    },
    async intakeSend(input){const s=await session();if(!projectId(input?.projectId))throw fail('STUDIO_PROJECT_INVALID');return s.request('/projects/'+input.projectId+'/intake','POST',{operationId:input.operationId,text:input.text})},
    async intakeState(input){const s=await session();if(!projectId(input?.projectId))throw fail('STUDIO_PROJECT_INVALID');return s.request('/projects/'+input.projectId+'/intake')},
    async intakeEvents(input){const s=await session();if(!projectId(input?.projectId)||!Number.isSafeInteger(input.after||0)||(input.after||0)<0)throw fail('STUDIO_PROJECT_INVALID');return s.request('/projects/'+input.projectId+'/intake/events?after='+(input.after||0))},
    async contextSources(input){const s=await session();if(!['space','xingtu'].includes(input?.kind)||input.parent&&!(input.kind==='xingtu'?/^offset:[0-9]{1,7}$/:/^[A-Za-z0-9_-]{1,128}$/).test(input.parent))throw fail('CONTEXT_REFERENCE_INVALID');return s.request('/context/sources?kind='+input.kind+'&parent='+encodeURIComponent(input.parent||''))},
    async contextSelect(input){const s=await session();if(!projectId(input?.projectId))throw fail('STUDIO_PROJECT_INVALID');return s.request('/projects/'+input.projectId+'/context','PUT',{operationId:input.operationId,expectedRevision:input.expectedRevision,references:input.references})},
    async capabilitiesList(){const s=await session();return s.request('/capabilities')},
    async capabilitiesState(input){const s=await session();if(!projectId(input?.projectId))throw fail('STUDIO_PROJECT_INVALID');return s.request('/projects/'+input.projectId+'/capabilities')},
    async capabilitiesDecide(input){const s=await session();if(!projectId(input?.projectId))throw fail('STUDIO_PROJECT_INVALID');return s.request('/projects/'+input.projectId+'/capabilities/decisions','POST',{operationId:input.operationId,gapId:input.gapId,detail:input.detail})},
    async capabilitiesCheck(input){const s=await session();if(!projectId(input?.projectId))throw fail('STUDIO_PROJECT_INVALID');return s.request('/projects/'+input.projectId+'/capabilities/check','POST',{operationId:input.operationId})},
    async intakeHandoff(input){const s=await session();if(!projectId(input?.projectId))throw fail('STUDIO_PROJECT_INVALID');const p=await s.request('/projects/'+input.projectId+'/intake/handoff','POST',{operationId:input.operationId,expectedRevision:input.expectedRevision});await openIn(s,p.id);return p},
    async overview() {
      const s = await session();
      const [result, context] = await Promise.all([s.request('/projects?includeDeleted=true'), s.request('/context')]);
      s.assertLive();
      return { protocolVersion:2, projects: result.projects.map(projectSummary), modelAvailable: context.modelAvailable };
    },
    async create(input) {
      if (!input || typeof input.goal !== 'string' || !input.goal.trim() || input.goal.length > 12000 || typeof input.operationId !== 'string' || !/^[a-f0-9-]{36}$/.test(input.operationId)) throw fail('STUDIO_CREATE_INVALID');
      const s = await session(), goal = input.goal.trim();
      const p = await s.request('/projects', 'POST', { goal, name: goal.slice(0, 20), operationId: input.operationId });
      return openIn(s, p.id);
    },
    async workspace(input={}) {
      if(input.protocolVersion!==2)throw fail('HOST_BRIDGE_UPDATE_REQUIRED');
      const s=await session();const c=await s.request('/context');
      if(!openWorkspace&&!c.modelAvailable)throw fail('MODEL_NOT_CONFIGURED');
      if(!openWorkspace)await s.request('/preflight');
      return openIn(s,null);
    },
    async metadata(input) {
      if(!projectId(input?.projectId)||!['rename','auto-name','delete','restore'].includes(input.action)||typeof input.operationId!=='string')throw fail('STUDIO_PROJECT_INVALID');
      const s=await session();return s.request('/projects/'+input.projectId+'/metadata','PUT',{operationId:input.operationId,action:input.action,name:input.name||''});
    },
    async export(input) {
      const s=await session();const key=s.key+JSON.stringify(input);if(exports.has(key))return exports.get(key);
      const job=exportStudioPackage({input,request:s.request,assertLive:s.assertLive,assets,chooseExport}).finally(()=>exports.delete(key));exports.set(key,job);return job;
    },
    async open(input) {
      if(input?.protocolVersion!==undefined&&input.protocolVersion!==2)throw fail('HOST_BRIDGE_UPDATE_REQUIRED');
      if (!projectId(input?.projectId)) throw fail('STUDIO_PROJECT_INVALID');
      const s = await session();
      await s.request('/projects/' + input.projectId);
      return openIn(s, input.projectId);
    },
    navigation(connection) {
      if (!destination || destination.scope !== scope(connection.context())) return { projectId: null };
      try { destination.assertLive(); } catch { destination = null; return { projectId: null }; }
      const { projectId, navigationId } = destination;
      destination = null;
      return { projectId, navigationId, protocolVersion:2 };
    },
  });
}
