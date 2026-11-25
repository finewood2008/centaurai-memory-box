import {logicalSourcesHTML, logicalSourceGroups, taskUnitLabel, extractionCountsHTML} from './logical-source-view.mjs';
import { overviewHTML, knowledgeHTML } from './starlink-pages.mjs';
import { createStarxiaotu } from './starxiaotu.mjs';
import {concepts, guideMark, isGuideBackgroundClick, guideShortcut} from '../shared/application-guide.mjs';
import { mountTermGlossary, starxiaotuTermMarker } from './term-help.mjs';
import { starxiaotuRecords, starxiaotuOverview, starxiaotuSearchFailure, revealStarxiaotuRecord } from './starxiaotu-records.mjs';
import { createWorkbenchHost, readWorkbenchReply } from "./native-workbench.js";
import { createOnboardingUI } from './onboarding.js';
import { onboardingUnavailable } from './onboarding-dialogue-state.mjs';
import { enterOnboardingWarehouse } from './onboarding-navigation.mjs';
import { materialReaderHTML } from './conversation.js';
import {changeUserInstruction} from './conversation-changes-view.mjs';
import {evidenceReferenceHTML} from './material-evidence-view.mjs';
import {pendingAnnotationHTML} from './import-annotation.mjs';
import {materialReplySuggestions} from './conversation-view.mjs';
import {ConversationFlow} from './conversation-state.mjs';
import {mountMaterialWorkspace,openMaterialUpload} from './material-workspace.mjs';
import {readWarehouseMaterials,selectWarehouseMaterial,openWarehouseMaterial} from './material-library.mjs';
import {openMaterialDelete} from './material-deletion.mjs';
import {continueMaterial,canContinueMaterial} from './material-continuation.mjs';
import {nextConversationStep} from './conversation-next.mjs';
import {currentCandidateGraph} from './conversation-candidate-graph.mjs';
import {extractionFailuresHTML, extractionValidationHTML} from './extraction-diagnostics.mjs';
let conversationFlow=null,conversationTimer=null,conversationReady=null,basicMaterialWarehouse=null;
function stopConversation(){clearTimeout(conversationTimer);document.getElementById('mw-upload-dialog')?.remove();document.getElementById('mw-delete-dialog')?.remove();conversationFlow?.dispose();conversationFlow=null;basicMaterialWarehouse=null;}
import { createSkillsUI } from "./native-skills.js";
import { icon, icons } from "./icons.js";
import { selectGraph, layoutGraph, edgeGeometry } from "./graph.js";
import { createGraphMotion } from './graph-motion.mjs';
import { createGraphExploration } from './graph-exploration-view.mjs';
const graphMotion = createGraphMotion();
let graphAutoRotate = false;
import {createGraphPresentation, graphConnections, presentGraph} from './graph-presentation.mjs';
const $ = (selector) => document.querySelector(selector);
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const bridge = window.semantica;
$('#app').classList.toggle('has-project-banner', !!bridge?.setBannerActions);
const onboarding = createOnboardingUI({
  bridge, call,
  async enter(warehouse, {isCurrent}) {
    await enterOnboardingWarehouse({
      warehouseId:warehouse.id, view:'conversation', isCurrent, readWarehouses:()=>call('warehouses'),
      snapshot:()=>({...state}), select:(id,view)=>selectWarehouse(id,view,true),
      commit:items=>{state.warehouses=items;},
    });
  },
  onChange() {
    renderWarehouseDirectory();
    syncControls();
  },
  onCreated() {
    toast('星图已就绪，可以导入资料。');
    $('#page-primary').focus({preventScroll:true});
  },
});
const typeDisplay = code => state.graphPresentation.entity(code);
const messages = {
  SKILL_ID_CONFLICT:"当前星图已存在同名 Skill，不会覆盖；请修改 ZIP 名称标识或先下载后删除旧版本。",
  SKILL_TOO_LARGE:"Skill ZIP 不能超过 4 MiB，解压文本最多 8 MiB。",
  SKILL_INVALID_REQUEST:"文件或请求格式不正确，请检查 SKILL.md 和确认名称。",
  SKILL_PACKAGE_PATH:"ZIP 含不安全路径或重复文件，请检查后重试。",
  SKILL_NOT_FOUND:"方法已删除或不属于当前星图，请刷新。",
  SKILL_REVISION_CONFLICT:"方法版本已变化，请重新读取后操作。",
  SKILL_REFERENCED:"还有方法依赖此 Skill，请先处理依赖或明确允许它们失效。",
  REASONING_DELIVERY_STALE:"方法、材料或检测规则已变化，请重新准备后试读。",
  REASONING_SCOPE_REQUIRED:"请勾选当前星图的资料后重新准备。",
  REASONING_SCOPE_CHANGED:"方法或材料版本已变化，请重新准备。",
  REASONING_PREPARATION_NOT_FOUND:"准备记录已失效或不属于当前账号、星图，请重新准备。",
  MODEL_SHARED_REQUIRED: "知识抽取与脱敏检测共用同一个模型，请刷新后统一设置。",
  MODEL_CLOUD_CONFIRMATION_REQUIRED: "请先确认所选在线服务将接收未经脱敏的正文片段。",
  MODEL_CONFIG_CONFLICT: "模型设置已更新，请刷新后重新确认。",
  MODEL_CHECK_REQUIRED: "模型检查已过期，请重新检查后保存。",
  MODEL_RELAY_UNAVAILABLE: "万象模型服务暂时无法连接，请检查连接后重试。",
  MODEL_AUTH_REQUIRED: "模型授权已失效，请重新连接万象。",
  MODEL_BILLING_REQUIRED: "云端模型因计费问题无法调用，请在模型设置选择可用的模型。",
  MODEL_UNAVAILABLE: "模型已停用或删除，请在万象检查模型配置。",
  MODEL_DEFAULT_UNAVAILABLE: "万象底座的默认模型暂不可用，请在万象模型设置中检查。",
  MODEL_DEFAULT_NOT_CONFIGURED: "万象底座尚未配置可用的默认模型。配置后，星图会自动使用。",
  MODEL_CONFIG_CHANGED: "模型服务配置已变化，请重新检查并确认。",
  MODEL_OPTIONS_INVALID: "思考模式参数无效，请重新选择。",
  MODEL_THINKING_UNSUPPORTED: "当前模型或万象版本不支持此思考模式，请刷新模型目录后选择。",
  MODEL_OPTIONS_UNCONFIRMED: "万象未确认思考模式，请更新万象后重新检查。",
  MODEL_INVALID_OUTPUT: "模型未返回符合要求的 JSON，请换模型或重试。",
  MODEL_CALL_FAILED: "模型检查或调用失败，请检查万象模型连接与输出能力。",
  MODEL_CANCELLED: "模型调用已取消。",
  MODEL_INPUT_TOO_LARGE: "本次模型输入超限，请缩小材料片段后重试。",
  SPACE_UPGRADE_REQUIRED: "当前设备尚不支持万象空间，请更新万象服务。",
  SPACE_REQUEST_FAILED: "万象空间暂时无法读取，请检查连接并刷新。",
  SPACE_REMOTE_FILE_CHANGED: "万象空间文件已变化。请移除旧选择，再刷新并选择新版本。",
  SPACE_TAG_RESULTS_CHANGED: "空间搜索进度已失效，请刷新后重新搜索。",
  SPACE_NOT_FOUND: "万象空间文件已删除或移入回收站。请移除旧选择，再刷新并选择可用文件。",
  SPACE_ENTRY_NOT_FOUND: "万象空间文件已删除或移入回收站。请移除旧选择，再刷新并选择可用文件。",
  SPACE_NOT_FILE: "此项目不是可导入的文件，请进入文件夹选择具体文件。",
  SPACE_EMPTY_FILE: "空文件不能导入。",
  SPACE_CHUNK_INVALID: "万象空间文件校验未通过，请刷新后重试。",
  SPACE_CONNECTION_TIMEOUT: "读取万象空间超时，请检查连接后重试。",
  WANX_HOST_REQUIRED: "请先在万象连接盒子，再进入星图。",
  HOST_SESSION_EXPIRED: "万象连接已失效。请重新连接盒子后进入星图。",
  SEMANTICA_UPGRADE_REQUIRED: "当前盒子尚未接入星图，请更新盒端服务。",
  SEMANTICA_NOT_CONFIGURED: "盒端尚未配置星图服务。",
  SEMANTICA_ANNOTATION_SEARCH_UNAVAILABLE: "当前无法按标签筛选，请更新盒端服务或清除标签后重试。",
  SEMANTICA_CONNECTION_FAILED: "当前连接不可用，请检查万象与盒子的连接后重试。",
  WAREHOUSE_BUSY: "当前星图正在处理或清理，可切换其他星图，或稍后重试。",
  NETWORK_NOT_READY:
    "万象正在恢复网络连接。已提交的任务仍由盒端处理，请稍后刷新。",
  SEMANTICA_SERVICE_UNAVAILABLE: "知识服务暂时不可用，请稍后刷新。",
  SEMANTICA_SERVICE_AUTH_FAILED: "盒端知识服务的授权配置需要检查。",
  SEMANTICA_VERSION_CONFLICT: "材料或设置已更新，请重新读取当前版本后再提交。",
  SEMANTICA_FILE_TOO_LARGE: "文件超过当前服务允许的大小。",
  SEMANTICA_FORMAT_NOT_SUPPORTED: "当前服务不支持该文件格式。",
  SEMANTICA_FILE_CONTENT_MISMATCH: "文件可能已损坏，或内容与扩展名不符。请移除后重新选择可打开的文件。",
  SEMANTICA_FILE_ENCRYPTED: "文件受密码保护。请解除保护后重新选择。",
  SEMANTICA_LOCAL_FILE_CHANGED: "文件在导入期间发生了变化，请重新选择文件。",
  SEMANTICA_RESOURCE_NOT_FOUND: "材料或来源已失效，请刷新当前页面。",
  SEMANTICA_RESOURCE_FORBIDDEN: "当前账号无权访问该材料或来源。",
  SEMANTICA_FILE_SELECTION_EXPIRED: "文件选择已失效，请重新选择。",
  SEMANTICA_DOWNLOAD_HASH_MISMATCH: "下载校验未通过，未保存该文件。",
};
const state = {
  ready: false,
  warehouses: [],
  warehouseId: null,
  generation: 0,
  runtime: null,
  managementStats: null,
  importFailure: null,
  clearIntent: null,
  preparingWarehouseChange: false,
  invalid: false,
  view: "graph",
  ontologySection: "published",
  ontologyCategory: "published",
  documents: [],
  jobs: [],
  jobTotal: 0,
  jobOffset: 0,
  graph: { nodes: [], edges: [] },
  policy: null,
  selectedNode: null,
  selectedEdge: null,
  detailsDismissed: false,
  type: "all",
  mode: "graph",
  graphOverview: true,
  showIsolated: false,
  importFiles: { standard: [], conversation: [] },
  get files() { return this.importFiles[this.importContext]; },
  set files(files) { this.importFiles[this.importContext] = files; },
  uploading: false,
  importContext: "standard",
  space: { parent: "", breadcrumbs: [], items: [] },
  spaceResults: null,
  spaceLoading: false,
  spaceSelecting: false,
  spaceError: null,
  spaceRequest: 0,
  refreshing: false,
  source: null,
  sourceEvidence: null,
  sourceRequest: 0,
  sourceLoading: false,
  editing: false,
  saving: false,
  graphError: null,
  graphPresentation: createGraphPresentation(),
  graphOntology: null,
};
function starxiaotuScope(warehouseId=state.warehouseId) {
  return state.ready && !state.invalid && state.identity ? JSON.stringify([
    state.identity.accountId,state.identity.boxId,state.identity.user.id,warehouseId,
  ]) : null;
}
const starxiaotu = bridge?.openGuide ? null : createStarxiaotu({
  identifyIntent:body=>call('assistant-intent',{body}),
  hasProject:()=>!!state.warehouseId,
  root:$('#content'), rail:$('#starlink-rail'), scope:starxiaotuScope,
  project:() => currentWarehouse()?.name || '个人空间',
  view:() => state.view==='graph'&&state.mode==='list'?'data':state.view,
  materialContext:()=>{
    if(state.view!=='conversation')return null;
    const material=conversationFlow?.state.librarySelection?.document || state.source?.document;
    if(!material || material.deleted_at || material.status==='deleted')return null;
    return {key:material.id,title:material.original_name||material.name||''};
  },
  async search(query,source) {
    if(!state.warehouseId)return {results:[],complete:true};
    if(source?.documentId){
      const payload=await call('search',{query:query.trim(),documentIds:[source.documentId]});
      const items=(Array.isArray(payload?.items)?payload.items:Array.isArray(payload?.results)?payload.results:[]).filter(item=>item?.document_id===source.documentId);
      return starxiaotuRecords({graph:{nodes:[],edges:[]},documents:state.documents.filter(d=>d.id===source.documentId),resolvedQuery:true},query,{items});
    }
    const snapshot={graph:state.graph,documents:state.documents,resolvedQuery:true};
    const local=starxiaotuRecords(snapshot,query);
    if(local.complete)return local;
    try {
      const payload=await call('search',{query:query.trim()});
      return starxiaotuRecords(snapshot,query,payload);
    } catch(error) {
      if(['WAREHOUSE_CHANGED','HOST_SESSION_EXPIRED'].includes(error.code))throw error;
      if(local.results.length){const failure=starxiaotuSearchFailure(error);return {...local,message:failure.answer+' 以下仅展示当前已加载记录。',errorCode:failure.code};}
      throw error;
    }
  },
  async overview(metric='summary') {
    const warehouseId=state.warehouseId;
    const snapshot={warehouse:currentWarehouse(),documents:state.documents,graph:state.graph};
    const [warehouse,documents]=await Promise.allSettled([call('warehouse',{id:warehouseId},warehouseId),call('documents',{limit:100},warehouseId)]);
    for(const result of [warehouse,documents])if(result.status==='rejected' && ['WAREHOUSE_CHANGED','HOST_SESSION_EXPIRED'].includes(result.reason?.code))throw result.reason;
    const validWarehouse=warehouse.status==='fulfilled' && warehouse.value?.id===warehouseId;
    const validDocuments=documents.status==='fulfilled' && Array.isArray(documents.value?.items);
    const current=validWarehouse ? warehouse.value : snapshot.warehouse;
    const rows=validDocuments ? documents.value.items : snapshot.documents;
    return starxiaotuOverview({...snapshot,warehouse:current,documents:rows,metric,
      notice:!validWarehouse||!validDocuments?'部分最新数据读取失败，以下包含当前已加载的项目数据，可刷新后重新查询。':''});
  },
  async queryOntology() {return readWorkbenchReply(await call('conversation-ontologies'));},
  canEditOntology:() => canCreateWarehouse() && currentWarehouse()?.state==='active',
  async ask(input, warehouseId=state.warehouseId) {
    const snapshot = {documents:warehouseId===state.warehouseId ? state.documents : []};
    const reply = await call('starxiaotu-answer',input,warehouseId);
    return {...reply,results:starxiaotuRecords(snapshot,'',{items:reply.items}).results};
  },
  navigate:navigateStarxiaotu,
});
function starxiaotuMarker(context) {
  return `<span class="sx-title-anchor"><button type="button" class="sx-context" data-starxiaotu-context="${context}" aria-label="让 CentaurAI 解释${{overview:'概览',ontology:'本体',conversation:'资料库',knowledge:'数据列表',graph:'星图',data:'数据列表',models:'模型设置',warehouses:'项目'}[context] || '当前板块'}">${guideMark}</button></span>`;
}
function explainStarxiaotuTerm(key, anchor) {
  const term=concepts.get(key);
  if (!term) return;
  if (bridge?.openGuide) {
    bridge.openGuide(term.key);
  } else {
    anchor?.closest('#help-dialog')?.close();
    starxiaotu.explain(term.guide,term.label,term.definition);
  }
}
function dismissGuideOnBackground(event) {
  if (bridge?.dismissGuide && isGuideBackgroundClick(event)) bridge.dismissGuide();
}
if (bridge?.openGuide) {
  document.addEventListener('click',dismissGuideOnBackground);
  document.addEventListener('toggle',event=>{
    if(event.target.matches('dialog'))bridge.setGuideView?.(state.view);
  },true);
  document.addEventListener('keydown',event=>{
    if (guideShortcut(event)){event.preventDefault();bridge.openGuide();}
  });
}
mountTermGlossary($('#help-dialog'));
function syncStarxiaotu() {
  starxiaotu?.sync();
  bridge?.setGuideView?.(state.view);
  const title=$('#page-title');
  if(['overview','ontology','conversation','knowledge'].includes(state.view) && !title.querySelector('.sx-context'))
    title.insertAdjacentHTML('beforeend',starxiaotuMarker(state.view));
  for (const anchor of document.querySelectorAll('[data-starxiaotu-glossary]:empty')) {
    anchor.innerHTML = starxiaotuTermMarker(anchor.dataset.starxiaotuGlossary);
  }
}
async function navigateStarxiaotu(target) {
  if(!state.ready || state.invalid)return false;
  const revealPage=(view=target.view)=>{
    const section=view==='data'?$('#relation-list'):view==='graph'?$('.graph-controls'):workbench.has(view)?$('#view-workbench'):$('#view-'+view);
    return revealStarxiaotuRecord(section?.querySelector('h1,h2,h3') || section);
  };
  const currentView=state.view==='graph'&&state.mode==='list'?'data':state.view;
  if(target.guide && !target.configuration && target.view===currentView && target.view!=='ontology')return revealPage(currentView);
  if(!workbench.canLeave())return false;
  if(target.configuration==='create-project') {
    await openWarehouseSetup();
    return onboarding.visible;
  }
  if(target.configuration==='dialogue-models') {
    if(state.view!=='models')setView('models');
    return state.view==='models' && revealStarxiaotuRecord($('#starxiaotu-model-settings'));
  }
  if(!state.warehouseId && !['warehouses','models'].includes(target.view))return false;
  const generation=state.generation;
  if(target.configuration==='material') {
    if(state.view!=='conversation')setView('conversation');
    if(state.view!=='conversation')return false;
    await conversationReady;
    if(state.generation!==generation || state.view!=='conversation')return false;
    $('#page-primary')?.focus();
    return true;
  }
  if(target.configuration==='ontology') {
    if (!canCreateWarehouse() || currentWarehouse()?.state !== 'active') return false;
    setView('ontology', false, 'drafts');
    return state.view === 'ontology';
  }
  if(target.configuration==='import') {
    if(state.view!=='conversation')setView('conversation');
    if(state.view!=='conversation')return false;
    await action('import');
    return $('#import-dialog').open;
  }
  if(target.kind==='document') {
    if(!/^[A-Za-z0-9_-]{1,128}$/.test(target.documentId || ''))return false;
    setView('conversation');
    if(state.view!=='conversation')return false;
    await showSource(target.documentId,null,target.versionId || '',{segment:target.segmentId,start:target.start});
    if(state.generation!==generation || state.invalid || state.source?.document?.id!==target.documentId)return false;
    return revealStarxiaotuRecord($('#source-body .source-segment'));
  }
  if(target.kind==='entity') {
    if(!state.graph.nodes.some(node=>node.id===target.recordId))return false;
    setView('knowledge');
    if(state.view!=='knowledge')return false;
    $('#knowledge-query').value='';
    state.knowledgeEntity=target.recordId;
    renderKnowledge();
    return revealStarxiaotuRecord([...document.querySelectorAll('#knowledge-list [data-entity-page]')].find(el=>el.dataset.entityPage===target.recordId));
  }
  if(target.kind==='relation') {
    if(!state.graph.edges.some(edge=>edge.id===target.recordId))return false;
    setView('graph');
    if(state.view!=='graph')return false;
    state.type='all';state.graphOverview=false;state.showIsolated=true;
    state.selectedNode=state.selectedEdge=null;
    $('#graph-query').value='';explorer.reset();renderFilters();renderGraph();
    $('[data-mode="list"]').click();
    state.selectedEdge=target.recordId;state.detailsDismissed=false;renderGraph();
    return revealStarxiaotuRecord([...document.querySelectorAll('#relation-list tr[data-edge]')].find(el=>el.dataset.edge===target.recordId));
  }
  if(target.view==='data'||target.view==='graph') {
    setView('graph');if(state.view!=='graph')return false;
    const mode=target.view==='data'?'list':'graph';
    $('[data-mode="'+mode+'"]').click();
    return state.view==='graph'&&state.mode===mode && (target.guide ? revealPage() : true);
  }
  if(!['overview','ontology','conversation','knowledge','graph','models','warehouses','tasks'].includes(target.view))return false;
  setView(target.view,false,target.view==='ontology'?'published':undefined);
  return state.view===target.view && (!target.guide || revealPage());
}
document.addEventListener('click',event=>{
  const button=event.target.closest('[data-starxiaotu-context],[data-starxiaotu-term]');
  if (!button) return;
  event.preventDefault();
  if (button.dataset.starxiaotuTerm) {
    explainStarxiaotuTerm(button.dataset.starxiaotuTerm,button);
  } else {
    const view=button.dataset.starxiaotuContext;
    const termKey={ontology:'ontology',conversation:'library',knowledge:'entity',data:'relation'}[view];
    if (bridge?.openGuide) bridge.openGuide(termKey || view);
    else if (termKey) explainStarxiaotuTerm(termKey,button);
    else starxiaotu.explain(view);
  }
});
const explorer = createGraphExploration({state,pick:$,esc,call,readReply:readWorkbenchReply,
  present:graphLayout,motion:graphMotion,redraw:() => {renderFilters();renderGraph();},
  selectEdge,notice:error => toast(errorText(error)),typeDisplay});
let managementStatsRequest = 0;
let toastTimer,
  refreshAt = 0;
