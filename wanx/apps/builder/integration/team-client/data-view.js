import {unwrapMaterialResponse} from './starlink/material-contract.mjs';
import {wrapAssistantKnowledgeAccess} from './assistant-knowledge-access.js';
import {selectGraph,graphVisibility,layoutConstellations,describeConstellations,edgeGeometry,labelLines} from './starlink/graph.mjs';
import {createGraphMotion} from './starlink/motion.mjs';
import {createMaterialBrowser} from './starlink/materials.mjs';
import {retainGraphInput,createGraphComposition} from './starlink/editing.mjs';
import {createWarehouseJournal,warehouseRecoveryScope,warehouseInput,ontologySummary} from './starlink/quick-warehouse.mjs';
import {createWarehouseRenameJournal} from './starlink/rename-warehouse.mjs';
window.createTeamDataView=({request,changed,edition="team"})=>{
  const graphMotion=createGraphMotion();
  const team=edition==="team",owner=team?"团队":"个人";
  const warehouseJournal=createWarehouseJournal(()=>window.localStorage);
  const renameJournal=createWarehouseRenameJournal(()=>window.localStorage);
  let ontologyDetail=null,ontologyError='',recoveryScope=null;
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const names={queued:'排队中',running:'处理中',processing:'处理中',ready:'正文就绪',succeeded:'已完成',failed:'失败',cancelled:'已取消',active:'可用',importing:'迁入中',clearing:'清理中',deleting:'删除中'};
  const jobNames={document_parse:'材料解析',ontology_suggest:'本体建议',knowledge_extract:'知识抽取',knowledge_publish:'图谱写入',knowledge_retract:'图谱更新',sensitive_scan:'保护检测',search_index:'检索索引',search_index_build:'检索索引'};
  const stageNames={accepted:'等待处理',retry_queued:'等待重试',generating_suggestions:'生成建议',extracting_entities:'抽取实体',extracting_relations:'抽取关系',completed:'已完成',failed:'处理失败',cancelled:'已取消',publishing:'正在写入图谱',published:'图谱已写入',review_ready:'抽取完成',index_ready:'索引就绪',superseded:'已被新任务取代'};
  const tabs=[['graph','知识图谱'],['materials','资料']];
  let scope=null,admin=false,epoch=0,loading=false,searching=false,busy=false,error='',errorCode='',warehouses=[],warehouseId=null,tab='graph',query='',filter='',documents=[],jobs=[],graph={nodes:[],edges:[]},results=[],retrieval=null,node=null,offset=0,total=0,initialized=false;
  let overviewWarehouseId=null,graphError='',graphQuery='',graphType='all',edge=null,zoom=1,graphCache=null;
  let constellation=null,starMetric='relations',showIsolated=false;
  let refreshTimer,loadingTimer,contentReady=false,refreshVisible=false,refreshing=false;
  let sharePreview=null,shareError='',governance=null,governanceError='',reviews=[],reviewTotal=0,reviewsOffset=0,review=null,proposal=null,panel=null,panelLoading=false,sourceValue=null,pendingGovernance=null,detailSequence=0,governanceWriting=false;
  let annotationSearch=null;
  const pendingAnnotationImports=new Map();
  const defaultTypeInfo={
    PERSON:['人物','人','#7a91a9'],ORG:['组织','组','#7c967e'],GPE:['地点','地','#739b92'],
    EVENT:['事件','事','#8c83a6'],CONCEPT:['概念','知','#b28f93'],DOCUMENT:['材料','文','#9c9780'],
    PRODUCT:['产品与系统','品','#b89561'],FEATURE:['功能','功','#ac986d'],TECHNOLOGY:['方法与技术','技','#8b8faa'],
    DATE:['日期','日','#899da9'],PROJECT:['项目','项','#7b8d70'],BUSINESS_OBJECT:['业务对象','业','#b18564'],
    PROCESS:['流程','流','#63958c'],TASK:['任务','任','#9a7d9c'],METRIC:['指标','指','#688da7'],
    ISSUE:['问题与风险','险','#b47872'],OTHER:['其它','其','#8d8a86'],
  };
  function customTypeColor(type){
    let hash=0;for(const char of type)hash=(Math.imul(hash,31)+char.codePointAt(0))>>>0;
    return ['#768fb4','#aa856f','#8b91b0','#729d84','#ad8499','#9b9b65'][hash%6];
  }
  const defaultRelationNames={PREFERS:'情境偏好',FOUNDED:'创办',CREATED:'创建',PART_OF:'属于',HAS_FEATURE:'具有功能',USES:'使用',OCCURRED_AT:'发生于',WORKS_AT:'任职于',LOCATED_IN:'位于'};
  const graphWarehouse=()=>warehouses.find(w=>w.id===(warehouseId||overviewWarehouseId));
  function clearGraph(){showIsolated=false;graphMotion.reset();graph={nodes:[],edges:[]};graphError='';graphCache=null;node=null;edge=null;zoom=1;graphQuery='';graphType='all';constellation=null}
  const code=e=>String(e?.code||e?.message||'');
  const invalidScope=e=>e?.httpStatus===401||e?.httpStatus===403||/ADMIN_REQUIRED|OWNER_REQUIRED|SESSION|AUTH|FORBIDDEN/.test(code(e));
  const message=e=>{
    const c=code(e);
    const creationErrors={WAREHOUSE_NAME_CONFLICT:'已有同名数据仓，请修改名称。',WAREHOUSE_NAME_INVALID:'请填写 1 至 60 字符的名称，不包含控制字符。',WAREHOUSE_DESCRIPTION_INVALID:'说明不能超过 500 字符。',WAREHOUSE_RECOVERY_UNAVAILABLE:'无法保存或读取建仓恢复记录，请检查本地存储后重试。',WAREHOUSE_CREATION_PENDING:'上次建仓结果尚未确认，请先恢复原请求，不能更换内容重复建仓。',WAREHOUSE_CREATION_INVALID:'名称或说明格式不正确，请修改后重试。',WAREHOUSE_CREATION_UNCERTAIN:'建仓结果尚未确认，已保留原请求。请重试或重新打开建仓窗口恢复，勿重复新建。',WAREHOUSE_CREATION_CONFLICT:'操作号与请求不一致，请恢复原请求核对，不能盲目重试。'};
    if(creationErrors[c])return creationErrors[c];
    const renameErrors={WAREHOUSE_INVALID_NAME:'请填写 1 至 60 字符的名称，不包含控制字符。',WAREHOUSE_RENAME_PENDING:'上次保存结果尚未确认，请先重试原名称。',WAREHOUSE_RENAME_UNCERTAIN:'名称保存结果尚未确认，请重试保存。',WAREHOUSE_RENAME_RECOVERY_UNAVAILABLE:'无法保存或读取待确认的改名记录，请检查本地存储后重试。',WAREHOUSE_RENAME_CONFLICT:'上次保存请求与服务端记录不一致，请核对原操作后重试。'};
    if(renameErrors[c])return renameErrors[c];
    if(c==='MODELING_CONFIRMATION_REQUIRED')return '此材料属于对话建模材料，不支持普通自动抽取。当前入口仅处理普通材料，未转换材料类型。';
    if(c==='TEAM_DATA_REVIEW_CHANGED')return '建议已保存在原事项中，请重新打开原事项核对，未应用到当前选择。';
    if(c==='TEAM_DATA_OPERATION_UNCONFIRMED')return '上一项操作的结果尚未确认，请先查询或重试原操作，再发起新的修改。';
    if(c.startsWith('WAREHOUSE_GOVERNANCE_'))return ({REVISION_CONFLICT:'核对事项已更新，请刷新后重新确认。',SOURCE_CHANGED:'来源已变化，请刷新并重新核对当前来源。',DRAFT_CHANGED:'知识草稿已变化，请刷新后重新核对。',TARGET_CHANGED:'目标知识已变化，请刷新后重新核对。',REVIEW_CLOSED:'此核对事项已关闭，请刷新列表。',HUMAN_EDIT_PROTECTED:'这项知识包含人工修正，请通过知识治理功能核对。',MULTI_SOURCE_REVIEW_REQUIRED:'这项修改涉及多份资料，请通过知识治理功能核对。',SOURCE_REVIEW_REQUIRED:'请先核对来源，再决定是否修改。',OPERATION_CONFLICT:'此操作标识对应的内容不同，请刷新后重新确认。',MODEL_OUTPUT_INVALID:'模型未返回可验证的修改建议，原知识保持不变。',MODEL_EVIDENCE_INVALID:'模型引用的证据未通过校验，原知识保持不变。',MODEL_EVIDENCE_INSUFFICIENT:'现有证据不足以支持建议，保留待核对。',MODEL_VALIDATION_FAILED:'模型建议未通过校验，原知识保持不变。',IDENTITY_REVIEW_REQUIRED:'身份尚未确认，请先核对身份，不能作为跨资料连接。',AI_UNAVAILABLE:'当前处理模型不可用，请检查模型与处理配置。',PROPOSAL_NOT_READY:'建议尚未准备完成或证据不足，当前不能应用。',CONFIRMATION_REQUIRED:'请先核对修改内容并明确确认。',PROPOSAL_IN_PROGRESS:'原建议操作仍在后台处理中或曾被中断，请刷新事项核对，服务端不会重复发起模型调用。'}[c.slice('WAREHOUSE_GOVERNANCE_'.length)]||'治理操作未完成，请刷新事项核对原因；原知识尚未改写。');
    if(c==='TEAM_DATA_SOURCE_VERSION_CHANGED')return '来源版本未能验证，未展示可能已变化的正文。请在完整版核对历史版本。';
    if(c==='SPACE_ANNOTATION_INDEX_PENDING')return '资料已导入，空间标签索引尚未完成。请重试标签索引；重试使用原导入记录。';
    if(c==='TEAM_DATA_KEY_NOT_REPLAYABLE')return '完整 Key 已不可再次读取，请新建只读 Key 并及时保存。';
    if(c==='TEAM_DATA_KEY_REVOKED')return '此 Key 已撤销或到期，无法继续复制或查看。';
    if(c==='TEAM_DATA_SHARE_INVALID')return '请填写用途名称，并选择 1 至 365 天的有效期。';
    if(c==='TEAM_CLIPBOARD_UNAVAILABLE')return '系统剪贴板暂不可用，请稍后重试。';
    if(!team&&c==='SEMANTICA_SERVICE_AUTH_FAILED')return '盒子与星图服务的接入鉴权失败，请检查盒端星图服务配置。';
    if(!team&&c==='SEMANTICA_RESOURCE_FORBIDDEN')return '当前账号无权访问此个人数据仓。';
    if(c==='SEMANTICA_SERVICE_AUTH_FAILED')return '盒子与星图服务的接入鉴权失败，请管理员检查服务凭据及团队接入版本。';
    if(c==='SEMANTICA_RESOURCE_FORBIDDEN')return '星图服务拒绝访问当前团队数据，请管理员检查团队数据权限与接入配置。';
    if(c==='SEMANTICA_RESOURCE_NOT_FOUND')return '星图服务未找到所请求的资源，请刷新重试；如持续出现，请管理员检查盒端接入版本。';
    if(c==='SEMANTICA_INVALID_REQUEST')return '星图服务未接受当前请求，请管理员检查团队客户端与盒端接入版本是否兼容。';
    return ({SEMANTICA_NOT_CONFIGURED:'当前盒子尚未配置星图服务。',SEMANTICA_SERVICE_UNAVAILABLE:'星图服务暂时不可用，请检查盒子服务后重试。',SEMANTICA_UPGRADE_REQUIRED:'当前盒子需要升级星图接入。',TEAM_STARLINK_NOT_INSTALLED:'尚未安装星图，请到“应用”中安装星图后重试。',APPLICATION_INSTALL_FAILED:'星图安装未完成，请检查应用目录权限后重试。',TEAM_STARLINK_PACKAGE_INVALID:'内置星图安装文件不完整，请重新安装团队客户端。',TEAM_STARLINK_UPGRADE_REQUIRED:'当前星图不支持数据仓定位，请更新星图。',TEAM_STARLINK_OPEN_TIMEOUT:'星图未确认打开目标页面，请检查星图中的连接状态后重试。',TEAM_ADMIN_REQUIRED:'管理员权限已失效，请重新核验团队身份。',SEMANTICA_ADMIN_REQUIRED:'当前账号没有团队数据管理权限。',HOST_SESSION_EXPIRED:'账号或盒子连接已变化，请重新打开数据页。',TEAM_SESSION_CHANGED:'账号或盒子连接已变化，请重新操作。',SPACE_UPGRADE_REQUIRED:'当前盒子不支持空间读取，请升级服务或从本地导入。',SPACE_REMOTE_FILE_CHANGED:'所选空间文件已变化，请重新选择。',MODEL_CLOUD_CONFIRMATION_REQUIRED:'请先在星图的“模型与处理”中确认在线模型使用范围。',WAREHOUSE_BUSY:'数据仓正在迁移或清理，请等待操作完成。'}[c]||'操作未完成，请检查连接、处理任务或星图配置后重试。');
  };
  const call=async(action,input={})=>unwrapMaterialResponse(await request('data.'+action,input));
  const current=()=>graphWarehouse();
  const activeId=()=>warehouseId||overviewWarehouseId;
  const composition=createGraphComposition(()=>JSON.stringify([scope,activeId()]));
  const badge=v=>`<span class="data-status ${v==='failed'?'failed':v==='active'||v==='succeeded'?'ready':''}">${esc(names[v]||v||'待处理')}</span>`;
  const size=v=>v>=1024*1024?(v/1024/1024).toFixed(1)+' MB':Math.ceil((v||0)/1024)+' KB';
  const loc=value=>{
    let v=value;
    if(typeof v==='string'){try{v=JSON.parse(v)}catch{return v}}
    if(!v)return '来源片段';
    const refs=Array.isArray(v.source_segments)?v.source_segments:[];
    const first=refs[0]?.locator||v,last=refs.at(-1)?.locator||first;
    const sheet=first.sheet||first.sheet_name,slide=first.slide,row=first.row;
    if(sheet||slide!=null||row!=null){
      const range=sheet===(last.sheet||last.sheet_name)&&slide===last.slide&&last.row>row?row+'–'+last.row:row;
      return [sheet?`工作表 ${sheet}`:'',slide!=null?`第 ${slide} 张幻灯片`:'',row!=null?`第 ${range} 行`:''].filter(Boolean).join(' · ');
    }
    const paragraph=v.paragraph_number??v.paragraph??(v.paragraph_index==null?null:v.paragraph_index+1);
    return [v.page_number||v.page?`第 ${v.page_number||v.page} 页`:'',paragraph!=null?`第 ${paragraph} 段`:'',
      v.start_seconds!=null?`${v.start_seconds} 秒`:'',v.segment_id||''].filter(Boolean).join(' · ')||'原文片段';
  };
  function clearLoading(){if(loadingTimer!==undefined){clearTimeout(loadingTimer);loadingTimer=undefined}}
  function readFailure(e){const text=message(e),failure=code(e);if(invalidScope(e)){reset();error=text;errorCode=failure;changed()}else{error=text;errorCode=failure}}
  function reset(){annotationSearch=null;pendingAnnotationImports.clear();ontologyDetail=null;ontologyError='';closeMoreMenu();materialBrowser.reset();detailSequence++;governanceWriting=false;clearTimeout(refreshTimer);clearLoading();epoch++;warehouses=[];warehouseId=null;overviewWarehouseId=null;documents=[];jobs=[];results=[];clearGraph();sharePreview=null;shareError='';governance=null;governanceError='';reviews=[];reviewTotal=0;reviewsOffset=0;review=null;proposal=null;panel=null;sourceValue=null;panelLoading=false;pendingGovernance=null;retrieval=null;loading=false;searching=false;contentReady=false;refreshVisible=false;busy=false;error='';errorCode='';initialized=false;query='';offset=0;total=0;document.querySelectorAll?.('dialog[data-team-data-dialog]').forEach(d=>{d.close();d.remove()})}
  function sync(state,isAdmin,options={}){
    admin=isAdmin;
    recoveryScope=admin&&state.canLaunchApplications?warehouseRecoveryScope(state,edition):null;
    const next=admin&&state.canLaunchApplications?JSON.stringify([state.account?.accountId,state.account?.clientId,state.activeDeviceId,state.dataContextId,state.dataIdentity?.profileId,state.dataIdentity?.generation]):null;
    if(next!==scope){const position=options.preserveSelection&&scope&&next?{warehouseId,overviewWarehouseId,tab,query,filter,offset}:null;reset();scope=next;if(position){({warehouseId,overviewWarehouseId,tab,query,filter,offset}=position);if(tab==='tasks'||tab==='search')panel=tab}}
  }
  async function refresh(){
    if(!scope||!admin||loading)return;clearTimeout(refreshTimer);clearLoading();const version=epoch;refreshing=contentReady;loading=true;refreshVisible=!refreshing;error='';errorCode='';
    if(refreshing)loadingTimer=setTimeout(()=>{if(version===epoch&&loading){refreshVisible=true;changed()}},450);
    else changed();
    try{
      const listing=await call('warehouses');if(version!==epoch)return;
      if(!Array.isArray(listing?.items))throw Error('TEAM_DATA_RESPONSE_INVALID');
      warehouses=listing.items;initialized=true;
      if(warehouseId&&!current()){warehouseId=null;documents=[];jobs=[];clearGraph();results=[]}
      if(!warehouses.some(w=>w.id===overviewWarehouseId)){overviewWarehouseId=(warehouses.find(w=>w.entity_count>0)||warehouses[0])?.id||null;clearGraph()}
      if(warehouseId){
        const input={warehouseId,offset};
        const result=await call(tab==='materials'?'documents':tab==='tasks'?'jobs':tab==='graph'?'graph':'retrieval',input);
        if(version!==epoch)return;
        if(tab==='materials'){
          documents=result.items||result.documents||[];total=result.total??documents.length;
          if(!team){
            try{
              const pages=await Promise.all([0,50].map(n=>call('material-workflows',{warehouseId,offset:offset+n,limit:50})));
              if(version!==epoch)return;
              if(pages.some(p=>!Array.isArray(p.items)))throw Error('TEAM_DATA_RESPONSE_INVALID');
              const states=new Map(pages.flatMap(p=>p.items).map(w=>[w.document_id,w]));
              documents=documents.map(d=>({...d,workflow:states.get(d.id)}));
            }catch(e){if(version!==epoch)return;if(invalidScope(e))throw e;}
          }
        }
        else if(tab==='tasks'){jobs=result.items||result.jobs||[];total=result.total??jobs.length}
        else if(tab==='graph'){graph=result;graphError=''}
        else retrieval=result;
        if(tab==='tasks'||tab==='search'){
          try{const result=await call('graph',{warehouseId});if(version!==epoch)return;graph=result;graphError=''}
          catch(e){if(version!==epoch)return;if(invalidScope(e))throw e;graphError=message(e)}
        }
      }else if(overviewWarehouseId){
        try{const result=await call('graph',{warehouseId:overviewWarehouseId});if(version!==epoch)return;graph=result;graphError=''}
        catch(e){if(version!==epoch)return;if(invalidScope(e))throw e;graphError=message(e);graph={nodes:[],edges:[]};graphCache=null}
      }
      contentReady=true;
      const shareWid=activeId();
      if(shareWid){
        try{const detail=await call('warehouse',{id:shareWid});if(version!==epoch)return;if(detail?.id!==shareWid)throw Error('TEAM_DATA_RESPONSE_INVALID');ontologyDetail=detail;ontologyError=''}
        catch(e){if(version!==epoch)return;if(invalidScope(e))throw e;ontologyDetail=null;ontologyError='知识结构读取失败，请刷新重试。'}
        try{const value=await call('authorization-summary',{warehouseId:shareWid});if(version!==epoch)return;if(!Number.isInteger(value?.active_count))throw Error('TEAM_DATA_RESPONSE_INVALID');sharePreview={...value,warehouseId:shareWid};shareError=''}
        catch(e){if(version!==epoch)return;if(invalidScope(e))throw e;if(sharePreview?.warehouseId!==shareWid)sharePreview=null;shareError=message(e)}
        try{const value=governance?.warehouseId===shareWid&&governance.supported===false?governance:await call('governance-summary',{warehouseId:shareWid});if(version!==epoch)return;if(value?.supported!==false&&(value?.supported!==true||!Number.isInteger(value.review_count)||!Number.isInteger(value.paused_count)))throw Error('SEMANTICA_UPGRADE_REQUIRED');governance={...value,warehouseId:shareWid};governanceError=value.supported===false?'当前服务尚未提供知识治理功能，待确认事项与问题反馈暂不可用。':''}
        catch(e){if(version!==epoch)return;if(invalidScope(e))throw e;if(governance?.warehouseId!==shareWid)governance=null;governanceError=message(e)}
      }else{sharePreview=null;shareError='';governance=null;governanceError=''}
    }catch(e){if(version===epoch)readFailure(e)}
    finally{if(version===epoch){clearLoading();loading=false;refreshVisible=false;changed();if(!error&&warehouses.some(w=>w.active_jobs>0))refreshTimer=setTimeout(()=>void refresh(),3000)}}
  }
  function btn(label,action,extra='',primary=false){return `<button class="button ${primary?'primary':''}" data-data-action="${action}" ${extra} ${busy?'disabled':''}>${label}</button>`}
  function warehouseStructure(){
    const w=current();if(!w)return '';
    const text=ontologyDetail?.id===w.id?ontologySummary(ontologyDetail.current_ontology):ontologyError||'正在读取知识结构…';
    return `<div class="data-lite-ontology" role="status"><p>${esc(text)}</p>${ontologyError?btn('刷新知识结构','refresh'):''}</div>`;
  }
  function createWarehouse(){
    const creationScope=recoveryScope,version=epoch;
    let pending=warehouseJournal.read(creationScope);
    function lockFields(dialog){
      for(const name of ['name','description']){const field=dialog.querySelector(`[name="${name}"]`);if(field){field.readOnly=Boolean(pending);if(pending)field.value=pending.input[name]}}
    }
    const d=dialog('新建'+owner+'数据仓',`<p>创建后使用通用知识结构，可直接上传资料。</p>${pending?'<p>有待确认的创建操作，请恢复原请求。</p>':''}<label>名称<input name="name" required maxlength="60" value="${esc(pending?.input?.name||'')}" placeholder="如：产品与客户资料"></label><p class="data-warehouse-name-error" role="alert"></p><label>说明<textarea name="description" maxlength="500" placeholder="这个数据仓存放哪些资料？">${esc(pending?.input?.description||'')}</textarea></label>`,async(f,dialog)=>{
      pending=warehouseJournal.read(creationScope);
      dialog.querySelector('.data-warehouse-name-error').textContent='';
      const fields=warehouseInput(f.get('name'),f.get('description'));
      if(pending&&(pending.input.name!==fields.name||pending.input.description!==fields.description))throw Error('WAREHOUSE_CREATION_PENDING');
      if(!pending){pending={input:{...fields,operationId:crypto.randomUUID()}};warehouseJournal.write(creationScope,pending)}
      lockFields(dialog);
      try{
        if(!pending.id){
          const value=await call('create-warehouse',pending.input);
          const id=value?.id||value?.warehouse?.id;
          if(!id)throw Error('TEAM_DATA_RESPONSE_INVALID');
          pending={...pending,id};warehouseJournal.write(creationScope,pending);
        }
      }catch(e){
        const failure=code(e);
        if(['WAREHOUSE_NAME_CONFLICT','SEMANTICA_INVALID_REQUEST'].includes(failure)){
          warehouseJournal.clear(creationScope);pending=null;
          lockFields(dialog);
          if(failure==='WAREHOUSE_NAME_CONFLICT'){dialog.querySelector('.data-warehouse-name-error').textContent=message(e);dialog.querySelector('[name="name"]')?.focus();throw e}
          throw Error('WAREHOUSE_CREATION_INVALID');
        }
        if(invalidScope(e))throw e;
        if(/CONFLICT/.test(failure))throw Error('WAREHOUSE_CREATION_CONFLICT');
        throw Error('WAREHOUSE_CREATION_UNCERTAIN');
      }
      if(version!==epoch)throw Error('TEAM_SESSION_CHANGED');
      const detail=await call('warehouse',{id:pending.id});
      if(version!==epoch)throw Error('TEAM_SESSION_CHANGED');
      if(detail?.id!==pending.id)throw Error('TEAM_DATA_RESPONSE_INVALID');
      const listing=await call('warehouses');
      if(version!==epoch)throw Error('TEAM_SESSION_CHANGED');
      if(!Array.isArray(listing?.items)||!listing.items.some(w=>w.id===pending.id))throw Error('TEAM_DATA_RESPONSE_INVALID');
      warehouses=listing.items;ontologyDetail=detail;ontologyError='';
      const id=pending.id;
      const selected=await action('select',{id,tab:'graph'});
      if(!selected||recoveryScope!==creationScope)return;
      warehouseJournal.clear(creationScope);dialog.close();
    });
    lockFields(d);
    if(pending)d.querySelector('[type=submit]').textContent='恢复创建结果';
  }
  function empty(title,body=''){return `<div class="data-empty"><span aria-hidden="true">◈</span><h3>${esc(title)}</h3><p>${esc(body)}</p></div>`}
  function authorizationFooter(){
    const w=current();if(!w)return '';
    const details=sharePreview?.warehouseId===w.id?sharePreview:null;
    return `<footer class="data-lite-footer"><span><i aria-hidden="true"></i>${details?`${details.active_count} 个有效授权${shareError?' · 上次读取，待更新':''}`:shareError?'授权摘要读取失败':'正在读取授权摘要…'}</span><span>账号、设备与数据仓跟随万象${shareError?btn('重试','refresh'):''}</span></footer>`;
  }
  function warehouseIcon(){return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></svg>'}
  function warehouseSwitcher(){
    const w=current(),name=w?.name||'选择或新建数据仓',visibility=team?'团队管理员共同维护':'仅当前账号可见';
    return `<button type="button" class="data-warehouse-switcher" data-data-action="warehouse-picker" aria-haspopup="dialog" aria-label="切换数据仓：${esc(w?.name||'尚未选择')}" title="${esc(name)} · ${visibility} · 点击切换数据仓"><span class="data-warehouse-switcher-icon">${warehouseIcon()}</span><span class="data-warehouse-switcher-label"><small>${owner}数据仓 · ${visibility}</small><strong>${esc(name)}</strong></span><svg class="data-warehouse-switcher-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></button>`;
  }
  function warehouseMetrics(){
    const w=current();
    return `<section class="data-lite-metrics" aria-label="整理概况">${[[w?.document_count??0,'份资料','materials'],[w?.entity_count??0,'个知识实体','graph'],[w?.relation_count??w?.fact_count??'—','条有据关系','graph'],[w?.active_jobs??0,'项正在整理','tasks']].map(([n,label,target])=>`<button data-data-action="tab" data-tab="${target}"><strong>${esc(n)}</strong><span>${label}</span></button>`).join('')}</section>${governance?.warehouseId===w?.id&&governance?.paused_count>0?`<div class="data-lite-paused" role="status">${governance.paused_count} 项整理正在等待核对。证据不足的部分保持暂停，不会自动补全结论。</div>`:''}`;
  }
  function warehousePicker(){
    const selected=activeId();
    const rows=()=>warehouses.filter(w=>(w.name+' '+(w.description||'')).toLocaleLowerCase().includes(filter.toLocaleLowerCase())).map(w=>`<div class="data-warehouse-choice-row"><button type="button" class="data-warehouse-choice ${w.id===selected?'active':''}" data-choose="${esc(w.id)}"><span class="data-lite-folder">${warehouseIcon()}</span><span><strong>${esc(w.name)}</strong><small>${w.document_count||0} 份资料 · ${w.entity_count||0} 个实体${w.active_jobs?' · '+w.active_jobs+' 项处理中':''}</small>${w.description?`<small>${esc(w.description)}</small>`:''}</span><span>${w.id===selected?'当前使用':'→'}</span></button><button type="button" class="button data-warehouse-rename" data-rename-warehouse="${esc(w.id)}" aria-label="重命名数据仓：${esc(w.name)}">重命名</button></div>`).join('')||'<p class="muted">未找到匹配的数据仓。</p>';
    const d=dialog('选择数据仓',`<input type="search" class="data-lite-warehouse-filter" value="${esc(filter)}" placeholder="按名称查找数据仓" aria-label="按名称查找数据仓"><div class="data-lite-warehouse-list">${rows()}</div><button type="button" class="button" data-new-warehouse>＋ 新建${owner}数据仓</button>`,async()=>{});
    d.querySelector('[type=submit]').hidden=true;
    d.querySelector('.data-lite-warehouse-filter').oninput=e=>{filter=e.target.value;d.querySelector('.data-lite-warehouse-list').innerHTML=rows()};
    d.addEventListener('click',e=>{const rename=e.target.closest('[data-rename-warehouse]');if(rename){d.close();void action('rename-warehouse',{id:rename.dataset.renameWarehouse});return}const b=e.target.closest('[data-choose]');if(b){d.close();void action('select',{id:b.dataset.choose,tab:'graph'})}else if(e.target.closest('[data-new-warehouse]')){d.close();void action('create')}});
  }
  function renameWarehouse(id){
    const w=warehouses.find(w=>w.id===id);if(!w)return;
    const renameScope=recoveryScope,version=epoch;
    let pending=renameJournal.read(renameScope,id);
    function lockFields(d){const field=d.querySelector('[name="name"]');field.readOnly=Boolean(pending);if(pending)field.value=pending.input.name;d.querySelector('[type=submit]').textContent=pending?'重试保存':'保存名称'}
    const d=dialog('重命名数据仓',`<p>修改「${esc(w.name)}」的名称，资料和知识仍保留在这个数据仓。</p>${pending?'<p>上次保存结果尚未确认，请重试原名称。</p>':''}<label>名称<input name="name" required maxlength="120" value="${esc(pending?.input.name||w.name)}" aria-describedby="data-rename-name-help"></label><small id="data-rename-name-help">最多 60 个字符</small><p class="data-warehouse-name-error" role="alert"></p>`,async(f,d)=>{
      pending=renameJournal.read(renameScope,id);
      const name=warehouseInput(f.get('name'),'').name;
      d.querySelector('.data-warehouse-name-error').textContent='';
      if(pending&&pending.input.name!==name)throw Error('WAREHOUSE_RENAME_PENDING');
      if(!pending&&name===w.name)return;
      if(!pending){pending={input:{warehouseId:id,name,operationId:crypto.randomUUID()},saved:false};renameJournal.write(renameScope,id,pending)}
      lockFields(d);
      try{
        if(!pending.saved){
          const value=await call('rename-warehouse',pending.input);
          if(version!==epoch||renameScope!==recoveryScope)throw Error('TEAM_SESSION_CHANGED');
          if(value?.id!==id||value.name!==pending.input.name)throw Error('TEAM_DATA_RESPONSE_INVALID');
          pending={...pending,saved:true};renameJournal.write(renameScope,id,pending);
        }
      }catch(e){
        if(version!==epoch||renameScope!==recoveryScope)throw Error('TEAM_SESSION_CHANGED');
        if(['WAREHOUSE_NAME_CONFLICT','WAREHOUSE_INVALID_NAME','WAREHOUSE_BUSY','SEMANTICA_UPGRADE_REQUIRED'].includes(code(e))){
          renameJournal.clear(renameScope,id);pending=null;lockFields(d);
          d.querySelector('.data-warehouse-name-error').textContent=message(e);d.querySelector('[name="name"]')?.focus();throw e;
        }
        if(invalidScope(e))throw e;
        if(code(e)==='OPERATION_CONFLICT')throw Error('WAREHOUSE_RENAME_CONFLICT');
        throw Error('WAREHOUSE_RENAME_UNCERTAIN');
      }
      const detail=await call('warehouse',{id});
      if(version!==epoch||renameScope!==recoveryScope)throw Error('TEAM_SESSION_CHANGED');
      if(detail?.id!==id||typeof detail.name!=='string')throw Error('TEAM_DATA_RESPONSE_INVALID');
      warehouses=warehouses.map(item=>item.id===id?{...item,name:detail.name}:item);
      if(ontologyDetail?.id===id)ontologyDetail={...ontologyDetail,name:detail.name};
      renameJournal.clear(renameScope,id);filter='';changed();
    });
    lockFields(d);d.querySelector('[name="name"]')?.focus();
  }
  function materialPage(){
    return materialBrowser.render({documents,total,offset,pagination:pagination(),isLoading:loading});
  }
  function pagination(){return total>100?`<div class="data-pagination">${btn('上一页','previous',offset?'':'disabled')}<span>${offset+1}–${Math.min(offset+100,total)} / ${total}</span>${btn('下一页','next',offset+100<total?'':'disabled')}</div>`:''}
  function graphPage(hero=false){
    const w=graphWarehouse(),labels=ontologyDetail&&ontologyDetail.id===w?.id?ontologyDetail.ontology_labels:null;
    const typeInfo=Object.assign(Object.create(null),defaultTypeInfo);
    for(const n of graph.nodes||[]){
      const type=typeof n.entity_type==='string'&&n.entity_type?n.entity_type:'UNKNOWN';
      const base=typeInfo[type]||[type,'',customTypeColor(type)];
      typeInfo[type]=[Object.hasOwn(labels?.entities||{},type)?labels.entities[type]:base[0],base[1],base[2]];
    }
    const relationNames=Object.assign(Object.create(null),defaultRelationNames,labels?.relations||{});
    const rawKey=JSON.stringify([graph,labels,showIsolated]);
    if(graphCache?.rawKey!==rawKey){
      const raw={nodes:(graph.nodes||[]).map(n=>({...n,id:String(n.entity_id||n.id),name:String(n.canonical_name||n.name||'未命名实体'),type:typeof n.entity_type==='string'&&n.entity_type?n.entity_type:'UNKNOWN'})),edges:(graph.edges||[]).map((e,i)=>({...e,id:String(e.fact_id||e.id||i),s:String(e.subject_entity_id),t:String(e.object_entity_id),label:relationNames[e.relation_type]||e.relation_type||'关联',evidence:e.evidence||[]}))};
      const visible=graphVisibility(raw,showIsolated);
      graphCache={rawKey,raw:visible,...describeConstellations(visible)};
    }
    const {raw,constellations,membership,counts,maxima}=graphCache;
    const activeGroup=constellations.find(group=>group.id===constellation);
    const key=JSON.stringify([graphQuery,graphType,node,activeGroup?.id]);
    if(graphCache.key!==key){
      const overview=!activeGroup&&!node&&!graphQuery&&graphType==='all';
      const visible=selectGraph(raw,{query:graphQuery,type:graphType,focus:node,members:node?null:activeGroup?.members});
      graphCache.key=key;
      graphCache.value=layoutConstellations(visible,overview?constellations:[]);
    }
    const g=graphCache.value,ids=new Map(g.nodes.map(n=>[n.id,n])),selected=raw.nodes.find(n=>n.id===node),selectedEdge=raw.edges.find(e=>e.id===edge),related=selectedEdge?[selectedEdge]:raw.edges.filter(e=>e.s===node||e.t===node),groups=new Map();
    const starCounts=id=>`${counts.get(id)?.relations||0} 条有据关系 · ${counts.get(id)?.sources||0} 份独立来源`;
    const sizeBy={counts,max:maxima[starMetric],metric:starMetric};
    for(const e of g.edges){const key=JSON.stringify([e.s,e.t].sort());if(!groups.has(key))groups.set(key,[]);groups.get(key).push(e.id)}
    const bounds=g.nodes.length?{left:Math.min(...g.nodes.map(n=>n.x-Math.max(n.r+18,n.labelWidth/2+18))),right:Math.max(...g.nodes.map(n=>n.x+Math.max(n.r+18,n.labelWidth/2+18))),top:Math.min(...g.nodes.map(n=>n.y-n.r-26)),bottom:Math.max(...g.nodes.map(n=>n.y+n.r+28+n.lines.length*15))}:{left:0,right:800,top:0,bottom:540};
    const scale=Math.max((bounds.right-bounds.left)/740,(bounds.bottom-bounds.top)/450,0.6)/zoom,vw=800*scale,vh=540*scale,cx=(bounds.left+bounds.right)/2,cy=(bounds.top+bounds.bottom)/2;
    const facts=related.map(e=>`<article>${e.paused?'<span class="data-status">待核对 · 已暂停对外使用</span>':''}<b>${esc(raw.nodes.find(n=>n.id===e.s)?.name)} → ${esc(e.label)} → ${esc(raw.nodes.find(n=>n.id===e.t)?.name)}</b>${e.evidence.map(v=>`<p>${esc(v.excerpt)}</p><button class="text-button" data-data-action="source" data-id="${esc(v.document_id)}" data-warehouse-id="${esc(w?.id)}" data-version-id="${esc(v.document_version_id||v.version_id||'')}">查看来源 · ${esc(loc(v.locator_json||v.locator))}</button>`).join('')||'<p>当前关系暂无可展示的原文片段。</p>'}</article>`).join('');
    const picker=btn('查找证据','tab','data-tab="search"');
    const emptyText=graphError||(!initialized&&loading?'正在读取'+owner+'知识图谱…':!w?'建立第一座'+owner+'数据仓，让资料开始相连。':!showIsolated&&raw.isolatedCount>0&&!raw.nodes.length?'当前图谱中暂无有关系的实体，可开启“显示孤立实体”查看。':raw.nodes.length?'没有找到匹配的实体，请调整搜索或返回全图。':w.document_count>0?`已导入 ${w.document_count} 份材料，知识图谱尚未生成。请查看知识抽取与图谱写入的处理结果。`:'这个仓的知识图谱，从第一份资料开始。导入后，处理模型会提取实体与关系。');
    graphMotion.schedule(g,JSON.stringify([scope,activeId()]),sizeBy);
    return `<section class="data-core-graph ${hero?'is-hero':''}" aria-label="核心知识图谱">
      <header class="data-core-heading"><div><h3>知识图谱</h3><p>${esc(w?.name||owner+'知识从这里开始')}</p></div><div class="data-core-actions">${picker}</div></header>
      <div class="data-core-toolbar">
        <form data-data-form="graph-search" data-data-context="${esc(JSON.stringify([scope,activeId()]))}"><input data-studio-edit-key="team-data-graph-query" name="graphQuery" value="${esc(graphQuery)}" placeholder="查找实体，探索知识关联" aria-label="查找图谱实体"><button class="button">查找</button></form>
        <div class="data-graph-filters" aria-label="图谱实体类型">${Object.entries(typeInfo).filter(([t])=>raw.nodes.some(n=>n.type===t)).map(([t,info])=>`<button data-data-action="graph-type" data-type="${esc(t)}" aria-pressed="${graphType===t}" class="${graphType===t?'active':''}">${info[2]?`<i style="background:${info[2]}"></i>`:''}${esc(info[0])}</button>`).join('')}</div>
        ${node||activeGroup||graphQuery||graphType!=='all'?btn('返回全图','graph-reset'):''}
        <div class="data-graph-display">${(graph.nodes||[]).length?`<button type="button" class="data-isolated-switch" data-data-action="graph-isolated" role="switch" aria-checked="${showIsolated}" ${busy?'disabled':''}><span>显示孤立实体</span><span class="data-isolated-switch-track" aria-hidden="true"></span></button>`:''}</div>
        ${raw.nodes.length?`<div class="data-space-metrics" role="group" aria-label="星点大小"><span>星点大小</span>${[['relations','有据关系'],['sources','独立来源']].map(([metric,label])=>btn(label,'graph-metric',`data-metric="${metric}" aria-pressed="${starMetric===metric}"`)).join('')}</div>`:''}
      </div>
      <div class="data-core-body">
        <div class="data-core-canvas">
          <svg class="data-graph data-space-graph ${selected?'is-entity-focus':''}" viewBox="${cx-vw/2} ${cy-vh/2} ${vw} ${vh}" role="group" aria-label="${esc(w?.name||owner+'数据仓')}知识图谱，立体视图">
            <defs>
              <marker id="team-graph-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M1 1 L5 3.5 L1 6" fill="none" stroke="#aa987e" stroke-width=".8"/></marker>
              ${Object.entries(typeInfo).map(([type,info])=>`<radialGradient id="data-star-glow-${esc(encodeURIComponent(type))}" class="data-star-glow" style="--type-color:${info[2]}"><stop offset="0%" stop-opacity=".32"/><stop offset="45%" stop-opacity=".16"/><stop offset="100%" stop-opacity="0"/></radialGradient>`).join('')}
            </defs>
            <g class="data-space-floor" aria-hidden="true"></g>
            <g class="data-space-links">${g.edges.map(e=>{
              const a=ids.get(e.s),b=ids.get(e.t);
              const group=groups.get(JSON.stringify([e.s,e.t].sort()));
              const path=edgeGeometry(a,b,group.indexOf(e.id),group.length),chosen=e.id===edge;
              return `<g class="data-graph-link ${chosen?'chosen':''} ${e.paused?'is-paused':''} ${g.anchors&&membership.get(e.s)!==membership.get(e.t)?'is-constellation-bridge':''}">
                <title>${esc(a.name)} → ${esc(e.label)} → ${esc(b.name)}</title>
                <path class="data-edge-hit" d="${path.d}" data-data-action="edge" data-id="${esc(e.id)}" role="button" tabindex="0" aria-label="查看关系 ${esc(a.name+' '+e.label+' '+b.name)}"/>
                <path class="data-edge" d="${path.d}" marker-end="url(#team-graph-arrow)"/>
                ${chosen||selected||(!g.anchors&&g.edges.length<=8)?`<text class="data-edge-label" transform="translate(${path.x} ${path.y})" text-anchor="middle" y="-7">${esc(e.label)}</text>`:''}
              </g>`;
            }).join('')}</g>
            <g class="data-space-nodes">${g.nodes.map(n=>`<g class="data-core-node ${n.id===node?'selected':''} ${n.paused?'is-paused':''}" style="--type-color:${typeInfo[n.type][2]}" transform="translate(${n.x} ${n.y})" role="button" tabindex="0" data-data-action="node" data-id="${esc(n.id)}" aria-label="查看实体 ${esc(n.name)}">
              <title>${esc(n.name)} · ${esc(typeInfo[n.type][0])} · ${starCounts(n.id)}${n.paused?' · 待核对，已暂停对外使用':''}</title>
              <circle class="node-star-hit" r="12"/>
              <circle class="node-star-glow" r="15" style="fill:url(#data-star-glow-${esc(encodeURIComponent(n.type))})"/>
              <circle class="node-star" r="7"/>
              <text class="node-name" y="${n.r+14}">${n.lines.map((line,i)=>`<tspan x="0" dy="${i?15:0}">${esc(line)}</tspan>`).join('')}</text>
            </g>`).join('')}</g>
            <g class="data-space-constellations">${(g.anchors||[]).map(group=>{
              const label=labelLines(group.name)[0];
              const short=label===group.name?label:label+'…';
              const width=short.length*12+20;
              return `<g class="data-space-constellation" data-data-action="graph-constellation" data-id="${esc(group.id)}" role="button" tabindex="0" aria-label="查看${esc(group.name)}，${group.members.size} 个实体" transform="translate(${group.x} ${group.y})"><title>${esc(group.name)} · ${group.members.size} 个实体</title><rect x="${-width/2}" y="-12" width="${width}" height="24" rx="8"/><text text-anchor="middle" dy=".34em">${esc(short)}</text></g>`;
            }).join('')}</g>
          </svg>
          ${g.nodes.length?`<span class="data-space-caption"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.7l5.4 3.1v6.4L8 14.3l-5.4-3.1V4.8L8 1.7Zm0 6.2v6.4m0-6.4 5.4-3.1M8 7.9 2.6 4.8"/></svg>立体视图</span>`:''}
          ${!g.nodes.length?`<div class="data-core-empty" ${graphError?'role="alert"':''}><span aria-hidden="true">◈</span><p>${esc(emptyText)}</p>${graphError?btn('重新读取','refresh'):w&&!(graph.nodes||[]).length&&(!loading||contentReady)?btn(w.document_count>0?'查看处理任务':'导入资料',w.document_count>0?'tab':'import',w.document_count>0?'data-tab="tasks"':''):''}</div>`:''}
          <div class="data-core-tools">
            ${g.nodes.length?`<div class="data-space-rotate" aria-label="旋转知识图谱">${btn('↶','graph-rotate','data-direction="left" aria-label="向左旋转知识图谱" title="向左旋转"')}${btn('↷','graph-rotate','data-direction="right" aria-label="向右旋转知识图谱" title="向右旋转"')}</div>`:''}
            ${btn('−','graph-zoom','data-direction="out" aria-label="缩小知识图谱"')}<output>${Math.round(zoom*100)}%</output>${btn('＋','graph-zoom','data-direction="in" aria-label="放大知识图谱"')}${btn('适应画布','graph-fit')}
          </div>
          ${g.nodes.length?'<p class="data-core-hint">拖动空白处旋转 · 滚轮缩放 · 点击查看证据</p>':''}
        </div>
        <aside class="data-graph-evidence">
          <p class="data-detail-eyebrow">${selectedEdge?'关系证据':selected?esc(typeInfo[selected.type][0]):'探索知识'}</p>
          <h3>${esc(selectedEdge?'查看关系来源':selected?.name||activeGroup?.name||(g.anchors?'探索知识星座':'从一个实体开始'))}</h3>
          ${selected&&!selectedEdge?`<p class="data-star-counts">${starCounts(selected.id)}</p>`:''}
          ${(selectedEdge||selected)?.paused?'<p class="data-lite-paused-note">待核对 · 已暂停此知识及其依赖关系对外使用。原始资料和证据保留。</p>':''}
          ${selected||selectedEdge?(facts||'<p>当前实体暂无可展示的关系证据。</p>')+((selectedEdge||selected)?.governance_review_id?btn('查看待核对事项','review-detail',`data-id="${esc((selectedEdge||selected).governance_review_id)}"`):btn('这条知识有问题','flag',`data-kind="${selectedEdge?'relation':'entity'}" data-id="${esc(selectedEdge?.id||selected?.id)}"`)):`
            <p>${g.anchors?'点击分组展开，或放大查看更多实体名称。':`点击图中实体，探索它与${owner}知识的联系。`}</p>
            <div class="data-graph-starts">${g.anchors?g.anchors.map(group=>`<button data-data-action="graph-constellation" data-id="${esc(group.id)}"><span>${esc(group.name)}<small>${group.members.size} 个实体</small></span><span>→</span></button>`).join(''):g.nodes.filter(n=>n.degree>0).slice(0,4).map(n=>`<button data-data-action="node" data-id="${esc(n.id)}"><span>${esc(n.name)}<small>${esc(typeInfo[n.type][0])} · ${n.degree} 条关联</small></span><span>→</span></button>`).join('')}</div>
            <p class="data-core-detail-note">有疑问的知识可以反馈核对。</p>`}
        </aside>
      </div>
      <footer class="data-core-footer">${!showIsolated&&raw.isolatedCount?`<span>当前图谱已隐藏 ${raw.isolatedCount} 个孤立实体</span>`:''}<span><b>${g.nodes.length}</b> 个实体 <b>${g.edges.length}</b> 条关系 <b>${new Set(g.edges.flatMap(e=>e.evidence.map(v=>v.document_id)).filter(Boolean)).size}</b> 份引用材料</span><span>${node?'实体直接关联':'当前数据仓 · 最多 120 个实体'}</span></footer>
    </section>`;
  }
  function searchPage(){return `<form class="data-search" data-data-form="search" data-data-context="${esc(JSON.stringify([scope,activeId()]))}"><input data-studio-edit-key="team-data-search" name="query" value="${esc(query)}" placeholder="针对当前数据仓，输入你想查找的问题" aria-label="证据检索问题" required maxlength="2000"><button class="button primary" ${searching?'disabled':''}>${searching?'检索中…':'检索证据'}</button></form><p class="muted">结果遵循数据仓保护规则，保留引用片段与来源定位。</p>${!team&&annotationSearch?.incomplete?'<p role="status">部分空间标签索引尚未核验，结果可能不完整。请重试检索。</p>':''}${results.map(r=>`<article class="data-search-result"><div><strong>${esc(r.document_name||r.original_name||r.document_id)}</strong><small>${esc(loc(r.locator))}</small></div>${!team&&r.spaceFolderPath?`<p class="muted">空间目录 · ${esc(r.spaceFolderPath)}</p>`:''}${!team&&r.spaceSourceStatus?`<p class="muted">${r.spaceSourceStatus==='updated'?'空间原文件已更新 · 此处引用先前导入的正文':'与空间原文件一致'}</p>`:''}${!team&&r.annotationMatch?`<p class="muted">空间标签命中 · 文档引用：${esc((r.annotation?.tags||[]).join('、'))}</p>`:''}<p>${esc(r.text||r.excerpt)}</p><button class="text-button" data-data-action="source" data-id="${esc(r.document_id)}" data-version-id="${esc(r.document_version_id||r.version_id||'')}" data-location="${esc(loc(r.locator))}" data-start="${Number.isSafeInteger(r.locator?.source_segments?.[0]?.canonical_start)?r.locator.source_segments[0].canonical_start:0}">查看原文来源 →</button></article>`).join('')}${!results.length&&!searching&&(!loading||contentReady)?empty(query?'未找到可交付的证据':'带着具体问题查找'+owner+'知识','如材料尚未完成索引或保护检测，请在星图中查看处理状态。'):''}`}
  const failedPublications=()=>jobs.filter(j=>j.kind==='knowledge_publish'&&j.status==='failed');
  function failedExtractions(){
    const latest=new Map();
    for(const job of jobs){if(job.kind!=='knowledge_extract'||!job.document_id)continue;const old=latest.get(job.document_id);if(!old||String(job.created_at||'')>String(old.created_at||''))latest.set(job.document_id,job)}
    return [...latest.values()].filter(j=>j.status==='failed'&&j.error_code!=='STALE_EXTRACTION_GENERATION');
  }
  function taskPage(){return `${failedExtractions().length?`<div class="data-section-heading"><p>${failedExtractions().length} 份材料的最新知识抽取未完成。原任务重试保留旧模型；也可确认后使用当前数据仓模型重新处理。</p>${btn('用当前模型补处理（'+failedExtractions().length+'）','reprocess-failed')}</div>`:''}${failedPublications().length?`<div class="data-section-heading"><p>${failedPublications().length} 份材料已完成抽取，但图谱写入失败；恢复图数据库后可重试，无需再次调用抽取模型。</p>${btn('重试图谱写入（'+failedPublications().length+'）','retry-publications')}</div>`:''}${jobs.map(j=>`<article class="data-task"><div><strong>${esc(j.document_name||j.document_id||'数据仓处理任务')}</strong><p>${esc(jobNames[j.kind]||j.kind)} · ${esc(stageNames[j.stage]||j.stage)}${j.total_units?' · '+j.completed_units+'/'+j.total_units:''}</p>${j.error_message?`<p class="data-error-text">${esc(j.error_message)}</p>`:''}${j.kind==='ontology_suggest'&&(j.status==='failed'||j.status==='cancelled')?'<p>本体建议不能在任务列表直接重试，请返回原建议入口重新生成；自动导入触发的任务请联系管理员重新发起。</p>':''}</div><div>${badge(j.status)}${j.kind!=='ontology_suggest'&&(j.status==='failed'||j.status==='cancelled')&&!['STALE_EXTRACTION_GENERATION','SUPERSEDED','INDEX_CHANGED'].includes(j.error_code)?btn('重试','retry',`data-id="${esc(j.id)}"`):''}</div></article>`).join('')}${!jobs.length&&(!loading||contentReady)?empty('暂无处理任务','导入材料后，任务进度会显示在这里。'):''}${pagination()}`}
  function syncStatus(){
    const failure=error||shareError;
    const state=searching?'searching':loading&&refreshVisible?(refreshing?'refreshing':'loading'):failure?'error':contentReady?'ready':'idle';
    const label={searching:'正在检索',loading:'正在加载',refreshing:'正在更新',ready:'已同步',error:'更新失败',idle:'准备读取'}[state];
    const description=state==='loading'?'正在读取当前'+owner+'的数据…':state==='error'?failure:label;
    return `<div class="data-sync-status" data-state="${state}" role="status" aria-live="${state==='loading'||state==='searching'||state==='error'?'polite':'off'}" aria-label="${esc(description)}" title="${esc(description)}"><span class="data-sync-dot" aria-hidden="true"></span><span>${label}</span>${state==='error'&&contentReady?'<button type="button" class="data-sync-retry" data-data-action="refresh" aria-label="重新读取当前数据">重试</button>':''}</div>`;
  }
  const moreMenu=()=>document.querySelector?.('details[data-starlink-more]');
  function closeMoreMenu(){const menu=moreMenu();if(menu)menu.open=false}
  function keepMoreMenu(){
    const menu=moreMenu();if(!menu)return '';
    // Carry the native disclosure and its focus across background redraws.
    const focused=document.activeElement;
    if(menu.contains(focused))queueMicrotask(()=>{
      const replacement=moreMenu();
      if(!replacement||replacement===menu||document.activeElement!==document.body)return;
      const control=[...replacement.querySelectorAll('[data-data-action]')].find(el=>el.dataset.dataAction===focused.dataset.dataAction&&!el.disabled);
      (control||replacement.querySelector('summary'))?.focus({preventScroll:true});
    });
    return menu.open?' open':'';
  }
  function pageBar(target={},available=true){return `<header class="data-page-bar${team?'':' wanx-section-banner'}" ${team?'':'data-section="starlink"'}><div class="data-page-title"><span class="data-page-mark" aria-hidden="true"><svg viewBox="0 0 32 32"><path d="M8 9L23 7 24 23 8 24 8 9 24 23M8 24L23 7"/><circle cx="8" cy="9" r="3"/><circle cx="23" cy="7" r="3"/><circle cx="24" cy="23" r="3"/><circle cx="8" cy="24" r="3"/></svg></span><div><h2>万象星图 <small class="data-edition-label">精简版</small> <span class="${team?'':'wanx-section-english'}">STARLINK</span></h2><p>把资料交给 AI，让知识自动相连。</p></div></div><div class="data-page-actions">${available?syncStatus()+btn('＋ 导入资料','import',current()?'':'disabled',true)+`<details class="wanx-action-menu" data-wanx-actions data-starlink-more${keepMoreMenu()}><summary class="button" data-data-action="toggle-more" aria-label="星图更多操作">更多 <span aria-hidden="true">⋯</span></summary><div class="wanx-menu-panel" role="group" aria-label="星图操作">${btn('打开完整版','open',`data-view="${target.warehouseId?target.view:'warehouses'}" ${target.warehouseId?`data-warehouse-id="${esc(target.warehouseId)}"`:''} ${busy?'disabled':''}`)}${btn('刷新','refresh',loading?'disabled':'')}${target.warehouseId?btn('重命名数据仓','rename-warehouse'):''}${team&&target.warehouseId?btn('助理授权','assistant-access',`data-warehouse-id="${esc(target.warehouseId)}"`):''}</div></details>`:''}</div></header>`}
  function sourcePanel(){
    if(panelLoading)return '<p role="status">正在读取来源…</p>';
    if(!sourceValue)return '<p>来源读取未完成，请重试。</p>';
    const v=sourceValue;
    return `<p class="data-detail-eyebrow">${v.pinned?'固定版本原文':'当前正文 · 未定位历史版本'}</p><h3>${esc(v.document?.original_name||'资料来源')}</h3><small>版本 ${esc(v.version?.id||v.document?.active_version_id||'待解析')}</small>${!team&&v.sourceAnnotation?.folderPath?`<p class="muted">空间目录 · ${esc(v.sourceAnnotation.folderPath)}</p>`:''}${sourceAnnotations(v.sourceAnnotation)}${v.sourceLocation&&v.sourceLocation!=='原文片段'?`<p class="muted">引用位置 · ${esc(v.sourceLocation)}</p>`:''}${v.pinned&&Number.isInteger(v.total_chars)?`<p class="muted">正文范围 ${v.start||0}–${v.end||0} / ${v.total_chars} 字</p>`:''}${v.excerpt?`<blockquote>${esc(v.excerpt)}</blockquote>`:''}<div class="data-source">${(v.segments||[]).map(s=>`<article><small>${esc(loc(s.source_locator||s.locator))}</small><p>${esc(s.text||s.content)}</p></article>`).join('')||'<p>正文尚未就绪，或此版本不支持读取。可在完整版查看原件和处理状态。</p>'}</div>${v.pinned&&v.end<v.total_chars?btn('继续读取正文','source',`data-id="${esc(v.sourceId)}" data-warehouse-id="${esc(v.warehouseId)}" data-version-id="${esc(v.version.id)}" data-start="${v.end}" data-location="${esc(v.sourceLocation||'')}"`):''}`;
  }
  function sourceAnnotations(value){
    if(team||!value)return '';
    const labels={manual:'人工',automatic:'自动规则',inherited:'文件夹继承'};
    const describe=(annotation,title)=>annotation?`<h4>${title}</h4><p>${esc((annotation.tags||[]).join('、')||'无标签')}</p>${annotation.description?`<p>${esc(annotation.description)}</p>`:''}<ul>${(annotation.provenance||[]).map(p=>`<li>${esc(p.tag)} · ${esc(labels[p.source]||p.source)} · 来源 ${esc(p.itemId)}</li>`).join('')}</ul>`:`<p>${title}暂不可读取。</p>`;
    return `<details class="data-source-annotation"><summary>空间标签与说明${value.needsRefresh?' · 需核对':''}</summary>${value.indexStatus==='pending'?'<p role="status">资料已导入，空间标签索引待完成；正文就绪后再次检索或打开材料可自动补齐。</p>':value.needsRefresh?`<p role="status">${value.current&&!value.current.needsReview?'空间标注已更新，标签检索使用当前标注。导入快照保留供核对。':'空间原文件或标注已变化，请在空间复核；正文变化需重新导入。'}</p>`:''}${describe(value.snapshot,'导入时快照')}${describe(value.current,'当前空间标注')}</details>`;
  }
  function pendingAnnotations(){
    const count=[...pendingAnnotationImports.values()].filter(item=>item.warehouseId===activeId()).length;
    return !team&&count?`<p role="status">${count} 份资料已导入，空间标签索引待完成。${btn('重试标签索引','retry-annotation-imports')}</p>`:'';
  }
  function reviewPage(){
    if(governance?.warehouseId===activeId()&&governance.supported===false)return `<h3>知识治理暂不可用</h3><p role="status">${esc(governanceError)}</p><p>仍可查看资料和图谱。服务升级后，请重新打开资料页。</p>`;
    if(panelLoading)return '<p role="status">正在读取待确认事项…</p>';
    if(review){
      return `${btn('← 全部待确认','reviews')}<p class="data-detail-eyebrow">${esc(review.kind)}</p><h3>${esc(review.title)}</h3><p>${esc(review.description)}</p><div class="data-review-evidence">${(review.evidence||[]).map(v=>`<blockquote>${esc(v.excerpt)}</blockquote><button class="text-button" data-data-action="source" data-id="${esc(v.document_id)}" data-version-id="${esc(v.document_version_id||'')}">查看证据来源 · ${esc(loc(v.locator))}</button>`).join('')||'<p>当前事项没有可核对的证据，不能据此补全结论。</p>'}</div>${proposal?`<section class="data-lite-proposal"><h4>${proposal.status==='ready'?'建议修改 · 尚未应用':'依据不足 · 继续待核对'}</h4><p>${esc(proposal.description||'请对照来源核对建议，确认后才会应用。')}</p>${proposal.model?`<small>建议模型：${esc(typeof proposal.model==='string'?proposal.model:proposal.model.name||proposal.model.model||proposal.model.label||'已配置模型')}</small>`:''}<p>修改前</p><pre>${esc(JSON.stringify(proposal.before,null,2))}</pre><p>修改后</p><pre>${esc(JSON.stringify(proposal.after,null,2))}</pre>${(proposal.evidence||[]).map(v=>`<blockquote>${esc(v.excerpt)}</blockquote><button class="text-button" data-data-action="source" data-id="${esc(v.document_id)}" data-version-id="${esc(v.document_version_id||'')}">核对建议依据 · ${esc(loc(v.locator))}</button>`).join('')}${proposal.status==='ready'?btn('确认应用这项修改','review-apply','',true):'<p>证据尚不足以支持修改，未提供应用操作。可以补充资料或保留待核对。</p>'}${btn('保留原结果','review-discard')}</section>`:`<div class="data-lite-review-actions">${(review.actions||[]).map(a=>btn(esc(a.label),'review-resolve',`data-action-id="${esc(a.id)}"`)).join('')}${btn('让 AI 建议如何修改','review-propose')}</div>`}`;
    }
    if(pendingGovernance)return '<h3>操作等待确认</h3><p>尚未收到服务端成功回执，待确认列表未作变更。</p>';
    return `<h3>有疑问，再请你确认</h3><p>身份不明确、证据不足或用户反馈的问题，保留待核对；不会自动补出结论。</p>${governanceError?`<p role="alert">${esc(governanceError)}</p>${btn('重试','reviews')}`:reviews.map(v=>`<button class="data-lite-review-row" data-data-action="review-detail" data-id="${esc(v.id)}"><strong>${esc(v.title)}</strong><span>${esc(v.description||v.kind)}</span><small>查看证据与可执行操作 →</small></button>`).join('')||'<div class="data-empty"><h3>没有待确认事项</h3><p>当前服务端尚无待确认问题记录。</p></div>'}${reviewTotal>50?`<div class="data-pagination">${btn('上一页','reviews-page',`data-offset="${Math.max(0,reviewsOffset-50)}" ${reviewsOffset===0?'disabled':''}`)}<span>${reviewsOffset+1}–${Math.min(reviewsOffset+reviews.length,reviewTotal)} / ${reviewTotal}</span>${btn('下一页','reviews-page',`data-offset="${reviewsOffset+50}" ${reviewsOffset+50>=reviewTotal?'disabled':''}`)}</div>`:''}`;
  }
  function inspector(){
    if(!panel)return '';
    const title={source:'知识与来源',tasks:'整理进度',search:'查找证据',reviews:'待确认'}[panel]||'知识详情';
    return `<aside class="data-lite-inspector" aria-label="${title}"><header><strong>${title}</strong>${btn('×','close-panel','aria-label="关闭详情"')}</header><div class="data-lite-inspector-body">${error?`<p class="data-error-text" role="alert">${esc(error)}</p>`:''}${panel==='source'?sourcePanel():panel==='tasks'?taskPage():panel==='search'?searchPage():reviewPage()}${pendingGovernance?`<div class="data-error" role="alert">操作结果尚未确认。重试将使用同一操作标识，避免重复执行。${btn('查询或重试原操作','governance-retry')}</div>`:''}</div></aside>`;
  }
  function render(){
    if(!admin)return team?empty('仅管理员可管理团队数据'):`<section class="team-data-page data-lite-page">${pageBar({},false)}${empty('请先登录万象')}</section>`;
    if(!scope)return `<section class="team-data-page data-lite-page">${pageBar({},false)}${empty('请先连接万象盒子','连接后读取当前'+owner+'的数据仓。')}</section>`;
    const w=current(),target={warehouseId:w?.id,view:tab==='materials'?'materials':'graph'},mainTab=tab==='materials'?'materials':'graph';
    return `<section class="team-data-page data-lite-page ${panel?'has-inspector':''}" aria-busy="${loading||searching}">${pageBar(target)}${error&&(!contentReady||team&&/TEAM_STARLINK_(NOT_INSTALLED|UPGRADE_REQUIRED)/.test(errorCode))?`<div class="data-error" role="alert">${esc(error)} ${team&&/TEAM_STARLINK_(NOT_INSTALLED|UPGRADE_REQUIRED)/.test(errorCode)?btn('安装／更新星图','install-starlink'):btn('重试','refresh')}</div>`:''}${warehouseMetrics()}${warehouseStructure()}<div class="data-lite-toolbar"><div class="data-lite-context">${warehouseSwitcher()}<nav class="data-tabs" aria-label="知识视图">${tabs.map(([id,label])=>`<button class="${mainTab===id?'active':''}" data-data-action="tab" data-tab="${id}" ${mainTab===id?'aria-current="page"':''}>${label}</button>`).join('')}</nav></div><div>${btn('查找知识与证据','tab','data-tab="search"')}</div></div><div class="data-lite-workspace">${mainTab==='materials'?materialPage():graphPage()}${inspector()}</div>${!w&&!loading?`<div class="data-lite-create">${btn('＋ 新建'+owner+'数据仓','create','',true)}<p>${team?'团队管理员共同维护':'仅当前账号可见'} · 导入资料后，知识自动相连。</p></div>`:''}${pendingAnnotations()}${authorizationFooter()}</section>`;
  }
  function dialog(title,body,onSubmit){
    const version=epoch,d=document.createElement('dialog');let submitting=false;d.dataset.teamDataDialog='';d.className='data-dialog';d.innerHTML=`<form><div class="data-dialog-heading"><h3>${esc(title)}</h3><button type="button" data-close aria-label="关闭">×</button></div>${body}<p class="data-dialog-error" role="alert"></p><div class="data-dialog-actions"><button type="button" class="button" data-close>取消</button><button type="submit" class="button primary">确认</button></div></form>`;document.body.append(d);d.showModal();
    d.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>{if(!submitting)d.close()});d.addEventListener?.('cancel',e=>{if(submitting)e.preventDefault()});d.onclose=()=>d.remove();
    d.querySelector('form').onsubmit=async e=>{e.preventDefault();if(submitting)return;submitting=true;const b=d.querySelector('[type=submit]');b.disabled=true;d.querySelectorAll('[data-close]').forEach(c=>c.disabled=true);try{if(version!==epoch)throw Error('TEAM_SESSION_CHANGED');await onSubmit(new FormData(e.target),d);if(version!==epoch)return;d.close();await refresh()}catch(e){d.querySelector('.data-dialog-error').textContent=message(e)}finally{submitting=false;b.disabled=false;d.querySelectorAll('[data-close]').forEach(c=>c.disabled=false)}};
    return d;
  }
  async function importFiles(files,retryAnnotations=false){
    if(!files?.length)return;const version=epoch,wid=activeId();
    let processing;try{processing=await call('processing',{warehouseId:wid})}catch{}
    if(version!==epoch)return;
    const model=processing?.effective?.extraction||processing?.config?.extraction||processing?.extraction;
    const completed=new Set();
    const d=dialog(retryAnnotations?'补齐空间标签索引':'导入到 '+current().name,`${retryAnnotations?'<p>资料已导入，本次核对原导入记录并补齐空间标签索引。</p>':`<p>导入 ${files.length} 份材料，生成可追溯的正文与知识。${esc(model?.model||model?.label||'处理模型沿用当前数据仓配置。')}</p><p>若本仓配置在线模型，正文片段将发送到已确认的模型服务。模型调整与服务确认请在星图中完成。</p>`}<ul>${files.map(f=>`<li>${esc(f.name)}${!team&&f.folderPath?' · '+esc(f.folderPath):''} · ${size(f.size)}</li>`).join('')}</ul>${retryAnnotations?'':'<label class="data-confirm"><input type="checkbox" name="confirmed" required>已确认材料范围及本仓的处理配置</label>'}<p class="data-upload-state" role="status"></p>`,async(_,dialog)=>{
      const pending=[];
      for(let i=0;i<files.length;i++){
        if(version!==epoch||wid!==activeId())throw Error('TEAM_SESSION_CHANGED');
        const file=files[i];if(completed.has(file.handle))continue;
        dialog.querySelector('.data-upload-state').textContent=`${pendingAnnotationImports.has(file.handle)?'正在补齐标签索引':'正在导入'} ${i+1}/${files.length}：${file.name}`;
        const receipt=pendingAnnotationImports.get(file.handle);
        let result=receipt?.documentId?await call('document',{warehouseId:wid,id:receipt.documentId}):null;
        if(!result?.annotationIndex)result=await call('upload',{warehouseId:wid,handle:file.handle});
        if(version!==epoch||wid!==activeId())throw Error('TEAM_SESSION_CHANGED');
        if(!team&&result?.annotationIndex?.status==='pending'){
          pending.push(file.name);pendingAnnotationImports.set(file.handle,{file,warehouseId:wid,documentId:result.document?.id||receipt?.documentId});
        }else{completed.add(file.handle);pendingAnnotationImports.delete(file.handle)}
      }
      if(version!==epoch||wid!==activeId())throw Error('TEAM_SESSION_CHANGED');
      if(pending.length){
        dialog.querySelector('.data-upload-state').textContent=`资料已导入；标签索引待完成：${pending.join('、')}`;
        dialog.querySelector('[type=submit]').textContent='重试标签索引';changed();throw Error('SPACE_ANNOTATION_INDEX_PENDING');
      }
      warehouseId=wid;tab='tasks';panel='tasks';
    });
    d.querySelector('[type=submit]').textContent=retryAnnotations?'重试标签索引':'导入并自动整理';
    d.addEventListener('close',()=>{if(version===epoch)void call('release-files',{warehouseId:wid,handles:files.filter(f=>!pendingAnnotationImports.has(f.handle)).map(f=>f.handle)}).catch(()=>{})});
  }
  async function spacePicker(){
    const version=epoch,wid=activeId();let listing,sequence=0;const picks=new Map();
    const d=dialog('从万象空间导入',`<p>选择当前账号有权读取的文件，导入为${owner}知识材料。</p><div class="data-space-breadcrumb"></div><div class="data-space-files">正在读取空间…</div>`,async()=>{if(version!==epoch||wid!==activeId())throw Error('TEAM_SESSION_CHANGED');if(!picks.size)return;const files=await call('select-space-files',{warehouseId:wid,entries:[...picks.values()]});d.close();await importFiles(files)});
    async function load(parent=''){
      const seq=++sequence;
      try{const v=await call('space-list',{parent});if(version!==epoch||seq!==sequence||!d.isConnected)return;listing=v;
        d.querySelector('.data-space-breadcrumb').innerHTML=`<button type="button" data-folder="">根目录</button>${(v.breadcrumbs||[]).map(b=>`<button type="button" data-folder="${esc(b.id)}">/ ${esc(b.name)}</button>`).join('')}`;
        d.querySelector('.data-space-files').innerHTML=(v.items||[]).map(f=>f.kind==='folder'?`<button type="button" class="data-space-folder" data-folder="${esc(f.id)}">▱ ${esc(f.name)} →</button>`:`<label><input type="checkbox" data-file="${esc(f.id)}" ${picks.has(f.id)?'checked':''} ${f.problem?'disabled':''}>${esc(f.name)}<small>${f.problem?esc(f.problem):size(f.size)}</small></label>`).join('')||'<p>此文件夹为空。</p>';
      }catch(e){d.querySelector('.data-dialog-error').textContent=message(e)}
    }
    d.addEventListener('click',e=>{const b=e.target.closest('[data-folder]');if(b)void load(b.dataset.folder)});
    d.addEventListener('change',e=>{if(e.target.dataset.file){const f=listing.items.find(f=>f.id===e.target.dataset.file);if(e.target.checked)picks.set(f.id,{id:f.id,digest:f.digest});else picks.delete(f.id)}});
    await load();
  }
  async function source(id,wid=activeId(),versionId='',start=0,location=''){
    const version=epoch,sequence=++detailSequence;panel='source';panelLoading=true;sourceValue=null;changed();
    try{
      const v=await call('document',{warehouseId:wid,id});if(version!==epoch||sequence!==detailSequence||panel!=='source')return;
      let value={...v,pinned:false};
      if(versionId){
        const text=await call('document-text',{warehouseId:wid,id,versionId,start});if(version!==epoch||sequence!==detailSequence||panel!=='source')return;
        const returned=text.version_id||text.document_version_id||text.version?.id;
        if(returned!==versionId)throw Error('TEAM_DATA_SOURCE_VERSION_CHANGED');
        value={...v,...text,version:{id:versionId},segments:text.segments||[{text:text.text||text.content||''}],pinned:true};
      }
      sourceValue={...value,sourceId:id,warehouseId:wid,sourceLocation:location};
    }finally{if(version===epoch&&sequence===detailSequence&&panel==='source'){panelLoading=false;changed()}}
  }
  async function loadReviews(id,offset=0){
    const version=epoch,wid=activeId(),sequence=++detailSequence;if(!wid)return;
    if(governance?.warehouseId===wid&&governance.supported===false){panel='reviews';panelLoading=false;review=null;proposal=null;changed();return}
    panel='reviews';panelLoading=true;review=null;proposal=null;changed();
    try{const value=await call(id?'governance-detail':'governance-reviews',{warehouseId:wid,...(id?{reviewId:id}:{offset,limit:50})});if(version!==epoch||sequence!==detailSequence||panel!=='reviews')return;
      if(id){if(!value?.id||!Array.isArray(value.actions)||!Array.isArray(value.evidence))throw Error('TEAM_DATA_RESPONSE_INVALID');review=value}
      else{if(!Array.isArray(value?.items))throw Error('SEMANTICA_UPGRADE_REQUIRED');reviews=value.items;reviewTotal=value.total??reviews.length;reviewsOffset=offset}
      governanceError='';
    }catch(e){if(version===epoch&&sequence===detailSequence){if(invalidScope(e))readFailure(e);else governanceError=message(e)}}finally{if(version===epoch&&sequence===detailSequence&&panel==='reviews'){panelLoading=false;changed()}}
  }
  async function governanceWrite(actionName,input){
    if(governanceWriting||pendingGovernance&&input.operationId!==pendingGovernance.input.operationId)throw Error('TEAM_DATA_OPERATION_UNCONFIRMED');
    const version=epoch,sequence=++detailSequence,reviewId=input.reviewId,operation={action:actionName,input:{warehouseId:activeId(),...input,operationId:input.operationId||crypto.randomUUID()}};
    pendingGovernance=operation;governanceWriting=true;busy=true;panel='reviews';changed();
    try{
      const value=await call(actionName,operation.input);if(version!==epoch)return;
      if(actionName==='governance-propose'){
        if(!value?.id||value.review_id!==reviewId||!Number.isInteger(value.revision)||value.revision<1||!['ready','insufficient'].includes(value.status)||!Array.isArray(value.evidence))throw Error('TEAM_DATA_RESPONSE_INVALID');
        pendingGovernance=null;
        if(sequence!==detailSequence||review?.id!==reviewId)throw Error('TEAM_DATA_REVIEW_CHANGED');
        proposal=value;
      }else{pendingGovernance=null;review=null;proposal=null;await loadReviews();await refresh()}
      changed();
    }catch(e){
      if(version===epoch){
        if(invalidScope(e))readFailure(e);
        else if(code(e).startsWith('WAREHOUSE_GOVERNANCE_')&&!code(e).endsWith('PROPOSAL_IN_PROGRESS'))pendingGovernance=null;
      }
      throw e;
    }finally{if(version===epoch){governanceWriting=false;busy=false;changed()}}
  }
  async function action(name,data={}){
    if(!scope||!admin)return;
    if(name==='toggle-more'){const menu=moreMenu();if(menu)menu.open=!menu.open;return}
    if(['open','refresh','assistant-access','rename-warehouse'].includes(name))closeMoreMenu();
    if(await materialBrowser.action(name,data))return;
    if(name==='delete-material'){
      if(busy)return;
      const version=epoch,wid=activeId();if(!wid)return;
      busy=true;error='';errorCode='';changed();
      try{
        const detail=await call('document',{warehouseId:wid,id:data.id});
        if(version!==epoch)return;
        if(detail.document?.id!==data.id)throw Error('TEAM_DATA_RESPONSE_INVALID');
        const input={warehouseId:wid,id:data.id,versionId:detail.version?.id||detail.document.active_version_id||null,operationId:crypto.randomUUID(),confirmed:true};
        dialog('删除材料及对应知识',`<p>将从当前数据仓删除「${esc(detail.document.original_name)}」及其对应知识、原文依据和检索索引，并取消尚未完成的处理任务。</p><p>其他材料仍有依据支持的共享知识会保留。电脑上的原始文件不会被删除。</p><label class="data-confirm"><input type="checkbox" required>确认删除这份材料及其对应知识</label>`,async()=>{
          await call('delete-document',input);
          if(version!==epoch)return;
          materialBrowser.remove(data.id);clearGraph();panel=null;
        });
      }catch(e){if(version===epoch){error=message(e);errorCode=code(e);contentReady=false}}
      finally{if(version===epoch){busy=false;changed()}}
      return;
    }
    if(governanceWriting&&['reviews','review-detail','reviews-page','close-panel','flag','review-discard','review-resolve','review-propose','review-apply','source','node','edge'].includes(name))return;
    if(pendingGovernance&&['flag','review-resolve','review-propose','review-apply'].includes(name)){error=message(Error('TEAM_DATA_OPERATION_UNCONFIRMED'));changed();return}
    if(name==='graph-warehouse'){await action('select',{id:data.id,tab:'graph'});return}
    if(name==='create'){try{createWarehouse()}catch(e){readFailure(e);contentReady=false;changed()}return}
    if(name==='warehouse-picker'){warehousePicker();return}
    if(name==='rename-warehouse'){try{renameWarehouse(data.id||activeId())}catch(e){readFailure(e);changed()}return}
    if(name==='close-panel'){detailSequence++;panelLoading=false;panel=null;review=null;proposal=null;changed();return}
    if(name==='reviews'||name==='review-detail'){await loadReviews(name==='review-detail'?data.id:null);return}
    if(name==='flag'){
      if(governance?.warehouseId===activeId()&&governance.supported===false){error=governanceError;changed();return}
      if(!['entity','relation'].includes(data.kind)||!data.id)return;
      dialog('反馈知识问题','<p>请描述你发现的问题。反馈会保留为待核对事项，尚未确认的修改不会直接生效。</p><label>问题说明<textarea name="reason" required maxlength="2000" placeholder="例如：同名人员被混为一人，或这条关系缺少原文依据。"></textarea></label>',async f=>governanceWrite('governance-flag',{kind:data.kind,targetId:data.id,reason:String(f.get('reason')||''),expectedRevision:0}));return;
    }
    if(name==='reviews-page'){const offset=Number(data.offset);if(Number.isSafeInteger(offset)&&offset>=0&&offset<reviewTotal)await loadReviews(null,offset);return}
    if(name==='review-discard'){proposal=null;changed();return}
    if(name==='governance-retry'){if(!pendingGovernance||busy)return;const version=epoch;busy=true;try{await governanceWrite(pendingGovernance.action,pendingGovernance.input)}catch(e){if(version===epoch){error=message(e);changed()}}finally{if(version===epoch)busy=false}return}
    if(name==='review-resolve'||name==='review-propose'||name==='review-apply'){
      if(!review||busy)return;
      if(name==='review-apply'&&(!proposal||proposal.status!=='ready'))return;
      const currentReview=review,choice=review.actions.find(a=>a.id===data.actionId);
      if(name==='review-resolve'&&!choice)return;
      const title=name==='review-apply'?'确认应用建议修改':name==='review-propose'?'说明希望如何核对':choice.label;
      dialog(title,`<p>${esc(currentReview.title)}</p>${choice?.id==='unflag'?'<p>撤回反馈后，服务端会重新核验并恢复可用知识。请确认已经核对来源；此操作不改写原始资料。</p>':''}${name==='review-apply'?'<p>仅应用上方已展示的建议；原始资料与来源保留。</p>':'<label>依据或说明<textarea name="reason" maxlength="2000" '+(choice?.requires_note||name==='review-propose'?'required':'')+' placeholder="说明你核对的依据，证据不足时请保留待核对。"></textarea></label>'}`,async f=>{
        if(review?.id!==currentReview.id)throw Error('TEAM_SESSION_CHANGED');
        const base={reviewId:currentReview.id,expectedRevision:currentReview.revision,reason:String(f.get('reason')||'')};
        if(name==='review-propose')await governanceWrite('governance-propose',base);
        else if(name==='review-apply')await governanceWrite('governance-apply',{proposalId:proposal.id,expectedRevision:proposal.revision,confirmed:true});
        else if(choice.id==='unflag')await governanceWrite('governance-unflag',{reviewId:currentReview.id,expectedRevision:currentReview.revision});
        else await governanceWrite('governance-resolve',{...base,actionId:choice.id});
      });return;
    }
    if(name==='select'||name==='overview'||name==='tab'){
      if(name==='select'&&!warehouses.some(w=>w.id===data.id))return;
      if(name==='tab'&&!['graph','materials','tasks','search'].includes(data.tab))return;
      const selectionEpoch=epoch;
      await call('select-warehouse');
      if(selectionEpoch!==epoch)return;
      const switching=name!=='tab';
      detailSequence++;panelLoading=false;governanceWriting=false;busy=false;epoch++;loading=false;searching=false;contentReady=false;refreshVisible=false;results=[];annotationSearch=null;error='';errorCode='';query='';offset=0;total=0;
      if(switching){ontologyDetail=null;ontologyError='';materialBrowser.reset();documents=[];jobs=[];clearGraph();sourceValue=null;panel=null;review=null;proposal=null;governance=null;governanceError='';pendingGovernance=null}
      if(name==='select'){if(!warehouses.some(w=>w.id===data.id))return;warehouseId=data.id;overviewWarehouseId=data.id;tab=['tasks','graph'].includes(data.tab)?data.tab:'materials'}else if(name==='overview'){warehouseId=null;tab='graph'}else{warehouseId=activeId();tab=data.tab}
      if(tab==='tasks'||tab==='search')panel=tab;else if(!switching)panel=null;
      if(sharePreview?.warehouseId!==activeId()){sharePreview=null;shareError=''}
      changed();await refresh();return epoch===selectionEpoch+1;
    }
    if(name==='node'){detailSequence++;panelLoading=false;panel=null;sourceValue=null;node=data.id;edge=null;zoom=1;changed();return}
    if(name==='edge'){detailSequence++;panelLoading=false;panel=null;sourceValue=null;edge=data.id;changed();return}
    if(name==='graph-reset'||name==='graph-constellation'){
      if(name==='graph-constellation'&&!graphCache?.constellations.some(group=>group.id===data.id))return;
      detailSequence++;panelLoading=false;panel=null;sourceValue=null;
      constellation=name==='graph-constellation'?data.id:null;
      node=null;edge=null;graphQuery='';graphType='all';zoom=1;changed();return
    }
    if(name==='graph-metric'){if(['relations','sources'].includes(data.metric)&&starMetric!==data.metric){starMetric=data.metric;changed()}return}
    if(name==='graph-isolated'){showIsolated=!showIsolated;node=null;edge=null;constellation=null;zoom=1;graphMotion.reset();changed();return}
    if(name==='graph-type'){graphType=data.type;node=null;edge=null;zoom=1;changed();return}
    if(name==='graph-rotate'){graphMotion.rotate(data.direction==='left'?-.32:.32);return}
    if(name==='graph-zoom'){if(graphMotion.zoom(data.direction==='in'?1.25:.8))return;zoom=Math.min(2.5,Math.max(.5,zoom+(data.direction==='in'?.25:-.25)));changed();return}
    if(name==='graph-fit'){if(graphMotion.fit())return;zoom=1;changed();return}
    if(name==='refresh'){await refresh();return}
    if(name==='retry-annotation-imports'){
      const files=[...pendingAnnotationImports.values()].filter(item=>item.warehouseId===activeId()).map(item=>item.file);
      if(!team&&files.length)await importFiles(files,true);return;
    }
    if(name==='previous'||name==='next'){offset=Math.max(0,offset+(name==='next'?100:-100));await refresh();return}
    if(name==='source'){if(data.warehouseId&&data.warehouseId!==activeId())return;const version=epoch,sequence=detailSequence+1;try{await source(data.id,data.warehouseId||activeId(),data.versionId||'',Number(data.start)||0,data.location||'')}catch(e){if(version===epoch&&sequence===detailSequence){readFailure(e);changed()}}return}
    if(name==='reprocess-failed'||name==='reextract-document'){
      if(!team){
        // Each material has its own version, blockers and replacement consent.
        // Do not bypass these with the legacy batch reprocess endpoint.
        const ids=[...new Set(failedExtractions().map(j=>j.document_id).filter(Boolean))],version=epoch,wid=activeId();
        if(!wid||!ids.length)return;
        const d=dialog('选择需要自动处理的材料',`<p>逐份预览当前处理配置和替换影响，再确认自动处理。</p>${ids.map(id=>`<button type="button" class="button" data-automatic-document="${esc(id)}">${esc(jobs.find(j=>j.document_id===id)?.original_name||jobs.find(j=>j.document_id===id)?.document_name||'待处理材料')}</button>`).join('')}`,async()=>{});
        d.querySelector('[type=submit]').hidden=true;
        d.addEventListener('click',async event=>{
          const selected=event.target.closest('[data-automatic-document]');if(!selected||version!==epoch||wid!==activeId())return;
          d.close();tab='materials';panel=null;changed();await refresh();
          if(version===epoch)await materialBrowser.action('reextract-document',{id:selected.dataset.automaticDocument});
        });return;
      }
      if(busy)return;
      const single=name==='reextract-document';
      const version=epoch,wid=activeId(),ids=new Set(single?[data.id]:failedExtractions().map(j=>j.document_id));
      if(!wid||!ids.size)return;
      busy=true;error='';errorCode='';changed();
      try{
        const processing=await call('processing',{warehouseId:wid});
        let listing;
        if(single){
          const detail=await call('document',{warehouseId:wid,id:data.id});
          listing={items:detail.document?[{...detail.document,active_version_id:detail.version?.id||detail.document.active_version_id}]:[]};
        }else listing=await call('documents',{warehouseId:wid,offset:0});
        if(version!==epoch)return;
        const selected=(listing.items||listing.documents||[]).filter(d=>d&&ids.has(d.id)&&d.status==='ready'&&d.active_version_id);
        if(!selected.length)throw Error('TEAM_DATA_RESPONSE_INVALID');
        if(single&&selected[0].active_version_id!==data.versionId)throw Error('TEAM_DATA_SOURCE_VERSION_CHANGED');
        const config=processing.effective||processing.config||processing,model=config.extraction;
        if(!model||typeof config.signature!=='string')throw Error('TEAM_DATA_RESPONSE_INVALID');
        const operationId=crypto.randomUUID();
        dialog(single?'重新抽取当前文件':'使用当前模型补处理',`<p>${single?'使用当前文件已解析的正文重新抽取知识，不重新上传或解析原文件。':`仅重新处理 ${selected.length} 份未完成知识抽取的材料，保留其他材料的现有图谱。`}</p><p>当前模型：${esc(model?.name||model?.model||'当前数据仓处理模型')}。${model?.location==='external'?'正文片段将发送到已确认的在线模型服务，并产生模型用量。':'沿用当前数据仓已确认的处理配置。'}</p><ul>${selected.map(d=>`<li>${esc(d.original_name)}</li>`).join('')}</ul><label class="data-confirm"><input type="checkbox" required>确认上述材料范围与当前模型</label>`,async()=>{
          await call('reprocess-models',{warehouseId:wid,documents:selected.map(d=>({id:d.id,version_id:d.active_version_id})),expectedSignature:config.signature,operationId});
          if(single&&version===epoch){warehouseId=wid;tab='tasks';panel='tasks'}
        });
      }catch(e){if(version===epoch){error=message(e);errorCode=code(e);contentReady=false}}finally{if(version===epoch){busy=false;changed()}}
      return;
    }
    if(busy)return;
    const version=epoch;busy=true;error='';errorCode='';changed();
    try{
      if(name==='share'||name==='share-create')await call('open-starlink',{warehouseId:activeId(),view:'api'});
      else if(name==='install-starlink'){await call('install-starlink');await call('open-starlink',{warehouseId:activeId(),view:activeId()?'graph':'warehouses'})}
      else if(name==='open')await call('open-starlink',{warehouseId:data.warehouseId||activeId(),view:data.view||(['materials','graph'].includes(tab)?tab:'graph')});
      else if(name==='import'){
        if(!current())return;
        const d=dialog('导入资料',`<p>导入到「${esc(current().name)}」。原文件保留，后续修改不会自动同步。</p><div class="data-lite-import-options"><button type="button" class="button primary" data-import-space>从万象空间选择 →</button><button type="button" class="button" data-import-local>从电脑选择 →</button></div>`,async()=>{});d.querySelector('[type=submit]').hidden=true;
        d.addEventListener('click',e=>{if(e.target.closest('[data-import-space]')){d.close();void action('import-space')}else if(e.target.closest('[data-import-local]')){d.close();void action('import-local')}});
      }
      else if(name==='import-local')await importFiles(await call('select-files',{warehouseId:activeId()}));
      else if(name==='import-space')await spacePicker();
      else if(name==='retry'){await call('retry-job',{warehouseId:activeId(),id:data.id});await refresh()}
      else if(name==='retry-publications'){
        const wid=activeId(),pending=failedPublications().map(j=>j.id);
        for(const id of pending){if(version!==epoch||!scope||!admin)return;await call('retry-job',{warehouseId:wid,id})}
        if(version===epoch)await refresh();
      }
    }catch(e){if(version===epoch){error=message(e);errorCode=code(e)}}finally{if(version===epoch){busy=false;changed()}}
  }
  async function submit(kind,form){
    if(!scope||!admin)return;
    if(kind==='material-save'){await materialBrowser.action('material-save',{});return}
    if(kind==='material-filter'){materialBrowser.filter(form.get('materialFilter')||'');return}
    if(!scope||!admin)return;
    if(kind==='graph-search'){graphQuery=String(form.get('graphQuery')||'').trim();constellation=null;node=null;edge=null;zoom=1;changed();return}
    if(kind==='filter'){filter=form.get('filter')||'';changed();return}
    if(kind==='search'){
      if(searching)return;
      query=String(form.get('query')||'').trim();if(!scope||!query)return;
      const version=epoch;searching=true;results=[];annotationSearch=null;error='';errorCode='';changed();
      try{const v=await call('search',{warehouseId:activeId(),query});if(version===epoch){
        results=v.items||v.results||[];
        if(!team){annotationSearch=v.annotationSearch||null;results=[...results,...(v.annotationDocuments||[]).map(d=>({
          document_id:d.documentId,document_version_id:d.versionId,document_name:d.title,text:'打开来源查看对应版本。',spaceFolderPath:d.folderPath,annotation:d.annotation,annotationMatch:true,
        }))]}
      }}
      catch(e){if(version===epoch)readFailure(e)}finally{if(version===epoch){searching=false;changed()}}
    }
  }
  const materialBrowser=createMaterialBrowser({call,changed,personal:!team,getContext:()=>({scope,recoveryScope,warehouseId:activeId()})});
  return {compositionStart:composition.start,compositionEnd:composition.end,isComposing:composition.active,retainInput:root=>retainGraphInput(root,document),currentWarehouse:()=>activeId(),hasMaterialDrafts:()=>materialBrowser.hasDrafts(),sync,suspend(){annotationSearch=null;closeMoreMenu();materialBrowser.reset();graphMotion.reset();admin=false;detailSequence++;governanceWriting=false;epoch++;clearTimeout(refreshTimer);clearLoading();loading=false;searching=false;contentReady=false;refreshVisible=false;busy=false;initialized=false;error='';errorCode='';sharePreview=null;governance=null;panel=null;sourceValue=null;pendingGovernance=null;document.querySelectorAll?.('dialog[data-team-data-dialog]').forEach(d=>{d.close();d.remove()})},render,refresh,action,submit,input:(name,value)=>{if(materialBrowser.input(name,value))return;if(name==='query')query=value;if(name==='filter')filter=value;if(name==='graphQuery')graphQuery=value},needsLoad:()=>scope&&!initialized&&!loading&&!error};
};

window.createTeamDataView=wrapAssistantKnowledgeAccess(window.createTeamDataView);
