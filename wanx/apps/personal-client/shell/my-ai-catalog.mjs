const workBuddyMacDisplayNames = {
  "workbuddy ai.app": "WorkBuddy（海外版）",
  "workbuddy.app": "WorkBuddy（国内版）",
};

// Runtime entries are separate from memory source identities. Codex desktop and CLI
// deliberately share one MCP configuration and one memory source.
export const agentCatalog = Object.freeze([
  { id: "codex", product: "codex", name: "Codex 客户端", variant: "desktop", sourceId: "codex", protocol: "codex://threads/new", bundles: ["codex.app", "chatgpt.app"], windowsExecutables: ["codex.exe", "chatgpt.exe"], download: "https://chatgpt.com/download/", delivery: "draft", configuration: "automatic", autoMemory: "unverified", limitations: ["桌面自动采集需单独验收。"] },
  { id: "codex_cli", product: "codex", name: "Codex CLI", variant: "cli", sourceId: "codex", command: "codex", download: "https://developers.openai.com/codex/cli/", npmPackage: "@openai/codex", delivery: "terminal-confirm", configuration: "automatic", autoMemory: "hook", limitations: ["采集 hook 须在 Codex 中信任后生效。"] },
  { id: "claude_code", product: "claude", name: "Claude Code CLI", variant: "cli", sourceId: "claude_code", command: "claude", download: "https://code.claude.com/docs/en/setup", delivery: "terminal-confirm", configuration: "automatic", autoMemory: "hook", limitations: [] },
  { id: "claude_desktop", product: "claude", name: "Claude 客户端", variant: "desktop", sourceId: "claude_desktop", protocol: "claude://claude.ai/new", bundles: ["claude.app"], windowsExecutables: ["claude.exe"], download: "https://claude.com/download", delivery: "draft", configuration: "automatic", autoMemory: "explicit", modes: [
    { id: "chat", name: "Chat", capabilities: { delivery: "draft", configuration: "automatic", autoMemory: "explicit", limitations: [] } },
    { id: "code", name: "Code", capabilities: { delivery: "draft", configuration: "automatic", autoMemory: "hook", limitations: [] } },
    { id: "cowork", name: "Cowork", capabilities: { delivery: "draft", configuration: "automatic", autoMemory: "unverified", limitations: ["请在 Claude 桌面端选择在本机运行 Cowork。此模式与 Claude Chat 共用客户端连接。"] } },
  ], limitations: [] },
  { id: "gemini", product: "gemini", name: "Gemini CLI", variant: "cli", sourceId: "gemini", command: "gemini", download: "https://geminicli.com/docs/get-started/installation/", npmPackage: "@google/gemini-cli", delivery: "terminal-confirm", configuration: "automatic", autoMemory: "hook", limitations: [] },
  { id: "workbuddy", product: "workbuddy", name: "WorkBuddy", variant: "desktop", sourceId: "workbuddy", protocol: "workbuddy://", bundles: Object.keys(workBuddyMacDisplayNames), macBundleDisplayNames: workBuddyMacDisplayNames, windowsExecutables: ["workbuddy.exe"], download: "https://www.workbuddy.ai/docs/workbuddy/From-Beginner-to-Expert-Guide/Installation-Mac-Guide", delivery: "copy-open", configuration: "guided", autoMemory: "scan", limitations: ["请在应用内添加并信任自定义 Connector。", "尚无可靠桌面提示词预填接口，使用复制并打开。"] },
  { id: "qwenwork", product: "qwenwork", name: "QwenWork", variant: "desktop", sourceId: "qwenwork", bundles: ["qwenwork.app", "qwenworkcn.app", "千问办公.app"], download: "https://qwenwork.cn/download", delivery: "copy-open", configuration: "guided", autoMemory: "unverified", limitations: ["请在连接器中导入配置，需按实际版本验证采集。", "尚无可靠桌面提示词预填接口，使用复制并打开。"] },
  { id: "deepseek_harness", product: "deepseek_harness", name: "DeepSeek Harness", variant: "desktop", sourceId: "deepseek_harness", bundles: ["deepseek harness.app", "deepseek-harness.app", "deepseek.app"], download: "https://www.deepseek.com/en/harness/", delivery: "copy-open", configuration: "automatic", autoMemory: "scan", limitations: ["仅配置所选 Desktop profile；预览版兼容性需验证。", "尚无可靠桌面提示词预填接口，使用复制并打开。"] },
]);

export const managedAgentIds = Object.freeze(agentCatalog.map(agent => agent.id));
export const managedSourceIds = Object.freeze([...new Set(agentCatalog.map(agent => agent.sourceId))]);

export function contextAgent(agent, mode) {
  if (!managedAgentIds.includes(agent)) return null;
  if (agent === "codex_cli") return "codex";
  if (agent === "claude_desktop") {
    if (mode === "code") return "claude_code";
    if (mode !== undefined && mode !== "chat" && mode !== "cowork") return null;
  }
  return agent;
}

export function catalogAgent(id) {
  return agentCatalog.find(agent => agent.id === id);
}

export function agentCapabilities(agent, mode) {
  const selected = agent.modes?.find(candidate => candidate.id === (mode ?? "chat"))?.capabilities;
  return {
    delivery: agent.delivery,
    configuration: selected?.configuration ?? agent.configuration,
    autoMemory: selected?.autoMemory ?? agent.autoMemory,
    limitations: [...agent.limitations, ...(selected?.limitations ?? [])],
  };
}
