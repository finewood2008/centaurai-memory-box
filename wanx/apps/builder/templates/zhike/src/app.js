import config from "./config.json";

const labels = {
  conversation: "对话",
  contacts: "客户",
  records: "沟通记录",
  opportunities: "商机",
  assistant: "AI 助手",
  settings: "设置",
};
const statusLabel = {
  pending: "待确认",
  saved: "已保存",
  recorded: "已记录",
  queried: "查询完成",
  drafted: "草稿已保存",
  resolved: "已处理",
  received: "已接收",
};
const errorLabels = {
  HOST_SESSION_EXPIRED: "连接已失效，请从万象重新打开。",
  CAPABILITY_DENIED: "当前版本没有此能力授权。",
  METHOD_NOT_ALLOWED: "当前运行层尚不支持此操作，请更新万象。",
  WORKSHOP_UPDATE_REQUIRED: "请更新万象客户端后使用工坊。",
  AUTHORIZATION_CANCELLED: "已取消授权，原有数据不变。",
};
const el = (tag, text, cls) => {
  const n = document.createElement(tag);
  if (text != null) n.textContent = text;
  if (cls) n.className = cls;
  return n;
};
const themes = [
  { id: "cloud", name: "云白", detail: "清透留白 · 日常工作", tone: "浅色" },
  { id: "ocean", name: "深海", detail: "深色侧栏 · 清晰专注", tone: "双色" },
  { id: "graphite", name: "石墨", detail: "柔和暗面 · 低光环境", tone: "深色" },
  { id: "paper", name: "暖纸", detail: "横向导航 · 纸感排版", tone: "暖色" },
];
const iconPaths = {
  conversation: "M4 4h16v12H9l-5 4V4Zm4 5h8m-8 3h5",
  channels: "M8 12h8M8 8H6a4 4 0 0 0 0 8h2m8-8h2a4 4 0 0 1 0 8h-2",
  contacts: "M8 19v-2a4 4 0 0 1 4-4h1a4 4 0 0 1 4 4v2M12.5 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6M5 8v11h15V5H8",
  records: "M4 4h16v12H9l-5 4V4Zm4 5h8m-8 3h5",
  opportunities: "M4 7h16v13H4V7Zm5 0V4h6v3M4 12h16m-10 0v3h4v-3",
  assistant: "m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4L12 3Z",
  settings: "M4 7h5m4 0h7M4 17h9m4 0h3M9 4v6m4 4v6",
  refresh: "M19 8a8 8 0 1 0 1 7m-1-7V3m0 5h-5",
  plus: "M12 5v14M5 12h14",
  search: "m16 16 4 4M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13Z",
  arrow: "m9 5 7 7-7 7",
  close: "m6 6 12 12M6 18 18 6",
  check: "m5 12 4 4L19 6",
  palette: "M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1-3.7c-1.2-.7-.7-2.3.7-2.3H17a4 4 0 0 0 4-4c0-4.4-4-8-9-8ZM7 10h.01M10 7h.01M15 7h.01M18 10h.01",
};
function icon(name) {
  const n = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  n.setAttribute("viewBox", "0 0 24 24"); n.setAttribute("fill", "none");
  n.setAttribute("stroke", "currentColor"); n.setAttribute("stroke-width", "1.65");
  n.setAttribute("stroke-linecap", "round"); n.setAttribute("stroke-linejoin", "round");
  n.setAttribute("aria-hidden", "true"); n.classList.add("icon");
  const path = document.createElementNS(n.namespaceURI, "path");
  path.setAttribute("d", iconPaths[name] || iconPaths.arrow); n.append(path); return n;
}
function logo() {
  const n = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  n.setAttribute("viewBox", "0 0 48 48"); n.setAttribute("role", "img");
  n.setAttribute("aria-label", "知客 Logo"); n.classList.add("brand-mark");
  for (const [tag, attributes] of [
    ["rect", { x: "1", y: "1", width: "46", height: "46", rx: "13", fill: "currentColor" }],
    ["path", { d: "M13 12h16l7 7v13H22l-9 6V12Z", fill: "#fff" }],
    ["path", { d: "M29 12v7h7Z", fill: "currentColor", opacity: ".28" }],
    ["path", { d: "M20 22h9M20 27h6", fill: "none", stroke: "currentColor", "stroke-width": "2.5", "stroke-linecap": "round" }],
  ]) { const p = document.createElementNS(n.namespaceURI, tag); for (const [k, v] of Object.entries(attributes)) p.setAttribute(k, v); n.append(p); }
  return n;
}
const time = (v) =>
  v
    ? new Date(v).toLocaleString("zh-CN", {
        timeZone: "Asia/Singapore",
        hour12: false,
      })
    : "时间未知";
