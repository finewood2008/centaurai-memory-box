import claudeCodeLogoUrl from "../assets/agent-logos/claude-code.svg";
import geminiLogoUrl from "../assets/model-logos/gemini.svg";
import codexLogoUrl from "../assets/agent-logos/codex.svg";
import cursorLogoUrl from "../assets/agent-logos/cursor.svg";
import deepseekHarnessLogoUrl from "../assets/agent-logos/deepseek-harness.svg";
import hermesLogoUrl from "../assets/agent-logos/hermes.svg";
import openclawLogoUrl from "../assets/agent-logos/openclaw.svg";
import opencodeLogoUrl from "../assets/agent-logos/opencode.svg";
import piLogoUrl from "../assets/agent-logos/pi.svg";
import qwenworkLogoUrl from "../assets/agent-logos/qwenwork.svg";
import workbuddyLogoUrl from "../assets/agent-logos/workbuddy.png";
import memmyRiceLogoUrl from "../assets/brand/centaurai-mark.png";

import diskLogo from "../assets/agent-logos/disk-agent.svg";
import clipLogo from "../assets/agent-logos/clip-agent.svg";

export const MEMORY_AGENT_SOURCE_VALUES = [
  "memmy-agent",
  "accessories",
  "meeting_recording",
  "portable_recording",
  "cursor",
  "claude_code",
  "claude_desktop",
  "codex",
  "gemini",
  "opencode",
  "openclaw",
  "hermes",
  "deepseek_harness",
  "workbuddy",
  "pi",
  "qwenwork"
] as const;

const AGENT_SOURCE_DISPLAY_NAMES: Record<string, string> = {
  memmy: "盒子内置记录",
  memmy_agent: "盒子内置记录",
  computer_history: "电脑使用记录",
  accessories: "配件记录（旧版录音、硬盘问答）",
  meeting_recording: "会议录音智能体",
  portable_recording: "随身录音智能体",
  cursor: "Cursor",
  claude_code: "Claude Code",
  codex: "Codex",
  codex_cli: "Codex CLI",
  claude_desktop: "Claude 客户端",
  gemini: "Gemini CLI",
  opencode: "OpenCode",
  openclaw: "OpenClaw",
  hermes: "Hermes",
  deepseek_harness: "DeepSeek Harness",
  workbuddy: "WorkBuddy",
  workbuddy_cn: "WorkBuddy（国内版）",
  pi: "Pi",
  qwenwork: "QwenWork"
};

export const AGENT_SOURCE_LOGOS: Partial<Record<string, string>> = {
  meeting_recording: diskLogo,
  portable_recording: clipLogo,
  cursor: cursorLogoUrl,
  claude_code: claudeCodeLogoUrl,
  codex: codexLogoUrl,
  codex_cli: codexLogoUrl,
  claude_desktop: claudeCodeLogoUrl,
  gemini: geminiLogoUrl,
  opencode: opencodeLogoUrl,
  openclaw: openclawLogoUrl,
  hermes: hermesLogoUrl,
  deepseek_harness: deepseekHarnessLogoUrl,
  workbuddy: workbuddyLogoUrl,
  workbuddy_cn: workbuddyLogoUrl,
  pi: piLogoUrl,
  qwenwork: qwenworkLogoUrl,
  memmy: memmyRiceLogoUrl,
  memmy_agent: memmyRiceLogoUrl,
  computer_history: memmyRiceLogoUrl
};

export function normalizeAgentSourceId(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/gu, "_");
}

export function agentSourceDisplayName(value: string): string {
  return AGENT_SOURCE_DISPLAY_NAMES[normalizeAgentSourceId(value)] ?? value.trim();
}

export function agentSourceLogoUrl(value: string): string | undefined {
  return AGENT_SOURCE_LOGOS[normalizeAgentSourceId(value)];
}

export function isMemmyAgentSource(value: string): boolean {
  const sourceId = normalizeAgentSourceId(value);
  return sourceId === "memmy" || sourceId === "memmy_agent" || sourceId === "computer_history";
}
