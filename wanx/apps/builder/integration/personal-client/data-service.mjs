import {materialActions,materialRequest,materialDiagnostic} from '../team-client/starlink/material-contract.mjs';
import {validStarlinkTarget} from '../../../personal-client/applications/starlink-target.mjs';
import {validatedCorrection,validatedDeletion} from '../team-client/starlink/correction.mjs';
import {validatedWarehouseRename} from '../team-client/starlink/warehouse-rename.mjs';
import { needsBundledStarlink } from '../bundled-starlink-version.mjs';
// Personal Starlink uses the current account's normal application connection.
// It never borrows the Team administrator context or company data selector.
import { randomUUID } from 'node:crypto';
import {mkdtemp,mkdir,readdir,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SemanticaService } from '../team-client/starlink/service.mjs';
import drive from '../team-client/starlink/drive.cjs';
import { createDataShareAccess } from '../team-client/data-share-service.mjs';
import { dataInteractionKey } from '../../../personal-client/device-trust/data-context.mjs';
import { createStarlinkSpaceAnnotations } from './starlink-space-annotations.mjs';
const ID = 'centaurai.wanx.semantica';
const fail = code => Object.assign(Error(code), {code});
const actions = new Set(['material-workflows','material-workflow','initialize','warehouses','warehouse','create-warehouse','rename-warehouse','select-warehouse','documents','document','delete-document','correct','document-text','evidence','authorization-summary','jobs','graph','retrieval','search','retry-job','build-index','processing','reprocess-models','select-files','select-space-files','space-list','release-files','upload']);
const views = new Set(['warehouses','conversation','materials','graph','search','tasks','sensitive','models','skills','reasoning','api','data']);
const sourceActions = new Set(['document-text','evidence','authorization-summary']);
const governanceActions = new Set(['governance-summary','governance-reviews','governance-detail','governance-resolve','governance-flag','governance-propose','governance-apply','governance-unflag']);
function operationId(value,required=false) {
  if(value===undefined&&!required)return randomUUID();
  if(typeof value!=='string'||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value))throw fail('TEAM_DATA_TARGET_INVALID');
  return value;
}
function governanceRequest(action,input) {
  const writing=!['governance-summary','governance-reviews','governance-detail'].includes(action);
  const fields={
    'governance-summary':[], 'governance-reviews':['offset','limit'], 'governance-detail':['reviewId'],
    'governance-resolve':['reviewId','actionId','reason'], 'governance-flag':['kind','targetId','reason'],
    'governance-propose':['reviewId','reason'], 'governance-apply':['proposalId','confirmed'], 'governance-unflag':['reviewId'],
  }[action];
  const allowed=['warehouseId',...fields,...(writing?['operationId','expectedRevision']:[])];
  if(!input||Array.isArray(input)||Object.keys(input).some(k=>!allowed.includes(k))||
      typeof input.warehouseId!=='string'||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(input.warehouseId))throw fail('TEAM_DATA_TARGET_INVALID');
  const resource=value=>{if(typeof value!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(value))throw fail('TEAM_DATA_TARGET_INVALID');return value;};
  const prefix='/warehouses/'+input.warehouseId+'/workbench/governance';
  if(action==='governance-summary')return {path:prefix+'/summary'};
  if(action==='governance-reviews'){
    const offset=input.offset??0,limit=input.limit??20;
    if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>50)throw fail('TEAM_DATA_TARGET_INVALID');
    return {path:prefix+'/reviews?'+new URLSearchParams({offset:String(offset),limit:String(limit)})};
  }
  if(action==='governance-detail')return {path:prefix+'/reviews/'+resource(input.reviewId)};
  const operation=operationId(input.operationId,true),revision=input.expectedRevision;
  if(!Number.isSafeInteger(revision)||revision<(action==='governance-flag'?0:1))throw fail('TEAM_DATA_TARGET_INVALID');
  const body={operation_id:operation,expected_revision:revision,_native_operation_id:operation};
  if(Object.hasOwn(input,'reason')){
    if(typeof input.reason!=='string'||input.reason.length>2000)throw fail('TEAM_DATA_TARGET_INVALID');
    body.reason=input.reason.trim();
  }
  let endpoint;
  if(action==='governance-flag'){
    if(!['entity','relation'].includes(input.kind))throw fail('TEAM_DATA_TARGET_INVALID');
    Object.assign(body,{kind:input.kind,target_id:resource(input.targetId),reason:body.reason??'用户标记待核对'});endpoint='/flag';
  }else if(action==='governance-resolve'){
    body.action_id=resource(input.actionId);endpoint='/reviews/'+resource(input.reviewId)+'/resolve';
  }else if(action==='governance-propose'){
    if(!body.reason)throw fail('TEAM_DATA_TARGET_INVALID');
    body.review_id=resource(input.reviewId);endpoint='/proposals';
  }else if(action==='governance-apply'){
    if(input.confirmed!==true)throw fail('TEAM_DATA_TARGET_INVALID');
    body.confirmed=true;endpoint='/proposals/'+resource(input.proposalId)+'/apply';
  }else {body.review_id=resource(input.reviewId);endpoint='/unflag';}
  return {path:prefix+endpoint,options:{method:'POST',body,timeoutMs:330000}};
}
function sourcePath(action,input) {
  const fields=action==='document-text'?['warehouseId','id','versionId','start','end']:action==='evidence'?['warehouseId','id']:['warehouseId'];
  if(!input||Array.isArray(input)||Object.keys(input).some(k=>!fields.includes(k))||
      typeof input.warehouseId!=='string'||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(input.warehouseId))throw fail('TEAM_DATA_TARGET_INVALID');
  const prefix='/warehouses/'+input.warehouseId;
  if(action==='authorization-summary')return prefix;
  if(typeof input.id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(input.id))throw fail('TEAM_DATA_TARGET_INVALID');
  if(action==='evidence')return prefix+'/evidence/'+encodeURIComponent(input.id);
  const start=input.start??0,end=input.end;
  if(typeof input.versionId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(input.versionId)||
      !Number.isSafeInteger(start)||start<0||end!==undefined&&(!Number.isSafeInteger(end)||end<=start||end-start>65536))throw fail('TEAM_DATA_TARGET_INVALID');
  return prefix+'/documents/'+encodeURIComponent(input.id)+'/text?'+new URLSearchParams({version_id:input.versionId,start:String(start),...(end!==undefined?{end:String(end)}:{})});
}
async function authorizationSummary(service,warehouseId) {
  const warehouse=await service.call('warehouse',{id:warehouseId}),keys=await service.call('keys',{warehouseId});
  if(warehouse?.id!==warehouseId||!Array.isArray(keys?.items)||keys.items.some(k=>!k||!Number.isFinite(k.expires_at)))throw fail('TEAM_DATA_RESPONSE_INVALID');
  const now=Date.now()/1000;
  return {warehouseId,warehouse:{id:warehouseId,name:warehouse.name},active_count:keys.items.filter(k=>!k.revoked_at&&k.expires_at>now).length,
    expired_count:keys.items.filter(k=>!k.revoked_at&&k.expires_at<=now).length,revoked_count:keys.items.filter(k=>k.revoked_at).length};
}
export function personalStarlinkTarget(input = {}) {
  if(!input||Array.isArray(input)||Object.keys(input).some(k=>!['warehouseId','view','documentId','conversationId','intentId'].includes(k)))throw fail('TEAM_DATA_TARGET_INVALID');
  const target={kind:'personal-data',version:input.documentId!==undefined?2:1,warehouseId:input.warehouseId??null,view:input.view||'warehouses',
    ...Object.fromEntries(['documentId','conversationId','intentId'].filter(k=>Object.hasOwn(input,k)).map(k=>[k,input[k]]))};
  if(!validStarlinkTarget(target))throw fail('TEAM_DATA_TARGET_INVALID');
  return target;
}
export function createPersonalDataService({client, personalSpace, applications, selectFiles, getMcpDetails, writeClipboard, starlinkPackageDir, emit = () => {}}) {
  let active, pending, revision = 0, disposed = false;
  const key = () => dataInteractionKey(client.snapshot());
  function invalidate() {
    revision++; const previous = active; active = null; pending = null;
    previous?.service.close(); previous?.unwatch?.(); previous?.link.close?.();
    share.clear(); emit({type:'invalidated'});
  }
  const stop = client.subscribe(() => { if (active && active.key !== key()) invalidate(); });
  function live(entry) {
    if (disposed || !key() || entry.key !== key() || entry.revision !== revision) throw fail('HOST_SESSION_EXPIRED');
    entry.link.context();
  }
  async function entry() {
    if (disposed || !key()) throw fail('HOST_SESSION_EXPIRED');
    if (active) { try { live(active); return active; } catch { invalidate(); } }
    if (pending) return pending;
    const scope = key(), generation = revision;
    const work = (async () => {
      const link = await client.applicationConnection(ID);
      const value = {key:scope, revision:generation, link};
      try {
        live(value);
        const host = {
          close() {},
          context: async () => {live(value); return {...link.context(), dataScope:'personal'};},
          onSessionInvalidated: notify => link.subscribe(() => {try {live(value);} catch {notify();}}),
          async request(path, {body, headers = {}, method = 'GET', ...options} = {}) {
            live(value);
            headers = Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'x-wanx-data-context'));
            if (body != null && !(body instanceof Uint8Array)) {body = Buffer.from(JSON.stringify(body)); headers['content-type'] = 'application/json';}
            const result = await link.request({path, method, headers, ...options, ...(body != null ? {body} : {})});
            live(value);
            return new Response(result.body.length ? result.body : null, {status:result.status, headers:result.headers});
          },
        };
        host.drive = drive.createDriveClient(host);
        value.service = new SemanticaService({host, selectFiles, emit});
        value.annotations = createStarlinkSpaceAnnotations({space:personalSpace, service:value.service, check:() => live(value)});
        value.service.context = await host.context(); live(value); active = value;
        value.unwatch = link.onInvalidated?.(() => {if (active === value) invalidate();});
        return value;
      } catch (error) {value.service?.close(); link.close?.(); throw error;}
    })();
    pending = work;
    try {return await work;} finally {if (pending === work) pending = null;}
  }
  async function identity() {const value = await entry(); live(value); return {next:value.key};}
  async function instance() {return (await entry()).service;}
  async function installStarlink() {
    if(!starlinkPackageDir)throw fail('TEAM_STARLINK_PACKAGE_INVALID');
    const temporary=await mkdtemp(path.join(os.tmpdir(),'wanx-starlink-'));
    async function materialize(source,target){
      await mkdir(target,{recursive:true});
      for(const item of await readdir(source,{withFileTypes:true})){
        const from=path.join(source,item.name),to=path.join(target,item.name);
        if(item.isDirectory())await materialize(from,to);
        else if(item.isFile())await writeFile(to,await readFile(from),{flag:'wx'});
        else throw fail('TEAM_STARLINK_PACKAGE_INVALID');
      }
    }
    try{await materialize(starlinkPackageDir,path.join(temporary,'package'));await identity();return await applications.install({sourceDir:path.join(temporary,'package')})}
    finally{await rm(temporary,{recursive:true,force:true})}
  }
  // These are Starlink's existing warehouse-bound keys, not Team session keys.
  const share = createDataShareAccess({identity, instance, getMcpDetails, writeClipboard, identitySecurityEnabled:false});
  return {
    async action(action, input = {}) {
      if (action === 'release-share-key') return share.action(action, input);
      if (!materialActions.has(action) && !actions.has(action) && !governanceActions.has(action) && !share.supports(action) && action !== 'open-starlink') throw fail('TEAM_DATA_ACTION_DENIED');
      if(action==='correct')input=validatedCorrection(input);
      if(action==='rename-warehouse')input=validatedWarehouseRename(input);
      if(action==='delete-document')input=validatedDeletion(input);
      if(materialActions.has(action)) {
        try {
          const request=materialRequest(action,input), value=await entry(); live(value);
          const result=await value.service.api(request.path,{...request.options,diagnostic:true});
          live(value);
          return {materialResponse:{ok:true,...result}};
        } catch(error) {
          return {materialResponse:{ok:false,error:materialDiagnostic(error)}};
        }
      }
      const source=sourceActions.has(action)?sourcePath(action,input):null;
      const governance=governanceActions.has(action)?governanceRequest(action,input):null;
      const value = await entry(); live(value);
      let result;
      if(governance){
        try{result=await value.service.api(governance.path,governance.options)}
        catch(error){
          if(action!=='governance-summary'||error.code!=='SEMANTICA_OPERATION_NOT_ALLOWED')throw error;
          result={supported:false};
        }
      }
      else if(source)result=action==='authorization-summary'?await authorizationSummary(value.service,input.warehouseId):await value.service.api(source);
      else if (share.supports(action)) result = await share.action(action, input);
      else if (action === 'open-starlink') {
        const target = personalStarlinkTarget(input);
        if (target.warehouseId) {await value.service.call('warehouse', {id:target.warehouseId}); live(value);}
        const installed=(await applications.listInstalled()).find(a=>a.applicationId===ID);
        if (await needsBundledStarlink(installed,starlinkPackageDir,applications)) await installStarlink();
        live(value); result = await applications.launch({applicationId:ID, launchContext:target});
      } else {
        if (['create-warehouse','retry-job','build-index'].includes(action)) input = {...input, operationId:operationId(input.operationId)};
        if (['select-files','select-space-files','upload'].includes(action) && !value.service.capabilities) value.service.capabilities = await value.service.api('/capabilities');
        live(value); result = await value.annotations.run(action, input, () => value.service.call(action, input));
      }
      live(value); return result;
    },
    close() {disposed = true; stop(); invalidate();},
  };
}
