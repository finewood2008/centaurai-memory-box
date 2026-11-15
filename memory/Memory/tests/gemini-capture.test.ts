import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGeminiSourceAdapter, normalizeGeminiCapture, saveGeminiCapture } from "../src/agent-source/adapters/gemini/index.js";
import { createGeminiSkillTarget, renderGeminiCaptureHook } from "../src/agent-source/integration/gemini/index.js";
import { createAgentSourceExecutor } from "../src/agent-source/runtime.js";
import { createSourceRegistry } from "../src/agent-source/adapters/source-registry.js";
import type { MemoryService } from "../src/service/memory-service.js";
import { withUnrestrictedScanPermit } from "./fixtures/scan-admission-fixture.js";
import { resolveGeminiHomeDirectory } from "../src/agent-source/agent-paths.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), "memobox-gemini-test-")); roots.push(root); return root; }
const event = (extra: Record<string, unknown> = {}) => ({
  hook_event_name: "AfterAgent", session_id: "synthetic-session", timestamp: "2026-11-15T00:00:00.000Z",
  cwd: "/synthetic/workspace", prompt: "Remember the synthetic project", prompt_response: "The synthetic project uses blue files.", ...extra,
});
async function collect<T>(items: AsyncIterable<T>) { const result: T[] = []; for await (const item of items) result.push(item); return result; }

function run(script: string, input: unknown) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [script], { env: { PATH: process.env.PATH } });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject); child.on("close", code => resolve({ code, stdout, stderr }));
    child.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
  });
}

describe("Gemini AfterAgent capture", () => {
  it("uses the official GEMINI_CLI_HOME parent rather than inventing a config-directory variable", () => {
    expect(resolveGeminiHomeDirectory({ homeDirectory: "/synthetic/home", environment: { GEMINI_CLI_HOME: "/synthetic/custom" } }))
      .toBe("/synthetic/custom/.gemini");
    expect(resolveGeminiHomeDirectory({ homeDirectory: "/synthetic/home", environment: {} })).toBe("/synthetic/home/.gemini");
  });
  it("queues offline without a service and produces no host-control output", async () => {
    const root = await fixture();
    const queue = join(root, "memobox-captures");
    const script = join(root, "hook.mjs");
    await writeFile(script, renderGeminiCaptureHook(queue));
    expect(await run(script, event())).toEqual({ code: 0, stdout: "{}\n", stderr: "" });
    expect(await run(script, event())).toEqual({ code: 0, stdout: "{}\n", stderr: "" });
    const queued = await readdir(queue);
    expect(queued).toHaveLength(1);
    expect((await stat(join(queue, queued[0]!))).mode & 0o777).toBe(0o600);
    const scanned = await collect(createGeminiSourceAdapter({ rootDirectory: root }).scan({}));
    expect(scanned.map(item => item.role)).toEqual(["user", "assistant"]);
    expect(scanned[1]).toMatchObject({ sourceId: "gemini", conversationId: "synthetic-session", content: "The synthetic project uses blue files." });
    // Restarting a scanner sees the same durable ids, so existing source checkpoints can deduplicate.
    expect(await collect(createGeminiSourceAdapter({ rootDirectory: root }).scan({}))).toEqual(scanned);
    expect(await readdir(queue)).toEqual(queued);
  });

  it("redacts secrets before queue publication and preserves separate identical turns", async () => {
    const root = await fixture();
    const queue = join(root, "memobox-captures");
    const prompt = "password=synthetic-secret Authorization: Bearer synthetic-bearer";
    const first = normalizeGeminiCapture(event({ prompt }))!;
    await saveGeminiCapture(queue, first);
    await saveGeminiCapture(queue, normalizeGeminiCapture(event({ prompt, timestamp: "2026-11-15T00:01:00Z" }))!);
    const text = await readFile(join(queue, first.id + ".json"), "utf8");
    expect(text).not.toContain("synthetic-secret"); expect(text).not.toContain("synthetic-bearer");
    expect(await readdir(queue)).toHaveLength(2);
    const adapter = createGeminiSourceAdapter({ rootDirectory: root });
    expect(await collect(adapter.scan({ maxMessages: 1 }))).toEqual([]);
    expect(await collect(adapter.scan({ since: "2026-11-15T00:00:30Z" }))).toHaveLength(2);
  });

  it("feeds a complete ordered turn into the existing scanner and respects source revocation", async () => {
    const root = await fixture();
    await saveGeminiCapture(join(root, "memobox-captures"), normalizeGeminiCapture(event())!);
    const addMemory = vi.fn().mockReturnValue({ id: "synthetic-memory", duplicate: false });
    const service = { withAgentSourceScanPermit: withUnrestrictedScanPermit, addMemory, enqueuePendingImportSummaries: vi.fn() } as unknown as MemoryService;
    const executor = createAgentSourceExecutor({
      service, configPath: join(root, "config.yaml"), statePath: join(root, "source-state.json"),
      sourceRegistry: createSourceRegistry([createGeminiSourceAdapter({ rootDirectory: root })]),
      resolveAgentSkillRoot: () => null,
    });
    try {
      await executor.startScan({ sourceId: "gemini", mode: "full" });
      await vi.waitFor(() => expect(executor.scanStatus().running).toBe(false));
      expect(executor.scanStatus().error).toBeNull();
      expect(addMemory).toHaveBeenCalledTimes(1);
      const request = addMemory.mock.calls[0]![0];
      expect(request).toMatchObject({ source: "gemini", adapterId: "agent-source:gemini" });
      expect(JSON.stringify(request)).toContain("Remember the synthetic project");
      expect(JSON.stringify(request)).toContain("The synthetic project uses blue files.");
      await executor.setSyncAccess("gemini", false);
      await expect(executor.startScan({ sourceId: "gemini", mode: "full" })).rejects.toThrow(/sync access is disabled/);
      expect((await readdir(join(root, "memobox-captures"))).length).toBe(1);
    } finally { await executor.dispose(); }
  });

  it("ignores malformed or incomplete events, symlink captures, and private transcripts", async () => {
    const root = await fixture();
    const queue = join(root, "memobox-captures");
    const script = join(root, "hook.mjs");
    await writeFile(script, renderGeminiCaptureHook(queue));
    expect((await run(script, event({ hook_event_name: "SessionEnd" }))).stdout).toBe("{}\n");
    expect(normalizeGeminiCapture(event({ prompt_response: "" }))).toBeNull();
    expect(normalizeGeminiCapture(event({ timestamp: "invalid" }))).toBeNull();
    expect(await run(script, "invalid JSON")).toMatchObject({ code: 0, stdout: "{}\n" });
    const capture = normalizeGeminiCapture(event())!;
    await saveGeminiCapture(queue, capture);
    await writeFile(join(root, "native-transcript.json"), JSON.stringify({ messages: [{ content: "private" }] }));
    await symlink(join(root, "native-transcript.json"), join(queue, "a".repeat(64) + ".json"));
    expect(await collect(createGeminiSourceAdapter({ rootDirectory: root }).scan({}))).toHaveLength(2);
  });
});

