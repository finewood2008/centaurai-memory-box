// Local-only visual harness. Serves the real client UI with an explicitly mocked
// host/API; never ships in either client and never reads an account or user data.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const port = Number(process.env.WANX_FAQ_PREVIEW_PORT || 4387);
const etag = 'W/"faq-0123456789abcdef0123456789abcdef"';
const data = { version: "faq-0123456789abcdef0123456789abcdef", updatedAt: null, categories: [
  { id: 1, name: "登录与账号", items: [
    { id: 11, question: "忘记登录密码，应该怎么办？", answer: "在登录页面点击“忘记密码”，按照页面提示完成验证并设置新密码。\n如果暂时无法收到验证码，可以稍后重试。" },
    { id: 12, question: "还没有登录，可以查看常见问题吗？", answer: "可以。查看常见问题无需登录账号，也不需要连接盒子。\n你可以随时从登录页面或设置页面进入这里。" },
  ] },
  { id: 2, name: "盒子与连接", items: [
    { id: 21, question: "如何添加我的第一台万象盒子？", answer: "打开“盒子”页面，选择“添加盒子”，按照向导完成发现、配网和绑定。\n请将电脑靠近盒子，并根据页面提示检查蓝牙和网络状态。" },
    { id: 22, question: "暂时没有连接盒子，会影响查看帮助吗？", answer: "不会。帮助内容通过电脑网络获取，不依赖盒子连接。\n如果电脑也暂时离线，当前窗口可以保留此前获取的内容。" },
  ] },
  { id: 3, name: "应用与使用", items: [
    { id: 31, question: "在哪里查看和打开已经安装的应用？", answer: "在“应用”页面查看可用应用，并按界面提示连接对应盒子后打开。" },
    { id: 32, question: "切换页面后，可以继续查看刚才的问题吗？", answer: "可以重新打开常见问题。当前窗口会保留已获取内容，并向帮助服务检查更新。" },
  ] },
  { id: 4, name: "积分与更新", items: [
    { id: 41, question: "如何查看积分余额和使用明细？", answer: "在账号菜单中打开“积分”，查看账户余额及相关明细。\n具体积分信息请以积分页面的实际记录为准。" },
    { id: 42, question: "客户端提示需要更新，还能查看帮助吗？", answer: "可以。在更新提示页面选择“常见问题”查看帮助，再返回继续处理更新。" },
  ] },
] };

const host = String.raw`
(() => {
  const params = new URLSearchParams(location.search), screen = params.get("screen") || "help";
  const signedOut = screen === "login";
  const state = { route: signedOut ? "auth" : "applications", phase: signedOut ? "signed_out" : "idle",
    account: { phase: signedOut ? "signed_out" : "authenticated", accountId: signedOut ? null : "preview-account", displayName: "界面预览" },
    applications: [], devices: [], network: { enabled: false, phase: "disabled" }, desktopStartup: { supported: false, enabled: false },
    upgrades: { client: { phase: "development", current: { productVersion: "1.0.5", distributionClass: "development" },
      ...(screen === "upgrade" ? { requirement: { required: true, minVersion: "9.0.0" } } : {}) } } };
  let mode = "normal", feedbackMode = "normal", submission = null;
  window.wanxClient = {
    getLocalState: async () => state, onLocalState() {}, onNavigate() {},
    listRememberedLogins: async () => ({ items: [] }), getRememberedLogin: async () => ({ remember: false }),
    action: async (name, input = {}) => {
      if (name === "help.feedback") {
        const fingerprint = JSON.stringify(input);
        if (submission?.fingerprint !== fingerprint) submission = { fingerprint, key: crypto.randomUUID() };
        try {
          const response = await fetch("/app-api/faq/feedback?mode=" + feedbackMode, {
            method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": submission.key }, body: fingerprint,
          });
          const value = await response.json();
          if (value.code === 601) { submission = null; return { ok: false, code: "FAQ_FEEDBACK_INVALID_CONTENT", userMessage: value.msg, state }; }
          if (!response.ok) {
            if (response.status === 409) submission = null;
            return { ok: false, code: "FAQ_FEEDBACK_" + ({ 409: "IDEMPOTENCY_CONFLICT", 429: "RATE_LIMITED", 503: "UNAVAILABLE" }[response.status] || "INVALID_RESPONSE"), state };
          }
          submission = null; return { ok: true, value: value.data, state };
        } catch { return { ok: false, code: "FAQ_FEEDBACK_INVALID_RESPONSE", state }; }
      }
      if (name !== "help.faq") return { ok: true, value: name === "market.list" ? { items: [] } : undefined, state };
      try {
        if (mode === "offline") throw Error("ACCOUNT_NETWORK_ERROR");
        const response = await fetch("/app-api/faq?mode=" + mode, { headers: input.etag ? { "If-None-Match": input.etag } : {} });
        if (response.status === 304) return { ok: true, value: { notModified: true, etag: response.headers.get("etag") }, state };
        if (!response.ok) throw Error(response.status === 429 ? "FAQ_RATE_LIMITED" : "FAQ_UNAVAILABLE");
        return { ok: true, value: { data: (await response.json()).data, etag: response.headers.get("etag") }, state };
      } catch (error) { return { ok: false, code: error.message, state }; }
    },
  };
  window.addEventListener("DOMContentLoaded", () => {
    const bar = document.createElement("aside");
    bar.style.cssText = "position:fixed;bottom:12px;right:16px;z-index:1000;padding:10px 14px;border:1px solid #ddc9a9;border-radius:10px;background:#fffdf8;box-shadow:0 3px 18px #302d2912;display:flex;align-items:center;gap:10px;flex-wrap:wrap;max-width:calc(100vw - 32px);font:12px system-ui;color:#686159";
    const edition = params.get("edition") === "team" ? "team" : "personal";
    bar.innerHTML = '<strong>界面预览 · 模拟数据</strong><a href="/?edition=' + (edition === "personal" ? "team" : "personal") + '&screen=help">切换版本</a><a href="/?edition=' + edition + '&screen=login">登录页</a><a href="/?edition=' + edition + '&screen=settings">设置页</a><a href="/?edition=' + edition + '&screen=upgrade">升级页</a><select aria-label="预览接口状态"><option value="normal">正常内容</option><option value="empty">空内容</option><option value="offline">网络失败</option><option value="limited">请求限流</option><option value="unavailable">服务不可用</option></select><select aria-label="预览反馈状态"><option value="normal">反馈成功</option><option value="slow">延迟成功</option><option value="invalid">确认丢失</option><option value="601">内容校验失败</option><option value="429">反馈限流</option><option value="503">反馈不可用</option><option value="409">幂等冲突</option></select>';
    for (const link of bar.querySelectorAll("a")) link.style.cssText = "white-space:nowrap;color:#5b4636";
    bar.querySelector("select").style.cssText = "width:auto;min-width:120px;max-width:160px;margin:0";
    bar.querySelector("select").addEventListener("change", event => { mode = event.target.value; document.querySelector('[data-action="help-refresh"]')?.click(); });
    bar.querySelector('[aria-label="预览反馈状态"]').addEventListener("change", event => { feedbackMode = event.target.value; });
    document.body.append(bar);
    document.body.style.paddingBottom = "160px";
    if (screen === "help" || screen === "settings") document.querySelector('[data-action="profile-menu"]')?.click();
    if (screen === "help") document.querySelector('[data-action="show-settings"]')?.click();
    if (screen === "help") document.querySelector('[data-action="show-help"]')?.click();
    if (screen === "settings") document.querySelector('[data-action="show-settings"]')?.click();
  });
})();`;

