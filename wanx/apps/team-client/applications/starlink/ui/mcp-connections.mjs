export const MCP_KEY_PREFIX = "MCP · ";
export const MCP_SCOPES = ["documents", "evidence", "graph", "reasoning", "search"];

function inputError(message) {
  return Object.assign(new Error(message), {publicMessage: message});
}

export function normalizeMcpEndpoint(value) {
  const raw = String(value || "").trim();
  if (/[\u0000-\u001f\u007f]/.test(raw)) throw inputError("MCP 地址不能包含控制字符。");
  let url;
  try { url = new URL(raw); }
  catch { throw inputError("请输入完整的万象 Bridge MCP 地址。"); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash ||
      !/^\/(?:[A-Za-z0-9_-]{1,64}\/)*mcp\/starlink\/?$/.test(url.pathname)) {
    throw inputError("服务器需返回 HTTPS 的 /mcp/starlink 地址；地址不能包含账号、参数或 Token。");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  return url.href;
}

export function mcpKeyName(name) {
  const value = String(name || "").trim();
  if (!value || [...value].length > 54 || /[\u0000-\u001f\u007f]/.test(value)) throw inputError("使用方名称需要填写，最多 54 个字符，不能包含控制字符。");
  return MCP_KEY_PREFIX + value;
}

export function isMcpKey(key) {
  return typeof key?.name === "string" && key.name.startsWith(MCP_KEY_PREFIX) &&
    Array.isArray(key.scopes) && MCP_SCOPES.every(scope => key.scopes.includes(scope));
}

export function mcpKeyStatus(key, now = Date.now()) {
  if (key?.revoked_at) return {active: false, label: "已关闭"};
  const expires = Number(key?.expires_at) * 1000;
  if (!Number.isFinite(expires)) return {active: false, label: "状态未知"};
  if (expires <= now) return {active: false, label: "已到期"};
  return {active: true, label: "使用中"};
}

export function mcpConnectionConfig(endpoint, token) {
  if (!/^xg_[A-Za-z0-9_-]{30,80}$/.test(token || "")) throw inputError("MCP Token 格式无效。");
  return JSON.stringify({url: normalizeMcpEndpoint(endpoint), headers: {Authorization: `Bearer ${token}`}}, null, 2);
}
