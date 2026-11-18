import { readMemoryConnection } from "./local-memory-runtime.mjs";

const sources = { codex: "Codex", claude_code: "Claude Code" };
const failure = code => Object.assign(new Error(code), { code });

export function createZhijunMemmyRead({ runtimeFile, confirm, request = fetch }) {
  return async ({ query, source }, check, signal) => {
    const label = Object.hasOwn(sources, source) && sources[source];
    if (!label || typeof query !== "string" || !query.trim() || query.length > 300)
      throw failure("ASSISTANT_INVALID_INPUT");
    check();
    if (!await confirm(label)) return { canceled: true, items: [] };
    check();
    signal.throwIfAborted();
    const { base, token } = await readMemoryConnection(runtimeFile);
    check();
    const headers = { "content-type": "application/json", "x-memmy-local-token": token };
    const endpoint = new URL("/api/v1/panel/browse", base);
    const response = await request(endpoint, {
      method: "POST", headers, redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      body: JSON.stringify({ op: "create", filter: { sourceAgent: source, q: query.trim(), status: "active" } }),
    });
    if (!response.ok) throw failure("ZHIJUN_MEMMY_UNAVAILABLE");
    const result = await response.json();
    if (typeof result.viewId === "string") {
      void request(endpoint, { method: "POST", headers, redirect: "error", signal: AbortSignal.timeout(3000),
        body: JSON.stringify({ op: "release", viewId: result.viewId }),
      }).catch(() => {});
    }
    check();
    signal.throwIfAborted();
    return { items: (result.items || []).slice(0, 8).map(item => ({
      title: String(item.title || "").slice(0, 180),
      text: String(item.sourceText || item.summary || "").slice(0, 1500),
      createdAt: item.createdAt,
      source: label,
    })) };
  };
}
