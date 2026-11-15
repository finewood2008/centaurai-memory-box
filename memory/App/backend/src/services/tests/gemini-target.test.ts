import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGeminiSkillTarget } from "../../adapters/outbound/skill-writer/gemini/index.js";
import { createBuiltinSkillTargetRegistry } from "../builtin-skill-target-registry.js";
import { createAgentSourceAutoInjectService } from "../agent-source-auto-inject-service.js";
import type { AgentSourceView } from "@memmy/local-api-contracts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("Gemini Desktop service hook distribution", () => {
  it("registers and installs a working capture hook without altering user instructions", async () => {
    expect(createBuiltinSkillTargetRegistry().require("gemini").displayName).toBe("Gemini CLI");
    const root = await mkdtemp(join(tmpdir(), "memobox-gemini-backend-")); roots.push(root);
    await writeFile(join(root, "GEMINI.md"), "synthetic instructions\n");
    const target = createGeminiSkillTarget({ rootDirectory: root });
    await target.installPlugin!("gemini");
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [join(root, "hooks", "memobox-after-agent.mjs")]);
      let stdout = "", stderr = "";
      child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
      child.on("error", reject); child.on("close", status => resolve({ status, stdout, stderr }));
      child.stdin.end(JSON.stringify({ hook_event_name: "AfterAgent", session_id: "synthetic-session", timestamp: "2026-11-15T00:00:00Z", prompt: "Synthetic question", prompt_response: "Synthetic answer" }));
    });
    expect(result).toEqual({ status: 0, stdout: "{}\n", stderr: "" });
    expect(await readdir(join(root, "memobox-captures"))).toHaveLength(1);
    expect(await readFile(join(root, "GEMINI.md"), "utf8")).toBe("synthetic instructions\n");
    await target.uninstallPlugin!("gemini");
    expect(await target.isInstalled("gemini")).toBe(false);
  });

  it("uses the hook path only when automatic injection and write permission are enabled", async () => {
    const installPlugin = vi.fn(async () => {}), installSkill = vi.fn(async () => {});
    const source: AgentSourceView = { sourceId: "gemini", displayName: "Gemini CLI", builtin: true, available: true, dataPath: "/synthetic/gemini", status: "not_connected", messageCount: 0, lastScannedAt: null };
    const agentSources = { list: async () => [source], installPlugin, installSkill, isInstalledHookCurrent: async () => true };
    const service = createAgentSourceAutoInjectService({ agentSources, permissionManager: { canWriteAgentSkill: async () => true }, getScanPreferences: () => ({ autoInjectSkill: true, autoScanKnownAgents: true, watchFileChanges: true }) });
    expect(await service.runOnce()).toMatchObject({ installed: ["gemini"], failed: [] });
    expect(installPlugin).toHaveBeenCalledWith("gemini", { installType: "auto_inject" });
    expect(installSkill).not.toHaveBeenCalled();
    const disabled = createAgentSourceAutoInjectService({ agentSources, permissionManager: { canWriteAgentSkill: async () => false }, getScanPreferences: () => ({ autoInjectSkill: true, autoScanKnownAgents: true, watchFileChanges: true }) });
    expect(await disabled.runOnce()).toMatchObject({ installed: [], failed: [] });
    expect(installPlugin).toHaveBeenCalledTimes(1);
  });
});
