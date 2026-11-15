import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { createAccount, DEFAULT_CONSUMER_URL } from "../account/index.mjs";
import { registerControlActions } from "../shell/control.mjs";

const data = () => ({ version: "faq-" + "a".repeat(32), updatedAt: null,
  categories: [{ id: 1, name: "登录", items: [{ id: 1, question: "如何登录？", answer: "使用万象账号。" }] }] });
const tag = `W/"${data().version}"`;
const json = (value, status = 200, headers) => new Response(JSON.stringify(value), { status, headers });
const forbiddenStore = { load() { assert.fail("FAQ must not read credentials"); }, save() { assert.fail("FAQ must not persist"); } };

test("anonymous FAQ completes a real 200 -> conditional 304 transport loop", async () => {
  const calls = [];
  const account = createAccount({ store: forbiddenStore, fetch: async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1 ? json({ code: 200, data: data() }, 200, { ETag: tag }) : new Response(null, { status: 304, headers: { ETag: tag } });
  } });
  const first = await account.faq();
  assert.deepEqual(first, { data: data(), etag: tag });
  assert.deepEqual(await account.faq({ etag: first.etag }), { notModified: true, etag: tag });
  assert.equal(calls[0].url, DEFAULT_CONSUMER_URL + "/app-api/faq");
  assert.equal(calls[0].options.cache, "no-cache");
  assert.equal(calls[1].options.headers["If-None-Match"], tag);
  for (const { options } of calls) {
    assert.equal(options.method, "GET");
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(Object.keys(options.headers).some(key => key.startsWith("X-Nexus-")), false);
  }
  assert.equal(account.snapshot().phase, "signed_out");
});

test("missing ETag uses version and empty categories remain valid", async () => {
  const empty = { version: data().version, updatedAt: null, categories: [] };
  const account = createAccount({ store: forbiddenStore, fetch: async () => json({ code: 200, data: empty }) });
  assert.deepEqual(await account.faq(), { data: empty, etag: tag });
});

test("FAQ accepts the server's one MiB budget and close cancels an in-flight read", async () => {
  const large = data(); large.categories[0].items[0].answer = "x".repeat(1024 * 1024 - 1024);
  const account = createAccount({ store: forbiddenStore, fetch: async () => json({ code: 200, data: large }) });
  assert.equal((await account.faq()).data.categories[0].items[0].answer.length, large.categories[0].items[0].answer.length);
  let resolve;
  const pendingAccount = createAccount({ store: forbiddenStore, fetch: () => new Promise(done => { resolve = done; }) });
  const pending = pendingAccount.faq();
  await pendingAccount.close();
  resolve(json({ code: 200, data: data() }));
  await assert.rejects(pending, { code: "ACCOUNT_CANCELLED" });
});

test("signed-in FAQ also omits credentials and does not change ordinary authenticated requests", async () => {
  const requests = [];
  const account = createAccount({ store: { load: async () => null, save: async () => {} }, fetch: async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith("/login")) return json({ code: 200, data: { accountId: "review-account", clientId: JSON.parse(options.body).clientId,
      accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresIn: 3600 } });
    return json({ code: 200, data: data() });
  } });
  await account.loginPassword({ phone: "13800138000", password: "fixture-password" });
  await account.faq();
  assert.equal(requests.at(-1).options.headers.Authorization, undefined);
  assert.equal(requests.at(-1).options.headers["X-Nexus-Signature"], undefined);
  await account.request({ path: "/app-api/example" });
  assert.equal(requests.at(-1).options.headers.Authorization, "Bearer fixture-access");
  await account.close();
});

