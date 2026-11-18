import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, nativeTheme, screen } from "electron";

const renderer = process.env.WANX_SIDEBAR_RENDERER_DIR ||
  fileURLToPath(new URL("../../build/app/local-ui/renderer/", import.meta.url));
const noteButton = "#academy-note-tool";
const workbenchButton = '[data-action="space-workbench"]';
const uploadControl = 'summary[aria-label="上传到当前文件夹"]';
const connectControl = '[data-action="show-boxes"]';
const assistantButton = "#academy-edge-handle";
function wideViewport() {
  const { width, height } = screen.getDisplayMatching(window.getBounds()).workAreaSize;
  return [Math.min(1440, width - 24), Math.min(750, height - 50)];
}
const model = { id: "fixture/model", name: "测试模型", provider: "fixture", input: ["text"] };
const scope = "fixture-dialogue";
const threadId = "fixture-thread";
const conversation = { id: threadId, revision: 1, context: {}, versions: [] };
const messages = [];
let dialogueSessions = [];
const editableApplicationId = "fixture.editable";
const expectExpertApps = process.env.WANX_TEST_EXPECT_EXPERT_APPS === "1";
const testMultipleNotes = process.env.WANX_SIDEBAR_NOTES_ONLY === "1";
const expectAcademyBridge = process.env.WANX_TEST_ACADEMY_BRIDGE === "1";
const expertAppRecords = {
  office: {
    applicationId: "centaurai.wanx.template.office-assistant", name: "小办·办公专家",
    entrypoint: "local-expert.cjs", installationSource: "local", version: "0.1.1",
  },
  "ai-crm": {
    applicationId: "centaurai.wanx.template.ai-crm", name: "AI CRM",
    entrypoint: "local-expert.cjs", installationSource: "local", version: "0.1.1",
  },
};
const expertAppCalls = [];
const appLaunches = [];
const baseState = {
  phase: "ready",
  account: { phase: "authenticated", accountId: "sidebar-fixture", clientId: "test-client" },
  network: { enabled: false, phase: "disabled" },
  platform: { phase: "idle" },
  connection: { deviceId: "test-box", mode: "local", gatewayURL: "http://127.0.0.1" },
  devices: [{ deviceId: "test-box", displayName: "测试盒子", accessState: "ready" }],
  applications: [expertAppRecords.office],
};
let hostState = baseState;
let noteBlocks = [];
const extraNotes = new Map();
let nextNote = 0;
const noteWrites = [];
let heldSave;
let heldDialogueSend;
let releaseSave;
let window;

const run = source => window.webContents.executeJavaScript(source, true);
const send = (channel, value) => window.webContents.send("wanx-client:" + channel, value);
const noteSnapshot = noteId => ({
  items: [], tasks: [], boxId: "test-box", scope: "fixture-note",
  online: hostState.phase === "ready",
  note: { blocks: noteId ? extraNotes.get(noteId) || [] : noteBlocks, revision: 1,
    phase: hostState.phase === "ready" ? "saved" : "offline",
    ...(noteId && !extraNotes.has(noteId) ? { deleted: true } : {}) },
  ...(noteId ? { noteId } : {}),
  ...(testMultipleNotes ? { notes: [...extraNotes].map(([id, blocks]) => ({
    id, title: blocks[0]?.text?.split("\n")[0] || "",
  })) } : {}),
});

async function until(predicate, description) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await predicate()) return;
    await pause(20);
  }
  const context = await run('document.querySelector(".nav-item.active")?.textContent || document.title');
  throw Error("Timed out: " + description + " on " + context);
}

async function click(selector) {
  if (selector === noteButton || selector === ".clipboard-note-editor") {
    await waitForEdge(true);
  }
  const point = await run("(" + function(selector) {
    const element = document.querySelector(selector);
    if (!element) throw Error("Missing control " + selector);
    const bounds = element.getBoundingClientRect();
    const x = Math.floor(bounds.x + bounds.width / 2);
    const y = Math.floor(bounds.y + bounds.height / 2);
    const hit = document.elementFromPoint(x, y);
    if (!element.contains(hit) || element.disabled) {
      throw Error("Unreachable control " + selector + ": " + JSON.stringify({
        bounds: bounds.toJSON(), viewport: { width: innerWidth, height: innerHeight },
        disabled: element.disabled, inert: element.closest("[inert]")?.outerHTML.slice(0, 180),
        hit: hit?.outerHTML.slice(0, 180) || "outside viewport",
        context: document.querySelector(".nav-item.active")?.textContent,
        topbar: document.querySelector(".topbar")?.getBoundingClientRect().toJSON(),
        bodyClasses: document.body.className,
      }));
    }
    return { x, y };
  } + ")(" + JSON.stringify(selector) + ")");
  const input = window.webContents.debugger;
  await input.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
  await input.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
  await pause(35);
}

const key = (key, options = {}) => run("(" + function(key, options) {
  document.activeElement.dispatchEvent(new KeyboardEvent("keydown", {
    key, bubbles: true, cancelable: true, ...options,
  }));
} + ")(" + JSON.stringify(key) + "," + JSON.stringify(options) + ")");

const shown = panel => run("activeSidebar() === " + JSON.stringify(panel));
const waitForPanel = panel => until(() => shown(panel), "sidebar " + (panel || "closed"));
async function waitForEditor() {
  await until(() => run('document.querySelector(".clipboard-note-editor")?.isContentEditable === true'), "editable note");
  await click(".clipboard-note-editor");
  assert.equal(await run('document.activeElement === document.querySelector(".clipboard-note-editor")'), true);
}
const noteText = () => run('document.querySelector(".clipboard-note-editor").textContent');
const dialogueDraft = () => run('document.querySelector("#academy-drawer [data-chat-input]").value');

async function enterDraft(draft) {
  await run("(" + function(draft) {
    const input = document.querySelector("#academy-drawer [data-chat-input]");
    input.value = draft;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  } + ")(" + JSON.stringify(draft) + ")");
}

async function holdNoteSave(text) {
  heldSave = Promise.withResolvers();
  const previousWrites = noteWrites.length;
  await run("(" + function(text) {
    const editor = document.querySelector(".clipboard-note-editor");
    editor.textContent = text;
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  } + ")(" + JSON.stringify(text) + ")");
  await until(() => noteWrites.length > previousWrites && Boolean(releaseSave), "delayed local note save");
}

