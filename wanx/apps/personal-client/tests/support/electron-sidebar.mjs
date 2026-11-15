import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, nativeTheme } from "electron";

const renderer = process.env.WANX_SIDEBAR_RENDERER_DIR ||
  fileURLToPath(new URL("../../local-ui/renderer/", import.meta.url));
const noteButton = '[data-action="clipboard-toggle"]';
const uploadControl = 'summary[aria-label="上传到当前文件夹"]';
const connectControl = '[data-action="show-boxes"]';
const assistantButton = "#academy-edge-handle";
const model = { id: "fixture/model", name: "测试模型", provider: "fixture", input: ["text"] };
const scope = "fixture-dialogue";
const threadId = "fixture-thread";
const conversation = { id: threadId, revision: 1, context: {}, versions: [] };
const messages = [];
const editableApplicationId = "fixture.editable";
const expectExpertApps = process.env.WANX_TEST_EXPECT_EXPERT_APPS === "1";
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
const noteWrites = [];
let heldSave;
let releaseSave;
let window;

const run = source => window.webContents.executeJavaScript(source, true);
const send = (channel, value) => window.webContents.send("wanx-client:" + channel, value);
const noteSnapshot = () => ({
  items: [], tasks: [], boxId: "test-box", scope: "fixture-note",
  online: hostState.phase === "ready",
  note: { blocks: noteBlocks, revision: 1, phase: hostState.phase === "ready" ? "saved" : "offline" },
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
const waitForEditor = () => until(
  () => run('document.activeElement === document.querySelector(".clipboard-note-editor")'),
  "note editor focus",
);
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
  handle("space-refresh", () => ({ phase: "ready", scope: "fixture-space", tasks: [] }));
  handle("space-list", () => ({ items: [], breadcrumbs: [] }));
  handle("space-links-spaces", () => []);
  handle("space-links-requests", () => []);
  handle("space-links-mcp-state", () => ({}));
  handle("clipboard-snapshot", noteSnapshot);
  handle("clipboard-note-refresh", noteSnapshot);
  handle("clipboard-note-save", async (_event, { blocks }) => {
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
    if (owner === hostState.account.accountId) noteBlocks = blocks;
    return noteSnapshot();
  });
  handle("ai-dialogue-load", () => ({ scope, defaultModel: model.id, models: [model], sessions: [], legacySessions: [] }));
  handle("ai-dialogue-model", () => ({ scope, defaultModel: model.id, models: [model] }));
  handle("ai-dialogue-history-list", () => ({ scope, sessions: [] }));
  handle("ai-dialogue-release-context", () => ({ scope }));
  handle("ai-dialogue-watch", () => ({}));
  handle("ai-dialogue-unwatch", () => ({}));
  handle("ai-dialogue-usage", () => ({}));
  handle("ai-dialogue-send", (_event, { prompt }) => {
    messages.push({ role: "user", content: prompt });
    return { scope, threadId, conversation, model: model.id };
  });
  handle("ai-dialogue-open", () => ({
    scope, conversation, history: { thread_id: threadId, model_ref: model.id, messages },
  }));
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

async function verifyWorkshopTab() {
  const appsBanner = '.wanx-section-banner[data-section="apps"]';
  const workshopBanner = '.wanx-section-banner[data-section="workshop"]';
  const assertBannerActions = async (bannerSelector, refreshAction, title, updateLabel) => {
    const { appearance, ...banner } = await run("(" + function(selector, refreshAction) {
      const banner = document.querySelector(selector);
      const controls = banner.querySelector(".applications-banner-controls");
      const lastTab = controls.querySelector("#applications-tab-workshop").getBoundingClientRect();
      const refresh = controls.querySelector('.applications-banner-refresh[data-action="' + refreshAction + '"]');
      const update = refresh.getBoundingClientRect();
      const style = getComputedStyle(refresh);
      return {
        actions: [...controls.querySelectorAll("button")].map(button => button.dataset.action),
        title: banner.querySelector("h2")?.textContent.trim().split(/\s+/)[0],
        hasConnectionBadge: Boolean(banner.querySelector(".connection-line, .status-dot")),
        updateLabel: refresh.getAttribute("aria-label"),
        updateIconOnly: Boolean(refresh.querySelector("svg") && !refresh.textContent.trim()),
        updateOnRight: lastTab.right <= update.left + 1 && lastTab.top < update.bottom && update.top < lastTab.bottom,
        appearance: {
          width: update.width, height: update.height, radius: style.borderRadius,
          color: style.color, background: style.backgroundColor, gap: getComputedStyle(controls).columnGap,
          icon: refresh.querySelector("svg")?.innerHTML,
        },
      };
    } + ")(" + JSON.stringify(bannerSelector) + "," + JSON.stringify(refreshAction) + ")");
    assert.deepEqual(banner, {
      actions: ["applications-tab", "applications-tab", "applications-tab", refreshAction],
      title, hasConnectionBadge: false, updateLabel, updateIconOnly: true, updateOnRight: true,
    });
    return appearance;
  };
  assert.equal(await run("innerWidth"), 760);
  const tabs = await run(`Array.from(document.querySelectorAll('.applications-tabs [data-action="applications-tab"]'),
    tab => [tab.dataset.tab, tab.textContent.trim()])`);
  assert.deepEqual(tabs, [["wanx", "应用市场"], ["local", "我的应用"], ["workshop", "万象工坊"]]);
  assert.equal(await run('Boolean(document.querySelector(".main-nav [data-action=show-workshop]"))'), false);
  await until(() => run('document.querySelector(\'[data-action="market-refresh"]\')?.disabled === false'), "market refresh ready");
  await assertApplicationTabPosition(appsBanner, "#applications-panel-wanx");
  const marketActions = await assertBannerActions(appsBanner, "market-refresh", "万象应用", "检查更新");
  await click(assistantButton);
  await waitForPanel("assistant");
  await assertApplicationTabPosition(appsBanner, "#applications-panel-wanx");
  await click(assistantButton);
  await waitForPanel(null);
  await click("#applications-tab-local");
  await until(() => run('Boolean(document.querySelector("#applications-panel-local"))'), "My Apps tab");
  await assertApplicationTabPosition(appsBanner, "#applications-panel-local");
  assert.deepEqual(await assertBannerActions(appsBanner, "market-refresh", "万象应用", "检查更新"),
    marketActions);
  await click("#applications-tab-wanx");
  await until(() => run('Boolean(document.querySelector("#applications-panel-wanx"))'), "Applications Market tab");
  await click("#applications-tab-workshop");
  await until(() => run('document.querySelector("#applications-panel-workshop")?.getAttribute("aria-label") === "万象工坊"'),
    "Workshop in Applications");
  assert.equal(await run('document.querySelector(".main-nav [aria-current=page]").dataset.action'), "show-applications");
  assert.equal(await run('document.querySelector(".applications-tabs [aria-selected=true]").id'), "applications-tab-workshop");
  assert.equal(await run('document.activeElement.id'), "applications-tab-workshop");
  await until(() => run('document.querySelector(\'[data-action="workshop-refresh"]\')?.disabled === false'), "Workshop refresh ready");
  await assertApplicationTabPosition(workshopBanner, "#applications-panel-workshop .workshop-layout");
  assert.deepEqual(await assertBannerActions(workshopBanner, "workshop-refresh", "万象工坊", "刷新工坊"),
    marketActions);
  await click("#applications-tab-wanx");
  await until(() => run('Boolean(document.querySelector("#applications-panel-wanx"))'), "return to Applications market");

  send("workshop-source", editableApplicationId);
  await until(() => run('Boolean(document.querySelector(\'#applications-panel-workshop [aria-label="创建定制副本"] [data-action="workshop-copy"]:enabled\'))'),
    "native Workshop source handoff");
  await click('[data-action="workshop-cancel"]');
  await until(() => run('!document.querySelector(".workshop-shade")'), "close source handoff dialog");
  await click("#applications-tab-wanx");
  await until(() => run('Boolean(document.querySelector("#applications-panel-wanx"))'), "return after source handoff");
}

async function verifyMergedExpertApps() {
  const officeCard = `[data-application="${expertAppRecords.office.applicationId}"]`;
  const crmCard = `[data-application="${expertAppRecords["ai-crm"].applicationId}"]`;
  const crmOffer = '[data-expert-app="ai-crm"]';
  const find = selector => run(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
  const count = selector => run(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
  const scrollClick = async selector => {
    await run(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: "center" })`);
    await click(selector);
  };

  await click("#applications-tab-local");
  await until(() => find(`#applications-panel-local ${officeCard}`), "installed app in My Apps");
  if (!expectExpertApps) {
    assert.equal(await count(officeCard), 1);
    assert.equal(await find('#applications-panel-local [aria-label="可添加的应用"]'), false);
    assert.equal(await find(`${officeCard} [data-action="expert-installed-workshop"]`), false);
    await scrollClick(`${officeCard} [data-action="applications-launch"]`);
    await until(() => appLaunches.includes(expertAppRecords.office.applicationId), "open installed app without Expert API");
    await click("#applications-tab-wanx");
    await until(() => find("#applications-panel-wanx"), "return after My Apps verification");
    return;
  }
  await until(() => find(`#applications-panel-local ${crmOffer}`), "addable apps in My Apps");
  assert.equal(await find('#applications-panel-local [aria-label="可添加的应用"]'), true);
  assert.equal(await count(officeCard), 1);
  assert.equal(await count('[data-expert-app="office"]'), 0, "the installed app should not have an offer card");
  assert.equal(await count(crmCard), 0, "an available app does not belong to the installed list");

  await scrollClick(`${officeCard} [data-action="expert-installed-workshop"]`);
  await until(() => expertAppCalls.some(([action, input]) => action === "workshop-installed" &&
    input.applicationId === expertAppRecords.office.applicationId), "installed app demo action");
  await scrollClick(`${crmOffer} [data-action="expert-app-workshop"]`);
  await until(() => expertAppCalls.some(([action, input]) => action === "workshop" && input.id === "ai-crm"),
    "addable app demo action");
  await scrollClick(`${crmOffer} [data-action="expert-app-install"]`);
  await until(() => expertAppCalls.some(([action, input]) => action === "install" && input.id === "ai-crm"),
    "add app action");
  await until(() => find(crmCard), "installed CRM in My Apps");
  assert.equal(await count(crmCard), 1);
  assert.equal(await count(crmOffer), 0, "the added app moved to the installed list");
  await scrollClick(`${crmCard} [data-action="applications-launch"]`);
  await until(() => appLaunches.includes(expertAppRecords["ai-crm"].applicationId), "open added application");
  await click('.main-nav [data-action="show-applications"]');
  await until(() => find("#applications-panel-wanx"), "return after My Apps verification");
}

async function assertNotePlacement(adjacentSelector) {
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
      bothClickable: Boolean(hit(entry, noteBounds) && hit(adjacent, actionBounds)),
      geometry: { width: innerWidth, height: innerHeight, sidebar,
        note: noteBounds?.toJSON(), action: actionBounds?.toJSON() },
    };
  } + ")(" + JSON.stringify(noteButton) + "," + JSON.stringify(adjacentSelector) + ")");
  assert.deepEqual(placement, { count: 1, inSpaceBanner: true, adjacent: true, bothClickable: true },
    "the single Note entry belongs directly before the Space banner action, with both reachable: " +
    JSON.stringify(geometry));
}

async function verifyAppearance() {
  await click('[data-action="show-space"]');
  await until(() => run('Boolean(document.querySelector("[data-action=clipboard-toggle]"))'), "Space note entry");
  for (const [width, height] of [[760, 560], [560, 720], [1440, 750]]) {
    window.setContentSize(width, height);
    await until(() => run(`innerWidth === ${width} && innerHeight === ${height}`), "resized viewport");
    await assertNotePlacement(uploadControl);
    for (const theme of ["light", "dark"]) {
      nativeTheme.themeSource = theme;
      await until(() => run(`matchMedia("(prefers-color-scheme: dark)").matches === ${theme === "dark"}`), "system theme");
      for (const panel of ["assistant", "note"]) {
        await click(panel === "assistant" ? assistantButton : noteButton);
        await waitForPanel(panel);
        if (panel === "note") {
          await until(() => run('getComputedStyle(document.querySelector("#super-clipboard")).opacity === "1"'), "note animation");
        }
        await assertNotePlacement(uploadControl);
        const geometry = await run("(" + function(panel) {
          const element = document.querySelector(panel === "assistant" ? "#academy-drawer" : "#super-clipboard");
          const bounds = element.getBoundingClientRect();
          const topbar = document.querySelector(".topbar").getBoundingClientRect();
          const banner = document.querySelector('.wanx-section-banner[data-section="space"]').getBoundingClientRect();
          const x = bounds.left + bounds.width / 2;
          const uninterrupted = [];
          for (let y = bounds.top + 2; y < bounds.bottom - 2; y += 20) {
            uninterrupted.push(element.contains(document.elementFromPoint(x, y)));
          }
          return { top: bounds.top, bottom: bounds.bottom, headerBottom: topbar.bottom,
            bannerBottom: banner.bottom, viewportBottom: innerHeight, uninterrupted };
        } + ")(" + JSON.stringify(panel) + ")");
        if (process.env.WANX_SIDEBAR_SCREENSHOTS) {
          await mkdir(process.env.WANX_SIDEBAR_SCREENSHOTS, { recursive: true });
          await writeFile(join(process.env.WANX_SIDEBAR_SCREENSHOTS,
            `fixture-space-${width}x${height}-${theme}-${panel}.png`), (await window.webContents.capturePage()).toPNG());
        }
        assert(geometry.bannerBottom > geometry.headerBottom + 40, "the Space banner is present in the fixture");
        const expectedTop = geometry.headerBottom + (panel === "note" ? 10 : 0);
        assert(Math.abs(geometry.top - expectedTop) <= 1,
          `${panel} starts below the global navigation, not below the Space banner: ${JSON.stringify(geometry)}`);
        assert(geometry.top < geometry.bannerBottom, "the Space banner cannot truncate the right sidebar");
        assert(Math.abs(geometry.bottom - geometry.viewportBottom + (panel === "note" && width > 600 ? 12 : 0)) <= 1,
          "the sidebar continues to the bottom of the viewport");
        assert(geometry.uninterrupted.every(Boolean), "no toolbar, divider or file panel cuts through the sidebar");
        await until(() => run('document.querySelector("#academy-edge-handle img")?.complete === true'), "WANX Logo loading");
        const logo = await run("(" + function() {
          const image = document.querySelector("#academy-edge-handle img");
          const handle = image.parentElement;
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
        assert.equal(logo.width, 20);
        assert.equal(logo.height, 20);
        assert(Math.abs(logo.offsetX) <= 1 && Math.abs(logo.offsetY) <= 1, "the Logo stays centered in the entry");
        assert.equal(logo.visible, true);
        assert.notEqual(logo.background, "rgba(0, 0, 0, 0)", "the Logo has a solid contrasting surface in either system theme");
        await click(panel === "assistant" ? assistantButton : '[data-clip="close"]');
        await waitForPanel(null);
      }
    }
  }
  await click('[data-action="space-mkdir"]');
  await until(() => run('Boolean(document.querySelector(".space-dialog"))'), "Space folder dialog");
  const noteBlocked = 'Boolean(document.querySelector(".wanx-section-actions [data-action=clipboard-toggle]:disabled, .wanx-section-actions[inert] [data-action=clipboard-toggle]"))';
  assert.equal(await run(noteBlocked), true);
  assert.equal(await run('document.querySelector("#academy-edge-handle").hidden'), true);
  await click('[data-action="space-dialog-close"]');
  await until(() => run(`!${noteBlocked} && !document.querySelector("#academy-edge-handle").hidden`), "sidebar entries after closing the dialog");
  await click(noteButton);
  await waitForPanel("note");
  await until(() => run('getComputedStyle(document.querySelector("#super-clipboard")).opacity === "1"'), "note animation after the dialog");
  await click('[data-clip="close"]');
  await waitForPanel(null);
  nativeTheme.themeSource = "system";
  window.setContentSize(760, 560);
  await until(() => run("innerWidth === 760"), "initial viewport");
  await click('[data-action="show-applications"]');
  await until(() => run('!document.querySelector("[data-action=clipboard-toggle]")'), "initial Applications page");
}

async function verifySwitching() {
  assert.equal(await run('Boolean(document.querySelector("[data-action=clipboard-toggle]"))'), false);
  await click('[data-action="show-space"]');
  await until(() => run('Boolean(document.querySelector("[data-action=clipboard-toggle]"))'), "Space note entry");
  await click(assistantButton);
  await waitForPanel("assistant");
  await until(() => run('document.querySelector("#academy-drawer [data-chat-input]")?.disabled === false'), "dialogue input");
  await enterDraft("未发送的小助理草稿");
  if (expectAcademyBridge) {
    await until(() => run('document.querySelector("#academy-page-help")?.hidden === false'), "default-on help");
    assert.equal(await run('document.querySelector("#academy-help-toggle").getAttribute("aria-pressed")'), "true");
    assert.equal(await run('document.querySelector("#academy-close-page-help").getAttribute("aria-label")'), "关闭万象帮助");
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
      "#academy-help-toggle, #academy-page-help, #academy-tab-academy"
    )).every(element => element.getClientRects().length === 0)`), true);
  }
  await assertNotePlacement(uploadControl);
  await click(noteButton);
  await waitForPanel("note");
  await waitForEditor();
  await holdNoteSave("便签文字和小助理草稿独立保存");
  await click(assistantButton);
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
  assert.equal(await run('document.activeElement.matches("[data-action=clipboard-toggle]")'), true);

  window.setContentSize(1440, 750);
  await until(() => run("innerWidth >= 1320"), "wide viewport");
  await click(assistantButton);
  await waitForPanel("assistant");
  assert.equal(await run('parseFloat(getComputedStyle(document.querySelector("#app")).paddingRight) > 0'), true);
  await assertNotePlacement(uploadControl);
  await click(noteButton);
  await waitForPanel("note");
  await waitForEditor();
  assert.equal(await run('getComputedStyle(document.querySelector("#app")).paddingRight'), "0px");
}

async function verifySaveFailure() {
  await holdNoteSave("本机保存失败时仍留在便签");
  await click(assistantButton);
  releaseSave("SECURE_STORAGE_WRITE_FAILED");
  await until(
    () => run('document.querySelector(".clipboard-note-error").textContent.includes("本机草稿保存失败")'),
    "local save failure",
  );
  assert.equal(await shown("note"), true);
  assert.equal(await noteText(), "本机保存失败时仍留在便签");
  await click(assistantButton);
  await waitForPanel("assistant");
  assert.deepEqual(noteBlocks, [{ type: "text", text: "本机保存失败时仍留在便签" }]);

  await click(noteButton);
  await waitForPanel("note");
  await waitForEditor();
  await holdNoteSave("离开空间时保留未保存的便签");
  await click('[data-action="show-applications"]');
  releaseSave("SECURE_STORAGE_WRITE_FAILED");
  await waitForPanel(null);
  await click('[data-action="show-space"]');
  await click(noteButton);
  await waitForPanel("note");
  await waitForEditor();
  assert.equal(await noteText(), "离开空间时保留未保存的便签");
  await click(assistantButton);
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
  await run('document.querySelector("#academy-edge-handle").click()');
  assert.equal(await shown("note"), true, "switching must wait for the current composition");
  assert.equal(noteWrites.length, previousWrites, "do not save unfinished composition");
  await keyboard.sendCommand("Input.insertText", { text: "输入法" });
  await waitForPanel("assistant");
  assert.match(noteWrites.at(-1).map(block => block.text).join(""), /输入法/);

  await click(noteButton);
  await waitForPanel("note");
  await waitForEditor();
  await holdNoteSave("快速切换以后保存");
  await click(assistantButton);
  await key("Escape");
  releaseSave();
  await waitForPanel(null);
  await pause(250);
  assert.equal(await shown(null), true, "an earlier open request must not override the later Escape");
}

async function verifyHandoffAndOffline() {
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
  await run('document.querySelector("#academy-drawer [data-chat-composer]").requestSubmit()');
  await until(async () => messages.length === 1 && await dialogueDraft() === "", "in-flight dialogue turn");
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

  await click(noteButton);
  await waitForPanel("note");
  await key("K", { metaKey: true, shiftKey: true });
  await waitForPanel("assistant");
  await click('[data-action="show-applications"]');
  await until(() => run('!document.querySelector("[data-action=clipboard-toggle]")'), "Space-only note entry");
  assert.equal(await shown("assistant"), true, "assistant remains available after leaving Space");

  hostState = { ...baseState, phase: "idle", connection: null };
  send("state", hostState);
  await click('[data-action="show-space"]');
  await until(() => run('document.querySelector(".space-connect") !== null'), "offline Space");
  await assertNotePlacement(connectControl);
  await click(noteButton);
  await waitForPanel("note");
  await waitForEditor();
  assert.equal(await noteText(), "快速切换以后保存");
}

async function verifyAccountSwitch() {
  await holdNoteSave("切换账号前的草稿");
  await click(assistantButton);
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
        const assistant = document.querySelector("#academy-drawer");
        const note = document.querySelector("#super-clipboard");
        const open = element => element && !element.hidden && !element.inert;
        if (open(assistant) && open(note)) return "both";
        if (open(assistant)) return "assistant";
        if (open(note)) return "note";
        return null;
      };
      window.overlapSeen = false;
      new MutationObserver(() => {
        if (window.activeSidebar() === "both") window.overlapSeen = true;
      }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["hidden", "inert"], childList: true });
    } + ")()");
    await verifyWorkshopTab();
    await verifyMergedExpertApps();
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
