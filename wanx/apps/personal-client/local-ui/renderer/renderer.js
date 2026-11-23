const app = document.querySelector("#app");
let walletCountdownTimer = null;
function syncWalletCountdown() {
  clearInterval(walletCountdownTimer);
  walletCountdownTimer = null;
  const clock = app.querySelector('[data-wallet-deadline]');
  if (!clock) return;
  const tick = () => {
    const seconds = Math.max(0, Math.ceil((Number(clock.dataset.walletDeadline) - Date.now()) / 1000));
    clock.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    if (!seconds || !clock.isConnected) { clearInterval(walletCountdownTimer); walletCountdownTimer = null; }
  };
  tick();
  walletCountdownTimer = setInterval(tick, 1000);
}
let currentState;
const accessoryPreview = window.createAccessoriesPreview?.(input => window.wanxClient.action("accessories-preview", input));
let accessoryPageVisible = false;
const dataView=window.createStarlinkPanelView({request:async(name,input)=>{const result=await window.wanxClient.action(name,input);if(!result.ok)throw Object.assign(Error(result.code),{code:result.code});return result.value;},changed:()=>{if(currentState)render(currentState);}});
const spaceRedactionSettings = window.createSpaceRedactionSettings?.({
  escapeHTML: value => escapeHTML(value),
  request: async (action, input) => {
    const result = await window.wanxClient.action(action, input);
    if (!result.ok) throw Object.assign(new Error(result.code), { code: result.code });
    return result.value;
  },
});
let redactionRuleComposition = null;
const homePage = "my-ai";
let page = homePage;
const clientBrand = "半人马AI记忆盒子";
const clientBrandEnglish = "CentaurAI MemoBox";
const clientBrandCopy = `<span class="brand-copy"><strong>${clientBrand}</strong><small>${clientBrandEnglish}</small></span>`;
let memoryAgent = "";
let memoryPage = "";
let cloudAuthOpen = false;
let helpReturnPage = "memory";
let helpReturnScroll = 0;
let helpReturnLabel = "返回";
let helpDrawer = null, helpDrawerTrigger = null;
function closeHelpDrawer(restoreFocus = true) {
  if (!helpDrawer) return;
  helpDrawer.remove(); helpDrawer = null;
  app.inert = false;
  document.body.classList.remove("faq-drawer-open");
  helpView?.visible(false);
  if (restoreFocus) {
    const trigger = helpDrawerTrigger?.isConnected ? helpDrawerTrigger :
      app.querySelector('[data-action="show-help"][data-scene="box_setup"]');
    trigger?.focus({ preventScroll: true });
  }
  helpDrawerTrigger = null;
}
function renderHelpDrawer() {
  if (!helpDrawer) return;
  const panel = helpDrawer.querySelector(".faq-drawer-panel");
  const scroll = panel?.scrollTop || 0;
  const active = helpDrawer.contains(document.activeElement) ? document.activeElement : null;
  const id = active?.id;
  const action = active?.dataset.action, itemId = active?.dataset.id;
  const selection = (active && ["text", "search"].includes(active.type)) || active?.tagName === "TEXTAREA"
    ? [active.selectionStart, active.selectionEnd] : null;
  helpDrawer.innerHTML = `<section class="faq-drawer-panel" role="dialog" aria-modal="true" aria-labelledby="faq-title" tabindex="-1">${helpView.render({ drawer: true })}</section>`;
  const nextPanel = helpDrawer.querySelector(".faq-drawer-panel");
  nextPanel.scrollTop = scroll;
  const next = id ? helpDrawer.querySelector(`#${id}`) : [...helpDrawer.querySelectorAll("[data-action]")]
    .find(node => node.dataset.action === action && node.dataset.id === itemId);
  if (active) {
    (next || nextPanel.querySelector('[data-action="help-back"]')).focus({ preventScroll: true });
    if (selection && next?.setSelectionRange) next.setSelectionRange(...selection);
  }
}
async function openHelpDrawer(target) {
  helpDrawerTrigger = target;
  helpDrawer = document.createElement("div");
  helpDrawer.className = "faq-drawer";
  document.body.append(helpDrawer);
  app.inert = true;
  document.body.classList.add("faq-drawer-open");
  helpView?.open({ scene: target.dataset.scene });
  helpView?.visible(true);
  helpDrawer.addEventListener("click", async event => {
    const button = event.target.closest("[data-action]");
    if (!button || button.disabled) return;
    if (button.dataset.action === "help-back") { closeHelpDrawer(); return; }
    await helpView.action(button.dataset.action, button.dataset);
    if (!helpDrawer) return;
    if (button.dataset.action === "help-category" || button.dataset.action === "help-clear")
      helpDrawer.querySelector(".faq-results")?.scrollIntoView({ block: "start" });
    if (button.dataset.action === "help-feedback-open") helpDrawer.querySelector("#faq-feedback-content")?.focus();
  });
  helpDrawer.addEventListener("input", event => {
    if (event.target.closest('[data-form="help-feedback"]')) helpView.input(event.target.name, event.target.value);
  });
  helpDrawer.addEventListener("submit", async event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.target));
    await helpView.action(event.target.dataset.form === "help-feedback" ? "help-feedback-submit" : "help-search", values);
  });
  helpDrawer.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); closeHelpDrawer(); }
    if (event.key === "Tab") {
      const buttons = [...helpDrawer.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled)')]
        .filter(node => node.getClientRects().length);
      if (!buttons.length) { event.preventDefault(); return; }
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (event.shiftKey && (document.activeElement === first || !buttons.includes(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !buttons.includes(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    }
  });
  renderHelpDrawer();
  helpDrawer.querySelector('[data-action="help-back"]').focus();
  await helpView?.refresh();
}

const helpView = window.createHelpView?.({
  request: async (action, input) => {
    const response = await window.wanxClient.action(action, input);
    if (!response.ok) throw Object.assign(new Error(response.code), { code: response.code, userMessage: response.userMessage, limitScope: response.limitScope, retryAfterSeconds: response.retryAfterSeconds });
    return response.value;
  },
  changed: () => { if (helpDrawer) renderHelpDrawer(); else if (currentState && page === "help") render(currentState); },
});
let applicationsTab = "wanx";

const FEATURED_PRODUCTS = {
  office: {
    applicationId: "centaurai.wanx.template.office-assistant",
    name: "小办",
    category: "办公工作台",
    summary: "把手头的材料整理成可以继续编辑的文档、表格和演示。",
    tasks: ["整理文档", "分析表格", "制作演示"],
    examples: ["会议纪要", "带公式的汇总表", "项目汇报幻灯片"],
    requirement: "生成成果需连接模型。",
    mark: "文",
  },
  "ai-crm": {
    applicationId: "centaurai.wanx.template.ai-crm",
    name: "AI CRM",
    category: "客户管理",
    summary: "保存沟通原文，整理客户信息和跟进建议，经确认后更新档案。",
    tasks: ["收集沟通材料", "管理客户档案", "确认跟进建议"],
    examples: ["沟通时间线", "有原文依据的客户更新", "待跟进清单"],
    requirement: "提取信息需连接模型。自动收集消息需完成渠道配对和授权。",
    mark: "客",
  },
};
function expertCatalog(scope = "") {
  return { scope, loaded: false, loading: false, error: "", pilots: [], mode: "" };
}
let expertApps = expertCatalog();

function expertCatalogAvailable() {
  return Boolean(expertApps.mode && expertApps.mode !== "unavailable");
}

async function refreshExpertApps() {
  if (!expertApps.scope || expertApps.loading || expertApps.mode === "unavailable") return;
  const state = expertApps;
  state.loading = true;
  state.error = "";
  render(currentState);
  try {
    const response = await window.wanxClient.action("expert-apps", { action: "catalog", input: {} });
    if (state !== expertApps) return;
    if (response.code === "UNKNOWN_CLIENT_ACTION" || response.code === "EXPERT_APPS_HOST_UPDATE_REQUIRED" ||
        response.value?.mode === "unavailable") {
      state.mode = "unavailable";
      state.pilots = [];
      return;
    }
    if (!response.ok) throw Error("CATALOG_UNAVAILABLE");
    const { pilots, mode } = response.value || {};
    if (typeof mode !== "string" || !mode) throw Error("CATALOG_UNAVAILABLE");
    state.pilots = Array.isArray(pilots) ? pilots.filter(p => p && Object.hasOwn(FEATURED_PRODUCTS, p.id)) : [];
    state.mode = mode;
  } catch {
    if (state === expertApps) state.error = "暂时无法读取可添加的应用，请重试。";
  } finally {
    if (state === expertApps) {
      state.loaded = true;
      state.loading = false;
      render(currentState);
    }
  }
}

async function expertAppAction(action, id) {
  if (!expertCatalogAvailable() || !Object.hasOwn(FEATURED_PRODUCTS, id) || expertApps.loading) return;
  const state = expertApps;
  state.loading = true;
  state.error = "";
  render(currentState);
  try {
    const response = await window.wanxClient.action("expert-apps", { action, input: { id } });
    if (state !== expertApps) return;
    if (!response.ok) throw Error("APP_ACTION_FAILED");
    if (action === "install") {
      appLibrary.loaded = false;
      if (response.state) acceptRemoteState(response.state);
    }
  } catch {
    if (state === expertApps) {
      state.error = action === "workshop" ? "工坊演示暂时无法打开，请重试。" : "添加应用未完成，请重试。";
    }
  } finally {
    if (state === expertApps) {
      state.loading = false;
      render(currentState);
    }
  }
}

function featuredLogo(id, logo, className) {
  const prefix = "data:image/svg+xml;base64,";
  const valid = typeof logo === "string" && logo.length <= 24576
    && (logo.length - prefix.length) % 4 === 0
    && /^data:image\/svg\+xml;base64,[A-Za-z0-9+/]+={0,2}$/.test(logo);
  return valid
    ? `<img class="${className}" src="${escapeHTML(logo)}" alt="" decoding="async" />`
    : `<span class="${className} featured-logo-fallback" data-featured-icon="${id}" aria-hidden="true">${FEATURED_PRODUCTS[id].mark}</span>`;
}

function featuredProductId(item) {
  if (item.entrypoint !== "local-expert.cjs") return null;
  return Object.keys(FEATURED_PRODUCTS).find(id => FEATURED_PRODUCTS[id].applicationId === item.applicationId) || null;
}

function availableFeaturedProductId(item) {
  return expertCatalogAvailable() ? featuredProductId(item) : null;
}

function featuredArt(id) {
  if (id === "office") {
    return `<div class="featured-art featured-art-office" aria-hidden="true">
      <div class="featured-art-document"><span>会议纪要</span><i></i><i></i><i></i><i></i></div>
      <div class="featured-art-sheet"><span>数据汇总</span><div><i></i><i></i><i></i><i></i></div></div>
      <span class="featured-art-caption">内容示意</span>
    </div>`;
  }
  return `<div class="featured-art featured-art-crm" aria-hidden="true">
    <div class="featured-art-timeline"><strong>客户跟进</strong>
      <div><i></i><span>沟通记录</span><small>已归档</small></div>
      <div><i></i><span>更新客户信息</span><small>待确认</small></div>
      <div><i></i><span>安排下次沟通</span><small>下一步</small></div>
    </div>
    <span class="featured-art-caption">内容示意</span>
  </div>`;
}

function featuredExamples(product) {
  return `<p class="featured-examples"><strong>成果示例</strong> ${product.examples.join("、")}</p>`;
}

function availableApplicationsView(items) {
  const { pilots, loading, error, mode } = expertApps;
  if (mode === "unavailable" || (!mode && !error)) return "";
  const listed = new Set(items.map(item => item.applicationId));
  const available = pilots.filter(({ id }) => !listed.has(FEATURED_PRODUCTS[id].applicationId));
  if (!available.length && !loading && !error) return "";
  return `<section class="featured-store" aria-label="可添加的应用">
    <div class="section-heading"><h3>可添加的应用</h3>
      <button class="text-button" data-action="expert-apps-refresh" ${loading ? "disabled" : ""}>${loading ? "正在读取…" : "刷新目录"}</button>
    </div>
    ${mode === "local-development" ? '<p class="featured-preview-label">本机预览</p>' : ""}
    ${error ? `<div class="notice error" role="status">${escapeHTML(error)}</div>` : ""}
    <div class="featured-app-grid">${available.map(pilot => {
      const { id, logo } = pilot;
      const product = FEATURED_PRODUCTS[id];
      return `<article class="expert-pilot-card" data-expert-app="${id}">
        ${featuredArt(id)}
        <div class="featured-app-body">
          <div class="featured-app-identity">${featuredLogo(id, logo, "featured-app-logo")}<div><h4>${product.name}</h4><p>${product.category}</p></div></div>
          <p class="featured-app-summary">${product.summary}</p>
          <ul class="featured-app-tasks">${product.tasks.map(task => `<li>${task}</li>`).join("")}</ul>
          ${featuredExamples(product)}
          <p class="featured-app-requirement">${product.requirement}</p>
          <div class="featured-app-actions">
            <button class="button primary" data-action="expert-app-install" data-id="${id}" ${loading ? "disabled" : ""}>添加到我的应用</button>
            <button class="text-button featured-demo-link" data-action="expert-app-workshop" data-id="${id}" ${loading ? "disabled" : ""}>工坊演示 <span aria-hidden="true">↗</span></button>
          </div>
        </div>
      </article>`;
    }).join("")}</div>
    ${!available.length && loading ? '<p class="market-empty" role="status">正在读取可添加的应用…</p>' : ""}
  </section>`;
}

let appLibrary={scope:'',loading:false,loaded:false,items:[],projects:[],workshopApplicationIds:[],error:''};
async function refreshAppLibrary(){
 if(!currentState?.canLaunchApplications||appLibrary.loading)return;const library=appLibrary;library.loading=true;
 try{const r=await window.wanxClient.action('workshop',{action:'library',input:{}});if(library!==appLibrary)return;if(!r.ok)throw Error(r.code);Object.assign(library,r.value,{loaded:true,error:r.value?.unavailable?'当前盒子尚不能读取工坊应用，请检查服务后重试。':''});}catch{if(library===appLibrary){library.loaded=true;library.error='工坊信息暂不可用，请重试。';}}finally{if(library===appLibrary){library.loading=false;render(currentState);}}
}
function isManagedLocalApplication(item) {
  return currentState?.applications?.find(record => record.applicationId === item.applicationId)?.managedLocal === true;
}
function isPrivateApplication(item){return Boolean(item.workshopProjectId)||item.installationSource==='local'||isManagedLocalApplication(item);}
function applicationCandidate(item){return isPrivateApplication(item)?null:marketCandidates.get(item.applicationId);}

const workshop = window.createWanxWorkshop({request:async(action,input)=>{const r=await window.wanxClient.action('workshop',{action,input});if(!r.ok)throw Object.assign(Error(r.code),{code:r.code});return r.value;},changed:()=>{if(currentState&&page==='workshop')render(currentState);}});
let selectedApplicationId = null;
let posterPreview = null;
const storeCarousel = window.createStoreCarousel();
let profileMenuOpen = false;
let notificationFilter = "all";
let expandedNotificationId = null;
const aiDialogueView = window.createAIDialogueView?.({
  title: "知君", drawer: true, memory: true,
  introduction: {
    heading: "你好，我是知君。",
    text: "我是你的记忆智能体。想记住什么，就告诉我。想起一件事时，哪怕只有一点线索，我也会陪你找回来。",
    placeholder: "跟我说说，你想记住或想起什么？",
  },
  request: (action, input) => window.wanxClient.action(action, input),
  resolvePageHelp: resolveAcademyPageHelp,
  onBoxes: () => { page = "boxes"; render(currentState); },
});
const academyApi = window.wanxAcademyCopilot;
let academyDrawer;
academyDrawer = window.createAcademyDrawer?.({
  root: document.querySelector("#academy-drawer-root"),
  request: academyApi && ((method, input) => academyApi.action(method, input)),
  onSuggestion: text => aiDialogueView?.fillSuggestion(text),
  onOpenChange: syncAcademyContents,
  onTabChange: syncAcademyContents,
  onSectionRequest: section => void requestSidebar(true, { section }),
  onVisibilityRequest: requestAssistantSidebar,
});
const noteSidebar = window.wanxClipboard;
let academyAvailable = false;
let academyContextKey = "";
let academyDialogueMounted = false;
let pendingDialogueOpen = false;
let pendingDialogueHandoff = null;
let sidebarIntent = null;

async function requestSidebar(show, { restoreFocus = true, section, handoff } = {}) {
  if (show && (!academyAvailable || academyDrawer?.isAvailable?.() === false)) return;

  const intent = { show };
  sidebarIntent = intent;
  try {
    if (noteSidebar?.isOpen?.() && (!show || section !== "note")) {
      const closed = await noteSidebar.close({
        immediate: true,
        restoreFocus: false,
        shouldClose: () => sidebarIntent === intent,
      });
      if (!closed || sidebarIntent !== intent) return;
    }

    if (show) {
      if (!academyAvailable) return;
      academyDrawer?.open(section ?? "assistant");
      if (handoff) aiDialogueView?.event(handoff);
    } else {
      academyDrawer?.close?.({ restoreFocus });
    }
  } finally {
    if (sidebarIntent === intent) sidebarIntent = null;
  }
}

function requestAssistantSidebar(show) {
  const selected = sidebarIntent?.show ?? academyDrawer?.isOpen?.();
  void requestSidebar(show ?? !selected);
}

function requestNoteSidebar(show, options) {
  if (show ?? !noteSidebar?.isOpen?.()) return requestSidebar(true, { section: "note" });
  return requestSidebar(false, options);
}

function syncAcademyContents() {
  if (academyDrawer?.isNoteVisible?.()) noteSidebar?.open?.({ focus: false });
  const visible = academyDrawer?.isDialogueVisible() === true;
  if (visible && !academyDialogueMounted) {
    const host = academyDrawer.dialogueHost();
    aiDialogueView?.mount(host);
    if (academyApi) academyDrawer.mountPageHelp(host.querySelector("[data-chat-composer]"), host.querySelector(".ai-page-actions"));
    academyDialogueMounted = true;
  }
  aiDialogueView?.visible(visible);
  syncAccessoriesPreview();
}

function openAcademyDialogue(handoff) {
  if (!currentState) {
    pendingDialogueOpen = true;
    pendingDialogueHandoff = handoff ?? pendingDialogueHandoff;
    return;
  }
  void requestSidebar(true, { section: "dialogue", handoff });
}

function getAcademyContext() {
  if (page === "applications") {
    if (applicationsTab === "local") return { module: "my-apps" };
    return { module: "app-market" };
  }
  if (page === "application-detail") return { module: "app-detail" };
  if (page === "workshop") {
    const { stage, errorCode } = workshop.copilotContext();
    return { module: "workshop", stage, errorCode };
  }
  const knownPage = ["data", "space", "boxes", "settings", "profile", "notifications", "credits", "help", "client-update", "dialogue-models"].includes(page);
  return { module: knownPage ? page : "general" };
}

function resolveAcademyPageHelp() {
  if (!academyApi || !academyDrawer?.isPageHelpEnabled()) return "";
  const context = getAcademyContext();
  return Promise.resolve().then(() => academyApi.action("context", context)).then(result => {
    const help = result?.ok && academyDrawer.formatPageHelp(result.value);
    if (!help) throw new Error("PAGE_HELP_UNAVAILABLE");
    return help;
  });
}

function syncAcademyContext(available) {
  academyAvailable = available;
  noteSidebar?.setActive?.(available);
  academyDrawer?.setAvailable(available);
  if (!available) {
    academyContextKey = "";
    return;
  }
  const context = getAcademyContext();
  const key = JSON.stringify(context);
  if (key !== academyContextKey && academyApi) {
    academyContextKey = key;
    void academyApi.action("context", context).then(result => {
      if (academyContextKey !== key) return;
      if (result?.ok) academyDrawer?.sync?.(result.value);
      else academyContextKey = "";
    }).catch(() => {
      if (academyContextKey === key) academyContextKey = "";
    });
  }
}

function syncAcademyModal() {
  const blocked = Boolean(app.querySelector?.('[aria-modal="true"], dialog[open]'));
  academyDrawer?.setBlocked(blocked);
  syncAcademyContents();
}

const dialogueModelSettings = window.createDialogueModelSettingsView?.({
  request: (action, input) => window.wanxClient.action(action, input),
  onSaved: () => aiDialogueView?.modelsChanged(),
});
let restoringWalletFocus = false;
function restoreWalletFocus(element) {
  restoringWalletFocus = true;
  try { element.focus({ preventScroll: true }); }
  finally { restoringWalletFocus = false; }
}
const creditsView = window.createWalletView({
  getBoxName: deviceId => {
    const device = currentState?.devices?.find(item => item.deviceId === deviceId);
    return device?.name || device?.displayName || (currentState?.connection?.deviceId === deviceId ? currentState.connection?.name : null) || deviceId;
  },
  request: async (action, input) => {
  const response = await window.wanxClient.action(action, input);
  if (response.state && JSON.stringify([response.state.account?.phase, response.state.account?.accountId, response.state.account?.clientId]) !== JSON.stringify([currentState?.account?.phase, currentState?.account?.accountId, currentState?.account?.clientId])) { acceptRemoteState(response.state); throw new Error("ACCOUNT_SESSION_CHANGED"); }
  if (!response.ok) throw Object.assign(new Error(response.code), { code: response.code, request_id: response.request_id, details: response.details, retryable: response.retryable });
  return response.value;
  },
  changed: () => { if (currentState) render(currentState); },
  onTiming: value => { void window.wanxClient.recordPaymentTiming?.(value); } });
const supportView = window.createSupportView({ request: async (action, input) => {
  const response = await window.wanxClient.action(action, input);
  if (response.state && JSON.stringify([response.state.account?.phase, response.state.account?.accountId, response.state.account?.clientId]) !== JSON.stringify([currentState?.account?.phase, currentState?.account?.accountId, currentState?.account?.clientId])) throw new Error("SUPPORT_SESSION_CHANGED");
  if (!response.ok) throw new Error(response.code);
  return response.value;
}, changed: () => { if (currentState) render(currentState); } });
let marketItems = [];
let marketCatalogState = null;
let marketCandidates = new Map();
let marketLoading = false;
let marketError = null;
let marketGeneration = 0;
let marketAccount = null;
let marketConfirmation = null;
let ownershipTransfers = [];
let ownershipRevision = 0;
let transferRequest = null;
let transferDeviceId = null;
let consoleClaimAttempt = null;
let consoleClaimNotice = null;
let consoleClaimFlow = null;
let consoleClaimReceipt = null;
function resetConsoleClaim() {
  app.querySelector?.('[data-form="console-claim"]')?.reset();
  consoleClaimAttempt = null;
  consoleClaimNotice = null;
  consoleClaimFlow = null;
  consoleClaimReceipt = null;
}
let transferNotice = null;
let transferResendAt = 0;
let transferResendTimer;
let authMode = "login";
let authUsername = "";
let resendAt = 0;
let resendTimer;
let codeSent = false;
let passwordEditing = false;
let resetResendAt = 0;
let changeResendAt = 0;
let passwordResendTimer;
const forcedSignOutMessages = Object.freeze({
  AUTH_CLIENT_REPLACED: "账号已在其他客户端登录，当前客户端已下线，请重新登录。",
  AUTH_CLIENT_RETIRED: "账号保留的客户端数量已达上限，当前客户端已下线，请重新登录。",
  AUTH_CLIENT_REAUTH_REQUIRED: "当前在线状态需要重新验证，请重新登录。",
});
let notice = null;
let connectionFailure = null;
const localOperations = new Map();
let pendingSelection = null;
let revealedPendingOpenId = null;
const expandedDetails = new Set();
let busy = false;
let busyRequest = null;
function busyFor(action) { return busyRequest?.action === action; }
function authBusy() { return busy || currentState?.account?.phase === "authenticating"; }
function activityLabel(label) { return `<span class="activity-spinner" aria-hidden="true"></span>${escapeHTML(label)}`; }
let boxUpdatePollTimer;
let boxUpdatePollKey = null;
let boxUpdatePollError = null;
let boxUpdatePollRequest = null;
let boxVersionReadKey = null;
let boxVersionReadRequest = null;
let boxVersionReadError = null;
let renderedMarkup = null;
let activeInteraction = false;
let interactionTimer;
let setupState = { state: "idle" };
let setupReady = false;
let bluetoothState = window.wanxBluetooth?.snapshot() || { status: "unsupported" };
let setupRequest = null;
let setupSelection = null;
let setupTargetDeviceId = null;
let wifiPicker = newWifiPicker();
function newWifiPicker() { return { scanned: false, pending: null, networks: [], selected: null, manual: false, error: null, sessionId: null }; }
function resetWifiPicker() {
  const form = app.querySelector?.('[data-form="wifi"]');
  form?.reset?.();
  const password = form?.querySelector('[name="password"]');
  if (password) password.value = "";
  wifiPicker = newWifiPicker();
}
function wifiKey(network) { return JSON.stringify([network.ssid, network.security]); }
function wifiOptions() {
  const networks = [...wifiPicker.networks];
  if (wifiPicker.selected && !networks.some(item => wifiKey(item) === wifiKey(wifiPicker.selected))) networks.unshift(wifiPicker.selected);
  return '<option value="">请选择 Wi-Fi</option>' + networks.map(network => `<option value="${escapeHTML(wifiKey(network))}" ${network.security === "unsupported" ? "disabled" : ""}>${escapeHTML(network.ssid)} · 信号 ${network.signal}% · ${network.security === "open" ? "开放网络" : network.security === "unsupported" ? "暂不支持此安全类型" : "需要密码"}</option>`).join("");
}
function updateWifiPicker() {
  const form = app.querySelector?.('[data-form="wifi"]');
  if (!form) return;
  const picker = form.querySelector('[data-input="wifi-network"]');
  if (picker) { picker.innerHTML = wifiOptions(); picker.value = wifiPicker.selected ? wifiKey(wifiPicker.selected) : ""; picker.required = !wifiPicker.manual; }
  const status = form.querySelector('[data-wifi-status]');
  if (status) status.textContent = wifiPicker.pending ? "正在扫描盒子附近的 Wi-Fi…" : wifiPicker.error || (wifiPicker.scanned && !wifiPicker.networks.length ? "未发现 Wi-Fi，请刷新重试，或手动添加隐藏网络。" : "列表来自盒子附近的 Wi-Fi，按信号强度排列。暂不支持的安全类型不可选择。");
  const refresh = form.querySelector('[data-action="wifi-refresh"]');
  if (refresh) { refresh.disabled = Boolean(wifiPicker.pending); refresh.textContent = wifiPicker.pending ? "扫描中…" : "刷新列表"; }
  for (const name of ["ssid", "security", "hidden"]) {
    const field = form.querySelector(`[name="${name}"]`);
    if (field) { const label = field.closest?.("label"); if (label) label.hidden = !wifiPicker.manual; }
  }
  const list = form.querySelector('[data-wifi-list]');
  if (list) list.hidden = wifiPicker.manual;
  const mode = form.querySelector('[data-action="wifi-manual"]');
  if (mode) mode.textContent = wifiPicker.manual ? "返回 Wi-Fi 列表" : "隐藏网络 / 手动添加";
  const security = form.querySelector('[name="security"]');
  const password = form.querySelector('[name="password"]');
  if (password && security) {
    password.disabled = security.value === "open";
    password.required = security.value !== "open";
    const label = password.closest?.("label"); if (label) label.hidden = security.value === "open";
  }
}
async function scanWifi() {
  if (page !== "provisioning" || setupState.state !== "awaitingWifi") return;
  const picker = wifiPicker;
  if (picker.pending) return picker.pending;
  picker.scanned = true;
  picker.error = null;
  picker.pending = Promise.resolve().then(() => {
    if (wifiPicker !== picker || page !== "provisioning" || setupState.state !== "awaitingWifi") return [];
    return window.wanxSetup.scanWifi();
  }).then(networks => {
    if (wifiPicker !== picker || page !== "provisioning" || setupState.state !== "awaitingWifi") return;
    picker.networks = [...networks].sort((a, b) => b.signal - a.signal || a.ssid.localeCompare(b.ssid));
  }).catch(() => {
    if (wifiPicker === picker) picker.error = "无法扫描盒子附近的 Wi-Fi，请刷新重试，或手动添加网络。";
  }).finally(() => {
    if (wifiPicker !== picker) return;
    picker.pending = null;
    if (page === "provisioning" && setupState.state === "awaitingWifi") updateWifiPicker();
  });
  updateWifiPicker();
  return picker.pending;
}
let discoveryView = { selecting: false, retained: false, candidates: [] };
let discoveryMetadata = new Map();
let discoveryMetadataGeneration = 0;
let discoveryMetadataRequest = null;
function discoveryDeviceId(candidate) {
  const value = candidate.displayIdentity?.deviceId;
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,36}$/.test(value) ? value : "";
}
function resetDiscoveryMetadata() {
  ++discoveryMetadataGeneration;
  discoveryMetadata = new Map();
  discoveryMetadataRequest = null;
}
function discoveryMetadataActive() {
  return page === "provisioning" && currentState?.route !== "auth" && marketAccount !== null &&
    (discoveryView.selecting || discoveryView.retained);
}
function updateDiscoveryMetadata() {
  if (!discoveryMetadataActive()) { resetDiscoveryMetadata(); return; }
  const ids = new Set(discoveryView.candidates.map(discoveryDeviceId).filter(id => /^centauros-(?:[0-9a-f]{24}|[0-9a-f]{32})$/.test(id)));
  for (const id of discoveryMetadata.keys()) if (!ids.has(id)) discoveryMetadata.delete(id);
  for (const id of ids) if (!discoveryMetadata.has(id)) discoveryMetadata.set(id, { requested: false, value: null });
  // Coalesce identity notifications, then query each ID once per scan. Rendering
  // and account/network broadcasts never initiate discovery lookups.
  void Promise.resolve().then(loadDiscoveryMetadata);
}
async function loadDiscoveryMetadata() {
  if (!discoveryMetadataActive() || discoveryMetadataRequest) return;
  const entries = [...discoveryMetadata].filter(([, entry]) => !entry.requested).slice(0, 16);
  if (!entries.length) return;
  for (const [, entry] of entries) entry.requested = true;
  const request = { generation: discoveryMetadataGeneration, account: marketAccount, entries };
  discoveryMetadataRequest = request;
  try {
    const response = await window.wanxClient.action("devices.discovery", { deviceIds: entries.map(([id]) => id) });
    if (request.generation !== discoveryMetadataGeneration || request.account !== marketAccount || !discoveryMetadataActive()) return;
    const rows = response.ok && Array.isArray(response.value?.devices) ? response.value.devices : [];
    for (const [id, entry] of entries) {
      // Removing or replacing a GATT identity revokes its old asynchronous result.
      if (discoveryMetadata.get(id) !== entry) continue;
      const matches = rows.filter(row => row?.deviceId === id);
      const value = matches.length === 1 ? matches[0] : null;
      entry.value = {
        deviceName: typeof value?.deviceName === "string" ? value.deviceName : null,
        claimStatus: ["claimed", "unclaimed"].includes(value?.claimStatus) ? value.claimStatus : "unknown",
      };
    }
    // This read-only result cannot replace newer account state from broadcasts.
    render(currentState);
  } catch {
    // Older platforms and temporary failures keep the local name and unknown state.
  } finally {
    if (discoveryMetadataRequest === request) {
      discoveryMetadataRequest = null;
      void loadDiscoveryMetadata();
    }
  }
}
const selection = createDiscoverySelection({
  discovery: window.wanxDiscovery,
  transport: window.wanxDeviceSetupTransport,
  onChange(view) {
    discoveryView = view;
    updateDiscoveryMetadata();
    if (page === "provisioning") render(currentState);
  },
  onNotice(issue) {
    const messages = {
      NOTIFICATION_BOX_REQUIRED: "请先连接这条通知对应的盒子，再打开任务。",
      NOTIFICATION_NOT_FOUND: "这条通知已不可用，请刷新通知列表。",
      unavailable: "当前运行时尚未接入本地配网能力",
      expired: "扫描结果已过期，请重新扫描盒子。",
      reselect_failed: "未能连接所选盒子，请靠近盒子并重新扫描后重试。",
      selection_cancel_failed: "蓝牙扫描未能正常结束，请关闭并重新打开记忆盒子后再扫描。",
      empty: "未发现可用盒子，请确认盒子通电、靠近电脑，并检查电脑蓝牙后重新扫描。",
    };
    notice = issue ? messages[issue.kind] || issue.message : null;
  },
  onSelected(candidate) {
    const selected = setupSelection;
    setupSelection = null;
    if (selected?.mode === "wifi" && !deviceIsOwner(selected.deviceId)) {
      notice = "当前账号不是此盒子的主人，请刷新盒子列表后重试。";
      render(currentState);
      return;
    }
    void run("provisioning.start", { candidate, mode: selected?.mode || "claim", expectedDeviceId: selected?.expectedDeviceId,
      ...(selected?.mode === "console" ? { claimCode: consoleClaimAttempt?.claimCode } : {}) });
  },
});
window.addEventListener?.("pagehide", () => { resetWifiPicker(); resetDiscoveryMetadata(); selection.dispose(); supportView.close(); }, { once: true });
window.addEventListener?.("pagehide", () => { clearTimeout(resendTimer); clearTimeout(transferResendTimer); clearTimeout(passwordResendTimer); }, { once: true });
const stageLabels = {
  discover: "发现盒子",
  identity: "读取设备身份",
  network: "配置网络",
  claim: "认领设备",
  initialize: "初始化盒端",
};