function mockIPC() {
  const handle = (name, handler) => ipcMain.handle("wanx-client:" + name, handler);
  handle("get-state", () => hostState);
  handle("market-list", () => ({ items: [] }));
  handle("market-candidate", () => ({ status: "unavailable" }));
  handle("credits-balance", () => ({ available: 0 }));
  handle("credits-transactions", () => ({ items: [] }));
  for (const method of ["orders", "catalog", "balance"]) {
    handle("wallet-" + method, () => ({ ok: false, error: { code: "CREDITS_NOT_CONFIGURED" } }));
  }
  handle("workshop", (_event, { action }) => ({
    items: action === "sources"
      ? [{ id: "installed:" + editableApplicationId, name: "可定制测试应用", editable: true }]
      : [],
    projects: [],
  }));
  handle("expert-apps", (_event, { action, input }) => {
    expertAppCalls.push([action, input]);
    if (action === "catalog") {
      if (!expectExpertApps) return { mode: "unavailable", pilots: [], installed: [] };
      const entries = Object.entries(expertAppRecords);
      return {
        mode: "local-development",
        pilots: entries.map(([id, record]) => ({ id, name: record.name, applicationId: record.applicationId })),
        installed: entries.filter(([, record]) => hostState.applications.some(
          app => app.applicationId === record.applicationId,
        )).map(([id]) => id),
      };
    }
    if (action === "install") {
      const record = expertAppRecords[input.id];
      hostState = { ...hostState, applications: [...hostState.applications, record] };
      return { applicationId: record.applicationId, installed: true };
    }
    return { opened: true };
  });
  handle("applications-request-open", (_event, input) => {
    appLaunches.push(input.applicationId);
    return { opened: true };
  });
  if (expectAcademyBridge) handle("academy-copilot-action", (_event, _method, context) => ({
    ok: true,
    value: {
      context: { ...context, label: context.module === "space" ? "万象空间" : "应用市场", examples: ["如何操作？"] },
    },
  }));
  handle("memory-open", () => ({ available: false }));
  handle("space-refresh", () => ({ phase: "ready", scope: "fixture-space", tasks: [], annotationAvailable: true }));
  handle("space-list", () => ({ items: [], breadcrumbs: [] }));
  handle("space-links-spaces", () => []);
  handle("space-links-requests", () => []);
  handle("space-links-mcp-state", () => ({}));
  handle("clipboard-snapshot", () => noteSnapshot());
  handle("clipboard-note-refresh", (_event, { noteId }) => noteSnapshot(noteId));
  handle("clipboard-note-command", (_event, { action, noteId }) => {
    if (action === "create") {
      noteId = (++nextNote).toString(16).padStart(32, "0");
      extraNotes.set(noteId, []);
    } else if (action === "delete") extraNotes.delete(noteId);
    return noteSnapshot(noteId);
  });
  handle("clipboard-note-save", async (_event, { blocks, noteId }) => {
    const owner = hostState.account.accountId;
    noteWrites.push(blocks);
    if (heldSave) {
      const gate = heldSave;
      heldSave = null;
      releaseSave = gate.resolve;
      const failure = await gate.promise;
      releaseSave = null;
      if (failure) throw Error(failure);
    }
    if (owner === hostState.account.accountId) {
      if (noteId) extraNotes.set(noteId, blocks);
      else noteBlocks = blocks;
    }
    return noteSnapshot(noteId);
  });
  handle("notifications-read", () => ({ ok: true }));
  const testMemories = new Map();
  handle("ai-dialogue-sidebar-memory", (_event, input) => {
    if (input.action === "search") {
      return { scope, items: [...testMemories.values()].filter(item => !input.query || item.text.includes(input.query)), hasMore: false };
    }
    assert.equal(input.conversationMode, "craft");
    if (input.id) testMemories.delete(input.id);
    if (input.action === "forget") return { scope, item: null, applied: true };
    const item = { id: input.requestId, text: input.text, createdAt: new Date().toISOString() };
    testMemories.set(item.id, item);
    return { scope, item, applied: true };
  });
  handle("ai-dialogue-sidebar-memory-cancel", () => ({ scope }));
  handle("ai-dialogue-sidebar-memmy", (_event, input) => ({
    scope, items: [{ source: input.source === "codex" ? "Codex" : "Claude Code", text: "本次授权的测试片段" }],
  }));
  handle("ai-dialogue-load", () => ({ scope, defaultModel: model.id, models: [model], sessions: dialogueSessions, legacySessions: [], sidebarSources: true, sidebarConversationModes: true }));
  handle("ai-dialogue-model", () => ({ scope, defaultModel: model.id, models: [model] }));
  let savedConversationMode = "ask";
  handle("ai-dialogue-sidebar-mode", (_event, { conversationId, mode }) => {
    assert.equal(conversationId, threadId);
    savedConversationMode = mode;
    return { scope, conversation, conversationMode: savedConversationMode };
  });
  handle("ai-dialogue-history-list", () => ({ scope, sessions: dialogueSessions }));
  handle("ai-dialogue-channels-list", () => ({ scope, items: [] }));
  handle("ai-dialogue-sidebar-source", () => ({ scope, title: "杭州周末笔记", text: "妈妈喜欢清泉茶馆的窗边位置。" }));
  handle("ai-dialogue-sidebar-source-list", (_event, { kind, parent }) => ({ scope,
    ...(kind === "space" ? { folder: { id: parent, name: "旅行笔记" }, parent: "",
      folders: parent ? [] : [{ id: "trip", name: "旅行笔记" }] } : {}),
    ...(kind === "starlink" ? { warehouses: [{ id: "trips", name: "旅途" }] } : {}),
    ...(kind === "memory" ? { agents: [{ id: "claude_code", name: "Claude Code" }] } : {}),
  }));
  handle("ai-dialogue-release-context", () => ({ scope }));
  handle("ai-dialogue-watch", () => ({}));
  handle("ai-dialogue-unwatch", () => ({}));
  handle("ai-dialogue-usage", () => ({}));
  handle("ai-dialogue-send", async (_event, { prompt }) => {
    const pendingSend = heldDialogueSend;
    heldDialogueSend = null;
    if (pendingSend) await pendingSend.promise;
    messages.push({ role: "user", content: prompt });
    return { scope, threadId, conversation, model: model.id };
  });
  handle("ai-dialogue-open", (_event, { trackOpened } = {}) => {
    const current = dialogueSessions.find(row => row.thread_id === threadId && row.unread);
    if (trackOpened && current) current.unread = false;
    return { scope, conversation, history: { thread_id: threadId, model_ref: model.id, messages }, conversationMode: savedConversationMode,
      ...(trackOpened && current && { channelReadThrough: current.last_active }) };
  });
  ipcMain.handle("wanx:discovery:bluetooth-state", () => ({ status: "available" }));
  ipcMain.handle("wanx:setup:state", () => ({ ok: true, value: { state: "idle" } }));
}