function errorText(error) {
  return (
    messages[error.code || error.message] ||
    error.publicMessage ||
    "操作未完成，请检查任务状态或稍后重试。"
  );
}
function toast(message) {
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("#toast").hidden = true), 4500);
}
function banner(message) {
  $("#connection-notice").innerHTML = message
    ? `<span>${esc(message)}</span>${
        !state.invalid
          ? '<button class="text-link" data-action="reconnect">重新读取</button>'
          : ""
      }`
    : "";
  $("#connection-notice").hidden = !message;
}
async function call(action, input, warehouseId = state.warehouseId) {
  const systemModel = warehouseId === null && ["processing", "model-catalog", "check-models", "save-models", "sync-models", "starxiaotu-models", "save-starxiaotu-model"].includes(action);
  const changesSensitiveSettings = action === 'workbench-request' && input?.method === 'POST' &&
    /^\/api\/(?:sensitive\/(?:settings|preview)|jobs\/[A-Za-z0-9_-]{1,128}\/retry)(?:\?|$)/.test(input.url);
  if (
    state.preview &&
    (changesSensitiveSettings || [
      "import-skill", "delete-skill", "download-skill",
      "check-models", "save-models", "sync-models", "reprocess-models", "starxiaotu-answer", "assistant-intent", "starxiaotu-models", "save-starxiaotu-model",
      "select-space-files",
      "upload",
      "download",
      "save-sensitive",
      "correct",
      "retry-job",
      "create-warehouse",
      "create-key",
      "revoke-key",
      "prepare-clear",
      "clear-warehouse",
      "prepare-delete",
      "delete-warehouse",
    ].includes(action))
  )
    throw Object.assign(new Error("READ_ONLY_PREVIEW"), {
      publicMessage: "这是实际数据的只读效果预览，请从万象打开星图进行操作。",
    });
  if (state.invalid)
    throw Object.assign(new Error("HOST_SESSION_EXPIRED"), {
      code: "HOST_SESSION_EXPIRED",
    });
  if (!bridge)
    throw Object.assign(new Error("WANX_HOST_REQUIRED"), {
      code: "WANX_HOST_REQUIRED",
    });
  const generation = state.generation;
  const identity = state.identity;
  const reply = await bridge.call(action, {
    ...input,
    warehouseId,
  });
  const envelope = ['create-warehouse','reprocess-models'].includes(action);
  if (envelope && !reply?.ok) throw Object.assign(new Error(reply?.message || '请求结果尚未确认'), {
    code: reply?.code, status: reply?.status, publicMessage: reply?.message,
  });
  const result = envelope ? reply.value : reply;
  if (state.invalid || systemModel && identity !== state.identity)
    throw Object.assign(new Error("HOST_SESSION_EXPIRED"), {
      code: "HOST_SESSION_EXPIRED",
    });
  if (!systemModel && generation !== state.generation)
    throw Object.assign(new Error("WAREHOUSE_CHANGED"), {
      code: "WAREHOUSE_CHANGED",
    });
  return result;
}
function canCreateWarehouse() {
  return state.ready && !state.invalid && !state.preview && !state.uploading && !state.spaceSelecting && state.identity?.dataScope === 'personal';
}
function needsNewFileSelection(file) {
  return [
    "SPACE_REMOTE_FILE_CHANGED", "SPACE_NOT_FOUND", "SPACE_ENTRY_NOT_FOUND", "SEMANTICA_FILE_SELECTION_EXPIRED",
    "SEMANTICA_FILE_CONTENT_MISMATCH", "SEMANTICA_FILE_ENCRYPTED",
  ].includes(file.error?.code);
}
function canUploadFile(file) {
  return !file.done && !needsNewFileSelection(file);
}
function syncControls() {
  syncStarxiaotu();
  const creationEnabled = canCreateWarehouse() && !onboarding.visible;
  const directoryEnabled = state.ready && !state.invalid && !onboarding.busy;
  $('#starlink-directory-entry').disabled = !directoryEnabled;
  bridge?.setDirectoryEnabled?.(directoryEnabled);
  $('#page-tasks').hidden = state.view !== 'conversation' || !state.warehouseId;
  $('#page-return-library').hidden = state.view !== 'tasks';
  const batchImport = $('#page-batch-import');
  batchImport.hidden = state.view !== 'conversation' || basicMaterialWarehouse === state.warehouseId;
  $('#starlink-sidebar-project').disabled = !directoryEnabled || state.uploading || state.spaceSelecting;
  batchImport.disabled = batchImport.hidden || importBlocked();
  batchImport.textContent = state.importFiles.standard.some(file => !file.done) ? "继续批量导入" : "批量导入";
  document.querySelectorAll('[data-action="new-warehouse"]').forEach(button => {
    button.disabled = !creationEnabled;
  });
  document
    .querySelectorAll('[data-action="import"]')
    .forEach(
      (b) => (b.disabled = importBlocked()),
    );
  $('#starlink-sidebar-import').disabled = !directoryEnabled || importBlocked();
  $("#confirm-import").disabled =
    !state.ready || state.uploading || state.spaceSelecting ||
    (state.importContext === "conversation" ? state.files.length !== 1 || state.files[0].done : !state.files.some(canUploadFile));
  $("#space-search-descendants").disabled = !state.ready || state.uploading || state.spaceSelecting ||
    state.spaceLoading || !$("#space-query").value.trim();
  $("#space-select-visible").disabled = !state.ready || state.uploading || state.spaceSelecting || state.spaceLoading;
  $("#space-load-more").disabled = $("#space-select-visible").disabled;
  $("#import-model-config").disabled = state.uploading || state.spaceSelecting;
  $("#import-link-existing").disabled = !state.ready || state.uploading || state.spaceSelecting || state.files.length > 0;
  document.querySelectorAll("#space-refresh,#space-query,#space-entries input,#space-entries button,#space-breadcrumbs button,[data-remove-file]").forEach(el => {
    el.disabled = !state.ready || state.uploading || state.spaceSelecting || el.dataset.unsupported === "true" ||
      (state.spaceLoading && el.matches('[data-space-file]')) ||
      (state.importContext === "conversation" && el.matches('[data-space-file]') && state.files.length > 0 && !el.checked);
  });
  document
    .querySelectorAll("#import-dialog [data-close]")
    .forEach((b) => (b.disabled = state.uploading || state.spaceSelecting));
  document
    .querySelectorAll("[data-setting]")
    .forEach(
      (b) => (b.disabled = !state.ready || !state.policy || state.saving),
    );
}
function importBlocked() {
  return !!(!state.ready || !state.warehouseId || currentWarehouse()?.state !== 'active' ||
    state.importOpening || state.uploading || state.spaceSelecting ||
    state.view === 'conversation' && basicMaterialWarehouse !== state.warehouseId && (!conversationFlow?.state.loaded || conversationFlow.state.busy ||
      conversationFlow.saved.pending || conversationFlow.saved.upload || conversationFlow.saved.intakeSubmission ||
      conversationFlow.saved.roundOpening || conversationFlow.importer?.sourceEdit));
}
function connection(ready) {
  state.ready = ready;
  $("#connection-label").textContent = ready
    ? "已连接盒子"
    : state.invalid
    ? "连接已失效"
    : "等待连接";
  $("#connection-title").textContent = state.preview ? "只读预览"
    : ready ? "已连接盒子" : state.invalid ? "连接已失效" : "等待盒子连接";
  $("#connection-dot").style.background = ready ? "var(--sage)" : "var(--ochre)";
  syncControls();
}
function invalidate() {
  if (state.invalid) return;
  state.invalid = true;
  starxiaotu?.invalidate();
  state.saving = state.sourceLoading = false;
  stopConversation();
  onboarding.reset();
  state.generation++;
  skillsUi.reset();
  if (bridge) void bridge.call("select-warehouse", {}).catch(()=>{});
  state.warehouses = [];
  $("#warehouse-query").value = "";
  $("#warehouse-picker-query").value = "";
  state.warehouseId = null;
  state.importFailure = null;
  renderConversation();
  state.runtime = null;
  state.processing = null; state.externalEmbedding = false; state.modelConfig = null; state.modelCatalog = []; state.modelRequest = (state.modelRequest || 0) + 1;
  state.modelSync = null;
  state.documents = [];
  state.jobs = [];
  state.graph = { nodes: [], edges: [] };
  state.graphPresentation = createGraphPresentation();
  state.graphOntology = null;
  explorer.reset();
  state.jobTotal = 0;
  state.jobOffset = 0;
  resetImportDrafts();
  state.spaceRequest++;
  state.space = { parent: "", breadcrumbs: [], items: [] };
  state.spaceResults = null;
  state.spaceLoading = false;
  state.spaceError = null;
  state.source = null;
  state.selectedNode = state.selectedEdge = null;
  state.policy = null;
  state.identity = null;
  document.querySelectorAll("dialog[open]").forEach((d) => d.close());
  $("#source-body").replaceChildren();
  $("#source-actions").replaceChildren();
  $("#user-avatar").textContent = "我";
  connection(false);
  renderTasks();
  renderGraph();
  renderPending();
  renderWarehouses();
  banner(messages.HOST_SESSION_EXPIRED);
}
function bytes(value) {
  const n = Number(value);
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KiB";
  if (n < 1073741824) return (n / 1048576).toFixed(1) + " MiB";
  return (n / 1073741824).toFixed(1) + " GiB";
}
const date = (value) => {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isFinite(d.getTime())
    ? new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(d)
    : "—";
};
function locator(value) {
  let v = value || {};
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return "来源片段";
    }
  }
  if (!v || typeof v !== "object") return "来源片段";
  const refs = Array.isArray(v.source_segments) ? v.source_segments : [];
  const first = refs[0]?.locator || v;
  const last = refs.at(-1)?.locator || first;
  const sheet = first.sheet || first.sheet_name;
  const slide = first.slide;
  const row = first.row;
  if (sheet || slide != null || row != null) {
    const sameRegion = sheet === (last.sheet || last.sheet_name) && slide === last.slide;
    const range = sameRegion && last.row > row ? row + "–" + last.row : row;
    return [sheet ? "工作表 " + sheet : "", slide != null ? "第 " + slide + " 张幻灯片" : "",
      row != null ? "第 " + range + " 行" : ""].filter(Boolean).join(" · ");
  }
  if (v.page != null || v.page_number != null)
    return (
      "第 " +
      (v.page ?? v.page_number) +
      " 页" +
      (v.paragraph ? " · 第 " + v.paragraph + " 段" : "")
    );
  if (v.start_seconds != null || v.start != null) {
    const fmt = (n) =>
      Math.floor(Number(n) / 60)
        .toString()
        .padStart(2, "0") +
      ":" +
      Math.floor(Number(n) % 60)
        .toString()
        .padStart(2, "0");
    return (
      fmt(v.start_seconds ?? v.start) +
      " – " +
      fmt(v.end_seconds ?? v.end ?? v.start_seconds ?? v.start)
    );
  }
  if (v.line_start)
    return (
      "第 " +
      v.line_start +
      " 行" +
      (v.line_end && v.line_end !== v.line_start
        ? " – " + v.line_end + " 行"
        : "")
    );
  if (v.paragraph || v.paragraph_index != null)
    return "第 " + (v.paragraph || Number(v.paragraph_index) + 1) + " 段";
  if (v.paragraph_start != null)
    return "第 " + (v.paragraph_start + 1) + (v.paragraph_end > v.paragraph_start ? "–" + (v.paragraph_end + 1) : "") + " 段";
  return "来源片段";
}
function highlight(value, names) {
  let text = String(value || ""),
    parts = [{ text, hit: false }];
  for (const name of [...new Set(names.filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  )) {
    const next = [];
    for (const p of parts) {
      if (p.hit) {
        next.push(p);
        continue;
      }
      const chunks = p.text.split(name);
      chunks.forEach((chunk, i) => {
        if (i) next.push({ text: name, hit: true });
        if (chunk) next.push({ text: chunk, hit: false });
      });
    }
    parts = next;
  }
  return parts
    .map((p) => (p.hit ? "<mark>" + esc(p.text) + "</mark>" : esc(p.text)))
    .join("");
}
const node = (id) => state.graph.nodes.find((n) => n.id === id),
  edge = (id) => state.graph.edges.find((e) => e.id === id),
  doc = (id) => state.documents.find((d) => d.id === id);
function graphLayout(raw) {
  return presentGraph(raw, state.graphPresentation);
}
let graphViewCache;
function visibleGraph() {
  const retain = explorer.keepsOverview;
  const expanded = explorer.expanded(state.selectedNode);
  const options = {query: state.selectedNode && (!retain || expanded) ? "" : $("#graph-query").value,
    type: expanded ? "all" : state.type, overview: !expanded && state.graphOverview,
    focus: retain ? null : state.selectedNode, showIsolated: expanded || state.showIsolated};
  const key = JSON.stringify(options);
  if (graphViewCache?.graph !== state.graph || graphViewCache?.key !== key)
    graphViewCache = {graph:state.graph, key, value:layoutGraph(selectGraph(state.graph, options))};
  return graphViewCache.value;
}
function renderFilters() {
  const ts = [...new Set(state.graph.nodes.map((n) => n.type))];
  const filters = $("#graph-filters");
  const enhanced = explorer.enabled();
  const exact = $("#graph-exact-type");
  exact.hidden = !enhanced;
  $("#graph-types-label").innerHTML = (enhanced ? '本体标签' : '实体类型') + starxiaotuTermMarker(enhanced ? 'ontology-label' : 'entity-type');
  explorer.menu();
  if (enhanced) {
    const all = [...new Set([...explorer.types().map(type => type.name),...ts])];
    const select = $("#graph-exact-type-select");
    const options = '<option value="all">全部类型</option>' + all.map(type =>
      `<option value="${esc(type)}">${esc(typeDisplay(type).label)}</option>`).join('');
    if (select.innerHTML !== options) select.innerHTML = options;
    select.value = state.type;
    const current = filters.contains(document.activeElement) ? document.activeElement.dataset.value : null;
    const scroll = filters.scrollLeft;
    filters.innerHTML = ['all',...all].map(type => {
      const label = typeDisplay(type), active = (explorer.type || 'all') === type;
      return `<button type="button" class="filter-chip ${active ? 'active' : ''}" aria-pressed="${active}" data-explore="type" data-value="${esc(type)}">${type === 'all' ? '全部' :
        `<span class="type-dot" style="--type-color:${label.color}"></span>${esc(label.label)}`}</button>`;
    }).join('');
    filters.scrollLeft = scroll;
    if (current) [...filters.querySelectorAll('button')].find(item => item.dataset.value === current)?.focus({preventScroll:true});
    return;
  }
  const activeType = filters.contains(document.activeElement) ? document.activeElement.dataset.type : null;
  const scroll = filters.scrollLeft;
  filters.innerHTML =
    `<button type="button" aria-pressed="${state.type === "all"}" class="filter-chip ${
      state.type === "all" ? "active" : ""
    }" data-type="all">全部</button>` +
    ts
      .map(
        (t) =>
          `<button type="button" aria-pressed="${state.type === t}" class="filter-chip ${
            state.type === t ? "active" : ""
          }" data-type="${esc(t)}" title="${esc(t)}"><span class="type-dot" style="--type-color:${
            typeDisplay(t).color
          }"></span>${esc(typeDisplay(t).label)}</button>`,
      )
      .join("");
  filters.scrollLeft = scroll;
  if (activeType) {
    const buttons = [...filters.querySelectorAll("button")];
    (buttons.find(button => button.dataset.type === activeType) || buttons[0])?.focus({ preventScroll: true });
  }
}
function transformScene() {
  if (!panelVisible || state.view !== 'graph' || state.mode !== 'graph') { graphMotion.reset(); return; }
  const graph = visibleGraph();
  const counts = new Map(graph.nodes.map(n => [n.id, {relations:n.degree}]));
  graphMotion.schedule(graph, JSON.stringify([state.generation, state.warehouseId]), {
    counts, metric:'relations', max:Math.max(1, ...graph.nodes.map(n => n.degree)),
    autoRotate: graphAutoRotate && !state.selectedNode && (!state.selectedEdge || state.detailsDismissed), spatial: true,
    expansion:explorer.revision, parents:explorer.parents, afterMount:explorer.applyCamera,
  });
}
function fact(e) {
  return `${esc(node(e.s)?.name)}<span class="fact-relation">→ ${esc(
    e.label,
  )} →</span>${esc(node(e.t)?.name)}`;
}
function renderGraph() {
  let g = visibleGraph();
  if (state.selectedNode && !g.nodes.some((n) => n.id === state.selectedNode)) {
    state.selectedNode = null;
    state.selectedEdge = null;
    g = visibleGraph();
  }
  if (state.selectedEdge && !g.edges.some((e) => e.id === state.selectedEdge))
    state.selectedEdge = null;
  const warehouse = currentWarehouse();
  $("#graph-empty").hidden = g.nodes.length > 0;
  const query = $("#graph-query").value.trim();
  const filterCount = Number(state.showIsolated) + Number(!state.graphOverview);
  const filterBadge = $("#graph-filter-count");
  filterBadge.hidden = filterCount === 0;
  filterBadge.textContent = filterCount;
  renderGraphEmpty(query, warehouse);
  const emptyAction = $("#graph-empty-action");
  emptyAction.disabled = emptyAction.dataset.action === "new-warehouse" && !canCreateWarehouse();
  renderGraphSuggestions(state.selectedNode ? "" : query, g.nodes);
  $("#graph-auto-rotate").disabled = g.nodes.length < 2;
  $("#nodes-total").textContent = g.nodes.length;
  $("#graph-show-isolated").checked = state.showIsolated;
  $("#source-count").textContent = new Set(
    g.edges.flatMap((e) => e.evidence.map((v) => v.document_id)),
  ).size;
  $("#view-graph").classList.toggle("has-knowledge", state.graph.nodes.length > 0);
  $("#graph-scope-summary").textContent = state.selectedNode
    ? `${node(state.selectedNode)?.name} · 直接关联`
    : $("#graph-query").value.trim() ? "搜索结果与直接关联" : state.graphOverview ? "知识概览" : "全部实体";
  $("#graph-focus").hidden = !state.selectedNode;
  const focusBack = $("#graph-focus-back");
  focusBack.hidden = !state.selectedNode;
  focusBack.textContent = query ? "返回搜索结果" : state.type === "all" ? "返回全图" : "返回筛选结果";
  $("#graph-reference-note").hidden = !g.referenceCount || !state.graphOverview || Boolean($("#graph-query").value.trim());
  $("#graph-reference-count").textContent = g.referenceCount;
  document.querySelectorAll("[data-graph-density]").forEach(b => {
    const active = (b.dataset.graphDensity === "overview") === state.graphOverview;
    b.classList.toggle("active", active);
    b.setAttribute("aria-pressed", String(active));
  });
  const positions = new Map(g.nodes.map(n => [n.id,n]));
  const look = explorer.enabled() ? explorer.appearance(g) : null;
  const relations = g.edges.filter(edge => !look?.omitted.has(edge.id));
  const connections = graphConnections(relations);
  $("#edges-total").textContent = state.mode === "graph" ? connections.length : relations.length;
  $("#edges-unit").textContent = state.mode === "graph" ? "条连线" : "条关系";
  $("#graph-scene").innerHTML = '<g class="graph-space-floor" aria-hidden="true"></g><g class="graph-space-links">' + connections.map(e => {
    const a = positions.get(e.s), b = positions.get(e.t);
    const path = edgeGeometry(a,b);
    const relationIds = e.relations.map(relation => relation.id);
    const chosen = relationIds.includes(state.selectedEdge);
    const connected = state.selectedNode && (e.s === state.selectedNode || e.t === state.selectedNode);
    const appearance = look ? [...new Set(relationIds.map(id => look.edgeClasses.get(id))),
      look.highlight && !relationIds.some(id => look.markedEdges.has(id)) && !chosen && 'explore-muted'].filter(Boolean).join(' ') : '';
    const title = e.relations
      .map(relation => `${node(relation.s)?.name} → ${relation.label} → ${node(relation.t)?.name}`).join("\n");
    const labels = [...new Set(e.relations.map(relation => relation.label))];
    const label = labels.length > 2 ? `${labels.length} 种关系` : labels.join(" / ");
    const marker = chosen ? "arrow-selected" : "arrow";
    const startMarker = e.bidirectional ? ` marker-start="url(#${marker})"` : "";
    return `<g class="graph-link ${connected ? "connected" : ""} ${chosen ? "chosen" : ""} ${appearance}"><title>${esc(title)}</title><path class="graph-edge-hit" d="${path.d}" data-edge="${esc(e.id)}"/><path class="graph-edge ${chosen ? "selected" : ""}" d="${path.d}" data-edge="${esc(e.id)}" marker-end="url(#${marker})"${startMarker}/><text class="graph-edge-label" transform="translate(${path.x} ${path.y}) rotate(${path.angle})" text-anchor="middle" y="-7">${esc(label)}</text>${relationIds.some(id => look?.queued.has(id)) ? '<text class="explore-flag" aria-hidden="true">⚑</text>' : ''}</g>`;
  }).join("") + '</g><g class="graph-space-nodes">' + g.nodes.map(n => {
    const selected = n.id === state.selectedNode;
    const match = $("#graph-query").value.trim() && n.name.toLocaleLowerCase().includes($("#graph-query").value.trim().toLocaleLowerCase());
    const display = typeDisplay(n.type);
    const appearance = look ? [look.nodeClasses.get(n.id),look.highlight && !look.markedNodes.has(n.id) && !selected && 'explore-muted',
      look.omittedNodes.has(n.id) && 'explore-omitted'].filter(Boolean).join(' ') : '';
    const shownType = look && (selected || look.markedNodes.has(n.id)) ? `<tspan x="0" dy="14" class="explore-node-type">${esc(display.label)}</tspan>` : '';
    return `<g class="graph-node ${selected ? "selected" : ""} ${match ? "search-match" : ""} ${appearance}" data-node="${esc(n.id)}" transform="translate(${n.x} ${n.y})" style="--type-color:${display.color}" role="button" tabindex="0" aria-label="${esc(n.name)}，${esc(display.label)}，点击聚焦关联"><title>${esc(n.name)} · ${esc(display.label)} (${esc(n.type)})</title><circle class="node-star-hit" r="${n.r+8}"/><circle class="core node-star" r="${n.r}"/>${look && explorer.boundary(n,n.degree) ? '<circle class="explore-boundary"/>' : ''}<text class="node-name" y="${n.r+20}">${n.lines.map((line,i) => `<tspan x="0" dy="${i ? 15 : 0}">${esc(line)}</tspan>`).join("")}${shownType}</text></g>`;
  }).join("") + '</g>' + (look?.pair ? `<path class="explore-duplicate-line" data-explore-from="${esc(look.pair.a.id)}" data-explore-to="${esc(look.pair.b.id)}"/>` : '');
  transformScene();
  $(
    "#relation-list",
  ).innerHTML = `<h2 class="sx-data-heading">数据列表${starxiaotuMarker('data')}</h2><table class="relation-table"><thead><tr><th>主体</th><th>关系${starxiaotuTermMarker('relation')}</th><th>客体</th><th>来源证据${starxiaotuTermMarker('evidence')}</th></tr></thead><tbody>${relations
    .map(
      (e) =>
        `<tr data-edge="${esc(
          e.id,
        )}" tabindex="0" role="button" aria-label="${esc(
          node(e.s)?.name + e.label + node(e.t)?.name,
        )}" class="${e.id === state.selectedEdge ? "selected" : ""}"><td>${esc(
          node(e.s)?.name,
        )}</td><td>${esc(e.label)} →</td><td>${esc(node(e.t)?.name)}</td><td>${
          e.evidence.length
        } 个片段</td></tr>`,
    )
    .join("")}</tbody></table>${
    !relations.length ? '<div class="empty">当前没有可显示的关系</div>' : ""
  }`;
  renderDetails(g);
  const tools = $("#graph-explore-details");
  const markup = look ? explorer.layer(g,look) : '';
  if (tools.renderedMarkup !== markup) {
    tools.innerHTML = markup;
    tools.renderedMarkup = markup;
  }
  tools.hidden = !markup;
  if (markup) {
    $(".graph-inspector").hidden = false;
    if (!state.selectedNode && !state.selectedEdge) $("#graph-inspector-trail").textContent = '星图探索';
  }
}
function renderGraphEmpty(query, warehouse) {
  let title = "正在连接星图", message = "连接盒子后会显示当前账号的星图。", actionName = "", label = "";
  if (state.graphError) {
    title = "暂时无法加载星图"; message = errorText(state.graphError);
    actionName = "refresh"; label = "重试";
  } else if (state.graph.nodes.length) {
    title = query ? "没有找到相关实体" : "没有找到匹配的实体";
    message = query ? "试试更短的名称，或者清除筛选重试。" : "可调整实体类型，或在筛选中显示孤立节点。";
    actionName = "clear-graph-filters"; label = "清空搜索和筛选";
    if (!query && state.type === "all" && !state.showIsolated) {
      actionName = "show-graph-isolated"; label = "显示孤立节点";
    }
  } else if (state.ready && !state.warehouseId) {
    title = "建立我的星图"; message = "填写名称即可创建，随后可以导入资料。";
    actionName = "new-warehouse"; label = "新建星图";
  } else if (state.ready && (warehouse?.document_count !== 0 || warehouse?.active_jobs)) {
    const count = warehouse?.document_count;
    title = warehouse?.active_jobs ? "正在处理资料" : count > 0 ? "星图尚未生成" : "正在读取星图状态";
    message = (count > 0 ? `已导入 ${count} 份材料。` : "") + "可以在任务中心查看知识提取和入图进度。";
    actionName = "graph-tasks"; label = "查看任务";
  } else if (state.ready) {
    title = "导入资料，点亮星图"; message = "导入第一份资料后，星图会显示整理出的关系。";
    actionName = "import"; label = "导入资料";
  }
  $("#graph-empty-title").textContent = title;
  $("#graph-empty-message").textContent = message;
  const button = $("#graph-empty-action");
  button.hidden = !actionName;
  button.dataset.action = actionName;
  button.textContent = label;
}

function renderGraphSuggestions(query, nodes) {
  const list = $("#graph-suggestions");
  const term = query.toLocaleLowerCase();
  const matching = term ? nodes.filter(n => n.name.toLocaleLowerCase().includes(term))
    .sort((a, b) => Number(b.name.toLocaleLowerCase() === term) - Number(a.name.toLocaleLowerCase() === term))
    .slice(0, 8) : [];
  list.hidden = !matching.length || !$("#graph-query").contains(document.activeElement) && !list.contains(document.activeElement);
  list.innerHTML = matching.map(n => `<button type="button" data-node="${esc(n.id)}"><span>${esc(n.name)}</span><small>${esc(typeDisplay(n.type).label)}</small></button>`).join("");
}