const escapeHTML = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

// Progress is display-only; deviceCanConnect still enforces actual readiness.
function deviceNetworkStatus(device) {
  if (device.local || device.cloudPresence === "offline" ||
      !["ready", "unreachable"].includes(device.accessState) ||
      (device.networkReady !== false && device.accessState !== "unreachable")) return null;
  const connecting = device.localReachability !== "unreachable" && (device.networkConnectionState === "connecting" ||
    (!device.networkConnectionState && (currentState.platform?.phase === "enrolling" ||
      currentState.network?.phase === "checking")));
  return connecting
    ? { label: "正在连接盒子网络", detail: "正在建立与盒子的连接，请稍候；长时间未完成可点击“刷新设备”重连。" }
    : { label: "连接暂未建立", detail: "请点击“刷新设备”重连；如仍未连接，请确认电脑和盒子联网。" };
}

function statusLabel(device) {
  const selected = (currentState.selectedDeviceId || currentState.activeDeviceId) === device.deviceId;
  if (currentState.recovery?.deviceId === device.deviceId && currentState.recovery.status === "failed") return "连接已中断，请点击“刷新设备”重连";
  if (selected && currentState.recovery?.status === "retrying") return `正在重连 · 第 ${currentState.recovery.attempt} 次尝试`;
  if (selected && currentState.connectionPhase === "recovering") return "正在恢复连接";
  if (selected && ["connecting", "resolving"].includes(currentState.connectionPhase)) return "正在连接";
  if (currentState.activeDeviceId === device.deviceId) return "当前连接";
  const accessLabel = {
    service_unavailable: "账号服务待更新", access_denied: "未获访问权限",
    authorization_unavailable: "盒子授权组件待更新", authorization_pending: "正在同步访问权限",
    network_unconfigured: "盒子尚未接入网络", identity_unavailable: "盒子身份待就绪",
  }[device.accessState];
  if (accessLabel) return accessLabel;
  if (["denied", "forbidden", "unauthorized", "revoked", "ownership_conflict"].includes(device.accessState)) return "需要访问权限";
  const network = deviceNetworkStatus(device);
  if (network) return network.label;
  if (device.accessState === "unreachable" || device.localReachability === "unreachable") return "当前不可达";
  if (["initializing", "provisioning"].includes(device.accessState)) return "正在准备设备";
  if (device.accessState === "offline" || device.cloudPresence === "offline") return "设备离线";
  if (device.accessState === "ready" && device.networkReady === false) return "当前不可达";
  if (device.canOpen === false) return "暂不可连接";
  if (device.canOpen === true || device.accessState === "ready") return "可连接";
  if (device.accessState === "discovered" || device.lifecycle === "discovered") return "待配置";
  return "暂不可连接";
}

function deviceCanConnect(device) {
  return device.canOpen !== false && device.networkReady !== false && (device.canOpen === true || device.accessState === "ready");
}

function authorizationHint() {
  return "请保持电脑和盒子联网，授权同步完成后会自动更新；长时间未完成可点击刷新。";
}

function deviceCard(device) {
  const selected = currentState.activeDeviceId === device.deviceId;
  const connecting = (busyRequest?.action === "devices.connect" && busyRequest.deviceId === device.deviceId) ||
    ((currentState.selectedDeviceId || currentState.activeDeviceId) === device.deviceId &&
      ["connecting", "resolving", "recovering"].includes(currentState.connectionPhase));
  const disconnecting = busyFor("devices.disconnect") && busyRequest.deviceId === device.deviceId;
  const available = deviceCanConnect(device);
  const needsSetup = ["discovered", "unclaimed", "uninitialized"].includes(device.accessState);
  const networkHint = !selected && !connecting ? deviceNetworkStatus(device)?.detail : null;
  const action = disconnecting
    ? `<button class="button small activity-button" aria-busy="true" disabled>${activityLabel("正在断开…")}</button>`
    : currentState.selectedDeviceId === device.deviceId && currentState.recovery?.status === "retrying"
    ? `<button class="button small" data-action="disconnect" ${busy ? "disabled" : ""}>停止重连</button>`
    : connecting
    ? `<button class="button small activity-button" aria-busy="true" disabled><span class="activity-spinner" aria-hidden="true"></span>正在连接…</button>`
    : selected
    ? `<button class="button small" data-action="disconnect" ${busy ? "disabled" : ""}>断开</button>`
    : available && (device.local || currentState.networkReady)
      ? `<button class="button small" data-action="connect" data-device-id="${escapeHTML(device.deviceId)}" ${busy ? "disabled" : ""}>${currentState.activeDeviceId ? "切换并连接" : "连接"}</button>`
      : available
        ? `<button class="button small" disabled>${networkStatus().label}</button>`
        : needsSetup ? `<button class="button small" data-action="provisioning" ${busy ? "disabled" : ""}>配置盒子</button>`
          : `<span class="muted">${escapeHTML(statusLabel(device))}</span>`;
  return `<article class="device-card ${selected ? "selected" : ""}">
    <img class="device-icon" src="./assets/centaurai-mark.png" alt="" />
    <div class="device-main"><h3>${escapeHTML(device.name || device.displayName || "盒子")}</h3><p class="device-meta"><span class="status-dot ${selected ? "ready" : ""}"></span>${device.local ? "本机服务 · " : ""}${escapeHTML(statusLabel(device))}</p>${device.accessState === "authorization_pending" ? `<p class="device-meta">${authorizationHint()}</p>` : ""}${networkHint ? `<p class="device-meta" role="status">${escapeHTML(networkHint)}</p>` : ""}${connectionFailure?.deviceId === device.deviceId ? `<p class="inline-error" role="alert">${escapeHTML(connectionFailure.message)} <button class="text-button" data-action="show-help" data-scene="box_connection">查看常见问题</button></p>` : ""}</div>
    <div class="device-action">${action}${!currentState.dataIdentity?.profileId && (device.deviceRole === "owner" || device.role === "owner") ? `${!device.local ? `<button class="text-button" data-action="configure-network" data-device-id="${escapeHTML(device.deviceId)}" ${busy ? "disabled" : ""}>配置网络</button>` : ""}<button class="text-button" data-action="support-open" data-device-id="${escapeHTML(device.deviceId)}" ${busy ? "disabled" : ""}>远程协助</button><button class="text-button" data-action="transfer-open" data-device-id="${escapeHTML(device.deviceId)}" ${busy ? "disabled" : ""}>转移所有权</button>` : ""}</div></article>`;
}

function networkStatus() {
  if (currentState.dataIdentity?.profileId) return currentState.canLaunchApplications
    ? { label: "本地身份已连接", detail: "已验证这台设备的访问授权。" }
    : { label: "本地身份", detail: "请先连接盒子，再使用盒子上的应用。" };
  if (currentState.activeDeviceId && currentState.connection?.mode === "local") return { label: "本机已连接", detail: "正在使用这台电脑上的记忆盒子服务。" };
  if (currentState.network?.enabled === false) return { label: "网络尚未就绪", detail: "请检查本机网络后点击“刷新设备”重试。" };
  if (currentState.networkReady) return { label: "网络已连接", detail: "可以连接盒子并使用应用。" };
  if (currentState.platform?.reason === "NETWORK_REVOCATION_PENDING")
    return { label: "网络会话清理中", detail: "服务器正在清理旧连接，完成后将自动重连；传输会保留进度等待恢复。" };
  if (currentState.platform?.reason === "NETWORK_LEASE_EXPIRED")
    return { label: "网络授权已到期", detail: "请点击“刷新设备”重连，重新获取授权后继续传输。" };
  if (currentState.platform?.phase === "unavailable" || ["unavailable", "failed", "error"].includes(currentState.network?.phase))
    return { label: "网络暂不可用", detail: "请点击“刷新设备”重连，并确认电脑和盒子联网。" };
  return { label: "网络连接中", detail: "正在准备与盒子的连接，请稍候；长时间未完成可点击“刷新设备”重连。" };
}

function activeDeviceName() {
  return currentState.devices?.find((device) => device.deviceId === currentState.activeDeviceId)?.name || currentState.connection?.name || "盒子";
}

function profileAvatar(large = false) {
  const profile = currentState.account?.profile || {};
  const avatar = typeof profile.avatarDataUrl === "string" && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(profile.avatarDataUrl) && profile.avatarDataUrl.length <= 512000 ? profile.avatarDataUrl : null;
  return `<span class="user-avatar ${large ? "large" : ""}">${avatar ? `<img src="${avatar}" alt="用户头像" />` : `<span aria-hidden="true">${escapeHTML(Array.from(profile.displayName || "我")[0])}</span>`}</span>`;
}
function shellHeader(title) {
  const activePage = page === "provisioning" ? "boxes" : page;
  const name = currentState.account?.profile?.displayName || "用户";
  return `<header class="topbar">
    <button class="brand brand-button" data-action="desktop-about" aria-label="关于${clientBrand}"><img class="brand-mark" src="./assets/centaurai-mark.png" alt="" />${clientBrandCopy}</button>
    <h1 class="sr-only">${title}</h1>
    <nav class="main-nav" aria-label="管理导航">${[["my-ai", "我的 AI"], ["memory", "记忆"], ["data", "星图"], ["space", "空间"], ["boxes", "盒子"], ["accessories", "配件"]].map(([destination, label]) => `<button class="nav-item ${activePage === destination ? "active" : ""}" data-action="show-${destination}" ${activePage === destination ? 'aria-current="page"' : ""} ${page === "provisioning" ? "disabled" : ""}>${label}</button>`).join("")}</nav>
    <div class="header-personal"><button class="notification-trigger ${page === "notifications" ? "active" : ""}" data-action="show-notifications" aria-label="通知中心，${currentState.notifications?.unreadCount || 0} 条未读" title="通知中心" ${page === "provisioning" ? "disabled" : ""}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3 9v6h4l8 4V5L7 9H3Z" stroke-linejoin="round"/><path d="m7 15 1 5h3l-1-4M18 8c2 2 2 6 0 8" stroke-linecap="round" stroke-linejoin="round"/></svg>${currentState.notifications?.unreadCount > 0 ? `<span class="notification-badge" aria-hidden="true">${currentState.notifications.unreadCount > 99 ? "99+" : currentState.notifications.unreadCount}</span>` : ""}</button><div class="account-menu"><button class="avatar-trigger" data-action="profile-menu" aria-label="个人资料与设置" aria-expanded="${profileMenuOpen}" aria-controls="profile-menu" ${page === "provisioning" ? "disabled" : ""}>${profileAvatar()}<span aria-hidden="true">⌄</span></button>
    ${profileMenuOpen ? `<div class="profile-menu" id="profile-menu"><div class="profile-menu-identity"><strong>${escapeHTML(name)}</strong><small>${escapeHTML(currentState.account?.maskedPhone || "云账号")}</small></div>${currentState.account?.phase === "authenticated" ? `<button data-action="show-profile">个人资料<span>›</span></button>` : `<button data-action="cloud-login">登录云账号<span>›</span></button>`}<button data-action="show-credits">积分<span class="profile-credit-balance">${escapeHTML(creditsView.label())} ›</span></button><button data-action="show-settings">设置<span>›</span></button><button data-action="show-help">问题与反馈<span>›</span></button><div class="profile-menu-divider"></div><button data-action="logout" class="${busyFor("auth.logout") ? "activity-button" : ""}" aria-busy="${busyFor("auth.logout")}" ${busy ? "disabled" : ""}>${busyFor("auth.logout") ? activityLabel("正在退出…") : currentState.account?.phase === "authenticated" ? "退出云账号" : "未登录云账号"}</button></div>` : ""}</div></div></header>${clientUpdateRequired() && page !== "client-update" ? clientUpdateRequirementNotice() : ""}`;
}
function accessoriesView() {
  return `<div class="app-layout accessories-layout">${shellHeader("配件")}
    <section class="accessories-tab-host" aria-label="配件工作台">
      <div class="accessories-tab-feedback" data-accessories-feedback>
        <p role="status">正在打开配件工作台…</p>
        <button type="button" class="button small" data-action="accessories-preview-retry" hidden>重试</button>
      </div>
    </section></div>`;
}
function syncAccessoriesPreview() {
  const visible = accessoryPageVisible && !profileMenuOpen && !marketConfirmation && !helpDrawer && !academyDrawer?.isOpen?.();
  accessoryPreview?.mount(visible ? app.querySelector(".accessories-tab-host") : null);
}
function profileView() {
  const account = currentState.account || {}, profile = account.profile || {};
  const avatarPending = busyFor("profile.avatar") || busyFor("profile.avatar-remove");
  return `<div class="app-layout">${shellHeader("个人资料")}<div class="page-content profile-page">
    <div class="page-heading"><h2>个人资料</h2><p class="muted">用你熟悉的样子，在记忆盒子相见。</p></div>
    ${notice ? `<div class="notice ${codeSent ? "success" : "error"}" role="status">${escapeHTML(notice)}</div>` : ""}
    <section class="profile-card"><div class="profile-avatar-row"><button class="profile-avatar-button" data-action="profile-avatar" aria-label="上传头像" ${busy ? "disabled" : ""}>${profileAvatar(true)}<span>更换头像</span></button><div><h3>你的头像</h3><p class="muted">支持 JPG、PNG，最大 5 MB。图片将居中裁为方形。</p><div class="settings-actions"><button class="button small ${busyFor("profile.avatar") ? "activity-button" : ""}" data-action="profile-avatar" aria-busy="${busyFor("profile.avatar")}" ${busy ? "disabled" : ""}>${busyFor("profile.avatar") ? activityLabel("正在更新…") : "上传头像"}</button>${profile.avatarDataUrl ? `<button class="text-button ${busyFor("profile.avatar-remove") ? "activity-button" : ""}" data-action="profile-avatar-remove" aria-busy="${busyFor("profile.avatar-remove")}" ${busy ? "disabled" : ""}>${busyFor("profile.avatar-remove") ? activityLabel("正在恢复…") : "恢复默认"}</button>` : ""}</div></div></div>${avatarPending ? `<p class="muted activity-status" role="status">${activityLabel("正在更新头像…")}</p>` : ""}
    <form data-form="profile"><label for="profile-name">昵称</label><input id="profile-name" name="displayName" value="${escapeHTML(profile.displayName || "用户")}" maxlength="80" required autocomplete="nickname" /><p class="muted">最多 40 个字符，昵称不会改变登录账号。</p><button class="button primary ${busyFor("profile.save") ? "activity-button" : ""}" type="submit" aria-busy="${busyFor("profile.save")}" ${busy ? "disabled" : ""}>${busyFor("profile.save") ? activityLabel("正在保存…") : "保存资料"}</button></form></section>
    <section class="profile-card profile-credits"><div><h3>积分</h3><p class="profile-credit-balance">${escapeHTML(creditsView.label())}</p></div><button class="button small" data-action="show-credits">查看积分明细<span aria-hidden="true"> ›</span></button></section>
    <section class="profile-card profile-account"><h3>云账号</h3><dl><dt>绑定手机号</dt><dd>${escapeHTML(account.maskedPhone || "暂未提供")}</dd><dt>资料保存</dt><dd>当前电脑</dd></dl><p class="muted">头像和昵称仅保存在这台电脑，按云账号分别保存。</p></section>
    </div></div>`;
}

function notificationView() {
  const center = currentState.notifications || { items: [], unreadCount: 0, taskStatus: "disconnected" };
  const items = (center.items || []).filter(item => notificationFilter !== "unread" || !item.readAt || item.id === expandedNotificationId);
  const status = { disconnected: "连接盒子后接收应用任务消息。", connecting: "正在连接任务消息…", unavailable: "任务消息暂时无法同步，稍后会自动重试。", "upgrade-required": "此盒子需更新后才能同步半人马环通知。" }[center.taskStatus];
  return `<div class="app-layout">${shellHeader("通知中心")}<div class="page-content notification-page">
    <div class="page-heading"><div><h2>通知中心</h2><p class="muted">应用动态与任务进展，都在这里。</p></div><button class="button" data-action="notifications-refresh" ${busy ? "disabled" : ""}>刷新</button></div>
    ${notice ? `<div class="notice error" role="status">${escapeHTML(notice)}</div>` : ""}
    <div class="notification-toolbar"><div class="notification-filters" role="group" aria-label="筛选通知"><button data-action="notifications-filter" data-filter="all" aria-pressed="${notificationFilter === "all"}">全部</button><button data-action="notifications-filter" data-filter="unread" aria-pressed="${notificationFilter === "unread"}">未读${center.unreadCount ? ` ${center.unreadCount}` : ""}</button></div><button class="text-button" data-action="notifications-read-all" ${!center.unreadCount || busy ? "disabled" : ""}>全部已读</button></div>
    ${status ? `<p class="muted notification-sync" role="status">${status}</p>` : ""}
    ${center.storageError ? `<p class="notice error" role="status">通知暂时无法保存在本机，请检查系统安全存储后重启记忆盒子。</p>` : ""}
    <section class="notification-list" aria-label="消息列表">${items.length ? items.map(item => {
      const expanded = expandedNotificationId === item.id;
      const date = new Date(item.createdAt);
      const time = Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date) : "";
      return `<article class="notification-card ${item.readAt ? "" : "unread"}"><span class="notification-kind" aria-hidden="true">${item.category === "task" ? "↗" : item.category === "system" ? "◈" : "▦"}</span><div class="notification-main"><button class="notification-summary" data-action="notifications-select" data-id="${escapeHTML(item.id)}" aria-expanded="${expanded}"><span class="notification-title">${escapeHTML(item.title)}${!item.readAt ? '<i class="notification-unread-dot" aria-label="未读"></i>' : ""}</span><span class="notification-meta">${item.category === "task" ? "任务消息" : item.category === "system" ? "系统通知" : "应用动态"}${item.deviceName ? ` · ${escapeHTML(item.deviceName)}` : ""}<time>${escapeHTML(time)}</time></span><span class="notification-body ${expanded ? "expanded" : ""}">${escapeHTML(item.body)}</span></button></div></article>`;
    }).join("") : `<div class="notification-empty"><span aria-hidden="true">✧</span><h3>${notificationFilter === "unread" ? "未读消息都看完了" : "暂时没有通知"}</h3><p class="muted">有新的应用动态或任务进展时，会在这里提醒你。</p></div>`}</section>
    <p class="muted notification-footnote">通知按当前账号保存在这台电脑。</p>
  </div></div>`;
}

function resendSeconds() {
  return Math.max(0, Math.ceil((resendAt - Date.now()) / 1000));
}

function updateResendButton() {
  clearTimeout(resendTimer);
  const remaining = resendSeconds();
  const button = document.querySelector('[data-action="send-registration-code"]');
  if (button) {
    button.disabled = busy || remaining > 0;
    const sending = busyFor("auth.send-code");
    button.classList.toggle("activity-button", sending);
    button.setAttribute("aria-busy", String(sending));
    button.innerHTML = sending ? activityLabel("正在发送…") : remaining ? `${remaining} 秒后重新获取` : "获取验证码";
  }
  if (remaining) resendTimer = setTimeout(updateResendButton, 1000);
}

function updateTransferCodeButton() {
  clearTimeout(transferResendTimer);
  const remaining = Math.max(0, Math.ceil((transferResendAt - Date.now()) / 1000));
  const button = document.querySelector('[data-action="transfer-code"]');
  if (button) {
    button.disabled = busy || remaining > 0;
    button.textContent = remaining ? `${remaining} 秒后重新发送` : "发送验证码";
  }
  if (remaining) transferResendTimer = setTimeout(updateTransferCodeButton, 1000);
}

function authSubmitLabel() {
  return authMode === "register" ? "创建账号并进入" : authMode === "reset" ? "重置密码" : "登录并进入";
}

function passwordFields(prefix, action, until) {
  const remaining = Math.max(0, Math.ceil((until - Date.now()) / 1000));
  const sending = busyFor({ "send-registration-code": "auth.send-code", "send-reset-code": "auth.send-reset-code", "send-change-code": "auth.send-change-code" }[action]);
  return `<label for="${prefix}-confirm-password">确认密码</label><input id="${prefix}-confirm-password" name="confirmPassword" type="password" required autocomplete="new-password" placeholder="再次输入密码" /><label for="${prefix}-code">短信验证码</label><div class="code-field"><input id="${prefix}-code" name="code" required pattern="[0-9]{6}" inputmode="numeric" autocomplete="one-time-code" placeholder="输入 6 位验证码" /><button class="button small ${sending ? "activity-button" : ""}" type="button" data-action="${action}" aria-busy="${sending}" ${busy || remaining ? "disabled" : ""}>${sending ? activityLabel("正在发送…") : remaining ? `${remaining} 秒后重新获取` : "获取验证码"}</button></div>`;
}

function updatePasswordCodeButtons() {
  clearTimeout(passwordResendTimer);
  let waiting = false;
  for (const [action, until] of [["send-reset-code", resetResendAt], ["send-change-code", changeResendAt]]) {
    const remaining = Math.max(0, Math.ceil((until - Date.now()) / 1000));
    const button = document.querySelector(`[data-action="${action}"]`);
    if (button) {
      button.disabled = busy || remaining > 0;
      const sending = busyFor(action === "send-reset-code" ? "auth.send-reset-code" : "auth.send-change-code");
      button.classList.toggle("activity-button", sending);
      button.setAttribute("aria-busy", String(sending));
      button.innerHTML = sending ? activityLabel("正在发送…") : remaining ? `${remaining} 秒后重新获取` : "获取验证码";
      waiting ||= remaining > 0;
    }
  }
  if (waiting) passwordResendTimer = setTimeout(updatePasswordCodeButtons, 1000);
}

function authView() {
  const register = authMode === "register";
  const reset = authMode === "reset";
  const newPassword = register || reset;
  return `<div class="auth-layout"><section class="auth-card">
    <button class="auth-brand brand-button" data-action="desktop-about" aria-label="关于${clientBrand}"><img class="brand-mark" src="./assets/centaurai-mark.png" alt="" />${clientBrandCopy}</button>
    <h1>${reset ? "找回密码" : register ? "创建云账号" : "登录记忆盒子"}</h1><p class="muted">${currentState.dataIdentity?.profileId ? "云账号用于应用市场与计费；盒子数据访问使用独立本地身份。" : "连接你的 AI，整理记忆与资料。"}</p>
        ${reset ? `<p class="muted">通过账号绑定的手机号验证身份，重置后请用新密码登录。</p>` : `<div class="tabs"><button class="tab ${!register ? "active" : ""}" data-action="auth-login" ${busy ? "disabled" : ""}>登录</button><button class="tab ${register ? "active" : ""}" data-action="auth-register" ${busy ? "disabled" : ""}>注册</button></div>`}
        <form id="auth-form" data-form="auth" data-mode="${authMode}" novalidate>
          <label for="account-name">手机号</label>
          <div class="auth-phone-field">
            <input id="account-name" name="username" value="${escapeHTML(authUsername)}" required pattern="1[0-9]{10}" autocomplete="username" placeholder="13800138000" />
            ${!newPassword ? `<div class="auth-saved-logins" data-saved-logins hidden><select id="saved-login" name="savedLogin" aria-label="选择已保存账号" title="选择已保存账号" ${authBusy() ? "disabled" : ""}><option value="">使用其他账号</option></select></div>` : ""}
          </div>
          <label for="account-password">${reset ? "新密码" : "密码"}</label>
          <input id="account-password" name="password" type="password" required autocomplete="${newPassword ? "new-password" : "current-password"}" placeholder="${newPassword ? "设置 8–72 字节的新密码" : "输入密码"}" />
          ${newPassword ? passwordFields("account", reset ? "send-reset-code" : "send-registration-code", reset ? resetResendAt : resendAt) : ""}
          ${!newPassword ? `<label class="remember-login"><input type="checkbox" name="remember" checked ${busy ? "disabled" : ""} />记住账号密码</label>` : ""}
          <div data-auth-notice class="notice ${codeSent ? "success" : "error"}" role="status" ${notice ? "" : "hidden"}>${escapeHTML(notice)}</div>
          <button class="button primary wide" type="submit" ${authBusy() ? "disabled" : ""}>${authBusy() ? authBusyLabel() : authSubmitLabel()}</button>
        </form>
        <button class="text-button auth-help" data-action="show-help">常见问题</button>
        <button class="text-button auth-help" data-action="${reset ? "auth-login" : "auth-reset"}" ${busy ? "disabled" : ""}>${reset ? "返回登录" : "忘记密码？"}</button>
        ${currentState.dataIdentity?.phase === "unlocked" ? `<button class="text-button auth-help" data-action="local-return">返回本地应用</button>` : ""}
    </section></div>`;
}

function updateBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "未知";
  return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function updateGuidance(code) {
  const messages = {
      NOTIFICATION_BOX_REQUIRED: "请先连接这条通知对应的盒子，再打开任务。",
      NOTIFICATION_NOT_FOUND: "这条通知已不可用，请刷新通知列表。",
    PLAN_STALE: "盒子状态已变化，请重新检查并生成更新计划。",
    UPDATE_IN_PROGRESS: "已有更新正在进行，请刷新该任务的进度。",
    UNSUPPORTED_PLATFORM: "此平台尚未通过更新验证，请继续使用当前版本并联系维护人员。",
    CONTRACT_UNSUPPORTED: "当前程序暂不支持此更新，请先安装受支持的记忆盒子版本。",
    UPDATE_SIGNATURE_VERIFICATION_FAILED: "无法核验安装包的系统签名，请联系维护人员。",
    DEPENDENCY_CONFLICT: "当前应用与目标版本不兼容，请保留现有版本并等待兼容更新。",
    INSUFFICIENT_SPACE: "可用空间不足，请释放空间后重新检查。",
    UPDATE_PERMISSION_REQUIRED: "你没有此盒子的更新权限，请联系盒主更新。",
    RELEASE_WITHDRAWN: "此版本已停止提供，请重新检查更新。",
    RECOVERY_REQUIRED: "更新需要维护人员处理，请保留当前状态并提供下方任务编号。",
    INVENTORY_UNKNOWN: "尚未取得可核验的盒端运行版本，请联系运维人员检查版本报告与部署回执。",
    UPGRADE_BASELINE_UNVERIFIED: "当前版本到目标发行的升级路径尚未验收，请联系发布管理员；不影响查看当前运行版本。",
    INVENTORY_STALE: "盒子的版本报告已过期，请等待盒子联网后重新检查。",
    RELEASE_UNAVAILABLE: "暂时没有适用更新，请保留当前版本并稍后检查。",
    UPDATER_UNSUPPORTED: "盒端管理组件版本过旧，请联系盒主完成受控引导升级。",
    UPDATER_NOT_READY: "盒端升级服务尚未就绪，请联系盒主完成管理组件引导和验证。",
    ALREADY_CURRENT: "盒子已运行目标版本，无需再次更新。",
    UPDATE_UNAVAILABLE: "暂时无法检查更新，请稍后重试。",
    UPDATE_REQUEST_FAILED: "暂时无法连接更新服务，请检查网络后重试。",
    CLIENT_UPDATE_REQUIRED: "请先更新记忆盒子，再启动新的业务。已打开的应用可继续保存工作。",
    ACCOUNT_LOGIN_REQUIRED: "请先登录云账号，再检查更新。",
    UPDATE_DEVELOPMENT_BUILD: "这是开发构建，请使用正式发行包接收客户端更新。",
    UPDATE_INSTALL_LOCATION_UNSUPPORTED: "当前安装位置不支持应用内更新，请使用面向当前用户的正式安装包重新安装。",
    UPDATE_EDITION_MISMATCH: "此更新包与当前客户端类型不一致，请选择适用的安装包。",
    UPDATE_NOT_CONFIGURED: "当前未配置正式更新，请联系发行维护人员获取受支持的安装包。",
    UPDATE_SIGNER_NOT_CONFIGURED: "当前未配置安装包签名校验，请联系发行维护人员。",
    UPDATE_LOCAL_NEWER: "当前版本高于渠道版本，继续保留现有安装。",
    UPDATE_SAME_VERSION_BUILD: "渠道构建与当前构建不同，请联系发行维护人员确认；不会按同版本自动替换。",
    UPDATE_RECOVERY_REQUIRED: "上次客户端更新未完成，请重新检查更新；若无法启动新版本，请联系维护人员。",
    UPDATE_CANDIDATE_CHANGED: "可用更新已变化，请重新检查后确认。",
    UPDATE_UNTRUSTED_KEY: "发行签名不受信任，已保留当前版本，请联系发行维护人员。",
    SIGNATURE_INVALID: "发行签名校验未通过，已保留当前版本，请联系发行维护人员。",
    UPDATE_ARTIFACT_MISMATCH: "下载内容与发行不一致，已保留当前版本，请重新检查更新。",
    APPLICATIONS_RUNNING: "请保存工作并关闭正在运行的应用，再重启更新。",
  };
  const key = String(code || "").toUpperCase().match(/(?:^|ERROR: )([A-Z][A-Z0-9_]{1,80})$/)?.[1];
  return messages[key] || "请重新检查更新；若仍失败，请联系维护人员并提供错误代码。";
}

function applicationUpdateGuidance(issue) {
  if (!issue || typeof issue !== "object" || issue.code !== "DEPENDENCY_CONFLICT" ||
      !["HOST_PROTOCOL_INCOMPATIBLE", "APPLICATION_CONTRACT_UNSUPPORTED"].includes(issue.reasonCode) ||
      typeof issue.applicationId !== "string" || !/^[a-z][a-z0-9._-]{1,127}$/.test(issue.applicationId)) return null;
  const label = typeof issue.applicationName === "string" && issue.applicationName.trim() &&
    issue.applicationName.length <= 128 && !/[\x00-\x1f\x7f]/.test(issue.applicationName)
    ? `${issue.applicationName.trim()}（${issue.applicationId}）` : issue.applicationId;
  const version = typeof issue.version === "string" && /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(issue.version)
    ? issue.version : "待确认";
  return issue.reasonCode === "HOST_PROTOCOL_INCOMPATIBLE"
    ? `应用 ${label}（已安装版本 ${version}）与目标记忆盒子的应用接口不兼容。请先安装兼容的应用版本，再检查记忆盒子更新。`
    : `无法核验应用 ${label} 的兼容信息（已安装版本 ${version}）。请先更新或重新安装此应用，再检查记忆盒子更新。`;
}

function updateIssueView(update) {
  const blockers = Array.isArray(update?.blockers) ? update.blockers : [];
  const issues = blockers.length ? blockers : update?.reason ? [update.reason] : [];
  return issues.length ? `<div class="update-issues" role="status">${issues.map(issue => {
    const code = typeof issue === "string" ? issue : issue.code || issue.reason;
    const guidance = applicationUpdateGuidance(issue) || (code === "DEPENDENCY_CONFLICT" ? updateGuidance(code)
      : typeof issue === "object" && issue.message ? issue.message : updateGuidance(code));
    return `<p>${escapeHTML(guidance)}${code ? ` <span class="muted">（${escapeHTML(code)}）</span>` : ""}</p>`;
  }).join("")}</div>` : "";
}

