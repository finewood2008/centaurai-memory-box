import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { createAccount, DEFAULT_CONSUMER_URL } from "../account/index.mjs";
import { createPlatformClient } from "../platform.mjs";
import { registerControlActions } from "../shell/control.mjs";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const accepted = duplicate => json({ code: 200, success: true, data: { received: true, duplicate } });
const body = () => ({ content: "第一步之后仍无法登录。\n已经重启。", contact: "", categoryId: 1, itemId: 11 });
const store = { load() { assert.fail("Feedback must not load credentials"); }, save() { assert.fail("Feedback must not persist"); } };
const identity = { packaged: true, distributionClass: "formal", edition: "personal", productVersion: "1.0.5",
  buildId: "build-test", channel: "stable", platform: "win32", arch: "x64", osVersion: "10.0.22631",
  accountId: "never-send", secret: "never-send", installationPath: "never-send" };

test("anonymous feedback uses only fixed POST, memory-only UUID and main-process context", async () => {
  const calls = [];
  const account = createAccount({ store, getClientUpdateContext: () => identity,
    fetch: async (url, options) => { calls.push({ url, options }); return accepted(false); } });
  assert.deepEqual(await account.feedback(body()), { received: true, duplicate: false });
  const { url, options } = calls[0];
  assert.equal(url, DEFAULT_CONSUMER_URL + "/app-api/faq/feedback");
  assert.equal(options.method, "POST"); assert.equal(options.redirect, "error");
  assert.match(options.headers["Idempotency-Key"], /^[0-9a-f-]{36}$/);
  assert.equal(options.headers.Authorization, undefined); assert.equal(options.headers["If-None-Match"], undefined);
  assert.equal(Object.keys(options.headers).some(key => key.startsWith("X-Nexus-")), false);
  assert.deepEqual(JSON.parse(options.body), { ...body(), contact: null });
  const context = JSON.parse(options.headers["X-Wanx-Client"]);
  assert.equal(context.edition, identity.edition); assert.equal(context.buildId, identity.buildId);
  assert.equal(context.currentVersion, identity.productVersion); assert.equal(context.platform.osVersion, identity.osVersion);
  assert.doesNotMatch(JSON.stringify(context), /never-send/);
  assert.equal(account.snapshot().phase, "signed_out"); await account.close();
});

test("missing context never blocks feedback; team and development context stay distinguishable", async () => {
  for (const context of [null, { ...identity, packaged: false, edition: "team", channel: "stable-studio" }]) {
    let headers;
    const account = createAccount({ store, getClientUpdateContext: () => context,
      fetch: async (_, options) => { headers = options.headers; return accepted(false); } });
    await account.feedback(body());
    if (context) assert.equal(JSON.parse(headers["X-Wanx-Client"]).edition, "team");
    else assert.equal(headers["X-Wanx-Client"], undefined);
    await account.close();
  }
});

test("failed acknowledgement retries reuse key/body; success and changed body get new keys", async () => {
  const calls = [];
  const account = createAccount({ store, fetch: async (_, options) => {
    calls.push(options);
    if (calls.length === 1) throw new TypeError("private transport detail");
    return accepted(calls.length === 2);
  } });
  await assert.rejects(account.feedback(body()), { code: "ACCOUNT_NETWORK_ERROR" });
  assert.deepEqual(await account.feedback(body()), { received: true, duplicate: true });
  assert.equal(calls[0].headers["Idempotency-Key"], calls[1].headers["Idempotency-Key"]);
  assert.equal(calls[0].body, calls[1].body);
  await account.feedback(body());
  assert.notEqual(calls[1].headers["Idempotency-Key"], calls[2].headers["Idempotency-Key"]);
  await account.close();
});