function renderDetails(g) {
  const n = node(state.selectedNode),
    e = edge(state.selectedEdge),
    related = g.edges.filter((v) => !n || v.s === n.id || v.t === n.id);
  const inspector = $(".graph-inspector");
  inspector.hidden = !(n || e) || state.detailsDismissed;
  if (inspector.hidden) {
    const details = $("#graph-details");
    details.replaceChildren();
    details.renderedMarkup = undefined;
    return;
  }
  $("#graph-inspector-trail").innerHTML = `<button type="button" class="text-link" data-action="leave-graph-focus">${$("#graph-focus-back").textContent}</button>
    <span aria-hidden="true">›</span>${e ? `<button type="button" class="text-link" data-action="graph-entity-details">${esc(n?.name || "实体")}</button>
    <span aria-hidden="true">›</span><span>关系来源</span>` : `<span>${esc(n?.name || "相关关系")}</span>`}`;
  const details = $("#graph-details");
  const markup = `<div class="detail-top"><div class="type-line"><span>${
    n ? esc(typeDisplay(n.type).label) : "星图"
  }</span><span>${n ? "实体详情" : "选择实体或关系"}</span></div><h2>${
    n ? esc(n.name) : "从一个节点开始"
  }</h2><p>${
    n
      ? "正在聚焦这个实体的直接关联。点击关系核对来源，或返回全图继续探索。"
      : "材料中的明确陈述形成知识关系，点击图中节点进行探索。"
  }</p>${explorer.nodeControls(n)}</div><div class="detail-section"><div class="section-caption"><span>相关关系</span><span class="muted mono">${
    related.length
  } 条</span></div>${
    related
      .map(
        (r) =>
          `<button class="fact-btn ${
            r.id === state.selectedEdge ? "selected" : ""
          }" data-edge="${esc(r.id)}"><span class="fact-text">${fact(
            r,
          )}<small>${r.evidence.length} 个来源片段</small></span>${icon(
            "chevron",
          )}</button>`,
      )
      .join("") ||
    '<p class="detail-empty">导入材料并完成知识处理后，显示相关关系。</p>'
  }</div>${explorer.edgeControls(e)}<div class="detail-section"><div class="section-caption"><span>关系来源</span><span class="muted">${
    e ? e.evidence.length + " 个片段" : "尚未选择"
  }</span></div>${
    e
      ? e.evidence
          .map(
            (v, i) =>
              `<div class="source-card"><div class="source-title">${icon(
                "file",
              )}${explorer.enabled() ? `<button type="button" class="text-link" data-explore="source" data-value="${esc(v.document_id)}">${esc(doc(v.document_id)?.original_name || '来源材料')}</button>`
                : `<span>${esc(doc(v.document_id)?.original_name || '来源材料')}</span>`}</div><p>${
                v.excerpt
                  ? highlight(v.excerpt, [node(e.s)?.name, node(e.t)?.name])
                  : "来源正在完成保护检测，请稍后刷新。"
              }</p><div class="source-bottom"><span>${esc(
                locator(v.locator_json),
              )}</span><button class="text-link" data-source="${esc(
                v.document_id,
              )}" data-source-version="${esc(
                v.document_version_id || v.version_id || "",
              )}" data-edge-source="${esc(
                e.id,
              )}" data-evidence-index="${i}">查看来源 ${icon(
                "external",
              )}</button></div></div>`,
          )
          .join("") +
        '<p class="detail-note">来源片段用于核对关系，片段数量不代表独立证明次数。</p>'
      : '<p class="detail-empty">点击关系或图中连线，查看来源位置与摘录。</p>'
  }</div>`;
  if (details.renderedMarkup !== markup) {
    details.innerHTML = markup;
    details.renderedMarkup = markup;
  }
}
function selectNode(id) {
  state.detailsDismissed = false;
  state.selectedNode = id;
  state.selectedEdge = null;
  renderGraph();
  fitGraph();
  transformScene();
  [...document.querySelectorAll("#graph-scene [data-node]")].find(el => el.dataset.node === id)?.focus({preventScroll:true});
}
function selectEdge(id) {
  const e = edge(id);
  if (!e) return;
  state.detailsDismissed = false;
  state.selectedEdge = id;
  const changed = ![e.s, e.t].includes(state.selectedNode);
  if (changed) state.selectedNode = e.s;
  renderGraph();
  if (changed) { fitGraph(); transformScene(); }
}
const skillsUi = createSkillsUI({call,state,esc,toast,errorText});
const workbench = createWorkbenchHost({ call, onAssistantTerm: explainStarxiaotuTerm, onOutsideClick(event) { starxiaotu?.dismiss(); dismissGuideOnBackground(event); }, warehouse: () => state.invalid ? null : state.warehouseId,
  container: () => $("#mw-editor-content")||$("#view-workbench"),
  onView: view => { if (!$('#mw-editor-dialog')&&workbench.has(state.view) && pages[view]) setView(view, true); },
  onImport: openMaterialFromWorkbench,
  onSource: (id, versionId, segment) => showSource(id, null, versionId, {segment}),
  onOntologySection: (section, category = section) => {
    state.ontologySection = section;
    state.ontologyCategory = category;
    if (state.view === "ontology") {
      updateCurrentNavigation();
      updatePageHeading();
    }
  },
});
async function findGuideRecords(query, area) {
  const id=state.warehouseId, generation=state.generation, view=state.view;
  if (!panelVisible || !state.ready || state.invalid || !query) return [];
  if(view==='warehouses'){
    return state.warehouses.filter(w=>w.name?.toLowerCase().includes(query.toLowerCase())).slice(0,8).map(w=>({
      key:w.id,title:w.name,source:'我的项目',open:async()=>{
        if(!panelVisible || state.invalid || state.generation!==generation || state.view!==view ||
          !state.warehouses.some(live=>live.id===w.id) || !workbench.canLeave() || document.querySelector('dialog[open]'))return false;
        await selectWarehouse(w.id,'overview');return state.warehouseId===w.id;
      }
    }));
  }
  if(!id)return [];
  const activeDoc=()=>$('#source-dialog')?.open ? state.source?.document?.id :
    state.view==='conversation' ? conversationFlow?.state.librarySelection?.document?.id : undefined;
  const documentId=area==='material' ? activeDoc() : undefined;
  if (area==='material' && !documentId) return [];
  const stillHere=()=>panelVisible && !state.invalid && generation===state.generation && id===state.warehouseId &&
    view===state.view && (!documentId || activeDoc()===documentId);
  if(area==='summary'){
    const payload=starxiaotuOverview({warehouse:currentWarehouse(),documents:state.documents,graph:state.graph});
    return (payload.results || []).map(item=>({key:item.id,title:item.title,source:'当前项目资料库',excerpt:item.excerpt,
      open:()=>stillHere() && !document.querySelector('dialog[open]') && navigateStarxiaotu(item.target)}));
  }
  if(area==='rules'){
    const payload=readWorkbenchReply(await call('conversation-ontologies',{},id));
    if(!stillHere())return [];
    const versions=payload?.items || [];
    const published=versions.find(x=>x.status==='published');
    return versions.slice(0,8).map(item=>{
      const types=[...(item.schema?.entity_types || []),...(item.schema?.relation_types || [])];
      const ordered=types.slice().sort((a,b)=>Number(query.includes(b.label))-Number(query.includes(a.label)));
      const status=item===published?'生效版本':item.status==='draft'?'草稿':'历史版本';
      const excerpt=ordered.slice(0,6).map(t=>t.label+(t.properties?.length?'：'+t.properties.slice(0,5).map(p=>p.label+(p.required===true?'（必填）':'')).join('、'):'')).join('；');
      return {key:item.id,title:item.name+' · '+status,source:'本体版本列表',excerpt,
        open:()=>stillHere() && workbench.canLeave() && navigateStarxiaotu({view:'ontology',guide:true})};
    });
  }
  let items=[];
  if (area==='material' || area==='project') {
    const result=await call('search',{query,...(documentId && {documentIds:[documentId]})},id);
    if(!stillHere())return [];
    // Use the same output policy as the original model-backed Starlink agent.
    if(result?.sensitive?.enabled===true && !['policy_changed','data_changed'].includes(result.sensitive.status))
      items=(result.items || []).filter(i=>['clean','masked'].includes(i.sensitive_status) && (!documentId || i.document_id===documentId));
  }
  const graph=documentId ? {nodes:[],edges:[]} : state.graph;
  const documents=documentId ? state.documents.filter(d=>d.id===documentId) : state.documents;
  return starxiaotuRecords({graph,documents,resolvedQuery:true},query,{items}).results.slice(0,8).map(item=>({
    key:item.id,title:item.title,exactId:item.exactId,source:item.target.kind==='document'?'项目资料库':'当前星图',excerpt:item.excerpt,
    open:()=>{
      if(!stillHere())return false;
      const dialog=document.querySelector('dialog[open]');
      if(dialog && (dialog.id!=='source-dialog' || state.editing || item.target.documentId!==activeDoc()))return false;
      return navigateStarxiaotu(item.target);
    },
  }));
}
function currentGuideFacts(question = '') {
  if (!panelVisible || !state.ready || state.invalid || !state.hostNavigationReady) return {};
  const view = state.view === 'graph' && state.mode === 'list' ? 'data' : state.view;
  const warehouse = currentWarehouse();
  const facts = {子页面: pages[state.view]?.[0], 当前项目: warehouse?.name};
  if (view==='warehouses') return {子页面:facts.子页面, 可见项目数:state.warehouses.length};
  if (!warehouse) return facts;
  Object.assign(facts, {项目资料数: warehouse.document_count, 项目实体数: warehouse.entity_count, 项目关系数: warehouse.relation_count});
  const rules = state.graphOntology;
  if (rules) {
    const types = rules.schema?.entity_types, relations = rules.schema?.relation_types;
    const label=t=>t.label || t.name;
    const examples=items=>[...(items || [])].sort((a,b)=>Number(question.includes(label(b)))-Number(question.includes(label(a))));
    const labels=new Map((types || []).map(t=>[t.name,label(t)]));
    const ends=keys=>keys?.map(k=>labels.get(k) || k).slice(0,3).join('、');
    const properties=examples(types).filter(t=>t.properties?.length).slice(0,3).map(t=>
      label(t)+'：'+t.properties.slice(0,4).map(p=>label(p)+(p.required===true?'（必填）':p.required===false?'（选填）':'')).join('、'));
    Object.assign(facts, {属性规则示例:properties.join('；'), 生效本体:rules.name, 生效版本:rules.version_number,
      实体类型数:types?.length, 关系类型数:relations?.length,
      实体类型示例:examples(types).slice(0,8).map(label).join('、'),
      关系规则示例:examples(relations).slice(0,4).map(r=>[ends(r.source_types),label(r),ends(r.target_types)].filter(Boolean).join(' → ')).join('、')});
  }
  if (view === 'graph' && state.graphFingerprint && !state.graphError) {
    const graph = visibleGraph();
    const selected = graph.nodes.find(n=>n.id===state.selectedNode);
    const edge = graph.edges.find(e=>e.id===state.selectedEdge);
    Object.assign(facts, {画面可见实体数:graph.nodes.length, 画面可见关系数:graph.edges.length,
      已选实体:selected?.name, 已选实体类型:selected && typeDisplay(selected.type).label,
      已选关系:edge && [node(edge.s)?.name,edge.label,node(edge.t)?.name].filter(Boolean).join(' → '), 图谱视图:state.graphOverview?'概览':'明细'});
  }
  if (view === 'conversation') {
    const doc = conversationFlow?.state.librarySelection?.document || state.source?.document;
    if (doc && !doc.deleted_at && doc.status!=='deleted') Object.assign(facts,{已选资料:doc.original_name || doc.name, 资料状态:doc.status});
  }
  return facts;
}
let panelVisible = true;
bridge?.register?.({
  visible(value) { panelVisible = value; transformScene(); },
  guideContext:()=>({ready:state.hostNavigationReady && state.ready && !state.invalid,project:state.invalid ? null : state.warehouseId,
    name:currentWarehouse()?.name || '', view:state.view,
    path:[!['warehouses','models'].includes(state.view) && currentWarehouse()?.name, pages[state.view]?.[0],
      state.view==='ontology' && (state.ontologyCategory==='drafts' ? '本体修改' : '规则总览'),
      state.view==='ontology' && ontologyHeadings[state.ontologySection]?.[0],
      state.view==='graph' && (state.mode==='list' ? '关系列表' : '3D 视图'),
      document.querySelector('dialog[open] h2')?.textContent?.trim()]}),
  guideRecords:findGuideRecords,
  guideFacts:currentGuideFacts,
  guideNavigate:navigateStarxiaotu,
  canLeave:()=>!document.querySelector('dialog[open]') && !onboarding.busy && conversationFlow?.importer.canLeaveSource()!==false && workbench.canLeave(),
  dismissAssistant: starxiaotu?.dismiss,
  openGraph() {
    if (!state.ready || state.invalid || state.view === 'graph' || document.querySelector('dialog[open]') ||
        !workbench.canLeave()) return;
    setView('graph');
  },
  chooseProject: () => action('choose-warehouse').catch(error => toast(errorText(error))),
  async importMaterial() {
    if (importBlocked() || !workbench.canLeave()) return;
    const generation = state.generation;
    if (state.view !== 'conversation') {
      setView('conversation');
      if (state.view !== 'conversation') return;
      await conversationReady;
    }
    if (generation === state.generation && state.view === 'conversation')
      await action('import').catch(error => toast(errorText(error)));
  },
  openWarehouseDirectory: () => action("all-warehouses").catch(error => toast(errorText(error))),
});
const pages = {
  overview: ["概览", "", "查看当前星图的目标、待处理资料和知识快照。"],
  knowledge: ["数据列表", "", "按实体查看属性、关系和对应原文。"],
  ontology: ["本体", "", "规定从资料里识别哪些对象、记录哪些属性，以及对象之间能建立什么关系。"],
  review: ["知识核对", "REVIEW WITH EVIDENCE", "对照原始材料核对实体与关系，保留修改和发布依据。"],
  releases: ["版本历史", "KNOWLEDGE THROUGH TIME", "查看知识发布记录，对比变化，追溯每个版本的来源。"],
  skills: ["Skill 管理", "METHODS FOR YOUR KNOWLEDGE", "按星图保管推理方法，给其他 AI 应用可靠的分析路径。"],
  models: ["模型设置", "KNOW HOW YOUR KNOWLEDGE IS BUILT", "选择 CentaurAI 模型，查看和调整资料处理模型。"],
  warehouses: ["我的项目", "", "每个项目有独立的资料、本体和星图。"],
  data: [
    "数据管理",
    "YOUR KNOWLEDGE, YOUR CONTROL",
    "保管资料、管理知识，决定它们如何被使用。",
  ],
  graph: [
    "星图",
    "A MAP OF WHAT YOU KNOW",
    "查看当前星图中的实体和关系，沿关系回到原文。",
  ],
  conversation: ['资料库','IMPORT MATERIALS','导入资料，查看正文和知识处理进度。'],
  tasks: [
    "处理任务",
    "FROM MATERIALS TO KNOWLEDGE",
    "查看当前星图的处理进度和失败原因。",
  ],
};
const ontologyHeadings = {
  "add-entity": ["添加实体类型", "设置要从材料中识别的实体及其属性。"],
  "add-relation": ["添加关系类型", "指定关系方向、可连接的实体类型及其属性。"],
};
function updatePageHeading() {
  const [title, kicker, description] = pages[state.view];
  const [heading, subtitle] = state.view === "ontology" ? ontologyHeadings[state.ontologySection] ?? [title, description] : [title, description];
  $("#page-title").textContent = $("#crumb-current").textContent = heading;
  $("#page-kicker").textContent = kicker;
  $("#page-description").textContent = subtitle;
  syncStarxiaotu();
}
function updateCurrentNavigation() {
  document.querySelectorAll('.starlink-rail [data-view]').forEach(el => {
    const current = state.view === "tasks" ? el.dataset.view === "conversation"
      : state.view === "ontology" ? el.dataset.view === "ontology" || el.dataset.ontologyAction === state.ontologyCategory
        : el.dataset.view === state.view;
    if (current) el.setAttribute("aria-current", "page");
    else el.removeAttribute("aria-current");
  });
}
function setView(view, fromWorkbench = false, ontologyAction, onboardingHandoff = false, materialDocumentId, materialCitation) {
  // This built-in panel exposes the migrated knowledge workflows only.
  if (['skills', 'api', 'data', 'releases', 'sensitive'].includes(view)) view = 'warehouses';
  if(view==='review'&&!fromWorkbench){if(!state.ready||state.invalid)return;view='conversation';}
  // Skill management is temporarily hidden; keep its implementation for later.
  if (view === "skills" || view === "api") view = "warehouses";
  if (!pages[view]) return;
  if (conversationFlow&&!conversationFlow.importer.canLeaveSource()) {
    toast('请先保存或关闭正文编辑。');
    return;
  }
  if (onboarding.busy && !onboardingHandoff) return;
  const integrated = workbench.has(view);
  if ((integrated || ['overview','knowledge','conversation','tasks'].includes(view)) && !fromWorkbench && !state.warehouseId && state.ready && !state.invalid) {
    setView("warehouses");
    toast("请先选择或新建一张星图，再使用知识管理。");
    return;
  }
  if (state.view === 'sensitive' && view !== 'sensitive' && !fromWorkbench && !integrated) {
    if (!workbench.canLeave()) return;
    workbench.reset();
  }
  if (integrated && !fromWorkbench && !workbench.show(view, ontologyAction)) return;
  const previousView = state.view;
  if (view !== "ontology" && previousView === "ontology") workbench.clearOntologyAction();
  if(view!=='conversation')stopConversation();
  state.view = view;
  $("#app").classList.toggle("graph-workspace", view === "graph");
  $(".graph-filter-menu").open = false;
  document.getElementById('conversation-return')?.remove();
  if(integrated&&state.conversationReturn?.warehouseId===state.warehouseId){
    const bar=document.createElement('div');bar.id='conversation-return';bar.className='cv-editor-return';
    const button=document.createElement('button');button.className='btn btn-secondary';button.textContent='返回材料流程，读取最新进度';
    button.addEventListener('click',()=>{if(workbench.canLeave())setView('conversation');});
    const hint=document.createElement('span');hint.textContent=view==='ontology'?'核对本体：发布后返回重新确认目标与计划；历史材料不会自动重抽。':'核对材料知识：保存草稿不等于发布，发布后返回读取当前生效结果。';
    bar.append(button,hint);$('#view-workbench').prepend(bar);
  }
  document
    .querySelectorAll(".view")
    .forEach((el) => (el.hidden = el.id !== (integrated ? "view-workbench" : "view-" + view)));
  if (view === 'graph') transformScene();
  else graphMotion.reset();
  updateCurrentNavigation();
  updatePageHeading();
  $("#page-secondary").hidden = view !== "graph";
  const directory = view === "warehouses";
  $("#page-primary").hidden = directory ? !!bridge : view !== "conversation";
  $(".page-scroll").classList.toggle("workbench-page", integrated);
  $("#page-primary").dataset.action = directory ? "new-warehouse" : "import";
  $("#page-primary").innerHTML = icon("plus") + (directory ? "新建星图" : "导入资料");
  $("#crumb-current").hidden = view !== "sensitive" && !bridge?.setBannerActions;
  $("#crumb-separator").hidden = view !== "sensitive" || !!bridge?.setBannerActions;
  renderWarehouses();
  renderProcessingSummary();
  syncControls();
  $(".page-scroll").scrollTop = 0;
  setNavigationOpen(false);
  if (view === "data") {
    renderManagement();
    if (previousView !== "data") void refreshManagementStats();
    if (currentWarehouse()?.state === "import_failed") void loadImportFailure(true);
  }
  if (view === "conversation") void loadConversation(materialDocumentId, materialCitation);
  if (view === 'overview') { renderOverview(); void loadOverview(); }
  if (view === 'knowledge') renderKnowledge();
  if (view === "models") { void loadStarxiaotuModel(); void loadModels(); }
  if (view === "skills") void skillsUi.load();
  if (view === "warehouses") void refresh();
}
function focusConversationCard(selector) {
  const item=$('#view-conversation '+selector),panel=item?.closest('.mw-review-content,.conversation-messages');
  if(!panel||!item||!panel.contains(item))return;
  for(let el=item;el&&el!==panel;el=el.parentElement)if(el.tagName==='DETAILS')el.open=true;
  panel.scrollTop+=item.getBoundingClientRect().top-panel.getBoundingClientRect().top-12;
}
function renderConversation() {
  syncControls();
  const conversationRoot=$('#view-conversation');
  const disclosureScope=JSON.stringify([state.generation,state.warehouseId,conversationFlow?.saved.conversationId,conversationFlow?.state.selectedIntent,conversationFlow?.state.importDocumentId]);
  const disclosureState=new Map(conversationRoot.dataset.disclosureScope===disclosureScope
    ? [...conversationRoot.querySelectorAll('[data-cv-disclosure]')].map(el=>[el.dataset.cvDisclosure,el.open]):[]);
  const focus=document.activeElement,focusId=focus?.id?.startsWith('cv-')||focus?.id==='starxiaotu-input'?focus.id:null;
  const selection=focusId&&typeof focus.selectionStart==='number'?[focus.selectionStart,focus.selectionEnd]:null;
  const scroll=$('#view-conversation .conversation-messages')?.scrollTop;
  const contextScroll=$('#view-conversation .conversation-context')?.scrollTop;
  const reviewScroll=$('#view-conversation .mw-review-content')?.scrollTop;
  const listScroll=$('#view-conversation .mw-material-list')?.scrollTop;
  const knowledgeScroll=$('#view-conversation .mw-knowledge-content')?.scrollTop;
  const reading=conversationFlow?.importer.view;
  const sourceMatch=reading?.sourceMatch;
  const readerCitation=reading?.readerCitation && reading.readerCitation.start===reading.textWindow?.start;
  const sourceMatchStamp=readerCitation?JSON.stringify([disclosureScope,reading.textWindow.version_id,reading.textWindow.start])
    :sourceMatch?JSON.stringify([disclosureScope,sourceMatch.id,sourceMatch.request]):'';
  const sourceScroll=$('#view-conversation .cv-source-review')?.scrollTop;
  const proposalStamp=JSON.stringify(conversationFlow?.changes.state.proposals.map(p=>[p.id,p.status])||[]);
  const newProposal=conversationRoot.dataset.proposalStamp!==proposalStamp;
  const materialStamp=JSON.stringify([conversationFlow?.state.librarySelection?.document.id,conversationFlow?.state.selectedIntent,nextConversationStep(conversationFlow)]);
  const newMaterialState=conversationRoot.dataset.materialStamp!==materialStamp;
  const basic = !!basicMaterialWarehouse && basicMaterialWarehouse===state.warehouseId;
  const markup=basic ? basicMaterialLibrary() : materialReaderHTML(currentWarehouse(),
    !state.preview && state.identity?.dataScope==='personal', conversationFlow);
  if(conversationRoot._renderedMarkup===markup&&conversationRoot.dataset.disclosureScope===disclosureScope)return;
  conversationRoot.innerHTML=markup;conversationRoot._renderedMarkup=markup;
  mountMaterialWorkspace(conversationRoot);
  starxiaotu?.sync();
  conversationRoot.querySelectorAll('[data-intake-segment]').forEach(el=>{el.style.height='auto';el.style.height=el.scrollHeight+'px';});
  if(sourceScroll!==undefined&&$('#view-conversation .cv-source-review'))$('#view-conversation .cv-source-review').scrollTop=sourceScroll;
  conversationRoot.dataset.disclosureScope=disclosureScope;
  conversationRoot.querySelectorAll('[data-cv-disclosure]').forEach(el=>{if(disclosureState.has(el.dataset.cvDisclosure))el.open=disclosureState.get(el.dataset.cvDisclosure);});
  if(focusId){const next=document.getElementById(focusId);next?.focus({preventScroll:true});if(selection&&next?.setSelectionRange)next.setSelectionRange(...selection);}
  if(scroll!==undefined&&$('#view-conversation .conversation-messages'))$('#view-conversation .conversation-messages').scrollTop=scroll;
  if(contextScroll!==undefined&&$('#view-conversation .conversation-context'))$('#view-conversation .conversation-context').scrollTop=contextScroll;
  if(reviewScroll!==undefined&&$('#view-conversation .mw-review-content'))$('#view-conversation .mw-review-content').scrollTop=newMaterialState?0:reviewScroll;
  if(listScroll!==undefined&&$('#view-conversation .mw-material-list'))$('#view-conversation .mw-material-list').scrollTop=listScroll;
  if(knowledgeScroll!==undefined&&!newMaterialState&&$('#view-conversation .mw-knowledge-content'))$('#view-conversation .mw-knowledge-content').scrollTop=knowledgeScroll;
  if(!['cv-goal','cv-instructions','cv-message'].includes(focusId)&&!focusId?.startsWith('cv-source-')){
    if(newProposal&&conversationFlow?.changes.state.proposals.length)focusConversationCard('.cv-proposal-current');
    else if(newMaterialState&&conversationFlow?.state.detail){
      focusConversationCard('.cv-conversation-actions');
      focusConversationCard('.mw-confirm-card');
    }
  }
  conversationRoot.dataset.proposalStamp=proposalStamp;
  conversationRoot.dataset.materialStamp=materialStamp;
  if(sourceMatchStamp&&conversationRoot.dataset.readerSourceMatch!==sourceMatchStamp){
    const match=conversationRoot.querySelector('[data-reader-match]');
    match?.focus({preventScroll:true});
    const panel=match?.closest('.mw-review-content');
    if(panel){
      const quote=match.querySelector('mark');
      const rect=(quote||match).getBoundingClientRect();
      const viewport=panel.getBoundingClientRect();
      if(rect.top<viewport.top||rect.bottom>viewport.bottom){
        panel.scrollTop+=rect.top-viewport.top-(quote?(panel.clientHeight-rect.height)/2:12);
      }
    }
  }
  conversationRoot.dataset.readerSourceMatch=sourceMatchStamp;
}
function basicMaterialLibrary() {
  const rows=state.documents.map(item=>`<li><button type="button" class="text-link" data-source="${esc(item.id)}">${esc(item.original_name||item.name)}</button></li>`).join('');
  return `<section class="mw-welcome"><header><strong>资料</strong></header>
    ${rows?`<ul>${rows}</ul>`:'<p class="empty">导入第一份资料，即可开始整理。</p>'}
    <p class="wp-muted">当前盒子支持导入和查看原文。</p></section>`;
}
async function loadConversation(materialDocumentId, materialCitation) {
  stopConversation();
  const request=state.conversationRequest=(state.conversationRequest||0)+1;
  const {identity,generation,warehouseId}=state;
  const isCurrent=()=>state.ready && !state.invalid && state.identity===identity && state.generation===generation &&
    state.warehouseId===warehouseId && state.conversationRequest===request && state.view==='conversation';
  if(!isCurrent() || !warehouseId || currentWarehouse()?.state !== 'active' || state.preview || identity?.dataScope!=='personal'){renderConversation();return;}
  const flow=conversationFlow=new ConversationFlow({warehouseId,identity,readerOnly:true,storage:window.localStorage,isCurrent,
    call:async(action,input)=>{const reply=await call(action,input);return action.startsWith('conversation-')||action==='workbench-request'?readWorkbenchReply(reply):reply;},onChange:()=>renderConversation()});
  flow.state.materialPage='import';
  const readBasicLibrary = async () => {
    try {
      const documents = await call('documents',{limit:100});
      if (isCurrent() && Array.isArray(documents?.items)) {
        state.documents=documents.items;basicMaterialWarehouse=warehouseId;renderConversation();
      }
    } catch (error) { if (isCurrent()) banner(errorText(error)); }
  };
  conversationReady=flow.load().then(async()=>{
    if(flow!==conversationFlow||!isCurrent())return;
    if(!flow.state.loaded){
      if(onboardingUnavailable(flow.state.errorCode))await readBasicLibrary();
      return;
    }
    await flow.materials();
    if(!isCurrent())return;
    if(onboardingUnavailable(flow.state.warehouseMaterialErrorCode)){
      await readBasicLibrary();
      return;
    }
    if(!flow.saved.pending&&!flow.saved.upload&&!flow.saved.intakeSubmission) {
      if (materialDocumentId) {
        await flow.importer.select(materialDocumentId);
        if (flow===conversationFlow && isCurrent() && materialCitation) flow.importer.openCitation(materialCitation);
      } else await flow.importer.first();
    }
    else if(flow.saved.pending?.input.documentId)await flow.run(()=>flow.importer.read(flow.saved.pending.input.documentId));
  });
  const poll=async()=>{
    if(flow!==conversationFlow||!isCurrent())return;
    try{if(!$('#mw-editor-dialog'))await flow.importer.tick();}
    catch{if(flow===conversationFlow&&isCurrent()){flow.state.progressRetryable=true;flow.state.error='暂时未能读取最新进度，正在自动重连；不会重复提交任务。';flow.emit();}}
    finally{if(flow===conversationFlow&&isCurrent())conversationTimer=setTimeout(poll,2000);}
  };
  conversationTimer=setTimeout(poll,2000);
  renderConversation();
}
function openMaterialFromWorkbench(documentId) {
  if ($('#mw-editor-dialog') || !workbench.canLeave()) return;
  setView('conversation', false, undefined, false, documentId);
}
async function openConversationReview(documentId,reviewTarget){
  if(!documentId||!state.ready||$('#mw-editor-dialog')||!workbench.canLeave())return;
  const flow=conversationFlow,warehouseId=state.warehouseId;
  if(!flow||flow.state.busy||flow.saved.pending||flow.saved.roundOpening||flow.changes.record.pending||flow.reviewPending||flow.claimPending||flow.releasePending)return;
  // Keep the workspace and material selection in place. The existing editor
  // remains responsible for validation, leases and unsaved-change protection.
  workbench.reset();
  const dialog=document.createElement('dialog');dialog.id='mw-editor-dialog';dialog.className='mw-editor-dialog';
  dialog.setAttribute('aria-labelledby','mw-editor-title');
  const importing=flow.state.materialPage==='import';
  const suggestions=reviewTarget==='ontology-suggestions';
  const title=suggestions?'核对本体建议':importing?'核对当前材料结果':'修改当前材料与本体';
  const description=suggestions?'核对根据材料原文生成的类型、关系与属性建议。采纳的规则可保存为草稿。':(importing?'核对实体、关系和证据；确认发布前，原有已发布结果保持不变。':'保存后可返回资料库，确认发布后才更新知识。')+'修改本体规则不会自动重抽其他材料。';
  dialog.innerHTML=`<header><div><h2 id="mw-editor-title">${title}</h2><p>${description}</p></div><button class="btn btn-secondary" type="button">${importing?'返回资料管理':'返回资料库'}</button></header><div id="mw-editor-content"></div>`;
  let closing=false;
  async function close(){
    if(closing||!workbench.canLeave())return;closing=true;
    workbench.reset();dialog.close();dialog.remove();
    if(flow!==conversationFlow||warehouseId!==state.warehouseId)return;
    flow.changes.clear();flow.state.inspectCard=null;
    await flow.refresh();
    if(!flow.state.error&&flow.state.materialPage==='import'&&flow.state.importDocumentId===documentId)await flow.importer.refresh();
    if(!importing&&!flow.state.error&&flow.state.detail?.document_id===documentId&&flow.saved.materialContinuations?.[flow.state.selectedIntent]?.editExisting&&!flow.state.detail.review?.draft_id)await flow.changes.openDraft();
  }
  dialog.addEventListener('cancel',event=>{event.preventDefault();void close();});
  dialog.querySelector('button').addEventListener('click',()=>void close());
  document.body.append(dialog);dialog.showModal();
  if(!workbench.openMaterial(documentId,reviewTarget)){dialog.close();dialog.remove();}
}
function bindConversationEvents(){
const filterMaterialList=event=>{
  if(!conversationFlow||event.target.id!=='cv-material-query'||event.isComposing)return;
  const s=conversationFlow.state;if(s.readerQuery===event.target.value)return;
  s.readerQuery=event.target.value;conversationFlow.emit();
};
$('#view-conversation').addEventListener('compositionend',filterMaterialList);
$('#view-conversation').addEventListener('input',event=>{
  if(!conversationFlow)return;const s=conversationFlow.state;
  if(event.target.id==='cv-material-query'){filterMaterialList(event);return;}
  if(event.target.id==='cv-message')s.input=event.target.value;
  if(event.target.dataset.inlineSource!==undefined){
    const importer=conversationFlow.importer;
    importer.changeSource(Number(event.target.dataset.inlineSource),event.target.value);
    const save=$('#view-conversation [data-cv="import-source-save"]');
    if(save&&importer.sourceEdit&&!importer.sourceEdit.write&&!importer.sourceEdit.stale)save.disabled=!importer.sourceEdit.edits.size;
    return;
  }
  if(event.target.dataset.intakeSegment){
    conversationFlow.intake.edit(event.target.dataset.intakeSegment,event.target.value);
    // Preserve the textarea and IME composition while typing.
    $('#view-conversation [data-intake-confirmed]')?.remove();
    const status=$('#view-conversation .cv-material-status strong');if(status)status.textContent='解析完成，待核对正文';
    event.target.style.height='auto';event.target.style.height=event.target.scrollHeight+'px';
    const changed=conversationFlow.intake.hasEdits;
    for(const confirm of document.querySelectorAll('#view-conversation [data-cv="intake-confirm"]'))confirm.textContent=changed?'保存并进入下一步':'确认正文，进入下一步';
    const save=$('#view-conversation [data-cv="intake-save"]');if(save)save.disabled=!changed||conversationFlow.intake.editLocked;
    const automatic=$('#view-conversation [data-cv="material-auto-from-source"]');if(automatic)automatic.textContent=changed?'保存正文并准备自动抽取':'使用当前正文，自动抽取';
    for(const el of document.querySelectorAll('#view-conversation [data-intake-edits],#view-conversation [data-cv="intake-original-goal"]'))el.hidden=!changed;
  }
  if(event.target.id==='cv-message'){
    if(conversationFlow.evidence.syncInput()){
      const reference=$('#view-conversation .cv-evidence-reference');
      reference?.insertAdjacentHTML('afterend',evidenceReferenceHTML(conversationFlow));reference?.remove();
      const notice=$('#view-conversation .cv-input-notice');if(notice)notice.textContent=s.inputNotice;
    }
    conversationFlow.saveMaterialComposer();
  }
  if(event.target.id==='cv-keep-existing'&&s.merge)s.merge.keepExisting=event.target.checked;
  if(event.target.id==='cv-rule-confirmed')conversationFlow.changes.state.ruleConfirmed=event.target.checked;
  if(event.target.id==='cv-publish-confirmed')conversationFlow.changes.state.publishConfirmed=event.target.checked;
  if(event.target.id==='cv-instruction-ack')conversationFlow.changes.state.instructionAcknowledged=event.target.checked;
  if(['cv-rule-confirmed','cv-publish-confirmed','cv-instruction-ack'].includes(event.target.id))conversationFlow.emit();
});
$('#view-conversation').addEventListener('keydown',event=>{
  if(event.target.id==='cv-message'&&event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&event.keyCode!==229){
    event.preventDefault();if(!event.target.value.trim())return;const form=event.target.form;if(form&&!form.querySelector('button[type="submit"]')?.disabled)form.requestSubmit();return;
  }
  const item=event.target.closest('.cv-candidate-network [data-cv="candidate-inspect"]');
  if(item&&['Enter',' '].includes(event.key)){event.preventDefault();item.dispatchEvent(new MouseEvent('click',{bubbles:true}));}
});
$('#view-conversation').addEventListener('change',event=>{
  if(event.target.id==='cv-material-sort'&&conversationFlow){conversationFlow.state.readerSort=event.target.value;conversationFlow.emit();}
  if(event.target.id==='cv-candidate-focus'&&conversationFlow){const g=currentCandidateGraph(conversationFlow);if(g){g.focus=event.target.value;g.selected=null;g.zoom=1;conversationFlow.emit();}}
  if(event.target.id==='cv-session'&&event.target.value)void conversationFlow?.select(event.target.value);
  if(event.target.id==='cv-message-mode'&&conversationFlow)conversationFlow.state.messageMode=event.target.value;
  if(event.target.id==='cv-source-page-size'&&conversationFlow)conversationFlow.intake.changePageSize(Number(event.target.value));
  if(event.target.dataset.cvItem)conversationFlow?.changes.select(event.target.dataset.cvItem,event.target.checked);
  if(event.target.dataset.cvIssue)conversationFlow?.changes.selectIssue(event.target.dataset.cvIssue,event.target.checked);
});
$('#view-conversation').addEventListener('submit',event=>{
  if(!conversationFlow)return;event.preventDefault();
  if(event.target.id==='cv-fact-filter')conversationFlow.changes.filterFacts($('#cv-fact-keyword').value,$('#cv-fact-type').value);
  if(event.target.id==='cv-goal-form'){
    const f=conversationFlow;
    void f.goal().then(()=>{if(f===conversationFlow&&!f.state.error&&f.state.detail?.status==='ready_for_confirmation')focusConversationCard('#cv-inline-rules');});
  }
});
$('#view-conversation').addEventListener('click',event=>{
  const el=event.target.closest('[data-cv]'),f=conversationFlow;if(!el||!f||el.disabled)return;
  const commandName=el.dataset.cv,offset=f.state.candidates?.offset||0,mergeOffset=f.state.merge?.plan.offset||0;
  if(['candidate-inspect','candidate-zoom-in','candidate-zoom-out','candidate-zoom-reset'].includes(commandName)){
    const g=currentCandidateGraph(f);if(!g)return;
    if(commandName==='candidate-inspect'){
      if(!/^\d+$/.test(el.dataset.id||'')||!g.items[Number(el.dataset.id)])return;
      g.selected=el.dataset.id;
    }else g.zoom=commandName==='candidate-zoom-reset'?1:Math.max(1,Math.min(3,g.zoom+(commandName==='candidate-zoom-in' ? .25 : -.25)));
    f.emit();if(commandName==='candidate-inspect')focusConversationCard('.cv-network-detail');return;
  }
  const commands={refresh:()=>f.refresh(),more:()=>f.more(),upload:()=>openMaterialUpload(f),
    'reply-suggestion':()=>{const text=materialReplySuggestions(f)[Number(el.dataset.id)];if(!text)return;f.state.input=f.state.input.trim()?f.state.input+'\n'+text:text;f.saveMaterialComposer();f.emit();$('#cv-message')?.focus();},
    'material-source':()=>f.agent.reviewSource(),'material-auto':()=>f.agent.prepareAutomatic(),'material-auto-confirm':()=>f.agent.confirmAutomatic({previewId:el.dataset.previewId,replacementAcknowledgement:el.dataset.replacementAcknowledgement}),
    'material-auto-cancel':()=>f.agent.cancelPreview(),
    'auto-results-prev':()=>{f.state.automaticResultPage=Math.max(0,(f.state.automaticResultPage||0)-1);f.emit();},'auto-results-next':()=>{f.state.automaticResultPage=(f.state.automaticResultPage||0)+1;f.emit();},
    'intake-save':()=>f.intake.confirm(false),
    'library-review':()=>f.state.librarySelection?.document.workflow?.draft&&openConversationReview(f.state.librarySelection.document.id),
    'instruction-read':()=>f.instructions.refresh(),'instruction-prepare':()=>f.instructions.prepare(),
    'evidence-open':()=>f.evidence.open(),'evidence-close':()=>f.evidence.close(),'evidence-clear':()=>f.evidence.clear(),
    'evidence-read':()=>f.evidence.read(Number(el.dataset.index)),
    'evidence-window-prev':()=>f.evidence.window('prev'),'evidence-window-next':()=>f.evidence.window('next'),
    'evidence-prev':()=>f.evidence.page(Math.max(0,(f.evidence.state?.page.offset||0)-10)),
    'evidence-next':()=>f.evidence.page((f.evidence.state?.page.offset||0)+10),
    'evidence-quote':()=>{const text=$('#cv-evidence-text');if(text)f.evidence.quote(text.selectionStart,text.selectionEnd);$('#cv-message')?.focus();},
    'evidence-classification':()=>{if(!f.evidence.replaceInput('我只想调整选中条目的分类，请先建议合适的分类供我确认；保留名称和原文引用，材料未提供的属性保持空缺。'))return;f.state.messageMode='auto';f.saveMaterialComposer();f.emit();$('#cv-message')?.focus();},
    'instruction-confirm':()=>f.instructions.confirm(),'instruction-abandon':()=>f.instructions.abandon(),
    'instruction-example':()=>{if(!f.evidence.replaceInput(el.dataset.text))return;f.state.messageMode='auto';f.saveMaterialComposer();f.emit();$('#cv-message')?.focus();},
    'change-exclusion-apply':()=>f.changes.applyExclusion(),'change-exclusion-cancel':()=>f.changes.cancelExclusion(),
    'change-issues-suggest':()=>f.changes.adjustIssues({suggest:true,all:!f.changes.state.issueSelection?.length}),
    'library-select':()=>f.state.materialPage?f.importer.select(el.dataset.id):selectWarehouseMaterial(f,el.dataset.id),'library-more':()=>f.run(()=>readWarehouseMaterials(f,true)),
    'import-refresh':()=>f.importer.refresh(),
    'import-retry-ontology-suggestions':()=>f.importer.retryOntologySuggestions(),
    'import-ontology-suggestions':()=>f.importer.view?.ontologySuggestion?.status==='completed'
      && openConversationReview(f.importer.view.documentId,'ontology-suggestions'),
    'import-confirm':()=>f.importer.confirm(),'import-auto':()=>f.importer.automatic(),'import-review':()=>f.importer.review((id,target)=>f===conversationFlow&&openConversationReview(id,target)),
    'import-knowledge':()=>f.importer.toggleKnowledge(),'import-knowledge-retry':()=>f.importer.readKnowledge(true),
    'import-knowledge-filter':()=>f.importer.filterKnowledge(el.dataset.id),'import-knowledge-more':()=>f.importer.moreKnowledge(),
    'import-source-jump':()=>f.importer.locateEvidence(Number(el.dataset.index)),
    'import-process-source':()=>f.importer.startProcessing(),
    'import-edit-source':()=>{
      const loading=f.importer.editSource();
      if(f.importer.sourceEdit)focusConversationCard('.mw-source-edit');
      return loading;
    },
    'import-source-save':()=>f.importer.saveSource(),
    'import-source-cancel':()=>f.importer.cancelSource(),
    'import-source-prev':()=>f.importer.pageSource(-1),'import-source-next':()=>f.importer.pageSource(1),
    'material-review':()=>f.importer.reviewAutomatic((id,target)=>f===conversationFlow&&openConversationReview(id,target)),
    'import-index-retry':()=>f.importer.retryIndex(),
    'import-close-dialogue':()=>f.importer.exitDialogue(),'import-prev':()=>f.importer.page(-1),'import-next':()=>f.importer.page(1),
    'import-auto-switch':()=>f.importer.switchAutomatic(),
    'round-finish':()=>f.saved.intakeSubmission?.newRound?f.intake.submit():f.rounds.finish(),
    'round-abandon':()=>f.rounds.abandonOpening(),
    'round-cancel':()=>{f.rounds.choice=null;f.emit();},
    'round-history':()=>f.rounds.openHistory(),
    'round-history-close':()=>{f.rounds.history=null;f.emit();},
    'round-history-view':()=>f.rounds.viewHistory(el.dataset.id),
    'material-retry-job':()=>f.agent.retryAutomatic(),
    'auto-switch-cancel':()=>{f.state.autoSwitch=false;f.changes.state.discardPrompt=null;f.emit();},
    'change-discard-prepare':()=>f.changes.prepareDiscard(),
    'change-discard-cancel':()=>{f.changes.state.discardPrompt=null;f.emit();},
    'change-discard-confirm':()=>f.changes.discardForAutomatic(),
    'material-edit-existing':()=>f.changes.editMaterial(),
    'baseline-prev':()=>{f.state.baselinePage=Math.max(0,(f.state.baselinePage||0)-1);f.emit();},
    'baseline-next':()=>{f.state.baselinePage=(f.state.baselinePage||0)+1;f.emit();},
    'import-text':()=>f.importer.text(),'import-text-prev':()=>f.importer.text(Math.max(0,(f.importer.view?.textWindow?.start||0)-65536)),
    'import-text-next':()=>f.importer.text(f.importer.view?.textWindow?.end||0),
    'import-resume':()=>f.intake.submit(),
    'material-select':()=>f.selectMaterial(el.dataset.session,el.dataset.id),'material-more':()=>f.materials(true),'material-refresh':()=>f.materials(),
    'material-delete':()=>openMaterialDelete(f,()=>{workbench.invalidateGraph();void refresh().catch(()=>{});}),
    'material-resume-draft':()=>continueMaterial(f,'draft'),'material-restart':()=>continueMaterial(f,'restart'),
    'intake-remove':()=>f.intake.remove(),'intake-submit':()=>f.intake.submit(),'intake-more':()=>f.intake.more(),'intake-confirm':()=>f.intake.confirm(true),
    'intake-start-goal':()=>f.intake.startGoal(),'intake-original-goal':()=>f.intake.startGoal(true),
    'intake-prev':()=>f.intake.changePage(-1),'intake-next':()=>f.intake.changePage(1),
    'intake-edit-goal':()=>{f.state.inspectCard='goal';f.emit();$('#cv-message')?.focus();},
    'next-action':()=>{f.state.inspectCard=null;f.emit();},
    'goal-edit':()=>$('#cv-message')?.focus(),
    adjust:()=>{f.changes.setTarget(el.dataset.id);f.state.composerContext=el.dataset.id;f.state.messageMode='auto';f.state.inputRouting=null;f.state.inputNotice='已选择修改范围，请补充具体要求后发送，生成差异预览。';f.emit();$('#cv-message')?.focus();},
    'adjust-cancel':()=>{f.state.inputRouting=null;f.state.composerContext=null;f.state.messageMode='auto';f.emit();},
    'change-defer':()=>f.changes.defer(el.dataset.id),
    'change-answer':()=>{f.state.composerContext='proposal';f.state.messageMode='auto';f.state.inputNotice=f.changes.record.changeTarget==='rules'?'请用业务语言说明含义，例如“专利包括申请中和已授权的成果，不加属性”。发送后生成待确认建议。':'请直接回答本轮待确认问题，发送后会生成新的修改预览。';f.emit();$('#cv-message')?.focus();},
    'change-suggest-labels':()=>f.changes.suggestRules(el.dataset.id),'change-continue-extraction':()=>f.changes.continueExtraction(),
    'change-edit-draft':()=>{f.changes.state.preview=null;f.changes.state.publishConfirmed=false;f.state.inspectCard=null;f.emit();},
    'retry-pending':()=>f.retryPending(),'resume-upload':()=>f.resumeUpload(),'abandon-upload':()=>f.abandonUpload(),
    documents:()=>openMaterialUpload(f),'documents-more':()=>f.listDocuments(f.state.documentOffset),
    'documents-close':()=>{f.state.documents=[];f.emit();},link:()=>f.intake.stageDocument(el.dataset.id),intent:()=>f.chooseIntent(el.dataset.id),
    analyze:()=>f.analyze(),'turn-cancel':()=>f.turnAction('cancel'),'turn-retry':()=>f.turnAction('retry'),
    'use-goal':()=>f.useSuggestedGoal(),plan:()=>f.preview(),'confirm-plan':()=>f.confirmPlan(),
    'stage-1':()=>f.goStage(1),'stage-2':()=>f.goStage(2),'stage-3':()=>f.goStage(3),
    'intent-retry':()=>f.intentAction('retry'),'intent-cancel':()=>f.intentAction('cancel'),
    candidates:async()=>{await f.candidates();f.state.stage=3;f.emit();},'candidates-prev':()=>f.candidates(Math.max(0,offset-20)),'candidates-next':()=>f.candidates(offset+20),
    'candidate-graph':async()=>{await f.showCandidateGraph();if(f===conversationFlow&&currentCandidateGraph(f))focusConversationCard('.cv-candidate-tabs');},'candidate-list':()=>{f.state.candidateView='list';f.emit();},
    'begin-edit':()=>f.beginEdit(),review:()=>f.review(),'claim-review':()=>f.claimReview(el.dataset.id),'merge-prev':()=>f.reviewPage(Math.max(0,mergeOffset-20)),'merge-next':()=>f.reviewPage(mergeOffset+20),
    merge:()=>f.merge(!!$('#cv-keep-existing')?.checked),'merge-close':()=>{if(!f.reviewPending){f.state.merge=null;f.emit();}},
    release:()=>f.release(),ontology:()=>setView('ontology',false,'drafts'),'open-review':()=>canContinueMaterial(f)?continueMaterial(f,'draft'):f.changes.openDraft(),
    'change-refresh':()=>f.changes.refresh(),'change-more':()=>f.changes.more(),'change-apply':()=>f.changes.apply(el.dataset.id),
    'change-recover':()=>f.changes.recover(),
    'change-open-draft':()=>f.changes.openDraft(),'change-claim':()=>f.changes.claim(el.dataset.id),
    'advanced-review':()=>openConversationReview(f.state.detail?.document_id),
    'material-current':()=>selectWarehouseMaterial(f,f.state.detail?.document_id,true),
    'material-auto-from-source':()=>f.agent.automaticFromSource(),
    'change-revise':()=>{const p=f.changes.state.proposals.find(p=>p.id===el.dataset.id);if(!p)return;f.changes.setTarget(f.changes.record.proposalTargets?.[p.id]||'facts');if(!f.evidence.replaceInput(changeUserInstruction(p.instruction)))return;f.state.composerContext=f.changes.record.changeTarget;f.state.messageMode='change';f.saveMaterialComposer();f.emit();$('#cv-message')?.focus();},
    'change-entities':()=>f.changes.page(0,'entity'),'change-relations':()=>f.changes.page(0,'relation'),
    'change-select-page':()=>f.changes.selectPage(),'change-clear-selection':()=>f.changes.clearSelection(),
    'change-items-prev':()=>f.changes.page(Math.max(0,(f.changes.state.items?.offset||0)-20)),
    'change-items-next':()=>f.changes.page((f.changes.state.items?.offset||0)+20),
    'change-issues-adjust':()=>f.changes.adjustIssues(),'change-issues-exclude':()=>f.changes.adjustIssues({exclude:true}),
    'change-source':()=>f.changes.source(el.dataset.id,el.dataset.itemId),'change-preview':()=>f.changes.preview(),'change-publish':()=>f.changes.publish(),
    'change-filter-clear':()=>f.changes.filterFacts(),
    'change-adjust-item':()=>{const c=f.changes;if(c.selectionLocked||!c.state.items?.items.some(i=>i.id===el.dataset.id))return;c.setTarget('facts');c.clearSelection();c.select(el.dataset.id,true);f.state.composerContext='facts';f.state.messageMode='auto';f.state.inputRouting=null;f.state.inputNotice='已选择这项内容。请描述需要调整的名称、分类或属性，先生成建议供你确认。';f.emit();$('#cv-message')?.focus();},
    'change-publish-rules':()=>f.changes.publishRules(),'change-retry-publication':()=>f.changes.retryPublication(),'change-new-draft':()=>f.changes.newDraft()};
  void Promise.resolve().then(()=>commands[commandName]?.()).then(async()=>{
    if(f!==conversationFlow)return;
    if(sourceCommand){
      focusConversationCard('.mw-import-source');
      if(commandName==='import-edit-source')$('#view-conversation .mw-source-edit textarea')?.focus({preventScroll:true});
      return;
    }
    if(f.state.openDraft){f.state.openDraft=null;await f.changes.openDraft();}
    if(f.state.openMaterialEditor===f.state.selectedIntent&&!f.state.error&&!f.saved.pending)await f.changes.editMaterial();
    if(f.state.openDetailedEditor&&f.state.openDetailedEditor===f.state.detail?.document_id&&!f.state.error&&!f.saved.pending){f.state.openDetailedEditor=false;await openConversationReview(f.state.detail?.document_id);}
    if(f!==conversationFlow)return;
    const target={'stage-1':'.cv-goal-card','stage-2':'#cv-inline-rules','stage-3':'#cv-inline-knowledge',
      'round-history':'.mw-round-history','round-history-view':'.mw-round-transcript',
      'import-refresh':'.mw-refresh-feedback','import-process-source':'.mw-import-process',
      'import-auto':'.mw-import-confirmation','import-auto-switch':'.mw-import-confirmation',
      'use-goal':'.cv-goal-card',plan:'.cv-plan','confirm-plan':'#cv-inline-knowledge',
      candidates:'.cv-candidates',review:'.cv-merge','begin-edit':'.cv-conversation-actions',merge:'.cv-change-facts',
      'open-review':'.cv-change-panel','change-open-draft':'.cv-change-panel',
      'change-apply':'.cv-change-panel','change-recover':'.cv-change-panel',
      'change-claim':'.cv-change-facts','change-preview':'.cv-publication-preview','change-new-draft':'.cv-change-facts',
      'change-publish':'.cv-publication-preview','change-publish-rules':'#cv-inline-rules'}[commandName];
    if(target)focusConversationCard(target);
    if(['change-defer','next-action','change-edit-draft'].includes(commandName))focusConversationCard('.cv-conversation-actions');
  }).catch(()=>toast('页面操作未完成，请重新读取进度。'));
});
}
const jobNames = {
  document_parse: "正文解析",
  knowledge_extract: "知识抽取",
  ontology_suggest: "本体建议",
  knowledge_publish: "知识入图",
  search_index: "检索索引",
  sensitive_scan: "交付检测",
  reasoning_detect: "推理内容检测",
  knowledge_retract: "撤回旧关系",
  document_delete: "材料清理",
};
const jobStates = {
  queued: "排队中",
  awaiting_index: "等待正文索引",
  discovering_ontology: "识别新实体类型和关系",
  extracting_joint: "联合抽取类型、实体和关系",
  extracting_entities: "抽取实体",
  extracting_relations: "抽取关系",
  extracting: "抽取知识",
  extracting_parallel: "并行抽取知识",
  running: "处理中",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
};
function taskProgress(job) {
  if (job.status === 'succeeded' && job.metrics?.joint_validation?.publication_blocked === true) return '待核对抽取结果';
  if (job.status !== 'running') return jobStates[job.status] || jobStates[job.stage] || job.stage || '等待处理';
  if (job.metrics?.extraction_protocol === 'joint-ontology-facts-v1') {
    const completed = Number.isSafeInteger(job.completed_units) && job.completed_units > 0 ? job.completed_units : 0;
    return '联合抽取类型、实体和关系' + (!job.total_units && completed ? ` · 已完成 ${completed} 批次` : '');
  }
  const progress = job.metrics?.ontology_discovery_progress;
  if (progress && ['document_analysis', 'document_review'].includes(progress.phase)) {
    const count = key => Number.isSafeInteger(progress[key]) && progress[key] >= 0 ? progress[key] : 0;
    const label = progress.phase === 'document_review' ? `复核本体建议 · 第 ${count('review_round')} 轮` : '读取材料并识别类型';
    return `${label} · 已完成 ${count('completed_batches')} 批次 · 已发起 ${count('requests')} 次请求` +
      (progress.state === 'recovering' ? ' · 正在拆分重试' : '');
  }
  return jobStates[job.stage] || jobNames[job.stage] || job.stage || '处理中';
}
function renderTasks() {
  const jobs = state.jobs.filter(j => j.kind !== 'sensitive_scan');
  const active = jobs.filter(j => j.status === "running" || j.status === "queued").length;
  const failed = jobs.filter(j => j.status === "failed").length;
  $("#jobs-page-summary").textContent = jobs.length ? `本页待处理或处理中 ${active} 项 · 失败 ${failed} 项` : "";
  const rows = $("#tasks-body");
  const openModels = new Set([...rows.querySelectorAll(".task-model-details[open]")].map(item => item.dataset.jobId));
  rows.innerHTML =
    jobs
      .map(
        (j) =>
          `<article class="task-row"><div class="task-mark" style="${
            j.status === "failed" ? "color:var(--accent)" : ""
          }">${icon(
            j.status === "succeeded"
              ? "check"
              : j.status === "failed"
              ? "info"
              : "activity",
          )}</div><div class="task-content"><strong>${esc(
            jobNames[j.kind] || "处理任务",
          )}</strong><p class="task-document">${esc(j.document_name || doc(j.document_id)?.original_name || "当前星图")}</p>
          <p class="task-progress">${esc(taskProgress(j))}${
            j.total_units ? " · " + (j.completed_units ?? 0) + " / " + j.total_units + " " + taskUnitLabel(j) : ""
          }</p>${j.error_message ? `<p class="task-error">${esc(j.error_message)}</p>` : ""}
          ${extractionCountsHTML(j)}
          ${extractionFailuresHTML(j)}
          ${extractionValidationHTML(j)}
          <details class="task-model-details" data-job-id="${esc(j.id)}" ${openModels.has(String(j.id)) ? "open" : ""}>
            <summary>模型与用量</summary><p class="model-actual">${esc(actualModel(j.metrics?.processing, j.kind === "sensitive_scan" ? "sensitive" : "extraction"))}${j.metrics?.model_calls?.length ? " · 用量：" + esc(modelUsage(j.metrics.model_calls)) : ""}</p>
          </details>${
            j.metrics?.automatic_ontology_publication?.entity_types || j.metrics?.automatic_ontology_publication?.relation_types
              ? `<p>本体已自动发布 · 新增 ${esc(j.metrics.automatic_ontology_publication.entity_types)} 个实体类型、${esc(j.metrics.automatic_ontology_publication.relation_types)} 种关系</p>`
              : ""
          }${
            j.metrics?.ontology_discovery?.status === "failed"
              ? `<p class="task-error">本体发现未完成。${esc(j.metrics.ontology_discovery.message || "")}</p>`
              : ""
          }${
            j.knowledge_summary
              ? `<p>候选 ${esc(j.knowledge_summary.candidate_entities ?? 0)} 个实体、${esc(j.knowledge_summary.candidate_relations ?? 0)} 条关系 · 入图 ${esc(j.knowledge_summary.published_entities ?? 0)} 个实体、${esc(j.knowledge_summary.published_relations ?? 0)} 条关系</p>`
              : ""
          }</div><div class="task-end"><span class="pill ${
            j.status === "succeeded"
              ? (j.metrics?.joint_validation?.publication_blocked === true ? "amber" : "green")
              : j.status === "failed"
              ? "error"
              : "amber"
          }">${
            j.status === "succeeded" && j.metrics?.joint_validation?.publication_blocked === true
              ? "待核对" : jobStates[j.status] || esc(j.status)
          }</span><span class="mono">${date(j.updated_at)}</span>${
            j.status === "failed" && j.kind === "ontology_suggest"
              ? `<button class="text-link" ${j.document_id ? `data-overview-document="${esc(j.document_id)}"` : 'data-view="conversation"'}>前往资料库</button>`
              : j.status === "failed"
              ? `<button class="text-link" data-retry="${esc(
                  j.id,
                )}">重试</button>`
              : ""
          }</div></article>`,
      )
      .join("") || `<div class="empty">${state.jobTotal?'当前页没有材料处理任务，请翻页查看其他记录。':'当前没有处理任务。'}</div>`;
  $("#jobs-label").textContent = `历史记录 ${state.jobTotal} 条 · 本页显示 ${jobs.length} 项`;
  renderPager("jobs", state.jobOffset, state.jobTotal);
  $("#task-count").hidden = active === 0;
  $("#task-count").textContent = active;
}

function renderPager(kind, offset, total) {
  const container = $("#" + kind + "-pager");
  container.hidden = total <= 100;
  container.innerHTML = `<button class="text-link" data-action="${kind}-previous" ${
    !state.ready || offset === 0 ? "disabled" : ""
  }>上一页</button><span class="muted mono">${
    Math.floor(offset / 100) + 1
  } / ${Math.max(
    1,
    Math.ceil(total / 100),
  )}</span><button class="text-link" data-action="${kind}-next" ${
    !state.ready || offset + 100 >= total ? "disabled" : ""
  }>下一页</button>`;
}
async function loadPolicy() {
  try {
    const p = await call("sensitive");
    if (state.invalid) return;
    state.policy = p;
    renderPolicy();
  } catch (e) {
    banner(errorText(e));
  }
}
function renderPolicy() {
  const p = state.policy;
  document
    .querySelectorAll("[data-setting]")
    .forEach((b) =>
      b.setAttribute(
        "aria-checked",
        String(
          Boolean(
            p?.[
              b.dataset.setting === "protection"
                ? "enabled"
                : "semantic_enabled"
            ],
          ),
        ),
      ),
    );
  $("#sensitive-rules").innerHTML = p
    ? `<div class="section-caption" style="margin-top:25px"><span>当前工作空间规则</span><span class="muted">${p.rules.length} 条</span></div>` +
      p.rules
        .map(
          (r) =>
            `<div class="rule-row"><span>${esc(
              r.name,
            )}</span><span class="pill">${
              r.enabled === false
                ? "已停用"
                : { mask: "自动脱敏", block: "阻止交付", confirm: "需要确认" }[
                    r.mode
                  ] || "按规则处理"
            }</span></div>`,
        )
        .join("") +
      `<p class="modal-warning">检测状态：${esc(
        {
          completed: "已完成",
          running: "检测中",
          queued: "排队中",
          pending: "待检测",
          failed: "失败",
          disabled: "未启用",
          index_required: "等待索引",
        }[p.scan?.status] ||
          p.scan?.status ||
          "等待处理",
      )}</p>`
    : '<p class="detail-empty">连接后读取当前工作空间的保护规则。</p>';
  syncControls();
}
async function saveSetting(button) {
  if (!state.policy || state.saving) return;
  state.saving = true;
  syncControls();
  const field =
      button.dataset.setting === "protection" ? "enabled" : "semantic_enabled",
    p = state.policy;
  try {
    state.policy = await call("save-sensitive", {
      operationId: crypto.randomUUID(),
      payload: {
        expected_revision: p.revision,
        enabled: p.enabled,
        semantic_enabled: p.semantic_enabled,
        rules: p.rules,
        [field]: !p[field],
      },
    });
    toast("保护设置已保存，检测状态以任务结果为准。");
  } catch (e) {
    banner(errorText(e));
    await loadPolicy();
  } finally {
    state.saving = false;
    renderPolicy();
  }
}
async function refresh() {
  if (!state.ready || state.refreshing) return;
  if (state.view === "warehouses" || !state.warehouseId) {
    state.refreshing = true;
    const generation = state.generation;
    try {
      const result = await call("warehouses");
      if (state.invalid || generation !== state.generation) return;
      state.warehouses = result.items;
      renderWarehouses();
      banner("");
    } catch (e) {
      if (!state.invalid && generation === state.generation) banner(errorText(e));
    } finally {
      if (generation === state.generation) {
        state.refreshing = false;
        refreshAt = Date.now();
        if (state.view !== "warehouses" && state.warehouseId) void refresh();
      }
    }
    return;
  }
  const generation = state.generation;
  state.refreshing = true;
  const scoped = currentWarehouse()?.state === "active";
  let newlyActive = false;
  try {
    const [d, j, g, w, ontology] = await Promise.allSettled([
      scoped ? call("documents", { limit: 100 }) : Promise.resolve({items:[]}),
      scoped ? call("jobs", { offset: state.jobOffset }) : Promise.resolve({items:[],total:0}),
      scoped ? call("graph") : Promise.resolve({nodes:[],edges:[]}),
      call("warehouses"),
      scoped ? call('conversation-ontologies').then(readWorkbenchReply).then(result => {
        if (!Array.isArray(result?.items)) throw Object.assign(new Error('SEMANTICA_INVALID_RESPONSE'), {code:'SEMANTICA_INVALID_RESPONSE'});
        return result.items.find(item => item.status === 'published') || null;
      }) : Promise.resolve(null),
    ]);
    if (state.invalid || generation !== state.generation) return;
    if (d.status === "fulfilled") {
      state.documents = d.value.items;
    }
    if (j.status === "fulfilled") {
      state.jobs = j.value.items;
      state.jobTotal = j.value.total;
    }
    // Never retain another warehouse's labels or substitute a generic ontology.
    state.graphOntology = ontology.status === 'fulfilled' ? ontology.value : null;
    const schema = state.graphOntology?.schema;
    state.graphPresentation = createGraphPresentation(schema);
    if (g.status === "fulfilled") {
      const fingerprint = JSON.stringify([g.value, schema]);
      if (fingerprint !== state.graphFingerprint) {
        const first = !state.graphFingerprint;
        explorer.resetExpansion();
        state.graph = graphLayout(g.value);
        state.graphFingerprint = fingerprint;
        if (first) fitGraph();
      }
      state.graphError = null;
    } else {
      state.graphError = g.reason;
      state.graph = graphLayout(state.graph);
      state.graphFingerprint = null;
    }
    if (w.status === "fulfilled") {
      const previousState = currentWarehouse()?.state;
      state.warehouses = w.value.items;
      if (previousState !== currentWarehouse()?.state) state.importFailure = null;
      newlyActive = !scoped && currentWarehouse()?.state === "active";
      renderWarehouses();
      if (state.view === "conversation" && previousState !== currentWarehouse()?.state) void loadConversation();
      if (currentWarehouse()?.state === "import_failed") void loadImportFailure();
    }
    const failed = [d, j, w].find((v) => v.status === "rejected");
    const directory = state.view === "warehouses";
    if (failed && !directory) banner(errorText(failed.reason));
    else if (ontology.status === 'rejected' && !directory) banner('当前星图本体名称读取失败，图谱暂按原始类型编码显示；请重新读取。');
    else if (!state.graphError) banner("");
    if (currentWarehouse()?.state !== "active") {
      state.documents = [];
      state.jobs = [];
      state.graph = { nodes: [], edges: [] };
      state.graphPresentation = createGraphPresentation();
      state.graphOntology = null;
      explorer.reset();
      state.jobTotal = 0;
      state.graphFingerprint = null;
      state.source = null;
      state.policy = null;
      state.graphError = {
        publicMessage: currentWarehouse()?.state === "import_failed"
          ? "迁入未完成，图谱暂不可读取。请到数据管理查看失败原因。"
          : "星图正在处理或清理，完成后可继续查看图谱。",
      };
      $("#source-dialog").close();
      $("#source-body").replaceChildren();
      $("#source-actions").replaceChildren();
      if (!directory) banner(currentWarehouse()?.state === "clear_failed"
        ? "当前星图清理未完成，请到数据管理查看；其他星图仍可正常使用。"
        : currentWarehouse()?.state === "import_failed"
          ? "当前星图迁入未完成，材料和图谱暂不可读取。请到数据管理查看失败原因。"
          : "星图正在处理或清理，请稍后重试。");
    }
    renderTasks();
    renderFilters();
    renderGraph();
    renderManagement();
    if (state.view === 'overview') renderOverview();
    if (state.view === 'knowledge') renderKnowledge();
    syncControls();
    if (state.view === "data") void refreshManagementStats();

  } finally {
    if (generation === state.generation) {
      state.refreshing = false;
      refreshAt = Date.now();
      if (newlyActive) void refresh();
    }
  }
}
async function initialize() {
  if (state.invalid) return;
  state.hostNavigationReady = false;
  banner("正在读取万象连接与知识空间…");
  try {
    const v = await call("initialize");
    if (state.invalid) return;
    state.identity = v.identity;
    state.initialization = v;
    state.preview = v.identity.connection === "preview";
    state.warehouses = v.warehouses.items;
    state.runtime = v.runtime;
    void loadProcessingSummary();
    $("#user-avatar").textContent = v.identity.user.name.slice(0, 1);
    $("#user-avatar").title = v.identity.user.name;
    renderWarehouses();
    $("#import-formats").textContent =
      (v.capabilities.accepted_suffixes || [])
        .map((v) => v.toUpperCase())
        .join(" · ") +
      " / 单文件最大 " +
      bytes(v.capabilities.document_max_bytes);
    connection(true);
    banner("");
    await selectWarehouse(
      state.warehouseId || rememberedWarehouse() ||
        state.warehouses.find((w) => w.state === "active")?.id ||
        state.warehouses[0]?.id || null,
      "graph",
    );
    state.hostNavigationReady = true;
    const target = bridge ? await call("launch-target") : null;
    if (target) await applyLaunchTarget(target);
    else if (onboarding.status(state.identity).pending) setView("warehouses");
  } catch (e) {
    connection(false);
    banner(errorText(e));
  }
}
let lastLaunchRequest = null;
async function applyLaunchTarget(value) {
  if (!value || !state.hostNavigationReady || value.requestId === lastLaunchRequest) return;
  if (onboarding.busy) return;
  if (onboarding.visible) onboarding.close();
  lastLaunchRequest = value.requestId;
  let ok = false;
  try {
    if (!state.ready || state.invalid || state.uploading) throw new Error("WAREHOUSE_BUSY");
    const { target } = value;
    const warehouses = await call("warehouses");
    if (lastLaunchRequest !== value.requestId) return;
    if (!state.ready || state.invalid || state.uploading) throw new Error("WAREHOUSE_BUSY");
    state.warehouses = warehouses.items;
    const active = id => state.warehouses.some(w => w.id === id && w.state === "active");
    const unavailable = target.warehouseId && !active(target.warehouseId);
    const warehouseId = target.warehouseId
      ? unavailable ? null : target.warehouseId
      : active(state.warehouseId) ? state.warehouseId : state.warehouses.find(w => w.state === "active")?.id || null;
    // Opening an unavailable warehouse is still a successful application open.
    // Issue no new clear/delete request; let the user choose from their directory.
    const view = unavailable || target.view === "skills" ? "warehouses"
      : target.view === "search" ? "graph" : target.view;
    const selected = view === "warehouses" && (!target.warehouseId || unavailable) ? null : warehouseId;
    await selectWarehouse(selected, view);
    if(target.documentId&&!unavailable){
      const flow=conversationFlow;await conversationReady;
      if(lastLaunchRequest!==value.requestId||!flow||flow!==conversationFlow||!flow.state.loaded||state.warehouseId!==selected)throw new Error('WAREHOUSE_CHANGED');
      if(!await openWarehouseMaterial(flow,target))throw new Error('MATERIAL_TARGET_UNAVAILABLE');
    }
    ok = !state.invalid && state.ready && !state.uploading &&
      state.view === view && state.warehouseId === selected;
    if (ok && unavailable) toast("指定星图当前不可用，已打开星图列表。清理或删除状态可在管理中查看。");
  } catch (error) { toast("无法打开指定星图：" + errorText(error)); }
  finally {
    if (lastLaunchRequest === value.requestId)
      await call("launch-target-applied", { requestId: value.requestId, ok }).catch(() => {});
  }
}
async function sourceRange(id, versionId, start = 0, end) {
  const page = await call("document-text", { id, versionId, start, ...(end === undefined ? {} : {end}) });
  if (page.document_id !== id || page.version_id !== versionId || page.start !== start ||
      (end !== undefined && page.end !== end)) {
    throw Object.assign(new Error("SOURCE_VERSION_CONFLICT"), {
      publicMessage: "无法核对引用的正文版本，请重新打开来源。",
    });
  }
  return page;
}
function citationLocator(value) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); }
  catch { return null; }
}
function citationIndex(...values) {
  return values.find(value => Number.isSafeInteger(value) && value >= 0);
}
function citationStart(value) {
  const location = citationLocator(value);
  return citationIndex(location?.source_segments?.[0]?.canonical_start, location?.canonical_start);
}
function citationSegment(evidence) {
  const location = citationLocator(evidence?.locator_json ?? evidence?.locator);
  return evidence?.segment_id || location?.source_segments?.[0]?.segment_id || location?.segment_id || "";
}
function citationOffset(value) {
  const location = citationLocator(value);
  return citationIndex(location?.source_segments?.[0]?.source_char_start, location?.source_char_start) ?? 0;
}
async function citedSourceRange(id, versionId, segmentId, offset, current) {
  let start = 0;
  while (current()) {
    const page = await sourceRange(id, versionId, start);
    if (!current()) return null;
    if (!Number.isSafeInteger(page.end) || !Number.isSafeInteger(page.total_chars) ||
        page.end <= start || page.end > page.total_chars || !Array.isArray(page.locators)) break;
    const segment = page.locators.find(item => item.segment_id === segmentId);
    if (segment && Number.isSafeInteger(segment.start) && Number.isSafeInteger(segment.end) &&
        segment.start >= 0 && segment.start < segment.end && segment.end <= page.total_chars) {
      const position = segment.start + (offset < segment.end - segment.start ? offset : 0);
      return position === start ? page : sourceRange(id, versionId, position);
    }
    if (page.end === page.total_chars) break;
    start = page.end;
  }
  if (!current()) return null;
  throw Object.assign(new Error("SOURCE_LOCATION_UNAVAILABLE"), {
    publicMessage: "暂时找不到引用在该版本正文中的位置，请重新读取图谱。",
  });
}
async function showSource(id, evidence = null, versionId = '', citation = {}) {
  if (state.saving) return;
  versionId ||= evidence?.document_version_id || evidence?.version_id || '';
  const generation = state.generation;
  const request = state.sourceRequest = (state.sourceRequest || 0) + 1;
  state.source = state.sourceEvidence = null;
  state.sourceLoading = state.editing = false;
  $("#source-title").textContent = doc(id)?.original_name || "材料来源";
  $("#source-body").innerHTML = '<div class="empty">正在读取来源…</div>';
  $("#source-actions").replaceChildren();
  $("#source-dialog").showModal();
  const current = () => !state.invalid && generation === state.generation &&
    request === state.sourceRequest && $("#source-dialog").open;
  try {
    const d = await call("document", { id });
    if (!current()) return;
    const evidenceLocator = evidence?.locator_json ?? evidence?.locator;
    const start = citationIndex(citation.start == null || citation.start === "" ? undefined : Number(citation.start),
      evidence?.canonical_start, citationStart(evidenceLocator));
    const segmentId = citation.segment || citationSegment(evidence);
    const offset = citationIndex(citation.offset == null || citation.offset === "" ? undefined : Number(citation.offset)) ?? citationOffset(evidenceLocator);
    const page = !versionId ? null : start === undefined && segmentId
      ? await citedSourceRange(id, versionId, segmentId, offset, current)
      : await sourceRange(id, versionId, start ?? 0);
    if (!current()) return;
    state.source = page ? {...d, pinned:page, pinnedText:page.text, pinnedStart:page.start,
      pinnedLocation:citation.location || (evidenceLocator && locator(evidenceLocator))} : d;
    state.sourceEvidence = evidence;
    state.sourceTotal =
      d.document.segment_count ?? doc(id)?.segment_count ?? d.segments.length;
    state.editing = false;
    renderSource();
  } catch (e) {
    if (generation !== state.generation || request !== state.sourceRequest || state.invalid || !$("#source-dialog").open) return;
    $("#source-body").innerHTML =
      '<div class="empty">' + esc(errorText(e)) + "</div>";
  }
}
function renderSource() {
  const s = state.source;
  if (!s) return;
  const folder = s.sourceAnnotation?.folderPath;
  const folderNote = folder ? `<p class="muted small">空间目录 · ${esc(folder)}</p>` : "";
  if (s.pinned) {
    const page = s.pinned;
    $("#source-title").textContent = s.document.original_name;
    const evidence = state.sourceEvidence;
    $("#source-body").innerHTML = `<p class="modal-intro">引用的正文版本 · 正文范围 ${s.pinnedContext?.start ?? s.pinnedStart}–${page.end} / ${page.total_chars} 字</p>${folderNote}${
      s.pinnedLocation && s.pinnedLocation !== '来源片段' ? `<p class="muted">引用位置 · ${esc(s.pinnedLocation)}</p>` : ''
    }${
      evidence?.excerpt ? `<div class="source-card"><span class="small muted">${esc(locator(evidence.locator_json || evidence.locator))}</span><p>${esc(evidence.excerpt)}</p></div>` : ''
    }<article class="source-page">${(s.pinnedContext?.start ?? s.pinnedStart) > 0
      ? `<button class="load-more-button" data-action="source-previous" ${state.sourceLoading ? "disabled" : ""}>读取上文</button>`
      : ""
    }${s.pinnedContext ? `<div class="source-segment"><span class="small muted">上文</span><p>${esc(s.pinnedContext.text)}</p></div>` : ""
    }<div class="source-segment">${s.pinnedContext ? '<span class="small muted">从引用位置继续</span>' : ""}<p>${esc(s.pinnedText)}</p></div>${
      page.end < page.total_chars
        ? `<button class="load-more-button" data-action="source-more" ${state.sourceLoading ? "disabled" : ""}>${state.sourceLoading ? "正在读取…" : "继续读取正文"}</button>`
        : ""
    }</article>`;
    const canOpenReader = state.ready && !state.preview && state.identity?.dataScope === "personal";
    const currentVersion = page.version_id === s.version?.id;
    $("#source-actions").innerHTML = '<button class="btn btn-secondary" data-close="source-dialog">关闭</button>' +
      (canOpenReader ? `<button class="btn btn-primary" data-action="open-source-reader">${currentVersion ? "在资料库打开" : "在资料库查看当前版本"}</button>` : "");
    return;
  }
  const d = s.document,
    p = s.processing || {},
    total = state.sourceTotal,
    complete =
      s.segments.length >= total && !s.segments.some((x) => x.text_truncated);
  $("#source-title").textContent = d.original_name;
  const stats = `<div class="source-meta-line"><span class="pill ${
    p.text_ready ? "green" : ""
  }">${p.text_ready ? "正文就绪" : "正文处理中"}</span><span class="pill ${
    p.index_ready ? "green" : ""
  }">${p.index_ready ? "可检索" : "索引待就绪"}</span><span class="pill">${esc(
    {
      published: "星图就绪",
      empty: "无有效关系",
      failed: "知识处理失败",
      pending: "知识处理中",
    }[p.graph_status] || "知识处理中",
  )}</span></div>`;
  $("#source-body").innerHTML =
    stats +
    folderNote +
    `<p class="modal-intro">${esc(
      String(d.document_format).toUpperCase(),
    )} · ${bytes(d.size_bytes)} · ${
      s.version ? "正文版本 v" + s.version.version_number : "尚无正文版本"
    }</p>${
      state.sourceEvidence
        ? `<div class="source-card"><span class="small muted">${esc(
            locator(state.sourceEvidence.locator_json),
          )}</span><p>${esc(state.sourceEvidence.excerpt)}</p></div>`
        : ""
    }<p class="small muted">原文 ${esc(total)} 个片段 · 已加载 ${s.segments.length} 个原文片段 · ${logicalSourceGroups(s.segments).length} 个阅读分组</p><p class="model-actual">实际知识处理：${esc(actualModel(d.processing))}</p><article class="source-page">${
      (!state.editing ? logicalSourcesHTML(s.segments, {location:v=>locator(v.source_locator)}) : s.segments
        .map(
          (v) =>
            `<div class="source-segment"><label for="segment-${esc(
              v.id,
            )}">${esc(locator(v.source_locator))}</label>${
              state.editing
                ? `<textarea id="segment-${esc(v.id)}" data-segment="${esc(
                    v.id,
                  )}" ${state.saving ? "disabled" : ""} aria-label="校对 ${esc(locator(v.source_locator))}">${esc(
                    s.correctionDraft?.[v.id] ?? v.text,
                  )}</textarea>`
                : `<p>${esc(v.text)}</p>`
            }</div>`,
        )
        .join("")) || "<p>材料仍在处理中，正文将在解析后显示。</p>"
    }${
      s.segments.length < total
        ? `<button class="load-more-button" data-action="source-more" ${state.sourceLoading || state.saving || state.editing ? "disabled" : ""}>${state.sourceLoading ? "正在读取…" : "继续读取正文"}</button>`
        : ""
    }</article><p class="modal-warning">${
      state.editing
        ? "保存后生成新的校对版本，并重新处理索引和知识关系。"
        : "来源对应保留的材料版本，可保存原件进行核对。"
    }</p>`;
  $(
    "#source-actions",
  ).innerHTML = `<button class="btn btn-secondary" data-close="source-dialog" ${state.saving ? "disabled" : ""}>关闭</button><button class="btn btn-secondary" data-action="download-source" ${state.saving ? "disabled" : ""}>保存原件</button>${
    s.version && complete
      ? `<button class="btn btn-primary" data-action="${
          state.editing ? "save-correction" : "edit-source"
        }" ${state.saving || state.sourceLoading ? "disabled" : ""}>${
          state.saving ? "正在保存…" : state.editing ? "保存校对" : "校对正文"
        }</button>`
      : ""
  }`;
}
async function sourceMore(previous = false) {
  const s = state.source, generation = state.generation;
  if (!s || state.sourceLoading || state.saving || state.editing) return;
  const contextStart = s.pinnedContext?.start ?? s.pinnedStart;
  if (previous && (!s.pinned || !(contextStart > 0))) return;
  const current = () => state.source === s && generation === state.generation && !state.invalid && $("#source-dialog").open;
  state.sourceLoading = true;
  renderSource();
  try {
    if (previous) {
      const start = Math.max(0, contextStart - 1200);
      const page = await sourceRange(s.document.id, s.pinned.version_id, start, contextStart);
      if (current()) s.pinnedContext = {start, text:page.text + (s.pinnedContext?.text || "")};
      return;
    }
    if (s.pinned) {
      const page = await sourceRange(s.document.id, s.pinned.version_id, s.pinned.end);
      if (current()) {
        s.pinned = page;
        s.pinnedText += page.text;
      }
      return;
    }
    const page = await call("document", { id: s.document.id, offset: s.segments.length });
    if (!current()) return;
    if (page.version?.id !== s.version?.id) { toast("材料版本已变化，请重新打开来源。"); return; }
    s.segments.push(...page.segments);
    if (!page.segments.length) state.sourceTotal = s.segments.length;
  } catch (error) { if (current()) throw error; }
  finally { if (current()) { state.sourceLoading = false; renderSource(); } }
}
async function saveCorrection() {
  const s = state.source;
  if (!s?.version || !state.editing || state.saving || state.sourceLoading) return;
  const generation = state.generation;
  let displayed = s;
  const current = () => state.source === displayed && generation === state.generation && !state.invalid && $("#source-dialog").open;
  const segments = [...document.querySelectorAll("#source-body [data-segment]")].map(
    (el) => ({ id: el.dataset.segment, text: el.value }),
  );
  s.correctionDraft = Object.fromEntries(segments.map(segment => [segment.id, segment.text]));
  const signature = JSON.stringify(segments);
  if (s.correctionRequest?.signature !== signature) s.correctionRequest = { signature, operationId: crypto.randomUUID() };
  state.saving = true;
  renderSource();
  try {
    await call("correct", {
      id: s.document.id,
      versionId: s.version.id,
      operationId: s.correctionRequest.operationId,
      segments,
    });
    if (!current()) return;
    const detail = await call("document", { id: s.document.id });
    if (!current()) return;
    displayed = state.source = detail;
    state.editing = false;
    state.sourceEvidence = null;
    toast("校对版本已保存，索引与知识关系正在更新。");
    await refresh();
  } catch (e) {
    if (current()) toast(errorText(e));
  } finally {
    if (current()) { state.saving = false; renderSource(); }
  }
}
function matchingSpaceItems() {
  if (state.spaceResults) return [...state.spaceResults.items];
  const query = $("#space-query").value.trim().toLocaleLowerCase();
  return state.space.items.filter(item =>
    [item.name, ...(item.tags || []), item.description || ""].some(value => value.toLocaleLowerCase().includes(query)));
}
function selectableSpaceItems(items = matchingSpaceItems()) {
  const selected = new Set(state.files.map(file => file.spaceId));
  return items.filter(item => item.kind === "file" && !item.problem && !selected.has(item.id));
}
function renderSpace() {
  const query = $("#space-query").value.trim();
  $("#space-breadcrumbs").innerHTML = [{ id: "", name: "万象空间" }, ...state.space.breadcrumbs.filter(b => b.id)]
    .map(b => `<button class="text-link" data-space-folder="${esc(b.id)}">${esc(b.name)}</button>`).join('<span aria-hidden="true">/</span>');
  const items = matchingSpaceItems()
    .sort((a, b) => (a.kind === "folder" ? 0 : 1) - (b.kind === "folder" ? 0 : 1) || a.name.localeCompare(b.name, "zh-CN"));
  $("#space-search-descendants").hidden = !state.space.searchAvailable;
  const search = state.spaceResults?.search;
  $("#space-load-more").hidden = !search?.nextCursor;
  const searchStatus = search
    ? `已显示 ${items.length} 份匹配文件${search.nextCursor ? "，可继续搜索后续资料" : ""}${search.scanLimited ? "。部分目录未覆盖，可缩小搜索范围。" : ""}`
    : !items.length ? (query ? "当前文件夹没有匹配的文件。" : "此文件夹还没有文件，可先在万象空间上传。") : "";
  $("#space-status").textContent = state.spaceLoading
    ? search && state.spaceSelecting ? `正在读取其余结果，已找到 ${items.length} 份匹配文件…` : "正在读取万象空间…"
    : state.spaceError ? errorText(state.spaceError) : searchStatus;
  const selectable = selectableSpaceItems(items);
  const selectVisible = $("#space-select-visible");
  const showFiles = Boolean(state.spaceResults) || !(state.spaceLoading || state.spaceError);
  selectVisible.hidden = state.importContext === "conversation" || !showFiles || (!search?.nextCursor && selectable.length < 2);
  selectVisible.textContent = search?.nextCursor
    ? search.scanLimited ? "选择已覆盖的匹配文件" : "选择所有匹配文件"
    : `选择 ${selectable.length} 份匹配文件`;
  $("#space-entries").innerHTML = !showFiles ? "" : items.map(e => {
    if (e.kind === "folder") return `<button class="space-row space-folder" data-space-folder="${esc(e.id)}">${icon("folder")}<span>${esc(e.name)}</span><small>文件夹</small>${icon("chevron")}</button>`;
    const selected = state.files.some(f => f.spaceId === e.id);
    return `<label class="space-row ${e.problem ? "unsupported" : ""}"><input type="checkbox" data-space-file="${esc(e.id)}" data-unsupported="${Boolean(e.problem)}" ${selected ? "checked" : ""} ${e.problem ? "disabled" : ""} aria-label="选择 ${esc(e.name)}" /><span class="space-file-name">${esc(e.name)}${e.tags?.length ? `<small>${esc(e.tags.join(" · "))}</small>` : ""}${e.folderPath ? `<small>${esc(e.folderPath)}</small>` : ""}${e.problem ? `<small>${esc(errorText({code:e.problem}))}</small>` : ""}</span><small>${esc(e.format.toUpperCase())} · ${bytes(e.size)}</small></label>`;
  }).join("");
  syncControls();
}
async function loadSpace(parent, query = "", after = "") {
  const request = ++state.spaceRequest;
  state.spaceLoading = true;
  state.spaceError = null;
  if (!after) state.spaceResults = null;
  if (!query) $("#space-query").value = "";
  renderSpace();
  try {
    const listing = await call("space-list", { parent, ...(query ? {query} : {}), ...(after ? {after} : {}) });
    if (request !== state.spaceRequest) return;
    if (query) {
      if (!listing.search) throw {publicMessage:"当前空间暂不支持搜索子文件夹。"};
      if ($("#space-query").value.trim() === query) {
        const items = new Map((state.spaceResults?.items || []).map(file => [file.id, file]));
        for (const file of listing.items) items.set(file.id, file);
        state.spaceResults = {...listing, items:[...items.values()], search:{
          ...listing.search, scanLimited:listing.search.scanLimited || Boolean(state.spaceResults?.search.scanLimited),
        }};
      }
    } else state.space = listing;
  } catch (error) {
    if (request !== state.spaceRequest || state.invalid) return;
    state.spaceError = error;
  } finally {
    if (request === state.spaceRequest) {
      state.spaceLoading = false;
      renderSpace();
    }
  }
}
async function removePending(handle) {
  if (state.uploading || state.spaceSelecting) return;
  state.spaceSelecting = true;
  syncControls();
  try {
    await call("release-files", { handles: [handle] });
    state.files = state.files.filter(f => f.handle !== handle);
  } finally {
    state.spaceSelecting = false;
    renderPending();
    renderSpace();
  }
}
function resetImportDrafts() {
  state.importFiles = { standard: [], conversation: [] };
  $("#import-note").value = "";
}
$("#space-query").addEventListener("input", () => {
  state.spaceResults = null;
  state.spaceError = null;
  renderSpace();
});
$("#space-search-descendants").addEventListener("click", () => {
  const query = $("#space-query").value.trim();
  if (query && !state.spaceLoading && !state.uploading && !state.spaceSelecting) void loadSpace(state.space.parent, query);
});
$("#space-refresh").addEventListener("click", () => void loadSpace(state.space.parent,
  state.spaceResults ? $("#space-query").value.trim() : ""));
$("#space-load-more").addEventListener("click", () => {
  const next = state.spaceResults?.search?.nextCursor;
  if (next && !state.spaceLoading && !state.uploading && !state.spaceSelecting)
    void loadSpace(state.space.parent, $("#space-query").value.trim(), next);
});
$("#space-browser").addEventListener("click", event => {
  const button = event.target.closest("[data-space-folder]");
  if (button && !state.uploading && !state.spaceSelecting) void loadSpace(button.dataset.spaceFolder);
});
async function selectSpaceItems(items, includeMore = false) {
  if (state.uploading || state.spaceSelecting || state.spaceLoading || (!items.length && !includeMore)) return;
  const generation = state.generation;
  state.spaceSelecting = true;
  syncControls();
  try {
    if (includeMore) {
      const query = $("#space-query").value.trim(), parent = state.space.parent;
      const cursors = new Set();
      while (state.spaceResults?.search.nextCursor) {
        const cursor = state.spaceResults.search.nextCursor;
        if (cursors.has(cursor)) throw { publicMessage: "无法继续读取匹配文件，请刷新后重试。" };
        cursors.add(cursor);
        await loadSpace(parent, query, cursor);
        if (state.invalid || generation !== state.generation || state.spaceError) return;
      }
      items = selectableSpaceItems();
    }
    const handles = new Set(state.files.map(file => file.handle));
    for (let offset = 0; offset < items.length; offset += 200) {
      const files = await call("select-space-files", {
        entries: items.slice(offset, offset + 200).map(({id, digest}) => ({id, digest})), selectionMode: state.importContext,
      });
      for (const file of files) {
        if (handles.has(file.handle)) continue;
        handles.add(file.handle);
        state.files.push(file);
      }
      renderPending();
    }
  } finally {
    state.spaceSelecting = false;
    renderPending();
    renderSpace();
  }
}
$("#space-select-visible").addEventListener("click", () => {
  if (state.importContext !== "conversation") {
    void selectSpaceItems(selectableSpaceItems(), Boolean(state.spaceResults?.search.nextCursor)).catch(error => toast(errorText(error)));
  }
});
$("#space-entries").addEventListener("change", event => {
  const input = event.target.closest("[data-space-file]");
  if (!input || state.uploading || state.spaceSelecting) return;
  const entry = (state.spaceResults || state.space).items.find(item => item.id === input.dataset.spaceFile);
  if (!entry || entry.problem) return;
  if (input.checked) {
    void selectSpaceItems([entry]).catch(error => toast(errorText(error)));
  } else {
    const file = state.files.find(file => file.spaceId === entry.id);
    if (file) void removePending(file.handle).catch(error => toast(errorText(error)));
  }
});
$("#file-list").addEventListener("click", event => {
  const button = event.target.closest("[data-remove-file]");
  if (button) void removePending(button.dataset.removeFile).catch(error => toast(errorText(error)));
});
function pendingFileStatus(file) {
  if (file.done) {
    if (file.reused) return "已复用星图中的材料";
    if (file.replacing) return "已提交同名覆盖";
    return "已交给盒端处理";
  }
  if (file.error) return errorText(file.error);
  if (file.progress != null) return `正在导入 ${Math.floor(file.progress * 100)}%`;
  return "等待导入";
}
function paintPendingFile(file) {
  const status = $(`#file-list [data-import-status="${CSS.escape(file.handle)}"]`);
  if (!status) return;
  const text = pendingFileStatus(file);
  if (status.textContent !== text) status.textContent = text;
  status.classList.toggle("file-state-error", !!file.error);
}
function renderPending(changedFile) {
  const batch = state.importContext !== "conversation";
  const failed = batch ? state.files.filter(f => f.error) : [];
  const replace = failed.filter(needsNewFileSelection).length;
  const retry = failed.length - replace;
  const submitted = state.files.filter(f => f.done).length;
  const files = !state.uploading && failed.length
    ? [...failed, ...state.files.filter(f => !f.error)]
    : state.files;
  const batchStatus = $("#import-batch-status");
  batchStatus.hidden = !batch || (!state.uploading && !failed.length && !submitted);
  batchStatus.textContent = batchStatus.hidden ? "" : [
    `已提交 ${submitted} 份`,
    retry ? `${retry} 份可重试` : "",
    replace ? `${replace} 份需重新选择` : "",
  ].filter(Boolean).join(" · ");
  $("#import-close").textContent = batch && submitted ? "关闭" : "取消";
  if (changedFile && state.uploading) {
    paintPendingFile(changedFile);
    return;
  }
  $("#file-list").innerHTML = files
    .map(
      (f) =>
        `<div class="file-preview">${icon("file")}<span class="pending-name">${esc(
          f.name,
        )}<small>万象空间${f.folderPath ? " · " + esc(f.folderPath) : ""}</small>${pendingAnnotationHTML(f)}</span><span class="file-meta mono">${bytes(
          f.size,
        )}</span><button class="text-link" data-remove-file="${esc(f.handle)}" aria-label="${batch && needsNewFileSelection(f) ? "移除旧选择" : "移除"} ${esc(f.name)}">${batch && needsNewFileSelection(f) ? "移除旧选择" : "移除"}</button><span class="file-state${f.error ? " file-state-error" : ""}" data-import-status="${esc(f.handle)}">${esc(pendingFileStatus(f))}</span></div>`,
    )
    .join("");
  $("#confirm-import").textContent = state.uploading
    ? "正在导入…"
    : !batch ? state.files.some(f => f.error) ? "重试未完成的导入" : "导入并核对"
    : retry && state.files.filter(canUploadFile).length === retry ? `重试 ${retry} 份`
    : "批量导入并解析";
  $("#import-selection-count").textContent = `已选 ${state.files.length} 份材料`;
  syncControls();
}
async function uploadFiles() {
  if (state.importContext === "conversation") return uploadConversationFile();
  if (state.uploading || state.spaceSelecting) return;
  const pending = state.files.filter(canUploadFile);
  if (!pending.length) return;
  state.uploading = true;
  renderPending();
  for (const f of pending) {
    f.error = null;
    paintPendingFile(f);
    try {
      const r = await call("upload", { handle: f.handle });
      f.done = true;
      f.documentId = r.document?.id;
      f.annotationIndex = r.annotationIndex;
      f.reused = r.reused === true;
      f.replacing = r.job?.replaces_original === true && !f.reused;
    } catch (e) {
      f.error = e;
      if (state.invalid) break;
    }
    renderPending(f);
  }
  state.uploading = false;
  if (state.invalid) return;
  renderPending();
  if (state.files.some(f => f.error)) {
    const list = $("#file-list");
    list.scrollTop = 0;
    list.firstElementChild?.scrollIntoView({ block: "nearest" });
  }
  state.jobOffset = 0;
  if (state.files.every((f) => f.done)) {
    const reused = state.files.filter(f => f.reused).length;
    const replaced = state.files.filter(f => f.replacing).length;
    const created = state.files.length - reused - replaced;
    $("#import-dialog").close();
    setView("conversation");
    toast([
      created ? `已导入 ${created} 份新材料。` : "",
      replaced ? `已提交 ${replaced} 份同名覆盖。` : "",
      reused ? `已复用 ${reused} 份相同材料。` : "",
      created || replaced ? "解析完成后可在资料库核对正文。" : "",
    ].join(""));
  }
  await refresh();
}
async function uploadConversationFile() {
  const flow = conversationFlow, file = state.files[0];
  if (state.uploading || state.spaceSelecting || !flow || flow.warehouseId !== state.warehouseId || state.files.length !== 1 || file.done) return;
  state.uploading = true;
  $("#import-error").hidden = true;
  renderPending();
  try {
    await flow.intake.stageSelectedFile(file);
    const submitted = flow.intake.staged?.handle === file.handle;
    if (submitted) await flow.intake.submit({isolated:true,note:$("#import-note").value});
    if (submitted && !flow.intake.staged) {
      state.files = [];
      $("#import-dialog").close();
      toast(flow.saved.upload?.replacementError ? flow.state.error
        : flow.state.error ? "材料提交结果待确认，请在材料页恢复原请求。" : "材料已导入，请先核对正文及索引状态。");
    } else if (flow.state.error) {
      $("#import-error").textContent = flow.state.error;
      $("#import-error").hidden = false;
    }
  } finally {
    state.uploading = false;
    renderPending();
  }
}
function resetGraph() {
  explorer.close();
  state.type = "all";
  state.selectedNode = state.selectedEdge = null;
  $("#graph-query").value = "";
  fitGraph();
  renderFilters();
  renderGraph();
}
function fitGraph() {
  graphMotion.fit();
}
function setNavigationOpen(open, restoreFocus = false) {
  const rail = $("#starlink-rail");
  const toggles = [...document.querySelectorAll(".starlink-module .mobile-toggle")];
  const toggle = toggles.find(button => button.getClientRects().length);
  const focusedInRail = toggle && rail.contains(document.activeElement);
  $("#app").classList.toggle("nav-open", open);
  for (const button of toggles) button.setAttribute("aria-expanded", String(open));
  if (open) ($(".starlink-rail [aria-current=page]") || $('.starlink-rail [data-view="graph"]'))?.focus();
  else if (restoreFocus || focusedInRail) toggle?.focus();
}