function clientUpdateRequired(state = currentState) {
  return state?.upgrades?.client?.requirement?.required === true;
}
function clientUpdateRequirementNotice() {
  const version = currentState.upgrades.client.requirement.minimumVersion;
  return `<div class="notice" role="status">需要更新记忆盒子至 v${escapeHTML(version)} 或更高版本，才能启动新的业务。<button class="text-button" data-action="show-client-update">查看客户端更新</button></div>`;
}
function requiredClientUpdateView() {
  const version = currentState.upgrades.client.requirement.minimumVersion;
  const authenticated = currentState.account?.phase === "authenticated";
  return `<div class="app-layout" ${marketConfirmation ? "inert" : ""}>${shellHeader("需要更新记忆盒子")}<div class="page-content">
    <div class="page-heading"><div><h2>需要更新记忆盒子</h2><p class="muted">请更新至 v${escapeHTML(version)} 或更高版本，再启动新的业务。</p></div></div>
    <p>已打开的应用不会被强制关闭，请先保存正在进行的工作。下载完成后，由你确认重启安装。</p>
    ${notice ? `<div class="notice error" role="status">${escapeHTML(notice)}</div>` : ""}
    ${clientUpdateView()}
    <p class="muted">${authenticated ? "若更新失败，可重新检查更新或查看诊断；也可联系管理员获取正式安装包。" : "请先登录云账号，再检查和下载更新。"}</p>
    <div class="settings-actions"><button class="button" data-action="show-settings">设置</button><button class="button" data-action="show-boxes">查看诊断</button><button class="button" data-action="${authenticated ? "logout" : "cloud-login"}" ${busy ? "disabled" : ""}>${authenticated ? "切换登录账号" : "登录账号"}</button><button class="button" data-action="show-help">常见问题</button><button class="button" data-action="desktop-quit" ${busy ? "disabled" : ""}>退出记忆盒子</button></div>
  </div></div>${confirmationView()}`;
}

function clientUpdateView() {
  const update = currentState.upgrades?.client || {};
  const current = update.current || {};
  const candidate = update.candidate;
  const alreadyCurrent = update.phase === "blocked" && update.reason === "RELEASE_UNAVAILABLE" && !update.blockers?.length && update.requirement?.required !== true;
  const phase = alreadyCurrent ? "up_to_date" : update.phase || "unavailable";
  const labels = {
    development: "开发构建，请安装正式发行包以接收更新。", unavailable: "当前尚未接入正式更新。",
    idle: "尚未检查更新", checking: "正在检查更新…", available: "有可用更新", up_to_date: "当前已是最新版本",
    blocked: "此更新暂不可用", downloading: "正在下载更新…", downloaded: "更新已下载，可选择现在重启安装",
    installing: "正在准备重启安装…", failed: "更新未完成，当前版本仍保留", succeeded: "已完成客户端更新",
  };
  const checking = phase === "checking" || busyFor("updates.client.check");
  const downloading = phase === "downloading" || busyFor("updates.client.download");
  const pending = checking || downloading || phase === "installing";
  const disabled = busy || pending ? "disabled" : "";
  const progress = update.progress;
  const transferred = Number(progress?.transferred);
  const total = Number(progress?.total);
  const hasProgress = progress && Number.isFinite(transferred) && transferred >= 0;
  const hasTotal = hasProgress && Number.isFinite(total) && total > 0;
  return `<article class="update-card"><div class="update-heading"><div><h3>记忆盒子 <span class="update-version">${current.internalVersion ? escapeHTML(current.internalVersion) : current.productVersion ? `v${escapeHTML(current.productVersion)}` : "版本待核验"}</span></h3><p class="muted ${pending ? "activity-status" : ""}" role="status">${pending ? '<span class="activity-spinner" aria-hidden="true"></span>' : ""}${escapeHTML(checking ? labels.checking : downloading ? labels.downloading : labels[phase] || "更新状态待确认")}</p></div><div class="settings-actions">${!["downloaded", "installing"].includes(phase) ? `<button class="button small ${checking ? "activity-button" : ""}" data-action="updates-client-check" aria-busy="${checking}" ${disabled}>${checking ? activityLabel("检查中…") : "检查更新"}</button>` : ""}${phase === "available" && candidate ? `<button class="button primary small ${downloading ? "activity-button" : ""}" data-action="updates-client-download" aria-busy="${downloading}" ${disabled}>${downloading ? activityLabel("正在下载…") : "下载更新"}</button>` : ""}${phase === "downloaded" && candidate ? `<button class="button primary small" data-action="updates-client-install" ${disabled}>重启并更新</button>` : ""}</div></div>
    ${candidate ? `<p class="update-candidate">可用版本 v${escapeHTML(candidate.productVersion || "待核验")}${candidate.size != null ? ` · ${escapeHTML(updateBytes(candidate.size))}` : ""}${candidate.requiresRestart ? " · 需要重启记忆盒子" : ""}</p>${candidate.releaseNotes ? `<p class="update-notes">${escapeHTML(candidate.releaseNotes)}</p>` : ""}` : ""}
    ${hasProgress ? `<div class="update-progress" role="status"><progress aria-label="客户端下载进度" ${hasTotal ? `max="${total}" value="${Math.min(transferred, total)}"` : ""}></progress><span>${escapeHTML(updateBytes(transferred))}${hasTotal ? ` / ${escapeHTML(updateBytes(total))}` : " · 总大小待确认"}</span></div>` : ""}
    ${alreadyCurrent ? "" : updateIssueView(update)}
    <details class="application-details" data-detail-id="updates-client" ${expandedDetails.has("updates-client") ? "open" : ""}><summary>版本详情</summary><dl class="update-facts">${current.internalVersion && current.productVersion ? `<dt>构建版本</dt><dd>${escapeHTML(current.productVersion)}</dd>` : ""}<dt>构建标识</dt><dd>${escapeHTML(current.buildId || "未知")}</dd><dt>渠道 / 类型</dt><dd>${escapeHTML(current.channel || "未知")} / ${escapeHTML(current.distributionClass || "未知")}</dd><dt>平台</dt><dd>${escapeHTML(current.platform || "未知")} / ${escapeHTML(current.arch || "未知")}</dd><dt>最近检查</dt><dd>${escapeHTML(update.checkedAt || "尚未检查")}</dd></dl></details>
  </article>`;
}

function versionUpdatesView() {
  return `<section class="updates-section" aria-labelledby="updates-heading"><h3 id="updates-heading">版本与更新</h3>${clientUpdateView()}</section>`;
}


function boxVersionReadScope() {
  return ["boxes", "settings"].includes(page) && currentState?.route !== "auth" && currentState?.activeDeviceId
    ? JSON.stringify([marketGeneration, marketAccount, currentState.activeDeviceId]) : null;
}

function freshBoxReport(inventory) {
  const age = Date.now() - Date.parse(inventory?.observedAt);
  return Number.isFinite(age) && age >= -60000 && age <= 15 * 60 * 1000;
}

function currentBoxVersion() {
  const deviceId = currentState.activeDeviceId;
  const update = deviceId && currentState.upgrades?.box?.deviceId === deviceId ? currentState.upgrades.box : {};
  const inventory = update.inventory;
  const wanx = inventory?.components?.wanx;
  const verified = freshBoxReport(inventory) && Boolean(wanx?.runningVersion) && wanx.runningVersion === wanx.installedVersion && wanx.evidenceStatus === "verified" && wanx.health === "healthy";
  const release = verified && update.currentRelease?.components?.includes("wanx") && Date.parse(update.currentRelease.verifiedAt) === Date.parse(inventory.observedAt) ? update.currentRelease : null;
  const unread = !inventory && !update.checkedAt && [undefined, "unknown", "checking"].includes(update.phase);
  const reading = update.phase === "checking" || busyFor("updates.box.check") || Boolean(boxVersionReadRequest && boxVersionReadRequest.key === boxVersionReadScope());
  return { deviceId, update, inventory, wanx, verified, release, unread, reading };
}

function boxVersionSummaryView() {
  const { deviceId, wanx, verified, release, reading } = currentBoxVersion();
  const version = !deviceId ? "—" : verified ? release ? `v${release.version}` : wanx.runningVersion : reading ? "读取中…" : "待核验";
  return `<section class="box-version-summary" aria-label="盒端版本"><div class="box-version-copy"><span class="box-eyebrow">${release ? "记忆盒子发行版本" : "盒端运行版本"}</span><strong role="status">${escapeHTML(version)}</strong></div><button class="text-button" data-action="show-box-version">在设置中查看 →</button></section>`;
}

function scheduleBoxVersionRead() {
  const key = boxVersionReadScope();
  if (!key) { boxVersionReadKey = null; boxVersionReadError = null; return; }
  if (key === boxVersionReadKey || busy || boxVersionReadRequest) return;
  const update = currentState.upgrades?.box?.deviceId === currentState.activeDeviceId ? currentState.upgrades.box : {};
  if (["checking", "planning"].includes(update.phase)) return;
  boxVersionReadKey = key;
  boxVersionReadError = null;
  const checkedAge = Date.now() - Date.parse(update.checkedAt);
  if (freshBoxReport(update.inventory) && Number.isFinite(checkedAge) && checkedAge >= -60000 && checkedAge < 60000) return;
  // Active tasks already refresh through the operation poller. Do not compete with it.
  if (update.operation?.operationId && !["succeeded", "rolled_back", "failed", "needs_attention", "cancelled"].includes(update.operation.state)) return;
  const request = { key, deviceId: currentState.activeDeviceId };
  boxVersionReadRequest = request;
  void Promise.resolve().then(async () => {
    try {
      if (key !== boxVersionReadScope() || boxVersionReadRequest !== request) return;
      const response = await window.wanxClient.action("updates.box.check", { deviceId: request.deviceId });
      if (key !== boxVersionReadScope() || boxVersionReadRequest !== request) return;
      if (!response.ok && response.code === "UPDATE_IN_PROGRESS") return;
      if (!response.ok) throw new Error(response.code);
      if (response.state) acceptRemoteState(response.state);
    } catch (error) {
      if (key === boxVersionReadScope() && boxVersionReadRequest === request) boxVersionReadError = `版本读取失败：${updateGuidance(error?.code || error?.message)}`;
    } finally {
      if (boxVersionReadRequest === request) { boxVersionReadRequest = null; render(currentState); }
    }
  });
}


function boxComponentRow(name, value) {
  const names = { base: "基础配置", docker: "容器环境", discovery: "设备发现", p2p: "盒子连接", wanx: "盒端记忆盒子", semantica: "语义服务", updater: "升级器" };
  const evidence = { verified: "已核验", drifted: "运行状态与安装记录不一致", unknown: "缺少运行核验证据（不代表服务停止）" };
  const health = { healthy: "运行正常", unhealthy: "运行异常", stopped: "未运行", starting: "正在启动", degraded: "运行受限", unknown: "未报告服务状态" };
  const running = value.runningVersion || (["base", "docker"].includes(name) ? "安装记录（不提供独立运行版本）" : "待核验（未取得运行版本）");
  // This field describes the current report's eligibility, not permanent capability.
  const ota = name === "updater" ? (value.otaSupported === true ? "支持独立自更新"
    : value.otaSupported !== false ? "自更新能力待确认"
    : (!value.evidenceStatus || value.evidenceStatus === "unknown") ? "自更新条件待核验" : "自更新条件未满足")
    : value.otaSupported === true ? "由 OTA 管理"
    : value.otaSupported !== false ? "更新方式待确认"
    : ["base", "docker"].includes(name) ? "由系统维护管理"
    : (!value.evidenceStatus || value.evidenceStatus === "unknown") ? "更新条件待核验"
    : "当前更新条件未满足";
  const installationOnly = ["base", "docker"].includes(name) && Boolean(value.installedVersion) && !value.runningVersion && (!value.evidenceStatus || value.evidenceStatus === "unknown") && (!value.health || value.health === "unknown");
  return `<tr><td>${escapeHTML(names[name] || name)}${names[name] ? `<small class="muted">${escapeHTML(name)}</small>` : ""}</td><td><div>安装：${escapeHTML(value.installedVersion || "未记录")}</div><div>运行：${escapeHTML(running)}</div></td><td>${installationOnly ? "<div>记录：历史部署回执</div><div>核验方式：受控维护</div>" : `<div>核验：${escapeHTML(evidence[value.evidenceStatus || "unknown"] || "核验状态待确认")}</div><div>服务：${escapeHTML(health[value.health || "unknown"] || "服务状态待确认")}</div>`}</td><td>${escapeHTML(ota)}</td></tr>`;
}

function boxUpdateView() {
  const deviceId = currentState.activeDeviceId;
  if (!deviceId) return `<article class="update-card"><h3>当前盒子</h3><p class="muted">尚未选择盒子。连接后可检查运行版本与更新。</p></article>`;
  const { update, inventory, wanx, verified: wanxVerified, release: currentRelease, unread, reading } = currentBoxVersion();
  const candidate = update.candidate;
  const release = candidate?.release?.payload;
  // Updater evidence is reported separately and is not part of the application suite.
  const components = Object.entries(inventory?.components || {}).filter(([name]) => name !== "updater");
  const updater = inventory?.updater || inventory?.components?.updater || (inventory ? { runningVersion: inventory.updaterVersion } : null);
  const displayedComponents = updater ? [...components, ["updater", updater]] : components;
  const verified = freshBoxReport(inventory) && components.length > 0 && components.every(([, value]) => Boolean(value.runningVersion) && value.evidenceStatus === "verified" && value.health === "healthy" && value.installedVersion === value.runningVersion);
  const actual = inventory?.suiteVersion && verified ? `v${inventory.suiteVersion}` : wanxVerified ? `盒端记忆盒子 ${currentRelease ? `v${currentRelease.version}` : wanx.runningVersion}` : components.some(([, value]) => value.evidenceStatus === "drifted" || value.installedVersion && value.runningVersion && value.installedVersion !== value.runningVersion) ? "部分更新 / 自定义组合" : "版本待核验";
  const operation = update.operation;
  const state = operation?.state;
  const labels = { queued: "等待盒子领取任务", prechecking: "正在检查更新条件", downloading: "正在下载", staged: "制品已准备好", waiting_window: "等待更新时机", applying: "正在安装，服务可能暂时中断", verifying: "正在核验运行版本", succeeded: "已核验更新成功", rolling_back: "正在恢复先前程序", rolled_back: "已恢复先前程序，本次更新未成功", failed: "本次更新未完成", needs_attention: "需要维护人员处理", cancelled: "更新已取消" };
  const checking = reading;
  const planning = update.phase === "planning" || busyFor("updates.box.plan");
  const pending = checking || planning;
  const active = operation && !["succeeded", "rolled_back", "failed", "needs_attention", "cancelled"].includes(state);
  const disabled = busy || pending ? "disabled" : "";
  const actions = operation?.allowedActions || [];
  const status = wanxVerified ? "当前记忆盒子运行版本已核验" : operation ? (state === "succeeded" && operation.serviceAvailable !== true ? "升级任务已结束，服务状态待确认" : labels[state] || "任务结果待确认") : checking ? "正在检查更新…" : planning ? "正在准备更新…" : candidate?.status === "current" && verified ? "最近检查未发现适用更新" : update.phase === "blocked" || candidate?.status === "blocked" ? "暂不可更新" : release ? `有可用版本 v${release.version}` : inventory ? "已取得版本报告" : "尚未取得运行版本";
  return `<article class="update-card"><div class="update-heading"><div><h3>${escapeHTML(activeDeviceName())} <span class="update-version">${escapeHTML(actual)}</span></h3><p class="muted ${pending ? "activity-status" : ""}" role="status">${pending ? '<span class="activity-spinner" aria-hidden="true"></span>' : ""}${escapeHTML(status)}</p></div><div class="settings-actions"><button class="button small ${checking ? "activity-button" : ""}" data-action="updates-box-check" aria-busy="${checking}" ${disabled}>${checking ? activityLabel("检查中…") : "检查更新"}</button>${update.canUpgrade === true && release && candidate.status === "available" && !active && state !== "needs_attention" && (state !== "rolled_back" || actions.includes("replan")) ? `<button class="button primary small ${planning ? "activity-button" : ""}" data-action="updates-box-plan" aria-busy="${planning}" ${disabled}>${planning ? activityLabel("正在准备…") : ["failed", "rolled_back"].includes(state) ? "重新预检" : "准备更新"}</button>` : ""}</div></div>
    ${inventory?.observedAt ? `<p class="muted">版本报告时间：${escapeHTML(inventory.observedAt)}${!freshBoxReport(inventory) ? " · 报告已过期或时间无效，当前状态待核验" : ""}</p>` : ""}
    ${release && candidate.status === "available" ? `<p class="update-candidate">可用版本 v${escapeHTML(release.version)} · 更新期间盒端应用可能暂时不可用</p>` : ""}
    ${release && candidate.status === "available" && update.canUpgrade !== true ? '<p class="muted">盒端更新需由盒主或受权维护人员执行，请联系盒主更新。</p>' : ""}
    ${release?.releaseNotes ? `<p class="update-notes">${escapeHTML(release.releaseNotes)}</p>` : ""}
    ${!unread && (updateIssueView(update) || candidate?.reasonCode) ? `<div class="box-update-conditions"><span class="muted">下一次更新条件</span>${updateIssueView(update)}${candidate?.reasonCode && !update.reason ? updateIssueView({ reason: candidate.reasonCode }) : ""}</div>` : ""}${boxVersionReadError ? `<p class="inline-error">${escapeHTML(boxVersionReadError)}</p>` : ""}
    ${boxUpdatePollError ? `<p class="inline-error update-candidate">${escapeHTML(boxUpdatePollError)}</p>` : ""}
    ${operation ? `<div class="update-operation" role="status"><p>${escapeHTML(state === "succeeded" && operation.serviceAvailable !== true ? "升级任务已结束，服务状态待确认" : labels[state] || state || "结果待确认")}${operation.step ? ` · ${escapeHTML(operation.step)}` : ""}</p><p class="muted">服务${operation.serviceAvailable === true ? "可用" : operation.serviceAvailable === false ? "暂不可用" : "可用性待确认"} · 任务 ${escapeHTML(operation.operationId)}</p>${operation.errorCode ? `<p class="inline-error">${escapeHTML(updateGuidance(operation.errorCode))} <span class="muted">（${escapeHTML(operation.errorCode)}）</span></p>` : ""}${state === "needs_attention" && !operation.errorCode ? '<p class="inline-error">请联系维护人员并提供任务编号，保留当前状态。</p>' : ""}<div class="market-actions"><button class="text-button" data-action="updates-box-status" ${disabled}>刷新任务状态</button>${update.canUpgrade === true && actions.includes("cancel") ? `<button class="text-button" data-action="updates-box-cancel" ${disabled}>取消更新</button>` : ""}${update.canUpgrade === true && actions.includes("resume") ? `<button class="button small" data-action="updates-box-resume" ${disabled}>继续此任务</button>` : ""}</div></div>` : ""}
    <details class="application-details" data-detail-id="updates-box" ${expandedDetails.has("updates-box") ? "open" : ""}><summary>版本详情</summary><dl class="update-facts"><dt>设备</dt><dd>${escapeHTML(deviceId)}</dd><dt>套件报告</dt><dd>${escapeHTML(inventory?.suiteVersion || (inventory ? "分组件版本（无统一整盒版本）" : "尚未读取"))}</dd><dt>管理组件</dt><dd>${escapeHTML(updater?.runningVersion || inventory?.updaterVersion || "未知")} · ${inventory?.otaReady === true ? "支持检查升级条件" : inventory ? "已运行，自动更新条件待核验" : "尚未取得版本报告，暂不能判断管理组件状态"}</dd><dt>最近检查</dt><dd>${escapeHTML(update.checkedAt || "尚未检查")}</dd></dl>${displayedComponents.length ? `<table class="update-components"><thead><tr><th>组件</th><th>安装版本 / 运行版本</th><th>版本核验 / 服务状态</th><th>更新方式</th></tr></thead><tbody>${displayedComponents.map(([name, value]) => boxComponentRow(name, value)).join("")}</tbody></table><p class="muted">各组件的更新条件单独判断，不代表已完成的更新失败。可更新的组件与版本以“检查更新”的结果及更新前检查为准；安装记录不能替代运行核验。</p>` : '<p class="muted">尚未读取到组件报告，请检查更新后查看。</p>'}</details>
  </article>`;
}

function boxUpdateConfirmation(action) {
  const update = currentState.upgrades?.box;
  const deviceId = currentState.activeDeviceId;
  if (!update || update.deviceId !== deviceId || update.canUpgrade !== true) return;
  const plan = update.plan;
  if (action === "execute" && (!plan?.planId || !Number.isFinite(Date.parse(plan.expiresAt)) || Date.parse(plan.expiresAt) <= Date.now())) return;
  if (action === "resume" && !update.operation?.allowedActions?.includes("resume")) return;
  const version = plan?.release?.payload?.version || update.candidate?.release?.payload?.version;
  marketConfirmation = {
    title: action === "resume" ? "继续盒子更新" : "确认更新盒子",
    detail: `${activeDeviceName()}${version ? `将更新至 v${version}` : "将按已确认的版本继续更新"}。更新期间盒子上的应用可能暂时不可用，不迁移或还原业务数据。${action === "resume" ? "将继续同一任务及固定版本。" : "确认后即使关闭记忆盒子，盒子仍会继续执行任务。"}`,
    verb: action === "resume" ? "继续更新" : "更新盒子", action: `updates.box.${action}`,
    input: action === "resume" ? { deviceId, operationId: update.operation.operationId, confirmed: true } : { deviceId, planId: plan.planId, confirmed: true },
    updateDeviceId: deviceId, updatePlanId: action === "execute" ? plan.planId : null,
    updateResumeOperationId: action === "resume" ? update.operation.operationId : null,
  };
  render(currentState);
}

function scheduleBoxUpdatePolling() {
  const update = currentState?.upgrades?.box;
  const operation = update?.operation;
  const active = ["settings", "boxes"].includes(page) && currentState?.route !== "auth" && currentState?.activeDeviceId === update?.deviceId && operation?.operationId && !["succeeded", "rolled_back", "failed", "needs_attention", "cancelled"].includes(operation.state);
  const key = active ? JSON.stringify([marketAccount, update.deviceId, operation.operationId]) : null;
  if (key !== boxUpdatePollKey) { clearTimeout(boxUpdatePollTimer); boxUpdatePollTimer = null; boxUpdatePollKey = key; boxUpdatePollError = null; }
  if (!key || boxUpdatePollTimer || boxUpdatePollRequest || boxUpdatePollError) return;
  boxUpdatePollTimer = setTimeout(async () => {
    boxUpdatePollTimer = null;
    if (key !== boxUpdatePollKey) return;
    if (busy) { scheduleBoxUpdatePolling(); return; }
    const request = { key };
    boxUpdatePollRequest = request;
    try {
      const response = await window.wanxClient.action("updates.box.status", { deviceId: update.deviceId, operationId: operation.operationId });
      if (key !== boxUpdatePollKey) return;
      if (!response.ok && response.code === "UPDATE_IN_PROGRESS") return;
      if (!response.ok) throw new Error(response.code);
      if (response.state) acceptRemoteState(response.state);
    } catch {
      if (key === boxUpdatePollKey) { boxUpdatePollError = "任务状态暂时无法读取，自动刷新已暂停。请点击“刷新任务状态”重试。"; render(currentState); }
    } finally {
      if (boxUpdatePollRequest === request) boxUpdatePollRequest = null;
      scheduleBoxUpdatePolling();
    }
  }, 5000);
}

function activeMemorySection() {
  if (page === "memory") return "";
  if (page === "my-ai") return "my-ai";
  return null;
}

function memoryView(section) {
  const title = section === "my-ai" ? "我的 AI" : "智能体记忆";
  const banner = section === "my-ai" ? `<header class="wanx-section-banner my-ai-banner" data-section="my-ai">
    ${personalModuleHeading("my-ai", "我的 AI", "管理智能体、采集会话记忆，把盒子里的资料带给 AI。")}
  </header>` : `<header class="wanx-section-banner memory-banner" data-section="memory">
    ${personalModuleHeading("memory", title, "查看 AI 从会话中整理的记忆，管理本机记忆库的备份和恢复。")}
  </header>`;
  return `<div class="app-layout memory-layout">${shellHeader(title)}${banner}
    <div class="memory-host" data-memory-section="${section}" data-memory-agent="${page === "memory" ? escapeHTML(memoryAgent) : ""}" data-memory-page="${page === "memory" ? memoryPage : ""}"></div></div>`;
}

window.addEventListener?.("wanx:accessory-project", event => {
  if (!currentState || page !== "memory") return;
  accessoryPreview?.openProject(event.detail);
  page = "accessories";
  render(currentState);
});
window.addEventListener?.("wanx:view-agent-memory", event => {
  if (!currentState || page !== "my-ai") return;
  memoryAgent = event.detail;
  profileMenuOpen = false;
  page = "memory";
  render(currentState);
  document.scrollingElement?.scrollTo?.(0, 0);
});
window.addEventListener?.("wanx:my-ai-destination", event => {
  if (!currentState || currentState.route === "auth" || page !== "my-ai") return;
  if (event.detail === "backup") {
    if (clientUpdateRequired()) return;
    memoryPage = "backup";
    page = "memory";
  } else if (event.detail === "boxes") {
    page = "boxes";
    void refreshTransfers();
  } else return;
  profileMenuOpen = false;
  notice = null;
  render(currentState);
  document.scrollingElement?.scrollTo?.(0, 0);
});
function spaceView() {
  return `<div class="app-layout space-app-layout">${shellHeader("空间")}
    <div class="page-content space-page-content space-files-page">
      <header class="wanx-section-banner" data-section="space">${personalModuleHeading("space", "私有云空间", "在自己的盒子上存储和管理文件，按权限访问与共享。")}${window.wanxSpace?.headerActions?.() || ""}</header>
      <div class="personal-space-browser">${window.wanxSpace?.view() || ""}</div>
    </div>
  </div>`;
}

function settingsView() {
  const startup = currentState.desktopStartup || { supported: false, enabled: false };
  return `<div class="app-layout" ${marketConfirmation ? "inert" : ""}>${shellHeader("设置")}<div class="page-content settings-page">
    <div class="page-heading"><h2>设置</h2><p class="muted">管理账号、模型、设备与客户端偏好。</p></div>
    ${notice && !passwordEditing ? `<div class="notice ${codeSent ? "success" : "error"}" role="status">${escapeHTML(notice)}</div>` : ""}
    ${versionUpdatesView()}
    <section class="settings-panel" aria-label="空间 MCP"><div><h3>空间 MCP</h3><p class="muted">通用 MCP 的资料授权、记忆归档与接入管理统一在空间中完成。</p></div><button class="button small" data-action="show-space" data-agent-hub-open>管理连接 →</button></section>
    <div id="space-redaction-settings-host"></div>
    <section class="settings-panel"><div><h3>云账号</h3><p class="muted">${currentState.dataIdentity?.profileId ? "云账号用于市场与计费。本地数据访问由可信设备授权管理。" : "已登录云账号。退出后将断开盒子连接，客户端继续在后台运行。"}</p></div><div class="settings-actions">${currentState.account?.phase === "authenticated" ? `<button class="button small" data-action="password-open" ${busy ? "disabled" : ""}>修改密码</button><button class="button small ${busyFor("auth.logout") ? "activity-button" : ""}" data-action="logout" aria-busy="${busyFor("auth.logout")}" ${busy ? "disabled" : ""}>${busyFor("auth.logout") ? activityLabel("正在退出…") : currentState.dataIdentity?.profileId ? "退出云账号" : "退出当前账号"}</button>` : `<button class="button small" data-action="cloud-login">登录云账号</button>`}</div></section>
    ${passwordEditing ? `<section class="password-panel"><h3>修改密码</h3><p class="muted">验证码将发送至当前账号${currentState.account?.maskedPhone ? `（${escapeHTML(currentState.account.maskedPhone)}）` : "绑定的手机号"}。修改后所有设备上的旧登录将失效，请重新登录。</p><form data-form="password-change" novalidate><label for="change-password">新密码</label><input id="change-password" name="password" type="password" required autocomplete="new-password" placeholder="设置 8–72 字节的新密码" />${passwordFields("change", "send-change-code", changeResendAt)}<div data-password-notice class="notice ${codeSent ? "success" : "error"}" role="status" ${notice ? "" : "hidden"}>${escapeHTML(notice)}</div><div class="settings-actions"><button type="button" class="button" data-action="password-cancel" ${busy ? "disabled" : ""}>取消</button><button type="submit" class="button primary" ${busy ? "disabled" : ""}>${busy ? busyRequest?.action === "auth.change-password" ? "正在修改…" : "处理中…" : "确认修改"}</button></div></form></section>` : ""}
    <section class="settings-panel"><div><h3>登录电脑时启动</h3><p class="muted ${busyFor("desktop.startup.set") ? "activity-status" : ""}" role="status">${busyFor("desktop.startup.set") ? activityLabel("正在保存设置…") : escapeHTML(startup.reason || (startup.supported ? startup.status === "requires-approval" ? "请在系统设置中允许登录项。" : "在菜单栏静默启动，随时打开应用。" : "安装正式应用后可设置开机启动。"))}</p></div><button class="switch" role="switch" aria-checked="${Boolean(startup.enabled)}" aria-label="登录电脑时启动" aria-busy="${busyFor("desktop.startup.set")}" data-action="startup-toggle" ${busy || !startup.supported ? "disabled" : ""}><span></span></button></section>

    ${maintenanceToolsView()}
    <section class="settings-panel" aria-label="常见问题"><div><h3>常见问题</h3><p class="muted">查看登录、盒子连接和日常使用的帮助。</p></div><button class="button small" data-action="show-help">查看帮助 →</button></section>
    <section class="settings-panel"><div><h3>关于${clientBrand}</h3><p class="muted">${clientBrandEnglish}</p></div><button class="button small" data-action="desktop-about">关于</button></section>
    <div class="settings-foot"><p class="muted">关闭窗口后，记忆盒子继续在后台运行。完全退出请在应用菜单中选择“退出记忆盒子”。</p></div>
  </div></div>${confirmationView()}`;
}

function resourceSize(value) {
  if (value == null) return "—";
  let amount = value, unit = 0;
  while (amount >= 1024 && unit < 4) { amount /= 1024; unit++; }
  return `${amount.toFixed(unit ? 1 : 0)} ${["B", "KB", "MB", "GB", "TB"][unit]}`;
}
function personalModuleHeading(kind, title, subtitle) {
  const english = {applications:"Apps",space:"Private Cloud",boxes:"Devices",starlink:"Starlink",memory:"agent memory","my-ai":"My AI"};
  const paths = {starlink:'M7 7 17 6m-9 3 5 8m3-9-2 8M7 7a2 2 0 1 0-4 0 2 2 0 0 0 4 0zm14-1a2 2 0 1 0-4 0 2 2 0 0 0 4 0zm-5 13a2 2 0 1 0-4 0 2 2 0 0 0 4 0z',applications:'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',space:'M3 7h7l2 2h9v11H3zM3 7V4h7l2 3',boxes:'M4 4h16v16H4zM4 14h16M8 17h.01M11 17h.01',memory:'M7 7V5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-2M5 7h11a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2zm2 5h7m-7 4h4',"my-ai":'M10 13a4 4 0 0 0 6 .5l4-4a4 4 0 0 0-6-5l-2 2m2 4a4 4 0 0 0-6-.5l-4 4a4 4 0 0 0 6 5l2-2'};
  return `<div class="personal-module-title"><span class="personal-module-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="${paths[kind]}"/></svg></span><div><h2>${title} <span class="wanx-section-english">${english[kind]}</span></h2><p>${subtitle}</p></div></div>`;
}