test("409 resets the key; unknown success and unavailable responses retain it", async () => {
  for (const [reply, reset] of [[() => json({ code: 409 }, 409), true], [() => new Response("<html>bad</html>"), false],
    [() => accepted(undefined), false], [() => json({ code: 503 }, 503), false]]) {
    const calls = [];
    const account = createAccount({ store, fetch: async (_, options) => { calls.push(options); return calls.length === 1 ? reply() : accepted(false); } });
    await assert.rejects(account.feedback(body()));
    await account.feedback(body());
    assert.equal(calls[0].headers["Idempotency-Key"] === calls[1].headers["Idempotency-Key"], !reset);
    await account.close();
  }
});

test("body changes after a failed submission use a new key; same normalized body does not", async () => {
  const calls = [];
  const account = createAccount({ store, fetch: async (_, options) => { calls.push(options); return json({ code: 503 }, 503); } });
  await assert.rejects(account.feedback(body()));
  await assert.rejects(account.feedback({ ...body(), contact: null, content: `  ${body().content}  ` }));
  assert.equal(calls[0].headers["Idempotency-Key"], calls[1].headers["Idempotency-Key"]);
  await assert.rejects(account.feedback({ ...body(), content: "另一个问题" }));
  assert.notEqual(calls[1].headers["Idempotency-Key"], calls[2].headers["Idempotency-Key"]);
  await account.close();
});

test("main process coalesces concurrent duplicate submissions and rejects concurrent changed bodies", async () => {
  let resolve, calls = 0;
  const account = createAccount({ store, fetch: () => { calls++; return new Promise(done => { resolve = done; }); } });
  const a = account.feedback(body()), b = account.feedback(body());
  await assert.rejects(account.feedback({ ...body(), content: "并发修改" }), { code: "FAQ_FEEDBACK_INVALID_REQUEST" });
  assert.equal(calls, 1); resolve(accepted(false)); await Promise.all([a, b]); await account.close();
});

for (const [status, code] of [[400, "INVALID_REQUEST"], [409, "IDEMPOTENCY_CONFLICT"], [413, "TOO_LARGE"],
  [429, "RATE_LIMITED"], [503, "UNAVAILABLE"], [404, "UNAVAILABLE"], [405, "UNAVAILABLE"], [502, "UNAVAILABLE"]]) {
  test(`HTTP ${status} maps safely even when the gateway body is HTML`, async () => {
    const account = createAccount({ store, fetch: async () => new Response("<html>private upstream details</html>", { status }) });
    await assert.rejects(account.feedback(body()), error => error.code === `FAQ_FEEDBACK_${code}` && !error.userMessage);
    await account.close();
  });
}

test("only business 601 exposes a bounded control-free validation message", async () => {
  const account = createAccount({ store, fetch: async () => json({ code: 601, msg: "\x00反馈内容不能为空\n" + "x".repeat(250) }) });
  await assert.rejects(account.feedback(body()), error => error.code === "FAQ_FEEDBACK_INVALID_CONTENT" &&
    [...error.userMessage].length === 200 && !/[\x00-\x1f]/.test(error.userMessage));
  await account.close();
});

test("input allowlist and code-point bounds reject spoofed context without any fetch or vault access", async () => {
  let calls = 0;
  const account = createAccount({ store, fetch: async () => { calls++; return accepted(false); } });
  for (const input of [null, [], { ...body(), accountId: "spoof" }, { ...body(), client: identity },
    { ...body(), path: "https://other.invalid" }, { ...body(), content: "\x00bad" }, { ...body(), content: " " },
    { ...body(), content: "x".repeat(2001) }, { ...body(), contact: "x".repeat(129) }, { ...body(), itemId: -1 }])
    await assert.rejects(account.feedback(input));
  assert.equal(calls, 0);
  await account.feedback({ content: "😀".repeat(2000), contact: "😀".repeat(128) });
  assert.equal(calls, 1); await account.close();
});

test("a closed account cancels anonymous feedback instead of acknowledging a late result", async () => {
  let resolve;
  const account = createAccount({ store, fetch: () => new Promise(done => { resolve = done; }) });
  const pending = account.feedback(body()); await account.close(); resolve(accepted(false));
  await assert.rejects(pending, { code: "ACCOUNT_CANCELLED" });
});