async function action(name, targetWarehouseId) {
  if (await warehouseAction(name, targetWarehouseId)) return;
  if (name === "nav") setNavigationOpen(!$("#app").classList.contains("nav-open"), true);
  else if (name === "help") $("#help-dialog").showModal();
  else if (name === "graph-tasks") setView("tasks");
  else if (name === "reload-materials") {
    if (state.view === "conversation" && !conversationFlow?.state.loaded && !conversationFlow?.state.busy) await loadConversation();
  }
  else if (name === "close-graph-details") {
    if (explorer.keepsOverview) {
      explorer.close();
      renderFilters();
      renderGraph();
      $("#graph-explore-menu summary")?.focus({preventScroll:true});
      return;
    }
    state.detailsDismissed = true;
    $(".graph-inspector").hidden = true;
    transformScene();
    $("#graph-focus-back").focus({ preventScroll: true });
  } else if (name === "leave-graph-focus") {
    explorer.close();
    renderFilters();
    state.selectedNode = state.selectedEdge = null;
    renderGraph();
    $("#graph-query").focus({ preventScroll: true });
  } else if (name === "graph-entity-details") {
    state.selectedEdge = null;
    renderGraph();
    $("#graph-inspector-trail [data-action=leave-graph-focus]")?.focus({ preventScroll: true });
  } else if (name === "clear-graph-filters") {
    state.graphOverview = true;
    state.showIsolated = false;
    resetGraph();
    $("#graph-query").focus({ preventScroll: true });
  } else if (name === "show-graph-isolated") {
    state.showIsolated = true;
    renderGraph();
    fitGraph();
  }
  else if (name === "import" || name === "import-batch") {
    if (state.view === "skills") { $("#skill-import").click(); return; }
    if (importBlocked() || $("#import-dialog").open) return;
    const opening = {}, generation = state.generation, warehouseId = state.warehouseId, view = state.view, flow = conversationFlow;
    state.importOpening = opening; syncControls();
    try {
      const context = name === "import" && view === "conversation" && basicMaterialWarehouse !== warehouseId
        ? "conversation" : "standard";
      const files = state.importFiles[context];
      if (files.every((f) => f.done)) {
        await call("release-files", { handles: files.map(f => f.handle) });
        if (state.importOpening !== opening || generation !== state.generation || warehouseId !== state.warehouseId || view !== state.view || flow !== conversationFlow || !state.ready) return;
        state.importFiles[context] = [];
      }
      state.importContext = context;
      $("#import-intro").textContent = state.importContext === "conversation"
        ? "选择一份资料。解析后，盒子会用所配置的模型自动生成本体建议。正文与知识仍可分别核对。"
        : "资料解析后，盒子会用所配置的模型自动生成本体建议。";
      $("#import-warning").textContent = state.importContext === "conversation"
        ? "确认后读取文件副本并准备正文。万象空间原文件保持不变；后续抽取与发布仍需单独确认。"
        : "批量导入后先解析文件副本，解析完成后可在资料库逐份核对正文。";
      $("#import-note-field").hidden = state.importContext !== "conversation";
      $("#import-link-existing").hidden = state.importContext !== "conversation";
      if (context === "conversation" && !state.files.length) $("#import-note").value = "";
      $("#import-selection-hint").textContent = state.importContext === "conversation" ? "每次选择一份材料" : "可跨文件夹选择";
      $("#import-error").hidden = true;
      $("#import-context").textContent = `万象空间 · ${state.identity?.boxName || state.identity?.boxId || "当前设备"} → ${currentWarehouse()?.name || "当前星图"}`;
      renderPending();
      $("#import-dialog").showModal();
      void loadSpace("");
    } finally { if (state.importOpening === opening) state.importOpening = null; syncControls(); }
  } else if (name === "reconnect") await initialize();
  else if (name === "refresh") await refresh();
  else if (/^jobs-(previous|next)$/.test(name)) {
    if (state.refreshing) return;
    const [, direction] = name.split("-");
    const field = "jobOffset";
    state[field] = Math.max(
      0,
      state[field] + (direction === "next" ? 100 : -100),
    );
    await refresh();
  } else if (name === "reset-graph") resetGraph();
  else if (name === "fit") {
    fitGraph();
    transformScene();
  } else if (name === "zoom-in" || name === "zoom-out") {
    graphMotion.zoom(name === 'zoom-in' ? 1.2 : 1 / 1.2);
  } else if (name === 'graph-auto-rotate') {
    graphAutoRotate = !graphAutoRotate;
    $('#graph-auto-rotate').setAttribute('aria-pressed', String(graphAutoRotate));
    transformScene();
  } else if (name === 'graph-rotate-left' || name === 'graph-rotate-right') {
    graphMotion.rotate(name === 'graph-rotate-left' ? -.32 : .32);
  } else if (name === "open-source-reader") {
    const source = state.source;
    if (!source?.pinned || !$("#source-dialog").open || state.saving) return;
    const citation = {page:source.pinned, excerpt:state.sourceEvidence?.excerpt};
    $("#source-dialog").close();
    setView("conversation", false, undefined, false, source.document.id, citation);
  } else if (name === "edit-source") {
    state.editing = true;
    renderSource();
  } else if (name === "save-correction") await saveCorrection();
  else if (name === "source-more" || name === "source-previous") await sourceMore(name === "source-previous");
  else if (name === "download-source") {
    const r = await call("download", { id: state.source.document.id });
    if (r.saved) toast("材料原件已保存。");

  }
}
document.addEventListener("click", (event) => {
  const el = event.target.closest("button,[data-node],[data-edge]");
  if (!el) return;
  void (async () => {
    if (el.dataset.warehouseId) {
      if (state.uploading || onboarding.busy) return;
      const nextView = el.dataset.warehouseView || "graph";
      if (el.dataset.warehouseId !== state.warehouseId) await selectWarehouse(el.dataset.warehouseId, nextView);
      else {
        $("#warehouse-picker").close();
        setView(nextView);
      }
    } else if (el.dataset.overviewDocument) {
      setView('conversation', false, undefined, false, el.dataset.overviewDocument);
    } else if (el.dataset.entityPage) {
      state.knowledgeEntity = el.dataset.entityPage;
      renderKnowledge();
      [...$('#knowledge-list').children].find(item => item.dataset.entityPage === state.knowledgeEntity)?.focus({preventScroll:true});
    } else if (el.dataset.entityInGraph) {
      setView('graph');
      if (state.view === 'graph') { resetGraph(); selectNode(el.dataset.entityInGraph); }
    } else if (el.dataset.ontologyAction) setView("ontology", false, el.dataset.ontologyAction);
    else if (el.dataset.view) setView(el.dataset.view);
    else if (el.dataset.action) await action(el.dataset.action, el.dataset.deleteWarehouse);
    else if (el.dataset.close) {
      if (el.dataset.close === "import-dialog" && (state.uploading || state.spaceSelecting)) return;
      if (el.dataset.close === "source-dialog" && state.saving) return;
      if (el.dataset.close === "clear-dialog" && state.clearIntent?.submitting) return;
      $("#" + el.dataset.close).close();
    } else if (el.dataset.node) {
      if (!explorer.takePathNode(el.dataset.node,event.shiftKey)) selectNode(el.dataset.node);
    }
    else if (el.dataset.edge) {
      if (state.view === 'knowledge') { setView('graph'); if (state.view !== 'graph') return; resetGraph(); }
      selectEdge(el.dataset.edge);
    }
    else if (el.dataset.source) {
      const e = edge(el.dataset.edgeSource);
      await showSource(
        el.dataset.source,
        e?.evidence[Number(el.dataset.evidenceIndex) || 0],
        el.dataset.sourceVersion,
        {location:el.dataset.sourceLocation, start:el.dataset.sourceStart,
          segment:el.dataset.sourceSegment, offset:el.dataset.sourceOffset},
      );
    } else if (el.dataset.graphDensity) {
      state.graphOverview = el.dataset.graphDensity === "overview";
      resetGraph();
    } else if (el.dataset.type) {
      state.type = el.dataset.type;
      state.selectedNode = state.selectedEdge = null;
      renderFilters();
      renderGraph();
      fitGraph();
      transformScene();
    } else if (el.dataset.mode) {
      state.mode = el.dataset.mode;
      syncStarxiaotu();
      document.querySelectorAll("[data-mode]").forEach((b) => {
        b.classList.toggle("active", b.dataset.mode === state.mode);
        b.setAttribute("aria-pressed", String(b.dataset.mode === state.mode));
      });
      $("#graph-space").hidden = state.mode !== "graph";
      $("#relation-list").hidden = state.mode !== "list";
      renderGraph();
    } else if (el.dataset.setting) await saveSetting(el);
    else if (el.dataset.retry) {
      await call("retry-job", {
        id: el.dataset.retry,
        operationId: crypto.randomUUID(),
      });
      toast("任务已安排重试。");
      await refresh();
    }
  })().catch((e) => toast(errorText(e)));
});
bindConversationEvents();
$("#confirm-import").addEventListener("click", () => void uploadFiles());
$("#import-dialog").addEventListener("cancel", (event) => {
  if (state.uploading || state.spaceSelecting) event.preventDefault();
});
$("#source-dialog").addEventListener("cancel", event => { if (state.saving) event.preventDefault(); });
$("#source-dialog").addEventListener("close", () => {
  if ($("#source-dialog").open) return;
  state.sourceRequest++;
  state.source = state.sourceEvidence = null;
  state.sourceLoading = false;
});
$("#import-link-existing").addEventListener("click", () => {
  if (state.uploading || state.spaceSelecting || !conversationFlow || state.files.length) return;
  $("#import-dialog").close();
  openMaterialUpload(conversationFlow);
});
document.addEventListener("pointerdown", event => {
  for (const menu of document.querySelectorAll(".graph-filter-menu[open]"))
    if (!menu.contains(event.target)) menu.open = false;
  if (!event.target.closest(".graph-entity-search")) $("#graph-suggestions").hidden = true;
});
$("#graph-query").addEventListener("focus", () => renderGraphSuggestions($("#graph-query").value.trim(), visibleGraph().nodes));
$("#graph-query").addEventListener("keydown", event => {
  if (!["Enter", "ArrowDown"].includes(event.key) || $("#graph-suggestions").hidden) return;
  const first = $("#graph-suggestions button");
  if (!first) return;
  event.preventDefault();
  if (event.key === "Enter") first.click();
  else first.focus();
});
$("#graph-suggestions").addEventListener("keydown", event => {
  if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
  event.preventDefault();
  const neighbor = event.key === "ArrowDown" ? event.target.nextElementSibling : event.target.previousElementSibling;
  (neighbor || $("#graph-query")).focus();
});
$("#graph-query").addEventListener("input", () => {
  state.selectedNode = state.selectedEdge = null;
  renderGraph();
  fitGraph();
  transformScene();
});
$("#graph-show-isolated").addEventListener("change", (event) => {
  state.showIsolated = event.target.checked;
  renderGraph();
  fitGraph();
  transformScene();
});
$("#graph-exact-type-select").addEventListener("change", event => {
  state.type = event.target.value;
  state.selectedNode = state.selectedEdge = null;
  renderGraph();
  fitGraph();
  transformScene();
});
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    setView("graph");
    $("#graph-query").focus();
  }
  if (event.key === "Escape") {
    if ($("#app").classList.contains("nav-open")) { setNavigationOpen(false, true); return; }
    if (state.view === "graph" && !document.querySelector("dialog[open]")) {
      if ($(".graph-filter-menu").open) { $(".graph-filter-menu").open = false; $(".graph-filter-menu summary").focus(); }
      else if (!$("#graph-suggestions").hidden) { $("#graph-suggestions").hidden = true; $("#graph-query").focus(); }
      else if (!$(".graph-inspector").hidden) void action(state.selectedEdge ? "graph-entity-details" : "close-graph-details");
      else if (state.selectedNode) void action("leave-graph-focus");
      else if ($("#graph-query").value) { resetGraph(); $("#graph-query").focus(); }
    }
  }
  if (
    (event.key === "Enter" || event.key === " ") &&
    event.target.matches("[data-node],[data-edge]")
  ) {
    event.preventDefault();
    event.target.dataset.node
      ? selectNode(event.target.dataset.node)
      : selectEdge(event.target.dataset.edge);
  }
});
bridge?.subscribe((event) => {
  if (event.type === "invalidated") { workbench.reset(); invalidate(); }
  else if (event.type === "launch-target") void applyLaunchTarget(event);
  else if (event.type === "upload") {
    const f = state.files.find((f) => f.handle === event.handle);
    if (f) {
      f.progress = event.size ? event.offset / event.size : 0;
      paintPendingFile(f);
    }
  }
});
icons();
explorer.bind();
renderFilters();
renderGraph();
renderTasks();
renderPolicy();
connection(false);
renderWarehouses();
setView("graph");
void initialize();
setInterval(() => {
  if (!panelVisible || document.hidden || !state.ready || state.invalid) return;
  const active =
    (state.warehouseId && currentWarehouse()?.state !== "active") ||
    state.warehouses.some((w) => ["clearing", "deleting", "importing"].includes(w.state)) ||
    state.jobs.some((j) => ["queued", "running"].includes(j.status));
  if (Date.now() - refreshAt > (active ? 3000 : 20000)) void refresh();
}, 1500);