function boxesView() {
  const devices = currentState.devices || [], ready = currentState.canLaunchApplications;
  const refreshing = busyRequest?.action === "devices.refresh";
  const metrics = window.wanxSpace?.overview?.();
  const volume = ready ? metrics?.volume : null;
  const storage = ready ? metrics?.wanxStorage : null;
  const cpu = ready ? metrics?.cpu : null, memory = ready ? metrics?.memory : null;
  const lanIPs = ready && Array.isArray(metrics?.network?.lanAddresses) ? metrics.network.lanAddresses : [];
  const network = networkStatus();
  const status = currentState.recovery?.status === "failed" ? "连接已中断，请点击“刷新设备”重连" : currentState.recovery?.status === "retrying" ? `正在重连 · 第 ${currentState.recovery.attempt} 次尝试` : ready ? "连接正常" : currentState.connectionPhase === "recovering" ? "正在恢复连接" : currentState.connectionPhase === "connecting" ? "正在连接" : "尚未连接";
  return `<div class="app-layout" ${marketConfirmation ? "inert" : ""}>${shellHeader("盒子")}<div class="page-content space-page-content box-page-content">
    <div class="page-heading wanx-section-banner" data-section="boxes">${personalModuleHeading("boxes", "我的设备", "连接设备，查看状态，维护盒子上的服务。")}<div class="settings-actions"><button class="button small ${refreshing ? "activity-button" : ""}" data-action="refresh" aria-busy="${refreshing}" ${busy ? "disabled" : ""}>${refreshing ? '<span class="activity-spinner" aria-hidden="true"></span>正在刷新…' : "刷新设备"}</button><button class="button primary small" data-action="provisioning" ${busy ? "disabled" : ""}>＋ 添加盒子</button><button class="text-button box-faq-entry" data-action="show-help" data-scene="box_connection">常见问题 ›</button></div></div>
    ${pendingOpenView()}${notice ? `<div class="notice error" role="status">${escapeHTML(notice)}</div>` : ""}
    <section class="box-overview" aria-label="当前盒子"><div class="box-overview-heading"><div class="box-identity"><img src="./assets/centaurai-mark.png" alt=""/><div><span class="box-eyebrow">当前使用的盒子</span><h3 class="current-device">${currentState.activeDeviceId ? escapeHTML(activeDeviceName()) : "尚未连接盒子"}</h3><p>${ready ? currentState.connection?.mode === "local" ? "这台电脑 · 文件与服务在本机运行" : "盒子连接 · 已建立盒子连接" : network.detail}</p><div class="box-addresses" aria-label="盒子 IP" title="当前盒子的局域网地址"><span>盒子 IP</span>${lanIPs.length ? lanIPs.map(address => `<code>${escapeHTML(address)}</code>`).join("") : `<span>${ready ? "暂未获取盒子内网 IP" : "连接后显示"}</span>`}</div></div></div><span class="box-status ${ready ? "ready" : ""}"><i class="status-dot ${ready ? "ready" : ""}"></i>${status}</span></div>
    <div class="box-resource-grid"><div><span>可用存储</span><strong>${resourceSize(volume?.free)}</strong><small>${volume ? `总容量 ${resourceSize(volume.total)}` : ready ? "暂未获取存储指标" : "连接后显示实际状态"}</small></div><div><span>应用与服务占用</span><strong>${storage && !storage.complete ? "≥ " : ""}${resourceSize(storage?.bytes)}</strong><small title="记忆盒子数据、应用与运行组件，含日志、缓存、历史版本和回收站；重叠文件仅计一次。按文件大小汇总，每 30 秒更新。">${storage ? storage.complete ? "数据、应用与运行组件" : "部分目录暂时无法读取" : ready ? "等待盒子返回完整统计" : "连接后显示实际状态"}</small></div><div><span>CPU 使用率</span><strong>${cpu ? `${cpu.percent.toFixed(1)}%` : "—"}</strong><small>${cpu ? "盒子当前负载" : ready ? "暂未获取 CPU 指标" : "连接后显示实际状态"}</small></div><div><span>内存使用</span><strong>${memory ? `${memory.percent.toFixed(1)}%` : "—"}</strong><small>${memory ? `${resourceSize(memory.used)} / ${resourceSize(memory.total)}` : ready ? "暂未获取内存指标" : "连接后显示实际状态"}</small></div></div></section>
    <section class="content-section" aria-label="设备管理"><div class="box-section-heading"><div><h3>已关联的盒子 <span class="count">${devices.length}</span></h3><p class="muted ${refreshing ? "activity-status" : ""}" role="status">${refreshing ? '<span class="activity-spinner" aria-hidden="true"></span>正在读取最新设备状态…' : "连接或切换盒子后，文件空间和应用将使用所选盒子。"}</p></div></div>${devices.length ? `<div class="box-device-grid">${devices.map(deviceCard).join("")}</div>` : `<div class="empty-state"><h3>还没有盒子</h3><p>发现附近的盒子，完成配网和账号绑定。</p><button class="button small" data-action="provisioning">添加盒子</button></div>`}</section>
    ${ownershipView()}
    ${currentState.dataIdentity?.profileId ? "" : supportView.render()}
  </div></div>${confirmationView()}`;
}

function ownershipView() {
  if (currentState.dataIdentity?.profileId) return "";
  const device = currentState.devices?.find(item => item.deviceId === transferDeviceId && (item.deviceRole === "owner" || item.role === "owner"));
  const pending = ownershipTransfers.filter(item => item.state === "pending_target" && Date.parse(item.expiresAt) > Date.now());
  return `<section class="content-section ownership-section" aria-label="所有权转移"><div class="section-heading"><h3>所有权转移</h3><button class="text-button" data-action="transfer-refresh" aria-busy="${Boolean(transferRequest)}" ${busy || transferRequest ? "disabled" : ""}>${transferRequest ? "正在刷新…" : "刷新转移记录"}</button></div>
    <p class="muted">将盒子交给另一个云账号。此操作保留盒内数据；需要清空交付时，请由管理员执行盒子清除。</p>
    ${transferNotice ? `<p role="status">${escapeHTML(transferNotice)}</p>` : ""}
    ${device ? `<form data-form="transfer" data-device-id="${escapeHTML(device.deviceId)}" class="auth-card transfer-form"><h3>转移 ${escapeHTML(device.name || device.displayName || device.deviceId)}</h3>
      <label for="transfer-phone">接收方云账号手机号</label><input id="transfer-phone" name="targetPhone" type="tel" pattern="1[0-9]{10}" maxlength="11" required autocomplete="off" />
      <label for="transfer-code">你的账号短信验证码</label><div class="code-field"><input id="transfer-code" name="verificationCode" pattern="[0-9]{6}" maxlength="6" inputmode="numeric" required autocomplete="one-time-code" /><button type="button" class="button small" data-action="transfer-code" ${busy || Date.now() < transferResendAt ? "disabled" : ""}>发送验证码</button></div>
      <p class="muted">客户接受后，你和原授权用户将失去此盒子的访问权限。请确认盒内保留的数据可交给客户。</p>
      <label class="transfer-consent"><input type="checkbox" name="retainData" required /> 我同意保留盒内数据并转移所有权</label>
      <div class="market-actions"><button type="button" class="button" data-action="transfer-cancel" ${busy ? "disabled" : ""}>取消</button><button type="submit" class="button primary" ${busy ? "disabled" : ""}>发送转移邀请</button></div></form>` : ""}
    ${pending.map(item => `<article class="device-card"><div class="device-main"><h3>${escapeHTML(currentState.devices?.find(device => device.deviceId === item.deviceId)?.name || item.deviceId)}</h3><p class="muted">${item.direction === "incoming" ? "待你接受" : "等待客户接受"} · ${item.retainData ? "保留盒内数据" : "此转移不支持，请联系原所有者"} · ${escapeHTML(new Date(item.expiresAt).toLocaleString())} 前有效</p></div>${item.direction === "incoming" && item.retainData ? `<button class="button small" data-action="transfer-accept" data-transfer-id="${escapeHTML(item.transferId)}" ${busy ? "disabled" : ""}>接受转移</button>` : ""}</article>`).join("")}
    ${!pending.length ? '<p class="muted">暂无待处理的转移邀请。</p>' : ""}</section>`;
}

async function refreshTransfers({ force = false } = {}) {
  if (transferRequest && !force) return transferRequest.promise;
  const generation = marketGeneration;
  const revision = ++ownershipRevision;
  const request = {};
  transferRequest = request;
  const loadError = "转移记录暂时无法加载，请刷新重试。";
  if (transferNotice === loadError) transferNotice = null;
  render(currentState);
  request.promise = (async () => {
    try {
      const response = await window.wanxClient.action("ownership.list");
      if (generation !== marketGeneration || revision !== ownershipRevision) return;
      if (!response.ok) throw new Error(response.code);
      ownershipTransfers = response.value || [];
    } catch (error) {
      if (generation !== marketGeneration || revision !== ownershipRevision) return;
      transferNotice = loadError;
    } finally {
      if (transferRequest === request) { transferRequest = null; render(currentState); }
    }
  })();
  return request.promise;
}

function maintenanceToolsView() {
  if (currentState.dataIdentity?.profileId) return "";
  const ready = currentState.canOpenDashboard;
  const tools = [
    ["terminal", "终端", "执行命令、查看日志与检查服务。", '<span aria-hidden="true">&gt;_</span>'],
    ["desktop", "远程桌面", "查看并操作盒子的桌面。", '<svg aria-hidden="true" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="26" height="18" rx="3"/><path d="M16 22v6M10 28h12"/></svg>'],
  ];
  return `<details class="settings-maintenance" aria-label="盒子运维工具" data-detail-id="settings-maintenance" ${expandedDetails.has("settings-maintenance") ? "open" : ""}><summary><span><strong>盒子运维工具</strong><small>${ready ? `当前盒子：${escapeHTML(activeDeviceName())}` : currentState.connectionPhase === "recovering" ? "正在恢复连接" : "请先连接一台盒子"}</small></span><span class="settings-maintenance-chevron" aria-hidden="true">⌄</span></summary><div class="box-operations-grid">${tools.map(([tool, title, description, icon]) => { const opening = busyFor("maintenance.open") && busyRequest.tool === tool; return `<article class="box-operation"><div class="maintenance-icon box-operation-${tool}">${icon}</div><div class="box-operation-copy"><h4>${title}</h4><p>${description}</p></div><button class="button small ${opening ? "activity-button" : ""}" aria-busy="${opening}" data-action="maintenance-open" data-tool="${tool}" ${!ready || busy ? "disabled" : ""}>${opening ? activityLabel("正在打开…") : `打开${title}<span aria-hidden="true"> ↗</span>`}</button></article>`; }).join("")}</div><p class="box-operations-footnote">终端与远程桌面使用当前盒子连接；切换或断开后，相关窗口会自动关闭。</p></details>`;
}

function operationFor(id) {
  const local = localOperations.get(id);
  const shared = currentState.ui?.applicationOperations?.[id];
  return local?.phase === "failed" ? shared || local : local || shared;
}

function operationBusy(id) {
  const operation = operationFor(id);
  return operation && !["idle", "failed", "completed", "ready", "running", "cancelled"].includes(operation.phase);
}

function operationMessage(operation) {
  if (!operation) return "";
  if (operation.error) return /[\u3400-\u9fff]/.test(String(operation.error)) ? String(operation.error) : operationErrorMessage(operation.error);
  return { installing: "正在安装…", updating: "正在更新…", uninstalling: "正在卸载…", rolling_back: "正在恢复版本…", rollback: "正在恢复版本…", selecting: "正在选择版本…", "rolling-back": "正在恢复版本…", opening: "正在打开…", connecting: "正在连接盒子…", running: "已打开" }[operation.phase] || "";
}

function showOpenedStatus(applicationId) {
  const operation = { phase: "running" };
  localOperations.set(applicationId, operation);
  setTimeout(() => {
    if (localOperations.get(applicationId) === operation) {
      localOperations.delete(applicationId);
      render(currentState);
    }
  }, 4000);
}

function pendingOpenView() {
  const pending = currentState.ui?.pendingOpen;
  if (!pending) { pendingSelection = null; return ""; }
  const devices = (currentState.devices || []).filter(deviceCanConnect);
  if (pendingSelection?.id !== pending.id) pendingSelection = { id: pending.id, deviceId: pending.deviceId || currentState.ui?.lastDeviceId || devices[0]?.deviceId };
  if (!devices.some((device) => device.deviceId === pendingSelection.deviceId)) pendingSelection.deviceId = devices[0]?.deviceId;
  const application = storeApplication(pending.applicationId);
  const processing = ["connecting", "opening"].includes(pending.phase);
  const selectedReady = currentState.networkReady || devices.some(device => device.local && device.deviceId === pendingSelection.deviceId);
  const authorizing = !devices.length && currentState.devices?.some(device => device.accessState === "authorization_pending");
  return `<section class="pending-open" aria-label="连接盒子并打开应用" role="status"><div><h3>${processing ? pending.phase === "connecting" ? "正在连接盒子…" : "正在打开应用…" : "连接盒子并打开应用"}</h3><p class="muted">${escapeHTML(application?.name || "此应用")}需要一台盒子提供服务。</p></div>
    ${pending.error ? `<p class="inline-error">${escapeHTML(operationErrorMessage(pending.error))}</p>` : ""}
    ${authorizing ? `<p class="muted">正在同步盒子访问权限。${authorizationHint()}</p>` : ""}
    <div class="pending-open-actions">${devices.length ? `<select aria-label="用于打开应用的盒子" data-input="pending-device" ${processing ? "disabled" : ""}>${devices.map((device) => `<option value="${escapeHTML(device.deviceId)}" ${pendingSelection.deviceId === device.deviceId ? "selected" : ""}>${escapeHTML(device.name || device.displayName || "盒子")}</option>`).join("")}</select><button class="button primary small ${processing ? "activity-button" : ""}" data-action="pending-confirm" aria-busy="${processing}" ${processing || !selectedReady ? "disabled" : ""}>${processing ? activityLabel("处理中…") : "连接并打开"}</button>` : '<button class="button small" data-action="show-boxes">发现或管理盒子</button>'}<button class="text-button" data-action="pending-cancel">取消</button></div>
    ${!selectedReady ? `<p class="muted">${networkStatus().label}。<button class="text-button" data-action="show-settings">检查网络</button></p>` : ""}</section>`;
}

function marketErrorMessage(error) {
  const message = String(error?.code || error?.message || error || "");
  const messages = {
      NOTIFICATION_BOX_REQUIRED: "请先连接这条通知对应的盒子，再打开任务。",
      NOTIFICATION_NOT_FOUND: "这条通知已不可用，请刷新通知列表。",
    BOX_APPLICATION_PLATFORM_SESSION_REQUIRED: "请登录记忆盒子并选择已关联的盒子后打开此应用。",
    BOX_APPLICATION_RUNTIME_UPDATE_REQUIRED: "盒子需要更新记忆盒子服务后才能打开此应用，请联系管理员。",
    BOX_APPLICATION_ACCESS_DENIED: "此账号尚未获得应用使用权限，请联系管理员启用并授权。",
    BOX_APPLICATION_SCOPE_FORBIDDEN: "此应用的连接权限不匹配，请更新记忆盒子后重试。",
    BOX_APPLICATION_SESSION_INVALID: "无法建立应用会话，请更新记忆盒子和盒端服务后重试。",
    ACCOUNT_LOGIN_REQUIRED: "登录已失效，请重新登录记忆盒子。",
    ACCOUNT_CANCELLED: "登录状态已变化，请重新登录后重试。",
    ACCOUNT_CHANGED: "登录账号已变化，请刷新应用市场后重试。",
    MARKET_CANDIDATE_CHANGED: "可用版本已变化，请刷新后重新确认安装。",
    MARKET_SESSION_CHANGED: "登录状态已变化，请重新登录后重试。",
    MARKET_UNTRUSTED_KEY: "尚未配置可信的应用发行方，请联系管理员。",
    MARKET_INVALID_SIGNATURE: "应用发行签名验证失败，请联系管理员。",
    MARKET_INVALID_DESCRIPTOR: "应用发行信息无效，请联系管理员。",
    MARKET_PACKAGE_INVALID: "安装包格式有误，请联系管理员。",
    MARKET_PACKAGE_HASH_MISMATCH: "安装包校验失败，请刷新后重新下载。",
    MARKET_PACKAGE_TOO_LARGE: "安装包超出允许大小，请联系管理员。",
    MARKET_UPDATE_NOT_AVAILABLE: "没有可安装的新版本，请刷新应用列表。",
    MARKET_OPERATION_BUSY: "此应用正在处理中，请稍后再试。",
    MARKET_ROLLBACK_UNAVAILABLE: "没有可恢复的上一个版本。",
    MARKET_UNTRUSTED_SIGNING_KEY: "服务器不信任此发行签名，请联系管理员检查发布公钥。",
    MARKET_TRUST_NOT_CONFIGURED: "服务器尚未配置发行公钥，请联系管理员。",
    MARKET_INTEGRITY_ERROR: "服务器发行记录校验失败，请联系管理员检查安装包。",
    MARKET_DATABASE_UNAVAILABLE: "应用市场服务暂不可用，请稍后刷新；如仍失败，请联系管理员。",
    MARKET_SERVICE_NOT_DEPLOYED: "应用市场接口尚未部署，请联系管理员更新平台服务。",
    MARKET_STORAGE_NOT_CONFIGURED: "安装包存储尚未配置完成，请联系管理员。",
    MARKET_STORAGE_UNAVAILABLE: "安装包存储暂不可用，请稍后刷新重试。",
    MARKET_STORAGE_REQUIRES_HTTPS: "安装包存储地址配置有误，请联系管理员配置 HTTPS。",
    MARKET_ARTIFACT_NOT_FOUND: "安装包已变化，请刷新应用市场后重试。",
    MARKET_DOWNLOAD_UNAVAILABLE: "安装包已下架、撤销或替换，请刷新应用市场。",
    MARKET_INVALID_VERSION: "版本信息有误，请更新记忆盒子；如仍失败，请联系管理员。",
    MARKET_APPLICATION_INVALID: "应用标识有误，请刷新应用市场；如仍失败，请联系管理员。",
    APPLICATION_RETIRED: "此应用已退役，无法继续从市场安装或更新。",
    MARKET_TRUST: "尚未配置可信的应用发行方，请联系管理员。",
    MARKET_SIGNATURE: "应用发行签名验证失败，请联系管理员。",
    MARKET_HASH: "安装包校验失败，请刷新后重新下载。",
    MARKET_SIZE: "安装包大小与发行信息不一致，请重新下载。",
    MARKET_DOWNLOAD: "安装包下载失败，请检查网络后重试。",
    MARKET_UNAVAILABLE: "此应用暂时无法安装，请刷新应用市场。",
    MARKET_GRAY_ACCESS_DENIED: "此版本正在灰度测试，当前账号未获测试资格。请使用正式版本，或联系管理员加入测试。",
    MARKET_RELEASE_ACCESS_REQUIRED: "请更新记忆盒子并登录有测试资格的账号，再打开此应用。",
    MARKET_RELEASE_ACCESS_SIGNED_PACKAGE_REQUIRED: "此测试版本需要通过「应用」页提供的签名安装包安装。",
    MARKET_RELEASE_ACCESS_INVALID: "暂时无法确认此版本的使用资格，请保持联网后重试。",
    MARKET_RELEASE_ACCESS_EXPIRED: "此版本的使用许可已到期，请保持联网后重新打开应用。",
    MARKET_INCOMPATIBLE: "此版本不兼容当前系统或记忆盒子版本，请先更新记忆盒子。",
    MARKET_ALREADY: "当前已安装此版本，请刷新应用列表。",
    MARKET_DOWNGRADE: "本机版本较新，不会自动降级。",
    MARKET_BUSY: "此应用正在处理中，请稍后再试。",
    MARKET_NOT_CONFIGURED: "应用市场尚未配置完成，请联系管理员。",
    CLIENT_UPDATE_REQUIRED: "请先更新记忆盒子，再启动新的业务。已打开的应用可继续保存工作。",
    CLIENT_VERSION_INCOMPATIBLE: "此应用与当前记忆盒子版本不兼容，请检查记忆盒子和应用更新，或联系管理员确认适配版本。",
    BACKEND_CONTRACT_INCOMPATIBLE: "此应用需要更新盒端服务，请联系盒主更新后再试。",
    APPLICATION_RESOURCES_PENDING: "应用已安装。连接盒子后打开，记忆盒子会检查盒端准备状态。",
    APPLICATION_RESOURCES_NOT_READY: "盒端尚未完成应用准备，请保持盒子联网后重试。",
    APPLICATION_RESOURCE_ARTIFACT_REQUIRED: "请在「应用」中安装已发布版本，再准备盒端资源。",
    APPLICATION_PREPARATION_INVALID: "盒端准备结果无法核验，请更新盒端后重试。",
    APPLICATION_PREPARATION_UNAVAILABLE: "盒端应用准备服务暂不可用，请检查盒端服务后重试。",
    RESOURCE_SERVICE_NOT_CONFIGURED: "盒端应用准备服务尚未启用，请联系盒主或管理员检查盒端配置。",
    RESOURCE_EXPERT_START_FAILED: "应用所需专家未能启动，请联系盒主或管理员检查模型配置和专家运行状态后重试。",
    APP_ENTITLEMENT_REQUIRED: "此账号尚未获得应用使用权限，请联系管理员启用并授权。",
    RESOURCE_PRODUCT_PROFILE_UNSUPPORTED: "此应用暂不支持自动准备专家，请联系应用提供方更新应用。",
    RESOURCE_PREPARATION_BUSY: "盒子正在准备应用所需资源，请稍后重试。",
    RESOURCE_NOT_PREPARED: "应用所需资源尚未准备好，请保持盒子联网后重新打开应用。",
    RESOURCE_UPSTREAM_PERMISSION_DENIED: "当前账号无权准备此应用的专家，请联系盒主或管理员。",
    RESOURCE_USER_MODIFIED: "现有专家或技能包已被修改，记忆盒子已保留这些内容，请联系维护人员确认后再更新。",
    RESOURCE_MIGRATION_REQUIRED: "此应用需要升级盒端专家，请先完成专家数据迁移。现有专家和历史数据已保留。",
    RESOURCE_INSTANCE_OWNERSHIP_CHANGED: "此应用的专家归属已变化，请联系盒主确认访问权限。",
    EXPERT_VERSION_UNKNOWN: "无法确认现有助手是否适用。现有内容已保留，请联系维护人员检查。",
    EXPERT_NOT_READY: "此应用需要的助手尚未准备好，请联系盒主完成准备。",
    EXPERT_NOT_PREPARED: "此应用需要的助手尚未准备好，请联系盒主完成准备。",
    APP_AUTHORIZATION_UNVERIFIED: "应用使用权限尚未确认，请重新登录后重试，或联系盒主。",
    APPLICATION_DATA_COMPATIBILITY_UNKNOWN: "无法核验应用数据的写入者或格式版本。请保留当前数据，联系应用提供方核验；不要删除数据来重试。",
    APPLICATION_DATA_SCHEMA_INCOMPATIBLE: "此版本无法读取现有应用数据。请保留当前数据并联系应用提供方恢复兼容版本。",
    APPLICATION_BUSY: "请先关闭应用，再进行此操作。",
    APPLICATION_RUNNING: "请先关闭应用，再进行此操作。",
    APPLICATION_ROLLBACK: "没有可恢复的上一个版本。",
    APPLICATION_MANAGED_DEPLOYMENT_REQUIRED: "此应用由工坊部署管理，请在本机安装中卸载；版本恢复请前往工坊。",
    APPLICATION_DEPLOYMENT_USER_REMOVED: "此电脑已卸载该部署版本，请在工坊重新部署后安装。",
  };
  return Object.entries(messages).find(([code]) => message.includes(code))?.[1]
    || "暂时无法完成应用市场操作，请刷新后重试；如仍失败，请联系管理员。";
}

function candidateLabel(candidate) {
  if (!candidate) return marketLoading ? "正在检查版本…" : "尚未检查版本";
  if (["incompatible", "unavailable"].includes(candidate.status)) {
    const reason = {
      application_unlisted: "此应用尚未上架或已下架，请刷新应用市场。",
      no_published_target: "暂无可安装的应用包，请联系管理员发布通用应用包或适用版本。",
      release_unavailable: "此发行版本暂不可用，请刷新应用市场后重试。",
      wanx_version: "请先升级记忆盒子，再安装此应用版本。",
      host_protocol: "此应用与当前记忆盒子运行协议不兼容，请联系管理员确认兼容版本。",
      version_selection_required: "请先选择历史应用的当前版本，再检查更新。",
      backend_contract: "此应用需要更新盒端服务，请联系盒主更新后再试。",
      backend_evidence_stale: "盒子状态还未确认，请连接盒子并刷新后再试。",
      expert_not_ready: "此应用需要的助手尚未准备好，请联系盒主完成准备。",
      expert_version_unknown: "无法确认现有助手是否适用。现有内容已保留，请联系维护人员检查。",
      client_version: "此应用与当前记忆盒子版本不兼容，请检查记忆盒子和应用更新，或联系管理员确认适配版本。",
      authorization_unverified: "应用使用权限尚未确认，请重新登录后重试，或联系盒主。",
      compatible_history_requires_recovery: "此盒子需要受支持的历史应用版本。请保留现有数据并联系应用提供方完成兼容恢复。",
    reinstall_required: "此版本需管理员协助重新安装。",
    }[candidate.reason === "CLIENT_VERSION_INCOMPATIBLE" ? "client_version" : candidate.reason];
    if (reason) return reason;
  }
  return {
    available: `可${candidate.installed ? "更新至" : "安装"} v${candidate.release?.version || ""}`,
    up_to_date: "已是最新版本",
    local_newer: "本机版本较新",
    incompatible: candidate.reason === "reinstall_required" ? "此版本需管理员协助重新安装" : "暂不兼容当前系统或记忆盒子版本",
    unavailable: "暂无适用版本",
    error: marketErrorMessage(candidate.error),
  }[candidate.status] || "暂无适用版本";
}

function candidateDetails(candidate) {
  const artifact = candidate?.artifact;
  const platforms = { "universal:universal": "通用应用包", "macos:arm64": "macOS · Apple 芯片", "macos:x64": "macOS · Intel", "windows:arm64": "Windows · ARM64", "windows:x64": "Windows · x64" };
  const metadata = [];
  if (artifact) {
    const platform = platforms[`${artifact.os}:${artifact.arch}`];
    if (platform) metadata.push(platform);
    if (Number.isFinite(artifact.size) && artifact.size > 0) {
      metadata.push(artifact.size >= 1024 * 1024 ? `${(artifact.size / (1024 * 1024)).toFixed(1)} MB`
        : artifact.size >= 1024 ? `${(artifact.size / 1024).toFixed(1)} KB` : `${artifact.size} B`);
    }
  }
  const notes = typeof candidate?.release?.notes === "string" ? candidate.release.notes.trim() : "";
  return `${metadata.length ? `<p class="market-metadata">${escapeHTML(metadata.join(" · "))}</p>` : ""}
    ${notes ? `<details class="market-notes"><summary>v${escapeHTML(candidate.release.version)} 更新说明</summary><p>${escapeHTML(notes)}</p></details>` : ""}`;
}

function applicationIcon(item) {
  const featuredId = availableFeaturedProductId(item);
  if (featuredId) {
    const logo = expertApps.pilots.find(pilot => pilot.id === featuredId)?.logo;
    return featuredLogo(featuredId, logo, "application-icon generated-app-icon");
  }
  const local = window.wanxAppMedia?.[item.applicationId]?.icon;
  let icon = "";
  try { const url = new URL(item.iconUrl); if (url.protocol === "https:" && !url.username && !url.password) icon = url.href; } catch {}
  const source = icon || (local ? "./" + local : "");
  return source ? `<img class="application-icon generated-app-icon" src="${escapeHTML(source)}" ${icon && local ? `data-fallback-src="./${local}"` : ""} alt="" decoding="async" />`
    : `<div class="application-icon" aria-hidden="true">${escapeHTML(Array.from(item.name || "应")[0])}</div>`;
}
function applicationTone() { return "creation"; }
function stagedInstallation(item) {
  return item.installationState === "pending" ? item : item.pendingInstallation;
}
function applicationPreparationStatus(item) {
  const staged = stagedInstallation(item);
  if (staged) {
    const description = item.installationState === "pending"
      ? "应用包已下载，等待完成盒端准备。"
      : `v${staged.version} 尚未启用，当前版本可继续使用。`;
    return `${description}${staged.resourcePreparation?.code ? marketErrorMessage({ code: staged.resourcePreparation.code }) : "连接盒子后重试。"}`;
  }
  return item.resourcePreparation?.status === "pending" ? "打开时将检查盒端专家和技能包。" : "";
}
function applicationActions(item, installed) {
  const candidate = applicationCandidate(item);
  const id = escapeHTML(item.applicationId);
  const operation = operationFor(item.applicationId);
  const status = operationMessage(operation);
  const disabled = operationBusy(item.applicationId) ? "disabled" : "";
  const active = installed && item.installationState !== "pending" && !item.workshopRemote;
  const staged = stagedInstallation(item);
  const installing = ["installing", "updating"].includes(operation?.phase);
  const selecting = operation?.phase === "selecting";
  const opening = ["opening", "connecting"].includes(operation?.phase);
  if(item.workshopRemote)return `<div class="application-actions"><button class="button primary small" data-action="application-workshop-install" data-project-id="${escapeHTML(item.workshopProjectId)}">安装到此电脑</button></div>`;
  return item.selectionRequired
    ? `<p class="muted">历史版本无法自动比较，请选择当前版本。</p><div class="version-choices">${item.versions.map(({ version }) => { const pending = selecting && operation.version === version; return `<button class="button small ${pending ? "activity-button" : ""}" data-action="applications-select-current" data-application-id="${id}" data-version="${escapeHTML(version)}" aria-busy="${pending}" ${disabled}>${pending ? activityLabel("正在选择…") : `使用 ${escapeHTML(version)}`}</button>`; }).join("")}</div>`
    : `<div class="application-actions">${candidate?.status === "available" ? `<button class="button ${active ? "" : "primary"} small ${installing ? "activity-button" : ""}" data-action="market-install" data-application-id="${id}" aria-busy="${installing}" ${disabled}>${installing ? activityLabel(status || "正在安装…") : staged ? active ? "重试更新" : "继续安装" : active ? "更新" : "安装"}</button>` : ""}${active ? `<button class="button primary small ${opening ? "activity-button" : ""}" data-action="applications-launch" data-application-id="${id}" aria-busy="${opening}" ${disabled}>${opening ? activityLabel(status || "正在打开…") : operationBusy(item.applicationId) ? status || "处理中…" : operation?.phase === "running" ? "已打开" : "打开"}</button>` : ""}</div>`;
}
function applicationManagement(item, installed) {
  const candidate = applicationCandidate(item);
  const availability = isManagedLocalApplication(item) ? "由工坊管理版本" : availableFeaturedProductId(item) ? "本机应用" : isPrivateApplication(item) ? "本地应用 · 在应用工坊管理版本" : candidateLabel(candidate);
  const id = escapeHTML(item.applicationId);
  const previous = typeof item.previous === "string" ? item.previous : item.previous?.version;
  const disabled = operationBusy(item.applicationId) ? "disabled" : "";
  const active = installed && item.installationState !== "pending" && !item.workshopRemote;
  const operation = operationFor(item.applicationId);
  const restoring = ["rolling_back", "rollback", "rolling-back"].includes(operation?.phase);
  const uninstalling = operation?.phase === "uninstalling";
  return `<div class="store-detail-body">${item.description ? `<p class="store-full-description">${escapeHTML(item.description)}</p>` : ""}${installed && item.version ? `<p class="muted">${active ? "当前版本" : "待安装版本"} v${escapeHTML(item.version)}</p>` : ""}<p class="market-status">${escapeHTML(availability)}</p>${candidateDetails(candidate)}${installed && !item.selectionRequired && !item.workshopRemote ? `<div class="market-actions">${active && previous && !isManagedLocalApplication(item) ? `<button class="text-button ${restoring ? "activity-button" : ""}" data-action="${isPrivateApplication(item) ? "local-rollback" : "market-rollback"}" data-application-id="${id}" aria-busy="${restoring}" ${disabled}>${restoring ? activityLabel("正在恢复…") : "恢复上一版本"}</button>` : ""}<button class="text-button danger-text ${uninstalling ? "activity-button" : ""}" data-action="${isPrivateApplication(item) ? "local-uninstall" : "market-uninstall"}" data-application-id="${id}" aria-busy="${uninstalling}" ${disabled}>${uninstalling ? activityLabel("正在卸载…") : "卸载"}</button></div>` : ""}${!candidate?.artifact && !candidate?.release?.notes && !installed ? '<p class="muted">暂无更多版本信息。</p>' : ""}</div>`;
}
function applicationCard(item, installed = true) {
  item = withMarketName(item);
  const expertInstalled = Boolean(availableFeaturedProductId(item));
  const candidate = applicationCandidate(item);
  const id = escapeHTML(item.applicationId);
  const operation = operationFor(item.applicationId);
  const status = operationMessage(operation);
  const preparation = applicationPreparationStatus(item);
  const actions = applicationActions(item, installed);
  return `<article class="application-card" data-application="${id}" data-tone="${applicationTone(item)}"><button class="store-icon-link" data-action="store-details" data-application-id="${id}" aria-label="了解${escapeHTML(item.name)}">${applicationIcon(item)}</button><div class="application-main">
    <div class="application-title"><h3><button class="store-title-link" data-action="store-details" data-application-id="${id}">${escapeHTML(item.name)}</button></h3></div>
    ${item.description ? `<p class="application-description">${escapeHTML(item.description)}</p>` : ""}
    ${status || preparation ? `<p class="market-status ${operation?.error ? "inline-error" : ""}" role="status">${escapeHTML(status || preparation)}</p>` : ""}
    ${installed?`<p class="muted">${isPrivateApplication(item)?"本地应用":"市场应用"}${item.workshopProjectId?" · "+escapeHTML(activeDeviceName()):""}${!expertInstalled&&appLibrary.items.find(a=>a.applicationId===item.applicationId)?.editable?' · 可定制':''}</p>${expertInstalled?`<button class="text-button" data-action="expert-installed-workshop" data-application-id="${id}">工坊演示 <span aria-hidden="true">↗</span></button>`:item.workshopProjectId?`<button class="text-button" data-action="application-workshop" data-project-id="${escapeHTML(item.workshopProjectId)}">在工坊继续修改 →</button>`:appLibrary.items.find(a=>a.applicationId===item.applicationId)?.editable?`<button class="text-button" data-action="application-customize" data-application-id="${id}">用工坊修改 →</button>`:''}`:""}
    ${!installed && candidate?.status !== "available" ? `<p class="market-status" role="status">${escapeHTML(candidate ? candidateLabel(candidate) : marketLoading ? "正在检查可安装版本…" : "暂未提供可安装版本")}</p>` : ""}
    </div>${actions}
    <button class="store-detail-link" data-action="store-details" data-application-id="${id}">了解应用 <span aria-hidden="true">›</span></button>
    <details class="application-details" data-detail-id="${id}" ${expandedDetails.has(item.applicationId) ? "open" : ""}><summary>版本与管理${candidate?.status === "available" && installed ? '<span class="store-update-dot">可更新</span>' : ""}</summary>${applicationManagement(item, installed)}</details></article>`;
}
function discoverableApplications() {
  // Only the account's remote catalog determines which apps are discoverable.
  return [...new Map(marketItems.map(item => [item.applicationId, item])).values()];
}
function withMarketName(item) {
  const featuredId = availableFeaturedProductId(item);
  if (featuredId) {
    const { name, summary } = FEATURED_PRODUCTS[featuredId];
    return { ...item, name, description: summary };
  }
  if (isPrivateApplication(item)) return item;
  const cloud = marketItems.find(entry => entry.applicationId === item.applicationId);
  // Directory presentation comes only from cloud; installed runtime metadata stays intact.
  return cloud && typeof cloud.name === "string" && cloud.name.trim() ? { ...item, name: cloud.name, description: cloud.description, iconUrl: cloud.iconUrl } : item;
}
function storeApplication(id) {
  const item = visibleInstalledApplications().find(item => item.applicationId === id)
    || discoverableApplications().find(item => item.applicationId === id);
  return item ? withMarketName(item) : null;
}
function visibleInstalledApplications() {
 const base=currentState.applications||[];if(!appLibrary.loaded)return base;
 const projects=appLibrary.projects.filter(p=>p.installedVersion);
 const installed=base.filter(a=>!appLibrary.workshopApplicationIds.includes(a.applicationId)||projects.some(p=>p.appId===a.applicationId));
 return [...installed.map(a=>{const p=projects.find(p=>p.appId===a.applicationId);return p?{...a,workshopProjectId:p.id}:a;}),...projects.filter(p=>!base.some(a=>a.applicationId===p.appId)).map(p=>({applicationId:p.appId,name:p.name,version:p.installedVersion,installationSource:'local',workshopProjectId:p.id,workshopRemote:true}))];
}
function localInstalledApplications(){return visibleInstalledApplications().filter(isPrivateApplication);}
function localApplicationsView(){
 const items=visibleInstalledApplications();return `<section class="content-section" aria-label="我的应用"><div class="section-heading"><h3>我的应用 <span class="count">${items.length}</span></h3></div><p class="muted">已下载的市场应用与当前盒子已启用的本地应用。</p>${appLibrary.error?`<p role="status">${escapeHTML(appLibrary.error)} <button class="text-button" data-action="application-library-refresh">重试</button></p>`:''}${items.length?`<div class="application-list">${items.map(item=>applicationCard(item)).join('')}</div>`:"<div class=\"empty-state\"><h3>暂无已下载或盒子本地应用</h3><p>前往应用市场下载，或在应用工坊启用定制应用。</p></div>"}</section>${availableApplicationsView(items)}`;
}
function applicationMedia(id) { return window.wanxAppMedia?.[id]; }
function storeFeatures() {
  // Only current cloud entries can appear; the image map is never a directory.
  const slides = discoverableApplications().filter(item => applicationMedia(item.applicationId)?.posters.length);
  if (!slides.length) return "";
  return `<section class="store-carousel" aria-label="产品一览" aria-roledescription="轮播" data-active="0">
    <div class="carousel-heading"><h3>产品一览</h3><div class="carousel-buttons"><button data-action="carousel-previous" aria-label="上一页产品">‹</button><button data-action="carousel-toggle" aria-label="暂停轮播" aria-pressed="false">Ⅱ</button><button data-action="carousel-next" aria-label="下一页产品">›</button></div></div>
    <div class="carousel-viewport"><div class="carousel-track">${slides.map((item,index)=>`<article class="carousel-slide" data-name="${escapeHTML(item.name)}" aria-roledescription="幻灯片" aria-label="${index+1} / ${slides.length} · ${escapeHTML(item.name)}"><button class="carousel-poster" data-action="store-details" data-application-id="${escapeHTML(item.applicationId)}" aria-label="了解${escapeHTML(item.name)}"><img class="carousel-artwork" src="./assets/posters/${applicationMedia(item.applicationId).posters[0]}" alt="${escapeHTML(item.name)}产品海报" decoding="async" draggable="false" /><span class="carousel-app-info">${applicationIcon(item)}<span class="carousel-copy"><strong>${escapeHTML(item.name)}</strong>${item.description ? `<span>${escapeHTML(item.description)}</span>` : ""}</span><span class="carousel-detail-label" aria-hidden="true">查看</span></span></button></article>`).join("")}</div></div>
    <div class="carousel-controls"><span class="carousel-caption">1 / ${Math.ceil(slides.length/2)}</span><div class="carousel-dots" aria-label="选择产品">${slides.filter((_,index)=>index%2===0).map((item,index)=>`<button class="carousel-dot" data-action="carousel-select" data-carousel-index="${index}" aria-label="第 ${index+1} 页产品：${escapeHTML(item.name)}" aria-current="${index===0}"><span></span></button>`).join("")}</div></div></section>`;
}