for (const [name, reply, code] of [
  ["JSON 429", () => json({ code: 429, msg: "private server detail" }, 429), "FAQ_RATE_LIMITED"],
  ["empty 429", () => new Response(null, { status: 429 }), "FAQ_RATE_LIMITED"],
  ["HTML 404", () => new Response("private upstream detail", { status: 404 }), "FAQ_UNAVAILABLE"],
  ["JSON 503", () => json({ code: 503, errorCode: "FAQ_PAYLOAD_TOO_LARGE" }, 503), "FAQ_UNAVAILABLE"],
  ["HTML 502", () => new Response("private upstream detail", { status: 502 }), "FAQ_UNAVAILABLE"],
  ["JSON null 503", () => json(null, 503), "FAQ_UNAVAILABLE"],
  ["JSON array 429", () => json([], 429), "FAQ_RATE_LIMITED"],
  ["HTTP 200 business failure", () => json({ code: 500 }), "FAQ_UNAVAILABLE"],
  ["invalid success", () => json({ code: 200, data: { categories: null } }), "FAQ_INVALID_RESPONSE"],
  ["HTML success", () => new Response("<html>invalid</html>"), "FAQ_INVALID_RESPONSE"],
  ["unsolicited 304", () => new Response(null, { status: 304 }), "FAQ_UNAVAILABLE"],
  ["oversize body", () => new Response("x".repeat(2 * 1024 * 1024 + 1)), "ACCOUNT_INVALID_RESPONSE"],
]) test(`FAQ maps ${name} without leaking server text`, async () => {
  const account = createAccount({ store: forbiddenStore, fetch: async () => reply() });
  await assert.rejects(account.faq(), error => error.code === code && error.message === code);
});

test("FAQ keeps network errors and rejects arbitrary request inputs before fetch", async () => {
  let calls = 0;
  const account = createAccount({ store: forbiddenStore, fetch: async () => { calls++; throw new TypeError("network private detail"); } });
  await assert.rejects(account.faq(), { code: "ACCOUNT_NETWORK_ERROR" });
  for (const input of [{ path: "https://untrusted.invalid" }, { etag: "bad\r\nheader" }, null, []])
    await assert.rejects(account.faq(input), { code: "ACCOUNT_INVALID_INPUT" });
  assert.equal(calls, 1);
  await assert.rejects(account.request({ path: "/app-api/faq", authenticated: false }), { code: "ACCOUNT_LOGIN_REQUIRED" });
});

test("trusted read IPC works signed out, rejects other frames and preserves FAQ codes through preload", async () => {
  const handlers = new Map(), frame = { url: "file:///trusted/index.html" }, webContents = { mainFrame: null };
  webContents.mainFrame = frame;
  const event = { sender: webContents, senderFrame: frame };
  let publishes = 0, calls = 0, fail = false;
  registerControlActions({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    control: { webContents, isDestroyed: () => false }, controlURL: frame.url,
    publishState: () => publishes++, client: {
      snapshot: () => ({ account: { phase: "signed_out" } }),
      faq: async input => { calls++; assert.equal(input.etag, tag); if (fail) throw Object.assign(new Error("FAQ_RATE_LIMITED"), { code: "FAQ_RATE_LIMITED" }); return { data: data(), etag: tag }; },
    } });
  const handler = handlers.get("wanx-client:help-faq");
  assert.throws(() => handler({ ...event, senderFrame: { url: frame.url } }, {}));
  assert.equal(calls, 0);
  const exposed = {};
  vm.runInNewContext(await readFile(new URL("../local-ui/remote-preload.cjs", import.meta.url), "utf8"), {
    process: { platform: "win32" }, require: () => ({ contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value; } },
      ipcRenderer: { on() {}, removeListener() {}, async invoke(name, input) {
        if (name === "wanx-client:get-state") return { account: { phase: "signed_out" } };
        try { return await handlers.get(name)(event, input); }
        catch (error) { throw new Error(`Error invoking remote method '${name}': Error: ${error.message}`); }
      } } }),
  });
  const result = await exposed.wanxClient.action("help.faq", { etag: tag, path: "/not-allowed", Authorization: "never-forward" });
  assert.equal(result.ok, true); assert.equal(result.value.etag, tag);
  fail = true;
  assert.equal((await exposed.wanxClient.action("help.faq", { etag: tag })).code, "FAQ_RATE_LIMITED");
  assert.equal(publishes, 0);
});