function renderOverview() {
  const warehouse = currentWarehouse();
  const snapshot = state.overview;
  const root = $('#view-overview');
  const markup = overviewHTML({warehouse, goal:snapshot?.goal, ontology:state.graphOntology,
    documents:state.documents,
    pending:snapshot?.pending, esc, date});
  if (root.renderedMarkup !== markup) { root.innerHTML = markup; root.renderedMarkup = markup; }
}

async function loadOverview() {
  if (!state.ready || currentWarehouse()?.state !== 'active') return;
  const generation = state.generation;
  const [scope, materials] = await Promise.allSettled([
    call('onboarding-context', {warehouseId:state.warehouseId}).then(readWorkbenchReply),
    call('conversation-material-workflows', {offset:0, limit:50}).then(readWorkbenchReply),
  ]);
  if (state.invalid || state.generation !== generation) return;
  state.overview = {
    goal:scope.value?.warehouse_scope?.purposes?.join('\n'),
    pending:materials.value?.items?.filter(item => item.document_id && item.document?.original_name &&
      (item.stage === 'review' || item.stage === 'awaiting_review' || item.document.ontology_suggestions?.status === 'completed' &&
       item.document.ontology_suggestions.count > 0 && !item.document.ontology_suggestions.handled)),
  };
  if (state.view === 'overview') renderOverview();
}

