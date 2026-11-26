import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { app, BrowserWindow, dialog, net, protocol, safeStorage, session } from "electron";
import { createLocalEncryption } from "../../account/local-encryption.mjs";
import { createSecureAccountStore } from "../../account/store.mjs";
import { createMemoryWorkspace, MEMORY_ORIGIN, MEMORY_SCHEME } from "../../shell/memory-workspace.mjs";
import { createMyAiCollaboration } from "../../shell/my-ai-collaboration.mjs";

protocol.registerSchemesAsPrivileged([{ scheme: MEMORY_SCHEME, privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true,
} }]);

const state = {
  account: { phase: "authenticated", accountId: "collaboration-fixture", clientId: "fixture-client" },
  connection: { deviceId: "fixture-box" }, phase: "ready",
};
const evidence = [
  { id: "E1", kind: "space", title: "发布清单.md", locator: { label: "试点资料 / 发布清单.md" }, text: "首发前逐一验证三类资料的授权、读取和撤销。" },
  { id: "E2", kind: "starlink", title: "首发用户", locator: { label: "产品星图 · 正文第 1 段" }, text: "首批选择已有盒子、经常进行资料研究的用户。" },
  { id: "E3", kind: "memory", title: "产品讨论", locator: { label: "历史记忆原文" }, text: "先在 Mac 客户端验证首发流程。" },
];
const recipients = [
  { id: "claude", name: "Claude", model: "Claude 模拟模型", destination: "Anthropic", configured: true },
  { id: "gemini", name: "Gemini", model: "Gemini 模拟模型", destination: "Google", configured: true },
  { id: "gpt", name: "GPT", model: "GPT 模拟模型", destination: "OpenAI", configured: true },
];
const assets = resolve(process.env.MEMOBOX_COLLAB_TEST_UI ?? (app.isPackaged
  ? join(process.resourcesPath, "collaboration-memory-ui") : "build/collaboration-memory-ui"));
const output = process.env.MEMOBOX_COLLAB_TEST_OUTPUT;
if (app.isPackaged) {
  app.setName("MemoBox-Collaboration-Fixture");
  const fixtureProfile = output ? join(output, "profile") : join(app.getPath("appData"), "MemoBox-Collaboration-Fixture");
  mkdirSync(fixtureProfile, { recursive: true, mode: 0o700 });
  app.setPath("userData", fixtureProfile);
}
const verify = Boolean(output);
const calls = [];

function sources() {
  return {
    async catalog(kind, parent) {
      if (kind === "space") return { folders: parent ? [] : [{ id: "release", name: "试点资料" }] };
      if (kind === "starlink") return { warehouses: [{ id: "product", name: "产品星图" }] };
      return { agents: [{ id: "discussion", name: "产品讨论" }] };
    },
    async collect(selection) {
      return { evidence: evidence.filter(item => selection[{ space: "folderId", starlink: "warehouseId", memory: "memoryAgent" }[item.kind]]), notices: [] };
    },
    async verify(_selection, candidate) {
      return evidence.some(item => item.id === candidate.id && item.text === candidate.text);
    },
  };
}

async function mockModel(provider, stage, input, signal) {
  calls.push({ provider, stage, input });
  await delay(stage === "research" ? (provider === "claude" ? 420 : 650) : 250, null, { signal });
  const issue = { severity: "blocking", text: "试点人数涉及不同意见，需要产品负责人确认。" };
  const found = input.evidence.some(item => item.id === "E1");
  const claim = (text, evidenceIds = []) => ({ text, evidenceIds });
  const result = {
    recommendation: claim(found ? "先验收三类资料的权限流程，再开放小范围试点。" : "补充资料后核对试点范围。", found ? ["E1"] : []),
    findings: found ? [claim("发布清单要求先验收资料权限。", ["E1"])] : [],
    disagreements: [],
    questions: ["试点人数待确认。"],
  };
  return { output: stage === "review" ? { issues: /冲突/.test(input.task) ? [issue] : [] } : result,
    usage: { inputTokens: 60, outputTokens: 30 } };
}

app.commandLine.appendSwitch("disable-background-networking");

