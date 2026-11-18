import { createWorkbenchHost, readWorkbenchReply } from "./native-workbench.js";
import { createOnboardingUI } from './onboarding.js';
import { onboardingUnavailable } from './onboarding-dialogue-state.mjs';
import { enterOnboardingWarehouse } from './onboarding-navigation.mjs';
import { conversationHTML } from './conversation.js';
import {changeUserInstruction} from './conversation-changes-view.mjs';
import {evidenceReferenceHTML} from './material-evidence-view.mjs';
import {materialReplySuggestions} from './conversation-view.mjs';
import {ConversationFlow} from './conversation-state.mjs';
import {mountMaterialWorkspace,openMaterialUpload} from './material-workspace.mjs';
import {readWarehouseMaterials,selectWarehouseMaterial,openWarehouseMaterial,startWarehouseMaterialDialogue} from './material-library.mjs';
import {openMaterialDelete} from './material-deletion.mjs';
import {continueMaterial,canContinueMaterial} from './material-continuation.mjs';
import {nextConversationStep} from './conversation-next.mjs';
import {currentCandidateGraph} from './conversation-candidate-graph.mjs';
let conversationFlow=null,conversationTimer=null,conversationReady=null,basicMaterialWarehouse=null;
function stopConversation(){clearTimeout(conversationTimer);document.getElementById('mw-upload-dialog')?.remove();document.getElementById('mw-delete-dialog')?.remove();conversationFlow?.dispose();conversationFlow=null;basicMaterialWarehouse=null;}
import { createSkillsUI } from "./native-skills.js";
import { icon, icons } from "./icons.js";
import { selectGraph, layoutGraph, edgeGeometry } from "./graph.js";
import { createGraphMotion } from './graph-motion.mjs';
const graphMotion = createGraphMotion();
import {createGraphPresentation, presentGraph} from './graph-presentation.mjs';
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
let onboardingReturn = { view: 'warehouses', ontologySection: 'published' };
const onboarding = createOnboardingUI({bridge,
  show: ({returningToRules, replacing}) => {
    if (!replacing && !(state.view === 'models' && state.modelOnboarding?.warehouseId === state.warehouseId)) {
      onboardingReturn = { view: state.view, ontologySection: state.ontologyCategory };
    }
    state.onboardingSection = returningToRules ? 'ontology' : 'warehouses';
    setView('onboarding');
    return state.view === 'onboarding';
  },
  enter: async (warehouse, {isCurrent, publication, view, quick}) => {
    if (!workbench.canLeave()) throw new Error('UNSAVED_CHANGES');
    try {
      await enterOnboardingWarehouse({warehouseId:warehouse.id,view,isCurrent,readWarehouses:()=>call('warehouses'),
        snapshot:()=>({...state}),select:(id,destination)=>selectWarehouse(id,destination,true),
        commit:items=>{state.warehouses=items;}});
      if (view === 'conversation') {
        await conversationReady;
        if (!isCurrent() || state.warehouseId !== warehouse.id || state.view !== view ||
            basicMaterialWarehouse !== warehouse.id && (!conversationFlow?.state.loaded || conversationFlow.state.warehouseMaterialError))
          throw new Error('WAREHOUSE_UNAVAILABLE');
        state.conversationPublication=publication || null;
        renderConversation();
      }
      if (isCurrent()) toast(quick?'数据仓已创建，可以导入资料。':'整理规则已发布。');
    } catch (error) {
      if (isCurrent() && state.view !== 'onboarding' && !state.invalid) setView('onboarding');
      throw error;
    }
  },
  openModels: async (warehouse, {required, isCurrent}) => {
    const handoff = {warehouseId:warehouse.id, required};
    try {
      await enterOnboardingWarehouse({warehouseId:warehouse.id,view:'models',isCurrent,readWarehouses:()=>call('warehouses'),
        snapshot:()=>({...state}),commit:items=>{state.warehouses=items;},select:(id,view)=>{
          state.modelOnboarding=handoff;
          $("#model-scope").value='warehouse';
          return selectWarehouse(id,view,true);
        }});
      onboarding.close();
      $("#model-onboarding-return").focus({preventScroll:true});
    } catch (error) {
      if (isCurrent() && state.modelOnboarding===handoff) state.modelOnboarding=null;
      throw error;
    }
  },
  leave: () => setView(onboardingReturn.view, false, onboardingReturn.ontologySection),
  onClose: () => { if (state.view !== 'onboarding') syncControls(); },
});
const typeDisplay = code => state.graphPresentation.entity(code);
const messages = {
  SKILL_ID_CONFLICT:"当前数据仓已存在同名 Skill，不会覆盖；请修改 ZIP 名称标识或先下载后删除旧版本。",
  SKILL_TOO_LARGE:"Skill ZIP 不能超过 4 MiB，解压文本最多 8 MiB。",
  SKILL_INVALID_REQUEST:"文件或请求格式不正确，请检查 SKILL.md 和确认名称。",
  SKILL_PACKAGE_PATH:"ZIP 含不安全路径或重复文件，请检查后重试。",
  SKILL_NOT_FOUND:"方法已删除或不属于当前数据仓，请刷新。",
  SKILL_REVISION_CONFLICT:"方法版本已变化，请重新读取后操作。",
  SKILL_REFERENCED:"还有方法依赖此 Skill，请先处理依赖或明确允许它们失效。",
  REASONING_DELIVERY_STALE:"方法、材料或检测规则已变化，请重新准备后试读。",
  REASONING_SCOPE_REQUIRED:"请勾选当前仓的资料后重新准备。",
  REASONING_SCOPE_CHANGED:"方法或材料版本已变化，请重新准备。",
  REASONING_PREPARATION_NOT_FOUND:"准备记录已失效或不属于当前账号、数据仓，请重新准备。",
  MODEL_SHARED_REQUIRED: "知识抽取与脱敏检测共用同一个模型，请刷新后统一设置。",
  MODEL_CLOUD_CONFIRMATION_REQUIRED: "请先确认所选在线服务将接收未经脱敏的正文片段。",
  MODEL_CONFIG_CONFLICT: "模型设置已更新，请刷新后重新确认。",
  MODEL_CHECK_REQUIRED: "模型检查已过期，请重新检查后保存。",
  MODEL_RELAY_UNAVAILABLE: "万象模型服务暂时无法连接，请检查连接后重试。",
  MODEL_AUTH_REQUIRED: "模型授权已失效，请重新连接万象。",
  MODEL_BILLING_REQUIRED: "云端模型因计费问题无法调用，请在模型设置选择可用的模型。",
  MODEL_UNAVAILABLE: "模型已停用或删除，请在万象检查模型配置。",
  MODEL_DEFAULT_UNAVAILABLE: "WANX 默认模型暂不可用，请在万象模型设置中检查默认模型。",
  MODEL_DEFAULT_NOT_CONFIGURED: "WANX 默认模型暂不可用，请在万象模型设置中检查默认模型。",
  MODEL_CONFIG_CHANGED: "模型服务配置已变化，请重新检查并确认。",
  MODEL_OPTIONS_INVALID: "思考模式参数无效，请重新选择。",
  MODEL_THINKING_UNSUPPORTED: "当前模型或万象版本不支持此思考模式，请刷新模型目录后选择。",
  MODEL_OPTIONS_UNCONFIRMED: "万象未确认思考模式，请更新万象后重新检查。",
  MODEL_INVALID_OUTPUT: "模型未返回符合要求的 JSON，请换模型或重试。",
  MODEL_CALL_FAILED: "模型检查或调用失败，请检查万象模型连接与输出能力。",
  MODEL_CANCELLED: "模型调用已取消。",
  MODEL_INPUT_TOO_LARGE: "本次模型输入超限，请缩小材料片段后重试。",
  SPACE_UPGRADE_REQUIRED: "当前设备尚不支持万象空间，请更新万象服务，或从电脑选择文件。",
  SPACE_REQUEST_FAILED: "万象空间暂时无法读取，请检查连接并刷新，或从电脑选择文件。",
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
  SEMANTICA_CONNECTION_FAILED: "当前连接不可用，请检查万象与盒子的连接后重试。",
  WAREHOUSE_BUSY: "当前数据仓正在处理或清理，可切换其他仓，或稍后重试。",
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
  invalid: false,
  view: "graph",
  ontologySection: "published",
  ontologyCategory: "published",
  documents: [],
  jobs: [],
  jobTotal: 0,
  jobOffset: 0,
  graph: { nodes: [], edges: [] },
  retrieval: null,
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
  importSource: "space",
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
  searching: false,
  searchRequest: 0,
  editing: false,
  saving: false,
  graphError: null,
  graphPresentation: createGraphPresentation(),
};
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
async function call(action, input) {
  if (
    state.preview &&
    [
      "import-skill", "delete-skill", "download-skill",
      "check-models", "save-models", "reprocess-models",
      "select-files",
      "select-space-files",
      "upload",
      "download",
      "save-sensitive",
      "correct",
      "retry-job",
      "build-index",
      "create-warehouse",
      "create-key",
      "revoke-key",
      "prepare-clear",
      "clear-warehouse",
      "prepare-delete",
      "delete-warehouse",
    ].includes(action)
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
  const reply = await bridge.call(action, {
    ...input,
    warehouseId: state.warehouseId,
  });
  const envelope = ['create-warehouse','reprocess-models'].includes(action);
  if (envelope && !reply?.ok) throw Object.assign(new Error(reply?.message || '请求结果尚未确认'), {
    code: reply?.code, status: reply?.status, publicMessage: reply?.message,
  });
  const result = envelope ? reply.value : reply;
  if (state.invalid)
    throw Object.assign(new Error("HOST_SESSION_EXPIRED"), {
      code: "HOST_SESSION_EXPIRED",
    });
  if (generation !== state.generation)
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
  const creationEnabled = canCreateWarehouse() && state.view !== "onboarding" && !onboarding.visible;
  bridge?.setCreationEnabled?.(creationEnabled);
  const warehouse = currentWarehouse();
  const suggestions = $("#page-ontology-suggestions");
  suggestions.hidden = state.view !== "conversation" || warehouse?.state !== "active" ||
    basicMaterialWarehouse === state.warehouseId || !(warehouse.document_count > 0 || state.documents?.length);
  suggestions.disabled = suggestions.hidden || importBlocked();
  const batchImport = $("#page-batch-import");
  batchImport.hidden = state.view !== "conversation" || basicMaterialWarehouse === state.warehouseId;
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
  $("#confirm-import").disabled =
    !state.ready || state.uploading || state.spaceSelecting ||
    (state.importContext === "conversation" ? state.files.length !== 1 || state.files[0].done : !state.files.some(canUploadFile));
  $("#choose-files").disabled = !state.ready || state.uploading || state.spaceSelecting ||
    (state.importContext === "conversation" && state.files.length > 0);
  $("#space-search-descendants").disabled = !state.ready || state.uploading || state.spaceSelecting ||
    state.spaceLoading || !$("#space-query").value.trim();
  $("#space-select-visible").disabled = !state.ready || state.uploading || state.spaceSelecting || state.spaceLoading;
  $("#space-load-more").disabled = $("#space-select-visible").disabled;
  $("#import-model-config").disabled = state.uploading || state.spaceSelecting;
  $("#import-link-existing").disabled = !state.ready || state.uploading || state.spaceSelecting || state.files.length > 0;
  document.querySelectorAll("#source-space,#source-computer,#space-refresh,#space-query,#space-entries input,#space-entries button,#space-breadcrumbs button,[data-remove-file]").forEach(el => {
    el.disabled = !state.ready || state.uploading || state.spaceSelecting || el.dataset.unsupported === "true" ||
      (state.spaceLoading && el.matches('[data-space-file]')) ||
      (state.importContext === "conversation" && el.matches('[data-space-file]') && state.files.length > 0 && !el.checked);
  });
  document
    .querySelectorAll("#import-dialog [data-close]")
    .forEach((b) => (b.disabled = state.uploading || state.spaceSelecting));
  $("#search-form button[type=submit]").disabled = !state.ready || state.searching || currentWarehouse()?.state !== "active";
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
      conversationFlow.saved.pending || conversationFlow.saved.upload || conversationFlow.saved.intakeSubmission || conversationFlow.saved.roundOpening));
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
  state.searching = state.saving = state.sourceLoading = false;
  state.modelOnboarding=null;
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
  state.conversationPublication=null;
  state.conversationOnboarding=null;
  renderConversation();
  state.runtime = null;
  state.processing = null; state.modelConfig = null; state.modelCatalog = []; state.modelRequest = (state.modelRequest || 0) + 1;
  state.documents = [];
  state.jobs = [];
  state.graph = { nodes: [], edges: [] };
  state.graphPresentation = createGraphPresentation();
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
  state.retrieval = null;
  state.identity = null;
  renderRetrieval();
  document.querySelectorAll("dialog[open]").forEach((d) => d.close());
  $("#source-body").replaceChildren();
  $("#source-actions").replaceChildren();
  $("#search-query").value = "";
  $("#search-results").replaceChildren();
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
  const options = {query: state.selectedNode ? "" : $("#graph-query").value, type: state.type, overview: state.graphOverview, focus: state.selectedNode, showIsolated: state.showIsolated};
  const key = JSON.stringify(options);
  if (graphViewCache?.graph !== state.graph || graphViewCache?.key !== key)
    graphViewCache = {graph:state.graph, key, value:layoutGraph(selectGraph(state.graph, options))};
  return graphViewCache.value;
}
function renderFilters() {
  const ts = [...new Set(state.graph.nodes.map((n) => n.type))];
  const filters = $("#graph-filters");
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
  if (state.view !== 'graph' || state.mode !== 'graph') { graphMotion.reset(); return; }
  const graph = visibleGraph();
  const counts = new Map(graph.nodes.map(n => [n.id, {relations:n.degree}]));
  graphMotion.schedule(graph, JSON.stringify([state.generation, state.warehouseId]), {
    counts, metric:'relations', max:Math.max(1, ...graph.nodes.map(n => n.degree)),
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
  $("#nodes-total").textContent = g.nodes.length;
  $("#graph-show-isolated").checked = state.showIsolated;
  $("#edges-total").textContent = g.edges.length;
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
  const groups = new Map();
  for (const e of g.edges) {
    const key = JSON.stringify([e.s,e.t].sort());
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e.id);
  }
  $("#graph-scene").innerHTML = '<g class="graph-space-floor" aria-hidden="true"></g><g class="graph-space-links">' + g.edges.map(e => {
    const a = positions.get(e.s), b = positions.get(e.t);
    const group = groups.get(JSON.stringify([e.s,e.t].sort()));
    const path = edgeGeometry(a,b,group.indexOf(e.id),group.length);
    const chosen = e.id === state.selectedEdge;
    const connected = state.selectedNode && (e.s === state.selectedNode || e.t === state.selectedNode);
    const labeled = chosen || connected || g.edges.length <= 12;
    return `<g class="graph-link ${connected ? "connected" : ""} ${chosen ? "chosen" : ""}"><title>${esc(node(e.s)?.name)} → ${esc(e.label)} → ${esc(node(e.t)?.name)}</title><path class="graph-edge-hit" d="${path.d}" data-edge="${esc(e.id)}"/><path class="graph-edge ${chosen ? "selected" : ""}" d="${path.d}" data-edge="${esc(e.id)}" marker-end="url(#${chosen ? "arrow-selected" : "arrow"})"/>${labeled ? `<text class="graph-edge-label" transform="translate(${path.x} ${path.y}) rotate(${path.angle})" text-anchor="middle" y="-7">${esc(e.label)}</text>` : ""}</g>`;
  }).join("") + '</g><g class="graph-space-nodes">' + g.nodes.map(n => {
    const selected = n.id === state.selectedNode;
    const match = $("#graph-query").value.trim() && n.name.toLocaleLowerCase().includes($("#graph-query").value.trim().toLocaleLowerCase());
    const display = typeDisplay(n.type);
    return `<g class="graph-node ${selected ? "selected" : ""} ${match ? "search-match" : ""}" data-node="${esc(n.id)}" transform="translate(${n.x} ${n.y})" style="--type-color:${display.color}" role="button" tabindex="0" aria-label="${esc(n.name)}，${esc(display.label)}，点击聚焦关联"><title>${esc(n.name)} · ${esc(display.label)} (${esc(n.type)})</title><circle class="node-star-hit" r="${n.r+8}"/><circle class="core node-star" r="${n.r}"/><text class="node-name" y="${n.r+20}">${n.lines.map((line,i) => `<tspan x="0" dy="${i ? 15 : 0}">${esc(line)}</tspan>`).join("")}</text></g>`;
  }).join("") + '</g>';
  transformScene();
  $(
    "#relation-list",
  ).innerHTML = `<table class="relation-table"><thead><tr><th>主体</th><th>关系</th><th>客体</th><th>来源</th></tr></thead><tbody>${g.edges
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
    !g.edges.length ? '<div class="empty">当前没有可显示的关系</div>' : ""
  }`;
  renderDetails(g);
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
    title = "创建你的第一座数据仓"; message = "导入资料后，星图会呈现其中的实体和关系。";
    actionName = "new-warehouse"; label = "新建数据仓";
  } else if (state.ready && (warehouse?.document_count !== 0 || warehouse?.active_jobs)) {
    const count = warehouse?.document_count;
    title = warehouse?.active_jobs ? "正在处理资料" : count > 0 ? "知识图谱尚未生成" : "正在读取数据仓状态";
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
    $("#graph-details").replaceChildren();
    return;
  }
  $("#graph-inspector-trail").innerHTML = `<button type="button" class="text-link" data-action="leave-graph-focus">${$("#graph-focus-back").textContent}</button>
    <span aria-hidden="true">›</span>${e ? `<button type="button" class="text-link" data-action="graph-entity-details">${esc(n?.name || "实体")}</button>
    <span aria-hidden="true">›</span><span>关系来源</span>` : `<span>${esc(n?.name || "相关关系")}</span>`}`;
  $(
    "#graph-details",
  ).innerHTML = `<div class="detail-top"><div class="type-line"><span>${
    n ? esc(typeDisplay(n.type).label) : "知识图谱"
  }</span><span>${n ? "实体详情" : "选择实体或关系"}</span></div><h2>${
    n ? esc(n.name) : "从一个节点开始"
  }</h2><p>${
    n
      ? "正在聚焦这个实体的直接关联。点击关系核对来源，或返回全图继续探索。"
      : "材料中的明确陈述形成知识关系，点击图中节点进行探索。"
  }</p></div><div class="detail-section"><div class="section-caption"><span>相关关系</span><span class="muted mono">${
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
  }</div><div class="detail-section"><div class="section-caption"><span>关系来源</span><span class="muted">${
    e ? e.evidence.length + " 个片段" : "尚未选择"
  }</span></div>${
    e
      ? e.evidence
          .map(
            (v, i) =>
              `<div class="source-card"><div class="source-title">${icon(
                "file",
              )}<span>${esc(
                doc(v.document_id)?.original_name || "来源材料",
              )}</span></div><p>${
                v.excerpt
                  ? highlight(v.excerpt, [node(e.s)?.name, node(e.t)?.name])
                  : "来源正在完成保护检测，请稍后刷新。"
              }</p><div class="source-bottom"><span>${esc(
                locator(v.locator_json),
              )}</span><button class="text-link" data-source="${esc(
                v.document_id,
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
const workbench = createWorkbenchHost({ call, warehouse: () => state.invalid ? null : state.warehouseId,
  container: () => $("#mw-editor-content")||$("#view-workbench"),
  onView: view => { if (!$('#mw-editor-dialog')&&workbench.has(state.view) && pages[view]) setView(view, true); },
  onImport: openMaterialFromWorkbench,
  onSource: (id, versionId) => showSource(id, null, versionId),
  onOntologySection: (section, category = section) => {
    state.ontologySection = section;
    state.ontologyCategory = category;
    if (state.view === "ontology") {
      updateCurrentNavigation();
      updatePageHeading();
    }
  },
});
let panelVisible = true;
bridge?.register?.({
  visible(value) { panelVisible = value; if (!value) graphMotion.reset(); },
  createWarehouse: () => action("new-warehouse").catch(error => toast(errorText(error))),
});
const pages = {
  onboarding: ["数据仓设置", "", ""],
  ontology: ["本体与关系", "", "查看数据仓会识别哪些实体，以及它们如何关联。"],
  review: ["知识核对", "REVIEW WITH EVIDENCE", "对照原始材料核对实体与关系，保留修改和发布依据。"],
  releases: ["版本历史", "KNOWLEDGE THROUGH TIME", "查看知识发布记录，对比变化，追溯每个版本的来源。"],
  skills: ["Skill 管理", "METHODS FOR YOUR KNOWLEDGE", "按数据仓保管推理方法，给其他 AI 应用可靠的分析路径。"],
  models: ["模型设置", "KNOW HOW YOUR KNOWLEDGE IS BUILT", "为当前数据仓或星图默认范围配置处理模型。"],
  warehouses: ["数据仓", "YOUR KNOWLEDGE SPACES", "查看各仓的资料、图谱和处理状态。"],
  data: [
    "数据管理",
    "YOUR KNOWLEDGE, YOUR CONTROL",
    "保管资料、管理知识，决定它们如何被使用。",
  ],
  graph: [
    "知识图谱",
    "A MAP OF WHAT YOU KNOW",
    "把你的资料，连成可追溯、可调用的知识。",
  ],
  conversation: ['资料库','IMPORT MATERIALS','导入资料，查看正文和知识处理进度。'],
  search: [
    "知识检索",
    "EVERY FINDING HAS A SOURCE",
    "使用问题或关键词检索材料中的证据。",
  ],
  tasks: [
    "处理任务",
    "FROM MATERIALS TO KNOWLEDGE",
    "查看当前仓的处理进度和失败原因。",
  ],
  sensitive: [
    "脱敏设置",
    "SHARE KNOWLEDGE WITH CARE",
    "为知识的使用与交付，设置清晰的边界。",
  ],
};
const ontologyHeadings = {
  "add-entity": ["添加实体类型", "设置要从材料中识别的实体及其属性。"],
  "add-relation": ["添加关系类型", "指定关系方向、可连接的实体类型及其属性。"],
  assistant: ["对话调整", "用对话修改类型、关系和属性。"],
  drafts: ["待发布草稿", "核对已保存的修改，再确认发布。"],
};
function updatePageHeading() {
  const [title, kicker, description] = pages[state.view];
  const [heading, subtitle] = state.view === "ontology" ? ontologyHeadings[state.ontologySection] ?? [title, description] : [title, description];
  $("#page-title").textContent = $("#crumb-current").textContent = heading;
  $("#page-kicker").textContent = kicker;
  $("#page-description").textContent = subtitle;
}
function updateCurrentNavigation() {
  document.querySelectorAll('[data-view], [data-ontology-action]').forEach(el => {
    const current = state.view === "onboarding"
      ? state.onboardingSection === "ontology" ? el.dataset.ontologyAction === "published" : el.dataset.view === "warehouses"
      : state.view === "ontology" ? el.dataset.view === "ontology" || el.dataset.ontologyAction === state.ontologyCategory : el.dataset.view === state.view;
    if (current) el.setAttribute("aria-current", "page");
    else el.removeAttribute("aria-current");
  });
}
function setView(view, fromWorkbench = false, ontologyAction, onboardingHandoff = false, materialDocumentId) {
  // This built-in panel exposes the migrated knowledge workflows only.
  if (['skills', 'api', 'data', 'sensitive', 'releases'].includes(view)) view = 'warehouses';
  if(view==='review'&&!fromWorkbench){if(!state.ready||state.invalid)return;view='conversation';}
  // Skill management is temporarily hidden; keep its implementation for later.
  if (view === "skills" || view === "api") view = "warehouses";
  if (!pages[view]) return;
  if (state.view === 'onboarding' && view !== 'onboarding' && !onboardingHandoff && onboarding.busy) return;
  const integrated = workbench.has(view);
  if ((integrated || view==='conversation') && !fromWorkbench && !state.warehouseId && state.ready && !state.invalid) {
    setView("warehouses");
    toast("请先选择或创建一座数据仓，再使用知识管理。");
    return;
  }
  if (integrated && !fromWorkbench && !workbench.show(view, ontologyAction)) return;
  const previousView = state.view;
  if (previousView === 'models' && view !== 'models') state.modelOnboarding=null;
  if (previousView === 'onboarding' && view !== 'onboarding' && !onboardingHandoff) onboarding.close();
  $(".page-heading").hidden = view === 'onboarding';
  const rulesMenu = $("#ontology-actions");
  rulesMenu.hidden = view !== "ontology";
  rulesMenu.open = false;
  $("#app").classList.toggle("is-setting-up", view === "onboarding");
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
    .forEach((el) => (el.hidden = el.id !== (integrated ? "view-workbench" : view === "onboarding" ? "onboarding-shell" : "view-" + view)));
  if (view === 'graph') transformScene();
  else graphMotion.reset();
  updateCurrentNavigation();
  updatePageHeading();
  $("#page-secondary").hidden = view !== "graph";
  const directory = view === "warehouses";
  $("#page-primary").hidden = directory ? typeof bridge?.setCreationEnabled === "function" : view !== "conversation" && view !== "search";
  $(".page-scroll").classList.toggle("workbench-page", integrated);
  $("#page-primary").dataset.action = directory ? "new-warehouse" : "import";
  $("#page-primary").innerHTML = icon("plus") + (directory ? "新建数据仓" : "导入资料");
  $("#crumb-current").hidden = true;
  $("#crumb-separator").hidden = true;
  renderWarehouses();
  renderProcessingSummary();
  syncControls();
  $(".page-scroll").scrollTop = 0;
  setNavigationOpen(false);
  if (view === "sensitive" && state.ready && state.warehouseId)
    void loadPolicy();
  if (view === "data") {
    renderManagement();
    if (previousView !== "data") void refreshManagementStats();
    if (currentWarehouse()?.state === "import_failed") void loadImportFailure(true);
  }
  if (view === "conversation") void loadConversation(materialDocumentId);
  if (view === "models") void loadModels();
  if (view === "skills") void skillsUi.load();
  if (view === "warehouses" || previousView === "warehouses" && view !== "onboarding") void refresh();
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
  const disclosureScope=JSON.stringify([state.generation,state.warehouseId,conversationFlow?.saved.conversationId,conversationFlow?.state.selectedIntent]);
  const disclosureState=new Map(conversationRoot.dataset.disclosureScope===disclosureScope
    ? [...conversationRoot.querySelectorAll('[data-cv-disclosure]')].map(el=>[el.dataset.cvDisclosure,el.open]):[]);
  const focus=document.activeElement,focusId=focus?.id?.startsWith('cv-')?focus.id:null;
  const selection=focusId&&typeof focus.selectionStart==='number'?[focus.selectionStart,focus.selectionEnd]:null;
  const scroll=$('#view-conversation .conversation-messages')?.scrollTop;
  const contextScroll=$('#view-conversation .conversation-context')?.scrollTop;
  const reviewScroll=$('#view-conversation .mw-review-content')?.scrollTop;
  const listScroll=$('#view-conversation .mw-material-list')?.scrollTop;
  const sourceScroll=$('#view-conversation .cv-source-review')?.scrollTop;
  const proposalStamp=JSON.stringify(conversationFlow?.changes.state.proposals.map(p=>[p.id,p.status])||[]);
  const newProposal=conversationRoot.dataset.proposalStamp!==proposalStamp;
  const materialStamp=JSON.stringify([conversationFlow?.state.librarySelection?.document.id,conversationFlow?.state.selectedIntent,nextConversationStep(conversationFlow)]);
  const newMaterialState=conversationRoot.dataset.materialStamp!==materialStamp;
  const markup=basicMaterialWarehouse && basicMaterialWarehouse===state.warehouseId ? basicMaterialLibrary() : conversationHTML(currentWarehouse(),state.conversationPublication,state.conversationOnboarding,
    !state.preview && state.identity?.dataScope==='personal',conversationFlow);
  if(conversationRoot._renderedMarkup===markup&&conversationRoot.dataset.disclosureScope===disclosureScope)return;
  conversationRoot.innerHTML=markup;conversationRoot._renderedMarkup=markup;
  mountMaterialWorkspace(conversationRoot);
  conversationRoot.querySelectorAll('[data-intake-segment]').forEach(el=>{el.style.height='auto';el.style.height=el.scrollHeight+'px';});
  if(sourceScroll!==undefined&&$('#view-conversation .cv-source-review'))$('#view-conversation .cv-source-review').scrollTop=sourceScroll;
  conversationRoot.dataset.disclosureScope=disclosureScope;
  conversationRoot.querySelectorAll('[data-cv-disclosure]').forEach(el=>{if(disclosureState.has(el.dataset.cvDisclosure))el.open=disclosureState.get(el.dataset.cvDisclosure);});
  if(focusId){const next=document.getElementById(focusId);next?.focus({preventScroll:true});if(selection&&next?.setSelectionRange)next.setSelectionRange(...selection);}
  if(scroll!==undefined&&$('#view-conversation .conversation-messages'))$('#view-conversation .conversation-messages').scrollTop=scroll;
  if(contextScroll!==undefined&&$('#view-conversation .conversation-context'))$('#view-conversation .conversation-context').scrollTop=contextScroll;
  if(reviewScroll!==undefined&&$('#view-conversation .mw-review-content'))$('#view-conversation .mw-review-content').scrollTop=newMaterialState?0:reviewScroll;
  if(listScroll!==undefined&&$('#view-conversation .mw-material-list'))$('#view-conversation .mw-material-list').scrollTop=listScroll;
  if(!['cv-goal','cv-instructions','cv-message'].includes(focusId)&&!focusId?.startsWith('cv-source-')){
    if(newProposal&&conversationFlow?.changes.state.proposals.length)focusConversationCard('.cv-proposal-current');
    else if(newMaterialState&&conversationFlow?.state.detail){
      focusConversationCard('.cv-conversation-actions');
      focusConversationCard('.mw-confirm-card');
    }
  }
  conversationRoot.dataset.proposalStamp=proposalStamp;
  conversationRoot.dataset.materialStamp=materialStamp;
}
function basicMaterialLibrary() {
  const rows=state.documents.map(item=>`<li><button type="button" class="text-link" data-source="${esc(item.id)}">${esc(item.original_name||item.name)}</button></li>`).join('');
  return `<section class="mw-welcome"><header><strong>资料</strong></header>
    ${rows?`<ul>${rows}</ul>`:'<p class="empty">导入第一份资料，即可开始整理。</p>'}
    <p class="wp-muted">当前盒子支持导入和查看原文。建仓与资料对话需要盒端提供相应服务。</p></section>`;
}
async function loadConversation(materialDocumentId) {
  stopConversation();
  const request=state.conversationRequest=(state.conversationRequest||0)+1;
  const {identity,generation,warehouseId}=state;
  const isCurrent=()=>state.ready && !state.invalid && state.identity===identity && state.generation===generation &&
    state.warehouseId===warehouseId && state.conversationRequest===request && state.view==='conversation';
  state.conversationOnboarding=null;
  if(!isCurrent() || !warehouseId || currentWarehouse()?.state !== 'active' || state.preview || identity?.dataScope!=='personal'){renderConversation();return;}
  const flow=conversationFlow=new ConversationFlow({warehouseId,identity,storage:window.localStorage,isCurrent,
    call:async(action,input)=>{const reply=await call(action,input);return action.startsWith('conversation-')||action==='workbench-request'?readWorkbenchReply(reply):reply;},onChange:()=>renderConversation()});
  flow.state.materialPage='import';
  conversationReady=flow.load().then(async()=>{
    if(flow!==conversationFlow||!isCurrent())return;
    if(!flow.state.loaded&&onboardingUnavailable(flow.state.errorCode)){
      try{
        const documents=await call('documents',{limit:100});
        if(isCurrent()&&Array.isArray(documents?.items)){
          state.documents=documents.items;basicMaterialWarehouse=warehouseId;renderConversation();
        }
      }catch(error){if(isCurrent())banner(errorText(error));}
      return;
    }
    if(!flow.state.loaded)return;
    await flow.materials();
    if(flow.saved.roundOpening&&!flow.saved.pending)await flow.rounds.finish();
    else if(!flow.saved.pending&&!flow.saved.upload&&!flow.saved.intakeSubmission) {
      if (materialDocumentId) await flow.importer.select(materialDocumentId);
      else await flow.importer.first();
    }
    else if(flow.saved.pending?.input.documentId)await flow.run(()=>flow.importer.read(flow.saved.pending.input.documentId));
  });
  const poll=async()=>{
    if(flow!==conversationFlow||!isCurrent())return;
    try{if(!$('#mw-editor-dialog')){if(flow.state.materialPage==='import')await flow.importer.tick();else{await flow.tick();await flow.changes.tick();}}}
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
  dialog.innerHTML=`<header><div><h2 id="mw-editor-title">${importing?'核对当前材料结果':'修改当前材料与本体'}</h2><p>${importing?'核对实体、关系和证据；确认发布前，原有已发布结果保持不变。':'保存后返回本材料继续对话；确认发布后才更新知识。'}修改本体规则不会自动重抽其他材料。</p></div><button class="btn btn-secondary" type="button">${importing?'返回资料管理':'返回材料对话'}</button></header><div id="mw-editor-content"></div>`;
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
$('#view-conversation').addEventListener('input',event=>{
  if(!conversationFlow)return;const s=conversationFlow.state;
  if(event.target.id==='cv-message')s.input=event.target.value;
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
  if(event.target.id==='cv-candidate-focus'&&conversationFlow){const g=currentCandidateGraph(conversationFlow);if(g){g.focus=event.target.value;g.selected=null;g.zoom=1;conversationFlow.emit();}}
  if(event.target.id==='cv-session'&&event.target.value)void conversationFlow?.select(event.target.value);
  if(event.target.id==='cv-message-mode'&&conversationFlow)conversationFlow.state.messageMode=event.target.value;
  if(event.target.id==='cv-source-page-size'&&conversationFlow)conversationFlow.intake.changePageSize(Number(event.target.value));
  if(event.target.dataset.cvItem)conversationFlow?.changes.select(event.target.dataset.cvItem,event.target.checked);
  if(event.target.dataset.cvIssue)conversationFlow?.changes.selectIssue(event.target.dataset.cvIssue,event.target.checked);
});
$('#view-conversation').addEventListener('submit',event=>{
  if(!conversationFlow)return;event.preventDefault();
  if(event.target.id==='cv-message-form'){conversationFlow.state.input=$('#cv-message').value;void conversationFlow.submitInput();}
  if(event.target.id==='cv-fact-filter')conversationFlow.changes.filterFacts($('#cv-fact-keyword').value,$('#cv-fact-type').value);
  if(event.target.id==='cv-goal-form'){
    const f=conversationFlow;
    void f.goal().then(()=>{if(f===conversationFlow&&!f.state.error&&f.state.detail?.status==='ready_for_confirmation')focusConversationCard('#cv-inline-rules');});
  }
});
$('#view-conversation').addEventListener('click',event=>{
  const el=event.target.closest('[data-cv]'),f=conversationFlow;if(!el||!f||el.disabled)return;
  const commandName=el.dataset.cv,offset=f.state.candidates?.offset||0,mergeOffset=f.state.merge?.plan.offset||0;
  if(commandName==='import-dialogue'||commandName==='material-dialogue'&&f.state.materialPage==='import')return;
  if(['candidate-inspect','candidate-zoom-in','candidate-zoom-out','candidate-zoom-reset'].includes(commandName)){
    const g=currentCandidateGraph(f);if(!g)return;
    if(commandName==='candidate-inspect'){
      if(!/^\d+$/.test(el.dataset.id||'')||!g.items[Number(el.dataset.id)])return;
      g.selected=el.dataset.id;
    }else g.zoom=commandName==='candidate-zoom-reset'?1:Math.max(1,Math.min(3,g.zoom+(commandName==='candidate-zoom-in' ? .25 : -.25)));
    f.emit();if(commandName==='candidate-inspect')focusConversationCard('.cv-network-detail');return;
  }
  const commands={new:()=>f.create(),refresh:()=>f.refresh(),more:()=>f.more(),send:()=>f.submitInput(),upload:()=>openMaterialUpload(f),
    'reply-suggestion':()=>{const text=materialReplySuggestions(f)[Number(el.dataset.id)];if(!text)return;f.state.input=f.state.input.trim()?f.state.input+'\n'+text:text;f.saveMaterialComposer();f.emit();$('#cv-message')?.focus();},
    'material-source':()=>f.agent.reviewSource(),'material-auto':()=>f.agent.prepareAutomatic(),'material-auto-confirm':()=>f.agent.confirmAutomatic({previewId:el.dataset.previewId,replacementAcknowledgement:el.dataset.replacementAcknowledgement}),'material-dialogue':()=>f.agent.dialogue(),
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
    'library-start':()=>startWarehouseMaterialDialogue(f),'library-select':()=>f.state.materialPage?f.importer.select(el.dataset.id):selectWarehouseMaterial(f,el.dataset.id),'library-more':()=>f.run(()=>readWarehouseMaterials(f,true)),
    'import-refresh':()=>f.importer.refresh(),
    'import-confirm':()=>f.importer.confirm(),'import-auto':()=>f.importer.automatic(),'import-review':()=>f.importer.review((id,target)=>f===conversationFlow&&openConversationReview(id,target)),
    'material-review':()=>f.importer.reviewAutomatic((id,target)=>f===conversationFlow&&openConversationReview(id,target)),
    'import-index-retry':()=>f.importer.retryIndex(),
    'import-close-dialogue':()=>f.importer.exitDialogue(),'import-prev':()=>f.importer.page(-1),'import-next':()=>f.importer.page(1),
    'import-auto-switch':()=>f.importer.switchAutomatic(),
    'round-start':()=>f.rounds.start(),'round-resume':()=>f.rounds.resume(),
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
    release:()=>f.release(),ontology:()=>{f.changes.setTarget('rules');f.state.composerContext='rules';f.state.messageMode='auto';f.emit();$('#cv-message')?.focus();},'open-review':()=>canContinueMaterial(f)?continueMaterial(f,'draft'):f.changes.openDraft(),
    'change-refresh':()=>f.changes.refresh(),'change-more':()=>f.changes.more(),'change-apply':()=>f.changes.apply(el.dataset.id),
    'change-recover':()=>f.changes.recover(),'change-suggest':()=>{f.changes.setTarget('rules');return f.changes.generate('仅调整本体规则：依据当前材料和目标，提出少量必要的类型、关系或属性；优先复用已有结构，不修改目标或材料事实。');},
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
    if(f.state.openDraft){f.state.openDraft=null;await f.changes.openDraft();}
    if(f.state.openMaterialEditor===f.state.selectedIntent&&!f.state.error&&!f.saved.pending)await f.changes.editMaterial();
    if(f.state.openDetailedEditor&&f.state.openDetailedEditor===f.state.detail?.document_id&&!f.state.error&&!f.saved.pending){f.state.openDetailedEditor=false;await openConversationReview(f.state.detail?.document_id);}
    if(f!==conversationFlow)return;
    const target={'stage-1':'.cv-goal-card','stage-2':'#cv-inline-rules','stage-3':'#cv-inline-knowledge',
      'round-history':'.mw-round-history','round-history-view':'.mw-round-transcript',
      'import-refresh':'.mw-refresh-feedback',
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
  running: "处理中",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
};
function renderTasks() {
  const active = state.jobs.filter(j => j.status === "running" || j.status === "queued").length;
  const failed = state.jobs.filter(j => j.status === "failed").length;
  $("#jobs-page-summary").textContent = state.jobs.length ? `本页待处理或处理中 ${active} 项 · 失败 ${failed} 项` : "";
  const rows = $("#tasks-body");
  const openModels = new Set([...rows.querySelectorAll(".task-model-details[open]")].map(item => item.dataset.jobId));
  rows.innerHTML =
    state.jobs
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
          )}</strong><p class="task-document">${esc(j.document_name || doc(j.document_id)?.original_name || "当前数据仓")}</p>
          <p class="task-progress">${esc(jobStates[j.stage] || jobNames[j.stage] || j.stage || jobStates[j.status] || "等待处理")}${
            j.total_units ? " · " + (j.completed_units ?? 0) + " / " + j.total_units + " 单元" : ""
          }</p>${j.error_message ? `<p class="task-error">${esc(j.error_message)}</p>` : ""}
          <details class="task-model-details" data-job-id="${esc(j.id)}" ${openModels.has(String(j.id)) ? "open" : ""}>
            <summary>模型与用量</summary><p class="model-actual">${esc(actualModel(j.metrics?.processing, j.kind === "sensitive_scan" ? "sensitive" : "extraction"))}${j.metrics?.model_calls?.length ? " · 用量：" + esc(modelUsage(j.metrics.model_calls)) : ""}</p>
          </details>${
            j.knowledge_summary
              ? `<p>候选 ${
                  j.knowledge_summary.candidate_relations ??
                  j.knowledge_summary.total_candidates ??
                  0
                } · 入图 ${
                  j.knowledge_summary.published_relations ?? 0
                } 条关系</p>`
              : ""
          }</div><div class="task-end"><span class="pill ${
            j.status === "succeeded"
              ? "green"
              : j.status === "failed"
              ? "error"
              : "amber"
          }">${
            jobStates[j.status] || esc(j.status)
          }</span><span class="mono">${date(j.updated_at)}</span>${
            j.status === "failed"
              ? `<button class="text-link" data-retry="${esc(
                  j.id,
                )}">重试</button>`
              : ""
          }</div></article>`,
      )
      .join("") || '<div class="empty">当前没有处理任务。</div>';
  $("#jobs-label").textContent = state.jobTotal;
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
    const [d, j, g, r, w, ontology] = await Promise.allSettled([
      scoped ? call("documents", { limit: 100 }) : Promise.resolve({items:[]}),
      scoped ? call("jobs", { offset: state.jobOffset }) : Promise.resolve({items:[],total:0}),
      scoped ? call("graph") : Promise.resolve({nodes:[],edges:[]}),
      scoped ? call("retrieval") : Promise.resolve(null),
      call("warehouses"),
      scoped ? call('conversation-ontologies').then(readWorkbenchReply).then(result => {
        if (!Array.isArray(result?.items)) throw Object.assign(new Error('SEMANTICA_INVALID_RESPONSE'), {code:'SEMANTICA_INVALID_RESPONSE'});
        return result.items.find(item => item.status === 'published')?.schema || null;
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
    const schema = ontology.status === 'fulfilled' ? ontology.value : null;
    state.graphPresentation = createGraphPresentation(schema);
    if (g.status === "fulfilled") {
      const fingerprint = JSON.stringify([g.value, schema]);
      if (fingerprint !== state.graphFingerprint) {
        const first = !state.graphFingerprint;
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
    if (r.status === "fulfilled") {
      state.retrieval = r.value;
      renderRetrieval();
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
    const failed = [d, j, r, w].find((v) => v.status === "rejected");
    const directory = state.view === "warehouses";
    if (failed && !directory) banner(errorText(failed.reason));
    else if (ontology.status === 'rejected' && !directory) banner('当前仓库本体名称读取失败，图谱暂按原始类型编码显示；请重新读取。');
    else if (!state.graphError) banner("");
    if (currentWarehouse()?.state !== "active") {
      state.documents = [];
      state.jobs = [];
      state.graph = { nodes: [], edges: [] };
      state.graphPresentation = createGraphPresentation();
      state.jobTotal = 0;
      state.graphFingerprint = null;
      state.source = null;
      state.policy = null;
      state.retrieval = null;
      state.graphError = {
        publicMessage: currentWarehouse()?.state === "import_failed"
          ? "迁入未完成，图谱暂不可读取。请到数据管理查看失败原因。"
          : "数据仓正在处理或清理，完成后可继续查看图谱。",
      };
      $("#source-dialog").close();
      $("#source-body").replaceChildren();
      $("#source-actions").replaceChildren();
      $("#search-results").replaceChildren();
      if (!directory) banner(currentWarehouse()?.state === "clear_failed"
        ? "当前数据仓清理未完成，请到数据管理查看；其他数据仓仍可正常使用。"
        : currentWarehouse()?.state === "import_failed"
          ? "当前数据仓迁入未完成，材料和图谱暂不可读取。请到数据管理查看失败原因。"
          : "数据仓正在处理或清理，请稍后重试。");
    }
    renderTasks();
    renderFilters();
    renderGraph();
    renderManagement();
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
function renderRetrieval() {
  const r = state.retrieval;
  const status = $("#search-index-state");
  if (r?.compatible && r?.fresh) {
    status.innerHTML = `<span class="index-state-ready">${icon("check")} 索引已就绪</span>`;
  } else if (!r) {
    status.textContent = "暂未读取到检索索引状态";
  } else if (r.items?.some(item => item.status === "building" && ["queued", "running"].includes(item.job_status))) {
    status.textContent = "正在建立检索索引，完成后即可查询。";
  } else if (r.embedding_configured === false) {
    status.textContent = "检索向量模型尚未配置，请查看模型设置。";
  } else if (r.publishable_segments === 0) {
    status.textContent = "等待材料解析，解析完成后可建立索引。";
  } else {
    status.innerHTML = `<span>${r.active ? "材料已更新" : "材料已解析"}</span>
      <button type="button" class="text-link" data-action="build-index">${r.active ? "更新索引" : "建立索引"}</button>`;
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
    state.preview = v.identity.connection === "preview";
    state.retrieval = v.retrieval;
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
    renderRetrieval();
    await selectWarehouse(
      state.warehouseId || rememberedWarehouse() ||
        state.warehouses.find((w) => w.state === "active")?.id ||
        state.warehouses[0]?.id || null,
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
  if (onboarding.visible) setView(onboardingReturn.view, false, onboardingReturn.ontologySection);
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
    const view = unavailable || target.view === "skills" ? "warehouses" : target.view;
    const selected = view === "warehouses" && (!target.warehouseId || unavailable) ? null : warehouseId;
    await selectWarehouse(selected, view);
    if(target.documentId&&!unavailable){
      const flow=conversationFlow;await conversationReady;
      if(lastLaunchRequest!==value.requestId||!flow||flow!==conversationFlow||!flow.state.loaded||state.warehouseId!==selected)throw new Error('WAREHOUSE_CHANGED');
      if(!await openWarehouseMaterial(flow,target))throw new Error('MATERIAL_TARGET_UNAVAILABLE');
    }
    ok = !state.invalid && state.ready && !state.uploading &&
      state.view === view && state.warehouseId === selected;
    if (ok && unavailable) toast("指定数据仓当前不可用，已打开数据仓列表。清理或删除状态可在管理中查看。");
  } catch (error) { toast("无法打开指定数据仓：" + errorText(error)); }
  finally {
    if (lastLaunchRequest === value.requestId)
      await call("launch-target-applied", { requestId: value.requestId, ok }).catch(() => {});
  }
}
async function runSearch(annotationAfter) {
  if (!state.ready || state.invalid || currentWarehouse()?.state !== "active") return;
  const generation = state.generation;
  const prior = state.searchResult;
  const query = annotationAfter ? prior?.query : $("#search-query").value.trim();
  if (!query) return;
  if (annotationAfter && (state.searching || prior.generation !== generation ||
    prior.reply.annotationSearch?.nextCursor !== annotationAfter)) return;
  if (!annotationAfter) state.searchResult = null;
  const request = state.searchRequest = (state.searchRequest || 0) + 1;
  state.searching = true;
  const button = $("#search-form button[type=submit]");
  button.disabled = true;
  if (!annotationAfter) $("#search-results").innerHTML = '<div class="empty">正在检索当前版本的材料…</div>';
  const more = $("#search-more-annotations");
  if (more) more.disabled = true;
  try {
    const result = await call("search", { query, ...(annotationAfter ? {annotationAfter} : {}) });
    if (
      state.invalid ||
      generation !== state.generation ||
      request !== state.searchRequest ||
      currentWarehouse()?.state !== "active"
    )
      return;
    let r = result;
    if (annotationAfter) {
      const documents = new Map((prior.reply.annotationDocuments || []).map(item => [item.documentId, item]));
      const nativeIds = new Set((prior.reply.items || []).map(item => item.document_id));
      for (const document of result.annotationDocuments || []) {
        if (!nativeIds.has(document.documentId)) documents.set(document.documentId, document);
      }
      r = {...prior.reply, annotationDocuments:[...documents.values()], annotationSearch:{...result.annotationSearch,
        verificationIncomplete: prior.reply.annotationSearch.verificationIncomplete ||
          (result.annotationSearch?.verificationIncomplete ?? result.annotationSearch?.incomplete)}};
    }
    state.searchResult = {generation, query, reply:r};
    const items = [
      ...(r.items || []),
      ...(r.annotationDocuments || []).map(document => ({
        document_id: document.documentId,
        document_version_id: document.versionId,
        original_name: document.title,
        spaceFolderPath: document.folderPath,
        text: "打开来源查看对应版本。",
        channels: ["space-tag"],
      })),
    ];
    const channels = { vector: "向量", keyword: "关键词", graph: "知识关系", "space-tag": "空间标签" };
    $("#search-results").innerHTML =
      `<div class="results-summary"><span>找到 <b class="mono">${
        items.length
      }</b> 项相关结果</span><span class="muted small">当前材料版本</span></div>${
        r.sensitive?.withheld
          ? `<div class="inline-error">${r.sensitive.withheld} 条内容尚未完成保护检测，暂不交付。</div>`
          : ""
      }${(r.annotationSearch?.verificationIncomplete ?? r.annotationSearch?.incomplete) ? '<p class="modal-warning" role="status">部分空间标签尚未核验，检索结果可能不完整。</p>' : ""}${r.message ? `<p class="modal-warning">${esc(r.message)}</p>` : ""}${
        r.graph_warning
          ? `<p class="modal-warning">${esc(r.graph_warning)}</p>`
          : ""
      }` +
      items
        .map(
          (v) =>
            `<article class="result-card"><header class="result-meta"><h3>${icon("file")}${esc(
              v.original_name || doc(v.document_id)?.original_name || "来源材料",
            )}</h3><span>${esc(locator(v.locator))}</span></header>${
              v.spaceFolderPath ? `<p class="muted small">空间目录 · ${esc(v.spaceFolderPath)}</p>` : ''
            }${
              v.spaceSourceStatus ? `<small class="muted">${v.spaceSourceStatus === 'updated' ? '空间原文件已更新 · 此处引用先前导入的正文' : '与空间原文件一致'}</small>` : ''
            }<p>${highlight(v.text, [
              query,
              ...(v.matched_entities || []),
            ])}</p><div class="result-footer"><div class="result-channels">${v.matched_entities?.length ? `<span class="result-entities">${esc(v.matched_entities.join(" · "))}</span>` : ""}${(
              v.channels || []
            )
              .map((c) => `<span class="pill">${esc(channels[c] || c)}</span>`)
              .join("")}</div><button class="text-link" data-source="${esc(
              v.document_id,
            )}" data-source-version="${esc(v.document_version_id || v.version_id || '')}" data-source-location="${esc(locator(v.locator))}" data-source-start="${
              citationStart(v.locator) ?? ""
            }" data-source-segment="${esc(citationSegment(v))}" data-source-offset="${citationOffset(v.locator)}">查看来源 ${icon("external")}</button></div></article>`,
        )
        .join("") +
      (!items.length
        ? '<div class="empty">没有找到符合当前版本与交付规则的证据。</div>'
        : "") +
      (r.annotationSearch?.nextCursor ? '<button id="search-more-annotations" class="btn btn-secondary" type="button">显示更多空间标签结果</button>' : "");
  } catch (e) {
    if (generation !== state.generation || request !== state.searchRequest || state.invalid) return;
    if (annotationAfter && e.code !== 'SPACE_TAG_RESULTS_CHANGED') {
      $("#search-more-error")?.remove();
      $("#search-results").insertAdjacentHTML('beforeend', `<p id="search-more-error" role="alert">${esc(errorText(e))}</p>`);
    } else {
      state.searchResult = null;
      $("#search-results").innerHTML = '<div class="empty subpage-error" role="alert">' +
        esc(e.code === 'SPACE_TAG_RESULTS_CHANGED' ? '空间标签结果已变化，请重新检索。' : errorText(e)) + '</div>';
    }
    if (["SEMANTICA_INDEX_REQUIRED", "SEMANTICA_INDEX_STALE"].includes(e.code)) void refresh();
  } finally {
    if (generation === state.generation && request === state.searchRequest) {
      state.searching = false;
      button.disabled = !state.ready || currentWarehouse()?.state !== "active";
      if (more?.isConnected) more.disabled = false;
    }
  }
}
async function sourceRange(id, versionId, start = 0, end) {
  const page = await call("document-text", { id, versionId, start, ...(end === undefined ? {} : {end}) });
  if (page.document_id !== id || page.version_id !== versionId || page.start !== start ||
      (end !== undefined && page.end !== end)) {
    throw Object.assign(new Error("SOURCE_VERSION_CONFLICT"), {
      publicMessage: "无法核对引用的正文版本，请重新检索后打开来源。",
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
    $("#source-actions").innerHTML = '<button class="btn btn-secondary" data-close="source-dialog">关闭</button>';
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
      published: "知识图谱就绪",
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
    }<p class="model-actual">实际知识处理：${esc(actualModel(d.processing))}</p><article class="source-page">${
      s.segments
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
        .join("") || "<p>材料仍在处理中，正文将在解析后显示。</p>"
    }${
      s.segments.length < total
        ? `<button class="load-more-button" data-action="source-more" ${state.sourceLoading || state.saving || state.editing ? "disabled" : ""}>${state.sourceLoading ? "正在读取…" : "加载更多片段"}</button>`
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
function renderImportSource() {
  const space = state.importSource === "space";
  $("#space-browser").hidden = !space;
  $("#computer-browser").hidden = space;
  for (const [id, selected] of [["#source-space", space], ["#source-computer", !space]]) {
    $(id).classList.toggle("active", selected);
    $(id).setAttribute("aria-pressed", String(selected));
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
    : !items.length ? (query ? "当前文件夹没有匹配的文件。" : "此文件夹还没有文件，可先在万象空间上传，或从电脑选择。") : "";
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
$("#source-space").addEventListener("click", () => {
  state.importSource = "space";
  renderImportSource();
});
$("#source-computer").addEventListener("click", () => {
  state.importSource = "computer";
  renderImportSource();
});
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
  if (file.done) return file.reused ? "已复用仓内材料" : "已交给盒端处理";
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
        )}<small>${f.source === "space" ? "万象空间" : "电脑文件"}${f.folderPath ? " · " + esc(f.folderPath) : ""}</small></span><span class="file-meta mono">${bytes(
          f.size,
        )}</span><button class="text-link" data-remove-file="${esc(f.handle)}" aria-label="${batch && needsNewFileSelection(f) ? "移除旧选择" : "移除"} ${esc(f.name)}">${batch && needsNewFileSelection(f) ? "移除旧选择" : "移除"}</button><span class="file-state${f.error ? " file-state-error" : ""}" data-import-status="${esc(f.handle)}">${esc(pendingFileStatus(f))}</span></div>`,
    )
    .join("");
  $("#confirm-import").textContent = state.uploading
    ? "正在导入…"
    : !batch ? state.files.some(f => f.error) ? "重试未完成的导入" : "导入并核对"
    : retry && state.files.filter(canUploadFile).length === retry ? `重试 ${retry} 份`
    : "导入并处理";
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
      f.reused = r.reused === true;
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
    const created = state.files.length - reused;
    $("#import-dialog").close();
    setView("conversation");
    toast(reused
      ? `已复用仓内 ${reused} 份材料。${created ? `新导入 ${created} 份，可在任务中心查看进度。` : ""}`
      : "材料已导入，正在按当前模型配置整理。可在任务中心查看进度。");
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
  const toggle = $(".starlink-module .mobile-toggle");
  const focusedInRail = toggle.getClientRects().length > 0 && rail.contains(document.activeElement);
  $("#app").classList.toggle("nav-open", open);
  toggle.setAttribute("aria-expanded", String(open));
  if (open) $(".starlink-rail [aria-current=page]")?.focus();
  else if (restoreFocus || focusedInRail) toggle.focus();
}

async function action(name) {
  if (await warehouseAction(name)) return;
  if (name === "nav") setNavigationOpen(!$("#app").classList.contains("nav-open"), true);
  else if (name === "help") $("#help-dialog").showModal();
  else if (name === "graph-tasks") setView("tasks");
  else if (name === "reload-materials") {
    if (state.view === "conversation" && !conversationFlow?.state.loaded && !conversationFlow?.state.busy) await loadConversation();
  }
  else if (name === "close-graph-details") {
    state.detailsDismissed = true;
    $(".graph-inspector").hidden = true;
    $("#graph-focus-back").focus({ preventScroll: true });
  } else if (name === "leave-graph-focus") {
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
      state.importSource = "space";
      state.importContext = context;
      $("#import-intro").textContent = state.importContext === "conversation"
        ? "选择一份材料导入当前数据仓；导入后先核对正文，再确认后续整理。"
        : "材料将导入当前数据仓，按所选模型配置整理为可追溯的知识。";
      $("#import-warning").textContent = state.importContext === "conversation"
        ? "确认后读取文件副本并准备正文。万象空间原文件保持不变；后续抽取与发布仍需单独确认。"
        : "点击“导入并处理”后读取文件副本，由模型整理。万象空间原文件保持不变；后续修改不会自动同步。";
      $("#import-note-field").hidden = state.importContext !== "conversation";
      $("#import-link-existing").hidden = state.importContext !== "conversation";
      if (context === "conversation" && !state.files.length) $("#import-note").value = "";
      $("#import-selection-hint").textContent = state.importContext === "conversation" ? "每次选择一份材料" : "可跨文件夹选择";
      $("#import-error").hidden = true;
      $("#import-context").textContent = `万象空间 · ${state.identity?.boxName || state.identity?.boxId || "当前设备"} → ${currentWarehouse()?.name || "当前数据仓"}`;
      renderImportSource();
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
  } else if (name === 'graph-rotate-left' || name === 'graph-rotate-right') {
    graphMotion.rotate(name === 'graph-rotate-left' ? -.32 : .32);
  } else if (name === "edit-source") {
    state.editing = true;
    renderSource();
  } else if (name === "save-correction") await saveCorrection();
  else if (name === "source-more" || name === "source-previous") await sourceMore(name === "source-previous");
  else if (name === "download-source") {
    const r = await call("download", { id: state.source.document.id });
    if (r.saved) toast("材料原件已保存。");
  } else if (name === "build-index") {
    const generation = state.generation;
    await call("build-index", { operationId: crypto.randomUUID() });
    if (state.invalid || generation !== state.generation) return;
    toast("索引任务已提交。");
    await refresh();
  }
}
document.addEventListener("click", (event) => {
  const rulesMenu = $("#ontology-actions");
  const el = event.target.closest("button,[data-node],[data-edge]");
  if (rulesMenu.open && (!rulesMenu.contains(event.target) || el)) {
    rulesMenu.open = false;
    if (el && rulesMenu.contains(el)) rulesMenu.querySelector("summary").focus();
  }
  if (!el) return;
  void (async () => {
    if (el.dataset.warehouseId) {
      if (state.uploading || onboarding.busy) return;
      const nextView = el.dataset.warehouseView || state.view;
      if (nextView === 'onboarding') {
        await openWarehouseSetup({warehouse:state.warehouses.find(w=>w.id===el.dataset.warehouseId&&w.state==='active'),startUpdate:el.dataset.startUpdate==='true'});
        return;
      }
      if (el.dataset.warehouseId !== state.warehouseId) await selectWarehouse(el.dataset.warehouseId, nextView);
      else {
        $("#warehouse-picker").close();
        setView(nextView);
      }
    } else if (el.dataset.ontologyAction) setView("ontology", false, el.dataset.ontologyAction);
    else if (el.dataset.view) setView(el.dataset.view);
    else if (el.dataset.action) await action(el.dataset.action);
    else if (el.dataset.close) {
      if (el.dataset.close === "import-dialog" && (state.uploading || state.spaceSelecting)) return;
      if (el.dataset.close === "source-dialog" && state.saving) return;
      $("#" + el.dataset.close).close();
    } else if (el.dataset.node) selectNode(el.dataset.node);
    else if (el.dataset.edge) selectEdge(el.dataset.edge);
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
      document.querySelectorAll("[data-mode]").forEach((b) => {
        b.classList.toggle("active", b.dataset.mode === state.mode);
        b.setAttribute("aria-pressed", String(b.dataset.mode === state.mode));
      });
      $("#graph-space").hidden = state.mode !== "graph";
      $("#relation-list").hidden = state.mode !== "list";
      transformScene();
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
$("#choose-files").addEventListener(
  "click",
  () =>
    void (async () => {
      state.spaceSelecting = true;
      syncControls();
      try {
        const files = await call("select-files", {multiple:state.importContext !== "conversation", selectionMode:state.importContext});
        for (const file of files) if (!state.files.some(f => f.handle === file.handle)) state.files.push(file);
      } finally {
        state.spaceSelecting = false;
        renderPending();
      }
    })().catch((e) => toast(errorText(e))),
);
bindConversationEvents();
$("#confirm-import").addEventListener("click", () => void uploadFiles());
$("#import-dialog").addEventListener("cancel", (event) => {
  if (state.uploading || state.spaceSelecting) event.preventDefault();
});
$("#ontology-actions").addEventListener("keydown", event => {
  if (event.key !== "Escape" || !event.currentTarget.open) return;
  event.currentTarget.open = false;
  event.currentTarget.querySelector("summary").focus();
  event.stopPropagation();
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
$("#search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void runSearch();
});
$("#search-results").addEventListener("click", event => {
  if (event.target.closest("#search-more-annotations")) void runSearch(state.searchResult?.reply.annotationSearch?.nextCursor);
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

function currentWarehouse() {
  return state.warehouses.find((w) => w.id === state.warehouseId);
}
function warehouseStatus(w) {
  const statuses = {clearing:"正在清理",clear_failed:"清理未完成",deleting:"正在删除",delete_failed:"删除未完成",importing:"正在迁入",import_failed:"迁入未完成"};
  return statuses[w.state] || (w.active_jobs ? `${w.active_jobs} 项处理中` : w.document_count ? "可进入" : "待导入资料");
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
  const drafts=compact?{}:onboarding.status(state.identity).drafts;
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
        ? `<span class="warehouse-choice-icon">${icon("folder")}</span><span class="warehouse-choice-content"><span class="warehouse-choice-title"><strong data-field="name"></strong><span data-field="current" class="warehouse-current-indicator"></span></span><span data-field="description" class="warehouse-choice-description"></span><span class="warehouse-choice-meta"><span data-field="counts"></span><span data-field="status" class="warehouse-state"></span></span></span><span class="warehouse-choice-arrow">${icon("arrow")}</span>`
        : `<div class="warehouse-card-head"><span class="warehouse-card-icon">${icon("folder")}</span><div class="warehouse-card-main"><div class="warehouse-card-name"><h2 data-field="name"></h2><span data-field="current" class="warehouse-current-indicator"></span></div><p data-field="description" class="warehouse-card-description"></p></div><span data-field="status" class="warehouse-state"></span></div>
          <dl class="warehouse-card-statistics"><div><dt>材料</dt><dd data-field="documents"></dd></div><div><dt>实体</dt><dd data-field="entities"></dd></div><div><dt>关系</dt><dd data-field="relations"></dd></div></dl>
          <footer><span data-field="created" class="warehouse-card-date"></span><div><button class="text-link" data-warehouse-view="conversation">资料库</button><button class="warehouse-card-open" data-warehouse-view="graph"><span data-field="open"></span>${icon("arrow")}</button></div></footer>`;
      if (compact) card.dataset.warehouseId = w.id;
      else {
        const reviewButton=document.createElement('button');
        reviewButton.className='text-link';reviewButton.dataset.warehouseView='onboarding';
        reviewButton.textContent='基于当前规则调整';card.querySelector('footer>div').prepend(reviewButton);
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
    update(card, "current", selected ? "当前使用" : "");
    update(card, "description", w.description || "");
    update(card, "status", warehouseStatus(w));
    const blocked = !state.ready || state.uploading;
    if (compact) {
      update(card, "counts", `${w.document_count} 份材料 · ${w.entity_count} 个实体`);
      card.disabled = blocked;
      card.setAttribute("aria-pressed", String(selected));
      card.setAttribute("aria-label", `${selected ? "当前使用" : "切换至"}：${w.name}`);
    } else {
      update(card, "documents", w.document_count);
      update(card, "entities", w.entity_count);
      update(card, "relations", w.relation_count);
      update(card, "created", "建立于 " + date(w.created_at));
      update(card, "open", "打开图谱");
      card.querySelectorAll("[data-warehouse-id]").forEach(b => b.disabled = blocked);
      const reviewButton=card.querySelector('[data-warehouse-view="onboarding"]');
      reviewButton.hidden=state.preview || state.identity?.dataScope!=='personal';
      reviewButton.disabled=blocked || w.state!=='active';
      const draft=Object.hasOwn(drafts,w.id)?drafts[w.id]:null;
      reviewButton.dataset.startUpdate=String(!draft||!!draft.publication&&!draft.entryPending);
      if (draft&&(!draft.publication||draft.entryPending)) {
        reviewButton.textContent='继续建仓';
        if (draft.setupMode==='new'&&!draft.conversationId) update(card,'status','等待设置');
      } else reviewButton.textContent='基于当前规则调整';
      card.querySelector('[data-warehouse-view="graph"]').setAttribute("aria-label", `打开「${w.name}」的知识图谱`);
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
  notice.querySelector('span').textContent = recovery.entryPending ? '上次规则已发布，可继续打开数据仓。'
    : recovery.quickCreated ? '数据仓已创建，可继续打开资料库。' : '上次建仓或规则发布有待确认的操作。';
  notice.querySelector('button').textContent = recovery.entryPending || recovery.quickCreated ? '继续打开' : '继续原操作';
  const totals = state.warehouses.reduce((n,w) => [n[0] + w.document_count, n[1] + w.entity_count, n[2] + w.relation_count], [0,0,0]);
  $("#warehouse-directory-summary").innerHTML = [[state.warehouses.length,"座数据仓"],[totals[0],"份材料"],[totals[1],"个实体"],[totals[2],"条知识关系"]].map(([n,label]) => `<div><b>${esc(n)}</b><span>${label}</span></div>`).join("");
  const query = $("#warehouse-query").value;
  const visible = renderWarehouseCollection($("#warehouse-directory"), query, false);
  $("#warehouse-directory-count").textContent = query.trim() ? `${visible} / ${state.warehouses.length}` : state.warehouses.length;
  const empty = $("#warehouse-directory-empty");
  empty.hidden = visible > 0;
  empty.innerHTML = state.warehouses.length
    ? `<h2>没有找到匹配的数据仓</h2><p>换一个仓名或说明中的关键词试试。</p>`
    : state.ready
    ? `<span class="warehouse-empty-icon">${icon("folder")}</span><h2>还没有数据仓</h2><p>建仓后即可导入资料。</p><button class="btn btn-primary" data-action="new-warehouse">${icon("plus")}新建第一座数据仓</button>`
    : `<h2>连接万象，打开你的数据仓</h2><p>数据仓随当前万象账号和盒子连接读取。</p>`;
}

function renderWarehouses() {
  const selected = currentWarehouse();
  $("#crumb-warehouse").textContent = state.view === "warehouses" ? "全部数据仓" : selected?.name || "尚未建仓";
  $("#graph-warehouse").textContent = selected?.name || "你的第一座知识仓";
  const switchingDisabled = !state.ready || state.uploading || state.view === 'onboarding';
  document.querySelector('[data-action="update-warehouse-rules"]').hidden = !canCreateWarehouse() || selected?.state !== 'active';
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
        : "清空当前数据仓";
  });
  document.querySelectorAll('[data-action="prepare-delete"]').forEach((b) => {
    b.disabled = !state.ready || !selected || !["active", "clear_failed", "import_failed", "delete_failed"].includes(selected.state);
    b.textContent = selected?.state === "delete_failed" ? "重新确认并继续删除" : "删除当前数据仓";
  });
  $("#search-form button[type=submit]").disabled = !state.ready || state.searching || selected?.state !== "active";
}
async function selectWarehouse(id, nextView, onboardingHandoff = false) {
  if (state.uploading || state.spaceSelecting || onboarding.busy && !onboardingHandoff) return;
  if (id !== state.warehouseId) {
    if (!workbench.canLeave()) return;
    workbench.reset();
  }
  if (id && !state.warehouses.some((w) => w.id === id)) return;
  state.generation++;
  state.searching = state.saving = state.sourceLoading = false;
  skillsUi.reset();
  const selection = bridge?.call("select-warehouse", {});
  if (!onboardingHandoff) void selection?.catch(()=>{});
  const selectionGeneration = state.generation;
  state.warehouseId = id;
  state.managementStats = null;
  state.importFailure = null;
  stopConversation();
  state.conversationPublication=null;
  state.conversationOnboarding=null;
  renderConversation();
  state.processing = null; state.modelConfig = null; state.modelRequest = (state.modelRequest || 0) + 1;
  void loadProcessingSummary();
  rememberWarehouse(id);
  state.refreshing = false;
  state.documents = [];
  state.jobs = [];
  state.jobTotal = 0;
  state.jobOffset = 0;
  state.graph = { nodes: [], edges: [] };
  state.graphFingerprint = null;
  state.graphError = null;
  state.graphPresentation = createGraphPresentation();
  state.policy = null;
  state.retrieval = null;
  renderRetrieval();
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
  $("#search-query").value = "";
  $("#graph-query").value = "";
  $("#search-results").innerHTML =
    '<div class="empty">从一个具体的问题开始，找到这个仓中的相关证据。</div>';
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
    if (state.view === "sensitive") await loadPolicy();
  }
}
function renderManagement() {
  const w = currentWarehouse();
  $("#manage-name").textContent = w?.name || "从一座数据仓开始";
  const status = {
    clearing: "正在清理原件、知识和索引，访问凭证已撤销。",
    clear_failed: "清理未完成。请恢复本地数据库或磁盘后，重新确认并继续清理。",
    deleting: "正在删除数据仓和全部资料。访问凭证已撤销，完成后会从列表移除。",
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
    "你的原始资料、正文版本与知识来源，保存在同一座数据仓中。";
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
async function openWarehouseSetup(options) {
  if (!canCreateWarehouse() || onboarding.busy || document.querySelector('dialog[open]:not(#warehouse-picker)')) return;
  if (!workbench.canLeave() || Object.hasOwn(options,'warehouse') && !options.warehouse) return;
  $("#warehouse-picker").close();
  onboarding.open(state.identity, options);
}
async function warehouseAction(name) {
  if (name === "choose-warehouse") {
    if (!state.ready || state.uploading) return true;
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
  if (['new-warehouse','resume-onboarding','update-warehouse-rules'].includes(name)) {
    await openWarehouseSetup(name === 'update-warehouse-rules' ? {warehouse:currentWarehouse(),startUpdate:true} : {fresh:name === 'new-warehouse'});
    return true;
  }
  if (name === "prepare-clear" || name === "prepare-delete") {
    const deleting = name === "prepare-delete";
    const intent = await call(name, {
      operationId: crypto.randomUUID(),
    });
    state.clearIntent = intent;
    intent.action = deleting ? "delete" : "clear";
    $("#clear-title").textContent = deleting ? "删除当前数据仓？" : "清空当前数据仓？";
    $('#clear-dialog .icon-btn').setAttribute('aria-label', deleting ? '取消删除' : '取消清空');
    $('#clear-dialog .btn-secondary').textContent = deleting ? '保留数据仓' : '保留数据';
    $("#clear-scope").innerHTML = `<p class="modal-intro">将清空「${esc(
      intent.warehouse.name,
    )}」中的全部数据：</p><div class="clear-counts">${
      intent.warehouse.document_count
    } 份材料 · ${intent.warehouse.entity_count} 个实体 · ${
      intent.warehouse.relation_count
    } 条关系</div><p class="modal-warning">原件、全部正文版本、知识关系、检索索引、Skill 及推理准备记录将被移除，${
      intent.warehouse.access_key_count
    } 个有效凭证将同时撤销。其他数据仓不受影响。</p>`;
    if (deleting) {
      $("#clear-scope").innerHTML = `<p class="modal-intro">将永久删除数据仓「${esc(intent.warehouse.name)}」及其全部数据：</p><div class="clear-counts">${intent.warehouse.document_count} 份材料 · ${intent.warehouse.entity_count} 个实体 · ${intent.warehouse.relation_count} 条关系</div><p class="modal-warning">数据仓本身、原件、全部正文版本、知识关系、索引、Skill 及推理准备记录将被移除，${intent.warehouse.access_key_count} 个有效凭证将撤销。此操作无法撤销，其他数据仓不受影响。</p>`;
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
  state.clearIntent = null;
  $("#clear-name").value = "";
});
$("#clear-next").addEventListener("click", () => {
  if ($("#clear-second").hidden) {
    $("#clear-second").hidden = false;
    $("#clear-next").textContent = state.clearIntent?.action === "delete" ? "确认永久删除数据仓" : "确认永久清空";
    $("#clear-next").disabled = true;
    $("#clear-name").focus();
    return;
  }
  const intent = state.clearIntent;
  if (!intent || $("#clear-name").value !== intent.warehouse.name) return;
  if (state.warehouseId !== intent.warehouse.id) return toast("数据仓已切换，请重新确认。");
  $("#clear-next").disabled = true;
  void (async () => {
    const deleting = intent.action === "delete";
    await call(deleting ? "delete-warehouse" : "clear-warehouse", {
      token: intent.confirmation_token,
      typedName: $("#clear-name").value,
      operationId: (intent.operationId ||= crypto.randomUUID()),
    });
    $("#clear-dialog").close();
    if (deleting) {
      await selectWarehouse("", "warehouses");
      await refresh();
      toast("删除已提交，清理完成后会从数据仓列表移除；访问凭证已撤销。");
    } else {
      await selectWarehouse(state.warehouseId);
      toast("清空已提交，正在移除资料与索引；访问凭证已撤销。");
    }
  })()
    .catch((e) => toast(errorText(e)))
    .finally(() => ($("#clear-next").disabled = false));
});

function actualModel(config, role = "extraction") {
  const item = config?.[role];
  if (config?.mode === "automatic" && item?.available === false) return "WANX 默认模型暂不可用，请检查万象模型设置";
  const name = [item?.name, item?.model].find(value => typeof value === 'string' && value.trim());
  if (!name) return "历史处理记录未提供模型配置";
  const location = {local: "本地", cloud: "云端 / 外部服务"}[item.location] || "运行位置未记录";
  const thinking = {auto: "思考：模型默认", on: "思考：开启", off: "思考：关闭"}[config?.inference_options?.thinking_mode] || "思考设置未记录";
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
    renderProcessingSummary();
  } catch { /* Older services keep the existing local runtime summary. */ }
}
function renderProcessingSummary() {
  if (!state.processing) return;
  const text = actualModel(state.processing);
  $("#graph-model").textContent = "知识抽取与脱敏：" + text;
  $("#runtime-summary").textContent = "知识抽取与脱敏共用模型：" + text;
  if ($("#import-model-summary")) $("#import-model-summary").textContent = "本次导入按入队时配置处理：" + text;
}
async function loadModels() {
  const status = $("#model-status");
  if (!state.ready || state.preview) { status.textContent = "连接盒子后即可查看和配置模型。"; return; }
  const request = state.modelRequest = (state.modelRequest || 0) + 1;
  const scope = $("#model-scope").value;
  state.modelConfig = null;
  $("#model-save-status").textContent = "";
  $("#model-context").textContent = "";
  $("#model-stages").replaceChildren();
  updateModelControls();
  if (scope === "warehouse" && !state.warehouseId) { $("#model-status").textContent = "请先选择数据仓，或切换到星图默认配置。"; return; }
  status.textContent = "正在读取当前设备的模型…";
  const results = await Promise.allSettled([call("processing", {scope}),call("model-catalog", {scope})]);
  if (request !== state.modelRequest) return;
  if (results[0].status === "rejected") { $("#model-status").textContent = errorText(results[0].reason); return; }
  state.modelConfig = results[0].value;
  state.modelCatalog = results[1].status === "fulfilled" ? results[1].value.items : [];
  state.modelDefault = results[1].status === "fulfilled" ? results[1].value.default : null;
  renderModelEditor();
  status.textContent = results[1].status === "rejected" ? errorText(results[1].reason) : state.modelCatalog.length ? "" : "万象尚未配置可用文本模型。";
}
function renderModelEditor() {
  const config = state.modelConfig;
  if (!config) return;
  const current = config.effective;
  const location = item => item?.location === "local" ? "本机 / 当前盒子" : item?.location ? "云端 / 外部服务" : "";
  const contextWindow = item => Number.isSafeInteger(item?.context_window)&&item.context_window>0 ? `${item.context_window} token` : "";
  const roles = [
    ["ocr","文字识别","将图片或扫描件转成正文"], ["asr","语音转写","将录音转成可追溯文字"],
    ["extraction","知识抽取","提取实体、关系和来源"], ["embedding","检索向量","为证据检索建立索引"], ["sensitive","敏感信息检测","检查知识交付中的敏感内容"]
  ];
  $("#model-context").textContent = config.inherit ? "继承星图默认配置"
    : $("#model-scope").value === "default" ? "星图默认配置" : "本仓独立配置";
  $("#model-stages").innerHTML = roles.map(([role,title,purpose]) => {
    const item = current[role] || config.stages.find(s => s.role === role);
    const selected = state.modelCatalog.find(m => m.id === item?.id);
    const matchesCatalog = selected?.revision === item?.revision;
    const ready = item?.route === "wanx" ? item.available && Boolean(selected && matchesCatalog) : item?.available;
    const status = item?.route === "legacy" ? "本地配置" : ready ? current[role] ? "使用时校验" : "已就绪" : "未就绪";
    const checked = current[role] && current.checked_at && ready ? `<small>上次检查 ${esc(date(current.checked_at))}</small>` : "";
    const details=[location(item),role==='extraction'?contextWindow(matchesCatalog?selected:item):''].filter(Boolean).join(' · ');
    return `<article class="model-stage"><div><h3 title="${esc(purpose)}">${title}</h3></div><div><strong>${esc(item?.name || "未配置")}</strong>${details ? `<p>${details}</p>` : ""}</div><div class="model-stage-meta"><span class="model-stage-status" data-ready="${Boolean(ready)}">${status}</span>${checked}</div></article>`;
  }).join("");
  for (const role of ["extraction"]) {
    const options = [...state.modelCatalog];
    if (!options.some(m => m.id === current[role]?.id)) options.unshift({...current[role], available:false});
    $("#model-"+role).innerHTML = options.map(m => `<option value="${esc(m.id)}" ${m.available ? "" : "disabled"}>${esc(m.name || m.model)} · ${esc(m.provider)} · ${m.location === "local" ? "本地" : "云端 / 外部"}${contextWindow(m)?` · ${contextWindow(m)}`:''}${m.available ? "" : "（当前配置，暂不可选择）"}</option>`).join("");
    $("#model-"+role).value = current[role]?.id || "";
  }
  $("#model-inherit").checked = config.inherit;
  $("#model-mode").value = current.mode === "automatic" ? "automatic" : "manual";
  // The backend resolves the default for new tasks; always show its actual value.
  renderThinkingOptions(current.inference_options?.thinking_mode || "auto");
  $("#model-inherit-label").hidden = $("#model-scope").value === "default";
  $("#model-impact").textContent = $("#model-scope").value === "default" ? "影响继承默认配置的数据仓及未来新仓：" + (config.affected_warehouses.join("、") || "目前没有继承仓") : "仅影响当前数据仓的新处理任务。";
  updateModelControls();
}
function renderThinkingOptions(selected = $("#model-thinking").value || null) {
  const item = $("#model-mode").value === "automatic" ? state.modelDefault
    : state.modelCatalog.find(m => m.id === $("#model-extraction").value);
  const modes = item?.inference_options?.thinking_modes || ["auto"];
  if (selected === null) selected = modes.includes("off") ? "off" : "auto";
  const labels = {auto: "沿用模型默认设置", on: "开启思考", off: "关闭思考"};
  $("#model-thinking").innerHTML = Object.entries(labels).map(([mode,label]) =>
    `<option value="${mode}" ${modes.includes(mode) ? "" : "disabled"}>${label}${modes.includes(mode) ? "" : "（当前模型不支持）"}</option>`).join("");
  $("#model-thinking").value = selected;
  $("#model-thinking-note").textContent = modes.length > 1
    ? "抽取与脱敏共用此设置，保存后应用于新任务。"
    : "该模型使用默认思考模式。";
}
function updateModelControls() {
  const returnBar=$("#model-onboarding");
  const handoff=state.modelOnboarding;
  returnBar.hidden=!handoff||handoff.warehouseId!==state.warehouseId;
  if (!returnBar.hidden) {
    $("#model-onboarding-budget").textContent=Number.isSafeInteger(handoff.required)&&handoff.required>0
      ? `本轮建仓预计至少需要 ${handoff.required} 个 token。` : '调整模型后，可以返回原建仓对话。';
    $("#model-onboarding-return").disabled=!!state.modelSaving;
  }
  const inherited = $("#model-scope").value === "warehouse" && $("#model-inherit").checked;
  const automatic = $("#model-mode").value === "automatic";
  for (const id of ["model-scope", "model-inherit", "model-mode", "model-extraction", "model-thinking", "model-refresh"]) $("#"+id).disabled = !!state.modelSaving;
  for (const id of ["model-inherit", "model-mode", "model-extraction"]) $("#"+id).disabled ||= !state.modelConfig;
  $("#model-mode-label").hidden = inherited;
  $("#model-selectors").hidden = inherited || automatic;
  $("#model-thinking-controls").hidden = false;
  $("#model-thinking").disabled = inherited || !!state.modelSaving || !state.modelConfig;
  renderThinkingOptions();
  if (inherited) $("#model-thinking-note").textContent = "继承星图默认配置。";
  $("#model-save").disabled = !!state.modelSaving || !state.modelConfig;
  $("#model-save").textContent = state.modelSaving ? "正在检查并保存…" : inherited ? "恢复继承" : "检查并保存";
}
async function saveModels() {
  if (!state.modelConfig || state.modelSaving) return;
  const generation = state.generation, scope = $("#model-scope").value;
  const inherit = scope === "warehouse" && $("#model-inherit").checked;
  const mode = $("#model-mode").value;
  const revision = state.modelConfig.revision;
  const inference_options = {thinking_mode: $("#model-thinking").value || "auto"};
  const request = state.modelRequest;
  const status = $("#model-save-status");
  try {
    state.modelSaving = true; updateModelControls();
    let check = {};
    if (!inherit) {
      const extraction = mode === "automatic" ? state.modelDefault?.id : $("#model-extraction").value;
      const items = [state.modelCatalog.find(m => m.id === extraction)];
      if (items.some(m => !m?.available)) throw {publicMessage:"请先选择万象中的可用模型。"};
      if (!items[0].inference_options?.thinking_modes?.includes(inference_options.thinking_mode) && inference_options.thinking_mode !== "auto") throw {publicMessage:"当前模型不支持所选思考模式，请重新选择。"};
      const cloud = items.filter(m => m.location !== "local");
      if (cloud.length && !confirm(`确认使用云端 / 外部模型？\n${cloud.map(m => `${m.provider} · ${m.name}`).join("\n")}\n\n知识抽取或敏感检测可能向这些服务发送未经脱敏的正文片段，并产生模型用量。\n${$("#model-impact").textContent}\n\n是否继续检查并保存？`)) return;
      status.textContent = "正在用示例检查模型…";
      check = await call("check-models",{scope,config:{extraction,mode,inference_options,cloud_confirmations:cloud.map(m => m.revision)}});
      if (generation !== state.generation || request !== state.modelRequest) return;
    }
    await call("save-models",{scope,config:{expected_revision:revision,inherit,mode,check_id:check.check_id || null}});
    if (generation !== state.generation) return;
    await loadProcessingSummary(); await loadModels();
    status.textContent = "已保存，新任务将使用此配置。";
  } catch (e) { if (generation === state.generation) status.textContent = errorText(e); }
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
$("#model-scope").addEventListener("change",()=>void loadModels());
$("#model-onboarding-return").addEventListener("click",()=>{
  if (state.view==='models'&&!state.modelSaving&&state.modelOnboarding?.warehouseId===state.warehouseId) {
    void openWarehouseSetup({warehouse:currentWarehouse()});
  }
});
$("#model-inherit").addEventListener("change",updateModelControls);
$("#model-mode").addEventListener("change",updateModelControls);
$("#model-extraction").addEventListener("change",updateModelControls);
$("#model-thinking").addEventListener("change",()=>{
  $("#model-status").textContent = "思考模式尚未保存。点击“检查并保存”后对新任务生效，已有任务和重试保留原设置。";
});
$("#model-refresh").addEventListener("click",()=>void loadModels());
$("#model-save").addEventListener("click",()=>void saveModels());
$("#model-reprocess-all").addEventListener("click",()=>void reprocessModels());
$("#model-manage").addEventListener("click",async()=>{
  try { const result=await call("open-model-management"); if(!result.opened) toast("当前万象版本暂不支持直接跳转。请在万象管理后台的「模型」中管理，再回到这里刷新。"); }
  catch(e){toast(errorText(e));}
});
if ($("#import-model-config")) $("#import-model-config").addEventListener("click",()=>{$("#import-dialog").close();setView("models");});