function applicationDetailView() {
  const installedItem = visibleInstalledApplications().find(item => item.applicationId === selectedApplicationId);
  const item = storeApplication(selectedApplicationId);
  if (!item) posterPreview = null;
  const media = item ? applicationMedia(item.applicationId)?.posters || [] : [];
  const modal = posterPreview !== null && media[posterPreview];
  const candidate = item ? applicationCandidate(item) : null;
  const operation = operationFor(selectedApplicationId);
  const status = operationMessage(operation);
  const preparation = item && applicationPreparationStatus(item);
  const version = installedItem?.version || candidate?.release?.version;
  const featuredId = item && availableFeaturedProductId(item);
  const featured = featuredId && FEATURED_PRODUCTS[featuredId];
  return `<div class="app-layout store-layout" ${marketConfirmation || modal ? "inert" : ""}>${shellHeader("应用介绍")}<div class="page-content app-detail-page">
    <button class="store-back" data-action="store-back"><span aria-hidden="true">‹</span> 应用</button>
    ${item ? `<section class="app-detail-hero" data-application-detail="${escapeHTML(item.applicationId)}" data-tone="creation">${applicationIcon(item)}<div class="app-detail-identity"><h2 class="app-detail-title" tabindex="-1">${escapeHTML(item.name)}</h2>${item.description ? `<p class="app-detail-tagline">${escapeHTML(item.description)}</p>` : ""}${applicationActions(item, Boolean(installedItem))}</div></section>
    ${pendingOpenView()}${notice ? `<div class="notice error" role="status">${escapeHTML(notice)}</div>` : ""}${status || preparation ? `<p class="market-status ${operation?.error ? "inline-error" : ""}" role="status">${escapeHTML(status || preparation)}</p>` : ""}
    <dl class="app-detail-facts">${version ? `<div><dt>${installedItem?.installationState === "pending" ? "待安装版本" : installedItem ? "当前版本" : "商店版本"}</dt><dd>${escapeHTML(version)}</dd></div>` : ""}<div><dt>安装状态</dt><dd>${installedItem ? installedItem.workshopRemote ? "盒子已启用，此电脑尚未安装" : installedItem.selectionRequired ? "待选择当前版本" : installedItem.installationState === "pending" ? "待完成盒端准备" : "已安装在此电脑" : "尚未安装"}</dd></div></dl>
    ${media.length ? `<section class="app-detail-section"><div class="section-heading"><h3>产品介绍</h3><span class="app-preview-hint">点击图片，放大查看</span></div><div class="app-poster-gallery ${media.length===1 ? "single" : ""}" role="region" aria-label="${escapeHTML(item.name)}产品海报" tabindex="0">${media.map((file,index)=>`<figure><button class="app-poster" data-action="poster-open" data-poster-index="${index}" aria-label="放大：${escapeHTML(item.name)}产品海报"><img src="./assets/posters/${file}" alt="${escapeHTML(item.name)}产品海报" decoding="async" /></button><figcaption><strong>${escapeHTML(item.name)}</strong></figcaption></figure>`).join("")}</div></section>` : ""}
    ${featured ? `<section class="app-detail-section featured-detail">
      <h3>应用介绍</h3>
      <ul class="featured-app-tasks">${featured.tasks.map(task => `<li>${task}</li>`).join("")}</ul>
      ${featuredExamples(featured)}
      <p class="featured-app-requirement">${featured.requirement}</p>
      <div class="featured-detail-demo">
        <p>查看示例任务中设置调整前后的效果。</p>
        <button class="button small" data-action="expert-installed-workshop" data-application-id="${escapeHTML(item.applicationId)}">工坊演示 <span aria-hidden="true">↗</span></button>
      </div>
    </section>` : ""}
    <section class="app-detail-section app-version-section"><h3>版本与管理</h3>${applicationManagement(item, Boolean(installedItem))}</section>` : '<div class="empty-state"><h2>此应用当前不可用</h2><p>返回应用刷新后重试。</p></div>'}
  </div></div>${modal ? `<section class="poster-modal" role="dialog" aria-modal="true" aria-label="${escapeHTML(item.name)}产品海报"><div class="poster-modal-card"><button class="button poster-close" data-action="poster-close" aria-label="关闭海报">关闭 ×</button><img src="./assets/posters/${modal}" alt="${escapeHTML(item.name)}产品海报" /></div></section>` : ""}${confirmationView()}`;
}

function confirmationView() {
  if (!marketConfirmation) return "";
  return `<section class="market-confirmation" role="alertdialog" aria-modal="true" aria-labelledby="market-confirm-title" aria-describedby="market-confirm-detail"><div class="market-confirm-card"><h2 id="market-confirm-title">${escapeHTML(marketConfirmation.title)}</h2><p id="market-confirm-detail">${escapeHTML(marketConfirmation.detail)}</p><div class="market-actions"><button class="button" data-action="market-cancel">取消</button><button class="button primary" data-action="market-confirm">确认${escapeHTML(marketConfirmation.verb)}</button></div></div></section>`;
}

function applicationsBannerControls(activeTab, loading, disabled = loading) {
  const tabs = [["wanx", "应用市场"], ["local", "我的应用"], ["workshop", "应用工坊"]];
  const workshopTab = activeTab === "workshop";
  const refreshAction = workshopTab ? "workshop-refresh" : "market-refresh";
  const refreshLabel = workshopTab ? "刷新工坊" : "检查更新";
  const refreshIcon = loading
    ? '<span class="activity-spinner" aria-hidden="true"></span>'
    : '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 4v5h-5m4.5 0A8 8 0 1 0 20 15"/></svg>';
  return `<div class="applications-banner-controls">
    <nav class="applications-tabs" aria-label="应用分类">${tabs.map(([id, label]) => `<button id="applications-tab-${id}" class="applications-tab" type="button" data-action="applications-tab" data-tab="${id}" aria-selected="${id === activeTab}">${label}</button>`).join("")}</nav>
    <button class="applications-banner-refresh" type="button" data-action="${refreshAction}" aria-label="${refreshLabel}" title="${loading ? `正在${refreshLabel}…` : refreshLabel}" aria-busy="${loading}" ${disabled ? "disabled" : ""}>${refreshIcon}</button>
  </div>`;
}

function applicationsView() {
  const listed = new Set(marketItems.map(item => item.applicationId));
  const applications = visibleInstalledApplications();
  const installed = new Set(applications.map((item) => item.applicationId));
  const pendingInstallations = applications.some((item) => item.installationState === "pending");
  const available = discoverableApplications().map(cloud=>{const local=applications.find(a=>a.applicationId===cloud.applicationId&&!isPrivateApplication(a));return local||cloud;});
  return `<div class="app-layout store-layout" ${marketConfirmation ? "inert" : ""}>${shellHeader("应用")}<div class="page-content store-page">
    <div class="store-heading wanx-section-banner" data-section="apps">${personalModuleHeading("applications", "AI 应用", "发现实用工具，管理自己的应用。") }
      <div class="store-toolbar applications-banner-actions">
        ${currentState.canLaunchApplications ? "" : `<div class="connection-line"><span class="status-dot"></span><span>${networkStatus().label}</span></div>`}
        ${applicationsBannerControls(applicationsTab, marketLoading)}
      </div>
    </div>
    ${pendingOpenView()}${notice ? `<div class="notice error" role="status">${escapeHTML(notice)}</div>` : ""}
    ${applicationsTab === "wanx" && marketCatalogState?.offline ? `<div class="notice" role="status">云端商城暂不可用，正在显示 ${escapeHTML(new Date(marketCatalogState.fetchedAt).toISOString().replace('T', ' ').slice(0, 19) + ' UTC')} 缓存的目录。已安装应用仍可打开；恢复网络后再检查下载与更新。</div>` : ""}

    <section id="applications-panel-${applicationsTab}" aria-label="${applicationsTab==='wanx'?'应用市场':'我的应用'}">${applicationsTab === "local" ? localApplicationsView() : `
    ${storeFeatures()}
    <section class="content-section market-section" aria-labelledby="market-heading" aria-busy="${marketLoading}"><div class="section-heading"><div><h3 id="market-heading">发现应用</h3><p>让 AI 融入你喜欢的事。</p></div></div>
    ${marketError ? `<div class="notice error" role="status">${escapeHTML(marketError)} <button class="text-button ${marketLoading ? "activity-button" : ""}" data-action="market-refresh" ${marketLoading ? "disabled" : ""}>${marketLoading ? activityLabel("正在刷新…") : "刷新重试"}</button></div>` : ""}
    ${available.length ? `<div class="application-list">${available.map((item) => applicationCard(item, applications.some(a=>a.applicationId===item.applicationId&&!isPrivateApplication(a)))).join("")}</div>` : `<p class="market-empty" role="status">${marketLoading ? "正在加载应用…" : marketError ? "稍后刷新即可重试。" : marketItems.length ? "商店中的应用均已安装。" : "暂无已上架应用。"}</p>`}</section>
    <div class="store-footnote"><span>Windows 与 macOS 通用</span><span aria-hidden="true">·</span><span>下载无需连接盒子，部分应用需连接盒子完成安装</span></div>
    `}</section>
  </div></div>${confirmationView()}`;
}

function selectApplicationsTab(tab) {
  if (tab === "workshop") {
    const entering = page !== "workshop";
    page = "workshop";
    releaseInteraction(); render(currentState);
    if (entering) document.scrollingElement?.scrollTo?.(0, 0);
    app.querySelector?.("#applications-tab-workshop")?.focus({ preventScroll: true });
    return;
  }
  if (!["wanx", "local"].includes(tab)) return;
  if (tab === "local" && applicationsTab !== tab && !expertApps.loading && expertApps.mode !== "unavailable") expertApps.loaded = false;
  applicationsTab = tab; page = "applications"; selectedApplicationId = null; posterPreview = null; notice = null;
  releaseInteraction(); render(currentState);
  app.querySelector?.(`#applications-tab-${tab}`)?.focus({ preventScroll: true });
}

async function refreshMarket() {
  if (currentState?.route === "auth") return;
  const generation = ++marketGeneration;
  marketLoading = true;
  marketError = null;
  marketCandidates = new Map();
  render(currentState);
  try {
    const response = await window.wanxClient.action("market.list");
    if (generation !== marketGeneration) return;
    if (response.state) acceptRemoteState(response.state);
    if (generation !== marketGeneration) return;
    if (!response.ok) throw new Error(response.code);
    marketItems = Array.isArray(response.value?.items) ? response.value.items : [];
    marketCatalogState = response.value?.catalogState || null;
    if (marketCatalogState?.offline) return;
    const installed = new Set((currentState.applications || []).map((item) => item.applicationId));
    const ids = new Set([...marketItems.map((item) => item.applicationId), ...installed]);
    await Promise.all([...ids].map(async (applicationId) => {
      const result = await window.wanxClient.action("market.candidate", { applicationId });
      if (generation !== marketGeneration) return;
      if (result.state) acceptRemoteState(result.state);
      if (generation !== marketGeneration) return;
      marketCandidates.set(applicationId, result.ok ? { ...result.value, installed: installed.has(applicationId) } : { status: "error", error: { code: result.code } });
    }));
  } catch (error) {
    if (generation === marketGeneration) { marketItems = []; marketCatalogState = null; marketError = marketErrorMessage(error); }
  } finally {
    if (generation === marketGeneration) { marketLoading = false; render(currentState); }
  }
}

function deviceIsOwner(deviceId) {
  const device = currentState.devices?.find(item => item.deviceId === deviceId);
  return Boolean(device && (device.deviceRole || device.role) === "owner");
}

function discoveryCard(candidate) {
  const hint = candidate.displayIdentity;
  const deviceId = discoveryDeviceId(candidate);
  // Public Device Info is a display hint only. Account names are joined by the
  // complete device ID; selection always keeps the original opaque handle.
  const known = deviceId && currentState.devices?.find((device) => device.deviceId === deviceId);
  // A registry can itself fall back to the ID. Neither that value nor the
  // protocol's fixed product label is a user-visible box name.
  const boxName = (value) => {
    const name = typeof value === "string" ? value.trim() : "";
    return name && name !== deviceId && !/^CentaurAI\s+Box$/i.test(name) &&
      !/^CentaurOS-(?:Setup-[0-9a-f]*|[0-9a-f]{6}|[0-9a-f]{24})?$/i.test(name) &&
      !/^centauros-box-[0-9a-f]+$/i.test(name) ? name : "";
  };
  const knownName = boxName(known?.name) || boxName(known?.displayName);
  const metadata = deviceId && discoveryMetadata.get(deviceId)?.value;
  const registryName = boxName(metadata?.deviceName);
  const specificName = deviceId && boxName(hint?.displayName);
  const advertisedName = candidate.advertisedName || "";
  const scanning = discoveryView.selecting && !discoveryView.retained;
  const reading = !deviceId && scanning && candidate.nameSource === "advertisement";
  const resolvedName = knownName || registryName || specificName;
  const knownClaimed = ["owner", "member"].includes(known?.deviceRole) || ["owner", "member"].includes(known?.role);
  const owner = deviceIsOwner(deviceId);
  const wrongTarget = setupTargetDeviceId && deviceId && deviceId !== setupTargetDeviceId;
  const claimStatus = knownClaimed ? "claimed" : metadata?.claimStatus || "unknown";
  const claimLabel = { claimed: "已认领", unclaimed: "未认领", unknown: "认领状态待确认" }[claimStatus];
  const title = resolvedName || (reading ? "正在读取盒子名称…" : "未获取到盒子名称");
  const detail = !deviceId && scanning && !reading
    ? [advertisedName, "选择后核对设备身份"].filter(Boolean).join(" · ")
    : [advertisedName, !deviceId ? reading ? "正在读取盒子名称…" : "未读取到名称" : "", "蓝牙配网"].filter(Boolean).join(" · ");
  const identityDetail = deviceId && !resolvedName
    ? `<span>设备编号：${escapeHTML(deviceId)}（用于核对，不是名称）</span>` : "";
  return `<button class="device-card discovery-card" data-action="${owner || setupTargetDeviceId ? "select-candidate-wifi" : "select-candidate"}" data-candidate-id="${escapeHTML(candidate.candidateId)}" ${wrongTarget || bluetoothState.status !== "available" || discoveryView.selecting && discoveryView.retained ? "disabled" : ""}><strong>${escapeHTML(title)}</strong><span class="claim-badge claim-${claimStatus}">${claimLabel}</span>${identityDetail}<span>${escapeHTML(detail)}</span>${wrongTarget ? "<span>不是当前要配置的盒子</span>" : setupTargetDeviceId && !deviceId ? "<span>选择后核对是否为目标盒子</span>" : owner ? "<span>修改 Wi-Fi</span>" : ""}</button>`;
}

function bluetoothNotice() {
  const status = bluetoothState.status;
  if (status === "available") return "";
  const message = {
    checking: "正在检查电脑蓝牙状态…",
    unavailable: "电脑蓝牙尚不可用。请先开启蓝牙；若电脑没有蓝牙适配器，请连接适配器后重试。",
    "permission-denied": "记忆盒子尚未获得蓝牙访问权限。请在系统设置中允许记忆盒子访问蓝牙，再重新检查。",
    unsupported: "当前运行环境不支持蓝牙发现。请使用支持蓝牙的记忆盒子桌面客户端。",
    error: "暂时无法读取电脑蓝牙状态，请确认蓝牙已开启后重新检查。",
  }[status];
  return `<div class="notice bluetooth-notice" role="status"><p>${escapeHTML(message)}</p>${!["checking", "unsupported"].includes(status) ? `<div class="wizard-actions"><button class="button small" data-action="bluetooth-settings">${status === "permission-denied" ? "打开蓝牙权限设置" : "打开蓝牙设置"}</button><button class="text-button" data-action="bluetooth-refresh">重新检查</button></div>` : ""}</div>`;
}

function consoleClaimView() {
  const offline = consoleClaimFlow === "entry-wifi";
  const receipt = consoleClaimReceipt;
  const ready = receipt?.authorizationState === "ready";
  const blocked = receipt?.authorizationState === "blocked";
  return `<div class="app-layout">${shellHeader("添加盒子")}<div class="page-content">
    <div class="page-heading"><div><h2>使用认领码添加盒子</h2><p class="muted">${receipt ? "账号绑定已确认，盒子接收授权后即可连接。" : "已有认领码的盒子也可以先配网，再确认绑定。"}</p></div><button class="text-button" data-action="show-help" data-scene="box_setup">常见问题 ›</button></div>
    <section class="wizard-card">
    ${receipt ? `<div role="status"><h3>${ready ? "盒子已就绪" : blocked ? "绑定已确认，授权暂不可用" : "绑定已确认，等待盒子授权"}</h3><p>设备 ID：${escapeHTML(receipt.deviceId)}</p><p>${ready ? "盒子已确认授权，可以返回盒子列表连接。" : blocked ? "请检查当前账号的设备权限，刷新状态后重试。" : "请保持盒子联网，等待盒子接收并确认授权后刷新状态。"}</p></div>
      <div class="wizard-actions"><button class="button" data-action="back-devices">返回盒子</button>${!ready ? `<button class="button primary" data-action="console-claim-refresh" ${busy ? "disabled" : ""}>${busyFor("devices.claim-status") ? "正在刷新…" : "刷新授权状态"}</button>` : '<button class="button primary" data-action="refresh">完成</button>'}</div>` : `
      <div class="wizard-actions"><button class="button ${!offline ? "primary" : ""}" data-action="console-claim-online" aria-pressed="${!offline}" ${busy ? "disabled" : ""}>盒子已联网</button><button class="button ${offline ? "primary" : ""}" data-action="console-claim-offline" aria-pressed="${offline}" ${busy ? "disabled" : ""}>需要先配网</button></div>
      <p>${offline ? "输入认领码以验证配网权限，然后发现并确认盒子、连接 Wi-Fi。配网成功后，还需点击“确认绑定到当前账号”。" : "输入盒子控制台或机身标签上的认领码，确认后绑定到当前账号。"}</p>
      <form data-form="console-claim"><label for="console-claim-code">盒子认领码</label><input id="console-claim-code" name="claimCode" required maxlength="20" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="输入 10 或 20 位认领码" /><button class="button primary" type="submit" ${busy ? "disabled" : ""}>${busyFor("devices.claim") ? "正在确认绑定…" : offline ? "下一步：发现盒子" : "确认绑定到当前账号"}</button></form>
      <div class="wizard-actions"><button class="button" data-action="back-devices">返回盒子</button><button class="text-button" data-action="console-claim-without-code" ${busy ? "disabled" : ""}>没有认领码，使用蓝牙认领</button></div>`}
      <button class="text-button setup-faq-entry" data-action="show-help" data-scene="box_setup">遇到问题？</button>${consoleClaimNotice ? `<p role="status">${escapeHTML(consoleClaimNotice)}</p>` : ""}${notice ? `<div class="notice error" role="status">${escapeHTML(notice)}</div>` : ""}
    </section></div></div>`;
}

function provisioningView() {
  if (consoleClaimReceipt || ["entry-online", "entry-wifi"].includes(consoleClaimFlow)) return consoleClaimView();
  const codeWifi = consoleClaimFlow === "wifi" || setupState.mode === "console";
  const wifiOnly = Boolean(setupTargetDeviceId) || setupState.mode === "wifi" || setupRequest?.mode === "wifi";
  const targetDevice = currentState.devices?.find(device => device.deviceId === setupTargetDeviceId);
  const targetLabel = targetDevice?.name || targetDevice?.displayName || setupTargetDeviceId;
  const starting = setupRequest?.action === "provisioning.start";
  const cancelling = setupRequest?.action === "provisioning.cancel";
  const refreshing = setupRequest?.action === "provisioning.refresh";
  const cancelButton = `<button class="button danger" data-action="cancel-provisioning" aria-busy="${cancelling}" ${cancelling ? "disabled" : ""}>${cancelling ? "正在取消…" : "取消"}</button>`;
  // waitingCloud describes polling, not an ownership commit. The device may
  // still owe its proof even though the account proof has been submitted.
  const initializing = setupState.claimState === "deviceAckPending";
  const cloudStage = initializing ? "initialize" : "claim";
  const cloudCopy = {
    waitingAppProof: "正在等待账号认领证明，认领尚未完成。",
    waitingDeviceProof: "正在等待盒子提交认领证明，认领尚未完成。请保持盒子联网后刷新。",
    ownershipCommitted: "账号绑定已确认，正在准备盒端授权。",
    projectionPending: "账号绑定已确认，正在同步访问权限。",
    deviceAckPending: "账号绑定已确认，正在等待盒子接收并确认授权。",
  }[setupState.claimState] || "认领尚未确认完成，请刷新认领状态。";
  const stagesByState = {
    idle: "discover", previewReady: "identity", awaitingWifi: "network",
    awaitingOwnershipConfirmation: "claim", awaitingCodeClaim: "claim", submittingAppProof: "claim",
    verifyingLocalDevice: "identity", establishingSecureChannel: "identity", provisioningWifi: "network", waitingCloud: cloudStage, attentionRequired: cloudStage,
  };
  const failed = ["terminalError", "restartRequired"].includes(setupState.state);
  const provisioning = {
    phase: starting || cancelling ? "running" : failed ? "failed" : setupState.state === "completed" ? "ready" :
      ["verifyingLocalDevice", "establishingSecureChannel", "submittingAppProof", "provisioningWifi", "waitingCloud"].includes(setupState.state) ? "running" : "idle",
    stage: starting ? "identity" : stagesByState[setupState.state],
    error: { message: setupErrorMessage(setupState.errorCode) },
  };
  const running = provisioning.phase === "running";
  const preview = setupState.preview || setupState.compatiblePreview;
  const ownershipBlock = !wifiOnly && ({ owned_self: "DEVICE_ALREADY_OWNED", owned_other: "DEVICE_OWNED_BY_OTHER",
    legacy_bound: "LEGACY_BINDING_REVIEW_REQUIRED", history_review: "CLAIM_HISTORY_REVIEW_REQUIRED",
    reset_pending: "DEVICE_RESET_PENDING" })[setupState.ownershipState];
  const previewBlocked = setupState.claimStatusError || ownershipBlock || (preview?.cloud_enrollment_status === "not_enrolled" ? "DEVICE_NOT_ENROLLED" :
    !wifiOnly && preview?.pairing_mode_remaining_seconds === 0 ? "PAIRING_MODE_CLOSED" : null);
  const setupPhase = setupState.state || "idle";
  const stages = Object.entries(stageLabels).filter(([key]) => !wifiOnly || !["claim", "initialize"].includes(key));
  const setupCopy = starting ? (setupState.connectionAttempt === 2 ? "蓝牙连接暂未成功，正在自动重连…" : "正在通过蓝牙读取盒子身份，请稍候。") : cancelling ? "正在停止本次配网，请稍候。" : {
    idle: wifiOnly ? "让目标盒子保持通电并靠近电脑，扫描后确认设备身份，再选择 Wi-Fi。电脑需联网以验证主人权限，盒子可以处于离线状态。" : "让盒子保持通电，点击扫描并选择附近的盒子。已认领的盒子也可从盒子卡片的“配置网络”入口修改 Wi-Fi。",
    attentionRequired: cloudCopy,
    previewReady: previewBlocked ? setupErrorMessage(previewBlocked) : "请核对设备 ID、型号和身份指纹，然后确认。",
    verifyingLocalDevice: codeWifi ? "正在验证设备身份和认领码配网权限…" : wifiOnly ? "正在验证设备身份和主人权限…" : "正在验证设备身份…",
    establishingSecureChannel: "正在建立加密连接…",
    awaitingWifi: setupState.sessionRenewed ? "安全会话已自动更新，请重新选择网络并确认。上次提交不会自动重复。" : wifiOnly ? "主人权限已验证，请选择新的 Wi-Fi。认领关系和盒子数据将保留。" : "设备身份已验证，请选择盒子要连接的 Wi-Fi。",
    awaitingOwnershipConfirmation: "设备已准备联网，请确认绑定到当前账号。",
    awaitingCodeClaim: "盒子已连接 Wi-Fi。请确认使用认领码，将此盒子绑定到当前账号。",
    submittingAppProof: "正在提交账号绑定证明…",
    provisioningWifi: "正在通过加密通道配置 Wi‑Fi…",
    waitingCloud: cloudCopy,
    completed: wifiOnly ? "Wi-Fi 配置成功，认领关系和盒子数据已保留。" : "设备已完成联网和账号绑定。",
    cancelled: "本次配网已取消。",
  }[setupPhase] || "让盒子保持通电并靠近电脑，然后开始扫描。";
  const previewBlock = preview ? `<dl class="setup-preview"><dt>设备名称</dt><dd>${escapeHTML(preview.display_name)}</dd><dt>设备 ID</dt><dd>${escapeHTML(preview.device_id)}</dd><dt>型号</dt><dd>${escapeHTML(preview.model)}</dd><dt>身份公钥指纹</dt><dd>${escapeHTML(preview.identity_public_key_sha256)}</dd></dl>` : "";
  const { candidates, selecting, retained } = discoveryView;
  const discoveryBlock = selecting || retained ? `<div class="discovery-list"><p>${retained ? "扫描已结束，本轮结果保留 2 分钟。请选择要配置的盒子：" : "选择要配置的盒子："}</p>${candidates.length ? candidates.map(candidate => discoveryCard(candidate)).join("") : "<p>正在等待附近的盒子，请让盒子保持通电并靠近电脑。</p>"}</div>` : "";
  const controls = setupPhase === "previewReady"
    ? `<button class="button primary" data-action="provisioning-confirm" ${busy || previewBlocked ? "disabled" : ""}>${previewBlocked ? (wifiOnly ? "暂不能配置网络" : "暂不能认领") : "确认设备身份"}</button>`
    : setupPhase === "awaitingWifi"
      ? `<form class="setup-wifi" data-form="wifi"><div class="wifi-picker" data-wifi-list><label>盒子附近的 Wi-Fi<select data-input="wifi-network" required>${wifiOptions()}</select></label><button class="button small" type="button" data-action="wifi-refresh">刷新列表</button></div><p class="hint wifi-status" data-wifi-status role="status" aria-live="polite"></p><button class="text-button wifi-mode" type="button" data-action="wifi-manual">隐藏网络 / 手动添加</button><label hidden>Wi‑Fi 名称<input name="ssid" required maxlength="32" autocomplete="off" /></label><label hidden>安全类型<select name="security"><option value="wpa_personal">WPA/WPA2 个人网络</option><option value="open">开放网络</option></select></label><label class="check" hidden><input name="hidden" type="checkbox" />隐藏网络</label><label class="wifi-password">密码<span class="password-field"><input name="password" type="password" maxlength="128" autocomplete="off" /><button type="button" class="password-toggle" data-action="wifi-password-toggle" aria-label="显示密码" aria-pressed="false" title="显示密码"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/><path data-password-slash d="M4 4l16 16" hidden /></svg></button></span></label><button class="button primary" type="submit" ${busy ? "disabled" : ""}>${wifiOnly || codeWifi ? "连接 Wi-Fi" : "继续绑定账号"}</button></form>`
      : codeWifi && setupPhase === "awaitingCodeClaim"
        ? `<button class="button primary" data-action="console-claim-confirm" ${busy ? "disabled" : ""}>${busyFor("provisioning.code-claim") ? "正在确认绑定…" : "确认绑定到当前账号"}</button>`
      : !wifiOnly && setupPhase === "awaitingOwnershipConfirmation"
        ? `<button class="button primary" data-action="provisioning-owner" ${busy ? "disabled" : ""}>确认绑定到当前账号</button>`
        : "";
  return `
    <div class="app-layout">
      ${shellHeader(wifiOnly ? "配置网络" : "添加盒子")}<div class="page-content">
      <div class="page-heading"><div><h2>${wifiOnly ? "配置网络" : codeWifi ? "使用认领码：先配置网络" : "添加盒子"}</h2><p class="muted">${wifiOnly ? "通过蓝牙修改 Wi-Fi，保留认领关系和全部业务数据。" : "新盒子可配网并认领；已认领的盒子可由主人修改 Wi-Fi。"}</p>${setupTargetDeviceId ? `<p>正在配置：<strong>${escapeHTML(targetLabel)}</strong></p><p class="muted">设备编号：${escapeHTML(setupTargetDeviceId)}</p>` : ""}</div><button class="text-button" data-action="show-help" data-scene="box_setup">常见问题 ›</button></div>
      <section class="wizard-card"><div class="wizard-steps">${stages.map(([key, label], index) => { const active = provisioning.stage === key; const done = provisioning.phase === "ready" || stages.findIndex(([name]) => name === provisioning.stage) > index; return `<div class="wizard-step ${active ? "active" : ""} ${done ? "done" : ""}"><span>${done ? "✓" : index + 1}</span><label>${label}</label></div>`; }).join("")}</div>
        <div class="wizard-copy"><p class="eyebrow">${running ? "正在处理" : provisioning.phase === "failed" ? "接入未完成" : "设备配置"}</p><h3>${starting ? "正在读取设备身份…" : cancelling ? "正在取消配网…" : running ? escapeHTML(stageLabels[provisioning.stage] || "处理中") : setupPhase === "idle" ? "发现附近的盒子" : "配置设备"}</h3><p>${provisioning.phase === "failed" ? escapeHTML(provisioning.error?.message || "本次接入失败") : escapeHTML(setupCopy)}</p><button class="text-button setup-faq-entry" data-action="show-help" data-scene="box_setup">遇到问题？</button>${bluetoothNotice()}${discoveryBlock}${previewBlock}${controls}</div>
        <div class="wizard-actions">${running ? `<button class="button" disabled>返回盒子</button>${cancelButton}` : `<button class="button" data-action="back-devices">返回盒子</button>${["idle", "cancelled"].includes(setupPhase) || provisioning.phase === "failed" ? `<button class="button primary scan-button" data-action="start-provisioning" aria-busy="${selecting}" ${busy || !setupReady || bluetoothState.status !== "available" || selecting ? "disabled" : ""}>${selecting ? '<span class="scan-spinner" aria-hidden="true"></span><span>正在扫描…</span>' : provisioning.phase === "failed" || retained ? "重新扫描" : "开始扫描盒子"}</button>` : setupPhase === "completed" ? '<button class="button primary" data-action="refresh">完成</button>' : cancelButton}</div>`}
        ${setupPhase === "attentionRequired" ? `<button class="button" data-action="provisioning-refresh" aria-busy="${refreshing}" ${busy ? "disabled" : ""}>${refreshing ? "正在刷新…" : initializing ? "刷新授权状态" : "刷新认领状态"}</button>` : ""}
        ${codeWifi && failed ? `<button class="text-button" data-action="console-claim-edit" ${busy ? "disabled" : ""}>重新输入认领码</button>` : ""}
        ${notice ? `<div class="notice error">${escapeHTML(notice)}</div>` : ""}
        ${!setupReady ? '<p class="hint">正在准备蓝牙配网服务…</p>' : ""}
      </section></div>
    </div>`;
}

