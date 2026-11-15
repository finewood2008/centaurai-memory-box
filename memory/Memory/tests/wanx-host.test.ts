import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { DEFAULT_MEMMY_CONFIG } from "../src/config/index.js";
import { createLlmClient } from "../src/model/llm.js";
import { withWanxMemoryModels } from "../src/model/wanx-host.js";

test("WANX serves both text roles and retains the configured vector model", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wanx-model-test-"));
  vi.stubEnv("MEMMY_RUNTIME_CONFIG_PATH", join(directory, "runtime.json"));
  const token = "a".repeat(64);
  const requests: unknown[] = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      url: request.url,
      authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString())
    });
    response.end(JSON.stringify({ text: '{"ok":true}', finishReason: "stop" }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const file = join(directory, "wanx-memory-model.json");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server is not listening");
    const registration = { version: 1, port: address.port, pid: process.pid, token };
    expect(withWanxMemoryModels(DEFAULT_MEMMY_CONFIG)).toBe(DEFAULT_MEMMY_CONFIG);
    await writeFile(file, JSON.stringify({ ...registration, model: null }));
    const disconnected = withWanxMemoryModels(DEFAULT_MEMMY_CONFIG);
    expect(createLlmClient(disconnected.summary).isConfigured()).toBe(false);
    await writeFile(file, JSON.stringify({ ...registration, model: "default",
      roles: { memory_summary: "summary-model", memory_evolution: "evolution-model" } }));
    const configured = withWanxMemoryModels(DEFAULT_MEMMY_CONFIG);
    expect(configured.embedding).toBe(DEFAULT_MEMMY_CONFIG.embedding);
    expect(configured.summary.model).toBe("summary-model");
    expect(configured.evolution.model).toBe("evolution-model");
    const messages = [{ role: "user" as const, content: "synthetic prompt" }];
    for (const config of [configured.summary, configured.evolution]) {
      await expect(createLlmClient(config).completeJson(messages, { operation: "test" })).resolves.toEqual({ ok: true });
    }
    expect(requests).toHaveLength(2);
    expect(requests).toMatchObject(["memory_summary", "memory_evolution"].map(role => ({
      url: "/complete", authorization: "Bearer " + token, body: { jsonMode: true, role },
    })));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});
