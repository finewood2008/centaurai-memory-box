// @vitest-environment happy-dom
import googleLogoUrl from "../../../assets/agent-logos/google.svg";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createInitialAppState } from "../../../state/app-reducer.js";
import { I18nProvider } from "../../../i18n/i18n-provider.js";
import MyAi from "../wanx-my-ai.js";
import type { BackupStatus } from "../wanx-memory-backup.js";
import type { Agent, AgentCapabilities } from "../wanx-my-ai-model.js";

const mocks = vi.hoisted(() => ({ state: null as ReturnType<typeof createInitialAppState> | null, dispatch: vi.fn(), sourcePanel: vi.fn(), backup: null as BackupStatus | null, collectionProfile: null as { id: string; name: string } | null }));
vi.mock("../../../app/providers.js", () => ({ useApiClients: () => ({ clients: { agentSources: null } }) }));
vi.mock("../../../state/app-state.js", () => ({ useAppState: () => ({ state: mocks.state, dispatch: mocks.dispatch }) }));
vi.mock("../../../app/use-scan-completions.js", () => ({ useScanCompletions: () => {} }));
vi.mock("../../../app/agent-source-scan-reconciler.js", () => ({ AgentSourceScanReconciler: () => null }));
vi.mock("../../memory-sources-page.js", () => ({
  visibleAgentSources: (items: unknown[]) => items,
  MemorySourcesContent: (props: object) => { mocks.sourcePanel(props); return <div>来源采集面板</div>; },
}));
vi.mock("../wanx-memory-backup.js", async importOriginal => ({
  ...await importOriginal<typeof import("../wanx-memory-backup.js")>(),
  MemorySyncSummary: ({ children }: { children: (profile: BackupStatus["library"] | null, backup: BackupStatus | null) => React.ReactNode }) =>
    <div>{children(mocks.collectionProfile, mocks.backup)}</div>,
}));
vi.mock("../wanx-memory-transfer.js", () => ({ MemoryTransfer: () => <div>统一记忆导入导出</div> }));

let host: HTMLDivElement;
let root: Root;
let agents: Agent[];
let posts: { action: string; body: Record<string, unknown> }[];
let respond: (action: string, body: Record<string, unknown>) => Promise<Response | undefined>;
const capabilities: AgentCapabilities = { delivery: "draft", configuration: "automatic", autoMemory: "hook", limitations: [] };
const agent = (id: string, name: string, delivery: AgentCapabilities["delivery"] = "draft"): Agent => ({
  id, name, installed: true, launchable: true, uninstallable: true, capabilities: { ...capabilities, delivery },
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  mocks.state = createInitialAppState();
  mocks.backup = null;
  mocks.collectionProfile = { id: "legacy", name: "旧版混合库" };
  agents = [agent("codex", "Codex 客户端")];
  posts = [];
  respond = async () => undefined;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const action = String(url).split("/my-ai/")[1];
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (init?.method === "POST") posts.push({ action, body });
    const response = await respond(action, body);
    if (response) return response;
    if (action === "status") return Response.json({ agents, apps: agents, agentAccess: Object.fromEntries(agents.map(item => [item.id, { configured: true, connected: true, serviceReady: true, boxReady: true }])) });
    if (action === "agent-context/status") return Response.json({ configured: true, connected: true, serviceReady: true, boxReady: true });
    if (action === "agent-context/selection") return Response.json({ selection: body.selection ?? { memoryEnabled: false }, resources: {} });
    if (action === "agent-context/catalog") return Response.json({
      warehouses: [{ id: "warehouse-one", name: "测试星图" }],
      folders: body.parent ? [] : [{ id: "docs-one", name: "测试文件夹" }],
      agents: [{ id: "claude_code", name: "Claude Code" }, { id: "codex", name: "Codex" }],
    });
    if (action === "optimize") return Response.json({ text: "优化后的测试任务" });
    if (action === "copy") return Response.json({ copied: true });
    return Response.json({ opened: true });
  }));
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const button = (name: string, scope: ParentNode = document.body) => [...scope.querySelectorAll<HTMLButtonElement>("button")]
  .find(item => item.textContent === name || item.getAttribute("aria-label") === name)!;