describe("Gemini hook-only installation", () => {
  it("preserves settings, comments and other hooks without changing instruction or trust files", async () => {
    const root = await fixture();
    await writeFile(join(root, "settings.json"), '{\n// user note\n"mcpServers":{"user":{"command":"existing"}},"hooks":{"AfterAgent":[{"hooks":[{"name":"user-hook","type":"command","command":"existing"}]}]}}\n');
    await writeFile(join(root, "GEMINI.md"), "User instructions stay exactly as written.\n");
    const target = createGeminiSkillTarget({ rootDirectory: root });
    await target.installPlugin!("gemini"); await target.installPlugin!("gemini");
    expect(await target.isInstalled("gemini")).toBe(true);
    expect(await readFile(join(root, "GEMINI.md"), "utf8")).toBe("User instructions stay exactly as written.\n");
    const settings = await readFile(join(root, "settings.json"), "utf8");
    expect(settings).toContain("// user note"); expect(settings).toContain("existing");
    expect(settings).not.toMatch(/trust|autoApprove|yolo/);
    await target.uninstallPlugin!("gemini");
    expect(await target.isInstalled("gemini")).toBe(false);
    const removed = await readFile(join(root, "settings.json"), "utf8");
    expect(removed).toContain("user-hook"); expect(removed).not.toContain("memobox-gemini-capture");
  });

  it("rejects broken configuration and unrelated hooks using the reserved name", async () => {
    const root = await fixture();
    const settings = join(root, "settings.json");
    await writeFile(settings, "invalid");
    const target = createGeminiSkillTarget({ rootDirectory: root });
    await expect(target.installPlugin!("gemini")).rejects.toThrow("Invalid Gemini");
    expect(await readFile(settings, "utf8")).toBe("invalid");
    await writeFile(settings, JSON.stringify({ hooks: { AfterAgent: [{ hooks: [{ name: "memobox-gemini-capture", command: "unrelated" }] }] } }));
    await expect(target.installPlugin!("gemini")).rejects.toThrow("already in use");
    expect(await readFile(settings, "utf8")).toContain("unrelated");
  });
});