const mime = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
const feedback = new Map();
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  try {
    if (request.method === "POST" && url.pathname === "/app-api/faq/feedback") {
      let text = "";
      for await (const chunk of request) {
        text += chunk;
        if (Buffer.byteLength(text) > 16 * 1024) { response.writeHead(413).end(); return; }
      }
      const mode = url.searchParams.get("mode"), key = request.headers["idempotency-key"];
      const send = (status, value) => response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(value));
      if (["409", "429", "503"].includes(mode)) { send(Number(mode), { code: Number(mode) }); return; }
      if (mode === "601") { send(200, { code: 601, msg: "请补充你遇到问题时的操作步骤。" }); return; }
      if (!key) { send(400, { code: 400 }); return; }
      JSON.parse(text);
      if (feedback.has(key) && feedback.get(key) !== text) { send(409, { code: 409 }); return; }
      const duplicate = feedback.has(key); feedback.set(key, text);
      if (mode === "invalid") { response.writeHead(200, { "Content-Type": "text/html" }).end("<html>Mock acknowledgement lost</html>"); return; }
      if (mode === "slow") await new Promise(resolve => setTimeout(resolve, 10000));
      send(200, { code: 200, success: true, data: { received: true, duplicate } }); return;
    }
    if (request.method !== "GET") { response.writeHead(405).end(); return; }
    if (url.pathname === "/__faq-preview-host.js") { response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" }).end(host); return; }
    if (url.pathname === "/app-api/faq") {
      const mode = url.searchParams.get("mode");
      if (mode === "limited" || mode === "unavailable") {
        response.writeHead(mode === "limited" ? 429 : 503, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify({ code: mode === "limited" ? 429 : 503 })); return;
      }
      const currentTag = mode === "empty" ? 'W/"faq-empty-preview"' : etag;
      const headers = { ETag: currentTag, "Cache-Control": "no-cache", "Content-Type": "application/json; charset=utf-8" };
      if (request.headers["if-none-match"] === currentTag) { response.writeHead(304, headers).end(); return; }
      response.writeHead(200, headers).end(JSON.stringify({ code: 200, success: true, data: mode === "empty" ? { ...data, version: "faq-empty-preview", categories: [] } : data })); return;
    }
    if (url.pathname === "/") {
      const edition = url.searchParams.get("edition") === "team" ? "team-client" : "personal-client";
      let html = await readFile(path.join(root, "apps", edition, "local-ui/renderer/index.html"), "utf8");
      html = html.replace("<head>", `<head><base href="/apps/${edition}/local-ui/renderer/"><script src="/__faq-preview-host.js"></script>`);
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(html); return;
    }
    if (!/^\/apps\/(personal-client|team-client)\/(local-ui\/renderer\/|resources\/)/.test(url.pathname)) { response.writeHead(404).end(); return; }
    const file = path.resolve(root, "." + decodeURIComponent(url.pathname));
    if (!file.startsWith(root + path.sep)) { response.writeHead(404).end(); return; }
    const body = await readFile(file);
    response.writeHead(200, { "Content-Type": (mime[path.extname(file)] || "application/octet-stream") + "; charset=utf-8" }).end(body);
  } catch { if (!response.headersSent) response.writeHead(404); response.end(); }
});
server.listen(port, "127.0.0.1", () => console.log(`FAQ preview (mock data): http://127.0.0.1:${port}/`));