export async function mount(root, api) {
  let live = true,
    epoch = 0,
    view = "conversation",
    state = {},
    customers = [],
    records = [],
    opportunities = [],
    pending = [],
    businessPending = [],
    page = 1,
    total = 0,
    query = "",
    draftText = "",
    selectedCustomer = "",
    assistantRequest = "",
    selectedRecord = "",
    selectedEvidence = [],
    spaceFolder = "",
    selectedJob = "",
    busy = false,
    featurePreferences = {},
    featureRevision = 0,
    featuresLoaded = false;
  let conversation = {}, conversationRows = [], conversationTotal = 0, channelRows = [], channelError = "", arrivals = [],
    chatText = "", chatVoice = "", chatRequest = null, chatSending = false, chatReceipt = "", pollTimer, unsubscribe;
  root.className = "zhike";
  const rail = el("aside", null, "rail"),
    main = el("section", null, "main"),
    brand = el("div", null, "brand");
  const brandText = el("div", null, "brand-text");
  brandText.append(el("b", config.name), el("small", config.subtitle));
  brand.append(logo(), brandText);
  rail.append(brand);
  const nav = el("nav");
  nav.setAttribute("aria-label", "主导航");
  rail.append(nav);
  const connection = el("small", "正在检查连接…", "connection");
  connection.setAttribute("role", "status");
  const railFooter = el("div", null, "rail-footer");
  railFooter.append(connection, el("small", "Powered by WanX", "powered"));
  rail.append(railFooter);
  const top = el("header"),
    title = el("h1", "客户"),
    topActions = el("div", null, "actions"),
    content = el("div", null, "content"),
    notice = el("div", null, "notice");
  notice.hidden = true;
  const heading = el("div", null, "page-heading");
  heading.append(el("small", "个人工作空间", "eyebrow"), title);
  top.append(heading, topActions);
  main.append(top, notice, content);
  root.replaceChildren(rail, main);
  const buttons = {};
  function featureEnabled(id) {
    if (id !== "assistant") return featureModules().some(m => m.id === id);
    return Object.hasOwn(featurePreferences.enabled || {}, id) ? featurePreferences.enabled[id] === true : config.featurePack?.modules?.some(m => m.id === id && m.defaultEnabled === true) || false;
  }
  function updateNavigation() {
    const entries = [];
    for (const [key, label] of Object.entries(labels)) {
      if (key === "assistant" && !featureEnabled("assistant")) continue;
      if (!buttons[key]) { buttons[key] = button(label, () => navigate(key), "nav-button"); buttons[key].prepend(icon(key)); }
      entries.push(buttons[key]);
    }
    nav.replaceChildren(...entries);
  }
  updateNavigation();
  async function loadFeatures() {
    const saved = await data("get", { collection:"flow_settings", id:"advanced_features" });
    const preference = saved ? JSON.parse(saved.value) : {};
    if (!preference || typeof preference !== "object" || Array.isArray(preference) || preference.enabled != null && (typeof preference.enabled !== "object" || Array.isArray(preference.enabled))) throw Error("模块偏好格式无效");
    featurePreferences = preference; featureRevision = saved?._revision || 0; featuresLoaded = true;
  }
  async function setFeature(id, enabled) {
    if (!featureModules().some(m => m.id === id)) throw Error("未声明的功能模块");
    if (!featuresLoaded) await loadFeatures();
    const next = { ...featurePreferences, enabled:{ ...featurePreferences.enabled, [id]:enabled } };
    let saved;
    try { saved = await data("put", { collection:"flow_settings", id:"advanced_features", expectedRevision:featureRevision, value:{name:"advanced_features",value:JSON.stringify(next)} }); }
    catch (e) { featuresLoaded = false; throw e; }
    featureRevision = saved._revision; featurePreferences = next;
    if (!enabled && id === "knowledge") selectedEvidence = [];
    if (!enabled && id === "assistant" && view === "assistant") view = "contacts";
    await refresh();
  }
  function featureModules() { return (config.featurePack?.modules || []).filter(m => ["assistant","knowledge","files","schedules"].includes(m.id)); }

  topActions.append(
    button("刷新", () => refresh()),
    button("外观", appearanceSettings),
  );
  let appearanceRevision = 0, appearanceValue = {}, appearanceLoaded = false;
  const defaultTheme = themes.some((t) => t.id === config.appearance?.theme) ? config.appearance.theme : "cloud";
  function applyTheme(id) {
    root.dataset.theme = themes.some((t) => t.id === id) ? id : defaultTheme;
  }
  applyTheme(defaultTheme);
  async function loadAppearance() {
    const saved = await data("get", { collection: "flow_settings", id: "appearance" });
    const preference = saved ? JSON.parse(saved.value) : {};
    if (!preference || typeof preference !== "object" || Array.isArray(preference)) throw Error("外观偏好格式无效");
    appearanceRevision = saved?._revision || 0;
    appearanceValue = preference;
    applyTheme(preference.theme);
    appearanceLoaded = true;
  }
  async function appearanceSettings() {
    if (!appearanceLoaded) await loadAppearance();
    const d = dialog("外观"), intro = el("p", "四套完整界面，选择适合自己的工作方式。", "muted"), grid = el("div", null, "theme-grid");
    d.classList.add("appearance-dialog");
    const choices = [];
    for (const theme of themes) {
      const b = button("", async () => {
        if (root.dataset.theme === theme.id) return;
        const result = await data("put", { collection: "flow_settings", id: "appearance", expectedRevision: appearanceRevision, value: { name: "appearance", value: JSON.stringify({ ...appearanceValue, theme: theme.id }) } });
        appearanceRevision = result._revision;
        appearanceValue = { ...appearanceValue, theme: theme.id };
        applyTheme(theme.id);
        for (const option of choices) option.setAttribute("aria-pressed", String(option.dataset.themeChoice === theme.id));
      }, "theme-card");
      b.dataset.themeChoice = theme.id;
      b.setAttribute("aria-label", theme.name + "界面");
      b.setAttribute("aria-pressed", String(root.dataset.theme === theme.id));
      const preview = el("span", null, "theme-preview");
      preview.dataset.swatch = theme.id;
      preview.setAttribute("aria-hidden", "true");
      const miniRail = el("span", null, "mini-rail"), miniPage = el("span", null, "mini-page");
      miniRail.append(el("i"), el("i"), el("i"));
      miniPage.append(el("i", null, "mini-title"), el("i"), el("i"), el("i"));
      preview.append(miniRail, miniPage);
      const caption = el("span", null, "theme-caption");
      caption.append(el("strong", theme.name), el("small", theme.tone), icon("check"));
      b.append(preview, caption, el("span", theme.detail, "theme-description"));
      choices.push(b); grid.append(b);
    }
    d.append(intro, grid, el("p", "外观会在当前应用中保留。", "muted"));
  }
  function say(text) {
    const clean = String(text || "").replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
    notice.textContent = errorLabels[clean] || clean;
    notice.hidden = !text;
    for (const n of root.querySelectorAll(".dialog-notice")) n.remove();
    const d = [...root.querySelectorAll("dialog")].at(-1);
    if (d && text) {
      const n = el("div", notice.textContent, "notice dialog-notice");
      n.setAttribute("role", "alert");
      d.insertBefore(n, d.children[1] || null);
    }
  }
  function button(text, fn, cls = "") {
    const b = el("button", text, cls);
    b.type = "button";
    const buttonIcon = { "刷新": "refresh", "外观": "palette", "新建客户": "plus", "新增沟通": "plus", "新建商机": "plus", "关闭": "close", "打开": "arrow" }[text];
    if (buttonIcon) b.prepend(icon(buttonIcon));
    b.onclick = async () => {
      if (b.disabled || !live) return;
      b.disabled = true;
      try {
        say("");
        await fn();
      } catch (e) {
        say(
          errorLabels[e.message] ||
            e.message ||
            "操作未完成，请检查连接后重试。",
        );
      } finally {
        b.disabled = !live;
      }
    };
    return b;
  }
  async function call(op, value = {}) {
    if (!live) throw Error("HOST_SESSION_EXPIRED");
    const start = epoch;
    const r = await api.foundation.invoke(op, value);
    if (!live || start !== epoch) throw Error("HOST_SESSION_EXPIRED");
    return r;
  }
  async function data(method, value) {
    if (!live) throw Error("HOST_SESSION_EXPIRED");
    const start = epoch,
      r = await api.data[method](value);
    if (!live || start !== epoch) throw Error("HOST_SESSION_EXPIRED");
    return r;
  }
  function panel(heading, help) {
    const p = el("section", null, "panel");
    if (heading) p.append(el("h2", heading));
    if (help) p.append(el("p", help, "muted"));
    return p;
  }
  function field(
    form,
    name,
    label,
    value = "",
    type = "text",
    required = false,
  ) {
    const l = el("label", label),
      input = el(type === "textarea" ? "textarea" : "input");
    input.name = name;
    if (type !== "textarea") input.type = type;
    input.value = value ?? "";
    input.required = required;
    l.append(input);
    form.append(l);
    return input;
  }
  function select(form, name, label, items, value = "", empty = "请选择") {
    const l = el("label", label),
      s = el("select");
    s.name = name;
    const p = el("option", empty);
    p.value = "";
    s.append(p);
    for (const item of items) {
      const o = el("option", item.name || item.label || item.id);
      o.value = item.id;
      s.append(o);
    }
    s.value = value || "";
    l.append(s);
    form.append(l);
    return s;
  }
  function dialog(heading) {
    const d = el("dialog"),
      head = el("div", null, "section-head");
    head.append(
      el("h2", heading),
      button("关闭", () => d.close()),
    );
    d.append(head);
    root.append(d);
    d.addEventListener("close", () => d.remove());
    d.showModal();
    return d;
  }
  function empty(text) {
    return el("p", text, "empty");
  }
  async function allCustomers() {
    let rows = [],
      p = 1,
      n = 0;
    do {
      const batch = await call("customers", { page: p++, limit: 100 });
      rows.push(...batch.items);
      n = batch.total;
      if (batch.items.length < 100) break;
    } while (rows.length < n);
    return [...new Map(rows.map((c) => [c.id, c])).values()];
  }
  async function refresh() {
    if (busy || !live) return;
    busy = true;
    try {
      state = await call("status");
      connection.textContent = state.ready
        ? (state.environment === "preview" ? "预览 · 独立数据" : "万象已连接")
        : state.error || "等待连接万象";
      connection.dataset.state = state.ready ? "ready" : "waiting";
      connection.title = state.identity ? "账号：" + state.identity.user + " · 盒子：" + state.identity.box : "";
      if (state.ready) {
        if (!appearanceLoaded) {
          try { await loadAppearance(); }
          catch (e) { if (e.message === "HOST_SESSION_EXPIRED") throw e; say("外观偏好暂未载入，已使用默认界面。可刷新重试。"); }
        }
        if (!featuresLoaded) {
          try { await loadFeatures(); }
          catch (e) { if (e.message === "HOST_SESSION_EXPIRED") throw e; say("模块偏好暂未载入，AI 助手入口保持关闭。可刷新重试。"); }
        }
        customers = await allCustomers();
        if (view === "conversation") {
          try {
            if (state.channelAccess === false) { channelRows = []; channelError = "请点击管理连接，授权当前应用使用消息渠道。"; }
            else { channelRows = (await call("channels.list")).items; channelError = ""; }
          }
          catch (e) { channelRows = []; channelError = e.message; }
          const recent = await call("records", { page, limit: 30 });
          conversationRows = recent.items; conversationTotal = recent.total;
          arrivals = conversationRows.filter(r => ["wecom","weixin","feishu","dingtalk"].includes(r.source));
          if (view === "conversation") {
            try { conversation = await call("conversation.status"); }
            catch (e) { conversation = { error: /FOUNDATION_OPERATION_DENIED|WORKSHOP_CAPABILITY_UNSUPPORTED|不支持的能力操作/.test(e.message) ? "当前运行环境暂不支持对话录入，请更新万象。客户和已有记录仍可使用。" : e.message }; }
          }
        }
        if (view === "records") {
          const r = await call("records", { page });
          records = r.items;
          total = r.total;
          pending = await call("pending");
          businessPending = await call("pending.business");
        }
        if (view === "opportunities") {
          const r = await call("opportunities", {
            include_archived: showArchived,
            page,
          });
          opportunities = r.items;
          total = r.total;
        }
      }
      const editing = document.activeElement?.name === "message" ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
      const oldThread = content.querySelector(".conversation-thread"), scroll = oldThread && oldThread.scrollHeight - oldThread.clientHeight - oldThread.scrollTop > 30 ? oldThread.scrollTop : null;
      await render();
      if (scroll !== null) { const thread = content.querySelector(".conversation-thread"); if (thread) thread.scrollTop = scroll; }
      if (editing) { const input = content.querySelector('[name="message"]'); if (input) { input.focus(); input.setSelectionRange(...editing); } }
    } finally {
      busy = false;
    }
  }
  async function navigate(next) {
    if (next === "assistant" && !featureEnabled("assistant")) { say("AI 助手为可选模块，请在设置中启用。"); return; }
    view = next;
    page = 1;
    query = "";
    await refresh();
  }
  let showArchived = false;
  async function render() {
    updateNavigation();
    title.textContent = labels[view];
    for (const [k, b] of Object.entries(buttons)) {
      b.classList.toggle("active", k === view);
      b.setAttribute("aria-current", k === view ? "page" : "false");
    }
    content.replaceChildren();
    content.classList.remove("conversation-content");
    if (!state.ready) {
      const p = panel(
        "开始使用",
        "沿用万象身份和模型。客户资料及连接按当前账号、盒子和应用保存。预览资料与正式版分别保存。",
      );
      p.append(
        button(
          "连接客户库",
          async () => {
            state = await call("setup");
            await refresh();
          },
          "primary",
        ),
      );
      content.append(p);
      return;
    }
    if (view === "contacts") drawContacts();
    if (view === "conversation") drawConversation();
    if (view === "records") drawRecords();
    if (view === "opportunities") drawOpportunities();
    if (view === "assistant") await drawAssistant();
    if (view === "settings") drawSettings();
  }
  const channelNames = { wecom: "企业微信", weixin: "微信", feishu: "飞书", dingtalk: "钉钉", app: "应用对话" };
  const channelStates = { connected: "已连接", connecting: "连接中", disabled: "已停用", error: "连接异常" };
  function channelSummary(parent) {
    parent.append(el("h2", "随时通过 Channel 找知客"), el("p", "在已连接的机器人中发文字或语音，记录和查询使用同一客户库。", "muted"));
    if (channelError) parent.append(el("p", "渠道状态未能读取：" + channelError, "result"));
    for (const kind of ["wecom", "weixin", "feishu", "dingtalk"]) {
      const rows = channelRows.filter(c => c.kind === kind), item = el("div", null, "channel-line");
      item.append(icon("channels"), el("span", channelNames[kind]), el("small", rows.length ? rows.map(c => channelStates[c.status] || c.status || "状态未知").join("、") : channelError ? "未读取" : "未连接", "muted")); parent.append(item);
    }
    parent.append(button("管理 Channel", async () => { await navigate("settings"); await channelSettings(); }));
  }
  function recordLinks(parent, r) {
    for (const id of r.contacts || []) {
      const customer = customers.find(c => c.id === id);
      if (customer) parent.append(button("查看 " + customer.name, () => editCustomer(id), "text-button"));
    }
    if (r.status === "pending") parent.append(button("核对待确认", () => navigate("records")));
  }
  function arrivalList(parent) {
    parent.append(el("h2", "最近收到"), el("small", "当前记录页中的渠道消息 · 不含未送达机器人的会话", "muted"));
    if (!arrivals.length) parent.append(empty("本页暂无渠道消息。连接后，向机器人发送一条记录或查询。"));
    for (const r of arrivals.slice(0, 4)) {
      const p = el("article", null, "arrival");
      p.append(el("small", (channelNames[r.source] || r.source) + " · " + time(r.created_at), "muted"), el("p", r.text, "arrival-text"), el("small", statusLabel[r.status] || r.status, "receipt-label"));
      p.append(button("查看记录", () => { const d = dialog("渠道消息"); d.append(el("p", r.text, "prewrap"), el("p", r.result || "原话已接收，暂无处理回执。", "result")); recordLinks(d, r); })); parent.append(p);
    }
  }
  function drawConversation() {
    content.classList.add("conversation-content");
    const layout = el("div", null, "conversation-layout"), workspace = el("section", null, "conversation-workspace"), side = el("aside", null, "conversation-side");
    const bar = el("div", null, "conversation-heading");
    bar.append(logo(), el("div", null, "conversation-identity")); bar.lastChild.append(el("b", "知客"), el("small", "记录客户信息，也随时帮你找回来", "muted"));
    workspace.append(bar);
    const thread = el("div", null, "conversation-thread"); thread.setAttribute("aria-label", "知客对话记录");
    const rows = conversationRows.filter(r => r.source === "app").slice().reverse();
    if (!rows.length) {
      const welcome = el("div", null, "conversation-welcome");
      welcome.append(el("h2", "想到什么，就先记在这里。"), el("p", "说一段客户沟通，补充一点信息，或直接提问。原话和处理结果会留下记录。", "muted"));
      const examples = el("div", null, "conversation-examples");
      for (const [name, text] of [["记一条客户信息", "帮我记录："], ["补充沟通内容", "补充客户信息："], ["查找已有资料", "查询客户："]]) examples.append(button(name, () => { chatText = text; input.value = text; input.focus(); }));
      welcome.append(examples); thread.append(welcome);
    }
    for (const r of rows) {
      const turn = el("article", null, "conversation-turn"); turn.dataset.sourceId = r.id;
      const user = el("div", null, "chat-message chat-user");
      user.append(el("small", time(r.created_at) + (r.input_type === "voice" ? " · 语音转写" : ""), "muted"), el("p", r.text, "prewrap"));
      const answer = el("div", null, "chat-message chat-agent");
      answer.append(el("small", "知客 · " + (statusLabel[r.status] || r.status), "receipt-label"), el("p", r.result || (r.status === "recorded" ? "这条沟通已保存，尚未进行 AI 整理。" : "原话已保存，尚无处理回执。"), "prewrap"));
      recordLinks(answer, r); turn.append(user, answer); thread.append(turn);
    }
    workspace.append(thread);
    const task = conversation.task, active = task && ["sending", "running", "interrupted", "needs-approval", "cancel-requested"].includes(task.status);
    const receipt = el("div", null, "conversation-progress"); receipt.setAttribute("role", "status");
    const taskLabels = { sending:"正在提交…", running:"正在整理或查询，原话已保留…", interrupted:"连接中断，远端可能仍在处理，请先检查状态。", "needs-approval":"本轮等待授权，请到万象中处理。", "cancel-requested":"已请求停止，正在等待确认…", failed:"本轮未完成", cancelled:"本轮已停止；已保存的记录仍保留。" };
    receipt.append(el("span", conversation.error || task?.error || (active ? taskLabels[task.status] : chatReceipt || taskLabels[task?.status]) || ""));
    if (active || task?.error) receipt.append(button("检查处理状态", async () => { conversation = await call("conversation.status", {refresh:true}); chatReceipt = ""; await refresh(); }));
    if (["sending","running"].includes(task?.status)) receipt.append(button("停止处理", async () => { await call("conversation.cancel"); await refresh(); }));
    workspace.append(receipt);
    const form = el("form", null, "conversation-composer"), input = el("textarea");
    input.name = "message"; input.setAttribute("aria-label", "给知客发消息"); input.placeholder = "记录一段沟通，补充客户信息，或询问已有资料…"; input.value = chatText; input.maxLength = 18000;
    input.oninput = () => { chatText = input.value; chatRequest = null; };
    const controls = el("div", null, "composer-actions"), voiceLabel = el("small", chatVoice ? "语音转写 · " + chatVoice : "Ctrl / ⌘ + Enter 发送", "muted");
    const voice = button("添加语音", async () => {
      const r = await call("voice"); if (r.cancelled) return;
      if (typeof r.text !== "string" || !r.text.trim()) throw Error("语音未返回转写文字，请重试。");
      if (r.text.length > 18000) throw Error("转写文字超过18000字，请分段输入。");
      chatText = r.text; chatVoice = r.name || "语音"; chatRequest = null; await refresh();
      content.querySelector('[name="message"]')?.focus();
    });
    voice.disabled = chatSending || !!active;
    const send = el("button", "发送", "primary"); send.type = "submit"; send.disabled = chatSending || !!active || !!conversation.error;
    controls.append(voice, voiceLabel, send); form.append(input, controls, el("small", "明确的信息可整理入档；归属不清会请你确认。查询展示已有资料，草稿不会自动发给客户。", "composer-help"));
    form.onsubmit = async e => {
      e.preventDefault(); if (!input.value.trim() || chatSending || active) return;
      chatText = input.value; chatSending = true; send.disabled = true; voice.disabled = true;
      chatRequest ||= { id: crypto.randomUUID(), text: chatText.trim(), ...(chatVoice ? {voiceName:chatVoice} : {}) };
      try {
        const r = await call("conversation.send", chatRequest);
        if (!r.accepted) throw Error("消息尚未确认接收，输入已保留。");
        chatText = ""; chatVoice = ""; chatRequest = null; page = 1;
        chatReceipt = r.error ? "原话已保存，处理未完成：" + r.error : r.duplicate ? "这条消息已接收，未重复处理。" : "消息已接收，处理结果以回执为准。";
      } catch (e) { chatReceipt = "发送未完成：" + e.message + " 输入已保留。"; }
      finally { chatSending = false; await refresh(); }
    };
    input.onkeydown = e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } };
    workspace.append(form);
    const channel = panel(); channelSummary(channel); const incoming = panel(); arrivalList(incoming); side.append(channel, incoming);
    layout.append(workspace, side); content.append(layout);
    const pages = el("div", null, "conversation-pages actions"); pages.append(el("small", "按全部沟通记录分页，本页展示应用对话；渠道原话在右侧及沟通记录中可查。", "muted"));
    if (page > 1) pages.append(button("较新记录", async () => { page--; await refresh(); }));
    if (page * 30 < conversationTotal) pages.append(button("更早记录", async () => { page++; await refresh(); })); content.append(pages);
    thread.scrollTop = thread.scrollHeight;
  }
  function drawContacts() {
    const tools = el("div", null, "toolbar"),
      search = el("input");
    search.placeholder = "搜索客户、公司或联系方式";
    search.setAttribute("aria-label", "搜索客户");
    search.value = query;
    search.oninput = () => {
      query = search.value;
      drawRows();
    };
    const searchBox = el("div", null, "search-box");
    searchBox.append(icon("search"), search);
    tools.append(searchBox, button("新建客户", () => editCustomer(), "primary"));
    const box = el("div", null, "table-wrap");
    content.append(tools, box);
    function drawRows() {
      box.replaceChildren();
      const rows = customers.filter((c) =>
        [c.name, c.company, c.phone, c.email].join(" ").includes(query),
      );
      if (!rows.length) {
        box.append(
          empty(
            query
              ? "没有匹配客户，可清除搜索。"
              : "还没有客户。可以先新建一位客户。",
          ),
        );
        return;
      }
      const table = el("table"),
        head = el("tr"), caption = el("div", null, "list-caption");
      caption.append(el("strong", "全部客户"), el("span", rows.length + " 位", "count-badge"));
      table.setAttribute("aria-label", "客户列表");
      for (const t of ["姓名", "公司", "联系方式", "需求与说明", ""])
        head.append(el("th", t));
      table.append(head);
      for (const c of rows) {
        const tr = el("tr");
        const person = el("td"), personInner = el("div", null, "person-cell"), avatar = el("span", (c.name || "客").slice(0, 1), "avatar");
        avatar.setAttribute("aria-hidden", "true");
        personInner.append(avatar, el("strong", c.name)); person.append(personInner);
        tr.append(
          person,
          el("td", c.company || "—"),
          el("td", [c.phone, c.email].filter(Boolean).join(" / ") || "—"),
          el("td", c.needs || "—"),
        );
        const cell = el("td");
        cell.append(button("查看", () => editCustomer(c.id), "row-action"));
        tr.append(cell);
        table.append(tr);
      }
            const footer = el("div", null, "list-footer");
      footer.append(el("small", "共 " + rows.length + " 位客户"), el("small", "打开客户可查看关联记录", "list-hint"));
      box.append(caption, table, footer);
    }
    drawRows();
  }
  async function editCustomer(id) {
    const detail = id ? await call("customer", { id }) : null,
      c = detail?.contact || {},
      d = dialog(id ? c.name || "客户档案" : "新建客户"),
      form = el("form", null, "customer-form"),
      fields = {};
    for (const f of config.customerFields)
      fields[f.key] = field(
        form,
        f.key,
        f.label,
        c[f.key] || "",
        f.multiline ? "textarea" : "text",
        f.required,
      );
    let ext = id
        ? await data("get", { collection: "customer_extensions", id })
        : null,
      extFields = JSON.parse(ext?.fields || "{}");
    const extra = {};
    for (const f of config.extraCustomerFields)
      extra[f.key] = field(form, f.key, f.label, extFields[f.key] || "");
    const submit = el("button", "保存客户", "primary");
    submit.type = "submit";
    form.append(submit);
    form.onsubmit = async (e) => {
      e.preventDefault();
      submit.disabled = true;
      try {
        const patch = Object.fromEntries(
          Object.entries(fields)
            .filter(([k, n]) => (c[k] || "") !== n.value)
            .map(([k, n]) => [k, n.value]),
        );
        if (Object.keys(patch).length || !id) {
          const result = await call("customer.save", {
            id: id || undefined,
            revision: c.revision,
            fields: patch,
          });
          if (!result.id) throw Error("客户保存回执缺少编号，请刷新核对。");
          id = result.id;
          Object.assign(c, result);
        }
        const savedId = id;
        if (Object.keys(extra).length)
          await data("put", {
            collection: "customer_extensions",
            id: savedId,
            expectedRevision: ext?._revision || 0,
            value: {
              customerId: savedId,
              fields: JSON.stringify({
                ...extFields,
                ...Object.fromEntries(
                  Object.entries(extra).map(([k, n]) => [k, n.value]),
                ),
              }),
            },
          });
        d.close();
        await refresh();
      } catch (e) {
        say(e.message);
      } finally {
        submit.disabled = false;
      }
    };
    if (!detail) { d.append(form); return; }
    if (detail) {
      d.classList.add("customer-detail");
      d.setAttribute("aria-label", "客户档案");
      const head = d.querySelector(".section-head"), identity = el("div", null, "detail-identity");
      const avatar = el("span", (c.name || "客").slice(0, 1), "avatar detail-avatar");
      avatar.setAttribute("aria-hidden", "true");
      const intro = el("div");
      intro.append(el("small", "客户档案", "eyebrow"), el("h2", c.name || "未命名客户"), el("p", [c.company, c.role].filter(Boolean).join(" · ") || "公司与身份尚未填写", "muted"));
      identity.append(avatar, intro); head.replaceChild(identity, head.firstChild);
      const layout = el("div", null, "detail-layout"), aside = el("aside", null, "detail-aside"), main = el("div", null, "detail-main");
      const tabs = el("div", null, "detail-tabs");
      tabs.setAttribute("role", "group"); tabs.setAttribute("aria-label", "客户档案内容");
      const panes = {}, tabButtons = {};
      function showTab(key) {
        for (const [name, pane] of Object.entries(panes)) pane.hidden = name !== key;
        for (const [name, b] of Object.entries(tabButtons)) { b.classList.toggle("active", name === key); b.setAttribute("aria-pressed", String(name === key)); }
      }
      for (const [key, label] of [["timeline", "沟通脉络"], ...(featureEnabled("assistant") ? [["prepare", "准备沟通"]] : []), ["edit", "编辑档案"]]) {
        const pane = el("section", null, "detail-pane"); pane.setAttribute("aria-label", label); panes[key] = pane;
        const b = button(label, () => showTab(key)); tabButtons[key] = b; tabs.append(b);
      }
      const fieldLabels = { name:"姓名", company:"公司", role:"身份 / 职务", phone:"电话", email:"邮箱", needs:"客户需求", status:"关系进展", last_contact:"最近沟通", next_step:"下一步", next_followup:"下次跟进", tags:"标签", aliases:"已确认别名" };
      const display = value => Array.isArray(value) ? value.join("、") || "尚未提供" : String(value ?? "").trim() || "尚未提供";
      const sourceName = value => ({ wecom:"企业微信", weixin:"微信", feishu:"飞书", dingtalk:"钉钉", "app-edit":"资料编辑", "app-business":"知客操作", app:"应用记录" })[value] || value || "应用记录";
      function sourceEvents(key) {
        return (detail.events || []).filter(e => Object.hasOwn(e.after || {}, key) && (!e.before || JSON.stringify(e.before[key] ?? "") !== JSON.stringify(e.after[key] ?? "")));
      }
      function provenance(key) {
        const sourceDialog = dialog((fieldLabels[key] || key) + " · 来源与变更");
        const events = sourceEvents(key);
        for (const event of events) {
          const a = el("article", null, "record");
          a.append(el("small", time(event.at) + " · " + sourceName(event.source?.source)), el("p", display(event.before?.[key]) + " → " + display(event.after?.[key]), "change"), el("blockquote", event.quote || event.source?.rawText || event.source?.text || "原话未提供"));
          sourceDialog.append(a);
        }
        if (!events.length) sourceDialog.append(empty("当前已加载记录中没有该字段的独立变更依据。可在沟通脉络中查看现有原话。"));
      }
      function summaryField(key, label, value, parent = aside) {
        const row = el("div", null, "detail-field"), labelRow = el("div", null, "detail-field-label");
        labelRow.append(el("span", label));
        if (sourceEvents(key).length) labelRow.append(button("来源", () => provenance(key), "source-button"));
        row.append(labelRow, el("p", display(value), "prewrap")); parent.append(row);
      }
      aside.append(el("h3", "档案摘要"));
      for (const key of ["phone", "email", "needs"]) summaryField(key, fieldLabels[key], c[key]);
      for (const key of ["status", "next_step", "next_followup", "last_contact", "tags", "aliases"]) {
        if (display(c[key]) !== "尚未提供") summaryField(key, fieldLabels[key], c[key]);
      }
      for (const f of config.extraCustomerFields) if (display(extFields[f.key]) !== "尚未提供") summaryField(f.key, f.label, extFields[f.key]);
      aside.append(button("编辑客户资料", () => { showTab("edit"); fields.name?.focus(); }, "detail-edit-button"));
      const timelineHead = el("div", null, "section-head timeline-heading");
      timelineHead.append(el("h3", "沟通与变更"), el("small", "最近记录 · 原话保留"));
      panes.timeline.append(timelineHead);
      const timeline = el("div", null, "customer-timeline");
      const items = [
        ...(detail.linkedRecords || []).map(record => ({ sourceId:record.id, at:record.created_at, source:record.source, text:record.text, raw:record.text, voice:record.input_type === "voice", label:"沟通记录" })),
        ...(detail.events || []).map(event => ({ sourceId:event.source?.id, at:event.at, source:event.source?.source, text:event.quote || event.text || "资料更新", raw:event.source?.rawText || event.source?.text, voice:event.source?.inputType === "voice", before:event.before, after:event.after, label:"资料更新" })),
      ].sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
      const grouped = new Map();
      for (const [index, item] of items.entries()) {
        const key = item.sourceId || "unlinked-event-" + index;
        const existing = grouped.get(key);
        if (existing) {
          if (item.before && item.after) existing.updates.push(item);
          existing.voice ||= item.voice;
          existing.label = "沟通与资料更新";
        } else grouped.set(key, { ...item, updates: item.before && item.after ? [item] : [] });
      }
      function readableText(item) {
        if (item.source !== "app-business" || !item.text?.startsWith("本人在知客确认：")) return item.text;
        try {
          const command = JSON.parse(item.text.slice("本人在知客确认：".length));
          if (command.kind === "opportunity") {
            if (command.fields?.archived === true) return "已归档商机";
            if (command.fields?.archived === false) return "已恢复商机";
            return "已保存商机资料" + (command.fields?.title ? "：" + command.fields.title : "");
          }
          if (command.kind === "followup") return "已记录跟进结果" + (command.fields?.note ? "：" + command.fields.note : "");
        } catch { /* Older source text stays available verbatim. */ }
        return item.text;
      }
      for (const item of grouped.values()) {
        const a = el("article", null, "timeline-event");
        a.append(el("small", time(item.at) + " · " + sourceName(item.source) + " · " + item.label), el("p", readableText(item), "prewrap"));
        if (item.voice) a.append(el("small", "语音转写", "source-badge"));
        for (const update of item.updates) {
          const changes = Object.keys(fieldLabels).filter(key => Object.hasOwn(update.after, key) && JSON.stringify(update.before[key] ?? "") !== JSON.stringify(update.after[key] ?? ""));
          for (const key of changes) a.append(el("p", fieldLabels[key] + "：" + display(update.before[key]) + " → " + display(update.after[key]), "change"));
        }
        const original = el("details"); original.append(el("summary", "查看原始依据"), el("blockquote", item.raw || item.text || "原件未提供", "prewrap")); a.append(original);
        timeline.append(a);
      }
      if (!items.length) timeline.append(empty("还没有沟通记录。留下第一段沟通，逐步积累客户脉络。"));
      panes.timeline.append(timeline, button("新增沟通", async () => { d.close(); await newRecord(c.id); }));
      if (featureEnabled("assistant")) {
      const prepare = panel("为这位客户准备", "带上已确认的客户资料，交给 AI 整理或起草。进入助手后由你点击生成，内容不会自动发送。");
      const prepareActions = el("div", null, "actions");
      for (const [label, request] of [["整理客户信息", "根据已确认的客户资料整理要点，区分已知事实和待确认事项。"], ["起草沟通内容", "根据已确认的客户资料，起草一段供我核对的沟通内容。不要编造承诺。"]]) {
        prepareActions.append(button(label, async () => { selectedCustomer = c.id; selectedRecord = ""; assistantRequest = request; d.close(); await navigate("assistant"); }));
      }
      prepare.append(prepareActions); panes.prepare.append(prepare);
      }
      panes.edit.append(form);
      const more = el("details", null, "historical-customer-fields"); more.append(el("summary", "其他已有资料"));
      for (const [key, value] of Object.entries(c)) {
        if (["id", "revision", "merged_into", "created_at", "updated_at"].includes(key) || config.customerFields.some(f => f.key === key) || display(value) === "尚未提供") continue;
        summaryField(key, fieldLabels[key] || key, value, more);
      }
      panes.edit.append(more);
      main.append(tabs, ...Object.values(panes)); layout.append(aside, main); d.append(layout); showTab("timeline");
    }
  }
  function drawRecords() {
    const tools = el("div", null, "toolbar");
    tools.append(
      el("span", "共 " + total + " 条记录"),
      button("新增沟通", () => newRecord(), "primary"),
    );
    content.append(tools);
    const count = pending.length + businessPending.length;
    if (count) {
      const p = panel(
        "待确认 · " + count,
        "原话已保留。请选择正确归属后再保存。",
      );
      for (const item of pending) {
        const a = el("article", null, "record");
        a.append(
          el(
            "p",
            item.source?.rawText ||
              item.source?.text ||
              item.proposal?.quote ||
              "待核对客户信息",
          ),
          button("核对客户", () => resolvePending(item)),
        );
        p.append(a);
      }
      for (const item of businessPending) {
        const a = el("article", null, "record");
        a.append(
          el("p", item.group?.quote || ""),
          el("p", item.reason || "请核对归属", "muted"),
          button("核对归属", () => resolveBusiness(item)),
        );
        p.append(a);
      }
      content.append(p);
    }
    for (const r of records) {
      const p = panel(null);
      p.append(
        el(
          "small",
          time(r.created_at) +
            " · " +
            r.source +
            " · " +
            (r.input_type === "voice" ? "语音" : "文字") +
            " · " +
            (statusLabel[r.status] || r.status),
          "muted",
        ),
      );
      if (r.source === "app-business") {
        const original = el("details");
        original.append(
          el("summary", "历史操作记录 · 查看原文"),
          el("pre", r.text, "prewrap"),
        );
        p.append(original);
      } else p.append(el("p", r.text, "prewrap"));
      for (const a of r.attachments || [])
        p.append(
          el(
            "p",
            [a.name, a.type, a.status, a.text, a.error]
              .filter(Boolean)
              .join(" · "),
            "muted prewrap",
          ),
        );
      if (r.result) p.append(el("p", r.result, "result"));
      p.append(
        el(
          "small",
          "关联客户：" +
            (r.contacts
              .map((id) => customers.find((c) => c.id === id)?.name || id)
              .join("、") || "尚未关联"),
        ),
        button("关联客户", () => linkRecord(r)),
      );
      if (featureEnabled("assistant")) p.append(
        button("交给 AI 整理", async () => {
          selectedRecord = r.id;
          await navigate("assistant");
        }),
      );
      content.append(p);
    }
    if (!records.length)
      content.append(empty("来自消息渠道和应用的沟通记录会出现在这里。"));
    const pages = el("div", null, "actions");
    if (page > 1)
      pages.append(
        button("上一页", async () => {
          page--;
          await refresh();
        }),
      );
    if (page * 30 < total)
      pages.append(
        button("下一页", async () => {
          page++;
          await refresh();
        }),
      );
    content.append(pages);
  }
  async function newRecord(customerId = "") {
    const d = dialog("新增沟通"),
      f = el("form"),
      who = select(f, "customer", "关联客户（选填）", customers, customerId),
      text = field(f, "text", "沟通内容", "", "textarea", true);
    let voice = null;
    const actions = el("div", null, "actions");
    actions.append(
      button("选择语音文件", async () => {
        const r = await call("voice");
        if (!r.cancelled) {
          text.value = r.text;
          voice = r;
        }
      }),
    );
    const save = el("button", "保存记录", "primary");
    save.type = "submit";
    actions.append(save);
    f.append(actions);
    const key = crypto.randomUUID();
    f.onsubmit = async (e) => {
      e.preventDefault();
      save.disabled = true;
      try {
        const c = customers.find((c) => c.id === who.value);
        await call("record.save", {
          id: key,
          text: text.value,
          input_type: voice ? "voice" : "text",
          filename: voice?.name || "",
          contact_id: c?.id,
          contact_revision: c?.revision,
        });
        d.close();
        say(config.recordSavedMessage);
        await refresh();
      } catch (e) {
        say(e.message);
      } finally {
        save.disabled = false;
      }
    };
    d.append(f);
  }
  async function linkRecord(r) {
    const d = dialog("关联客户"),
      f = el("form"),
      who = select(f, "customer", "客户", customers, r.contacts[0]);
    const save = button(
      "确认关联",
      async () => {
        const c = customers.find((c) => c.id === who.value);
        if (!c) throw Error("请选择客户。");
        await call("record.link", {
          source_id: r.id,
          contact_id: c.id,
          contact_revision: c.revision,
          revision: r.link_revision || 0,
        });
        d.close();
        await refresh();
      },
      "primary",
    );
    f.append(save);
    d.append(f);
  }
  async function resolvePending(item) {
    const d = dialog("核对客户信息"),
      f = el("form");
    d.append(el("p", item.source?.text || item.proposal?.quote || ""));
    const who = select(f, "customer", "客户", item.candidates || customers);
    f.append(
      button(
        "确认保存",
        async () => {
          const c = (item.candidates || customers).find(
            (c) => c.id === who.value,
          );
          if (!c) throw Error("请选择客户。");
          await call("pending.resolve", {
            id: item.id,
            contact_id: c.id,
            revision: c.revision,
          });
          d.close();
          await refresh();
        },
        "primary",
      ),
    );
    d.append(f);
  }
  async function resolveBusiness(item) {
    const d = dialog("核对原有商机／跟进"),
      f = el("form");
    d.append(
      el("p", item.group?.quote || ""),
      el(
        "pre",
        JSON.stringify(
          {
            客户: item.group?.customer?.fields,
            商机: item.group?.opportunity?.fields,
            跟进: item.group?.followup,
          },
          null,
          2,
        ),
      ),
    );
    const who = select(f, "customer", "所属客户", customers);
    const project = select(f, "opportunity", "关联商机（选填）", []);
    who.onchange = async () => {
      const rows = (
        await call("opportunities", { include_archived: false })
      ).items.filter((o) => o.contact_id === who.value);
      project.replaceChildren(el("option", "按原话创建／不关联"));
      project.firstChild.value = "";
      for (const o of rows) {
        const n = el("option", o.title);
        n.value = o.id;
        project.append(n);
      }
    };
    f.append(
      button(
        "确认保存",
        async () => {
          const c = customers.find((c) => c.id === who.value);
          if (!c) throw Error("请选择客户。");
          const rows = (await call("opportunities")).items,
            op = rows.find((o) => o.id === project.value);
          await call("pending.business.confirm", {
            id: item.id,
            contact_id: c.id,
            contact_revision: c.revision,
            opportunity_id: op?.id,
            opportunity_revision: op?.revision,
          });
          d.close();
          await refresh();
        },
        "primary",
      ),
    );
    d.append(f);
  }
  function drawOpportunities() {
    const tools = el("div", null, "toolbar"),
      label = el("label", null, "inline"),
      check = el("input");
    check.type = "checkbox";
    check.checked = showArchived;
    check.onchange = async () => {
      showArchived = check.checked;
      page = 1;
      await refresh();
    };
    label.append(check, el("span", "显示已归档"));
    tools.append(
      label,
      button("新建商机", () => editOpportunity(), "primary"),
    );
    content.append(tools);
    for (const o of opportunities) {
      const p = panel(o.title);
      p.append(
        el(
          "p",
          (o.customer_name || "") + (o.archived ? " · 已归档" : ""),
          "muted",
        ),
        el("p", o.note || "暂无备注"),
        button("编辑", () => editOpportunity(o)),
      );
      content.append(p);
    }
    if (!opportunities.length)
      content.append(empty("暂无商机。名称、客户和备注就可以开始记录。"));
    const pages = el("div", null, "actions");
    pages.append(el("small", "共 " + total + " 条 · 第 " + page + " 页"));
    if (page > 1)
      pages.append(
        button("上一页", async () => {
          page--;
          await refresh();
        }),
      );
    if (page * 100 < total)
      pages.append(
        button("下一页", async () => {
          page++;
          await refresh();
        }),
      );
    content.append(pages);
  }
  async function editOpportunity(o) {
    const d = dialog(o ? "编辑商机" : "新建商机"),
      f = el("form"),
      titleInput = field(f, "title", "名称", o?.title || "", "text", true),
      who = select(f, "customer", "关联客户", customers, o?.contact_id),
      note = field(f, "note", "备注", o?.note || "", "textarea");
    if (o) who.disabled = true;
    const save = el("button", "保存", "primary");
    save.type = "submit";
    f.append(save);
    const command = crypto.randomUUID();
    async function persist(archived) {
      const c = customers.find((c) => c.id === who.value);
      if (!c) throw Error("请选择客户。");
      await call("opportunity.save", {
        command_id: command,
        id: o?.id,
        revision: o?.revision,
        note_revision: o?.note_revision || 0,
        contact_id: c.id,
        contact_revision: c.revision,
        title: titleInput.value,
        note: note.value,
        ...(archived === undefined ? {} : { archived }),
      });
      d.close();
      await refresh();
    }
    f.onsubmit = async (e) => {
      e.preventDefault();
      save.disabled = true;
      try {
        await persist();
      } catch (e) {
        say(e.message);
      } finally {
        save.disabled = false;
      }
    };
    if (o)
      f.append(
        button(o.archived ? "恢复商机" : "归档商机", () =>
          persist(!o.archived),
        ),
      );
    d.append(f);
  }
  async function drawAssistant() {
    const p = panel(
        "AI 助手",
        "先选客户或沟通记录，再告诉 AI 要整理什么、写什么。也可以选择星图资料作为参考。生成内容会保存为草稿，由你核对后使用。",
      ),
      f = el("form");
    select(f, "customer", "客户（选填）", customers, selectedCustomer);
    const recent = await call("records", { page: 1, limit: 100 });
    if (selectedRecord && !recent.items.some((r) => r.id === selectedRecord)) {
      const selected = await call("records", {
        source_id: selectedRecord,
        limit: 1,
      });
      recent.items.push(
        ...selected.items.filter((r) => r.id === selectedRecord),
      );
    }
    const recordSelect = select(
      f,
      "record",
      "沟通记录（选填）",
      recent.items.map((r) => ({
        id: r.id,
        name: time(r.created_at) + " · " + r.text.slice(0, 60),
      })),
      selectedRecord,
    );
    const sourceTools = el("div", null, "actions"),
      knowledgeBadge = el(
        "small",
        selectedEvidence.length
          ? "已选 " + selectedEvidence.length + " 项知识证据"
          : "尚未选择知识证据",
        "knowledge-selection muted",
      );
    sourceTools.append(
      ...(featureEnabled("knowledge") ? [button("选择星图资料", knowledgeSettings)] : []),
      knowledgeBadge,
      button("功能模块", () => navigate("settings")),
      button("清除知识来源", async () => {
        selectedEvidence = [];
        await call("knowledge.select", { warehouseIds: [] });
        knowledgeBadge.textContent = "尚未选择知识证据";
      }),
    );
    p.append(sourceTools);
    const request = field(f, "request", "你的要求", assistantRequest, "textarea", true);
    request.placeholder = "例如：列出这位客户已确认的需求和待确认事项；或根据这条沟通，起草一段回复。不会自动发送或修改客户资料。";
    const output = el("div", null, "answer prewrap");
    output.textContent = draftText;
    const submit = el("button", "生成内容", "primary");
    submit.type = "submit";
    f.append(submit);
    f.onsubmit = async (e) => {
      e.preventDefault();
      submit.disabled = true;
      try {
        const cid = f.elements.customer.value,
          rid = recordSelect.value,
          c = customers.find((c) => c.id === cid),
          r = recent.items.find((r) => r.id === rid);
        selectedCustomer = cid;
        selectedRecord = rid;
        const context = {
          客户: c || null,
          沟通: r ? { id: r.id, text: r.text } : null,
          知识证据: selectedEvidence.map((e) => ({ citation: e.citationRef })),
        };
        const prompt =
          config.assistantInstruction +
          "\n本次参考资料：\n" +
          JSON.stringify(context) +
          "\n用户要求：" +
          request.value;
        const result = await call("assistant", {
          prompt,
          evidence: selectedEvidence.map(
            ({ warehouseId, evidenceId, documentId, versionId }) => ({
              warehouseId,
              evidenceId,
              documentId,
              versionId,
            }),
          ),
        });
        draftText = result.text;
        output.textContent = draftText;
        await data("put", {
          collection: "drafts",
          id: crypto.randomUUID(),
          expectedRevision: 0,
          value: {
            customerId: cid,
            prompt: request.value,
            text: draftText,
            createdAt: new Date().toISOString(),
            model: result.model || "",
            archived: false,
          },
        });
      } catch (e) {
        say(e.message);
      } finally {
        submit.disabled = false;
      }
    };
    p.append(
      f,
      output,
      ...(featureEnabled("files") ? [button("保存到空间", () => spaceSave(draftText, "AI草稿.md"))] : []),
    );
    content.append(p);
    await appendAssistantDrafts(content);
  }
  async function appendAssistantDrafts(parent) {
    const drafts = await data("list", {
        collection: "drafts",
        limit: 100,
        offset: 0,
      }),
      history = el("details");
    history.append(el("summary", "已保存的草稿"));
    for (const row of drafts.items.filter((d) => !d.archived)) {
      const a = el("article", null, "record");
      a.append(
        el("small", time(row.createdAt) + " · " + row.model),
        el("p", row.prompt),
        el("p", row.text, "prewrap"),
      );
      history.append(a);
    }
    parent.append(history);
  }
  function drawSettings() {
    const intro = panel("标准功能模块", "知客已经提供可直接使用的 CRM 最小流程。这里是已接入万象的标准件，可独立使用，也可用于扩展页面和流程。");
    intro.append(el("p", "当前账号：" + state.identity.user + " · 盒子：" + state.identity.box), button("检查连接", () => refresh()));
    content.append(intro);
    const grid = el("div", null, "capabilities module-grid");
    function addCard(name, help, symbol, open) {
      const p = panel(name, help); p.prepend(icon(symbol));
      moduleDetails(p, name);
      p.append(button("打开", open));grid.append(p);return p;
    }
    function moduleDetails(p, name) {
      const module = config.moduleLibrary?.modules?.find(m => m.name === name);
      if (!module) return;
      p.dataset.module = module.id;
      const detail = el("details", null, "module-extension"); detail.append(el("summary", "可如何扩展"), el("p", module.extension, "muted")); p.append(detail);
    }
    addCard("外观", "四套完整界面，选择适合自己的配色与排版。", "palette", appearanceSettings);
    addCard("我的资料", "称呼、公司、身份和产品介绍均为选填。", "contacts", profileSettings);
    addCard("模型", "沿用万象默认，或只为本应用指定模型。", "assistant", modelSettings);
    addCard("消息渠道", "连接企业微信、微信、飞书或钉钉，沿用现有绑定。", "records", channelSettings);
    addCard("对话录入与查询", "通过文字或语音整理客户信息、补充和查询；保留原话与处理回执。", "conversation", () => navigate("conversation"));
    addCard("客户与沟通数据", "以稳定客户编号关联档案和记录，为新字段及流程提供基础。", "contacts", () => navigate("contacts"));
    addCard("语音", "选择已有语音，使用当前配置的转写能力。", "records", async () => {
      const r = await call("voice");if (!r.cancelled) { const d = dialog("语音转写");d.append(el("p", r.text, "prewrap")); }
    });
    const modules = featureModules();
    for (const id of ["files","knowledge","schedules","assistant"]) {
      const module = modules.find(m => m.id === id);if (!module) continue;
      const p = panel(module.name, module.description);p.dataset.feature = id;
      moduleDetails(p, module.name);
      p.prepend(icon({assistant:"assistant",knowledge:"search",files:"opportunities",schedules:"settings"}[id]));
      p.querySelector("h2").append(el("span", "已接入", "feature-badge"));
      p.append(el("small", "使用条件：" + module.requirements.join("、"), "feature-requirements"));
      const status = el("p", "当前连接尚未检查", "muted feature-status");status.setAttribute("role", "status");
      const actions = el("div", null, "actions");
      if (id === "assistant") {
        const toggle = button(featureEnabled(id) ? "从导航移除" : "添加到导航", async () => { await setFeature(id, !featureEnabled(id)); });
        toggle.dataset.featureToggle = id;toggle.setAttribute("aria-pressed", String(featureEnabled(id)));actions.append(toggle);
      }
      const open = button("打开", () => openFeature(id));open.dataset.featureOpen = id;open.hidden = id === "assistant" && !featureEnabled(id);
      actions.append(open, button("检查连接", async () => {
        try { status.textContent = await inspectFeature(id); }
        catch (e) { status.textContent = "连接检查未完成：" + (errorLabels[e.message] || e.message); }
      }));
      p.append(status, actions);grid.append(p);
    }
    addCard("CSV 备份", "选择空间目录、周期和需要备份的内容。", "opportunities", backupSettings);
    addCard("历史资料", "已有草稿、详细商机、历史与提醒设置继续保留。", "records", legacySettings);
    content.append(grid);
  }
  async function openFeature(id) {
    if (!featureEnabled(id)) throw Error("请先在设置中将 AI 助手添加到导航。");
    const handlers = { assistant:() => navigate("assistant"), knowledge:knowledgeSettings, files:spaceBrowser, schedules:scheduleSettings };
    await handlers[id]();
  }
  async function inspectFeature(id) {
    if (id === "assistant") { const r = await call("models"); return r.models?.length ? "可选模型 " + r.models.length + " 个 · 本次未进行模型调用" : "未找到可选模型，请检查万象配置"; }
    const operation = {knowledge:"knowledge.list",files:"space.locations",schedules:"schedules"}[id];
    const r = await call(operation);const count = (r.items || []).length;
    return {knowledge:count ? "当前可访问 " + count + " 个知识范围" : "当前没有已授权知识范围",files:count ? "当前可访问 " + count + " 个空间" : "当前没有可访问的空间",schedules:"当前应用已有 " + count + " 个任务 · 未改变启停状态"}[id];
  }
  async function modelSettings() {
    const result = await call("models"),
      d = dialog("万象模型"),
      f = el("form");
    const model = select(
      f,
      "model",
      "应用模型",
      [
        { id: "auto", name: "跟随万象默认" },
        ...result.models.map((m) => ({
          id: m.ref,
          name: m.name + " · " + m.provider,
        })),
      ],
      result.selection.mode === "manual" ? result.selection.ref : "auto",
      null,
    );
    f.append(
      button(
        "保存选择",
        async () => {
          await call(
            "model.select",
            model.value === "auto"
              ? { mode: "auto" }
              : { mode: "manual", ref: model.value },
          );
          d.close();
          await refresh();
        },
        "primary",
      ),
    );
    d.append(
      el("p", "当前选择：" + (state.model?.name || "跟随万象默认")),
      el(
        "p",
        state.lastModelCall
          ? "最近调用：" +
              state.lastModelCall.status +
              " · " +
              state.lastModelCall.model +
              (state.lastModelCall.error
                ? " · " + state.lastModelCall.error
                : "")
          : "尚未在本版本调用模型",
        "muted",
      ),
      f,
    );
  }
  async function profileSettings() {
    const r = await call("profile.get"),
      d = dialog("我的资料（选填）"),
      f = el("form");
    for (const [key, label] of [
      ["name", "称呼"],
      ["company", "公司／团队"],
      ["role", "身份／职位"],
    ])
      field(f, key, label, r.profile?.[key] || "");
    field(
      f,
      "offering",
      "我的产品与服务",
      r.preferences.offering || "",
      "textarea",
    );
    f.append(
      button(
        "保存资料",
        async () => {
          await call("profile.save", {
            profile: {
              name: f.elements.name.value,
              company: f.elements.company.value,
              role: f.elements.role.value,
            },
            revision: r.profile.revision || 0,
            offering: f.elements.offering.value,
            preferences_revision: r.preferences.revision,
          });
          d.close();
        },
        "primary",
      ),
    );
    d.append(f);
  }
  async function channelSettings() {
    const d = dialog("消息渠道"),
      list = await call("channels.list"),
      catalog = await call("channels.catalog");
    for (const row of list.items) {
      const p = panel(row.name);
      p.append(
        el(
          "p",
          [
            row.kind,
            row.status,
            row.verification?.status === "active"
              ? "本人已确认"
              : "尚未确认本人",
          ].join(" · "),
        ),
        button("编辑配置", () => channelForm(row, catalog)),
        button("测试连接", async () => {
          const r = await call("channels.test", { id: row.id, kind: row.kind });
          say(r.valid ? "连接测试通过" : "连接测试未通过");
        }),
        button(row.enabled ? "停用" : "启用", async () => {
          await call("channels.toggle", {
            id: row.id,
            kind: row.kind,
            enabled: !row.enabled,
          });
          d.close();
          await channelSettings();
        }),
        button("确认本人", () => verifyChannel(row)),
      );
      if (row.verification?.status === "active")
        p.append(
          button("撤销本人确认", async () => {
            await call("channels.verify-revoke", {
              id: row.id,
              kind: row.kind,
            });
            d.close();
            await channelSettings();
          }),
        );
      d.append(p);
    }
    const actions = el("div", null, "actions");
    for (const kind of ["wecom", "weixin", "feishu", "dingtalk"]) {
      const spec = catalog.items.find((s) => s.kind === kind),
        name = {
          wecom: "企业微信",
          weixin: "微信",
          feishu: "飞书",
          dingtalk: "钉钉",
        }[kind];
      if (spec?.qr)
        actions.append(button("扫码连接" + name, () => channelQr(kind)));
      if (kind !== "weixin")
        actions.append(
          button("配置" + name, () => channelForm({ kind }, catalog)),
        );
    }
    d.append(actions);
  }
  async function channelQr(kind) {
    const d = dialog("扫码连接"),
      r = await call("channels.qr", { kind });
    const image = el("img");
    image.alt = "渠道授权二维码";
    if (r.qr?.dataUrl) image.src = r.qr.dataUrl;
    else if (typeof r.qr === "string" && r.qr.startsWith("data:image/"))
      image.src = r.qr;
    d.append(
      image,
      el("p", "请用对应应用扫码授权。"),
      button("检查扫码状态", async () => {
        const status = await call("channels.poll", { handle: r.handle });
        if (
          typeof status.qr === "string" &&
          status.qr.startsWith("data:image/")
        )
          image.src = status.qr;
        if (
          status.status === "connected" ||
          status.status === "saved" ||
          status.channel
        ) {
          d.close();
          await channelSettings();
        } else say("扫码状态：" + status.status);
      }),
    );
    d.addEventListener(
      "close",
      () => call("channels.cancel", { handle: r.handle }).catch(() => {}),
      { once: true },
    );
  }
  async function channelForm(row, catalog) {
    const spec = catalog.items.find((i) => i.kind === row.kind);
    if (!spec) throw Error("当前万象不支持此渠道。");
    const old = row.id
        ? await call("channels.detail", { id: row.id, kind: row.kind })
        : null,
      d = dialog(row.id ? "编辑渠道" : "新增渠道"),
      f = el("form");
    field(f, "name", "名称", row.name || spec.label, "text", true);
    for (const item of spec.fields) {
      const n = field(
        f,
        item.name,
        item.label || item.name,
        old?.values?.[item.name] || "",
        item.type === "password"
          ? "password"
          : item.type === "switch"
          ? "checkbox"
          : "text",
        item.required && !old?.configured?.includes(item.name),
      );
      if (item.type === "switch")
        n.checked = old?.values?.[item.name] === "true";
      if (old?.configured?.includes(item.name))
        n.placeholder = "已配置，留空保留";
    }
    f.append(
      button(
        "保存渠道",
        async () => {
          if (!f.reportValidity()) return;
          const values = Object.fromEntries(
            spec.fields.map((item) => [
              item.name,
              item.type === "switch"
                ? String(f.elements.namedItem(item.name).checked)
                : f.elements.namedItem(item.name).value,
            ]),
          );
          await call("channels.save", {
            id: row.id,
            kind: row.kind,
            name: f.elements.name.value,
            values,
          });
          d.close();
          say("渠道已保存。请确认本人后使用。");
        },
        "primary",
      ),
    );
    d.append(f);
  }
  function verificationText(v) {
    return (
      {
        active: "本人已确认，可以接收已授权会话消息。",
        awaiting_message: "请给这个机器人发送一条私聊，再点击检查验证消息。",
        awaiting_confirmation:
          "收到：" +
          (v.name || "私聊") +
          "\n" +
          (v.preview || "") +
          "\n请核对后确认是本人。",
        unverified: "尚未确认本人。",
        expired: "确认已过期，请重新发起。",
      }[v.status] || "当前状态：" + v.status
    );
  }
  async function verifyChannel(row) {
    const d = dialog("确认本人"),
      r = await call("channels.verify-start", { id: row.id, kind: row.kind });
    d.append(
      el("p", verificationText(r.verification || r), "prewrap"),
      button("检查验证消息", async () => {
        const r = await call("channels.verification", {
          id: row.id,
          kind: row.kind,
        });
        d.querySelector("p").textContent = verificationText(
          r.verification || r,
        );
        const ticket = r.verification?.ticket;
        if (ticket)
          d.append(
            button(
              "确认是本人",
              async () => {
                await call("channels.verify-confirm", {
                  id: row.id,
                  kind: row.kind,
                  ticket,
                });
                d.close();
              },
              "primary",
            ),
          );
      }),
    );
  }
  async function spaceBrowser() {
    const d = dialog("空间文件"),
      box = el("div");
    d.append(box);
    async function show(parent = "") {
      const r = await call("space.list", { parent });
      box.replaceChildren(button("返回根目录", () => show("")));
      spaceFolder = parent;
      for (const item of r.items) {
        const row = el("div", null, "record");
        row.append(
          button((item.kind === "folder" ? "▱ " : "") + item.name, async () => {
            if (item.kind === "folder") await show(item.id);
            else {
              const file = await call("space.read", { id: item.id });
              const v = dialog(file.name);
              v.append(el("pre", file.text));
            }
          }),
        );
        box.append(row);
      }
      box.append(
        button("在此保存文本", () => spaceSave("", "资料.md", parent)),
      );
    }
    await show();
  }
  async function spaceSave(text, name, parent = spaceFolder) {
    const d = dialog("保存到空间"),
      f = el("form");
    field(f, "name", "文件名", name, "text", true);
    field(f, "text", "内容", text, "textarea", true);
    f.append(
      button(
        "保存新文件",
        async () => {
          if (!f.reportValidity()) return;
          await call("space.save", {
            parent,
            name: f.elements.name.value,
            text: f.elements.text.value,
          });
          d.close();
          say("文件已保存。");
        },
        "primary",
      ),
    );
    d.append(f);
  }
  async function chooseFolder(onChoose) {
    const d = dialog("选择空间目录"),
      box = el("div");
    d.append(box);
    const locations = await call("space.locations");
    const spaces = Array.isArray(locations)
      ? locations
      : locations.items || locations.spaces || [];
    function home() {
      box.replaceChildren();
      for (const space of spaces)
        box.append(
          button(space.name || "空间", () =>
            browse(space.id, "", space.name || "空间"),
          ),
        );
    }
    async function browse(space_id, parent, name) {
      const r = await call("space.browse", { space_id, parent });
      box.replaceChildren(
        button("返回空间列表", () => home()),
        el("p", name),
        button(
          "选择此目录",
          async () => {
            await onChoose({ parent, space_id, name });
            d.close();
          },
          "primary",
        ),
      );
      for (const folder of r.items.filter((i) => i.kind === "folder"))
        box.append(
          button("▱ " + folder.name, () =>
            browse(space_id, folder.id, folder.name),
          ),
        );
    }
    home();
  }
  async function backupSettings() {
    const r = await call("backup.status"),
      d = dialog("CSV 备份"),
      f = el("form");
    let target = {
      parent: r.parent || "",
      space_id: r.space_id || "personal",
      name: r.folder_name || "尚未选择目录",
    };
    const destination = el("p", target.name);
    d.append(
      el(
        "p",
        r.last_success
          ? "最近成功：" + time(r.last_success * 1000)
          : "尚无完整备份",
      ),
      el("p", r.last_error || "", "muted"),
    );
    f.append(
      destination,
      button("选择空间目录", () =>
        chooseFolder((value) => {
          target = value;
          destination.textContent = value.name;
        }),
      ),
    );
    field(f, "name", "文件名", r.filename || "知客客户表.csv");
    select(
      f,
      "period",
      "周期",
      [
        { id: "1440", name: "每天" },
        { id: "360", name: "每6小时" },
        { id: "60", name: "每小时" },
        { id: "15", name: "每15分钟" },
        ...(![1440, 360, 60, 15].includes(r.interval_minutes)
          ? [
              {
                id: String(r.interval_minutes),
                name: "原周期：每" + r.interval_minutes + "分钟",
              },
            ]
          : []),
      ],
      String(r.interval_minutes || 1440),
    );
    const enable = field(f, "enable", "启用定期备份", "", "checkbox");
    enable.checked = !!r.enabled;
    const includeBusiness=field(f,"includeBusiness","同时备份商机与跟进记录（含历史资料）","","checkbox");includeBusiness.checked=r.include_business===true;
    f.append(
      button(
        "保存设置",
        async () => {
          await call("backup.configure", {
            settings: {
              enabled: enable.checked,
              filename: f.elements.name.value,
              interval_minutes: Number(f.elements.period.value),
              parent: target.parent,
              space_id: target.space_id,
              include_business: includeBusiness.checked,
            },
            revision: r.revision,
          });
          d.close();
        },
        "primary",
      ),
      button("立即备份", async () => {
        const result = await call("backup.run");
        if (result.status === "not_due")
          throw Error("请先启用备份并保存设置，再执行立即备份。");
        if (result.status !== "saved")
          throw Error(result.last_error || "备份未完成，请检查空间连接后重试。");
        d.close();
        await backupSettings();
      }),
    );
    d.append(
      f,
      el(
        "p",
        "CSV 为可查看的业务快照，不是完整系统恢复包。原备份内容选择保持不变。",
        "muted",
      ),
    );
  }
  async function knowledgeSettings() {
    const r = await call("knowledge.list"),
      d = dialog("星图知识"),
      f = el("form"),
      checks = [];
    for (const w of r.items) {
      const l = el("label", null, "inline"),
        c = el("input");
      c.type = "checkbox";
      l.append(c, el("span", w.name));
      f.append(l);
      checks.push([w.id, c]);
    }
    const q = field(f, "query", "检索问题"),
      out = el("div");
    f.append(
      button("检索", async () => {
        await call("knowledge.select", {
          warehouseIds: checks.filter(([, c]) => c.checked).map(([id]) => id),
        });
        const r = await call("knowledge.search", { query: q.value });
        out.replaceChildren();
        selectedEvidence = [];
        for (const hit of r.hits) {
          const p = panel(hit.title);
          p.append(
            el("p", hit.excerpt),
            button(featureEnabled("assistant") ? "回读证据并用于本次 AI" : "查看原文与引用", async () => {
              const evidence = await call("knowledge.evidence", hit);
              if (
                selectedEvidence.some(
                  (e) => e.citationRef === evidence.citationRef,
                )
              )
                return;
              if (selectedEvidence.length >= 5)
                throw Error("每次最多选择5项知识证据。");
              selectedEvidence.push(evidence);
              const badge = root.querySelector(".knowledge-selection");
              if (badge)
                badge.textContent =
                  "已选 " + selectedEvidence.length + " 项知识证据";
              p.append(
                el("small", evidence.citationRef, "muted"),
                el("pre", evidence.text),
              );
            }),
          );
          out.append(p);
        }
        if (!r.hits.length) out.append(empty("当前范围没有匹配证据。"));
      }),
    );
    d.append(f, out);
  }
  async function scheduleSettings(allowCreate = true) {
    const r = await call("schedules"),
      d = dialog("定时任务与本人通知");
    for (const job of r.items) {
      const p = panel(job.name);
      p.append(
        el(
          "p",
          (job.enabled ? "已启用" : "已暂停") +
            " · " +
            JSON.stringify(job.trigger),
        ),
        button(job.enabled ? "暂停" : "启用", async () => {
          await call("schedule.toggle", {
            id: job.cron_id || job.id,
            enabled: !job.enabled,
          });
          d.close();
          await scheduleSettings();
        }),
        ...(allowCreate ? [button("立即执行一次", async () => {
          await call("schedule.run", { id: job.id });
          say("执行请求已提交，可查看执行记录。");
        })] : []),
        button("查看执行记录", async () => {
          const history = await call("schedule.history", {
            id: job.cron_id || job.id,
          });
          const v = dialog("任务状态");
          v.append(el("pre", JSON.stringify(history, null, 2)));
        }),
      );
      d.append(p);
    }
    if (!allowCreate) { d.append(el("p", "入口未启用时仍可管理已有任务。创建新任务或立即执行，请先启用定时模块。", "muted")); return; }
    const f = el("form");
    field(f, "name", "任务名称");
    field(f, "trigger", "周期表达式，例如 interval:3600（每小时）");
    field(f, "prompt", "任务内容", "", "textarea");
    select(
      f,
      "mode",
      "执行方式",
      [
        { id: "text", name: "发送提醒内容" },
        { id: "agent", name: "交给 AI 执行" },
      ],
      "text",
    );
    const notify = field(
      f,
      "notify",
      "结果通知已确认的本人企微",
      "",
      "checkbox",
    );
    f.append(
      button(
        "创建为暂停状态",
        async () => {
          await call("schedule.create", {
            name: f.elements.name.value,
            trigger: f.elements.trigger.value,
            prompt: f.elements.prompt.value,
            notify: notify.checked,
            mode: f.elements.mode.value,
          });
          d.close();
          await scheduleSettings();
        },
        "primary",
      ),
    );
    d.append(
      f,
      el(
        "p",
        "任务由万象执行。需要本人消息通知时，沿用已确认的本人渠道；不向客户自动发信。",
        "muted",
      ),
    );
  }
  async function legacySettings(legacyPage = 1) {
    const r = await call("legacy", { page: legacyPage }),
      d = dialog("历史资料");
    await appendAssistantDrafts(d);
    for (const draft of r.care.drafts || []) {
      const p = panel(draft.title);
      p.append(
        el(
          "p",
          (draft.stale ? "资料已变化，使用前核对。" : "") + " · " + draft.kind,
        ),
        button("查看完整草稿", async () => {
          const r = await call("legacy.draft", { id: draft.id });
          const v = dialog(r.title);
          v.append(el("pre", r.text));
        }),
      );
      d.append(p);
    }
    for (const op of r.opportunities.items) {
      const details = el("details");
      details.append(
        el("summary", op.title + " · 原有详细资料"),
        el("pre", JSON.stringify(op, null, 2)),
        button("查看原阶段历史与跟进", async () => {
          const r = await call("legacy.opportunity", { id: op.id });
          const v = dialog(op.title);
          v.append(el("pre", JSON.stringify(r, null, 2)));
        }),
      );
      d.append(details);
    }
    const reminders = panel(
      "原有提醒设置",
      "保留已启用任务；可以在此暂停或恢复。",
    );
    reminders.append(
      el("pre", JSON.stringify(r.care.preferences, null, 2)),
      button(
        r.care.preferences.enabled ? "暂停原提醒" : "启用原提醒",
        async () => {
          await call("legacy.preferences", {
            settings: { enabled: !r.care.preferences.enabled },
            revision: r.care.preferences.revision,
          });
          d.close();
          await legacySettings();
        },
      ),
    );
    d.append(reminders);
    const pages = el("div", null, "actions");
    if (legacyPage > 1)
      pages.append(
        button("上一页历史资料", async () => {
          d.close();
          await legacySettings(legacyPage - 1);
        }),
      );
    if (
      legacyPage * 100 <
      Math.max(r.opportunities.total || 0, r.draftTotal || 0)
    )
      pages.append(
        button("下一页历史资料", async () => {
          d.close();
          await legacySettings(legacyPage + 1);
        }),
      );
    d.append(pages);
  }
  function invalidate() {
    live = false;
    epoch++;
    clearInterval(pollTimer); unsubscribe?.();
    chatText = ""; chatRequest = null; chatVoice = ""; conversationRows = []; arrivals = []; channelRows = []; conversation = {};
    customers = [];
    records = [];
    opportunities = [];
    pending = [];
    businessPending = [];
    selectedEvidence = [];
    draftText = "";
    root.replaceChildren(el("p", "连接已失效，请从万象重新打开。", "empty"));
  }
  if (api.onInvalidated) api.onInvalidated(invalidate);
  if (api.subscribe)
    unsubscribe = api.subscribe(() => {
      // Stream events can arrive for every token. Receipts are polled below;
      // do not replace the composer on each model event.
      if (live && !busy && view !== "conversation") refresh().catch((e) => say(e.message));
    });
  await refresh();
  pollTimer = setInterval(() => {
    if (live && !busy && !chatSending && view === "conversation" && !root.querySelector("dialog[open]") && document.visibilityState !== "hidden") refresh().catch(e => say(e.message));
  }, 5000);
  return { invalidate };
}