async function assertApplicationTabPosition(bannerSelector, contentSelector) {
  const positions = await run("(" + function(bannerSelector, contentSelector) {
    const banner = document.querySelector(bannerSelector);
    const tabs = document.querySelector(".applications-tabs");
    const content = document.querySelector(contentSelector);
    if (!banner || !tabs || !content) return null;
    const follows = (first, second) => Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
    const rect = element => element.getBoundingClientRect().toJSON();
    const controls = banner.querySelectorAll('.applications-tabs button, [data-action="market-refresh"], [data-action="workshop-refresh"]');
    const controlsReachable = [...controls].every(control => {
      const { left, top, width, height } = control.getBoundingClientRect();
      return width > 0 && height > 0 && control.contains(document.elementFromPoint(left + width / 2, top + height / 2));
    });
    return {
      inOrder: banner.contains(tabs) && follows(banner, content),
      banner: rect(banner), tabs: rect(tabs), content: rect(content),
      controlsReachable,
    };
  } + ")(" + JSON.stringify(bannerSelector) + "," + JSON.stringify(contentSelector) + ")");
  assert(positions && positions.inOrder && positions.controlsReachable &&
    positions.banner.height > 0 && positions.tabs.height > 0 && positions.content.height > 0 &&
    positions.tabs.left >= positions.banner.left - 1 && positions.tabs.right <= positions.banner.right + 1 &&
    positions.tabs.top >= positions.banner.top - 1 && positions.tabs.bottom <= positions.banner.bottom + 1 &&
    positions.banner.bottom <= positions.content.top + 1,
    "the category tabs are contained within the banner above the content: " + JSON.stringify(positions));
}

async function assertWorkbenchPlacement(adjacentSelector) {
  const { geometry, ...placement } = await run("(" + function(noteSelector, adjacentSelector) {
    const entries = [...document.querySelectorAll(noteSelector)];
    const entry = entries[0];
    const next = entry?.nextElementSibling;
    const adjacent = next?.matches(adjacentSelector) ? next : next?.querySelector(adjacentSelector);
    const noteBounds = entry?.getBoundingClientRect();
    const actionBounds = adjacent?.getBoundingClientRect();
    const sidebar = activeSidebar();
    const hit = (element, bounds) => bounds && !element.disabled && element.contains(document.elementFromPoint(
      bounds.left + bounds.width / 2, bounds.top + bounds.height / 2,
    ));
    const aligned = noteBounds && actionBounds &&
      noteBounds.right <= actionBounds.left + 1 && noteBounds.top < actionBounds.bottom &&
      actionBounds.top < noteBounds.bottom;
    const compactStack = noteBounds && actionBounds && innerWidth < 600 && sidebar &&
      noteBounds.bottom <= actionBounds.top + 1 && Math.abs(noteBounds.right - actionBounds.right) <= 1;
    return {
      count: entries.length,
      inSpaceBanner: Boolean(entry?.closest('.wanx-section-banner[data-section="space"] .wanx-section-actions')),
      adjacent: Boolean(aligned || compactStack),
      actionsReachable: Boolean((entry?.disabled || hit(entry, noteBounds)) && hit(adjacent, actionBounds)),
      geometry: { width: innerWidth, height: innerHeight, sidebar,
        note: noteBounds?.toJSON(), action: actionBounds?.toJSON() },
    };
  } + ")(" + JSON.stringify(workbenchButton) + "," + JSON.stringify(adjacentSelector) + ")");
  assert.deepEqual(placement, { count: 1, inSpaceBanner: true, adjacent: true, actionsReachable: true },
    "the workbench belongs directly before the Space banner action, with both reachable: " +
    JSON.stringify(geometry));
}