function renderKnowledge() {
  const {list, reader} = knowledgeHTML({graph:state.graph, selected:state.knowledgeEntity,
    query:$('#knowledge-query').value, schema:state.graphOntology?.schema, presentation:state.graphPresentation,
    esc, documentName:id => doc(id)?.original_name || '来源材料'});
  for (const [selector, markup] of [['#knowledge-list', list], ['#knowledge-reader', reader]]) {
    const root = $(selector);
    if (root.renderedMarkup !== markup) { root.innerHTML = markup; root.renderedMarkup = markup; }
  }
}
$('#knowledge-query').addEventListener('input', renderKnowledge);

function currentWarehouse() {
  return state.warehouses.find((w) => w.id === state.warehouseId);
}
function warehouseStatus(w) {
  const statuses = {clearing:"正在清理",clear_failed:"清理未完成",deleting:"正在删除",delete_failed:"删除未完成",importing:"正在迁入",import_failed:"迁入未完成"};
  return statuses[w.state] || (w.active_jobs ? `${w.active_jobs} 项处理中` : w.document_count ? "可进入" : "待导入资料");
}
function canDeleteWarehouse(warehouse) {
  return canCreateWarehouse() && Boolean(warehouse) &&
    ["active", "clear_failed", "import_failed", "delete_failed"].includes(warehouse.state);
}
function warehouseSelectionKey() {
  return state.identity && !state.preview ? "xingtu.warehouse." + JSON.stringify([state.identity.boxId, state.identity.user.id]) : null;
}
function rememberedWarehouse() {
  try {
    const key = warehouseSelectionKey();
    const id = key && localStorage.getItem(key);
    return state.warehouses.some(w => w.id === id) ? id : null;
  } catch { return null; }
}
function rememberWarehouse(id) {
  try {
    const key = warehouseSelectionKey();
    if (key && id) localStorage.setItem(key, id);
  } catch { /* Browsing remains available when local preferences cannot be saved. */ }
}
function renderWarehouseCollection(container, query, compact) {
  const needle = query.trim().toLocaleLowerCase();
  const ordered = [...state.warehouses].sort((a,b) => Number(b.id === state.warehouseId) - Number(a.id === state.warehouseId) || b.created_at.localeCompare(a.created_at));
  const existing = new Map([...container.children].map(el => [el.dataset.warehouseKey, el]));
  let visible = 0;
  const update = (card, field, value) => {
    const el = card.querySelector(`[data-field="${field}"]`);
    const text = String(value ?? "");
    if (el.textContent !== text) el.textContent = text;
  };
  ordered.forEach((w, index) => {
    let card = existing.get(w.id);
    if (!card) {
      card = document.createElement(compact ? "button" : "article");
      card.className = compact ? "warehouse-choice" : "warehouse-directory-card";
      card.dataset.warehouseKey = w.id;
      card.innerHTML = compact
        ? `<span class="warehouse-choice-icon">${icon("network")}</span><span class="warehouse-choice-content"><span class="warehouse-choice-title"><strong data-field="name"></strong><span data-field="current" class="warehouse-current-indicator"></span></span><span data-field="description" class="warehouse-choice-description"></span><span class="warehouse-choice-meta"><span data-field="counts"></span><span data-field="status" class="warehouse-state"></span></span></span><span class="warehouse-choice-arrow">${icon("arrow")}</span>`
        : `<div class="warehouse-card-head"><span class="warehouse-card-icon">${icon("network")}</span><div class="warehouse-card-main"><div class="warehouse-card-name"><h2 data-field="name"></h2><span data-field="current" class="warehouse-current-indicator"></span></div><p data-field="description" class="warehouse-card-description"></p></div><span data-field="status" class="warehouse-state"></span></div>
          <dl class="warehouse-card-statistics"><div><dt>材料</dt><dd data-field="documents"></dd></div><div><dt>实体</dt><dd data-field="entities"></dd></div><div><dt>关系</dt><dd data-field="relations"></dd></div></dl>
          <footer><span data-field="created" class="warehouse-card-date"></span><div><button type="button" class="text-link warehouse-card-delete" data-action="prepare-delete" data-delete-warehouse>删除</button><button class="text-link" data-warehouse-view="conversation">资料库</button><button class="warehouse-card-open" data-warehouse-view="graph"><span data-field="open"></span>${icon("arrow")}</button></div></footer>`;
      if (compact) card.dataset.warehouseId = w.id;
      else {
        const reviewButton=document.createElement('button');
        reviewButton.className='text-link';reviewButton.dataset.warehouseView='ontology';
        reviewButton.textContent='本体';card.querySelector('footer>div').prepend(reviewButton);
        card.querySelectorAll("[data-warehouse-view]").forEach(b => b.dataset.warehouseId = w.id);
      }
    }
    existing.delete(w.id);
    const selected = w.id === state.warehouseId;
    const matches = !needle || `${w.name} ${w.description || ""}`.toLocaleLowerCase().includes(needle);
    card.hidden = !matches;
    visible += Number(matches);
    card.classList.toggle("is-current", selected);
    card.classList.toggle("has-error", ["clear_failed", "delete_failed", "import_failed"].includes(w.state));
    update(card, "name", w.name);
    update(card, "current", selected ? "当前星图" : "");
    update(card, "description", w.description || "");
    update(card, "status", warehouseStatus(w));
    const blocked = !state.ready || state.uploading;
    if (compact) {
      update(card, "counts", `${w.document_count} 份材料 · ${w.entity_count} 个实体`);
      card.disabled = blocked;
      card.setAttribute("aria-pressed", String(selected));
      card.setAttribute("aria-label", `${selected ? "当前星图" : "切换至"}：${w.name}`);
    } else {
      update(card, "documents", w.document_count);
      update(card, "entities", w.entity_count);
      update(card, "relations", w.relation_count);
      update(card, "created", "建立于 " + date(w.created_at));
      update(card, "open", "打开星图");
      card.querySelectorAll("[data-warehouse-id]").forEach(b => b.disabled = blocked);
      const remove = card.querySelector('[data-delete-warehouse]');
      remove.dataset.deleteWarehouse = w.id;
      remove.hidden = state.preview || state.identity?.dataScope !== 'personal';
      remove.disabled = !canDeleteWarehouse(w);
      remove.textContent = w.state === 'delete_failed' ? '继续删除' : '删除';
      remove.setAttribute('aria-label', `${remove.textContent}「${w.name}」`);
      const reviewButton=card.querySelector('[data-warehouse-view="ontology"]');
      reviewButton.hidden=state.preview || state.identity?.dataScope!=='personal';
      reviewButton.disabled=blocked || w.state!=='active';
      card.querySelector('[data-warehouse-view="graph"]').setAttribute("aria-label", `打开星图「${w.name}」`);
      card.querySelector('[data-warehouse-view="conversation"]').setAttribute("aria-label", `管理「${w.name}」的资料`);
    }
    if (container.children[index] !== card) container.insertBefore(card, container.children[index] || null);
  });
  existing.forEach(el => el.remove());
  if (compact) $("#warehouse-picker-empty").hidden = visible > 0;
  return visible;
}
function renderWarehouseDirectory() {
  const recovery = onboarding.status(state.identity);
  const notice = $("#onboarding-resume");
  notice.hidden = !recovery.pending;
  notice.querySelector('span').textContent = recovery.entryPending ? '上次规则已发布，可继续打开星图。'
    : recovery.quickCreated ? '星图已创建，可继续打开资料库。' : '上次创建星图或规则发布有待确认的操作。';
  notice.querySelector('button').textContent = recovery.entryPending || recovery.quickCreated ? '继续打开' : '继续原操作';
  const totals = state.warehouses.reduce((n,w) => [n[0] + w.document_count, n[1] + w.entity_count, n[2] + w.relation_count], [0,0,0]);
  $("#warehouse-directory-summary").innerHTML = [[state.warehouses.length,"张星图"],[totals[0],"份材料"],[totals[1],"个实体"],[totals[2],"条知识关系"]].map(([n,label]) => `<div><b>${esc(n)}</b><span>${label}</span></div>`).join("");
  const query = $("#warehouse-query").value;
  const visible = renderWarehouseCollection($("#warehouse-directory"), query, false);
  $("#warehouse-directory-count").textContent = query.trim() ? `${visible} / ${state.warehouses.length}` : state.warehouses.length;
  const empty = $("#warehouse-directory-empty");
  empty.hidden = visible > 0;
  empty.innerHTML = state.warehouses.length
    ? `<h2>没有找到匹配的星图</h2><p>试试星图名称或说明中的其他关键词。</p>`
    : state.ready
    ? `<span class="warehouse-empty-icon">${icon("network")}</span><h2>还没有星图</h2><p>创建星图后即可导入资料。</p><button class="btn btn-primary" data-action="new-warehouse">${icon("plus")}新建第一张星图</button>`
    : `<h2>连接万象，打开你的星图</h2><p>星图随当前万象账号和盒子连接读取。</p>`;
}

