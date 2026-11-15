// Read-only operator check. Never submits feedback or changes server content.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
const args = process.argv.slice(2);
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : null;
const url = new URL(option("--url") || "https://boss.nexusaos.qitus.cn/prod-api/app-api/faq");
if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !url.pathname.endsWith("/app-api/faq"))
  throw Error("Expected an HTTPS public FAQ URL without credentials, query or fragment");
const response = await fetch(url, { redirect: "error", cache: "no-cache", signal: AbortSignal.timeout(20000) });
if (!response.ok) throw Error(`FAQ_HTTP_${response.status}`);
const payload = await response.json();
if (payload.code !== 200 || typeof payload.data?.version !== "string") throw Error("FAQ_INVALID_RESPONSE");
const file = option("--cache-file");
const cache = file ? JSON.parse(await readFile(file, "utf8")) : null;
if (cache) {
  const edition = option("--edition") || "personal";
  if (!["personal", "team"].includes(edition)) throw Error("FAQ_INVALID_EDITION");
  const baseURL = new URL(url.href.replace(/\/app-api\/faq$/, "")).href;
  const expectedScope = createHash("sha256").update(`${edition}:${baseURL}`).digest("hex").slice(0, 24);
  if (cache.schema !== 1 || cache.scope !== expectedScope) throw Error("FAQ_CACHE_SCOPE_MISMATCH");
}
const result = { serverVersion: payload.data.version, serverEtag: response.headers.get("etag"),
  ...(cache ? { cacheVersion: cache.data?.version, lastCheckedAt: new Date(cache.lastCheckedAt).toISOString(),
    updatedAt: new Date(cache.updatedAt).toISOString(), matches: cache.data?.version === payload.data.version } : {}) };
console.log(JSON.stringify(result, null, 2));
if (cache && !result.matches) process.exitCode = 1;