function authBusyLabel() {
  return {
    "auth.login": "正在登录…",
    "auth.register": "正在创建账号…",
    "auth.reset-password": "正在重置密码…",
  }[busyRequest?.action] || (currentState?.account?.phase === "authenticating" ? "正在恢复登录…" : "处理中…");
}

// State broadcasts must not detach the pressed control before Chromium emits click.
function releaseInteraction() {
  clearTimeout(interactionTimer);
  activeInteraction = false;
}
function finishInteraction() {
  clearTimeout(interactionTimer);
  interactionTimer = setTimeout(() => { releaseInteraction(); if (currentState) render(currentState); }, 0);
}
app.addEventListener("pointerdown", event => {
  if (!event.target.closest?.('button, input, select, textarea, summary, a')) return;
  clearTimeout(interactionTimer);
  activeInteraction = true;
});
window.addEventListener?.("pointerup", finishInteraction);
window.addEventListener?.("pointercancel", finishInteraction);
window.addEventListener?.("keyup", finishInteraction);
window.addEventListener?.("blur", finishInteraction);

function showSavedLogins(form, items) {
  const select = form.elements.savedLogin;
  select.innerHTML = `<option value="">使用其他账号</option>${items.map(({ phone }) => `<option value="${escapeHTML(phone)}">${escapeHTML(phone)}</option>`).join("")}`;
  select.value = items.some(({ phone }) => phone === form.elements.username.value) ? form.elements.username.value : "";
  form.querySelector('[data-saved-logins]').hidden = items.length === 0;
}

async function selectSavedLogin(form, phone) {
  const request = form.dataset.savedLoginRequest = String(Number(form.dataset.savedLoginRequest || 0) + 1);
  form.dataset.edited = "true";
  form.elements.username.value = authUsername = phone;
  form.elements.password.value = "";
  delete form.dataset.savedLoginPhone;
  if (!phone) return;
  try {
    const saved = await window.wanxClient.getRememberedLogin(phone);
    if (app.querySelector('[data-form="auth"]') !== form || form.dataset.savedLoginRequest !== request || authBusy()) return;
    if (saved.phone === phone && saved.password) {
      form.elements.password.value = saved.password;
      form.elements.remember.checked = true;
      form.dataset.savedLoginPhone = phone;
    }
  } catch (error) {
    if (app.querySelector('[data-form="auth"]') !== form || form.dataset.savedLoginRequest !== request) return;
    notice = operationErrorMessage(error);
    syncFormState();
  }
}

async function fillRememberedLogin(form) {
  if (!form?.elements) return;
  form.dataset.rememberLoad = "pending";
  const edited = () => { form.dataset.edited = "true"; };
  form.addEventListener("input", edited, { once: true });
  form.addEventListener("change", edited, { once: true });
  try {
    const [saved, { items }] = await Promise.all([
      window.wanxClient.getRememberedLogin(), window.wanxClient.listRememberedLogins(),
    ]);
    if (app.querySelector('[data-form="auth"]') !== form) return;
    if (busy) { delete form.dataset.rememberLoad; return; }
    form.dataset.rememberLoad = "done";
    showSavedLogins(form, items);
    if (form.dataset.edited) return;
    form.elements.remember.checked = saved.remember;
    if (saved.phone && saved.password) {
      form.elements.username.value = saved.phone;
      form.elements.password.value = saved.password;
      authUsername = saved.phone;
      form.dataset.savedLoginPhone = saved.phone;
      form.elements.savedLogin.value = saved.phone;
    }
  } catch (error) {
    form.dataset.rememberLoad = "done";
    if (app.querySelector('[data-form="auth"]') !== form) return;
    notice = operationErrorMessage(error);
    render(currentState);
  }
}

// Keep the credits dialog, focused input and decoded QR image mounted while
// polling changes text or attributes elsewhere on the page.
function updateCreditsDOM(current, incoming) {
  const previous = Array.from(current.childNodes);
  const next = Array.from(incoming.childNodes);
  for (let index = 0; index < Math.max(previous.length, next.length); index++) {
    const oldNode = previous[index], newNode = next[index];
    if (!newNode) { oldNode.remove(); continue; }
    if (!oldNode) { current.appendChild(newNode.cloneNode(true)); continue; }
    if (oldNode.nodeType !== newNode.nodeType || oldNode.nodeName !== newNode.nodeName) {
      oldNode.replaceWith(newNode.cloneNode(true)); continue;
    }
    if (oldNode.nodeType !== 1) {
      if (oldNode.nodeValue !== newNode.nodeValue) oldNode.nodeValue = newNode.nodeValue;
      continue;
    }
    for (const attribute of Array.from(oldNode.attributes)) {
      if (!newNode.hasAttribute(attribute.name)) oldNode.removeAttribute(attribute.name);
    }
    for (const attribute of newNode.attributes) {
      if (oldNode.getAttribute(attribute.name) !== attribute.value) oldNode.setAttribute(attribute.name, attribute.value);
    }
    if (oldNode.tagName === 'INPUT' && oldNode.value !== newNode.value) oldNode.value = newNode.value;
    updateCreditsDOM(oldNode, newNode);
  }
}

function render(state) {
  if (["applications", "application-detail", "workshop"].includes(page)) page = homePage;
  const updateRequired = clientUpdateRequired(state);
  // Let an existing file editor finish saving before replacing its DOM.
  const retainingEditor = updateRequired && page === "space" && window.wanxSpace?.retainEditor?.();
  if (updateRequired && !["client-update", "settings", "boxes", "profile", "help"].includes(page) && !retainingEditor) page = "client-update";
  else if (!updateRequired && page === "client-update") page = homePage;
  if (updateRequired && marketConfirmation && !marketConfirmation.updateReleaseId) marketConfirmation = null;
  if (state.account?.phase === "authenticated") cloudAuthOpen = false;
  const auth = cloudAuthOpen || state.route === "auth" || state.phase === "signed_out" || state.phase === "authenticating";
  accessoryPageVisible = !auth && page === "accessories";
  if (!accessoryPageVisible) accessoryPreview?.mount(null);
  helpView?.visible(page === "help" || Boolean(helpDrawer));
  const previousAuth = app.querySelector?.('[data-form="auth"]');
  if (auth && previousAuth?.elements) authUsername = previousAuth.elements.username.value.trim();
  if (auth || state.dataOwnerId !== currentState?.dataOwnerId || state.dataContextId !== currentState?.dataContextId ||
      state.account?.accountId !== currentState?.account?.accountId ||
      state.account?.clientId !== currentState?.account?.clientId ||
      state.selectedDeviceId !== currentState?.selectedDeviceId) sidebarIntent = null;
  currentState = state;
  const libraryScope=!auth&&state.canLaunchApplications?JSON.stringify([state.dataOwnerId,state.account?.accountId,state.connection?.deviceId,state.dataIdentity?.selected?.boxId,state.dataIdentity?.selected?.principalId,(state.applications||[]).map(a=>[a.applicationId,a.version,a.installationSource])]):'';
  if(appLibrary.scope!==libraryScope)appLibrary={scope:libraryScope,loading:false,loaded:false,items:[],projects:[],workshopApplicationIds:[],error:''};
  const expertScope = !auth ? JSON.stringify([state.dataOwnerId, state.dataContextId, state.account?.accountId,
    state.account?.clientId, state.selectedDeviceId, state.connection?.deviceId, state.dataIdentity?.selected?.principalId]) : "";
  if (expertApps.scope !== expertScope) expertApps = expertCatalog(expertScope);
  dataView.sync(state,true,!auth&&page==='data');
  if(!auth&&page==="data"&&dataView.needsLoad())queueMicrotask(()=>void dataView.refresh());
  aiDialogueView?.hostState(state);
  syncAcademyContext(!auth && page !== "provisioning");
  if (pendingDialogueOpen) {
    const handoff = pendingDialogueHandoff;
    pendingDialogueOpen = false;
    pendingDialogueHandoff = null;
    openAcademyDialogue(handoff);
  }
  dialogueModelSettings?.hostState(state);
  dialogueModelSettings?.visible(!auth && page === "dialogue-models");
  const viewingRedactionSettings = !auth && page === "settings";
  const redactionSettingsOwner = state.dataIdentity?.profileId ? state.dataOwnerId : state.account?.accountId;
  spaceRedactionSettings?.sync(viewingRedactionSettings && redactionSettingsOwner
    ? JSON.stringify([Boolean(state.dataIdentity?.profileId), redactionSettingsOwner]) : null);
  if (!viewingRedactionSettings || !redactionRuleComposition?.isConnected) redactionRuleComposition = null;
  window.wanxSpace?.activate(!auth && (page === "boxes" || page === "space"), page === "space");
  supportView.sync(auth || state.account?.phase !== "authenticated" ? null : JSON.stringify([state.account?.accountId, state.account?.clientId]), state.devices || []);
  supportView.visible(!auth && page === "boxes");
  creditsView.visible(!auth && page === "credits");
  if (activeInteraction || window.wanxSpace?.isSelecting?.() || window.wanxSpace?.isDragging?.()) return;
  // Moving even the same input node interrupts the native IME candidate session.
  if (viewingRedactionSettings && redactionRuleComposition?.isConnected) return;
  if (!auth && page === "data" && dataView.isComposing?.()) return;
  if (!auth && page === "space" && window.wanxSpace?.retainEditor?.()) return;
  if (auth || page !== "memory") {
    memoryAgent = "";
    memoryPage = "";
  }
  const desiredMemorySection = auth ? null : activeMemorySection();
  const markup = page === "help" ? `<div class="app-layout">${auth ? `<header class="topbar faq-public-header"><div class="brand"><img class="brand-mark" src="./assets/centaurai-mark.png" alt="" />${clientBrandCopy}</div></header>` : shellHeader("常见问题")}${helpView?.render({ backLabel: helpReturnLabel }) || ""}</div>` : auth ? authView() : page === "client-update" ? requiredClientUpdateView() : page === "provisioning" ? provisioningView()
    : desiredMemorySection !== null ? memoryView(desiredMemorySection)
    : page === "dialogue-models" ? `<div class="app-layout">${shellHeader("助理模型")}<div class="page-content dialogue-model-settings-page"><div id="dialogue-model-settings-host"></div></div></div>`
    : page === "data" ? `<div class="app-layout starlink-layout">${shellHeader("星图")}<header class="wanx-section-banner starlink-banner" data-section="starlink">${personalModuleHeading("starlink", "本体星图", "在图谱中探索个人本体的实体与关系，沿着关联追溯原文。")}</header><div class="page-content data-page-content">${dataView.render()}</div></div>`
    : page === "space" ? spaceView()
    : page === "accessories" ? accessoriesView()
    : page === "notifications" ? notificationView() : page === "profile" ? profileView() : page === "credits" ? `<div class="app-layout"><div ${creditsView.isOpen() ? "inert" : ""}>${shellHeader("积分")}</div>${creditsView.render()}</div>` : page === "boxes" ? boxesView() : page === "settings" ? settingsView() : memoryView("my-ai");
  if (markup === renderedMarkup) {
    if (!auth && page === 'data') dataView.mount();
    if (page === "dialogue-models") dialogueModelSettings?.mount(app.querySelector?.("#dialogue-model-settings-host"));
    window.wanxMemory?.mount(app.querySelector?.(".memory-host"));
    syncFormState();
    syncAcademyModal();
    return;
  }
  const restoreDataInput = !auth && page === "data" ? dataView.retainInput?.(app) : null;
  renderedMarkup = markup;
  // Reuse the actual Wi-Fi form when setup updates. This preserves typed secrets,
  // selection and focus; network polling does not rebuild active setup forms.
  const wifiForm = page === "provisioning" && setupState.state === "awaitingWifi" ? app.querySelector?.('[data-form="wifi"]') : null;
  const authForm = auth && previousAuth?.dataset.mode === authMode ? previousAuth : null;
  const transferForm = !auth && page === "boxes" && transferDeviceId && currentState.devices?.some(item => item.deviceId === transferDeviceId && (item.deviceRole === "owner" || item.role === "owner")) ? app.querySelector?.(`[data-form="transfer"][data-device-id="${transferDeviceId}"]`) : null;
  // Keep the active scan indicator spinning across discovery and account updates.
  const scanButton = !auth && page === "provisioning" && discoveryView.selecting
    ? app.querySelector?.('[data-action="start-provisioning"][aria-busy="true"]') : null;
  const scanAnimations = new Map(scanButton?.querySelector('.scan-spinner').getAnimations().map(animation => [animation.animationName, animation.currentTime]));
  const passwordForm = !auth && page === "settings" && passwordEditing ? app.querySelector?.('[data-form="password-change"]') : null;
  const profileForm = !auth && page === "profile" ? app.querySelector?.('[data-form="profile"]') : null;
  const claimForm = !auth && page === "provisioning" && !consoleClaimReceipt && ["entry-online", "entry-wifi"].includes(consoleClaimFlow) ? app.querySelector?.('[data-form="console-claim"]') : null;
  const searchForm = page === "help" ? app.querySelector?.('[data-form="help-search"]') : null;
  const helpForm = searchForm?.contains(document.activeElement) ? searchForm : null;
  const feedbackFocus = page === "help" && ["faq-feedback-content", "faq-feedback-contact"].includes(document.activeElement?.id)
    ? { id: document.activeElement.id, start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd } : null;
  const retainedForm = helpForm || wifiForm || authForm || transferForm || passwordForm || profileForm || claimForm;
  const focused = retainedForm?.contains(document.activeElement) ? document.activeElement : null;
  const walletDialog = app.querySelector?.('.wallet-purchase-dialog');
  // Detached dialog nodes lose their scroll offsets when innerHTML is replaced.
  const walletScroll = walletDialog ? { top: walletDialog.scrollTop, left: walletDialog.scrollLeft, step: walletDialog.dataset.step } : null;
  const walletFocus = walletDialog?.contains(document.activeElement) ? { ...document.activeElement.dataset } : null;
  const walletInput = walletDialog && document.activeElement?.id === 'wallet-custom-amount' ? document.activeElement : null;
  const walletSelection = walletInput ? [walletInput.selectionStart, walletInput.selectionEnd] : null;
  const scroller = document.scrollingElement;
  const scroll = (retainedForm || feedbackFocus || walletDialog) && scroller ? { top: scroller.scrollTop, left: scroller.scrollLeft } : null;
  const spaceList = page === "space" ? app.querySelector?.(".space-file-list") : null;
  const spacePosition = spaceList ? { key: spaceList.dataset.location, top: spaceList.scrollTop } : null;
  const spaceFocus = spaceList?.contains?.(document.activeElement) ? document.activeElement.closest?.("[data-entry-id]")?.dataset.entryId || "" : null;
  const spaceSearch = page === "space" && document.activeElement?.id === "space-search" ? document.activeElement : null;
  const searchSelection = spaceSearch ? [spaceSearch.selectionStart, spaceSearch.selectionEnd] : null;
  const modelSettingsHost = !auth && page === "dialogue-models" ? app.querySelector?.("#dialogue-model-settings-host") : null;
  const modelSettingsFocus = modelSettingsHost?.contains(document.activeElement) ? document.activeElement : null;
  const redactionSettingsHost = viewingRedactionSettings ? app.querySelector?.("#space-redaction-settings-host") : null;
  const redactionSettingsFocus = redactionSettingsHost?.contains(document.activeElement) ? document.activeElement : null;
  const memoryHost = app.querySelector?.(".memory-host");
  const accessoriesHost = !auth && page === "accessories" && app.querySelector?.(".accessories-tab-host");
  if (memoryHost && desiredMemorySection !== null && memoryHost.dataset.memorySection === desiredMemorySection &&
    (memoryHost.dataset.memoryAgent ?? "") === (page === "memory" ? memoryAgent : "") &&
    (memoryHost.dataset.memoryPage ?? "") === (page === "memory" ? memoryPage : "")) {
    const template = document.createElement("template");
    template.innerHTML = markup;
    app.querySelector(".topbar").replaceWith(template.content.querySelector(".topbar"));
  } else if (accessoriesHost) {
    const template = document.createElement("template");
    template.innerHTML = markup;
    app.querySelector(".topbar").replaceWith(template.content.querySelector(".topbar"));
  } else if (!auth && page === 'credits' && app.querySelector?.('.credits-page')) {
    const template = document.createElement('template');
    template.innerHTML = markup;
    updateCreditsDOM(app, template.content);
  } else {
    const focused=document.activeElement?.dataset?.workshopField;
    const focusedTab = document.activeElement?.closest?.(".applications-tab")?.dataset.tab;
    const caret=focused?document.activeElement.selectionStart:null;
    if (!auth && page === "workshop") window.replaceWanxWorkshopMarkup(app, markup);
    else app.innerHTML = markup;
    if(focused){const input=app.querySelector(`[data-workshop-field="${focused}"]`);input?.focus({preventScroll:true});if(caret!=null)input?.setSelectionRange(caret,caret);}
    if (focusedTab) app.querySelector?.(`#applications-tab-${focusedTab}`)?.focus({ preventScroll: true });
  }
  window.wanxMemory?.mount(app.querySelector?.(".memory-host"));
  restoreDataInput?.();
  if (!auth && page === "workshop") workshop.mounted(app);
  syncAcademyModal();
  if (modelSettingsHost) { app.querySelector?.("#dialogue-model-settings-host")?.replaceWith(modelSettingsHost); modelSettingsFocus?.focus({ preventScroll:true }); }
  if (!auth && page === "dialogue-models") dialogueModelSettings?.mount(app.querySelector?.("#dialogue-model-settings-host"));
  if (redactionSettingsHost) {
    app.querySelector?.("#space-redaction-settings-host")?.replaceWith(redactionSettingsHost);
    redactionSettingsFocus?.focus({ preventScroll: true });
  }
  spaceRedactionSettings?.mount(viewingRedactionSettings ? app.querySelector?.("#space-redaction-settings-host") : null);
  if (spacePosition) {
    const replacement = app.querySelector?.(".space-file-list");
    if (replacement?.dataset.location === spacePosition.key) {
      // Keep row nodes during selection/progress refreshes so a double-click
      // still targets the same file and the browser retains its scroll position.
      const oldRows = Array.from(spaceList.querySelectorAll?.(".space-file-row") || []);
      const nextRows = Array.from(replacement.querySelectorAll?.(".space-file-row") || []);
      if (oldRows.length && oldRows.length === nextRows.length && oldRows.every((row, index) => row.dataset.entryId === nextRows[index].dataset.entryId && row.innerHTML === nextRows[index].innerHTML)) {
        for (let index = 0; index < oldRows.length; index++) {
          const row = oldRows[index], next = nextRows[index];
          row.className = next.className;
          row.setAttribute("aria-selected", next.getAttribute("aria-selected"));
          row.tabIndex = next.tabIndex;
        }
        spaceList.setAttribute("aria-busy", replacement.getAttribute("aria-busy"));
        replacement.replaceWith(spaceList);
        spaceList.scrollTop = spacePosition.top;
      } else replacement.scrollTop = spacePosition.top;
    }
  }
  if (spaceSearch) {
    const replacement = app.querySelector?.("#space-search");
    replacement?.focus({ preventScroll: true });
    if (searchSelection[0] != null) replacement?.setSelectionRange?.(...searchSelection);
  }
  if (spaceFocus !== null) {
    const list = app.querySelector?.(".space-file-list");
    (list?.querySelector?.(`[data-entry-id="${spaceFocus}"]`) || list)?.focus?.({ preventScroll: true });
  }

  if (scanButton) {
    app.querySelector?.('[data-action="start-provisioning"][aria-busy="true"]')?.replaceWith(scanButton);
    for (const animation of scanButton.querySelector('.scan-spinner').getAnimations()) {
      animation.currentTime = scanAnimations.get(animation.animationName) ?? 0;
    }
  }
  if (retainedForm) {
    const formName = wifiForm ? "wifi" : transferForm ? "transfer" : passwordForm ? "password-change" : profileForm ? "profile" : claimForm ? "console-claim" : "auth";
    app.querySelector?.(`[data-form="${formName}"]`)?.replaceWith(retainedForm);
    const submit = retainedForm.querySelector('button[type="submit"]');
    if (submit) {
      submit.disabled = authForm ? authBusy() : busy;
      const pending = authForm ? currentState?.account?.phase === "authenticating" || busy && ["auth.login", "auth.register", "auth.reset-password"].includes(busyRequest?.action)
        : passwordForm ? busyFor("auth.change-password") : profileForm ? busyFor("profile.save") : false;
      submit.classList.toggle("activity-button", pending);
      submit.setAttribute("aria-busy", String(pending));
      if (authForm) submit.innerHTML = pending ? activityLabel(authBusyLabel()) : busy ? authBusyLabel() : authSubmitLabel();
      if (passwordForm) submit.innerHTML = pending ? activityLabel("正在修改…") : busy ? "处理中…" : "确认修改";
      if (claimForm) submit.textContent = busyFor("devices.claim") ? "正在确认绑定…" : consoleClaimFlow === "entry-wifi" ? "下一步：发现盒子" : "确认绑定到当前账号";
      if (profileForm) submit.innerHTML = pending ? activityLabel("正在保存…") : "保存资料";
    }
    focused?.focus({ preventScroll: true });
  }
  if (feedbackFocus) {
    const field = app.querySelector?.(`#${feedbackFocus.id}`);
    field?.focus({ preventScroll: true });
    if (feedbackFocus.start != null) field?.setSelectionRange?.(feedbackFocus.start, feedbackFocus.end);
  }
  const nextWalletDialog = app.querySelector?.('.wallet-purchase-dialog');
  if (nextWalletDialog) {
    const buttons = Array.from(nextWalletDialog.querySelectorAll('button:not(:disabled)'));
    const previous = walletInput ? nextWalletDialog.querySelector('#wallet-custom-amount:not(:disabled)')
      : buttons.find(button => button.dataset.action === walletFocus?.action && button.dataset.amount === walletFocus?.amount && button.dataset.channel === walletFocus?.channel);
    if (!nextWalletDialog.contains(document.activeElement) || document.activeElement.disabled) {
      restoreWalletFocus(previous || buttons.find(button => button.getAttribute('aria-pressed') === 'true') || buttons.find(button => button.dataset.action === 'credits-buy') || nextWalletDialog);
    }
    if (walletSelection && previous) previous.setSelectionRange(...walletSelection);
    if (walletScroll && walletScroll.step !== nextWalletDialog.dataset.step) {
      nextWalletDialog.scrollTop = 0;
      nextWalletDialog.focus({ preventScroll: true });
    } else if (walletScroll) {
      nextWalletDialog.scrollTop = walletScroll.top;
      nextWalletDialog.scrollLeft = walletScroll.left;
    }
  } else if (walletDialog && page === 'credits' && !auth) {
    app.querySelector?.('[data-action="credits-open"]')?.focus({ preventScroll: true });
  }
  storeCarousel.mount(app.querySelector?.(".store-carousel"), !auth && page === "applications" && !marketConfirmation && !profileMenuOpen);
  syncWalletCountdown();
  syncFormState();
  // Reattaching a focused form must not pull the user back after they scroll away.
  if (scroll) {
    scroller.scrollTop = scroll.top;
    scroller.scrollLeft = scroll.left;
  }
  if (marketConfirmation) app.querySelector?.('[data-action="market-cancel"]')?.focus();
  if (page === "space") window.wanxSpace?.mounted?.();
  if (!auth && page === 'data') dataView.mount();
  const pendingPanel = app.querySelector?.(".pending-open");
  const pendingId = pendingPanel ? currentState.ui?.pendingOpen?.id : null;
  // Reveal each new request once; background updates must not pull the user
  // back after they choose a box or scroll elsewhere.
  if (pendingId && pendingId !== revealedPendingOpenId) {
    pendingPanel.style.scrollMarginTop = `${(app.querySelector?.(".topbar")?.offsetHeight || 0) + 16}px`;
    pendingPanel.scrollIntoView?.({ block: "start", behavior: "instant" });
  }
  revealedPendingOpenId = pendingId;
}

function syncFormState() {
  if (authMode === "login") {
    const form = app.querySelector?.('[data-form="auth"]');
    if (form?.elements?.remember) form.elements.remember.disabled = busy;
    if (form?.elements?.savedLogin) form.elements.savedLogin.disabled = authBusy();
    if (!busy && !form?.dataset.rememberLoad) void fillRememberedLogin(form);
  }
  updateResendButton();
  updatePasswordCodeButtons();
  const authNotice = app.querySelector?.('[data-form="auth"]')?.querySelector('[data-auth-notice]');
  if (authNotice) {
    authNotice.textContent = notice || "";
    authNotice.hidden = !notice;
    authNotice.className = `notice ${codeSent ? "success" : "error"}`;
  }
  const passwordNotice = app.querySelector?.('[data-form="password-change"]')?.querySelector('[data-password-notice]');
  if (passwordNotice) {
    passwordNotice.textContent = notice || "";
    passwordNotice.hidden = !notice;
    passwordNotice.className = `notice ${codeSent ? "success" : "error"}`;
  }
  const passwordCancel = document.querySelector('[data-action="password-cancel"]');
  if (passwordCancel) passwordCancel.disabled = busy;
  updateTransferCodeButton();
  if (page === "provisioning" && setupState.state === "awaitingWifi") {
    updateWifiPicker();
    if (!busy && !wifiPicker.scanned) void scanWifi();
  }
}

function setupErrorMessage(error) {
  const code = typeof error === "string" ? error : String(error?.code || error?.message || "");
  const messages = {
      NOTIFICATION_BOX_REQUIRED: "请先连接这条通知对应的盒子，再打开任务。",
      NOTIFICATION_NOT_FOUND: "这条通知已不可用，请刷新通知列表。",
    DEVICE_NOT_ENROLLED: "盒子尚未完成平台注册，请联系设备管理员完成初始化。",
    CLAIM_STATUS_CHECKING: "正在核对盒子归属…",
    CLAIM_STATUS_UNAVAILABLE: "暂时无法核对盒子归属，请检查网络后重新选择盒子；如仍失败，请管理员检查账号服务版本。",
    OWNER_ALREADY_CHANGED: "盒子归属已变化，请刷新设备列表并核对当前拥有者。",
    IDEMPOTENCY_CONFLICT: "认领码已用于其他认领请求，请刷新设备列表核对结果。",
    CONSOLE_CLAIM_NOT_FOUND: "认领码无效，请核对盒子控制台显示的认领码。",
    CONSOLE_CLAIM_EXPIRED: "认领码已过期，请从盒子控制台获取新的认领码。",
    CONSOLE_CLAIM_INACTIVE: "认领码已失效，请从盒子控制台重新发起。",
    CONSOLE_CLAIM_DISABLED: "平台暂未启用认领码功能，请联系管理员。",
    CONSOLE_CLAIM_RATE_LIMITED: "认领尝试过于频繁，请稍后重试。",
    CONSOLE_CLAIM_CONFLICT: "认领状态已变化，请刷新设备列表后重试。",
    DEVICE_ALREADY_OWNED: "这台盒子已属于当前账号，无需再次认领。返回盒子列表即可连接或修改 Wi-Fi。",
    DEVICE_OWNED_BY_OTHER: "这台盒子已属于其他账号，需要原主人完成转移后才能认领。",
    LEGACY_BINDING_REVIEW_REQUIRED: "这台盒子保留旧版账号绑定，请联系管理员迁移归属，或完成重置后重新交付。",
    CLAIM_HISTORY_REVIEW_REQUIRED: "这台盒子有尚待核对的交付历史，请联系管理员处理后再认领。",
    DEVICE_RESET_PENDING: "盒子正在完成重置，请等待管理员确认交付就绪后再试。",
    PAIRING_MODE_CLOSED: "盒子正在准备配网，请稍后重新选择；如持续未就绪，请管理员更新并检查盒端状态。",
    PROTOCOL_CHANGED: "盒子与客户端的配网协议未能匹配，请更新盒端和客户端后重试（PROTOCOL_CHANGED）。",
    DEVICE_IDENTITY_MISMATCH: "盒子身份校验未通过，接入已停止。请核对目标盒子。",
    LOCAL_TRANSPORT_DISCONNECTED: "蓝牙连接已断开，请靠近盒子并重新扫描。",
    LOCAL_CONNECT_TIMEOUT: "蓝牙连接盒子超时。请靠近盒子，检查电脑蓝牙后重试。",
    GATT_FRAGMENT_INCOMPLETE: "未完整收到盒子的蓝牙响应，请靠近盒子后重试。",
    PAIRING_EXPIRED: "本次安全会话已到期，请重新选择盒子开始新会话。未认领盒子会持续可用。",
    HELLO_CONTEXT_EXPIRED: "本次身份验证已到期，请重新选择盒子重试。",
    OWNER_AUTHORIZATION_SYNC_PENDING: "盒子正在同步归属状态，请稍后重新选择。",
    OWNER_REQUIRED: "只有盒子的主人可以修改 Wi-Fi，请刷新盒子列表后重试。",
    OWNER_WIFI_UNSUPPORTED: "盒端程序尚不支持修改 Wi-Fi，请更新盒端程序后重试。",
    CONTRACT_MISMATCH: "账号服务的配网响应不兼容，请联系管理员核对服务版本（CONTRACT_MISMATCH）。",
    LOCAL_SELECTION_LEASE_INVALID: "扫描结果已失效，请重新扫描并选择盒子。",
    AUTH_SESSION_CHANGED: "登录状态已变化，请重新开始配网。",
  };
  const key = Object.keys(messages).find((key) => code.includes(key));
  const diagnostic = /^[A-Z][A-Z0-9_]{1,79}$/.test(code) ? `（${code}）` : "";
  return messages[key] || `盒子接入未完成，请重试；如仍失败，请联系管理员。${diagnostic}`;
}

