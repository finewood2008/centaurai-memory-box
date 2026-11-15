// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createInitialAppState } from "../../../state/app-reducer.js";
import { I18nProvider } from "../../../i18n/i18n-provider.js";
import MyAi from "../wanx-my-ai.js";
import type { Agent, AgentCapabilities } from "../wanx-my-ai-model.js";

const mocks = vi.hoisted(() => ({ state: null as ReturnType<typeof createInitialAppState> | null, dispatch: vi.fn(), sourcePanel: vi.fn(), collectionProfile: null as { id: string; name: string } | null }));
vi.mock("../../../app/providers.js", () => ({ useApiClients: () => ({ clients: { agentSources: null } }) }));
vi.mock("../../../state/app-state.js", () => ({ useAppState: () => ({ state: mocks.state, dispatch: mocks.dispatch }) }));
vi.mock("../../../app/use-scan-completions.js", () => ({ useScanCompletions: () => {} }));
vi.mock("../../../app/agent-source-scan-reconciler.js", () => ({ AgentSourceScanReconciler: () => null }));
vi.mock("../../memory-sources-page.js", () => ({
  visibleAgentSources: (items: unknown[]) => items,
  MemorySourcesContent: (props: object) => { mocks.sourcePanel(props); return <div>来源采集面板</div>; },
}));
vi.mock("../wanx-memory-backup.js", () => ({ MemorySyncSummary: ({ children }: { children: React.ReactNode | ((profile: { id: string; name: string } | null) => React.ReactNode) }) => <div>{typeof children === "function" ? children(mocks.collectionProfile) : children}</div> }));
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
    if (action === "agent-context/catalog") return Response.json({ warehouses: [{ id: "warehouse-one", name: "测试星图" }], folders: [] });
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

