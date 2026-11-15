export const managedAgentIds = new Set([
  "codex", "codex_cli", "claude_code", "claude_desktop", "gemini", "workbuddy", "qwenwork", "deepseek_harness",
]);

export interface AgentCapabilities {
  delivery: "draft" | "terminal-confirm" | "copy-open";
  configuration: "automatic" | "guided" | "unsupported";
  autoMemory: "hook" | "scan" | "explicit" | "unverified";
  limitations: string[];
}
interface AgentMode extends Partial<AgentCapabilities> { id: string; name?: string; capabilities?: Partial<AgentCapabilities> }

export interface Agent {
  id: string;
  name: string;
  installed: boolean;
  prefill?: boolean;
  launchable?: boolean;
  uninstallable?: boolean;
  installable?: boolean;
  version?: string;
  channel?: string;
  sourceId?: string;
  capabilities?: AgentCapabilities;
  modes?: (string | AgentMode)[];
  downloadLabel?: "官方下载" | "安装说明";
}

export interface AgentAccessStatus {
  connected?: boolean;
  available?: boolean;
  configured?: boolean;
  serviceReady?: boolean;
  loaded?: boolean;
  retrievalVerified?: boolean;
  memorySaved?: boolean | string;
  boxReady?: boolean;
}

export interface TaskSource { id: string; name: string }
export interface TaskSources { folder?: TaskSource; warehouse?: TaskSource; memoryEnabled?: boolean }
export interface TaskSelection { folderId?: string; warehouseId?: string; memoryEnabled: boolean }
export type MyAiRequest = <T>(action: string, signal: AbortSignal, data?: object) => Promise<T>;

export function contextAgentId(agent: string, mode = "chat") {
  if (agent === "codex_cli") return "codex";
  if (agent === "claude_desktop" && mode === "code") return "claude_code";
  if (agent === "claude_desktop" && mode === "cowork") return undefined;
  return agent;
}

export function modeCapabilities(agent: Agent | undefined, mode: string) {
  const base = agent?.capabilities;
  if (!base) return undefined;
  const selected = agent?.modes?.find(item => typeof item !== "string" && item.id === mode);
  if (!selected || typeof selected === "string") return base;
  return {
    delivery: selected.capabilities?.delivery ?? selected.delivery ?? base.delivery,
    configuration: selected.capabilities?.configuration ?? selected.configuration ?? base.configuration,
    autoMemory: selected.capabilities?.autoMemory ?? selected.autoMemory ?? base.autoMemory,
    limitations: [...base.limitations, ...(selected.capabilities?.limitations ?? selected.limitations ?? [])],
  };
}

export function accessStatusText(status?: AgentAccessStatus) {
  if (status?.retrievalVerified) return "资料检索已验证";
  if (status?.loaded) return "客户端已加载，等待检索验证";
  if (status?.configured || status?.connected) return "配置已保存，等待客户端加载";
  return "尚未配置资料工具";
}