function connectionErrorMessage(error) {
  const code = String(error?.code || error?.message || "")
    .replace(/^Error invoking remote method 'wanx-client:connect-box': (?:Error: )?/, "");
  const messages = {
      NOTIFICATION_BOX_REQUIRED: "请先连接这条通知对应的盒子，再打开任务。",
      NOTIFICATION_NOT_FOUND: "这条通知已不可用，请刷新通知列表。",
    health_unavailable: "连接盒子失败：盒端服务暂不可达，请检查盒子网络和服务后重试。",
    health_timeout: "连接盒子超时：盒端服务未及时响应，请稍后重试。",
    health_invalid: "连接盒子失败：盒端服务健康检查未通过，请联系管理员检查服务版本与状态。",
    netbird_peer_disconnected: "连接盒子失败：盒子当前离线，请确认盒子联网后重试。",
    netbird_peer_unknown: "连接盒子失败：网络尚未发现此盒子，请刷新设备后重试。",
  };
  return Object.hasOwn(messages, code) ? `${messages[code]}（${code}）`
    : operationErrorMessage(new Error(code), "连接盒子失败，请刷新设备后重试；如仍失败，请联系管理员检查盒子网络与服务。");
}

function operationErrorMessage(error, fallback) {
  const message = typeof error === "string" ? error : String(error?.code || error?.message || "");
  const boxSessionMessages = {
    BOX_PLATFORM_AUTH_FAILED: "盒子登录验证失败，请重新连接；如仍失败，请联系管理员检查盒端登录服务。",
    BOX_PLATFORM_SESSION_EXPIRED: "盒子登录已过期，请重新连接盒子。",
    BOX_PLATFORM_TIMEOUT: "连接盒子超时，请检查盒子网络后重试。",
    BOX_PLATFORM_BUSY: "盒子正在处理其他连接，请稍后重试。",
    BOX_PLATFORM_CAPACITY: "盒子暂时无法建立更多连接，请稍后重试。",
    BOX_ZHIJUN_INITIALIZATION_FAILED: "盒子的知君服务准备失败，暂时无法完成连接，请联系管理员修复盒端服务。",
    BOX_ZHIJUN_EXPERT_CONFLICT: "盒子的知君配置存在冲突，暂时无法完成连接，请联系管理员检查。",
  };
  for (const code of ["BOX_PLATFORM_STATE_INVALID", "BOX_PLATFORM_CONFIG_INVALID", "BOX_UPSTREAM_CREDENTIALS_INVALID", "BOX_UPSTREAM_AUTH_FAILED", "BOX_UPSTREAM_ADMIN_REQUIRED", "BOX_UPSTREAM_CAPTCHA_REQUIRED", "BOX_UPSTREAM_OIDC_CONFLICT", "BOX_UPSTREAM_OIDC_INVALID", "BOX_UPSTREAM_OIDC_FAILED", "BOX_UPSTREAM_IDENTITY_INVALID", "BOX_UPSTREAM_IDENTITY_MISMATCH", "BOX_UPSTREAM_ROLE_SYNC_FAILED"])
    boxSessionMessages[code] = "盒端登录服务配置异常，暂时无法完成连接，请联系管理员检查。";
  for (const code of ["BOX_PLATFORM_UPSTREAM_INVALID", "BOX_PLATFORM_UPSTREAM_UNAVAILABLE", "BOX_PLATFORM_RESPONSE_INVALID", "PLATFORM_RESPONSE_TOO_LARGE", "BOX_UPSTREAM_UNAVAILABLE", "BOX_UPSTREAM_NOT_READY", "BOX_UPSTREAM_PROTOCOL_INVALID", "BOX_UPSTREAM_RESPONSE_TOO_LARGE"])
    boxSessionMessages[code] = "盒端服务暂不可用，请稍后重新连接；如仍失败，请联系管理员。";
  if (Object.hasOwn(boxSessionMessages, message)) return `${boxSessionMessages[message]}（${message}）`;
  const messages = {
      NOTIFICATION_BOX_REQUIRED: "请先连接这条通知对应的盒子，再打开任务。",
      NOTIFICATION_NOT_FOUND: "这条通知已不可用，请刷新通知列表。",
      OWNERSHIP_RETAIN_DATA_REQUIRED: "此功能仅转移所有权并保留数据；清空交付请使用盒子清除。",
      OWNERSHIP_TRANSFER_PENDING: "此盒子已有待处理的转移邀请，请等待客户接受或邀请过期。",
      OWNERSHIP_TRANSFER_NOT_FOUND: "未找到属于你的转移邀请，请刷新记录。",
      OWNERSHIP_TRANSFER_EXPIRED: "转移邀请已过期，请原所有者重新发起。",
      OWNERSHIP_ACCOUNT_INACTIVE: "当前账号不可接受所有权，请检查账号状态。",
      OWNERSHIP_CLIENT_INACTIVE: "当前客户端登录已失效，请重新登录记忆盒子后再接受转移。",
      OWNERSHIP_OWNER_CHANGED: "盒子所有者已变化，请刷新盒子列表。",
      OWNERSHIP_DEVICE_UPDATE_REQUIRED: "盒子交付组件需要更新，请联系管理员更新后再转移。",
      OWNERSHIP_NETWORK_REVOKE_FAILED: "旧访问权限暂未撤销，转移尚未完成，请稍后重试。",
      OWNERSHIP_DEVICE_UNAVAILABLE: "盒子当前无法进行所有权转移，请稍后刷新重试。",
      OWNERSHIP_OWNER_REQUIRED: "只有当前盒子所有者可以发起转移，请刷新盒子列表。",
      OWNERSHIP_TARGET_SELF: "客户手机号不能是你当前登录的手机号。",
      OWNERSHIP_TRANSFER_UNAVAILABLE: "转移邀请已失效或不适用于当前账号，请刷新转移记录。",
      ACCOUNT_CANCELLED: "登录状态已变化，请重新操作。",
      invalid_sms_code: "请输入 6 位短信验证码。",
      invalid_phone: "请输入有效的手机号。",
      invalid_credentials: "手机号或密码不正确，请重试。",
      account_unavailable: "暂时无法连接账号服务，请稍后重试。",
      session_expired: "登录已过期，请重新登录记忆盒子。",
      ACCOUNT_NETWORK_ERROR: "暂时无法连接账号服务，请检查网络后重试。",
      ACCOUNT_REQUEST_FAILED: "账号服务暂时不可用，请稍后重试。",
      SECURE_STORAGE_READ_FAILED: "无法读取本机保存的登录凭据。若系统提示访问旧版凭据，请允许后重试；如仍失败，请联系管理员。",
      SECURE_STORAGE_WRITE_FAILED: "无法保存本机登录凭据，请检查磁盘空间和目录权限后重试。",
      SECURE_STORAGE_UNAVAILABLE: "本机加密服务暂不可用，请解锁系统凭据存储后重试；如仍失败，请联系管理员。",
      ACCOUNT_SESSION_EXPIRED: "登录已过期，请重新登录记忆盒子。",
      ...forcedSignOutMessages,
      ACCOUNT_ACCESS_DENIED: "当前账号无权执行此操作。",
      SMS_CODE_INVALID: "验证码错误或已过期，请重新获取。",
      SMS_RATE_LIMITED: "验证码发送过于频繁，请稍后重试。",
      SMS_DAILY_LIMIT: "该手机号今日验证码发送次数已达上限，请明日再试。",
      AUTH_RATE_LIMITED: "登录失败次数过多，已被暂时限制。请稍后重试，并确认使用最新密码。",
      PASSWORD_RESET_RATE_LIMITED: "密码重置尝试过于频繁，请稍后再试。",
      PASSWORD_ALREADY_SET: "该手机号已注册，请使用密码登录。",
      PASSWORD_WEAK: "密码需为 8–72 字节，且不能包含换行符。",
      PASSWORD_INVALID: "手机号或密码不正确，请重新输入。",
      PASSWORD_NOT_SET: "该账号尚未设置密码，请先完成注册。",
      ACCOUNT_INVALID_INPUT: "请检查手机号、密码和验证码格式。",
      ACCOUNT_LOGIN_REQUIRED: "请先登录记忆盒子。",
      PROFILE_INVALID_NAME: "昵称需为 1–40 个字符，不能包含控制字符。",
      PROFILE_AVATAR_TOO_LARGE: "头像文件不能超过 5 MB。",
      PROFILE_INVALID_AVATAR: "无法读取这张图片，请选择有效的 JPG 或 PNG 图片。",
      PROFILE_INVALID_INPUT: "资料格式无效，请重试。",
      PROFILE_UNAVAILABLE: "资料功能尚未就绪，请重启记忆盒子。",
      ACCOUNT_SESSION_CHANGED: "登录状态已变化，请重新打开应用。",
      APPLICATION_OPEN_CANCELLED: "已取消打开应用。",
      APPLICATION_OPEN_BUSY: "正在打开另一个应用，请稍后再试。",
      APPLICATION_OPEN_NOT_PENDING: "本次打开已取消，请重新打开应用。",
      APPLICATION_OPERATION_FAILED: "操作未完成，请重试。",
      NETWORK_DEVICE_ACCESS_DENIED: "当前账号无权访问此盒子，请刷新盒子列表。",
      LOCAL_BOX_AUTH_FAILED: "这台电脑登录失败，请检查本机盒子的登录配置。",
      LOCAL_BOX_AUTH_TIMEOUT: "这台电脑暂未响应，请确认服务已启动后重试。",
      LOCAL_BOX_INVALID_REGISTRATION: "本机盒子的连接配置无效，请重新登记。",
      NETWORK_NOT_READY: "网络尚未连接，请在设置中检查网络状态。",
      BOX_CONNECTION_REQUIRED: "请先在盒子空间中连接一台盒子。",
      NETWORK_CHANGED: "盒子连接已变化，请重新连接后打开应用。",
      BOX_IDENTITY_UNAVAILABLE: "暂时无法访问盒端服务，请重新连接盒子。",
      BOX_IDENTITY_INVALID: "盒端服务返回了无效身份，请重新连接盒子。",
      BOX_CONNECTION_CHANGED: "盒子连接已变化，请核对当前盒子后重新打开运维工具。",
      DASHBOARD_OPEN_FAILED: "盒子控制台打开失败，请检查盒子连接后重试。",
      APPLICATION_START_CANCELED: "应用启动已取消。",
      APPLICATION_STOP_FAILED: "应用尚未完全退出，请关闭应用后重试。",
      APPLICATIONS_CLOSED: "记忆盒子正在退出，无法启动或安装应用。",
      INVALID_APPLICATION_VERSION: "安装包需使用规范版本号，例如 1.2.3。",
      APPLICATION_VERSION_DOWNGRADE: "此安装包版本低于当前版本，请选择更新的安装包。",
      APPLICATION_VERSION_SELECTION_REQUIRED: "请先在应用卡片中选择当前版本，再安装或打开应用。",
      APPLICATION_VERSION_SELECTION_INVALID: "版本选择已变化，请刷新应用列表后重试。",
      APPLICATION_CURRENT_INVALID: "当前版本记录无法读取，请检查应用安装目录。",
      APPLICATION_START_FAILED: "应用启动失败，请重新打开；若仍失败，请检查应用安装是否完整。",
      APPLICATION_START_TIMEOUT: "应用启动超时，请稍后重新打开。",
      APPLICATION_ARCHIVE_INVALID: "安装包损坏或格式不受支持，请重新下载应用 ZIP 安装包。",
      APPLICATION_ARCHIVE_TOO_LARGE: "安装包过大，请联系应用提供方。",
      APPLICATION_MANIFEST_READ_FAILED: "安装包缺少有效的应用描述文件，请联系应用提供方。",
      APPLICATION_PLATFORM_REQUIRED: "独立应用安装包需要声明适用的系统和架构。",
      APPLICATION_PLATFORM_UNSUPPORTED: "此安装包不适用于当前电脑，请下载对应系统和架构的版本。",
      APPLICATION_VERSION_ALREADY_INSTALLED: "此版本已经安装，可在应用列表中打开。",
      APPLICATION_ENTRYPOINT_NOT_FOUND: "安装包缺少启动文件，请重新下载完整安装包。",
      INVALID_APPLICATION_ENTRYPOINT: "安装包中的启动文件无效，请联系应用提供方。",
      APPLICATION_ENTRYPOINT_NOT_EXECUTABLE: "启动文件缺少执行权限，请联系应用提供方重新打包。",
      APPLICATION_INSTALL_FAILED: "应用安装失败，请检查磁盘空间和目录权限后重试。",
    };
  const code = Object.keys(messages).find(value => message.includes(value));
  return messages[code] || fallback || marketErrorMessage(error);
}

async function run(action, input = {}) {
  const isSetupOperation = action.startsWith("provisioning.");
  if (isSetupOperation && setupRequest && (action !== "provisioning.cancel" || setupRequest.action === action)) return null;
  const request = isSetupOperation ? { action, mode: input.mode } : null;
  if (request) setupRequest = request;
  if (["provisioning.start", "provisioning.cancel", "auth.logout"].includes(action)) resetWifiPicker();
  notice = null;
  if (action === "devices.connect") connectionFailure = null;
  codeSent = false;
  const actionAccount = marketAccount;
  const applicationId = input.applicationId;
  const isAppOperation = Boolean(applicationId) && (action.startsWith("market.") || action.startsWith("applications."));
  if (isAppOperation && operationBusy(applicationId)) return null;
  const holdBusy = !isAppOperation && !["applications.confirm-open", "applications.cancel-open", "desktop.about"].includes(action);
  if (isAppOperation) localOperations.set(applicationId, { phase: { "market.install": "installing", "market.uninstall": "uninstalling", "market.rollback": "rolling_back", "applications.uninstall-local": "uninstalling", "applications.rollback-local": "rolling_back", "applications.select-current": "selecting" }[action] || "opening", version: input.version });
  const operation = { action, deviceId: input.deviceId || (action === "devices.disconnect" ? currentState.activeDeviceId : undefined), tool: input.tool };
  if (holdBusy) { busy = true; busyRequest = operation; }
  render(currentState);
  let failure;
  try {
    const setupActions = {
      "provisioning.start": () => window.wanxSetup.begin(input.mode === "console" ? { ...input.candidate, mode: "console", claimCode: input.claimCode } : input.mode === "wifi" ? { ...input.candidate, mode: "wifi", ...(input.expectedDeviceId ? { expectedDeviceId: input.expectedDeviceId } : {}) } : input.candidate),
      "provisioning.confirm": () => window.wanxSetup.confirmPhysical(),
      "provisioning.wifi": () => window.wanxSetup.wifi(input),
      "provisioning.owner": () => window.wanxSetup.confirmOwnership(),
      "provisioning.refresh": () => window.wanxSetup.refresh(),
      "provisioning.cancel": () => window.wanxSetup.cancel(),
    };
    if (setupActions[action]) {
      const snapshot = await setupActions[action]();
      if (setupRequest !== request) return null;
      setupState = snapshot;
      return { ok: true };
    }
    const response = action === "provisioning.code-claim"
      ? { ok: true, value: await window.wanxSetup.redeemClaimCode(input) }
      : await window.wanxClient.action(action, input);
    if (holdBusy && busyRequest !== operation) return null;
    if (response.state) acceptRemoteState(response.state);
    if (!response.ok) throw new Error(response.code);
    return response;
  } catch (error) {
    if (request && setupRequest !== request || holdBusy && busyRequest !== operation) return null;
    if (action === "auth.send-code" && error.message.includes("SMS_RATE_LIMITED")) {
      resendAt = Date.now() + 60000;
      updateResendButton();
    }
    if (["auth.send-reset-code", "auth.send-change-code"].includes(action) && error.message.includes("SMS_RATE_LIMITED")) {
      if (action === "auth.send-reset-code") resetResendAt = Date.now() + 60000;
      else changeResendAt = Date.now() + 60000;
    }
    failure = action === "devices.connect" ? connectionErrorMessage(error) : action.startsWith("provisioning.") || action === "devices.claim" ? setupErrorMessage(error) : action.startsWith("updates.") ? updateGuidance(error.message) : operationErrorMessage(error);
    if (action === "devices.connect" && actionAccount === marketAccount) connectionFailure = { deviceId: input.deviceId, message: failure };
    if (!isAppOperation && actionAccount === marketAccount) notice = failure;
    return null;
  } finally {
    if (isAppOperation && actionAccount === marketAccount) {
      if (failure) localOperations.set(applicationId, { phase: "failed", error: failure });
      else if (action === "applications.request-open" && !currentState.ui?.pendingOpen) showOpenedStatus(applicationId);
      else localOperations.delete(applicationId);
    }
    if (holdBusy && busyRequest === operation) { busy = false; busyRequest = null; }
    if (request && setupRequest === request) setupRequest = null;
    render(currentState);
  }
}

app.addEventListener("click", async (event) => {
  const dataTarget=event.target.closest("[data-data-action]");
  if(dataTarget?.dataset.dataAction){event.preventDefault();return dataView.action(dataTarget.dataset.dataAction,dataTarget.dataset);}
  activeInteraction = false;
  finishInteraction();
  if (event.target.id === "wallet-custom-amount") return creditsView.action("credits-custom");
  const target = event.target.closest("[data-action]");
  if (!target) { if (profileMenuOpen) { profileMenuOpen = false; render(currentState); } return; }
  if (target.disabled) return;
  const action = target.dataset.action;
  if (action === "show-client-update") { page = "client-update"; render(currentState); return; }
  if (clientUpdateRequired() && ((action.startsWith("show-") && !["show-settings", "show-boxes", "show-maintenance", "show-box-version", "show-profile", "show-help"].includes(action)) ||
      ["applications-launch", "pending-confirm", "notifications-open", "market-install", "market-rollback", "store-details"].includes(action))) {
    page = "client-update"; marketConfirmation = null; render(currentState); return;
  }


  if (action === "show-help") {
    if (page === "provisioning") { if (!helpDrawer) await openHelpDrawer(target); return; }
    if (page !== "help") {
      helpReturnPage = page;
      helpReturnScroll = document.scrollingElement?.scrollTop || 0;
      helpReturnLabel = ({ boxes: "返回盒子", settings: "返回设置", "client-update": "返回升级页面" })[page] || "返回";
    }
    helpView?.open({ scene: target.dataset.scene });
    page = "help"; profileMenuOpen = false; render(currentState);
    document.scrollingElement?.scrollTo?.(0, 0);
    await helpView?.refresh(); return;
  }
  if (action === "help-back") { page = helpReturnPage; render(currentState); document.scrollingElement?.scrollTo?.(0, helpReturnScroll); return; }
  if (action.startsWith("help-")) {
    await helpView?.action(action, target.dataset);
    if (action === "help-feedback-open") { app.querySelector?.("#faq-feedback-content")?.focus(); return; }
    const button = [...(app.querySelectorAll?.("[data-action]") || [])].find(node => node.dataset.action === action && node.dataset.id === target.dataset.id);
    button?.focus({ preventScroll: true }); return;
  }
  if (action === "profile-menu" && page !== "provisioning") { profileMenuOpen = !profileMenuOpen; render(currentState); if (profileMenuOpen) app.querySelector?.('[data-action="show-profile"]')?.focus(); return; }
  if (profileMenuOpen && action !== "logout") profileMenuOpen = false;
  if (action === "notifications-filter") { notificationFilter = target.dataset.filter === "unread" ? "unread" : "all"; expandedNotificationId = null; render(currentState); return; }
  if (action === "notifications-select") { expandedNotificationId = expandedNotificationId === target.dataset.id ? null : target.dataset.id; await run("notifications.read", { id: target.dataset.id }); return; }
  if (action === "notifications-read-all") { expandedNotificationId = null; await run("notifications.read", { all: true }); return; }
  if (action === "notifications-refresh") { await run("notifications.refresh"); return; }
  if (action === "profile-avatar" || action === "profile-avatar-remove") {
    if (busy || page !== "profile") return;
    await run(action === "profile-avatar" ? "profile.avatar" : "profile.avatar-remove"); return;
  }
  if (marketConfirmation && !["market-cancel", "market-confirm"].includes(action)) return;
  if (action.startsWith("carousel-")) {
    if (action === "carousel-next") storeCarousel.select(storeCarousel.index + 1);
    else if (action === "carousel-previous") storeCarousel.select(storeCarousel.index - 1);
    else if (action === "carousel-select") storeCarousel.select(Number(target.dataset.carouselIndex));
    else if (action === "carousel-toggle") storeCarousel.toggle();
    return;
  }
  if (action === "poster-open") {
    const index = Number(target.dataset.posterIndex), media = storeApplication(selectedApplicationId) && applicationMedia(selectedApplicationId)?.posters;
    if (page !== "application-detail" || !Number.isInteger(index) || !media?.[index]) return;
    posterPreview = index; render(currentState); app.querySelector?.('[data-action="poster-close"]')?.focus?.(); return;
  }
  if (action === "poster-close") { posterPreview = null; render(currentState); app.querySelector?.('[data-action="poster-open"]')?.focus?.(); return; }
  if (action === "workshop-connect") { page="boxes"; render(currentState); return; }
  if (action?.startsWith('workshop-') || action?.startsWith('studio-product-')) { void workshop.action(action,{projectId:target.dataset.projectId,sourceId:target.dataset.sourceId,tab:target.dataset.tab,hash:target.dataset.hash,mode:target.dataset.mode}); return; }
  if (action === "applications-tab") { selectApplicationsTab(target.dataset.tab); return; }
  if(action==='expert-apps-refresh'){await refreshExpertApps();return;}
  if(action==='expert-installed-workshop'){
    if (!expertCatalogAvailable()) return;
    const scope = expertApps;
    target.disabled=true;
    try{const response=await window.wanxClient.action('expert-apps',{action:'workshop-installed',input:{applicationId:target.dataset.applicationId}});if(!response.ok)throw Error(response.userMessage||response.code);}
    catch{if (scope === expertApps) { notice='工坊演示暂时无法打开，请重试。'; render(currentState); }}
    finally{target.disabled=false;}
    return;
  }
  if(['expert-app-install','expert-app-workshop'].includes(action)){await expertAppAction(action.slice('expert-app-'.length),target.dataset.id);return;}
  if (action === "local-install") return;
  if(action === "application-library-refresh"){await refreshAppLibrary();return;}
  if(action === "application-customize"||action === "application-workshop"){const id=target.dataset.applicationId;const existing=target.dataset.projectId||appLibrary.projects.find(p=>p.workshop?.applicationId===id&&!p.deletedAt)?.id;if(!existing&&!appLibrary.items.find(a=>a.applicationId===id)?.editable)return;page="workshop";render(currentState);if(existing)await workshop.action("workshop-locate",{projectId:existing});else await workshop.action("workshop-open-source",{sourceId:"installed:"+id});return;}
  if(action === "application-workshop-install"){const r=await window.wanxClient.action("workshop",{action:"install-adopted",input:{projectId:target.dataset.projectId}});if(!r.ok)notice="安装未完成，请在工坊中重试。";await run("applications.list");await refreshAppLibrary();return;}
  if (action === "local-refresh") { await run("applications.list"); return; }
  if (["local-uninstall", "local-rollback"].includes(action)) {
    const id = target.dataset.applicationId, item = localInstalledApplications().find(row => row.applicationId === id);
    if (!item || operationBusy(id)) return;
    const rollback = action === "local-rollback", previous = typeof item.previous === "string" ? item.previous : item.previous?.version;
    if (rollback && (!previous || isManagedLocalApplication(item))) return;
    marketConfirmation = { applicationId: id, action: rollback ? "applications.rollback-local" : "applications.uninstall-local",
      title: `${rollback ? "恢复" : "卸载"}${item.name}`, verb: rollback ? "恢复" : "卸载",
      detail: rollback ? `将程序恢复到 v${previous}，业务数据保持当前状态。` : isManagedLocalApplication(item) ? "仅移除此电脑上的应用程序，保留应用业务数据和盒端服务；之后可在工坊重新部署。" : "将移除此电脑上的应用程序，保留应用业务数据。" };
    render(currentState); return;
  }
  if (action === "store-details") {
    const id = target.dataset.applicationId;
    if (page !== "applications" || !storeApplication(id)) return;
    selectedApplicationId = id; posterPreview = null;

    page = "application-detail";
    render(currentState);
    document.querySelector(".app-detail-title")?.focus?.({ preventScroll: true });
    document.scrollingElement?.scrollTo?.(0, 0);
    return;
  }
  if (action === "store-back") { selectedApplicationId = null; posterPreview = null; page = "applications"; render(currentState); document.scrollingElement?.scrollTo?.(0, 0); return; }
  if (action.startsWith("support-")) {
    if (busy || page !== "boxes") return;
    await supportView.action(action, target.dataset);
    if (action === "support-open") app.querySelector?.(".support-panel")?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    return;
  }
  if (action === "market-cancel") { marketConfirmation = null; render(currentState); return; }
  if (action === "market-confirm") {
    const confirmation = marketConfirmation;
    if (!confirmation || busy) return;
    marketConfirmation = null;
    if (confirmation.updateReleaseId && (currentState.upgrades?.client?.phase !== "downloaded" || currentState.upgrades?.client?.candidate?.releaseId !== confirmation.updateReleaseId)) { notice = "更新内容已变化，请重新检查并确认。"; render(currentState); return; }
    if (confirmation.updateDeviceId && (currentState.activeDeviceId !== confirmation.updateDeviceId || currentState.upgrades?.box?.deviceId !== confirmation.updateDeviceId || confirmation.updatePlanId && (currentState.upgrades.box.plan?.planId !== confirmation.updatePlanId || Date.parse(currentState.upgrades.box.plan.expiresAt) <= Date.now()))) { notice = "更新计划已变化，请重新检查并确认。"; render(currentState); return; }
    if (confirmation.updateDeviceId && currentState.upgrades?.box?.canUpgrade !== true) { notice = updateGuidance("UPDATE_PERMISSION_REQUIRED"); render(currentState); return; }
    if (confirmation.updateResumeOperationId && (currentState.upgrades?.box?.operation?.operationId !== confirmation.updateResumeOperationId || !currentState.upgrades.box.operation.allowedActions?.includes("resume"))) { notice = "此任务状态已变化，请刷新任务状态。"; render(currentState); return; }
    const generation = marketGeneration;
    const result = await run(confirmation.action, confirmation.input || { applicationId: confirmation.applicationId });
    if (result && generation === marketGeneration && confirmation.action === "ownership.accept") {
      transferNotice = result.value?.refreshRequired ? "所有权已接受，盒子列表暂未刷新，请点击刷新。" : "已接受所有权，请等待盒子授权同步后连接。";
      await refreshTransfers({ force: true });
    }
    if (result && confirmation.action.startsWith("market.")) await refreshMarket();
    return;
  }
  if (busy && ["auth-login", "auth-register", "auth-reset", "send-registration-code", "send-reset-code", "send-change-code", "password-open", "password-cancel"].includes(action)) return;
  if (action === "auth-login") { authMode = "login"; notice = null; codeSent = false; render(currentState); return; }
  if (action === "auth-register") { authMode = "register"; notice = null; codeSent = false; render(currentState); return; }
  if (action === "auth-reset") { authMode = "reset"; notice = null; codeSent = false; render(currentState); return; }
  if (action === "password-open" || action === "password-cancel") {
    passwordEditing = action === "password-open";
    notice = null; codeSent = false; render(currentState); return;
  }
  if (action === "send-reset-code" || action === "send-change-code") {
    const change = action === "send-change-code";
    if (change ? !passwordEditing || currentState.route === "auth" : authMode !== "reset") return;
    if (Date.now() < (change ? changeResendAt : resetResendAt)) return;
    if (!change) {
      authUsername = document.querySelector("#account-name")?.value.trim() || "";
      if (!/^1\d{10}$/.test(authUsername)) { notice = "请输入有效的 11 位手机号"; codeSent = false; render(currentState); return; }
    }
    const response = await run(change ? "auth.send-change-code" : "auth.send-reset-code", change ? {} : { username: authUsername });
    if (response) {
      if (change) changeResendAt = Date.now() + 60000;
      else resetResendAt = Date.now() + 60000;
      codeSent = true; notice = "验证码已发送，5 分钟内有效，请查收短信";
    }
    render(currentState); return;
  }
  if (action === "send-registration-code") {
    if (authMode !== "register" || resendSeconds()) return;
    const input = document.querySelector("#account-name");
    authUsername = input?.value.trim() || "";
    codeSent = false;
    if (!/^1\d{10}$/.test(authUsername)) { notice = "请输入有效的 11 位手机号"; render(currentState); return; }
    const response = await run("auth.send-code", { username: authUsername });
    if (response) {
      resendAt = Date.now() + 60000;
      codeSent = true;
      notice = "验证码已发送，5 分钟内有效，请查收短信";
      updateResendButton();
    }
    render(currentState);
    return;
  }
  if (busy && action.startsWith("transfer-")) return;
  if (action === "transfer-open") {
    transferDeviceId = target.dataset.deviceId;
    transferNotice = null;
    render(currentState);
    const form = app.querySelector('[data-form="transfer"]');
    form?.scrollIntoView({ block: "center", behavior: "instant" });
    form?.querySelector('[name="targetPhone"]')?.focus({ preventScroll: true });
    return;
  }
  if (action === "transfer-cancel") { transferDeviceId = null; render(currentState); return; }
  if (action === "transfer-refresh") { await refreshTransfers(); return; }
  if (action === "transfer-code") {
    if (Date.now() < transferResendAt) return;
    const generation = marketGeneration;
    const response = await run("ownership.send-code");
    if (response && generation === marketGeneration) { transferResendAt = Date.now() + 60000; transferNotice = "验证码已发送到你当前登录账号的手机号，60 秒后可再次发送。"; render(currentState); }
    return;
  }
  if (action === "transfer-accept") {
    const transfer = ownershipTransfers.find(item => item.transferId === target.dataset.transferId);
    if (!transfer || !transfer.retainData || transfer.direction !== "incoming") return;
    marketConfirmation = { title: "接受盒子所有权", detail: `确认接收盒子 ${transfer.deviceId} 及其保留的数据？接受后你将成为新所有者，原所有者将失去访问权限。`, verb: "接受", action: "ownership.accept", input: { transferId: transfer.transferId, retainData: true } };
    render(currentState); return;
  }
  if (action?.startsWith("credits-")) {
    await creditsView.action(action, target.dataset);
    return;
  }
  if (action === "cloud-login") { cloudAuthOpen = true; profileMenuOpen = false; render(currentState); return; }
  if (action === "local-return") { cloudAuthOpen = false; render(currentState); return; }
  if (action === "logout") { await run("auth.logout"); return; }
  if (action === "show-ai-dialogue") { openAcademyDialogue(); return; }
  if (action === "accessories-preview-retry") { accessoryPreview?.retry(); return; }
  if (["show-data", "show-memory", "show-my-ai", "show-space", "show-boxes", "show-accessories", "show-maintenance", "show-settings", "show-credits", "show-profile", "show-notifications", "show-dialogue-models"].includes(action)) {
    if (page === "provisioning") return;
    const previousPage = page;
    if (action === "show-memory") {
      memoryAgent = "";
      memoryPage = "";
    }
    page = action === "show-maintenance" ? "settings" : action.slice(5);
    if(page==='applications')applicationsTab='wanx';
    selectedApplicationId = null;
    if (page === "credits") void creditsView.refresh();
    if (page === "boxes") void refreshTransfers();
    notice = null;
    render(currentState);
    if (action === 'show-data') dataView.action('open-graph');
    if (page !== previousPage) document.scrollingElement?.scrollTo?.(0, 0);
    return;
  }
  if (action === "pending-cancel") { const pending = currentState.ui?.pendingOpen; if (pending) await run("applications.cancel-open", { intentId: pending.id }); return; }
  if (action === "pending-confirm") { const pending = currentState.ui?.pendingOpen; if (pending && pendingSelection?.deviceId && (currentState.networkReady || currentState.devices?.some(device => device.local && device.deviceId === pendingSelection.deviceId)) && !["connecting", "opening"].includes(pending.phase)) { const opened = await run("applications.confirm-open", { intentId: pending.id, deviceId: pendingSelection.deviceId }); if (opened) { showOpenedStatus(pending.applicationId); render(currentState); } } return; }
  if (action === "desktop-about") { await run("desktop.about"); return; }
  if (action === "device-trust-open") { await run("device-trust.open"); return; }
  if (busy && action !== "cancel-provisioning") return;
  if (action === "updates-client-check") { await run("updates.client.check"); return; }
  if (action === "updates-client-download") { if (currentState.upgrades?.client?.phase === "available") await run("updates.client.download"); return; }
  if (action === "updates-client-install") {
    const update = currentState.upgrades?.client;
    if (update?.phase !== "downloaded" || !update.candidate?.releaseId) return;
    marketConfirmation = { title: "重启并更新记忆盒子", detail: `将安装记忆盒子 v${update.candidate.productVersion}。记忆盒子需要退出并重启，请先保存工作并关闭正在使用的应用。`, verb: "重启并更新", action: "updates.client.install", input: { confirmed: true }, updateReleaseId: update.candidate.releaseId };
    render(currentState); return;
  }
  if (action === "show-box-version") { page = "settings"; expandedDetails.add("updates-box"); render(currentState); app.querySelector?.("#updates-heading")?.scrollIntoView?.({ block: "start" }); return; }
  if (action === "updates-box-check") { boxUpdatePollError = null; boxVersionReadError = null; if (currentState.activeDeviceId) await run("updates.box.check", { deviceId: currentState.activeDeviceId }); return; }
  if (action.startsWith("updates-box-")) {
    const update = currentState.upgrades?.box;
    const deviceId = currentState.activeDeviceId;
    if (!update || update.deviceId !== deviceId) return;
    if (action !== "updates-box-status" && update.canUpgrade !== true) return;
    if (action === "updates-box-plan") {
      const releaseId = update.candidate?.release?.payload?.releaseId;
      if (update.candidate?.status !== "available" || !releaseId) return;
      const result = await run("updates.box.plan", { deviceId, releaseId });
      if (result && currentState.activeDeviceId === deviceId) boxUpdateConfirmation("execute");
    } else if (action === "updates-box-resume") boxUpdateConfirmation("resume");
    else if (action === "updates-box-status" && update.operation?.operationId) { boxUpdatePollError = null; await run("updates.box.status", { deviceId, operationId: update.operation.operationId }); }
    else if (action === "updates-box-cancel" && update.operation?.allowedActions?.includes("cancel")) await run("updates.box.cancel", { deviceId, operationId: update.operation.operationId });
    return;
  }
  if (action === "startup-toggle") { if (currentState.desktopStartup?.supported) await run("desktop.startup.set", { enabled: !currentState.desktopStartup.enabled }); return; }
  if (action === "desktop-quit") { await run("desktop.quit"); return; }
  if (action === "maintenance-open") {
    if (currentState.canOpenDashboard && ["terminal", "desktop"].includes(target.dataset.tool)) await run("maintenance.open", { tool: target.dataset.tool, deviceId: currentState.activeDeviceId });
    return;
  }
  if (action === "market-refresh") { if (!marketLoading) await refreshMarket();await refreshAppLibrary(); return; }
  if (["market-install", "market-uninstall", "market-rollback"].includes(action)) {
    const applicationId = target.dataset.applicationId;
    const installed = (currentState.applications || []).find((item) => item.applicationId === applicationId);
    const item = storeApplication(applicationId);
    if (!item || operationBusy(applicationId)) return;
    const candidate = marketCandidates.get(applicationId);
    if (action === "market-install" && candidate?.status !== "available") return;
    if (action !== "market-install" && !installed) return;
    const previous = typeof installed?.previous === "string" ? installed.previous : installed?.previous?.version;
    if (action === "market-rollback" && !previous) return;
    const verb = action === "market-uninstall" ? "卸载" : action === "market-rollback" ? "恢复" : installed ? "更新" : "安装";
    marketConfirmation = {
      applicationId, action: action.replace("market-", "market."), verb,
      title: `${verb}${item.name || "应用"}`,
      detail: action === "market-uninstall" ? "将移除此电脑上的应用程序，保留应用业务数据。"
        : action === "market-rollback" ? `将程序恢复到 v${previous}，不会还原业务数据。请先关闭正在运行的应用。`
        : `${installed ? `将 v${installed.version} 更新至` : "将安装"} v${candidate.release?.version}。${installed ? "请先关闭正在运行的应用。" : "安装完成后，连接盒子即可打开应用。"}`,
    };
    render(currentState);
    return;
  }
  if (action === "refresh") { if (page === "provisioning") page = "boxes"; await run("devices.refresh"); if (page === "boxes") await refreshTransfers({ force: true }); return; }
  if (action === "bluetooth-refresh") { await window.wanxBluetooth?.refresh(); return; }
  if (action === "bluetooth-settings") {
    try { await window.wanxDiscovery.openBluetoothSettings(bluetoothState.status === "permission-denied" ? "privacy" : "bluetooth"); }
    catch { notice = "无法自动打开系统设置，请手动打开电脑的蓝牙设置并开启蓝牙、允许记忆盒子访问。"; render(currentState); }
    return;
  }
  if (["provisioning", "configure-network"].includes(action)) {
    const deviceId = action === "configure-network" ? target.dataset.deviceId : null;
    if (action === "configure-network" && (!deviceIsOwner(deviceId) || currentState.devices?.find(device => device.deviceId === deviceId)?.local)) return;
    resetWifiPicker();
    setupSelection = null;
    selection.reset();
    setupTargetDeviceId = deviceId;
    resetConsoleClaim();
    setupState = { state: "idle" };
    notice = null;
    page = "provisioning";
    void window.wanxBluetooth?.refresh();
    const operation = { action: "provisioning.reset" };
    busy = true; busyRequest = operation;
    render(currentState);
    try { const snapshot = await window.wanxSetup.reset(); if (busyRequest === operation) setupState = snapshot; }
    catch (error) { if (busyRequest === operation) notice = error.message; }
    finally { if (busyRequest === operation) { busy = false; busyRequest = null; render(currentState); } }
    return;
  }
  if (action === "wifi-refresh") { await scanWifi(); return; }
  if (action === "wifi-password-toggle") {
    const password = app.querySelector?.('[data-form="wifi"]')?.querySelector('[name="password"]');
    if (!password || password.disabled) return;
    const visible = password.type === "password";
    const cursor = [password.selectionStart, password.selectionEnd];
    password.type = visible ? "text" : "password";
    const label = visible ? "隐藏密码" : "显示密码";
    target.setAttribute("aria-pressed", String(visible));
    target.setAttribute("aria-label", label);
    target.setAttribute("title", label);
    const slash = target.querySelector?.('[data-password-slash]');
    if (slash) slash.toggleAttribute("hidden", !visible);
    password.focus({ preventScroll: true });
    if (cursor[0] !== null) password.setSelectionRange(...cursor);
    return;
  }
  if (["console-claim-online", "console-claim-offline", "console-claim-without-code"].includes(action)) {
    if (busy || page !== "provisioning" || setupTargetDeviceId) return;
    selection.reset(); notice = null; consoleClaimNotice = null;
    if (action === "console-claim-without-code") { resetConsoleClaim(); setupState = { state: "idle" }; }
    else consoleClaimFlow = action === "console-claim-offline" ? "entry-wifi" : "entry-online";
    render(currentState); return;
  }
  if (action === "console-claim-confirm") {
    if (busy || setupState.state !== "awaitingCodeClaim" || consoleClaimFlow !== "wifi" || !consoleClaimAttempt) return;
    await submitConsoleClaim(true); return;
  }
  if (action === "console-claim-edit") {
    if (busy || consoleClaimFlow !== "wifi" || !["terminalError", "restartRequired"].includes(setupState.state)) return;
    const result = await run("provisioning.cancel");
    if (!result) return;
    resetConsoleClaim(); consoleClaimFlow = "entry-wifi"; setupState = { state: "idle" };
    render(currentState); return;
  }
  if (action === "console-claim-refresh") {
    const receipt = consoleClaimReceipt;
    if (!receipt || busy) return;
    const result = await run("devices.claim-status", { deviceId: receipt.deviceId });
    if (consoleClaimReceipt === receipt && result?.value?.deviceId === receipt.deviceId) {
      consoleClaimReceipt = { ...receipt, authorizationState: result.value.authorizationState };
      render(currentState);
    }
    return;
  }
  if (action === "wifi-manual") {
    if (setupState.state !== "awaitingWifi") return;
    wifiPicker.manual = !wifiPicker.manual;
    if (!wifiPicker.manual && wifiPicker.selected) selectWifi(wifiKey(wifiPicker.selected));
    updateWifiPicker(); return;
  }
  if (action === "start-provisioning") {
    if (busy || !setupReady || bluetoothState.status !== "available" || discoveryView.selecting) return;
    setupSelection = null;
    resetWifiPicker(); resetDiscoveryMetadata(); selection.start(); return;
  }
  if (["select-candidate", "select-candidate-wifi"].includes(action)) {
    if (bluetoothState.status !== "available") return;
    const candidate = discoveryView.candidates.find(item => item.candidateId === target.dataset.candidateId);
    if (!candidate) return;
    const deviceId = discoveryDeviceId(candidate);
    const owner = deviceIsOwner(deviceId);
    if (setupTargetDeviceId) {
      if (!deviceIsOwner(setupTargetDeviceId) || deviceId && deviceId !== setupTargetDeviceId) return;
      setupSelection = { mode: "wifi", deviceId: setupTargetDeviceId, expectedDeviceId: setupTargetDeviceId };
    } else {
      if (action === "select-candidate-wifi" && !owner) return;
      if (consoleClaimFlow === "wifi" && owner) { notice = "此盒子已认领，请从盒子卡片的“配置网络”入口修改 Wi-Fi。"; render(currentState); return; }
      setupSelection = { mode: consoleClaimFlow === "wifi" ? "console" : owner ? "wifi" : "claim", deviceId };
    }
    selection.choose(candidate.candidateId);
    return;
  }
  if (action === "provisioning-confirm") { await run("provisioning.confirm"); return; }
  if (action === "provisioning-refresh") { await run("provisioning.refresh"); return; }
  if (action === "provisioning-owner") { await run("provisioning.owner"); return; }
  if (action === "cancel-provisioning") { selection.reset(); await run("provisioning.cancel"); if (consoleClaimFlow === "wifi") { resetConsoleClaim(); setupState = { state: "idle" }; render(currentState); } return; }
  if (action === "connect") {
    const device = currentState.devices?.find((item) => item.deviceId === target.dataset.deviceId);
    if (!device || (!device.local && !currentState.networkReady) || !deviceCanConnect(device)) return;
    if (currentState.activeDeviceId && currentState.activeDeviceId !== device.deviceId) {
      marketConfirmation = { action: "devices.connect", input: { deviceId: device.deviceId }, title: `切换到 ${device.name || device.displayName || "此盒子"}`, detail: "当前应用与原盒子的连接将失效。切换后，请重新打开应用。", verb: "切换" };
      render(currentState);
    } else await run("devices.connect", { deviceId: device.deviceId });
    return;
  }
  if (action === "disconnect") {
    marketConfirmation = { action: "devices.disconnect", input: {}, title: "断开当前盒子", detail: "当前应用与盒子的连接将失效。重新连接后，请再次打开应用。", verb: "断开" };
    render(currentState); return;
  }
  if (action === "back-devices") {
    const claimed = Boolean(consoleClaimReceipt);
    void window.wanxSetup.reset().catch(() => {});
    resetConsoleClaim(); resetWifiPicker(); page = "boxes"; selection.reset(); setupTargetDeviceId = null; notice = null; render(currentState);
    if (claimed) await run("devices.refresh");
    return;
  }
  if (action === "applications-select-current") {
    await run("applications.select-current", { applicationId: target.dataset.applicationId, version: target.dataset.version });
    return;
  }
  if (action === "applications-launch") {
    await run("applications.request-open", { applicationId: target.dataset.applicationId });
    return;
  }
});