it("keeps only the approved eight entries and filters retired sources without revoking or deleting them", async () => {
  agents = [agent("codex", "Codex 客户端"), agent("codex_cli", "Codex CLI"), agent("claude_code", "Claude Code CLI"), agent("claude_desktop", "Claude 客户端"),
    agent("gemini", "Gemini CLI"), agent("workbuddy", "WorkBuddy"), agent("qwenwork", "QwenWork"), agent("deepseek_harness", "DeepSeek Harness"), agent("cursor", "Cursor")];
  mocks.state!.agentSources.items = [
    { sourceId: "cursor", displayName: "Cursor", builtin: true }, { sourceId: "openclaw", displayName: "OpenClaw", builtin: true },
  ] as typeof mocks.state.agentSources.items;
  await render();
  expect([...host.querySelectorAll(".my-ai-agent-list strong")].map(item => item.textContent)).toEqual(agents.slice(0, 8).map(item => item.name));
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
  agents = [agent("claude_desktop", "Claude 客户端")];
  agents[0].capabilities!.autoMemory = "explicit";
  agents[0].modes = [{ id: "chat", autoMemory: "explicit" }, { id: "code", autoMemory: "hook" }, { id: "cowork", configuration: "unsupported", autoMemory: "unverified" }];
  await render();
  expect(host.textContent).toContain("等待客户端加载");
  expect(host.textContent).not.toContain("配置已保存，等待客户端加载");
  expect(host.querySelector(".my-ai-connection-details")).toBeNull();
  await act(async () => button("连接详情").click());
  expect(host.textContent).toContain("配置已保存，等待客户端加载");
  expect(host.textContent).not.toContain("资料检索已验证");
  await optimize();
  expect(posts.find(item => item.action === "optimize")?.body).toMatchObject({ agent: "claude_desktop", mode: "chat", agentContext: { memoryEnabled: false } });
  await act(async () => {
    const select = host.querySelector<HTMLSelectElement>('[aria-label="Claude 运行模式"]')!;
    select.value = "code"; select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(host.textContent).not.toContain("优化后的提示词");
  expect(host.querySelector(".my-ai-connection-details")).toBeNull();
  await act(async () => button("连接详情").click());
  expect(host.textContent).toContain("支持配置逐轮采集");
  await act(async () => button("优化提示词").click());
  expect(posts.filter(item => item.action === "optimize").at(-1)?.body.mode).toBe("code");
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
  expect(button("配置资料工具")).toBeUndefined();
  expect(posts.some(item => item.action.startsWith("agent-context/"))).toBe(false);
  await optimize();
  expect(posts.find(item => item.action === "optimize")?.body).not.toHaveProperty("agentContext");
});

it("prepares Gemini in a terminal without claiming the task executed", async () => {
  agents = [agent("gemini", "Gemini CLI", "terminal-confirm")];
  respond = async action => action === "handoff" ? Response.json({ opened: true, prepared: true, delivery: "terminal-confirm" }) : undefined;
  await render();
  await enter(host.querySelector<HTMLInputElement>('[aria-label="工作目录"]')!, "/tmp/synthetic-project");
  await optimize();
  await act(async () => button("在终端核对任务").click());
  expect(posts.find(item => item.action === "handoff")?.body).toMatchObject({ agent: "gemini", workspacePath: "/tmp/synthetic-project" });
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
  agents = [agent("gemini", "Gemini CLI", "terminal-confirm")];
  let saveFails = false;
  respond = async (action, body) => action === "agent-context/selection" && body.selection && saveFails
    ? Response.json({ error: { message: "范围保存失败" } }, { status: 400 }) : undefined;
  await render();
  await act(async () => button("参考星图").click());
  await act(async () => button("测试星图").click());
  expect(posts.find(item => item.action === "agent-context/selection" && item.body.selection)?.body).toMatchObject({ agent: "gemini", selection: { warehouseId: "warehouse-one", memoryEnabled: false } });
  saveFails = true;
  const toggle = button("允许检索记忆");
  await act(async () => toggle.click());
  expect(toggle.getAttribute("aria-pressed")).toBe("false");
  expect(host.textContent).toContain("范围保存失败");
  expect(host.textContent).toContain("测试星图");
});

it("ignores the previous agent's delayed selection after the target changes", async () => {
  agents = [agent("codex", "Codex 客户端"), agent("gemini", "Gemini CLI", "terminal-confirm")];
  let finishOld: ((response: Response) => void) | undefined;
  respond = async (action, body) => {
    if (action === "agent-context/selection" && body.agent === "codex") return new Promise<Response>(resolve => { finishOld = resolve; });
    if (action === "agent-context/selection" && body.agent === "gemini") return Response.json({
      selection: { warehouseId: "gemini-warehouse", memoryEnabled: false }, resources: { warehouse: { id: "gemini-warehouse", name: "Gemini 范围" } },
    });
    return undefined;
  };
  await render();
  await act(async () => button("Gemini CLI", host.querySelector(".my-ai-agent-list")!).click());
  expect(host.textContent).toContain("Gemini 范围");
  await act(async () => finishOld!(Response.json({
    selection: { warehouseId: "old-warehouse", memoryEnabled: true }, resources: { warehouse: { id: "old-warehouse", name: "过期 Codex 范围" } },
  })));
  expect(host.textContent).not.toContain("过期 Codex 范围");
  expect(button("允许检索记忆").getAttribute("aria-pressed")).toBe("false");
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
    ["claude_desktop", "Claude 客户端"], ["gemini", "Gemini CLI"], ["workbuddy", "WorkBuddy"],
    ["qwenwork", "QwenWork"], ["deepseek_harness", "DeepSeek Harness"],
  ];
  agents = entries.map(([id, name]) => agent(id!, name!));
  await render();
  for (const [, name] of entries) {
    const row = [...host.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")].find(item => item.textContent?.includes(name!));
    expect(row?.querySelector(".my-ai-agent-logo img"), name).toBeTruthy();
  }
  await act(async () => button("添加应用").click());
  expect(document.querySelectorAll(".my-ai-app-catalog .my-ai-agent-logo img")).toHaveLength(8);
  expect(host.textContent).not.toContain("统一记忆导入导出");
  expect(host.textContent).not.toContain("记忆包导入导出");
});


it("uses matching source buttons and persists memory toggle independently without expanding the selected scope", async () => {
  await render();
  const toggle = button("允许检索记忆");
  expect(toggle.classList.contains("my-ai-source-trigger")).toBe(true);
  expect(toggle.querySelector("svg")).toBeTruthy();
  expect(toggle.getAttribute("aria-pressed")).toBe("false");
  expect(host.querySelector('input[type="checkbox"]')).toBeNull();
  await act(async () => toggle.click());
  expect(toggle.getAttribute("aria-pressed")).toBe("true");
  expect(posts.filter(item => item.action === "agent-context/selection" && item.body.selection).at(-1)?.body)
    .toEqual({ agent: "codex", selection: { memoryEnabled: true } });
  await act(async () => toggle.click());
  expect(toggle.getAttribute("aria-pressed")).toBe("false");
  expect(posts.filter(item => item.action === "agent-context/selection" && item.body.selection).at(-1)?.body)
    .toEqual({ agent: "codex", selection: { memoryEnabled: false } });
  expect(host.textContent).not.toContain("启动任务时重新校验权限");
});