test("signed-in feedback stays anonymous and ordinary authenticated headers retain their contract", async () => {
  const calls = [];
  const account = createAccount({ store: { load: async () => null, save: async () => {} }, getClientUpdateContext: () => identity,
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/login")) return json({ code: 200, data: { accountId: "fixture-account", clientId: JSON.parse(options.body).clientId,
        accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresIn: 3600 } });
      return url.endsWith("/feedback") ? accepted(false) : json({ code: 200, data: {} });
    } });
  await account.loginPassword({ phone: "13800138000", password: "fixture-password" });
  await account.feedback(body());
  assert.equal(calls.at(-1).options.headers.Authorization, undefined);
  assert.equal(calls.at(-1).options.headers["X-Nexus-Signature"], undefined);
  assert.equal(JSON.parse(calls.at(-1).options.headers["X-Wanx-Client"]).edition, "personal");
  await account.request({ path: "/app-api/example" });
  assert.equal(calls.at(-1).options.headers.Authorization, "Bearer fixture-access");
  const ordinary = JSON.parse(calls.at(-1).options.headers["X-Wanx-Client"]);
  assert.equal(ordinary.edition, undefined); assert.equal(ordinary.buildId, undefined);
  await account.close();
});

test("real account/platform/control/preload/view chain preserves 601 and escapes its message", async () => {
  const account = createAccount({ store, fetch: async () => json({ code: 601, msg: '<img src=x onerror="alert(1)"> 内容不能为空' }) });
  const client = createPlatformClient({ account, createTransport: () => assert.fail("Feedback must not start a network engine") });
  const frame = { url: "file:///trusted/index.html" }, webContents = { mainFrame: frame };
  const event = { sender: webContents, senderFrame: frame }, handlers = new Map(), exposed = {};
  let publishes = 0;
  registerControlActions({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    control: { webContents, isDestroyed: () => false }, controlURL: frame.url, client, publishState: () => { publishes++; } });
  const handler = handlers.get("wanx-client:help-feedback");
  assert.throws(() => handler({ ...event, senderFrame: { url: frame.url } }, body()));
  assert.throws(() => handler({ ...event, sender: { mainFrame: frame } }, body()));
  const rejection = await handler(event, body());
  assert.equal(rejection.code, "FAQ_FEEDBACK_INVALID_CONTENT"); assert.match(rejection.userMessage, /内容不能为空/);
  vm.runInNewContext(await readFile(new URL("../local-ui/remote-preload.cjs", import.meta.url), "utf8"), {
    process: { platform: "win32" }, require: () => ({ contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value; } },
      ipcRenderer: { on() {}, removeListener() {}, async invoke(name, input) {
        if (name === "wanx-client:get-state") return { account: { phase: "signed_out" } };
        return structuredClone(await handlers.get(name)(event, input));
      } } }),
  });
  const result = await exposed.wanxClient.action("help.feedback", { ...body(), accountId: "discarded" });
  assert.equal(result.code, rejection.code); assert.equal(result.userMessage, rejection.userMessage);
  const window = {};
  vm.runInNewContext(await readFile(new URL("../local-ui/renderer/help.js", import.meta.url), "utf8"), { window });
  const view = window.createHelpView({ changed() {}, request: async (action, input) => {
    const result = await exposed.wanxClient.action(action, input);
    if (!result.ok) throw Object.assign(new Error(result.code), { code: result.code, userMessage: result.userMessage });
    return result.value;
  } });
  view.action("help-feedback-open"); view.input("content", body().content);
  await view.action("help-feedback-submit");
  assert.match(view.render(), /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt; 内容不能为空/);
  assert.doesNotMatch(view.render(), /<img src=x/); assert.match(view.render(), /已经重启/);
  assert.ok(publishes > 0); await client.close();
});