function renderWarehouses() {
  const selected = currentWarehouse();
  $("#crumb-warehouse").textContent = state.view === "warehouses" ? "全部星图" : selected?.name || "尚无星图";
  $('#starlink-current-name').textContent = selected?.name || '我的项目';
  $('#starlink-current-name').title = selected?.name || '';
  $("#graph-warehouse").textContent = selected?.name || "你的第一张星图";
  const switchingDisabled = !state.ready || state.uploading || onboarding.busy;
  $("#crumb-warehouse").disabled = switchingDisabled;
  renderWarehouseDirectory();
  // Keep the picker's buttons and search focus stable during background updates.
  renderWarehouseCollection($("#warehouse-picker-list"), $("#warehouse-picker-query").value, true);
  $("#graph-model").textContent = state.processing ? "知识抽取：" + actualModel(state.processing) : state.runtime?.local_only
    ? `处理模型 ${state.runtime.model} · 本人查看原始知识`
    : "来源可查";
  document.querySelectorAll('[data-action="prepare-clear"]').forEach((b) => {
    b.disabled =
      !state.ready ||
      !selected ||
      !["active", "clear_failed", "import_failed"].includes(selected.state);
    b.textContent =
      selected?.state === "clear_failed"
        ? "重新确认并继续清理"
        : "清空当前星图";
  });
  document.querySelectorAll('[data-action="prepare-delete"]:not([data-delete-warehouse])').forEach((b) => {
    b.disabled = !canDeleteWarehouse(selected);
    b.textContent = selected?.state === "delete_failed" ? "重新确认并继续删除" : "删除当前星图";
  });
}
async function selectWarehouse(id, nextView, onboardingHandoff = false) {
  if (state.uploading || state.spaceSelecting || onboarding.busy && !onboardingHandoff) return;
  if(conversationFlow&&!conversationFlow.importer.canLeaveSource()){toast('请先保存或关闭正文编辑。');return;}
  if (id !== state.warehouseId) {
    if (!workbench.canLeave()) return;
    workbench.reset();
  }
  if (id && !state.warehouses.some((w) => w.id === id)) return;
  state.generation++;
  state.saving = state.sourceLoading = false;
  skillsUi.reset();
  const selection = bridge?.call("select-warehouse", {});
  if (!onboardingHandoff) void selection?.catch(()=>{});
  const selectionGeneration = state.generation;
  state.warehouseId = id;
  state.overview = null;
  state.knowledgeEntity = null;
  $('#knowledge-query').value = '';
  state.managementStats = null;
  state.importFailure = null;
  stopConversation();
  renderConversation();
  state.processing = null; state.externalEmbedding = false;
  void loadProcessingSummary();
  rememberWarehouse(id);
  bridge?.rememberGuideProject?.(id);
  state.refreshing = false;
  state.documents = [];
  state.jobs = [];
  state.jobTotal = 0;
  state.jobOffset = 0;
  state.graph = { nodes: [], edges: [] };
  state.graphFingerprint = null;
  state.graphError = null;
  state.graphPresentation = createGraphPresentation();
  state.graphOntology = null;
  explorer.reset();
  state.policy = null;
  resetImportDrafts();
  state.spaceRequest++;
  state.space = { parent: "", breadcrumbs: [], items: [] };
  state.spaceResults = null;
  state.spaceLoading = false;
  state.spaceError = null;
  state.source = null;
  state.selectedNode = state.selectedEdge = null;
  state.type = "all";
  document.querySelectorAll("dialog[open]").forEach((d) => d.close());
  $("#graph-query").value = "";
  $("#source-body").replaceChildren();
  $("#source-actions").replaceChildren();
  renderWarehouses();
  renderFilters();
  renderGraph();
  renderTasks();
  renderPolicy();
  renderManagement();
  syncControls();
  if (onboardingHandoff) {
    await selection;
    if (state.invalid || state.generation !== selectionGeneration) return;
  }
  if (nextView) setView(nextView, false, nextView==='ontology'&&onboardingHandoff?'published':undefined, onboardingHandoff);
  if (id) {
    await refresh();
  }
}
function renderManagement() {
  const w = currentWarehouse();
  $("#manage-name").textContent = w?.name || "从一张星图开始";
  const status = {
    clearing: "正在清理原件、知识和索引，访问凭证已撤销。",
    clear_failed: "清理未完成。请恢复本地数据库或磁盘后，重新确认并继续清理。",
    deleting: "正在删除星图和全部资料。访问凭证已撤销，完成后会从列表移除。",
    delete_failed: "删除未完成。请检查本地服务后，重新确认并继续删除。",
    importing: "正在恢复迁移资料，请等待任务完成。",
    import_failed: state.importFailure?.id === w?.id && state.importFailure?.loading
      ? "迁入未完成，正在读取失败原因。材料和图谱暂不可读取；已写入的计数不表示迁入成功。"
      : state.importFailure?.id === w?.id && state.importFailure?.error
        ? `迁入未完成：${state.importFailure.error}。材料和图谱暂不可读取；已写入的计数不表示迁入成功。`
        : "迁入未完成，材料和图谱暂不可读取；已写入的计数不表示迁入成功。迁移任务记录可能已过期，请检查盒端服务。",
  }[w?.state];
  $("#manage-status").hidden = !status;
  $("#manage-status").textContent = status || "";
  $("#manage-description").textContent =
    w?.description ||
    "你的原始资料、正文版本与知识来源，保存在同一张星图中。";
  const currentStats = state.managementStats?.id === state.warehouseId ? state.managementStats : null;
  const stats = currentStats?.value;
  $("#warehouse-stats").innerHTML = !w ? "" : stats
    ? [
        [stats.document_count, "份材料"],
        [stats.entity_count, w.state === "import_failed" ? "个已写入实体" : "个已发布实体"],
        [stats.relation_count, w.state === "import_failed" ? "条已写入关系" : "条已发布关系"],
        ...(Number.isSafeInteger(stats.storage_bytes) && stats.storage_bytes >= 0 ? [[bytes(stats.storage_bytes), "原件大小"]] : []),
      ].map(([value, label]) => `<div><b>${esc(value)}</b><span>${label}</span></div>`).join("")
    : currentStats ? '<span>统计暂不可用</span>' : '<span>正在读取统计…</span>';
  $("#runtime-summary").innerHTML = state.runtime
    ? `<span>${
        state.runtime.local_only
          ? "✓ 处理服务已启用"
          : "当前服务未启用严格本地模式"
      }</span><code>${esc(
        state.runtime.model || "请在模型与处理页面查看配置",
      )}</code><span>嵌入模型：${esc(state.runtime.embedding)}</span>`
    : "等待连接本地知识服务";
  renderProcessingSummary();
}
async function loadImportFailure(force = false) {
  const id = state.warehouseId;
  if (!state.ready || !id || currentWarehouse()?.state !== "import_failed") return;
  if (state.importFailure?.id === id && (state.importFailure.loading || state.importFailure.error || !force)) return;
  const generation = state.generation;
  state.importFailure = { id, error: null, loading: true };
  try {
    const result = await call("warehouse-import-status", { warehouseId: id });
    if (generation !== state.generation || state.warehouseId !== id) return;
    state.importFailure = { id, error: typeof result?.error === "string" ? result.error : null };
  } catch {
    if (generation !== state.generation || state.warehouseId !== id) return;
    state.importFailure = { id, error: null };
  }
  if (state.view === "data") renderManagement();
}
async function refreshManagementStats() {
  const id = state.warehouseId;
  if (state.view !== "data" || !state.ready || !id) return;
  const request = ++managementStatsRequest;
  try {
    const result = await call("warehouse", { id });
    if (request !== managementStatsRequest || state.view !== "data" || state.warehouseId !== id) return;
    const value = result?.warehouse ?? result;
    const counts = [value?.document_count, value?.entity_count, value?.relation_count];
    state.managementStats = { id, value: counts.every(count => Number.isSafeInteger(count) && count >= 0) ? value : null };
  } catch {
    if (request !== managementStatsRequest || state.view !== "data" || state.warehouseId !== id) return;
    state.managementStats = { id, value: null };
  }
  renderManagement();
}
async function openWarehouseSetup() {
  if (!canCreateWarehouse() || onboarding.busy || document.querySelector('dialog[open]:not(#warehouse-picker)')) return;
  if (!workbench.canLeave() || conversationFlow && !conversationFlow.importer.canLeaveSource()) return;
  $("#warehouse-picker").close();
  onboarding.open(state.identity);
}
async function warehouseAction(name, targetWarehouseId) {
  if (name === "choose-warehouse") {
    if (!state.ready || state.uploading) return true;
    if (document.querySelector('dialog[open]')) return true;
    $("#warehouse-picker-query").value = "";
    renderWarehouseCollection($("#warehouse-picker-list"), "", true);
    $("#warehouse-picker").showModal();
    $("#warehouse-picker-query").focus();
    return true;
  }
  if (name === "all-warehouses") {
    $("#warehouse-picker").close();
    setView("warehouses");
    return true;
  }
  if (name === 'new-warehouse' || name === 'resume-onboarding') {
    await openWarehouseSetup();
    return true;
  }
  if (name === "prepare-clear" || name === "prepare-delete") {
    const deleting = name === "prepare-delete";
    const selectedId = state.warehouseId;
    const target = deleting && targetWarehouseId ? state.warehouses.find(w => w.id === targetWarehouseId) : currentWarehouse();
    if (!target || deleting && !canDeleteWarehouse(target) ||
        state.preparingWarehouseChange || $("#clear-dialog").open) return true;
    if (target.id === selectedId && !workbench.canLeave()) return true;
    state.preparingWarehouseChange = true;
    let intent;
    try {
      intent = await call(name, {operationId: crypto.randomUUID()}, target.id);
    } finally {
      state.preparingWarehouseChange = false;
    }
    if (intent?.warehouse?.id !== target.id || typeof intent.warehouse.name !== 'string' ||
        typeof intent.confirmation_token !== 'string' || !intent.confirmation_token)
      throw Object.assign(new Error('SEMANTICA_INVALID_RESPONSE'), {publicMessage:'未收到有效的星图操作确认，请重新发起操作。'});
    state.clearIntent = {...intent, selectedId, action: deleting ? "delete" : "clear"};
    $("#clear-title").textContent = deleting ? "永久删除星图？" : "清空当前星图？";
    $('#clear-dialog .icon-btn').setAttribute('aria-label', deleting ? '取消删除' : '取消清空');
    $('#clear-dialog .btn-secondary').textContent = deleting ? '保留星图' : '保留数据';
    $("#clear-scope").innerHTML = `<p class="modal-intro">将清空「${esc(
      intent.warehouse.name,
    )}」中的全部数据：</p><div class="clear-counts">${
      intent.warehouse.document_count
    } 份材料 · ${intent.warehouse.entity_count} 个实体 · ${
      intent.warehouse.relation_count
    } 条关系</div><p class="modal-warning">原件、全部正文版本、知识关系、检索索引、Skill 及推理准备记录将被移除，${
      intent.warehouse.access_key_count
    } 个有效凭证将同时撤销。其他星图不受影响。</p>`;
    if (deleting) {
      $("#clear-scope").innerHTML = `<p class="modal-intro">将永久删除星图「${esc(intent.warehouse.name)}」及其全部数据：</p><div class="clear-counts">${intent.warehouse.document_count} 份材料 · ${intent.warehouse.entity_count} 个实体 · ${intent.warehouse.relation_count} 条关系</div><p class="modal-warning">星图本身、原件、全部正文版本、知识关系、索引、Skill 及推理准备记录将被移除，${intent.warehouse.access_key_count} 个有效凭证将撤销。此操作无法撤销，其他星图不受影响。</p>`;
    }
    $("#clear-second").hidden = true;
    $("#clear-name").value = "";
    $("#clear-next").textContent = "继续确认";
    $("#clear-next").disabled = false;
    $("#clear-dialog").showModal();
    return true;
  }
  return false;
}
$("#warehouse-query").addEventListener("input", renderWarehouseDirectory);
$("#warehouse-picker-query").addEventListener("input", () => renderWarehouseCollection($("#warehouse-picker-list"), $("#warehouse-picker-query").value, true));
$("#warehouse-picker-query").addEventListener("keydown", (event) => {
  if (!["ArrowDown", "Enter"].includes(event.key)) return;
  const first = $("#warehouse-picker-list").querySelector("button:not([hidden]):not(:disabled)");
  if (!first) return;
  event.preventDefault();
  if (event.key === "Enter") first.click();
  else first.focus();
});
function definiteWriteRejection(error) {
  return [400, 401, 403, 404, 409, 413, 422].includes(error?.status);
}
$("#clear-name").addEventListener(
  "input",
  () =>
    ($("#clear-next").disabled =
      $("#clear-name").value !== state.clearIntent?.warehouse.name),
);
$("#clear-dialog").addEventListener("close", () => {
  if ($("#clear-dialog").open) return;
  state.clearIntent = null;
  $("#clear-name").value = "";
});
$("#clear-dialog").addEventListener("cancel", event => {
  if (state.clearIntent?.submitting) event.preventDefault();
});
$("#clear-next").addEventListener("click", () => {
  if ($("#clear-second").hidden) {
    $("#clear-second").hidden = false;
    $("#clear-next").textContent = state.clearIntent?.action === "delete" ? "确认永久删除星图" : "确认永久清空";
    $("#clear-next").disabled = true;
    $("#clear-name").focus();
    return;
  }
  const intent = state.clearIntent;
  if (!intent || intent.submitting || $("#clear-name").value !== intent.warehouse.name) return;
  if (state.warehouseId !== intent.selectedId || !state.warehouses.some(w => w.id === intent.warehouse.id))
    return toast("星图已变化，请重新确认。");
  intent.submitting = true;
  $("#clear-name").disabled = true;
  $("#clear-next").disabled = true;
  const cancelButtons = [...$("#clear-dialog").querySelectorAll('[data-close="clear-dialog"]')];
  cancelButtons.forEach(button => button.disabled = true);
  void (async () => {
    const deleting = intent.action === "delete";
    await call(deleting ? "delete-warehouse" : "clear-warehouse", {
      token: intent.confirmation_token,
      typedName: $("#clear-name").value,
      operationId: (intent.operationId ||= crypto.randomUUID()),
    }, intent.warehouse.id);
    $("#clear-dialog").close();
    if (deleting) {
      state.warehouses = state.warehouses.map(w => w.id === intent.warehouse.id ? {...w, state:"deleting"} : w);
      if (state.warehouseId === intent.warehouse.id) await selectWarehouse("", "warehouses");
      else renderWarehouses();
      await refresh();
      toast("删除已提交，清理完成后会从星图列表移除；访问凭证已撤销。");
    } else {
      await selectWarehouse(state.warehouseId);
      toast("清空已提交，正在移除资料与索引；访问凭证已撤销。");
    }
  })()
    .catch((e) => toast(errorText(e)))
    .finally(() => {
      intent.submitting = false;
      $("#clear-name").disabled = false;
      cancelButtons.forEach(button => button.disabled = false);
      $("#clear-next").disabled = $("#clear-name").value !== state.clearIntent?.warehouse.name;
    });
});