void app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: !verify, width: 1240, height: 850,
    title: "记忆盒子 · 多 Agent 验收版（虚构资料）", autoHideMenuBar: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const profile = app.getPath("userData");
  const storage = createSecureAccountStore({ filePath: join(profile, "collaboration-fixture.enc"),
    safeStorage: process.platform === "darwin" ? createLocalEncryption({ directory: profile }) : safeStorage });
  const workspace = createMemoryWorkspace({
    assets, getState: () => state, fetchAsset: url => net.fetch(url), myAiTask: async () => ({ agents: [] }),
    myAiCollaboration: createMyAiCollaboration({
      identity: () => ({ owner: state.account.accountId, box: state.connection.deviceId, scope: "fixture-scope" }),
      sources: sources(), models: { recipients, call: mockModel }, store: storage,
      async saveReport(markdown, check) {
        const destination = verify ? join(output, "report.md") : (await dialog.showSaveDialog(window, {
          title: "导出验收报告", defaultPath: "研究方案.md", filters: [{ name: "Markdown", extensions: ["md"] }],
        })).filePath;
        if (!destination) return false;
        await check();
        await writeFile(destination, markdown, "utf8");
        return true;
      },
    }),
  });
  session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] },
    (_details, callback) => callback({ cancel: true }));
  session.defaultSession.protocol.handle(MEMORY_SCHEME, input => workspace.handle(input));
  const { token } = await workspace.open();
  assert.ok(token, assets);
  window.on("page-title-updated", event => event.preventDefault());
  await window.loadURL(MEMORY_ORIGIN + "/wanx-memory.html?section=my-ai#session=" + token);

  if (!verify) {
    app.on("window-all-closed", () => { void workspace.close().finally(() => app.quit()); });
  } else {
    try {
      const evaluate = source => window.webContents.executeJavaScript(source, true);
      async function waitFor(source) {
        for (let attempt = 0; attempt < 160; attempt++) {
          if (await evaluate(source)) return;
          await delay(40);
        }
        throw Error("UI not reached: " + source);
      }
      const text = text => waitFor("document.body.innerText.includes(" + JSON.stringify(text) + ")");
      async function click(name) {
        const element = "[...document.querySelectorAll('button')].find(button => !button.disabled && (button.getAttribute('aria-label') === " +
          JSON.stringify(name) + " || button.innerText.trim() === " + JSON.stringify(name) + "))";
        await waitFor("Boolean(" + element + ")");
        await evaluate(element + ".click()");
      }
      async function fill(value) {
        await evaluate(`(() => {
          const textarea=document.querySelector(".my-ai-collab textarea");
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(textarea,${JSON.stringify(value)});
          textarea.dispatchEvent(new Event("input",{bubbles:true}));
        })()`);
      }
      await click("协作任务");
      await text("发起协作任务");
      await click("个人空间");
      await click("打开文件夹 试点资料");
      await click("选择当前文件夹");
      await click("星图仓库");
      await click("产品星图");
      await click("历史记忆");
      await click("产品讨论");
      await fill("请给出记忆盒子首发试点研究方案");
      await click("预览资料");
      await text("确认发送资料");
      assert.equal(calls.length, 0);
      assert.equal(await evaluate('document.querySelectorAll(".my-ai-collab-evidence input").length'), 3);
      await evaluate('document.querySelector(".my-ai-collab-evidence input").click()');
      await click("确认并开始");
      await text("独立研究中");
      await text("已通过核证");
      assert.equal(calls.length, 4);
      assert.ok(calls.every(call => call.input.evidence.length === 1 && call.input.evidence[0].id === "E1"));
      await click("E1 发布清单.md");
      await text("已确认的原文片段");
      await click("关闭证据出处");
      await click("导出 Markdown");
      await text("Markdown 已导出");
      const report = await readFile(join(output, "report.md"), "utf8");
      assert.match(report, /发布清单/);
      assert.doesNotMatch(report, /首发用户/);
      await click("返回新建");
      await fill("请研究试点规模的冲突");
      await click("预览资料");
      await text("确认发送资料");
      await evaluate('document.querySelector(".my-ai-collab-evidence input").click()');
      await click("确认并开始");
      await text("需要核对的疑点");
      await text("待你核对");
      assert.equal(calls.length, 10);
      assert.equal(await evaluate('[...document.querySelectorAll("button")].some(button=>button.innerText.includes("导出 Markdown"))'), false);
      console.log("MEMOBOX_COLLAB_ELECTRON_PASS");
      await workspace.close();
      app.exit(0);
    } catch (error) {
      console.error(error);
      console.error(await window.webContents.executeJavaScript("document.body.innerText", true));
      await workspace.close();
      app.exit(1);
    }
  }
}).catch(error => { console.error(error); app.exit(1); });