async function render() {
  await act(async () => root.render(<I18nProvider language="zh-CN"><MyAi sessionToken="synthetic-session" memoryError={false} retryMemory={() => {}} /></I18nProvider>));
}
async function enter(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function optimize() {
  await enter(host.querySelector<HTMLTextAreaElement>('textarea[placeholder^="例如"]')!, "测试任务");
  await act(async () => button("优化提示词").click());
}

it('blocks refresh and optimization until the chosen source scope has finished saving',async()=>{
  await render();
  await enter(host.querySelector<HTMLTextAreaElement>('textarea[placeholder^="例如"]')!, '测试任务');
  let save!: (value:Response)=>void;
  respond=async(action,body)=>{
    if(action==='agent-context/selection'&&body.selection)return new Promise(resolve=>{save=resolve;});
  };
  await act(async()=>button('智能体记忆').click());
  await act(async()=>{
    button('全部 Agent').click();
    // Both handlers can run before React has committed the disabled state.
    button('优化提示词').click();
  });
  expect(posts.some(item=>item.action==='optimize')).toBe(false);
  expect(button('优化提示词').disabled).toBe(true);
  expect(button('重新检测').disabled).toBe(true);
  await act(async()=>save(Response.json({selection:{memoryEnabled:true}})));
  expect(button('智能体记忆').querySelector("small")?.textContent).toBe("全部 Agent");
  expect(button('优化提示词').disabled).toBe(false);
  await act(async()=>button('优化提示词').click());
  expect(posts.find(item=>item.action==='optimize')?.body.agentContext).toEqual({memoryEnabled:true,memoryAgent:null});
});

it("keeps only the approved nine entries and filters retired sources without revoking or deleting them", async () => {
  agents = [agent("codex", "Codex 客户端"), agent("codex_cli", "Codex CLI"), agent("claude_code", "Claude Code CLI"), agent("claude_desktop", "Claude 客户端"),
    agent("gemini", "Google"), agent("workbuddy", "WorkBuddy（海外版）"), agent("workbuddy_cn", "WorkBuddy（国内版）"), agent("qwenwork", "QwenWork"), agent("deepseek_harness", "DeepSeek Harness"), agent("cursor", "Cursor")];
  mocks.state!.agentSources.items = [
    { sourceId: "cursor", displayName: "Cursor", builtin: true }, { sourceId: "openclaw", displayName: "OpenClaw", builtin: true },
  ] as typeof mocks.state.agentSources.items;
  await render();
  expect([...host.querySelectorAll(".my-ai-agent-list strong")].map(item => item.textContent)).toEqual(agents.slice(0, 9).map(item => item.name));
  await act(async () => button("添加应用").click());
  const catalog = document.querySelector('[role="dialog"]')!;
  expect(catalog.textContent).not.toContain("Cursor");
  expect(catalog.textContent).not.toContain("OpenClaw");
  const panel = mocks.sourcePanel.mock.calls.at(-1)![0];
  expect([...panel.disconnectedLocalAgentIds]).toContain("cursor");
  expect([...panel.disconnectedLocalAgentIds]).toContain("openclaw");
  expect(mocks.state!.agentSources.items).toHaveLength(2);
  expect(posts.some(item => item.action === "hide-agent")).toBe(false);
});

it("shows configured separately from verified and uses the selected Claude mode for new tasks", async () => {
  agents = [agent("claude_desktop", "Claude 客户端"), agent("gemini", "Google")];
  agents[0].capabilities!.autoMemory = "explicit";
  agents[0].modes = [{ id: "chat", autoMemory: "explicit" }, { id: "code", autoMemory: "hook" }, { id: "cowork", configuration: "automatic", autoMemory: "unverified" }];
  await render();
  expect(host.textContent).toContain("等待智能体加载");
  const capture = host.querySelector('[aria-label="从智能体到记忆盒子"]')!;
  expect(capture.textContent).toContain("在对话中指定要保存的内容");
  expect(button("Google").textContent).toContain("等待检测到本机会话");
  await act(async () => button("历史导入与保存", capture).click());
  const settings = host.querySelector<HTMLElement>("#my-ai-collection-settings")!;
  expect(settings.hidden).toBe(false);
  expect(settings.textContent).toContain("旧对话可从 Claude 导出后批量导入");
  expect(settings.textContent).not.toContain("等待首次检测到会话");
  expect(host.textContent).toContain("先完全退出再重新打开");
  expect(host.querySelector(".my-ai-connection-details")).toBeNull();
  await act(async () => button("连接详情").click());
  expect(host.textContent).toContain("等待智能体加载");
  expect(host.textContent).not.toContain("资料检索已验证");
  await optimize();
  expect(posts.find(item => item.action === "optimize")?.body).toMatchObject({ agent: "claude_desktop", mode: "chat", agentContext: { memoryEnabled: false } });
  await act(async () => {
    const select = host.querySelector<HTMLSelectElement>('[aria-label="Claude 运行模式"]')!;
    select.value = "code"; select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(host.textContent).not.toContain("优化后的提示词");
  expect(host.querySelector(".my-ai-connection-details")).toBeNull();
  expect(settings.hidden).toBe(true);
  expect(capture.textContent).toContain("桌面 Code 与 Claude Code CLI 共用采集来源");
  await act(async () => button("管理采集", capture).click());
  expect(mocks.sourcePanel.mock.calls.at(-1)![0].focusedSourceId).toBe("claude_code");
  await act(async () => button("连接详情").click());
  expect(host.textContent).toContain("支持配置逐轮采集");
  await act(async () => button("优化提示词").click());
  expect(posts.filter(item => item.action === "optimize").at(-1)?.body.mode).toBe("code");
  await act(async () => {
    const select = host.querySelector<HTMLSelectElement>('[aria-label="Claude 运行模式"]')!;
    select.value = "cowork"; select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => button("优化提示词").click());
  expect(posts.filter(item => item.action === "optimize").at(-1)?.body).toMatchObject({ mode: "cowork", agentContext: { memoryEnabled: false } });
});

it("previews a Claude export before sending the opaque approval to import", async () => {
  agents = [agent("claude_desktop", "Claude 客户端")];
  respond = async action => {
    if (action === "claude-chat-import/preview") return Response.json({ previewId: "chat-preview", name: "claude-export.zip",
      conversationCount: 3, messageCount: 8, recordCount: 8, skippedMessages: 1 });
    if (action === "claude-chat-import/commit") return Response.json({ imported: 7, skipped: 1, remaining: 0 });
  };
  await render();
  await act(async () => button("历史导入与保存").click());
  await act(async () => button("选择 Claude 历史导出文件").click());
  expect(host.textContent).toContain("3 个对话 · 8 条文本消息");
  expect(posts).not.toContainEqual(expect.objectContaining({ action: "claude-chat-import/commit" }));
  await act(async () => button("确认导入 Claude 历史").click());
  expect(posts).toContainEqual({ action: "claude-chat-import/commit", body: { previewId: "chat-preview" } });
  expect(host.textContent).toContain("新增 7 条，跳过 1 条已有记录");
});

it("keeps collection and retrieval actions in the flow without duplicate shortcuts", async () => {
  agents = [agent("codex", "Codex 客户端"), agent("gemini", "Google")];
  agents[0].sourceId = "codex";
  respond = async action => {
    if (action === "status") return Response.json({ agents, apps: agents, agentAccess: { codex: { configured: true } } });
    if (action === "agent-access/connect") return Response.json({ configured: true, connected: true });
    if (action === "agent-access/test") return Response.json({ configured: true, connected: true, connectionTested: true });
    return undefined;
  };
  mocks.state!.agentSources.items = [{
    sourceId: "codex", displayName: "Codex", builtin: true, available: true,
    dataPath: "/synthetic/codex", status: "not_connected", messageCount: 17, lastScannedAt: "2026-11-17T06:10:00Z",
  }];
  await render();
  const capture = host.querySelector('[aria-label="从智能体到记忆盒子"]')!;
  const context = host.querySelector('[aria-label="从记忆盒子到智能体"]')!;
  const diagram = host.querySelector('[aria-label="智能体、本机客户端与记忆盒子"]')!;
  expect([...diagram.querySelectorAll(".my-ai-flow-node strong")].map(node => node.textContent)).toEqual(["Codex 客户端", "本机客户端", "记忆盒子"]);
  expect(diagram.contains(capture) && diagram.contains(context)).toBe(true);
  expect(capture.querySelectorAll(".my-ai-flow-arrow .lucide-arrow-right")).toHaveLength(2);
  expect(context.querySelectorAll(".my-ai-flow-arrow .lucide-arrow-left")).toHaveLength(2);
  expect(capture.textContent).toContain("有已采集的记忆");
  expect(host.textContent).toContain("等待智能体加载");
  const manage = button("管理采集", capture);
  await act(async () => manage.click());
  expect(manage.getAttribute("aria-expanded")).toBe("true");
  expect(mocks.sourcePanel.mock.calls.at(-1)![0].focusedSourceId).toBe("codex");
  expect(button("查看记忆", diagram)).toBeUndefined();
  expect(button("备份与恢复", diagram)).toBeUndefined();
  await act(async () => host.querySelectorAll<HTMLButtonElement>(".my-ai-agent")[1].click());
  expect(host.querySelector<HTMLElement>("#my-ai-collection-settings")!.hidden).toBe(true);
  expect(capture.textContent).toContain("等待检测到本机会话");
  expect(host.textContent).toContain("尚未连接");
  await act(async () => button("连接智能体", context).click());
  expect(posts).toContainEqual({ action: "agent-access/connect", body: { agent: "gemini" } });
  expect(posts).toContainEqual({ action: "agent-access/test", body: { agent: "gemini" } });
  expect(host.textContent).toContain("本机测试通过，等待智能体加载");
  expect(button("测试连接", context)).toBeDefined();
});

it.each([
  { id: "codex", name: "Codex 客户端", delivery: "draft" as const, title: "请重新打开 Codex 客户端" },
  { id: "codex_cli", name: "Codex CLI", delivery: "terminal-confirm" as const, title: "请重新启动 Codex CLI" },
  { id: "workbuddy_cn", name: "WorkBuddy（国内版）", delivery: "copy-open" as const, title: "首次连接 WorkBuddy：信任记忆盒子" },
])("explains how to load changed MCP configuration for $name after authorization", async ({ id, name, delivery, title }) => {
  agents = [agent(id, name, delivery)];
  const ready = { authorized: true, configured: true, boxReady: true, serviceReady: true };
  respond = async action => {
    if (action === "status") return Response.json({ agents, agentAccess: {} });
    if (action === "agent-access/connect") return Response.json({ ...ready, configurationChanged: true });
    if (action === "agent-access/test") return Response.json({ ...ready, connectionTested: true, loaded: false });
  };
  await render();
  await act(async () => button("连接智能体").click());
  const notice = document.querySelector('[role="dialog"]')!;
  expect(notice.textContent).toContain(title);
  expect(notice.textContent).toContain("资料授权与连接配置已保存");
  if (id === "workbuddy_cn") {
    const steps = /专家·技能·连接器.*「连接器」.*自定义连接器.*我的 MCP.*wanx-memobox.*「信任」/;
    expect(notice.textContent).toMatch(steps);
    expect(host.querySelector(".my-ai-connection-result")?.textContent).toMatch(steps);
  } else expect(notice.textContent).toContain("保持半人马AI记忆盒子客户端运行并连接盒子");
  if (id === "codex_cli") {
    expect(notice.textContent).toContain("/quit");
    expect(notice.textContent).toContain("codex resume --last");
  } else if (id === "codex") expect(notice.textContent).toContain("完全退出并重新打开 Codex 客户端");
  expect(posts.map(item => item.action)).not.toContain("launch");
  await act(async () => button("我知道了", notice).click());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it.each([
  { configurationChanged: false, loaded: false, failed: false },
  { configurationChanged: true, loaded: true, failed: false },
  { configurationChanged: true, loaded: false, failed: true },
])("does not request a restart for reused, already loaded, or failed connections: %j", async ({ configurationChanged, loaded, failed }) => {
  agents = [agent("codex", "Codex 客户端")];
  const ready = { authorized: true, configured: true, boxReady: true, serviceReady: true };
  respond = async action => {
    if (action === "status") return Response.json({ agents, agentAccess: {} });
    if (action === "agent-access/connect") return failed
      ? Response.json({ error: { message: "已取消更新" } }, { status: 400 })
      : Response.json({ ...ready, configurationChanged });
    if (action === "agent-access/test") return Response.json({ ...ready, connectionTested: true, loaded });
  };
  await render();
  await act(async () => button("连接智能体").click());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  if (failed) expect(host.textContent).toContain("已取消更新");
});

it("shows connecting and testing separately, offers a retry, and completes after the agent loads", async () => {
  agents = [agent("claude_desktop", "Claude 客户端")];
  let configure!: (value: Response) => void;
  let completeTest!: (value: Response) => void;
  let retries = 0;
  const ready = { authorized: true, configured: true, boxReady: true, serviceReady: true };
  respond = async action => {
    if (action === "status") return Response.json({ agents, agentAccess: {} });
    if (action === "agent-access/connect") return new Promise(resolve => { configure = resolve; });
    if (action === "agent-access/test" && retries++ === 0) return new Promise(resolve => { completeTest = resolve; });
    if (action === "agent-access/test") return Response.json({ ...ready, loaded: true, connectionTested: true });
  };
  await render();
  const status = host.querySelector('[aria-label="智能体连接状态"]')!;
  const bar = status.querySelector("progress")!;
  await act(async () => button("连接智能体").click());
  expect(status.textContent).toContain("正在连接智能体");
  expect(bar.value).toBe(0);
  await act(async () => configure(Response.json(ready)));
  expect(status.textContent).toContain("正在测试连接");
  expect(bar.value).toBe(1);
  await act(async () => completeTest(Response.json({ error: { message: "本机工具未响应" } }, { status: 400 })));
  expect(status.textContent).toContain("连接测试未通过");
  expect(status.textContent).toContain("本机工具未响应");
  await act(async () => button("测试连接").click());
  expect(bar.value).toBe(3);
  expect(status.textContent).toContain("已连接本机客户端");
  expect(button("测试连接")).toBeUndefined();
  await act(async () => button("连接详情").click());
  expect(button("断开连接")).toBeDefined();
  expect(posts.filter(item => item.action === "agent-access/test").map(item => item.body)).toEqual([
    { agent: "claude_desktop", mode: "chat" }, { agent: "claude_desktop", mode: "chat" },
  ]);
});

it("offers Claude Code repair and copies the manual command only when needed", async () => {
  agents = [agent("claude_code", "Claude Code CLI", "terminal-confirm")];
  let attempts = 0;
  const ready = { authorized: true, boxReady: true };
  respond = async action => {
    if (action === "status") return Response.json({ agents, agentAccess: { claude_code: ready } });
    if (action === "agent-access/connect" && attempts++ === 0)
      return Response.json({ error: { code: "claude_mcp_manual_repair", message: "请先确认旧连接。" } }, { status: 400 });
    if (action === "agent-access/connect") return Response.json({ ...ready, configured: true });
    if (action === "agent-access/test") return Response.json({ ...ready, configured: true, connectionTested: true });
    if (action === "agent-access/copy-removal-command") return Response.json({ copied: true });
  };
  await render();
  expect(button("复制移除命令")).toBeUndefined();
  await act(async () => button("修复连接").click());
  expect(host.textContent).toContain("请先确认旧连接。");
  await act(async () => button("复制移除命令").click());
  expect(posts).toContainEqual({ action: "agent-access/copy-removal-command", body: { agent: "claude_code" } });
  expect(host.textContent).toContain("已复制移除命令。");
  await act(async () => button("修复连接").click());
  expect(button("复制移除命令")).toBeUndefined();
  expect(host.textContent).toContain("本机测试通过，等待智能体加载");
});

it("reconnects Codex for selected sources after revocation and asks separately for full access", async () => {
  const ready = { authorized: true, configured: true, boxReady: true, allPersonalReadOnly: true };
  let allPersonalReadOnly = true;
  respond = async (action, body) => {
    if (action === "status") return Response.json({ agents, agentAccess: { codex: {
      ...ready, outputFolder: { id: "old-output", name: "Old output" },
    } } });
    if (action === "agent-access/disconnect") return Response.json({ boxReady: true, revokedAccess: "all-personal-read-only" });
    if (action === "agent-access/connect") {
      allPersonalReadOnly = body.allPersonalReadOnly === true;
      return Response.json({ ...ready, allPersonalReadOnly });
    }
    if (action === "agent-access/test") return Response.json({ ...ready, allPersonalReadOnly, loaded: true, connectionTested: true });
  };
  await render();
  expect(host.textContent).toContain("已授权全部个人资料 · 只读");
  expect(host.textContent).not.toContain("成果回写");
  expect(button("撤销授权")).toBeUndefined();
  await act(async () => button("连接详情").click());
  const details = host.querySelector('#my-ai-connection-details')!;
  expect(details.textContent).toContain("立即停止通过此连接读取盒子资料");
  await act(async () => button("撤销授权", details).click());
  expect(posts).toContainEqual({ action: "agent-access/disconnect", body: { agent: "codex" } });
  expect(host.textContent).not.toContain("已授权全部个人资料 · 只读");
  expect(details.textContent).toContain("退出当前 Codex CLI 后重新启动");
  await act(async () => button("授权全部个人资料").click());
  await act(async () => button("取消授权").click());
  expect(posts.some(item => item.action === "agent-access/connect")).toBe(false);
  await act(async () => button("连接所选资料", details).click());
  expect(posts.filter(item => item.action === "agent-access/connect")).toEqual([{ action: "agent-access/connect", body: { agent: "codex" } }]);
  expect(host.textContent).not.toContain("已授权全部个人资料 · 只读");
  expect(button("连接所选资料", details)).toBeUndefined();
  await act(async () => button("授权全部个人资料").click());
  await act(async () => button("确认只读授权").click());
  expect(posts).toContainEqual({ action: "agent-access/connect", body: { agent: "codex", allPersonalReadOnly: true } });
  expect(host.textContent).toContain("已授权全部个人资料 · 只读");
  expect(button("连接所选资料", details)).toBeUndefined();
});

it("shows connection controls for WorkBuddy and DeepSeek history sources without detected desktop apps", async () => {
  const workbuddy = { ...agent("workbuddy", "WorkBuddy", "copy-open"), installed: false, launchable: false, connectionAvailable: true,
    capabilities: { ...capabilities, configuration: "guided" as const } };
  const deepseek = { ...agent("deepseek_harness", "DeepSeek Harness", "copy-open"), installed: false, launchable: false, connectionAvailable: true };
  mocks.state!.agentSources.items = [workbuddy, deepseek].map(app => ({ sourceId: app.id, displayName: app.name, builtin: true })) as typeof mocks.state.agentSources.items;
  const mainland = { ...workbuddy, id: "workbuddy_cn", name: "WorkBuddy（国内版）", sourceId: "workbuddy" };
  respond = async action => {
    if (action === "status") return Response.json({ agents: [], apps: [workbuddy, mainland, deepseek] });
    if (action === "agent-access/connect") return Response.json({ authorized: true, boxReady: true, serviceReady: true });
    if (action === "agent-access/test") return Response.json({ authorized: true, boxReady: true, serviceReady: true, connectionTested: true });
  };
  await render();
  expect(button("WorkBuddy（国内版）").textContent).toContain("尚未安装");
  await act(async () => button("连接智能体").click());
  expect(host.textContent).toContain("等待智能体加载");
  expect(button("查看接入配置")).toBeDefined();
  expect(button("测试连接")).toBeDefined();
  await act(async () => button("DeepSeek Harness").click());
  await act(async () => button("连接智能体").click());
  expect(posts.filter(item => item.action === "agent-access/connect").map(item => item.body.agent)).toEqual(["workbuddy", "deepseek_harness"]);
});

it("keeps the loaded Agent connected when a refresh no longer reports a manual test", async () => {
  const local = { configured: true, loaded: true, serviceReady: true, boxReady: true, allPersonalReadOnly: true };
  let refreshed = false;
  respond = async action => {
    if (action === "status") return Response.json({ agents, agentAccess: { codex: { ...local, connectionTested: true } } });
    if (action === "agent-access/status") {
      refreshed = true;
      return Response.json({ codex: { ...local, connectionTested: false } });
    }
  };
  await render();
  const status = host.querySelector('[aria-label="智能体连接状态"]')!;
  expect(status.textContent).toContain("已连接本机客户端");
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(refreshed).toBe(true);
  expect(status.textContent).toContain("已连接本机客户端");
  expect(status.querySelector("progress")?.value).toBe(3);
  expect(button("测试连接")).toBeUndefined();
});

it("tests the local Agent connection even when the box is offline", async () => {
  const local = { configured: true, loaded: false, serviceReady: true, boxReady: false, retrievalVerified: false };
  respond = async action => {
    if (action === "status") return Response.json({ agents, agentAccess: { codex: local } });
    if (action === "agent-access/test") return Response.json({ ...local, loaded: true, connectionTested: true });
  };
  await render();
  const testConnection = button("测试连接");
  expect(testConnection.disabled).toBe(false);
  await act(async () => testConnection.click());
  const status = host.querySelector('[aria-label="智能体连接状态"]')!;
  expect(status.textContent).toContain("已连接本机客户端");
  expect(status.textContent).toContain("盒子连通后即可检索授权资料");
  expect(button("连接盒子")).toBeDefined();
  expect(posts).toContainEqual({ action: "agent-access/test", body: { agent: "codex" } });
});

it("offers box and backup shortcuts, showing the saved schedule and active backup", async () => {
  respond = async action => action === "status" ? Response.json({ agents, agentAccess: { codex: { boxReady: false } } }) : undefined;
  mocks.backup = { connected: false, enabled: true, intervalMinutes: 30, context: null };
  const messages = vi.spyOn(window.parent, "postMessage").mockImplementation(() => {});
  try {
    await render();
    const backup = host.querySelector(".my-ai-flow--capture li:last-child")!;
    const box = host.querySelector(".my-ai-flow--context li:first-child")!;
    expect(backup.textContent).toContain("每 30 分钟自动备份");
    expect(backup.querySelector(".my-ai-flow-step-icon--busy")).toBeNull();
    expect(box.textContent).toContain("盒子未连接");
    await act(async () => button("连接盒子", box).click());
    await act(async () => button("自动备份", backup).click());
    expect(messages).toHaveBeenNthCalledWith(1, { type: "wanx-my-ai-destination", destination: "boxes" }, "*");
    expect(messages).toHaveBeenNthCalledWith(2, { type: "wanx-my-ai-destination", destination: "backup" }, "*");

    mocks.backup = { ...mocks.backup, connected: true, phase: "backing-up", intervalMinutes: 60 };
    await render();
    expect(button("连接盒子", box)).toBeUndefined();
    expect(backup.textContent).toContain("每 1 小时自动备份");
    expect(backup.textContent).toContain("正在备份记忆库");
    expect(backup.querySelector(".my-ai-flow-step-icon--busy")).toBeTruthy();

    mocks.backup = { ...mocks.backup, enabled: false, phase: "ready" };
    await render();
    expect(backup.textContent).toContain("自动备份已关闭");
    expect(backup.textContent).not.toContain("每 1 小时自动备份");
    expect(backup.querySelector(".my-ai-flow-step-icon--busy")).toBeNull();
  } finally {
    messages.mockRestore();
  }
});

it("passes the server collection profile to the real source panel contract", async () => {
  mocks.collectionProfile = null;
  await render();
  expect(mocks.sourcePanel.mock.calls.at(-1)![0].collectionProfile).toBeNull();
  mocks.collectionProfile = { id: "codex-desktop", name: "Codex Desktop" };
  await render();
  expect(mocks.sourcePanel.mock.calls.at(-1)![0].collectionProfile).toEqual(mocks.collectionProfile);
});

it("keeps task drafting available while an isolated library disables integration", async () => {
  respond = async action => action === "status" ? Response.json({ agents, apps: agents, agentAccess: {}, integrationUnavailable: "当前为独立测试记忆库，资料接入未开启。" }) : undefined;
  await render();
  expect(host.textContent).toContain("当前为独立测试记忆库");
  expect(button("连接智能体")).toBeUndefined();
  expect(posts.some(item => item.action.startsWith("agent-context/"))).toBe(false);
  await optimize();
  expect(posts.find(item => item.action === "optimize")?.body).not.toHaveProperty("agentContext");
});

it("prepares Gemini in a terminal without asking for a workspace or claiming the task executed", async () => {
  agents = [agent("gemini", "Google", "terminal-confirm")];
  respond = async action => action === "handoff" ? Response.json({ opened: true, prepared: true, delivery: "terminal-confirm" }) : undefined;
  await render();
  expect(host.querySelector('[aria-label="工作目录"]')).toBeNull();
  await optimize();
  await act(async () => button("在终端核对任务").click());
  const handoff = posts.find(item => item.action === "handoff")?.body;
  expect(handoff).toMatchObject({ agent: "gemini" });
  expect(handoff).not.toHaveProperty("workspacePath");
  expect(host.textContent).toContain("按回车后才会开始执行");
  expect(host.textContent).not.toContain("任务已执行");
});

it("reports copy-and-open as a manual paste for WorkBuddy", async () => {
  agents = [agent("workbuddy", "WorkBuddy", "copy-open")];
  respond = async action => action === "handoff" ? Response.json({ opened: true, copied: true, delivery: "copy-open" }) : undefined;
  await render(); await optimize();
  await act(async () => button("复制并打开 WorkBuddy").click());
  expect(host.textContent).toContain("请在应用中粘贴后发送");
  expect(host.textContent).not.toContain("注入成功");
});

it("persists source selections and leaves the previous value when saving fails", async () => {
  agents = [agent("gemini", "Google", "terminal-confirm")];
  let saveFails = false;
  respond = async (action, body) => action === "agent-context/selection" && body.selection && saveFails
    ? Response.json({ error: { message: "范围保存失败" } }, { status: 400 }) : undefined;
  await render();
  await act(async () => button("参考星图").click());
  await act(async () => button("测试星图").click());
  expect(posts.find(item => item.action === "agent-context/selection" && item.body.selection)?.body).toMatchObject({ agent: "gemini", selection: { warehouseId: "warehouse-one", memoryEnabled: false } });
  saveFails = true;
  const toggle = button("智能体记忆");
  await act(async () => toggle.click());
  await act(async () => button("Codex", document.querySelector('[role="dialog"]')!).click());
  expect(toggle.dataset.selected).toBe("false");
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("范围保存失败");
  expect(host.textContent).toContain("测试星图");
});

it("ignores the previous agent's delayed selection after the target changes", async () => {
  agents = [agent("codex", "Codex 客户端"), agent("gemini", "Google", "terminal-confirm")];
  let finishOld: ((response: Response) => void) | undefined;
  respond = async (action, body) => {
    if (action === "agent-context/selection" && body.agent === "codex") return new Promise<Response>(resolve => { finishOld = resolve; });
    if (action === "agent-context/selection" && body.agent === "gemini") return Response.json({
      selection: { warehouseId: "gemini-warehouse", memoryEnabled: false }, resources: { warehouse: { id: "gemini-warehouse", name: "Gemini 范围" } },
    });
    return undefined;
  };
  await render();
  await act(async () => button("Google", host.querySelector(".my-ai-agent-list")!).click());
  expect(host.textContent).toContain("Gemini 范围");
  await act(async () => finishOld!(Response.json({
    selection: { warehouseId: "old-warehouse", memoryEnabled: true }, resources: { warehouse: { id: "old-warehouse", name: "过期 Codex 范围" } },
  })));
  expect(host.textContent).not.toContain("过期 Codex 范围");
  expect(button("智能体记忆").dataset.selected).toBe("false");
});

it("clears session-bound drafts and pending state when the account session changes", async () => {
  let finishOld: ((response: Response) => void) | undefined;
  let calls = 0;
  respond = async action => action === "optimize" && calls++ === 0 ? new Promise<Response>(resolve => { finishOld = resolve; }) : undefined;
  await render();
  await optimize();
  expect(host.textContent).toContain("正在优化…");
  await act(async () => root.render(<I18nProvider language="zh-CN"><MyAi sessionToken="new-synthetic-session" memoryError={false} retryMemory={() => {}} /></I18nProvider>));
  expect(host.querySelector<HTMLTextAreaElement>('textarea[placeholder^="例如"]')!.value).toBe("");
  expect(host.textContent).not.toContain("正在优化…");
  await act(async () => finishOld!(Response.json({ text: "过期账号的结果" })));
  expect(host.textContent).not.toContain("过期账号的结果");
  await optimize();
  expect(host.querySelectorAll("textarea")[1].value).toBe("优化后的测试任务");
});

it("requires confirmation to manage uninstall and never labels opening an entry as completion", async () => {
  respond = async action => action === "uninstall" ? Response.json({ opened: true, guided: true, message: "已打开官方卸载入口，请完成后重新检测。" }) : undefined;
  await render();
  await act(async () => button("应用操作").click());
  await act(async () => button("管理卸载").click());
  expect(posts.some(item => item.action === "uninstall")).toBe(false);
  expect(document.body.textContent).toContain("历史记忆会保留");
  await act(async () => button("确认管理卸载").click());
  expect(posts.filter(item => item.action === "uninstall")).toHaveLength(1);
  expect(host.textContent).toContain("已打开官方卸载入口");
  expect(host.textContent).not.toContain("已完成卸载");
});

it("uses brand icons for every supported entry and omits the duplicate memory-transfer card", async () => {
  const entries = [
    ["codex", "Codex 客户端"], ["codex_cli", "Codex CLI"], ["claude_code", "Claude Code CLI"],
    ["claude_desktop", "Claude 客户端"], ["gemini", "Google"], ["workbuddy", "WorkBuddy（海外版）"], ["workbuddy_cn", "WorkBuddy（国内版）"],
    ["qwenwork", "QwenWork"], ["deepseek_harness", "DeepSeek Harness"],
  ];
  agents = entries.map(([id, name]) => agent(id!, name!));
  await render();
  for (const [id, name] of entries) {
    const row = [...host.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")].find(item => item.textContent?.includes(name!));
    const logo = row?.querySelector(".my-ai-agent-logo img");
    expect(logo, name).toBeTruthy();
    if (id === "gemini") expect(logo?.getAttribute("src")).toBe(googleLogoUrl);
  }
  await act(async () => button("添加应用").click());
  expect(document.querySelectorAll(".my-ai-app-catalog .my-ai-agent-logo img")).toHaveLength(9);
  expect(host.textContent).not.toContain("统一记忆导入导出");
  expect(host.textContent).not.toContain("记忆包导入导出");
});


it("shows all three selections on a second line and sends the chosen memory scope with the task", async () => {
  await render();
  const composer = host.querySelector(".my-ai-composer")!;
  const memory = button("智能体记忆", composer);
  const warehouse = button("参考星图", composer);
  const folder = button("空间文件", composer);
  for (const trigger of [warehouse, folder, memory]) {
    expect(trigger.classList.contains("my-ai-source-trigger")).toBe(true);
    expect(trigger.dataset.selected).toBe("false");
  }
  await act(async () => warehouse.click());
  await act(async () => button("测试星图").click());
  await act(async () => folder.click());
  await act(async () => button("打开文件夹 测试文件夹").click());
  await act(async () => button("选择当前文件夹").click());
  await act(async () => memory.click());
  await act(async () => button("Claude Code", document.querySelector('[role="dialog"]')!).click());
  expect([warehouse, folder, memory].map(trigger => trigger.querySelector("small")?.textContent))
    .toEqual(["测试星图", "测试文件夹", "Claude Code"]);
  await optimize();
  expect(posts.find(item => item.action === "optimize")?.body).toMatchObject({
    agent: "codex", agentContext: { folderId: "docs-one", warehouseId: "warehouse-one", memoryEnabled: true, memoryAgent: "claude_code" },
  });
  await act(async () => memory.click());
  await act(async () => button("全部 Agent").click());
  expect(memory.querySelector("small")?.textContent).toBe("全部 Agent");
  expect(posts.filter(item => item.action === "agent-context/selection" && item.body.selection).at(-1)?.body)
    .toMatchObject({ selection: { folderId: "docs-one", warehouseId: "warehouse-one", memoryEnabled: true, memoryAgent: null } });
  await act(async () => memory.click());
  await act(async () => button("不检索记忆").click());
  expect(memory.dataset.selected).toBe("false");
  expect(posts.filter(item => item.action === "agent-context/selection" && item.body.selection).at(-1)?.body)
    .toEqual({ agent: "codex", selection: { folderId: "docs-one", warehouseId: "warehouse-one", memoryEnabled: false } });
});