const embeddingTransferNotice = "建索引时可向配置的向量服务发送未经脱敏的正文片段，向量检索时可发送检索词。交付脱敏在返回结果时生效。";
function usesExternalEmbedding(config) {
  const item = config.effective?.embedding || config.stages?.find(stage => stage.role === 'embedding');
  return item?.available === true && Boolean(item.location) && item.location !== 'local';
}
function actualModel(config, role = "extraction") {
  const item = config?.[role];
  if (config?.mode === "automatic" && item?.available === false) return "万象底座默认模型暂不可用，请检查万象模型设置";
  const name = [item?.name, item?.model].find(value => typeof value === 'string' && value.trim());
  if (!name) return "历史处理记录未提供模型配置";
  const location = {local: "本地", cloud: "云端 / 外部服务"}[item.location] || "运行位置未记录";
  const thinking = {auto: "思考：模型默认", on: "思考：开启", off: "思考：优先关闭"}[config?.inference_options?.thinking_mode] || "思考设置未记录";
  const revision = Number.isSafeInteger(config?.revision) && config.revision >= 0 ? `配置 v${config.revision}` : "配置版本未记录";
  return `${name.trim()} · ${location} · ${thinking} · ${revision}`;
}
function modelUsage(calls) {
  const usages = calls.map(c => c.usage);
  if (usages.some(u => !u)) return "未返回完整用量";
  return usages.reduce((n,u) => n + (u.total_tokens || u.input_tokens + u.output_tokens || 0), 0) + " tokens";
}
async function loadProcessingSummary() {
  if (!state.ready || !state.warehouseId || state.preview) return;
  const generation = state.generation;
  try {
    const config = await call("processing");
    if (generation !== state.generation) return;
    state.processing = config.effective;
    state.externalEmbedding = usesExternalEmbedding(config);
    renderProcessingSummary();
  } catch { /* Older services keep the existing local runtime summary. */ }
}
function renderProcessingSummary() {
  const text = state.processing ? actualModel(state.processing) : '';
  if ($("#import-model-summary")) {
    $("#import-model-summary").textContent = text
      ? "本次导入按入队时配置处理：" + text + (state.externalEmbedding ? `。${embeddingTransferNotice}` : '')
      : "正在读取处理模型…";
  }
  if (!text) return;
  $("#graph-model").textContent = "知识抽取与脱敏：" + text;
  $("#runtime-summary").textContent = "知识抽取与脱敏共用模型：" + text;
}
let starxiaotuModelRequest = 0;
let selectedStarxiaotuModel = null;
let savingStarxiaotuModel = false;
function updateStarxiaotuModelSave() {
  const choice = $("#starxiaotu-model-choice");
  $("#starxiaotu-model-save").disabled = choice.disabled || savingStarxiaotuModel ||
    (choice.value || null) === selectedStarxiaotuModel;
}
function renderStarxiaotuModels(data) {
  const choice = $("#starxiaotu-model-choice");
  const option = (ref, label, disabled = false) => Object.assign(document.createElement("option"), {value:ref,textContent:label,disabled});
  const defaultName = data.defaultModel?.name;
  const fallback = option("", defaultName ? "跟随万象底座默认模型 · " + defaultName : "跟随万象底座默认模型");
  choice.replaceChildren(fallback, ...data.models.map(model => option(model.ref, model.name + " · " + model.provider)));
  if (data.selectedRef && !data.models.some(model => model.ref === data.selectedRef)) {
    choice.append(option(data.selectedRef, "已选模型暂不可用", true));
  }
  selectedStarxiaotuModel = data.selectedRef;
  choice.value = selectedStarxiaotuModel || "";
  choice.disabled = false;
  updateStarxiaotuModelSave();
}
function starxiaotuModelError(error) {
  return {
    MODEL_CHOICE_UNAVAILABLE: "所选模型已不可用，请刷新后重新选择。",
    MODEL_PREFERENCE_UNAVAILABLE: "无法读取或保存本机模型偏好，请检查系统授权后重试。",
    SEMANTICA_UPGRADE_REQUIRED: "当前盒端暂不提供平台模型目录。",
    HOST_SESSION_EXPIRED: "盒子连接已变更，请重新打开模型设置。",
  }[error.code] || "暂时无法访问平台模型，请检查盒子连接后重试。";
}
async function loadStarxiaotuModel() {
  if (savingStarxiaotuModel) return;
  const request = ++starxiaotuModelRequest;
  const identity = state.identity;
  const status = $("#starxiaotu-model-status");
  $("#starxiaotu-model-choice").disabled = true;
  $("#starxiaotu-model-choice").replaceChildren(new Option("跟随万象底座默认模型", ""));
  updateStarxiaotuModelSave();
  if (!state.ready || state.preview) { status.textContent = "连接盒子后可以选择模型。"; return; }
  status.textContent = "正在读取平台模型…";
  try {
    const data = await call("starxiaotu-models", {}, null);
    if (request !== starxiaotuModelRequest || state.invalid || identity !== state.identity) return;
    renderStarxiaotuModels(data);
    status.textContent = data.models.length ? "" : "暂无可单独选择的文本模型。";
  } catch (error) {
    if (request === starxiaotuModelRequest && !state.invalid && identity === state.identity) status.textContent = starxiaotuModelError(error);
  }
}
$("#starxiaotu-model-choice").addEventListener("change", updateStarxiaotuModelSave);
$("#starxiaotu-model-form").addEventListener("submit", async event => {
  event.preventDefault();
  if ($("#starxiaotu-model-save").disabled) return;
  const choice = $("#starxiaotu-model-choice"), status = $("#starxiaotu-model-status");
  const identity = state.identity;
  savingStarxiaotuModel = true;
  choice.disabled = true;
  updateStarxiaotuModelSave();
  status.textContent = "正在保存…";
  try {
    const data = await call("save-starxiaotu-model", {modelRef: choice.value || null}, null);
    if (!state.invalid && identity === state.identity) {
      renderStarxiaotuModels(data);
      status.textContent = "已保存，下次发送时生效。";
    }
  } catch (error) {
    if (!state.invalid && identity === state.identity) status.textContent = starxiaotuModelError(error);
  } finally {
    savingStarxiaotuModel = false;
    if (!state.invalid && identity === state.identity) { choice.disabled = false; updateStarxiaotuModelSave(); }
    else if (state.view === 'models') void loadStarxiaotuModel();
  }
});
async function loadModels() {
  const status = $("#model-status");
  if (!state.ready || state.preview) { status.textContent = "连接盒子后即可查看和配置模型。"; return; }
  if (state.modelSaving) return;
  const request = state.modelRequest = (state.modelRequest || 0) + 1;
  const identity = state.identity;
  state.modelConfig = null;
  $("#model-save-status").textContent = "";
  $("#model-source").hidden = true;
  $("#model-stages").replaceChildren();
  updateModelControls();
  status.textContent = "正在读取当前设备的模型…";
  const results = await Promise.allSettled([call("processing", {scope:"default"}, null), call("model-catalog", {scope:"default"}, null)]);
  if (request !== state.modelRequest || state.invalid || identity !== state.identity) return;
  if (results[0].status === "rejected") { $("#model-status").textContent = errorText(results[0].reason); return; }
  state.modelConfig = results[0].value;
  if (state.modelSync?.revision !== state.modelConfig.revision) state.modelSync = null;
  state.modelCatalog = results[1].status === "fulfilled" ? results[1].value.items : [];
  state.modelDefault = results[1].status === "fulfilled" ? results[1].value.default : null;
  renderModelEditor();
  const affected = state.modelConfig.affected_warehouses;
  const hasOverrides = Array.isArray(affected) && state.warehouses?.length > affected.length;
  status.textContent = [
    results[1].status === "rejected" ? errorText(results[1].reason) : modelAvailability(state.modelConfig.effective),
    hasOverrides && !state.modelSync ? "部分旧项目仍有独立配置。检查并保存共用模型后，它们也会使用这里的设置。" : "",
  ].filter(Boolean).join(" ");
}
function modelAvailability(current) {
  if (current.blocked_reason) {
    const message = errorText({code:current.blocked_reason});
    return current.mode === "manual" && ["MODEL_CONFIG_CHANGED", "MODEL_UNAVAILABLE"].includes(current.blocked_reason)
      ? `${message}也可在编辑模型配置中切换为跟随万象底座默认模型。`
      : message;
  }
  if (!state.modelCatalog.length) return "万象尚未配置可用文本模型。";
  const item = current.extraction;
  if (item?.route === "wanx" && (!item.available || !state.modelCatalog.some(model =>
    model.id === item.id && model.revision === item.revision && model.available)))
    return "当前共用模型已变化或暂不可用。请选择可用模型，检查并保存。";
  return "";
}
function renderModelEditor() {
  const config = state.modelConfig;
  if (!config) return;
  const current = config.effective;
  const source = $("#model-source");
  source.textContent = current.mode === "automatic"
    ? "跟随万象底座默认模型，当前盒子上的所有星图共用。"
    : current.mode === "manual" ? "手动指定处理模型，当前盒子上的所有星图共用。" : "使用当前盒子的处理模型配置。";
  source.hidden = false;
  const location = item => item?.location === "local" ? "本机 / 当前盒子" : item?.location ? "云端 / 外部服务" : "";
  const contextWindow = item => Number.isSafeInteger(item?.context_window)&&item.context_window>0 ? `${item.context_window} token` : "";
  const roles = [
    ["ocr","文字识别","将图片或扫描件转成正文"], ["asr","语音转写","将录音转成可追溯文字"],
    ["extraction","知识抽取","提取实体、关系和来源"], ["embedding","检索向量","为证据检索建立索引"], ["sensitive","敏感信息检测","检查知识交付中的敏感内容"]
  ];
  const externalEmbedding = usesExternalEmbedding(config);
  $("#model-stages").innerHTML = roles.map(([role,title,purpose]) => {
    const item = current[role] || config.stages.find(s => s.role === role);
    const selected = state.modelCatalog.find(m => m.id === item?.id);
    const matchesCatalog = selected?.revision === item?.revision;
    const ready = item?.route === "wanx" ? item.available && Boolean(selected?.available && matchesCatalog) : item?.available;
    const status = item?.route === "legacy" ? "本地配置" : ready ? current[role] ? "使用时校验" : "已就绪" : "未就绪";
    const checked = current[role] && current.checked_at && ready ? `<small>上次检查 ${esc(date(current.checked_at))}</small>` : "";
    const details=[location(item),role==='extraction'?contextWindow(matchesCatalog?selected:item):''].filter(Boolean).join(' · ');
    const term = { extraction:'extraction', embedding:'vector-index' }[role];
    const transfer = role === 'embedding' && externalEmbedding ? `<p>${embeddingTransferNotice}</p>` : '';
    return `<article class="model-stage"><div><h3 title="${esc(purpose)}">${title}${term ? starxiaotuTermMarker(term) : ''}</h3></div><div><strong>${esc(item?.name || "未配置")}</strong>${details ? `<p>${details}</p>` : ""}${transfer}</div><div class="model-stage-meta"><span class="model-stage-status" data-ready="${Boolean(ready)}">${status}</span>${checked}</div></article>`;
  }).join("");
  for (const role of ["extraction"]) {
    const options = [...state.modelCatalog];
    if (!options.some(m => m.id === current[role]?.id)) options.unshift({...current[role], available:false});
    $("#model-"+role).innerHTML = options.map(m => `<option value="${esc(m.id)}" ${m.available ? "" : "disabled"}>${esc(m.name || m.model)} · ${esc(m.provider)} · ${m.location === "local" ? "本地" : "云端 / 外部"}${contextWindow(m)?` · ${contextWindow(m)}`:''}${m.available ? "" : "（当前配置，暂不可选择）"}</option>`).join("");
    $("#model-"+role).value = current[role]?.id || "";
  }
  $("#model-mode").value = current.mode === "automatic" ? "automatic" : "manual";
  // Processing uses fixed off independently of saved thinking preferences.
  renderThinkingOptions();
  updateModelControls();
}
function renderThinkingOptions() {
  $("#model-thinking").value = "off";
}
function updateModelControls() {
  const automatic = $("#model-mode").value === "automatic";
  $("#model-refresh").disabled = !!state.modelSaving;
  for (const id of ["model-mode", "model-extraction", "model-thinking", "model-save"]) $("#"+id).disabled = !!state.modelSaving || !state.modelConfig;
  $("#model-selectors").hidden = automatic;
  renderThinkingOptions();
  const pending = state.modelSync?.pending || 0;
  $("#model-sync").hidden = !pending;
  $("#model-sync-retry").disabled = !!state.modelSaving || state.modelSync?.revision !== state.modelConfig?.revision;
  $("#model-sync-status").textContent = pending ? `还有 ${pending} 个旧项目待切换到共用配置。` : "";
}
async function saveModels() {
  if (!state.modelConfig || state.modelSaving) return;
  const identity = state.identity;
  const mode = $("#model-mode").value;
  const revision = state.modelConfig.revision;
  const inference_options = {thinking_mode: "off"};
  const request = state.modelRequest;
  const status = $("#model-save-status");
  try {
    state.modelSaving = true; updateModelControls();
    const extraction = mode === "automatic" ? state.modelDefault?.id : $("#model-extraction").value;
    const model = state.modelCatalog.find(item => item.id === extraction && item.available);
    if (!model) throw {publicMessage:"请先选择万象中的可用模型。"};
    const cloud = model.location !== "local";
    if (cloud && !confirm(`确认所有星图使用云端 / 外部模型？\n${model.provider} · ${model.name}\n\n此配置适用于当前盒子上现有和新建的星图。抽取知识与检测敏感信息时，可能将未经脱敏的正文片段发送给所选服务。交付脱敏在返回结果时生效。\n\n是否继续检查并保存？`)) return;
    status.textContent = "正在用示例检查模型…";
    const check = await call("check-models", {scope:"default", config:{extraction,mode,inference_options,cloud_confirmations:cloud ? [model.revision] : []}}, null);
    if (state.invalid || identity !== state.identity || request !== state.modelRequest) return;
    if (!check?.check_id) throw {code:"MODEL_CHECK_REQUIRED"};
    status.textContent = "正在保存并应用到所有星图…";
    const saved = await call("save-models", {scope:"default", applyToAll:true, config:{expected_revision:revision, mode, check_id:check.check_id}}, null);
    if (state.invalid || identity !== state.identity) return;
    state.modelConfig = saved;
    state.modelSync = saved.modelSync?.pending ? {...saved.modelSync, revision:saved.revision} : null;
    renderModelEditor();
    $("#model-status").textContent = modelAvailability(saved.effective);
    status.textContent = state.modelSync ? "已保存共用配置。" : "已保存，所有星图的新任务将使用此配置。";
    void loadProcessingSummary();
  } catch (e) { if (!state.invalid && identity === state.identity) status.textContent = errorText(e); }
  finally { state.modelSaving = false; updateModelControls(); }
}
async function retryModelSync() {
  if (!state.modelSync || state.modelSaving || state.modelSync.revision !== state.modelConfig?.revision) return;
  const identity = state.identity;
  const {revision} = state.modelSync;
  const status = $("#model-save-status");
  state.modelSaving = true;
  updateModelControls();
  status.textContent = "正在切换旧项目…";
  try {
    const {modelSync} = await call("sync-models", {scope:"default", expectedRevision:revision}, null);
    if (state.invalid || identity !== state.identity) return;
    state.modelSync = modelSync.pending ? {...modelSync, revision} : null;
    status.textContent = state.modelSync ? "还有旧项目待切换，可以再试一次。" : "所有星图的新任务将使用此配置。";
    void loadProcessingSummary();
  } catch (e) { if (!state.invalid && identity === state.identity) status.textContent = errorText(e); }
  finally { state.modelSaving = false; updateModelControls(); }
}
const reprocessPlans = new Map();
async function reprocessModels() {
  if (!state.warehouseId) return;
  const warehouseId = state.warehouseId;
  if (reprocessPlans.get(warehouseId)?.running) return;
  const generation = state.generation;
  let plan = reprocessPlans.get(warehouseId);
  // Lock selection, confirmation and submission, including the list read.
  if (!plan) { plan = {running: true, batches: null, next: 0, accepted: 0}; reprocessPlans.set(warehouseId, plan); }
  else plan.running = true;
  try {
  if (!plan.batches || plan.rejected) {
  let documents = [];
    for(let offset=0; ;offset+=100){
      const result=await call("documents",{offset,limit:100});
      documents.push(...result.items);
      if (result.items.length<100 || documents.length>=result.total) break;
    }
  documents=documents.filter(d=>d.status==="ready" && d.active_version_id);
  if (plan.rejected) {
    const remaining = new Set(plan.batches.slice(plan.next).flatMap(b=>b.documents.map(d=>d.id)));
    documents=documents.filter(d=>remaining.has(d.id));
  }
  if (!documents.length) {toast("没有待提交的已解析材料。");reprocessPlans.delete(warehouseId);return;}
  if (generation !== state.generation) return;
  if (!confirm(`重新处理「${currentWarehouse()?.name}」中的 ${documents.length} 份材料？\n${actualModel(state.processing)}\n\n每份成功后替换知识关系，失败或取消保留原结果。云端配置会发送正文并产生用量。`)) return;
    plan.batches=[];plan.next=0;plan.rejected=false;
    for(let offset=0;offset<documents.length;offset+=100) plan.batches.push({
      documents:documents.slice(offset,offset+100).map(d=>({id:d.id,version_id:d.active_version_id})),
      expectedSignature:state.processing?.signature,operationId:crypto.randomUUID(),
    });
  } else if (!confirm(`继续上次未确认的重处理批次？已受理 ${plan.accepted} 份材料，不会重复提交；剩余批次使用上次确认的材料版本和模型配置。`)) return;
    while(plan.next<plan.batches.length){
      if (generation!==state.generation) return;
      const batch=plan.batches[plan.next];
      await call("reprocess-models",batch);
      plan.accepted+=batch.documents.length;plan.next++;
    }
    reprocessPlans.delete(warehouseId);
    toast("已创建重处理任务，可在任务中心查看实际模型与进度。");setView("tasks");void refresh();
  } catch(e){
    plan.rejected=definiteWriteRejection(e);
    toast(`已受理 ${plan.accepted} 份材料。${errorText(e)} 再次点击将继续剩余批次。`);
  } finally {
    plan.running=false;
    if (!plan.batches) reprocessPlans.delete(warehouseId);
  }
}
$("#model-mode").addEventListener("change",updateModelControls);
$("#model-extraction").addEventListener("change",updateModelControls);
$("#model-refresh").addEventListener("click",()=>{void loadStarxiaotuModel();void loadModels();});
$("#model-save").addEventListener("click",()=>void saveModels());
$("#model-sync-retry").addEventListener("click",()=>void retryModelSync());
$("#model-reprocess-all").addEventListener("click",()=>void reprocessModels());
if ($("#import-model-config")) $("#import-model-config").addEventListener("click",()=>{
  $("#import-dialog").close();
  setView("models");
});
