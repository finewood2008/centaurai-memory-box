export const managedAgentIds = new Set([
  "codex", "codex_cli", "claude_code", "claude_desktop", "gemini", "workbuddy", "workbuddy_cn", "qwenwork", "deepseek_harness",
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
  connectionAvailable?: boolean;
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
  authorized?: boolean;
  allPersonalReadOnly?: boolean;
  revokedAccess?: "all-personal-read-only" | "connection";
  outputFolder?: TaskSource;
  connected?: boolean;
  available?: boolean;
  configured?: boolean;
  configurationChanged?: boolean;
  serviceReady?: boolean;
  loaded?: boolean;
  connectionTested?: boolean;
  retrievalVerified?: boolean;
  memorySaved?: boolean | string;
  boxReady?: boolean;
}

export type ConnectionOperation = "connect" | "test" | "disconnect";
export interface ConnectionActivity { source: string; operation: ConnectionOperation; error?: string; errorCode?: string }

export interface TaskSource { id: string; name: string }
export interface TaskSources { folder?: TaskSource; warehouse?: TaskSource; memoryEnabled?: boolean; memoryAgent?: string | null }
export interface TaskSelection { folderId?: string; warehouseId?: string; memoryEnabled: boolean; memoryAgent?: string | null }
export type MyAiRequest = <T>(action: string, signal: AbortSignal, data?: object) => Promise<T>;

export function contextAgentId(agent: string, mode = "chat") {
  if (agent === "codex_cli") return "codex";
  if (agent === "claude_desktop" && mode === "code") return "claude_code";
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

export const workBuddyTrustHint = "首次连接时，在 WorkBuddy 左侧打开「专家·技能·连接器」，选择「连接器」→「自定义连接器」。在「MCP 服务管理」的「我的 MCP」中找到 wanx-memobox，点击该服务的「信任」。";

export function connectionProgress(status: AgentAccessStatus | undefined, activity: ConnectionActivity | undefined,
  { hasConnection, boxDisconnected, guided, terminal, agentId }: { hasConnection: boolean; boxDisconnected: boolean; guided: boolean; terminal: boolean; agentId?: string }) {
  const waitHint = agentId === "workbuddy_cn" ? workBuddyTrustHint
    : guided ? "在智能体内添加并信任接入配置，加载后再测试。"
    : terminal ? "请新开一个 CLI 会话，再回来测试连接。"
    : "请打开智能体应用。如果应用已打开，先完全退出再重新打开。";
  if (activity?.error) return { step: hasConnection ? 1 : 0, tone: "error",
    title: activity.operation === "test" ? "连接测试未通过" : activity.operation === "disconnect" ? "断开连接失败" : "连接未完成",
    hint: activity.error };
  if (activity) {
    const title = { connect: "正在连接智能体…", test: "正在测试连接…", disconnect: "正在断开连接…" }[activity.operation];
    return { step: activity.operation === "test" ? 1 : 0, tone: "working", title,
      hint: activity.operation === "test" ? "正在检查记忆盒子客户端的本机 MCP 服务。" : undefined };
  }
  if (status?.serviceReady === false && hasConnection)
    return { step: 1, tone: "error", title: "本机连接暂不可用", hint: "请检查记忆盒子客户端的 MCP 服务，恢复后重新测试。" };
  if (hasConnection && status?.loaded)
    return { step: 3, tone: "success", title: "已连接本机客户端",
      hint: boxDisconnected ? "智能体已加载工具。盒子连通后即可检索授权资料。" : "智能体已加载记忆盒子客户端的工具。" };
  if (status?.connectionTested)
    return { step: 2, tone: "waiting", title: "本机测试通过，等待智能体加载", hint: waitHint };
  if (hasConnection)
    return { step: 1, tone: "waiting", title: "等待智能体加载", hint: waitHint };
  if (status?.revokedAccess) return { step: 0, tone: "idle",
    title: status.revokedAccess === "all-personal-read-only" ? "已撤销授权" : "已断开连接",
    hint: "可在「连接详情」重新连接。" };
  if (boxDisconnected) return { step: 0, tone: "idle", title: "等待连接盒子", hint: "请先连接盒子以选择并授权资料范围。" };
  return { step: 0, tone: "idle", title: "尚未连接", hint: undefined };
}