async function verifyZhijunMemory() {
  const modal = ".zhijun-memory";
  const invoke = selector => run(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const contains = text => run(`document.querySelector(${JSON.stringify(modal)}).textContent.includes(${JSON.stringify(text)})`);
  hostState = { ...baseState, notifications: { unreadCount: 1, items: [{
    id: "old-application", category: "application", applicationId: expertAppRecords.office.applicationId,
    title: "历史通知", body: "以前收到的应用通知", createdAt: Date.now(),
  }] } };
  send("state", hostState);
  send("navigate", "notifications");
  await until(() => run('Boolean(document.querySelector("[data-action=notifications-select]"))'), "legacy notification");
  await invoke("[data-action=notifications-select]");
  assert.equal(await run('Boolean(document.querySelector("[data-action=notifications-open]"))'), false);
  send("workshop-source", expertAppRecords.office.applicationId);
  for (const old of ["applications", "workshop", "application-detail"]) send("navigate", old);
  assert.equal(await run('Boolean(document.querySelector(".notification-page"))'), true);
  assert.equal(await run('Boolean(document.querySelector(".applications-tabs, [data-action=show-applications], [aria-label=应用工坊]"))'), false);
  hostState = baseState;
  send("state", hostState);
  send("navigate", "memory");
  await until(() => run('Boolean(document.querySelector(".memory-banner h2"))'), "agent memory banner");
  assert.equal(await run('document.querySelector(".memory-banner h2").firstChild.textContent.trim()'), "智能体记忆");
  assert.equal(await run('document.querySelector(".memory-banner .wanx-section-english").textContent'), "agent memory");
  send("navigate", "my-ai");
  await invoke(assistantButton);
  await waitForPanel("assistant");
  await waitForEdge(true);
  await until(() => run('Boolean(document.querySelector("[data-chat-action=quick-remember]"))'), "Zhijun memory entry");
  assert.equal(await run('!!document.querySelector("[data-chat-action=memory]")'), false);
  assert(await run('document.querySelector("#academy-drawer").textContent.includes("记忆智能体")'));
  assert(await run('getComputedStyle(document.querySelector(".ai-zhijun-dialogue .ai-page-title")).display === "none"'));
  const modeTrigger = '[data-chat-action="modes"]';
  assert(await run('document.querySelector(".ai-model-section").nextElementSibling.classList.contains("ai-mode-setting")'));
  await until(() => run(`!document.querySelector('${modeTrigger}').disabled`), "mode control is ready");
  const modelTrigger = '[data-chat-action="models"]';
  for (const selector of [modelTrigger, modeTrigger]) {
    assert.deepEqual(await run(`(() => {
      const button = document.querySelector('${selector}');
      return [button.textContent.trim(), button.offsetWidth, button.offsetHeight];
    })()`), ["", 28, 28]);
  }
  await invoke(modelTrigger);
  await until(() => run('!document.querySelector("[data-chat-model-picker]").hidden'), "model picker");
  assert(await run('document.activeElement.matches("[data-chat-model-search]")'));
  assert(await run('document.querySelector("[data-chat-model-default] [aria-pressed=true]").textContent.includes("跟随默认")'));
  await run(`(() => {
    const search = document.querySelector("[data-chat-model-search]");
    search.value = "invalid test search";
    search.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  assert.equal(await run('document.querySelectorAll("[data-chat-model-options] button").length'), 0);
  await run('document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
  assert(await run('document.querySelector("[data-chat-model-picker]").hidden && document.activeElement.matches("[data-chat-action=models]")'));
  await invoke(modeTrigger);
  assert.deepEqual(await run('[...document.querySelectorAll("[data-mode-panel] strong")].map(option => option.textContent)'), ["普通模式", "高级模式"]);
  assert(await run('document.querySelector("[data-mode-compatibility]").hidden'));
  await invoke('[data-chat-action="select-mode"][data-id="ask"]');
  await invoke('[data-chat-action="quick-remember"]');
  assert(await run('document.querySelector("[data-chat-notice]").textContent.includes("切到高级模式")'));
  assert.equal(await run('document.querySelector(".zhijun-memory").open'), false);
  await invoke(modeTrigger);
  await invoke('[data-chat-action="select-mode"][data-id="craft"]');
  assert.match(await run(`document.querySelector('${modeTrigger}').title`), /高级模式/);
  assert.deepEqual(await run(
    '[...document.querySelectorAll(".ai-zhijun-source[aria-pressed=true]")].map(button => button.textContent)'
  ), ["空间", "星图", "智能体记忆"]);
  const memorySource = '[data-source-key="memory"]';
  await until(() => run('!document.querySelector("[data-source-key=memory]").disabled'), "source choices");
  await invoke(memorySource);
  assert.equal(await run('document.querySelector("[data-source-key=memory]").getAttribute("aria-pressed")'), "false");
  await invoke(memorySource);

  await invoke(".ai-zhijun-scope > summary");
  assert.equal(await run('document.querySelector("#academy-dialogue [data-context-summary]")'), null);
  for (const [kind, id] of [["space", "trip"], ["starlink", "trips"], ["memory", "claude_code"]]) {
    const trigger = `[data-chat-action="source-settings"][data-source-key="${kind}"]`;
    if (kind !== "space") await invoke(trigger);
    else {
      await invoke(trigger);
      await until(() => run('!!document.querySelector("[data-chat-action=source-browse]")'), "folder listing");
      await invoke('[data-chat-action="source-browse"][data-id="trip"]');
    }
    const choice = `[data-chat-action="source-select"][data-id="${id}"]`;
    await until(() => run(`!!document.querySelector('${choice}')`), `scope selection: ${kind}`);
    await invoke(choice);
    assert.equal(await run('document.querySelector("[data-zhijun-picker]").open'), false);
  }
  await invoke(".ai-zhijun-scope > summary");

  await invoke('[data-chat-action="quick-remember"]');
  assert(await run('!!document.querySelector(".zhijun-memory[open] textarea")'));
  assert(await run('document.activeElement.matches(".zhijun-memory textarea")'));
  assert(await run('getComputedStyle(document.querySelector(".zhijun-memory [data-memory-search]")).display === "none"'));
  assert.equal(await run('!!document.querySelector("[data-chat-action=find-material]")'), false);
  await run(`document.querySelector('${modal} textarea').value = '小林下周搬去杭州。'`);
  await invoke(modal + " [data-memory-submit]");
  await until(() => contains("已记住。"), "memory write confirmation");
  await invoke(modal + " [data-memory-action=close]");
  await waitForEdge(true);

  const nextChat = '[data-chat-action="new"]';
  await invoke("#academy-drawer " + nextChat);
  await until(() => run('document.activeElement.matches("[data-chat-input]")'), "new dialogue is ready");
  assert.match(await run(`document.querySelector('${modeTrigger}').title`), /普通模式/);
  await enterDraft("找回，小林");
  await run('document.querySelector("[data-chat-composer]").requestSubmit()');
  await until(() => contains("小林下周搬去杭州"), "recall from a new chat");
  assert.equal(await run('document.querySelector(".zhijun-memory [data-memory-action=correct]")'), null);
  await invoke(modal + " [data-memory-action=close]");
  await invoke(modeTrigger);
  await invoke('[data-chat-action="select-mode"][data-id="craft"]');
  await enterDraft("找回，小林");
  await run('document.querySelector("[data-chat-composer]").requestSubmit()');
  await until(() => run('!!document.querySelector(".zhijun-memory [data-memory-action=correct]")'), "memory correction is available in advanced mode");
  await invoke(modal + " [data-memory-action=correct]");
  await run(`document.querySelector('${modal} textarea').value = '小林下周搬去苏州。'`);
  await invoke(modal + " [data-memory-submit]");
  await until(() => contains("已更正。"), "memory correction");
  assert(await contains("小林下周搬去苏州"));
  await invoke(modal + " [data-memory-action=forget]");
  await until(() => contains("原聊天和 Memmy 源记录仍保留"), "forget confirmation");
  await invoke(modal + " [data-memory-action=forget-confirm]");
  await until(() => contains("已从知君长期记忆移除"), "memory removed");
  assert.equal(await run(`document.querySelectorAll('${modal} article').length`), 0);

  await invoke(modal + " [data-memory-action=external]");
  await until(() => run(`!document.querySelector('${modal} [data-memory-external]').hidden`), "external search form");
  await run(`document.querySelector('${modal} [data-memory-external] [name=query]').value = '测试'`);
  await run(`document.querySelector('${modal} [data-memory-external]').requestSubmit()`);
  await until(() => contains("来自 Memmy · Codex"), "authorized read-only external result");
  await invoke(modal + " [data-memory-action=cancel-external]");
  assert.equal(await run(`document.querySelectorAll('${modal} article').length`), 0);
  await invoke(modal + " [data-memory-action=close]");

  assert.equal(await run('!!document.querySelector("[data-chat-history-list] .ai-history-source[data-source=weixin]")'), false);
  dialogueSessions = [{ thread_id: threadId, title: "杭州周末", channel_type: "weixin", last_active: Date.now() / 1000, unread: true }];
  await invoke('[data-chat-action="history"]');
  await until(() => run('!!document.querySelector("[data-chat-history-list] .ai-history-source[data-source=weixin]")'), "new WeChat conversation appears when opening history");
  assert(await run('document.querySelector("[data-chat-history-list]").textContent.includes("杭州周末")'));
  assert.equal(await run('document.querySelector("[data-history-unread]").textContent'), "1");
  assert(await run('!!document.querySelector(".ai-history-unread-dot")'));
  await invoke('[data-chat-action="history-close"]');
  assert(await run('!document.querySelector("[data-history-unread]").hidden'));

  messages.push(
    { role: "user", content: "上次在杭州去了哪家茶馆？", zhijun_evidence: [
      { source: "space", title: "杭州周末笔记", text: "清泉茶馆", file_id: "a".repeat(32) },
    ] },
    { role: "assistant", content: "上次去的是清泉茶馆。" },
  );
  await invoke(assistantButton);
  await waitForPanel(null);
  await invoke(assistantButton);
  await waitForPanel("assistant");
  await waitForEdge(true);
  await until(() => run('!!document.querySelector("[data-chat-action=continue-recent]")'), "recent dialogue");
  await invoke('[data-chat-action="continue-recent"]');
  await until(() => run('document.querySelector("[data-history-unread]").hidden'), "opening the WeChat conversation clears its badge");
  await invoke(modeTrigger);
  await invoke('[data-chat-action="select-mode"][data-id="craft"]');
  await until(() => run(`document.querySelector('${modeTrigger}').title.includes("高级模式")`), "selected mode saved on the conversation");
  await until(() => run('!!document.querySelector(".ai-zhijun-evidence summary")'), "evidence on resumed answer");
  await invoke(".ai-zhijun-evidence summary");
  assert(await run('document.querySelector(".ai-zhijun-evidence details").open'));
  await invoke('[data-chat-action="evidence-source"]');
  await until(() => run('document.querySelector("[data-chat-artifact-dialog]").open'), "source preview");
  assert(await run('document.querySelector("[data-artifact-content]").textContent.includes("窗边位置")'));
  await invoke('[data-chat-action="close-artifact"]');
  await invoke('[data-assistant-channels]');
  await until(() => run('document.querySelector(".ai-channels-dialog[open] .ai-channel-catalog")?.textContent.includes("企业微信")'), "phone channel catalog");
  assert(await run('document.querySelector(".ai-channels-dialog h3").textContent.includes("在手机上用知君")'));
  await invoke('[data-channel-action="close"]');
  await invoke("#academy-drawer " + nextChat);
  await until(() => run('!!document.querySelector("[data-chat-action=quick-remember]")'), "clean welcome");
  assert.match(await run(`document.querySelector('${modeTrigger}').title`), /普通模式/);
  await invoke('[data-chat-action="continue-recent"]');
  await until(() => run(`document.querySelector('${modeTrigger}').title.includes("高级模式")`), "mode restored when reopening the saved conversation");
  await invoke("#academy-drawer " + nextChat);
  await until(() => run('document.activeElement.matches("[data-chat-input]")'), "new dialogue is ready again");
  messages.length = 0;
  dialogueSessions = [];
  await invoke(assistantButton);
  await waitForPanel(null);
}

async function verifyMultipleNotes() {
  noteBlocks = [{ type: "text", text: "原来的共享便签" }];
  await click('[data-action="show-space"]');
  await until(() => run(`Boolean(document.querySelector(${JSON.stringify(noteButton)}))`), "Space note entry");
  await click(assistantButton);
  await waitForPanel("assistant");
  await waitForEdge(true);
  await click(noteButton);
  await waitForPanel("note");
  await until(() => run('getComputedStyle(document.querySelector("#super-clipboard")).opacity === "1"'), "note animation");
  await until(async () => await noteText() === "原来的共享便签", "original note");
  const fill = text => run(`(() => {
    const editor = document.querySelector(".clipboard-note-editor");
    editor.textContent = ${JSON.stringify(text)};
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  const select = label => run(`(() => {
    const picker = document.querySelector(".clipboard-note-switch select");
    picker.value = Array.from(picker.options).find(option => option.text === ${JSON.stringify(label)}).value;
    picker.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  const selectedTitle = () => run('document.querySelector(".clipboard-note-switch select").selectedOptions[0]?.text');
  const add = async text => {
    await click('[data-clip="create"]');
    await until(async () => await selectedTitle() === "未命名便签" && await noteText() === "", "new blank note");
    await fill(text);
    await until(async () => await selectedTitle() === text.split("\n")[0], "title based on the first line");
  };
  await add("周末安排\n周六看展");
  await add("采购清单\n咖啡豆");
  await select("周末安排");
  await until(async () => await noteText() === "周末安排\n周六看展", "switch to the first extra note");
  await run('document.querySelector(".clipboard-note-menu").open = true');
  await click('[data-clip="delete"]');
  assert.equal(extraNotes.size, 2, "deletion waits for confirmation");
  await click('[data-clip="confirm"]');
  await until(async () => await selectedTitle() === "原共享便签" && await noteText() === "原来的共享便签", "return to the preserved note after deleting");
  assert.equal(extraNotes.size, 1);
  await select("采购清单");
  await until(async () => await noteText() === "采购清单\n咖啡豆", "other extra note is intact");
}

const edgeGeometry = () => run(`(() => {
  const handle = document.querySelector("#academy-edge-handle");
  const drawer = document.querySelector("#academy-drawer");
  const mark = handle.querySelector(".academy-edge-mark");
  const image = mark.querySelector("img");
  const button = handle.getBoundingClientRect();
  const panel = drawer.getBoundingClientRect();
  return {
    viewport: innerWidth, handle: button.toJSON(), drawer: panel.toJSON(),
    inert: drawer.inert, expanded: handle.getAttribute("aria-expanded"),
    visible: getComputedStyle(drawer).visibility === "visible",
    seamWidth: getComputedStyle(handle, "::before").width,
    logoVisible: image.naturalWidth > 0 && getComputedStyle(image).visibility === "visible",
    logoBackground: getComputedStyle(mark).backgroundColor,
  };
})()`);

const waitForEdge = open => until(async () => {
  const edge = await edgeGeometry();
  return open
    ? edge.expanded === "true" && Math.abs(edge.drawer.right - edge.viewport) <= 1
    : edge.expanded === "false" && !edge.visible && Math.abs(edge.handle.right - edge.viewport) <= 1;
}, open ? "assistant aligned with the right edge" : "collapsed handle aligned with the right edge");

async function verifyAppearance() {
  await click('[data-action="show-space"]');
  await until(() => run(`Boolean(document.querySelector(${JSON.stringify(workbenchButton)}))`), "Space workbench entry");
  for (const [width, height] of [[760, 560], [560, 720], wideViewport()]) {
    window.setContentSize(width, height);
    await until(() => run(`Math.abs(innerWidth - ${width}) <= 1 && Math.abs(innerHeight - ${height}) <= 1`), "resized viewport");
    await assertWorkbenchPlacement(uploadControl);
    for (const theme of ["light", "dark"]) {
      nativeTheme.themeSource = theme;
      await until(() => run(`matchMedia("(prefers-color-scheme: dark)").matches === ${theme === "dark"}`), "system theme");
      for (const panel of ["assistant", "note"]) {
        const bannerRight = await run('document.querySelector(".space-files-page > .wanx-section-banner").getBoundingClientRect().right');
        await click(assistantButton);
        if (panel === "note") await click(noteButton);
        await waitForPanel(panel);
        await waitForEdge(true);
        if (panel === "note") {
          assert.equal(await run('Boolean(document.querySelector("#academy-note > #super-clipboard"))'), true);
        }
        await until(() => run(`Math.abs(document.querySelector("#academy-drawer").getBoundingClientRect().top -
          document.querySelector(".topbar").getBoundingClientRect().bottom) <= 1`), "sidebar aligned after resize");
        const geometry = await run("(" + function() {
          const element = document.querySelector("#academy-drawer");
          const bounds = element.getBoundingClientRect();
          const topbar = document.querySelector(".topbar").getBoundingClientRect();
          const banner = document.querySelector('.wanx-section-banner[data-section="space"]').getBoundingClientRect();
          const x = bounds.left + bounds.width / 2;
          const uninterrupted = [];
          for (let y = bounds.top + 2; y < bounds.bottom - 2; y += 20) {
            uninterrupted.push(element.contains(document.elementFromPoint(x, y)));
          }
          const title = document.querySelector("#academy-title").getBoundingClientRect();
          const caption = document.querySelector(".academy-title-caption").getBoundingClientRect();
          const noteTool = document.querySelector("#academy-note-tool").getBoundingClientRect();
          const close = document.querySelector("#academy-close").getBoundingClientRect();
          return { top: bounds.top, bottom: bounds.bottom, left: bounds.left, headerBottom: topbar.bottom,
            bannerBottom: banner.bottom, bannerRight: banner.right, viewportBottom: innerHeight,
            viewportWidth: innerWidth, toolbarOrder: Math.max(title.right, caption.right) <= noteTool.left && noteTool.right <= close.left, uninterrupted };
        } + ")()");
        if (process.env.WANX_SIDEBAR_SCREENSHOTS) {
          await run("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
          await mkdir(process.env.WANX_SIDEBAR_SCREENSHOTS, { recursive: true });
          await writeFile(join(process.env.WANX_SIDEBAR_SCREENSHOTS,
            `fixture-space-${width}x${height}-${theme}-${panel}.png`), (await window.webContents.capturePage()).toPNG());
        }
        assert(geometry.bannerBottom > geometry.headerBottom + 40, "the Space banner is present in the fixture");
        const expectedTop = geometry.headerBottom;
        assert(Math.abs(geometry.top - expectedTop) <= 1,
          `${panel} starts below the global navigation, not below the Space banner: ${JSON.stringify(geometry)}`);
        assert(geometry.top < geometry.bannerBottom, "the Space banner cannot truncate the right sidebar");
        if (geometry.viewportWidth < 1320) {
          assert(Math.abs(geometry.bannerRight - bannerRight) <= 1, "Space keeps its normal banner width under the sidebar");
          assert(geometry.bannerRight > geometry.left, "the sidebar can cover the right side of the banner");
        }
        assert(geometry.toolbarOrder, "the drawer title, note tool and close button do not overlap");
        assert(Math.abs(geometry.bottom - geometry.viewportBottom) <= 1,
          "the sidebar continues to the bottom of the viewport");
        assert(geometry.uninterrupted.every(Boolean), "no toolbar, divider or file panel cuts through the sidebar");
        await until(() => run('document.querySelector("#academy-edge-handle img")?.complete === true'), "WANX Logo loading");
        const logo = await run("(" + function() {
          const image = document.querySelector("#academy-edge-handle img");
          const handle = image.closest(".academy-edge-mark");
          const bounds = image.getBoundingClientRect(), button = handle.getBoundingClientRect();
          return { src: image.getAttribute("src"), loaded: image.naturalWidth > 0,
            width: bounds.width, height: bounds.height,
            offsetX: bounds.left + bounds.width / 2 - button.left - button.width / 2,
            offsetY: bounds.top + bounds.height / 2 - button.top - button.height / 2,
            background: getComputedStyle(handle).backgroundColor,
            visible: getComputedStyle(image).visibility === "visible" && getComputedStyle(image).display !== "none" };
        } + ")()");
        assert.equal(logo.src, "./assets/centaurai-mark.png");
        assert.equal(logo.loaded, true);
        assert.equal(logo.width, 17);
        assert.equal(logo.height, 17);
        assert(Math.abs(logo.offsetX) <= 1 && Math.abs(logo.offsetY) <= 1, "the Logo stays centered in the entry");
        assert.equal(logo.visible, true);
        assert.notEqual(logo.background, "rgba(0, 0, 0, 0)", "the Logo has a solid contrasting surface in either system theme");
        await click("#academy-close");
        await waitForPanel(null);
        await waitForEdge(false);
      }
    }
  }
  await click('[data-action="space-mkdir"]');
  await until(() => run('Boolean(document.querySelector(".space-dialog"))'), "Space folder dialog");
  assert.equal(await run('Boolean(document.querySelector(".wanx-section-actions[inert] [data-action=space-workbench]"))'), true);
  assert.equal(await run('document.querySelector("#academy-edge-handle").hidden'), true);
  await click('[data-action="space-dialog-close"]');
  await until(() => run('!document.querySelector("#academy-edge-handle").hidden'), "sidebar entry after closing the dialog");
  await click(assistantButton);
  await click(noteButton);
  await waitForPanel("note");
  await click("#academy-close");
  await waitForPanel(null);
  nativeTheme.themeSource = "system";
  window.setContentSize(760, 560);
  await until(() => run("innerWidth === 760"), "initial viewport");
  await click('[data-action="show-my-ai"]');
  await until(() => run('!document.querySelector(".space-files-page")'), "initial Applications page");
}

async function verifySwitching() {
  assert.equal(await run('Boolean(document.querySelector("[data-action=clipboard-toggle]"))'), false);
  await click('[data-action="show-space"]');
  await until(() => run(`Boolean(document.querySelector(${JSON.stringify(workbenchButton)}))`), "Space workbench entry");
  await click(assistantButton);
  await waitForPanel("assistant");
  await until(() => run('document.querySelector("#academy-drawer [data-chat-input]")?.disabled === false'), "dialogue input");
  await enterDraft("未发送的小助理草稿");
  if (expectAcademyBridge) {
    await until(() => run('document.querySelector("#academy-page-help")?.hidden === false'), "default-on help");
    assert.equal(await run('document.querySelector("#academy-help-toggle").getAttribute("aria-pressed")'), "true");
    assert.equal(await run('document.querySelector("#academy-close-page-help").getAttribute("aria-label")'), "关闭记忆盒子帮助");
    await click("#academy-close-page-help");
    assert.equal(await run('document.querySelector("#academy-page-help").hidden'), true);
    assert.equal(await run('document.activeElement.id'), "academy-help-toggle");
    assert.equal(await shown("assistant"), true);
    assert.equal(await dialogueDraft(), "未发送的小助理草稿");
    await click("#academy-help-toggle");
    assert.equal(await run('document.querySelector("#academy-page-help").hidden'), false);
  } else {
    assert.equal(await run("typeof window.wanxAcademyCopilot"), "undefined");
    assert.equal(await run(`Array.from(document.querySelectorAll(
      "#academy-help-toggle, #academy-page-help, #academy-resource-tool"
    )).every(element => element.getClientRects().length === 0)`), true);
  }
  assert.equal(await run('document.querySelector("#academy-title").textContent'), "知君");
  assert.equal(await run('document.querySelector(".academy-title-caption").textContent'), "memory agent");
  assert.equal(await run('document.querySelector(".academy-toolbar [role=tablist]")'), null);
  assert.equal(await run('document.querySelector("#academy-note-tool span").textContent'), "便签");
  await click(noteButton);
  await waitForPanel("note");
  assert.equal(await run("document.activeElement.id"), "academy-note-tool");
  assert.equal(await run('document.querySelector("#academy-title").textContent'), "知君");
  assert.equal(await run('document.querySelector("#academy-note-tool span").textContent'), "返回对话");
  await waitForEditor();
  await holdNoteSave("便签文字和小助理草稿独立保存");
  await click(noteButton);
  assert.equal(await shown("note"), true, "stay on the note until the pending local save succeeds");
  releaseSave();
  await waitForPanel("assistant");
  assert.equal(await dialogueDraft(), "未发送的小助理草稿");
  assert.deepEqual(noteBlocks, [{ type: "text", text: "便签文字和小助理草稿独立保存" }]);
  await click(noteButton);
  await waitForPanel("note");
  await waitForEditor();
  assert.equal(await noteText(), "便签文字和小助理草稿独立保存");
  await key("Escape");
  await waitForPanel(null);
  assert.equal(await run('document.activeElement.id'), "academy-edge-handle");

  const [wideWidth, wideHeight] = wideViewport();
  window.setContentSize(wideWidth, wideHeight);
  await until(() => run(`Math.abs(innerWidth - ${wideWidth}) <= 1`), "wide viewport");
  await click(assistantButton);
  await waitForPanel("assistant");
  assert.equal(await run('parseFloat(getComputedStyle(document.querySelector("#app")).paddingRight) > 0'), wideWidth >= 1320);
  await click(noteButton);
  await waitForPanel("note");
  await waitForEditor();
  assert.equal(await run('parseFloat(getComputedStyle(document.querySelector("#app")).paddingRight) > 0'), wideWidth >= 1320);
}

async function verifySaveFailure() {
  await holdNoteSave("本机保存失败时仍留在便签");
  await click(noteButton);
  releaseSave("SECURE_STORAGE_WRITE_FAILED");
  await until(
    () => run('document.querySelector(".clipboard-note-error").textContent.includes("本机草稿保存失败")'),
    "local save failure",
  );
  assert.equal(await shown("note"), true);
  assert.equal(await noteText(), "本机保存失败时仍留在便签");
  await click(noteButton);
  await waitForPanel("assistant");
  assert.deepEqual(noteBlocks, [{ type: "text", text: "本机保存失败时仍留在便签" }]);

  await click(noteButton);
  await waitForPanel("note");
  await waitForEditor();
  await holdNoteSave("离开空间时保留未保存的便签");
  await click('[data-action="show-my-ai"]');
  releaseSave("SECURE_STORAGE_WRITE_FAILED");
  await until(() => run('document.querySelector(".clipboard-note-error").textContent.includes("本机草稿保存失败")'), "save error after navigation");
  await waitForPanel("note");
  await click('[data-action="show-space"]');
  await waitForPanel("note");
  await waitForEditor();
  assert.equal(await noteText(), "离开空间时保留未保存的便签");
  await click(noteButton);
  await waitForPanel("assistant");
  assert.deepEqual(noteBlocks, [{ type: "text", text: "离开空间时保留未保存的便签" }]);
}

async function verifyCompositionAndLatestIntent() {
  await click(noteButton);
  await waitForPanel("note");
  await waitForEditor();
  const keyboard = window.webContents.debugger;
  const previousWrites = noteWrites.length;
  await keyboard.sendCommand("Input.imeSetComposition", { text: "输入法", selectionStart: 3, selectionEnd: 3 });
  await key("Escape", { isComposing: true });
  await key("K", { ctrlKey: true, shiftKey: true, isComposing: true });
  assert.equal(await shown("note"), true, "IME shortcuts must leave the editor open");
  await run('document.querySelector("#academy-note-tool").click()');
  assert.equal(await shown("note"), true, "switching must wait for the current composition");
  assert.equal(noteWrites.length, previousWrites, "do not save unfinished composition");
  await keyboard.sendCommand("Input.insertText", { text: "输入法" });
  await waitForPanel("assistant");
  assert.match(noteWrites.at(-1).map(block => block.text).join(""), /输入法/);

  await click(noteButton);
  await waitForPanel("note");
  await waitForEditor();
  await holdNoteSave("快速切换以后保存");
  await click(noteButton);
  await key("Escape");
  releaseSave();
  await waitForPanel(null);
  await pause(250);
  assert.equal(await shown(null), true, "an earlier open request must not override the later Escape");
}

async function verifyHandoffAndOffline() {
  await click(assistantButton);
  await waitForPanel("assistant");
  assert.equal(await run('document.querySelector("#academy-drawer .ai-composer-more") === null'), true);
  assert.equal(await run(`document.querySelectorAll(
    '#academy-drawer [data-chat-action="transcribe-file"], #academy-drawer [data-chat-action="generate-image"]'
  ).length`), 0);
  await enterDraft("");
  await click(noteButton);
  await waitForPanel("note");
  await waitForEditor();
  send("ai-dialogue", {
    type: "handoff", scope, conversationId: null, draft: "托盘交接草稿",
    reference: "", attachments: [], model: model.id,
    context: { space: { enabled: false }, knowledge: { enabled: false, warehouses: [] } },
  });
  await waitForPanel("assistant");
  await until(async () => await dialogueDraft() === "托盘交接草稿", "tray handoff draft");
  window.setContentSize(430, 620);
  await until(() => run("innerWidth <= 430"), "narrow client");
  const actions = async () => run(`(() => {
    const footer = document.querySelector("#academy-dialogue .ai-composer-bottom");
    const primary = footer.querySelector("[data-zhijun-primary]");
    const shown = [...primary.querySelectorAll("button")].filter(item => item.getClientRects().length);
    const model = footer.querySelector("[data-chat-action=models]").getBoundingClientRect();
    const mode = footer.querySelector("[data-chat-action=modes]").getBoundingClientRect();
    const button = shown[0]?.getBoundingClientRect();
    const centered = rect => rect.top + rect.height / 2;
    return { text: shown.map(item => item.getAttribute("aria-label")), aligned: Boolean(button &&
      model.width > 0 && model.right <= mode.left && mode.right <= button.left &&
      Math.abs(centered(model) - centered(button)) <= 2 &&
      Math.abs(centered(mode) - centered(button)) <= 2),
      width: button?.width, height: footer.getBoundingClientRect().height };
  })()`);
  const idle = await actions();
  assert.deepEqual(idle.text, ["发送"]);
  await until(() => run(`(() => {
    const send = document.querySelector("[data-zhijun-primary] [data-chat-send]");
    return !send.disabled && getComputedStyle(send).backgroundColor === "rgb(166, 83, 63)";
  })()`), "enabled dark terracotta send button");
  assert.equal(idle.aligned, true);
  const request = heldDialogueSend = Promise.withResolvers();
  await run('document.querySelector("#academy-drawer [data-chat-composer]").requestSubmit()');
  try {
    await until(async () => (await actions()).text.includes("发送中"), "only the sending action is visible");
    assert.deepEqual(await actions(), { ...idle, text: ["发送中"] });
  } finally {
    request.resolve();
  }
  await until(async () => messages.length === 1 && await dialogueDraft() === "", "in-flight dialogue turn");
  assert.deepEqual(await actions(), { ...idle, text: ["停止"] });
  window.setContentSize(760, 560);
  if (!expectAcademyBridge) assert.equal(messages[0].content, "托盘交接草稿");
  await click(noteButton);
  await waitForPanel("note");
  const reply = "切换到便签时完成的回复";
  messages.push({ role: "assistant", content: reply });
  for (const event of [{ type: "token", content: reply }, { type: "done" }]) {
    send("ai-dialogue", { type: "assistant-event", scope, threadId, event });
  }
  send("navigate", "ai-dialogue");
  await waitForPanel("assistant");
  await until(() => run('document.querySelector("#academy-drawer .ai-answer-text")?.textContent.includes("切换到便签时完成的回复")'), "reply after switching back");
  assert.equal(messages.filter(message => message.role === "user").length, 1, "returning must not resubmit the turn");
  await key("Escape");
  await waitForPanel(null);
  assert.equal(await run('document.activeElement.id'), "academy-edge-handle");

  await click(assistantButton);
  await click(noteButton);
  await waitForPanel("note");
  await key("K", { metaKey: true, shiftKey: true });
  await waitForPanel(null);
  await click('[data-action="show-my-ai"]');
  await click(assistantButton);
  await click(noteButton);
  await waitForPanel("note");
  assert.equal(await run('Boolean(document.querySelector("#academy-note > #super-clipboard"))'), true);

  hostState = { ...baseState, phase: "idle", connection: null };
  send("state", hostState);
  await click('[data-action="show-space"]');
  await until(() => run('document.querySelector(".space-connect") !== null'), "offline Space");
  assert.equal(await run(`Boolean(document.querySelector(".wanx-section-actions " + ${JSON.stringify(connectControl)}))`), true);
  assert.equal(await run(`document.querySelector(${JSON.stringify(workbenchButton)}).disabled`), true);
  await waitForPanel("note");
  await waitForEditor();
  assert.equal(await noteText(), "快速切换以后保存");
}

async function verifyAccountSwitch() {
  await holdNoteSave("切换账号前的草稿");
  await click(noteButton);
  assert.equal(await shown("note"), true);
  hostState = { ...baseState, account: { ...baseState.account, accountId: "other-owner" } };
  send("state", hostState);
  await waitForPanel(null);
  assert.equal(await noteText(), "");
  releaseSave();
  await pause(250);
  assert.equal(await shown(null), true, "a delayed save must not reopen either panel under a new account");
  assert.equal(await noteText(), "");
}

async function verify() {
  await app.whenReady();
  try {
    mockIPC();
    let preload = join(dirname(renderer), "remote-preload.cjs");
    if (expectAcademyBridge || expectExpertApps) {
      let fixturePreload = await readFile(preload, "utf8");
      if (expectExpertApps) fixturePreload += `
        actions["expert-apps"] ??= input => ipcRenderer.invoke("wanx-client:expert-apps", input);
      `;
      if (expectAcademyBridge) fixturePreload += `
        contextBridge.exposeInMainWorld("wanxAcademyCopilot", {
          action: (method, input) => ipcRenderer.invoke("wanx-client:academy-copilot-action", method, input),
        });
      `;
      preload = join(app.getPath("userData"), "sidebar-fixture-preload.cjs");
      await writeFile(preload, fixturePreload);
    }
    window = new BrowserWindow({
      show: false, width: 760, height: 560, useContentSize: true,
      webPreferences: {
        preload,
        contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false,
      },
    });
    window.webContents.on("console-message", event => {
      if (event.level === "error") console.error(event.message);
    });
    await window.loadFile(join(renderer, "index.html"));
    window.webContents.debugger.attach("1.3");
    await until(() => run('Boolean(document.querySelector("[data-action=show-space]"))'), "main navigation");
    await run("(" + function() {
      window.activeSidebar = () => {
        const drawer = document.querySelector("#academy-drawer");
        const assistant = document.querySelector("#academy-assistant");
        const notePanel = document.querySelector("#academy-note");
        const note = document.querySelector("#super-clipboard");
        const open = element => element && !element.hidden && !element.inert;
        if (!open(drawer)) return null;
        const noteOpen = open(notePanel) && open(note);
        if (open(assistant) && noteOpen) return "both";
        if (open(assistant)) return "assistant";
        if (noteOpen) return "note";
        return null;
      };
      window.overlapSeen = false;
      new MutationObserver(() => {
        if (window.activeSidebar() === "both") window.overlapSeen = true;
      }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["hidden", "inert"], childList: true });
    } + ")()");
    if (testMultipleNotes) {
      await verifyMultipleNotes();
      console.log("WANX_SIDEBAR_UI_PASS");
      return;
    }
    await verifyZhijunMemory();
    await verifyAppearance();
    await verifySwitching();
    await verifySaveFailure();
    await verifyCompositionAndLatestIntent();
    await verifyHandoffAndOffline();
    await verifyAccountSwitch();
    assert.equal(await run("window.overlapSeen"), false, "both right sidebar panels were interactive at once");
    console.log("WANX_SIDEBAR_UI_PASS");
  } catch (error) {
    console.error(error);
    if (window && process.env.WANX_SIDEBAR_SCREENSHOTS) {
      await mkdir(process.env.WANX_SIDEBAR_SCREENSHOTS, { recursive: true });
      await writeFile(join(process.env.WANX_SIDEBAR_SCREENSHOTS, "fixture-failure.png"),
        (await window.webContents.capturePage()).toPNG());
    }
    process.exitCode = 1;
  } finally {
    window?.destroy();
    app.exit(process.exitCode || 0);
  }
}

void verify();
