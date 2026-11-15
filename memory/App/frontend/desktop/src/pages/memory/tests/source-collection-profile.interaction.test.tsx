// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppClients } from "../../../api/client-types.js";
import { AppProviders, useApiClients } from "../../../app/providers.js";
import { MemorySourcesContent } from "../../memory-sources-page.js";

type CollectionProfile = { id: string; name: string } | null | undefined;
let container: HTMLDivElement;
let root: Root;
let clients: AppClients;
const source = (sourceId: string, displayName: string, status = "not_connected") => ({
  sourceId, displayName, status, builtin: true, available: true, dataPath: "/synthetic/" + sourceId,
  messageCount: 0, lastScannedAt: null,
});

function Harness({ profile }: { profile: CollectionProfile }) {
  const { setClients } = useApiClients();
  useEffect(() => { setClients(clients); }, [setClients]);
  return <MemorySourcesContent embedded surface="my-ai" collectionProfile={profile}
    localAgents={[{ id: "codex", name: "Codex" }, { id: "gemini", name: "Gemini CLI" }]} />;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(window, "localStorage", { configurable: true, value: createMemoryStorage() });
  Object.defineProperty(window, "sessionStorage", { configurable: true, value: createMemoryStorage() });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  clients = {
    runtimeConfig: { baseUrl: "http://synthetic.invalid", localToken: "synthetic", memory: { baseUrl: "http://synthetic.invalid" } },
    localData: { getPath: vi.fn(async () => ({ ok: true, dataPath: "/synthetic/memory" })) },
    memoryRuntime: { health: vi.fn(async () => ({ ok: true, storage: { ready: true } })) },
    config: {
      getScanPreferences: vi.fn(async () => ({ autoScanKnownAgents: false, watchFileChanges: false, autoInjectSkill: false })),
      updateOnboarding: vi.fn(async () => ({ scanPermission: "scan_only" })),
      updateScanPreferences: vi.fn(async (value: object) => value),
    },
    agentSources: {
      listSources: vi.fn(async () => [source("codex", "Codex"), source("cursor", "Cursor")]),
      getScanStatus: vi.fn(async () => ({ active: false, progress: null })),
      startScan: vi.fn(async () => ({ jobId: "scoped-scan", attemptId: "attempt" })),
      installPlugin: vi.fn(async () => {}), uninstallPlugin: vi.fn(async () => {}),
      installSkill: vi.fn(async () => {}), uninstallSkill: vi.fn(async () => {}),
    },
  } as unknown as AppClients;
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });

async function render(profile: CollectionProfile) {
  await act(async () => root.render(<AppProviders><Harness profile={profile} /></AppProviders>));
}
const buttons = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].filter(item => item.textContent?.trim() === label);
function expectNoIntegrationWrites() {
  expect(clients.agentSources.installPlugin).not.toHaveBeenCalled();
  expect(clients.agentSources.uninstallPlugin).not.toHaveBeenCalled();
  expect(clients.agentSources.installSkill).not.toHaveBeenCalled();
  expect(clients.agentSources.uninstallSkill).not.toHaveBeenCalled();
}

it.each([
  { id: "codex-desktop", name: "Codex Desktop", status: "not_connected" },
  { id: "codex-cli", name: "Codex CLI", status: "plugin_installed" },
])("uses local scanning in $name without exposing global Hook actions", async ({ id, name, status }) => {
  vi.mocked(clients.agentSources.listSources).mockResolvedValue([
    source("codex", "Codex", status), source("cursor", "Cursor"),
  ] as never);
  await render({ id, name });
  const rows = [...container.querySelectorAll("article.my-ai-sync-source")];
  expect(rows).toHaveLength(1);
  expect(rows[0].textContent).toContain(name);
  expect(container.textContent).not.toContain("Cursor");
  expect(container.textContent).not.toContain("Gemini CLI");
  expect(container.textContent).toContain("本机扫描采集");
  expect(container.textContent).not.toContain("未安装 Hook");
  expect(buttons("接入记忆")).toHaveLength(0);
  expect(buttons("断开接入")).toHaveLength(0);
  expect(container.textContent).not.toContain("发现新 Agent 时自动接入");
  expect(container.textContent).toContain("启动时主动扫描");
  expect(container.textContent).toContain("定时扫描");
  expect(buttons("首次扫描")[0].disabled).toBe(false);
  expect(buttons("同步新增")[0].disabled).toBe(false);
  await act(async () => buttons("同步新增")[0].click());
  expect(clients.agentSources.startScan).toHaveBeenCalledWith(expect.objectContaining({ sourceId: "codex" }));
  expectNoIntegrationWrites();
  expect(clients.config.updateScanPreferences).not.toHaveBeenCalled();
});

it.each([undefined, { id: "legacy", name: "旧版混合库" }])("keeps legacy Hook integration behavior for %j", async profile => {
  await render(profile);
  const codexRow = [...container.querySelectorAll<HTMLElement>("article.my-ai-sync-source")].find(item => item.textContent?.includes("Codex"))!;
  const connect = [...codexRow.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === "接入记忆")!;
  expect(connect.disabled).toBe(false);
  await act(async () => connect.click());
  expect(clients.agentSources.installPlugin).toHaveBeenCalledWith("codex", { installType: "manual" });
  expect(container.textContent).toContain("Cursor");
  expect(container.textContent).toContain("发现新 Agent 时自动接入");
});

it.each([null, { id: "future-library", name: "未识别库" }])("fails closed for profile %j after previously showing legacy actions", async unresolved => {
  await render({ id: "legacy", name: "旧版混合库" });
  const oldConnect = buttons("接入记忆")[0];
  expect(oldConnect).toBeDefined();
  await render(unresolved);
  expect(container.textContent).toContain(unresolved === null ? "正在确认当前记忆库" : "当前记忆库暂不支持来源采集配置");
  expect(buttons("接入记忆")).toHaveLength(0);
  expect(buttons("断开接入")).toHaveLength(0);
  expect(container.querySelectorAll("article.my-ai-sync-source")).toHaveLength(0);
  expect(container.textContent).not.toContain("发现新 Agent 时自动接入");
  expect(buttons("同步新增")[0].disabled).toBe(true);
  expectNoIntegrationWrites();
  expect(clients.agentSources.startScan).not.toHaveBeenCalled();
  const scanSettings = [...container.querySelectorAll<HTMLButtonElement>('[role="switch"]')];
  expect(scanSettings).toHaveLength(2);
  expect(scanSettings.every(item => item.disabled)).toBe(true);
  await act(async () => { scanSettings.forEach(item => item.click()); });
  expect(clients.config.updateScanPreferences).not.toHaveBeenCalled();
  await render({ id: "codex-cli", name: "Codex CLI" });
  expect(container.querySelectorAll("article.my-ai-sync-source")).toHaveLength(1);
  expect(container.textContent).toContain("Codex CLI");
  expect(buttons("同步新增")[0].disabled).toBe(false);
});

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}
