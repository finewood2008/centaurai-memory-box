import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { LlmConfig, MemmyConfig } from "../config/index.js";

export function withWanxMemoryModels(config: MemmyConfig): MemmyConfig {
  const runtime = process.env.MEMMY_RUNTIME_CONFIG_PATH?.trim() ||
    join(process.env.MEMMY_HOME?.trim() || join(homedir(), ".memmy"), "runtime.json");
  let host;
  try {
    host = JSON.parse(readFileSync(join(dirname(runtime), "wanx-memory-model.json"), "utf8"));
    if (!host || host.version !== 1 ||
        !Number.isInteger(host.port) || host.port < 1 || host.port > 65535 ||
        !Number.isInteger(host.pid) || host.pid < 1 ||
        typeof host.token !== "string" || !/^[a-f0-9]{64}$/.test(host.token)) return config;
    process.kill(host.pid, 0);
  } catch {
    return config;
  }

  const model = (base: LlmConfig, role: "memory_summary" | "memory_evolution"): LlmConfig => {
    const selected = host.roles ? host.roles[role] : host.model;
    const modelId = typeof selected === "string" && selected ? selected : null;
    return {
      provider: modelId ? "host" : "local_only",
      sourceProvider: "wanx",
      model: modelId ?? "wanx-default",
      endpoint: `http://127.0.0.1:${host.port}/complete`,
      apiKey: host.token,
      extraBody: { role, ...(typeof host.refs?.[role] === "string" && { expectedRef: host.refs[role] }) },
      enableThinking: base.enableThinking,
      temperature: base.temperature,
      maxTokens: base.maxTokens,
      timeoutMs: Math.max(base.timeoutMs, 125_000),
      maxRetries: 0,
      malformedRetries: base.malformedRetries
    };
  };

  return { ...config, summary: model(config.summary, "memory_summary"), evolution: model(config.evolution, "memory_evolution") };
}