function selectWifi(key) {
  const network = wifiPicker.networks.find(item => wifiKey(item) === key) || (wifiPicker.selected && wifiKey(wifiPicker.selected) === key ? wifiPicker.selected : null);
  if (network?.security === "unsupported") return;
  const form = app.querySelector?.('[data-form="wifi"]');
  if (!form) return;
  if (!wifiPicker.selected || wifiKey(wifiPicker.selected) !== key) { const password = form.querySelector('[name="password"]'); if (password) password.value = ""; }
  wifiPicker.selected = network;
  if (!network) { const ssid = form.querySelector('[name="ssid"]'); if (ssid) ssid.value = ""; updateWifiPicker(); return; }
  const ssid = form.querySelector('[name="ssid"]'); if (ssid) ssid.value = network.ssid;
  const security = form.querySelector('[name="security"]'); if (security) security.value = network.security;
  const hidden = form.querySelector('[name="hidden"]'); if (hidden) hidden.checked = false;
  updateWifiPicker();
}
app.addEventListener("compositionstart", event => {
  if (page === "settings" && event.target.dataset?.redactionField) redactionRuleComposition = event.target;
  if(page === "data") dataView.compositionStart?.(event.target);
});
app.addEventListener("compositionend", event => {
  if (redactionRuleComposition === event.target) {
    redactionRuleComposition = null;
    setTimeout(() => { if (currentState && page === "settings") render(currentState); }, 0);
    return;
  }
  const result=dataView.compositionEnd?.(event.target);
  if(!result)return;
  dataView.input(result.name,result.value);
  // The final input event follows compositionend; let it finish before rendering.
  setTimeout(()=>{if(currentState && page === "data")render(currentState);},0);
});
app.addEventListener("focusin", event => {
  if (!restoringWalletFocus && event.target.id === "wallet-custom-amount") void creditsView.action("credits-custom");
});
app.addEventListener("input", event => {
  if (event.target.closest?.('[data-form="help-feedback"]')) { helpView?.input(event.target.name, event.target.value); return; }
  const workshopField=event.target?.dataset?.workshopField;
  if(workshopField){workshop.field(workshopField,event.target.value);return;}
  if (["username", "password"].includes(event.target.name)) {
    const form = app.querySelector('[data-form="auth"]');
    if (form?.dataset.mode === "login") {
      form.dataset.edited = "true";
      form.dataset.savedLoginRequest = String(Number(form.dataset.savedLoginRequest || 0) + 1);
      if (event.target.name === "username") {
        authUsername = event.target.value;
        if (form.dataset.savedLoginPhone && form.dataset.savedLoginPhone !== authUsername) {
          form.elements.password.value = "";
          form.elements.savedLogin.value = "";
          delete form.dataset.savedLoginPhone;
        }
      }
    }
  }
  if(event.target.closest?.("[data-data-form]")?.dataset.dataForm)dataView.input(event.target.name,event.target.value);
  if (event.target.id === "wallet-custom-amount") void creditsView.action("credits-custom-change", { amount: event.target.value, value: event.target.value });
});
app.addEventListener("change", async (event) => {
  const productField=event.target?.dataset?.studioProductField;
  if(productField&&page==='workshop'){workshop.productField(productField,event.target.value);return;}
  if (event.target.name === "savedLogin" && !authBusy()) {
    await selectSavedLogin(app.querySelector('[data-form="auth"]'), event.target.value);
    return;
  }
  if (event.target.name === "remember" && !event.target.checked && !busy) {
    const form = app.querySelector('[data-form="auth"]');
    form.dataset.savedLoginRequest = String(Number(form.dataset.savedLoginRequest || 0) + 1);
    const phone = form.elements.username.value.trim();
    if (/^1[0-9]{10}$/.test(phone)) {
      await run("auth.forget-login", { phone });
      if (app.querySelector('[data-form="auth"]') === form) {
        try { showSavedLogins(form, (await window.wanxClient.listRememberedLogins()).items); }
        catch (error) { notice = operationErrorMessage(error); syncFormState(); }
      }
    }
    return;
  }
  if (event.target.dataset.input === "wifi-network") selectWifi(event.target.value);
  if (event.target.name === "security") updateWifiPicker();
  if (event.target.dataset.input === "pending-device" && pendingSelection) { pendingSelection.deviceId = event.target.value; render(currentState); }
});
app.addEventListener("toggle", (event) => {
  const id = event.target.dataset?.detailId;
  if (id) { if (event.target.open) expandedDetails.add(id); else expandedDetails.delete(id); }
}, true);

app.addEventListener("keydown", (event) => {
  const dataTarget=event.target?.closest?.("svg [data-data-action]");
  if(dataTarget?.dataset.dataAction&&["Enter"," "].includes(event.key)){event.preventDefault();void dataView.action(dataTarget.dataset.dataAction,dataTarget.dataset);return;}

  if (posterPreview !== null && ["Escape", "Tab"].includes(event.key)) { event.preventDefault(); if(event.key === "Escape") {posterPreview = null; render(currentState);} app.querySelector?.(event.key === "Escape" ? '[data-action="poster-open"]' : '[data-action="poster-close"]')?.focus?.(); return; }
  const walletDialog = app.querySelector?.('.wallet-purchase-dialog');
  if (walletDialog && event.key === 'Escape') { event.preventDefault(); releaseInteraction(); void creditsView.action('credits-dismiss'); return; }
  if (walletDialog && event.key === 'Tab') {
    const buttons = Array.from(walletDialog.querySelectorAll('button:not(:disabled), input:not(:disabled)'));
    if (buttons.length) {
      event.preventDefault();
      const index = buttons.indexOf(document.activeElement);
      const next = index < 0 ? (event.shiftKey ? buttons.length - 1 : 0) : (index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
      buttons[next].focus();
    }
    return;
  }
  if (event.key === " " && event.target?.closest?.("button")) { clearTimeout(interactionTimer); activeInteraction = true; }
  if (profileMenuOpen && event.key === "Escape") { profileMenuOpen = false; render(currentState); app.querySelector?.('[data-action="profile-menu"]')?.focus(); return; }
  if (!marketConfirmation) return;
  if (event.key === "Escape") { marketConfirmation = null; render(currentState); }
  if (event.key === "Tab") {
    const buttons = app.querySelectorAll?.('.market-confirm-card button');
    if (buttons?.length) {
      event.preventDefault();
      const first = buttons[0], last = buttons[buttons.length - 1];
      (document.activeElement === first ? last : first).focus();
    }
  }
});

function validateNewPassword(data) {
  if (!data.password) return "请输入新密码";
  const length = new TextEncoder().encode(data.password || "").length;
  if (length < 8 || length > 72 || /[\r\n\0]/.test(data.password)) return "密码需为 8–72 字节，且不能包含换行符。";
  if (!data.confirmPassword) return "请再次输入新密码";
  if (data.password !== data.confirmPassword) return "两次输入的密码不一致";
  if (!/^\d{6}$/.test(data.code || "")) return "请输入 6 位短信验证码";
  return null;
}

async function submitConsoleClaim(scanned) {
  const attempt = consoleClaimAttempt;
  const generation = marketGeneration;
  const result = await run(scanned ? "provisioning.code-claim" : "devices.claim", attempt);
  if (!result || generation !== marketGeneration || consoleClaimAttempt !== attempt) return;
  const receipt = result.value;
  if (!receipt?.deviceId || receipt.ownership !== "claimed") {
    notice = "暂未获得绑定确认，请重试。";
    render(currentState); return;
  }
  app.querySelector?.('[data-form="console-claim"]')?.reset();
  consoleClaimAttempt = null;
  consoleClaimReceipt = { deviceId: receipt.deviceId, authorizationState: receipt.authorizationState || "deviceAckPending" };
  consoleClaimFlow = "receipt";
  render(currentState);
}

app.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (event.target.dataset.form === "help-feedback") {
    event.preventDefault(); await helpView?.action("help-feedback-submit", Object.fromEntries(new FormData(event.target))); return;
  }
  if (event.target.dataset.form === "help-search") {
    helpView?.action("help-search", { query: new FormData(event.target).get("query") }); return;
  }
  if(event.target.dataset.dataForm){if(dataView.isComposing?.())return;return dataView.submit(event.target.dataset.dataForm,new FormData(event.target));}
  if (busy) return;
  if (event.target.dataset.form === "profile") {
    const data = Object.fromEntries(new FormData(event.target));
    const result = await run("profile.save", { displayName: String(data.displayName || "").trim() });
    if (result) { notice = "资料已保存在这台电脑。"; codeSent = true; render(currentState); }
    return;
  }
  if (event.target.dataset.form === "console-claim") {
    if (!["entry-online", "entry-wifi"].includes(consoleClaimFlow)) return;
    consoleClaimNotice = null;
    const data = Object.fromEntries(new FormData(event.target));
    const claimCode = String(data.claimCode || "").trim().toUpperCase();
    if (!/^(?:[A-Z2-7]{10}|[A-Z2-7]{20})$/.test(claimCode)) {
      consoleClaimNotice = "请输入 10 或 20 位有效认领码。"; render(currentState); return;
    }
    if (consoleClaimAttempt?.claimCode !== claimCode)
      consoleClaimAttempt = { claimCode, clientAttemptId: crypto.randomUUID() };
    if (consoleClaimFlow === "entry-wifi") {
      app.querySelector?.('[data-form="console-claim"]')?.reset();
      consoleClaimFlow = "wifi";
      setupState = { state: "idle" };
      notice = null;
      render(currentState);
    } else await submitConsoleClaim(false);
    return;
  }
  if (event.target.dataset.form === "transfer") {
    event.preventDefault();
    const generation = marketGeneration;
    const data = Object.fromEntries(new FormData(event.target));
    const result = await run("ownership.create", { deviceId: transferDeviceId, targetPhone: String(data.targetPhone || "").trim(), verificationCode: String(data.verificationCode || "").trim(), retainData: data.retainData === "on" });
    if (result && generation === marketGeneration) {
      transferDeviceId = null;
      transferNotice = result.value?.refreshRequired ? "邀请已发送，列表暂未刷新；请客户登录记忆盒子接受。" : "邀请已发送，24 小时内请客户登录记忆盒子，在“我的盒子”中接受转移。";
      await refreshTransfers({ force: true });
    }
    return;
  }
  if (event.target.dataset.form === "wifi") {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));
    if (!wifiPicker.manual && !wifiPicker.selected) return;
    await run("provisioning.wifi", {
      ssid: data.ssid,
      security: data.security,
      hidden: data.hidden === "on",
      ...(data.security === "open" ? {} : { password: data.password }),
    });
    return;
  }
  if (event.target.dataset.form === "password-change") {
    const data = Object.fromEntries(new FormData(event.target));
    codeSent = false;
    notice = validateNewPassword(data);
    if (notice) { render(currentState); return; }
    await run("auth.change-password", { password: data.password, code: data.code });
    return;
  }
  if (event.target.dataset.form !== "auth") return;
  if (authBusy()) return;
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  authUsername = String(data.username || "").trim();
  codeSent = false;
  if (!/^1\d{10}$/.test(authUsername)) notice = "请输入有效的 11 位手机号";
  else if (authMode === "login" && !data.password) notice = "请输入密码";
  else if (authMode !== "login" && validateNewPassword(data)) notice = validateNewPassword(data);
  else {
    const reset = authMode === "reset";
    const result = await run(reset ? "auth.reset-password" : authMode === "register" ? "auth.register" : "auth.login", { username: authUsername, password: data.password, ...(authMode !== "login" ? { code: data.code } : { remember: data.remember === "on" }) });
    if (reset && result) { authMode = "login"; codeSent = true; notice = "密码重置成功，请使用新密码登录。"; render(currentState); }
    return;
  }
  render(currentState);
});

function acceptRemoteState(state) {
  const noteWasOpen = noteSidebar?.isOpen?.();
  noteSidebar?.hostState?.(state);
  if (noteWasOpen && !noteSidebar.isOpen()) academyDrawer?.close?.({ restoreFocus: false });
  window.wanxSpace?.hostState(state);
  const cloudAuthenticated = state.dataIdentity?.profileId ? state.account?.phase === "authenticated" : state.route !== "auth";
  const creditsIdentity = cloudAuthenticated ? JSON.stringify([state.account.accountId, state.account.clientId]) : null;
  const creditsChanged = creditsView.reset(creditsIdentity);
  const account = cloudAuthenticated ? state.account.accountId || "authenticated" : null;
  const accountChanged = account !== marketAccount || state.account?.clientId !== currentState?.account?.clientId;
  const localIdentityChanged = state.dataIdentity?.profileId !== currentState?.dataIdentity?.profileId ||
    state.dataIdentity?.generation !== currentState?.dataIdentity?.generation ||
    state.dataIdentity?.phase !== currentState?.dataIdentity?.phase;
  if (state.route === "auth" || accountChanged || localIdentityChanged) {
    window.wanxMemory?.reset();
    if (page !== "help" && page !== "provisioning") page = homePage;
  }
  if (accountChanged || state.activeDeviceId === connectionFailure?.deviceId) connectionFailure = null;
  if (marketConfirmation?.updateReleaseId && (state.upgrades?.client?.phase !== "downloaded" || state.upgrades?.client?.candidate?.releaseId !== marketConfirmation.updateReleaseId)) marketConfirmation = null;
  if (marketConfirmation?.updateDeviceId && (accountChanged || state.activeDeviceId !== marketConfirmation.updateDeviceId || state.upgrades?.box?.deviceId !== marketConfirmation.updateDeviceId || marketConfirmation.updatePlanId && state.upgrades.box.plan?.planId !== marketConfirmation.updatePlanId)) marketConfirmation = null;
  if (marketConfirmation?.updateDeviceId && state.upgrades?.box?.canUpgrade !== true) marketConfirmation = null;
  if (marketConfirmation?.updateResumeOperationId && (state.upgrades?.box?.operation?.operationId !== marketConfirmation.updateResumeOperationId || !state.upgrades.box.operation.allowedActions?.includes("resume"))) marketConfirmation = null;
  if (accountChanged) {
    selectedApplicationId = null;

    profileMenuOpen = false;
    expandedNotificationId = null;
    notificationFilter = "all";
    notice = null;
    resetDiscoveryMetadata();
    setupSelection = null;
    const passwordChanged = state.account?.reason === "password_reset" && busyRequest?.action === "auth.change-password";
    releaseInteraction(); busy = false; busyRequest = null;
    passwordEditing = false; changeResendAt = 0;
    clearTimeout(resendTimer); resendAt = 0; codeSent = false;
    if (passwordChanged) {
      authMode = "login"; codeSent = true;
      notice = "密码修改成功，请使用新密码重新登录。";
    }
  }
  const forcedSignOut = state.account?.phase === "signed_out" && Object.hasOwn(forcedSignOutMessages, state.account.reason)
    ? forcedSignOutMessages[state.account.reason] : null;
  const previousForcedSignOut = Object.hasOwn(forcedSignOutMessages, currentState?.account?.reason);
  if (forcedSignOut) {
    if (state.account.reason !== currentState?.account?.reason) {
      cloudAuthOpen = true;
      authMode = "login";
    }
    codeSent = false;
    notice = forcedSignOut;
  } else if (previousForcedSignOut) notice = null;
  if (helpDrawer && (accountChanged || state.route === "auth" || forcedSignOut)) closeHelpDrawer(false);
  // Page selection belongs to the UI; network polling only updates its data.
  // Do not discard in-progress Wi-Fi input or the selected BLE device.
  if (page === "provisioning" && state.route !== "auth" && !accountChanged) {
    currentState = state;
    // The account directory can arrive after Bluetooth discovery. Refresh names
    // while choosing a box, but leave the active setup flow and its inputs alone.
    if (setupState.state === "idle" && (discoveryView.selecting || discoveryView.retained)) render(state);
    return;
  }
  if (state.route === "auth" || accountChanged) {
    resetWifiPicker();
    if (page !== "help") page = homePage;
    transferRequest = null;
    ++ownershipRevision;
    if (setupRequest) { setupRequest = null; busy = false; }
    resetConsoleClaim();
    ownershipTransfers = []; transferDeviceId = null; transferNotice = null; transferResendAt = 0;
    selection.reset();
    posterPreview = null;
    applicationsTab = "wanx";
    marketItems = [];
    marketCatalogState = null;
    marketCandidates = new Map();
    marketConfirmation = null;
    localOperations.clear();
    pendingSelection = null;
    expandedDetails.clear();
    selectedApplicationId = null;
    marketError = null;
    marketLoading = false;
    marketAccount = account;
    marketGeneration++;
    setupState = { state: "idle" };
    setupTargetDeviceId = null;
  }
  render(state);
  if (creditsChanged && creditsIdentity) void creditsView.refresh();
}
window.wanxBluetooth?.subscribe(state => {
  bluetoothState = state;
  if (state.status === "unavailable" && discoveryView.selecting) selection.reset();
  if (page === "provisioning" && currentState) render(currentState);
});
window.wanxClient.onLocalState(acceptRemoteState);
window.wanxClient.onAIDialogue?.(value => {
  if (value?.type === "handoff") openAcademyDialogue(value);
  else aiDialogueView?.event(value);
});
window.wanxClient.onNavigate?.((destination) => {
  if (destination === "ai-dialogue") { openAcademyDialogue(); return; }
  if (!currentState || currentState.route === "auth" || page === "provisioning") return;
  if (![homePage, "memory", "data", "space", "boxes", "accessories", "settings", "credits", "profile", "notifications"].includes(destination)) return;
  profileMenuOpen = false;
  if (destination === "memory") {
    memoryAgent = "";
    memoryPage = "";
  }
  page = destination;
  if (page === "credits") void creditsView.refresh();
  if (page === "boxes") void refreshTransfers();
  notice = null;
  render(currentState);
});
window.wanxSetup?.subscribe((snapshot) => {
  if ((snapshot.pairingSessionId && wifiPicker.sessionId && snapshot.pairingSessionId !== wifiPicker.sessionId) ||
      (snapshot.sessionRenewed && !setupState.sessionRenewed)) resetWifiPicker();
  if (snapshot.pairingSessionId) wifiPicker.sessionId = snapshot.pairingSessionId;
  if (["cancelled", "completed", "terminalError", "restartRequired", "idle"].includes(snapshot.state)) resetWifiPicker();
  setupState = snapshot;
  if (page === "provisioning") render(currentState);
});
window.wanxSetup?.state().then((snapshot) => {
  setupState = snapshot;
  if (page === "provisioning") render(currentState);
}).catch(() => {});
window.wanxSetup?.onReady?.(() => {
  setupReady = true;
  if (currentState) render(currentState);
  window.wanxSetup.resume?.().catch(() => {}).then(() => window.wanxSetup.state()).then((snapshot) => {
    setupState = snapshot;
    if (page === "provisioning") render(currentState);
  }).catch(() => {});
});
window.wanxSpace?.bind({ compactActions: true, notesInAssistant: true, render: () => { if (currentState && ["space", "boxes"].includes(page)) render(currentState); } });
noteSidebar?.bindSidebar?.(requestNoteSidebar, academyDrawer?.noteHost?.());
window.wanxClient.getLocalState().then(acceptRemoteState);

app.addEventListener("error", event => {
  const image = event.target;
  if (image?.tagName !== "IMG" || !image.classList?.contains("application-icon")) return;
  const fallback = image.dataset.fallbackSrc;
  if (fallback) { delete image.dataset.fallbackSrc; image.src = fallback; }
}, true);

window.addEventListener?.("focus",()=>{if(page==="data")void dataView.refresh()});




// This event reads main-process cache only; it never forces an HTTP request.
window.wanxClient.onFaqUpdated?.(() => { void helpView?.refresh(); });
